import { execFileSync } from "node:child_process";
import { clickByRef, getBrowserContext, getCurrentControlMode } from "./playwright";

// Mutex: only one engine operates at a time
let engineBusy = false;
const engineQueue: Array<(val: void) => void> = [];

async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  while (engineBusy) {
    await new Promise<void>((resolve) => {
      engineQueue.push(resolve);
    });
  }
  engineBusy = true;
  try {
    return await fn();
  } finally {
    engineBusy = false;
    const next = engineQueue.shift();
    if (next) next();
  }
}

interface ScreenResolution {
  width: number;
  height: number;
}

const DISPLAY_ENV = { ...process.env, DISPLAY: process.env.DISPLAY || ":99" };

function getScreenResolution(): ScreenResolution {
  try {
    // Use execFileSync to avoid shell — parse xdpyinfo output directly
    const out = execFileSync("xdpyinfo", [], {
      encoding: "utf-8",
      env: DISPLAY_ENV,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(/dimensions:\s+(\d+)x(\d+) pixels/);
    if (match) return { width: parseInt(match[1]), height: parseInt(match[2]) };
  } catch {}
  return { width: 1280, height: 1024 }; // Fallback to configured Xvfb resolution
}

export interface ClickOptions {
  ref?: string;
  x?: number;
  y?: number;
  description?: string;
  button?: "left" | "right" | "middle";
  doubleClick?: boolean;
}

export interface ClickResult {
  method: "ref" | "coordinates" | "vision";
  success: boolean;
  error?: string;
}

export async function routedClick(
  opts: ClickOptions,
  visionClickFn?: (description: string) => Promise<{ x: number; y: number }>,
): Promise<ClickResult> {
  return withMutex(async () => {
    // Priority 1: ref (Playwright structured)
    if (opts.ref !== undefined) {
      try {
        await clickByRef(opts.ref);
        return { method: "ref", success: true };
      } catch (e: any) {
        return { method: "ref", success: false, error: `Element not found: ${opts.ref}. ${e.message}` };
      }
    }

    const buttonNum = opts.button === "right" ? 3 : opts.button === "middle" ? 2 : 1;
    const clickRepeat = opts.doubleClick ? 2 : 1;

    // Priority 2: coordinates (xdotool — free, deterministic)
    if (opts.x !== undefined && opts.y !== undefined) {
      const { width, height } = getScreenResolution();
      if (opts.x < 0 || opts.x > width || opts.y < 0 || opts.y > height) {
        return {
          method: "coordinates",
          success: false,
          error: `Coordinates (${opts.x}, ${opts.y}) out of bounds (${width}x${height})`,
        };
      }
      // Use execFileSync to avoid shell injection; timeout prevents X11 hangs from stalling server
      execFileSync(
        "xdotool",
        ["mousemove", String(opts.x), String(opts.y), "click", "--repeat", String(clickRepeat), String(buttonNum)],
        { env: DISPLAY_ENV, timeout: 10000 },
      );
      return { method: "coordinates", success: true };
    }

    // Priority 3: description (vision — screenshot → LLM → coordinates)
    if (opts.description !== undefined && visionClickFn) {
      try {
        const { x, y } = await visionClickFn(opts.description);
        const { width, height } = getScreenResolution();
        if (x < 0 || x > width || y < 0 || y > height) {
          return { method: "vision", success: false, error: `Vision returned out-of-bounds coordinates (${x}, ${y})` };
        }
        execFileSync(
          "xdotool",
          ["mousemove", String(x), String(y), "click", "--repeat", String(clickRepeat), String(buttonNum)],
          { env: DISPLAY_ENV, timeout: 10000 },
        );
        return { method: "vision", success: true };
      } catch (e: any) {
        return { method: "vision", success: false, error: e.message };
      }
    }

    return { method: "ref", success: false, error: "No click target specified (ref, x/y, or description required)" };
  });
}

export async function xdotoolType(text: string): Promise<void> {
  return withMutex(async () => {
    // Use execFileSync array args to avoid shell injection
    execFileSync("xdotool", ["type", "--clearmodifiers", "--", text], { env: DISPLAY_ENV, timeout: 15000 });
  });
}

export async function xdotoolKey(key: string): Promise<void> {
  return withMutex(async () => {
    // Use execFileSync to avoid shell injection — key is passed as a direct argument
    execFileSync("xdotool", ["key", key], { env: DISPLAY_ENV, timeout: 10000 });
  });
}
