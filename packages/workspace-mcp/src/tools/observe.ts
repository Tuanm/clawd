import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getCurrentControlMode, isExtensionPopupDetected, getCurrentUrl } from "../engines/playwright";

export async function screenshotTool(): Promise<{ path: string; width: number; height: number }> {
  const path = `/tmp/ws-screenshot-${randomBytes(8).toString("hex")}.png`;
  execFileSync("scrot", [path], { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" } });
  return { path, width: 1280, height: 1024 };
}

export function cleanupScreenshot(path: string): void {
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

export async function getContextTool(): Promise<object> {
  const controlMode = getCurrentControlMode();
  const popupDetected = isExtensionPopupDetected();
  let url = "unknown";
  try {
    url = await getCurrentUrl();
  } catch {}

  return {
    control_mode: controlMode,
    active_context: popupDetected ? "extension_popup" : "browser",
    current_url: url,
    context_changed: false,
    hint: popupDetected
      ? "Extension popup active. Use 'observe' to see current state, then 'click' with coordinates or description."
      : "Browser in structured mode. Use 'snapshot' for a11y tree, 'click' with ref for fast interaction.",
  };
}
