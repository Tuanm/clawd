import { existsSync, mkdirSync, rmSync } from "node:fs";
import { type BrowserContext, type CDPSession, chromium } from "playwright";

let context: BrowserContext | null = null;
let cdpSession: CDPSession | null = null;
let currentControlMode: "structured" | "vision" = "structured";
let extensionPopupDetected = false;

const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || "/data/.chrome-profile";
const EXTENSIONS_DIR = process.env.EXTENSIONS_DIR || "/opt/extensions";

export function getBrowserContext(): BrowserContext | null {
  return context;
}

export function getCurrentControlMode(): "structured" | "vision" {
  return currentControlMode;
}

export function isExtensionPopupDetected(): boolean {
  return extensionPopupDetected;
}

export function clearExtensionPopupFlag(): void {
  extensionPopupDetected = false;
  currentControlMode = "structured";
}

async function buildExtensionArgs(): Promise<string[]> {
  if (!existsSync(EXTENSIONS_DIR)) return [];
  const { readdirSync, statSync } = await import("node:fs");
  const dirs = readdirSync(EXTENSIONS_DIR)
    .filter((d) => {
      const dir = `${EXTENSIONS_DIR}/${d}`;
      // Only load directories that contain a manifest.json (valid Chrome extension)
      return statSync(dir).isDirectory() && existsSync(`${dir}/manifest.json`);
    })
    .map((d) => `${EXTENSIONS_DIR}/${d}`);
  if (dirs.length === 0) return [];
  return [`--load-extension=${dirs.join(",")}`, `--disable-extensions-except=${dirs.join(",")}`];
}

export async function launchBrowser(): Promise<void> {
  if (context) return; // Already running

  if (!existsSync(CHROME_PROFILE_DIR)) {
    mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  }

  // Remove stale Chromium lock file from previous crash to prevent "ProcessSingleton" error
  const lockFile = `${CHROME_PROFILE_DIR}/SingletonLock`;
  if (existsSync(lockFile)) {
    try {
      rmSync(lockFile);
    } catch {}
  }

  const extArgs = await buildExtensionArgs();

  context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
    headless: false,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=TranslateUI",
      "--remote-debugging-port=9222",
      "--no-sandbox", // Required inside container with --cap-drop ALL
      "--disable-setuid-sandbox",
      ...extArgs,
    ],
    viewport: null, // Use window size
  });

  // Defensive: ensure at least one page exists
  if (context.pages().length === 0) {
    await context.newPage();
  }

  // Register CDP target listener BEFORE setDiscoverTargets so pre-existing targets aren't missed
  cdpSession = await context.newCDPSession(context.pages()[0]);
  cdpSession.on("Target.targetCreated", (event: any) => {
    const url: string = event.targetInfo?.url || "";
    // Detect MetaMask / Phantom / Freighter popup windows
    if (
      url.includes("chrome-extension://") &&
      (url.includes("notification.html") || url.includes("popup.html") || url.includes("home.html"))
    ) {
      extensionPopupDetected = true;
      currentControlMode = "vision";
    }
  });
  cdpSession.on("Target.targetDestroyed", () => {
    // Check if any extension contexts still open
    const pages = context?.pages() || [];
    const hasExtPage = pages.some((p) => p.url().startsWith("chrome-extension://"));
    if (!hasExtPage) {
      extensionPopupDetected = false;
      currentControlMode = "structured";
    }
  });
  await cdpSession.send("Target.setDiscoverTargets", { discover: true });

  console.log("[Playwright] Browser launched with extensions:", extArgs.length > 0 ? "yes" : "none");
}

export async function closeBrowser(): Promise<void> {
  if (cdpSession) {
    try {
      await cdpSession.detach();
    } catch {}
    cdpSession = null;
  }
  if (context) {
    try {
      await context.close();
    } catch {}
    context = null;
  }
  currentControlMode = "structured";
  extensionPopupDetected = false;
}

export async function getActivePage() {
  if (!context) throw new Error("Browser not started. Call launch_browser first.");
  const pages = context.pages();
  if (pages.length === 0) return await context.newPage();
  // Return the last focused page (most recently active)
  return pages[pages.length - 1];
}

export async function getAccessibilityTree(): Promise<object> {
  const page = await getActivePage();
  // page.accessibility was removed in Playwright 1.58+ — use ariaSnapshot or DOM evaluation
  // ariaSnapshot returns a YAML-like string of accessible roles/names (null on error, "" on empty)
  const snapshot = await page
    .locator("body")
    .ariaSnapshot({ timeout: 10000 })
    .catch(() => null);
  if (snapshot !== null) return { snapshot }; // Accept empty string as valid (no elements)
  // Fallback: collect key elements via DOM
  const elements = await page.evaluate(() => {
    const sel =
      'button,a,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="menuitem"],h1,h2,h3';
    return Array.from(document.querySelectorAll<HTMLElement>(sel))
      .slice(0, 200)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        text: el.innerText?.trim().slice(0, 100) || "",
        id: el.id || undefined,
        name: (el as HTMLInputElement).name || undefined,
        placeholder: (el as HTMLInputElement).placeholder || undefined,
        href: (el as HTMLAnchorElement).href || undefined,
      }));
  });
  return { elements };
}

export async function navigateTo(url: string): Promise<string> {
  if (!context) await launchBrowser();
  const page = await getActivePage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return page.url();
}

export async function clickByRef(ref: string): Promise<void> {
  const page = await getActivePage();
  const locator = page.locator(ref).first();
  await locator.click({ timeout: 10000 });
}

export async function typeText(text: string): Promise<void> {
  const page = await getActivePage();
  await page.keyboard.type(text);
}

export async function pressKey(key: string): Promise<void> {
  const page = await getActivePage();
  await page.keyboard.press(key);
}

export async function selectOption(ref: string, value: string): Promise<void> {
  const page = await getActivePage();
  await page.locator(ref).first().selectOption(value);
}

export async function handleDialog(action: "accept" | "dismiss", promptText?: string): Promise<void> {
  const page = await getActivePage();
  page.once("dialog", (dialog) => {
    // Add .catch() to prevent unhandled rejections from crashing the MCP server
    const p = action === "accept" ? dialog.accept(promptText) : dialog.dismiss();
    p.catch((err) => console.warn("[Playwright] dialog handler error:", err.message));
  });
}

export async function waitForElement(selector: string, timeoutMs = 30000): Promise<boolean> {
  try {
    const page = await getActivePage();
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentUrl(): Promise<string> {
  try {
    const page = await getActivePage();
    return page.url();
  } catch {
    return "unknown";
  }
}
