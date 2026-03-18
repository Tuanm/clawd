import { spawn } from "node:child_process";
import {
  getAccessibilityTree,
  getActivePage,
  handleDialog,
  launchBrowser,
  navigateTo,
  waitForElement,
} from "../engines/playwright";

export async function launchBrowserTool(
  url?: string,
): Promise<{ url: string; title: string; context_changed: boolean }> {
  await launchBrowser();
  if (url) {
    const finalUrl = await navigateTo(url);
    const page = await getActivePage();
    const title = await page.title().catch(() => "");
    return { url: finalUrl, title, context_changed: false };
  }
  return { url: "about:blank", title: "New tab", context_changed: false };
}

// Allowlist of permitted application executables to prevent command injection
const ALLOWED_APPS = new Set([
  "xterm",
  "gnome-terminal",
  "konsole",
  "xfce4-terminal",
  "firefox",
  "chromium",
  "google-chrome",
  "gedit",
  "kate",
  "mousepad",
  "leafpad",
  "nautilus",
  "thunar",
  "dolphin",
  "evince",
  "okular",
  "eog",
  "shotwell",
  "vlc",
  "mpv",
  "libreoffice",
  "gimp",
]);

export async function launchAppTool(app: string, args: string[] = []): Promise<{ pid: number; app: string }> {
  // Validate app against allowlist to prevent command injection
  const appBasename = app.split("/").pop() || app;
  if (!ALLOWED_APPS.has(appBasename)) {
    throw new Error(`App '${appBasename}' is not in the permitted application list`);
  }
  // Ensure each arg does not contain shell metacharacters
  for (const arg of args) {
    if (/[;&|`$<>]/.test(arg)) {
      throw new Error("Argument contains disallowed shell characters");
    }
  }
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ":99" };
  const proc = spawn(app, args, { detached: true, stdio: "ignore", env }); // lgtm[js/command-line-injection]
  proc.unref();
  return { pid: proc.pid || 0, app };
}

export async function snapshotTool(): Promise<{ tree: object; url: string; context_changed: boolean }> {
  const page = await getActivePage();
  const tree = await getAccessibilityTree();
  const url = page.url();
  return { tree, url, context_changed: false };
}

const MAX_WAIT_TIMEOUT_MS = 60_000; // 60 seconds maximum to prevent resource exhaustion

export async function waitTool(
  selector?: string,
  text?: string,
  timeoutMs = 30000,
): Promise<{ found: boolean; elapsed_ms: number }> {
  // Clamp timeout to prevent resource exhaustion from large caller-supplied values
  timeoutMs = Math.min(Math.max(timeoutMs, 0), MAX_WAIT_TIMEOUT_MS);
  const start = Date.now();
  if (selector) {
    const found = await waitForElement(selector, timeoutMs);
    return { found, elapsed_ms: Date.now() - start };
  }
  if (text) {
    const page = await getActivePage();
    try {
      await page.waitForFunction((t: string) => document.body.innerText.includes(t), text, { timeout: timeoutMs });
      return { found: true, elapsed_ms: Date.now() - start };
    } catch {
      return { found: false, elapsed_ms: Date.now() - start };
    }
  }
  // Just wait for given timeout
  await new Promise((r) => setTimeout(r, timeoutMs)); // lgtm[js/resource-exhaustion]
  return { found: true, elapsed_ms: Date.now() - start };
}

export async function handleDialogTool(action: "accept" | "dismiss", promptText?: string): Promise<{ action: string }> {
  await handleDialog(action, promptText);
  return { action };
}
