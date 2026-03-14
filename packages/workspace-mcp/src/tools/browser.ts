import { execSync, spawn } from "node:child_process";
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

export async function launchAppTool(app: string, args: string[] = []): Promise<{ pid: number; app: string }> {
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ":99" };
  const proc = spawn(app, args, { detached: true, stdio: "ignore", env });
  proc.unref();
  return { pid: proc.pid || 0, app };
}

export async function snapshotTool(): Promise<{ tree: object; url: string; context_changed: boolean }> {
  const page = await getActivePage();
  const tree = await getAccessibilityTree();
  const url = page.url();
  return { tree, url, context_changed: false };
}

export async function waitTool(
  selector?: string,
  text?: string,
  timeoutMs = 30000,
): Promise<{ found: boolean; elapsed_ms: number }> {
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
  await new Promise((r) => setTimeout(r, timeoutMs));
  return { found: true, elapsed_ms: Date.now() - start };
}

export async function handleDialogTool(action: "accept" | "dismiss", promptText?: string): Promise<{ action: string }> {
  await handleDialog(action, promptText);
  return { action };
}
