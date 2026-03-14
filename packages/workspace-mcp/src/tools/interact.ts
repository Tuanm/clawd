import { execFileSync, execSync } from "node:child_process";
import {
  clearExtensionPopupFlag,
  getCurrentControlMode,
  isExtensionPopupDetected,
  pressKey,
  selectOption,
  typeText,
} from "../engines/playwright";
import { type ClickOptions, routedClick, xdotoolKey, xdotoolType } from "../engines/router";

interface ContextChangedResult {
  context_changed: boolean;
  control_mode: "structured" | "vision";
  active_context: string;
  hint?: string;
}

function buildContextResult(): ContextChangedResult {
  const mode = getCurrentControlMode();
  const popupDetected = isExtensionPopupDetected();
  return {
    context_changed: popupDetected,
    control_mode: mode,
    active_context: popupDetected ? "extension_popup" : "browser",
    hint: popupDetected
      ? "Extension popup detected. Use 'observe' to see current state, then 'click' with coordinates or description."
      : undefined,
  };
}

export async function clickTool(
  opts: ClickOptions,
  visionClickFn?: (description: string) => Promise<{ x: number; y: number }>,
): Promise<{ result: string } & ContextChangedResult> {
  const clickResult = await routedClick(opts, visionClickFn);
  if (!clickResult.success) {
    throw new Error(clickResult.error || "Click failed");
  }
  const ctx = buildContextResult();
  return {
    result: `Clicked via ${clickResult.method}`,
    ...ctx,
  };
}

export async function typeTextTool(
  text: string,
  useXdotool = false,
): Promise<{ result: string } & ContextChangedResult> {
  if (useXdotool || isExtensionPopupDetected()) {
    await xdotoolType(text);
  } else {
    await typeText(text);
  }
  return { result: `Typed ${text.length} characters`, ...buildContextResult() };
}

export async function pressKeyTool(
  key: string,
  useXdotool = false,
): Promise<{ result: string } & ContextChangedResult> {
  if (useXdotool || isExtensionPopupDetected()) {
    await xdotoolKey(key);
  } else {
    await pressKey(key);
  }
  return { result: `Pressed key: ${key}`, ...buildContextResult() };
}

export async function selectOptionTool(ref: string, value: string): Promise<{ result: string } & ContextChangedResult> {
  await selectOption(ref, value);
  return { result: `Selected: ${value}`, ...buildContextResult() };
}

export async function dragTool(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Promise<{ result: string } & ContextChangedResult> {
  const displayEnv = { ...process.env, DISPLAY: process.env.DISPLAY || ":99" };
  execFileSync(
    "xdotool",
    [
      "mousemove",
      String(fromX),
      String(fromY),
      "mousedown",
      "1",
      "mousemove",
      String(toX),
      String(toY),
      "mouseup",
      "1",
    ],
    { env: displayEnv, timeout: 10000 },
  );
  return { result: `Dragged from (${fromX},${fromY}) to (${toX},${toY})`, ...buildContextResult() };
}
