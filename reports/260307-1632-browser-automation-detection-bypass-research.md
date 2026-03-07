# Browser Automation Detection Bypass — Comprehensive Research Report

**Date**: 2026-03-07  
**Scope**: CDP detection, DevTools detection, HttpOnly cookies, extension-based automation, anti-bot frameworks, stealth tools, extension-native approach  
**Context**: Claw'd browser extension currently uses `chrome.debugger` (CDP via extension API). Research into detection vectors and mitigation strategies.

---

## Table of Contents

1. [CDP Detection Vectors & Mitigations](#1-cdp-detection)
2. [DevTools/F12 Detection & Countermeasures](#2-devtools-detection)
3. [HttpOnly Cookie Challenges](#3-httponly-cookies)
4. [Extension-Based Automation vs CDP Stealth](#4-extension-vs-cdp)
5. [Anti-Bot Detection Frameworks](#5-anti-bot-frameworks)
6. [Stealth Techniques in Modern Tools](#6-stealth-tools)
7. [Extension-Native Automation (No CDP)](#7-extension-native)
8. [Recommendations for Claw'd](#8-recommendations)
9. [Unresolved Questions](#9-unresolved)

---

## 1. CDP Detection Vectors & Mitigations {#1-cdp-detection}

### 1.1 Detection Surface: What CDP Leaks

| Signal | How it works | Severity |
|--------|-------------|----------|
| **`navigator.webdriver`** | Set to `true` when browser launched with `--enable-automation` or via WebDriver protocol | 🔴 Critical |
| **`window.cdc_` / `document.$cdc_`** | ChromeDriver injects `cdc_adoQpoasnfa76pfcZLmcfl_` (variable name changes per version) into DOM. Used for internal CDP communication | 🔴 Critical |
| **`Runtime.enable` execution context** | When CDP calls `Runtime.enable`, it creates observable side-effects: `__proto__` chain modifications, extra execution contexts visible to page | 🟡 Medium |
| **`sourceURL` injection** | CDP's `Runtime.evaluate` appends `//# sourceURL=__playwright_evaluation_script__` or `//# sourceURL=pptr:evaluate` to injected scripts, visible in stack traces | 🟡 Medium |
| **WebSocket on debugging port** | If `--remote-debugging-port=9222` used, detectable via port scanning (`fetch('http://localhost:9222/json')`) | 🟡 Medium |
| **`window.chrome.runtime`** | Missing in headless Chrome (present in headed). Some scripts also check `window.chrome.app`, `window.chrome.csi` | 🟡 Medium |
| **Headless indicators** | `navigator.plugins.length === 0`, missing `window.chrome`, `navigator.languages` empty, WebGL renderer = "Google SwiftShader" | 🟡 Medium |
| **`Page.addScriptToEvaluateOnNewDocument`** | Scripts added this way run before page JS but create detectable artifacts in `Error().stack` traces | 🟢 Low |
| **Chrome `--disable-blink-features`** | The flag itself is not detectable, but its effects can be: e.g., `AutomationControlled` feature flag changes behavior of `navigator.webdriver` | 🟢 Low |
| **User-Agent string** | HeadlessChrome/xxx in UA (old headless). New headless mode fixed this | 🟢 Low (fixed in Chrome 112+) |

### 1.2 Detailed Detection Mechanisms

#### `navigator.webdriver` Detection

```javascript
// Detection (page-side)
if (navigator.webdriver) {
  // Bot detected
}

// Also detectable via property descriptor
const desc = Object.getOwnPropertyDescriptor(navigator, 'webdriver');
if (desc && desc.get) {
  // Might be patched — check if it's native
  if (!desc.get.toString().includes('[native code]')) {
    // Patched getter — still suspicious
  }
}
```

#### `cdc_` Variable Detection (ChromeDriver-specific)

```javascript
// Detection: scan for ChromeDriver's injected control variable
// The variable name pattern: cdc_adoQpoasnfa76pfcZLmcfl_
// It changes per ChromeDriver version but always starts with cdc_
for (const key of Object.keys(document)) {
  if (key.startsWith('cdc_') || key.startsWith('$cdc_')) {
    // ChromeDriver detected
  }
}
// Also check window
for (const key of Object.keys(window)) {
  if (key.match(/^(cdc|__cdc|\\$cdc)/)) {
    // ChromeDriver detected
  }
}
```

**Note**: This is ChromeDriver-specific. Puppeteer/Playwright do NOT inject `cdc_` variables since they use CDP directly, not ChromeDriver.

#### `Runtime.enable` Artifacts

When CDP's `Runtime.enable` is called (as Claw'd's extension does in `ensureDebugger()`), it:
1. Starts reporting execution context creation/destruction events
2. May create observable side effects if page JS checks for unusual context IDs
3. The `Runtime.executionContextCreated` event exposes info about injected worlds

**Detection by page**:
```javascript
// Some anti-bot scripts check for unusual properties on Error stack
try { throw new Error(); } catch(e) {
  if (e.stack.includes('pptr:') || e.stack.includes('__puppeteer')) {
    // Puppeteer detected via stack trace
  }
}
```

#### `sourceURL` Detection

```javascript
// Detection: check stack traces for automation framework markers
function detectSourceURL() {
  try { null[0]; } catch (e) {
    const stack = e.stack || '';
    const markers = [
      '__playwright_evaluation_script__',
      'pptr:evaluate',
      '__puppeteer_evaluation_script__',
      '__selenium_evaluation_script__'
    ];
    return markers.some(m => stack.includes(m));
  }
}
```

### 1.3 Proven CDP Stealth Mitigations

#### A. Patch `navigator.webdriver` (Most Critical)

```javascript
// Via CDP Page.addScriptToEvaluateOnNewDocument (runs before any page JS)
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,  // or false
    configurable: true
  });
});

// More robust — delete it entirely and make it non-enumerable
await page.evaluateOnNewDocument(() => {
  const newProto = navigator.__proto__;
  delete newProto.webdriver;
  navigator.__proto__ = newProto;
});
```

**Chrome flag alternative** (simpler, works at browser level):
```bash
chrome --disable-blink-features=AutomationControlled
```
This prevents `navigator.webdriver` from being set to `true` in the first place.

#### B. Remove `cdc_` Variables (ChromeDriver only)

For undetectable-chromedriver, this is done by binary-patching the chromedriver binary:
```python
# undetectable-chromedriver approach: hex-edit chromedriver binary
# Replace cdc_ prefix with random string in the binary
import re
with open('chromedriver', 'rb') as f:
    data = f.read()
data = re.sub(b'cdc_', b'xxx_', data)  # simplified
with open('chromedriver', 'wb') as f:
    f.write(data)
```

**Not relevant to Claw'd** — Claw'd uses `chrome.debugger` API from extension, not ChromeDriver.

#### C. Mask Headless Chrome Indicators

```javascript
// Fix plugins (headless has 0 plugins)
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', filename: 'internal-nacl-plugin' }
    ]
  });
});

// Fix languages
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en']
  });
});

// Fix WebGL renderer (SwiftShader is headless giveaway)
await page.evaluateOnNewDocument(() => {
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    // UNMASKED_VENDOR_WEBGL
    if (param === 37445) return 'Intel Inc.';
    // UNMASKED_RENDERER_WEBGL
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, param);
  };
});

// Fix window.chrome object (missing in headless)
await page.evaluateOnNewDocument(() => {
  window.chrome = {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: () => {}
    },
    loadTimes: () => ({
      commitLoadTime: Date.now() / 1000,
      connectionInfo: 'h2',
      finishDocumentLoadTime: Date.now() / 1000,
      finishLoadTime: Date.now() / 1000,
      firstPaintAfterLoadTime: 0,
      firstPaintTime: Date.now() / 1000,
      navigationType: 'Other',
      npnNegotiatedProtocol: 'h2',
      requestTime: Date.now() / 1000 - 0.16,
      startLoadTime: Date.now() / 1000 - 0.1,
      wasAlternateProtocolAvailable: false,
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true
    }),
    csi: () => ({ pageT: Date.now(), startE: Date.now() })
  };
});
```

#### D. Prevent `sourceURL` Leakage

```javascript
// Override Error.prepareStackTrace to strip automation markers
await page.evaluateOnNewDocument(() => {
  const originalPrepareStackTrace = Error.prepareStackTrace;
  Error.prepareStackTrace = function(error, structuredStackTrace) {
    // Filter out frames from automation scripts
    const filtered = structuredStackTrace.filter(frame => {
      const fileName = frame.getFileName() || '';
      return !fileName.includes('pptr:') &&
             !fileName.includes('__puppeteer') &&
             !fileName.includes('__playwright');
    });
    if (originalPrepareStackTrace) {
      return originalPrepareStackTrace(error, filtered);
    }
    return filtered.map(f => `    at ${f}`).join('\n');
  };
});
```

#### E. Block WebSocket Port Scanning

```javascript
// If using --remote-debugging-port, block fetch to localhost:9222
await page.evaluateOnNewDocument(() => {
  const origFetch = window.fetch;
  window.fetch = function(...args) {
    const url = args[0]?.toString?.() || args[0];
    if (url && /localhost:\d{4}\/json/.test(url)) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return origFetch.apply(this, args);
  };
});
```

### 1.4 Claw'd-Specific CDP Exposure

Claw'd's extension uses `chrome.debugger` API which calls CDP from the extension context. Key observations:

1. **No `cdc_` variables** — Not using ChromeDriver, so no `cdc_` injection
2. **`Runtime.enable` IS called** — `ensureDebugger()` calls `Runtime.enable` on attach (line 2019 of service-worker.js). This is a detection vector
3. **`Page.enable` IS called** — Also called in `ensureDebugger()` (line 2020)
4. **`navigator.webdriver` NOT set** — Extensions using `chrome.debugger` don't set this flag (only WebDriver/`--enable-automation` does)
5. **Yellow infobar** — `chrome.debugger.attach()` shows "Extension started debugging this browser" bar. CANNOT be suppressed. Visible UX indicator.
6. **No headless** — Runs in user's real browser, so no headless detection vectors

**Claw'd's current risk level**: LOW for CDP detection. The main concern is `Runtime.enable` artifacts and the visible debugger infobar.

---

## 2. DevTools/F12 Detection & Countermeasures {#2-devtools-detection}

### 2.1 Detection Methods

#### Method 1: `debugger` Statement Timing Attack

```javascript
// Detection: debugger statement pauses execution only when DevTools is open
setInterval(() => {
  const start = performance.now();
  debugger; // Pauses if DevTools open
  const elapsed = performance.now() - start;
  if (elapsed > 100) {
    // DevTools is open (debugger statement caused pause)
    document.body.innerHTML = 'DevTools detected';
  }
}, 1000);
```

**Countermeasure**:
```javascript
// Via CDP: Disable breakpoints entirely
await chrome.debugger.sendCommand({tabId}, 'Debugger.disable');
// OR: Don't enable Debugger domain at all (Claw'd doesn't, which is good)

// Via extension: Intercept and skip debugger statements
// (Not directly possible — but if not attaching Debugger domain, 
// debugger statements don't pause when only extension debugger is attached)
```

**Key insight**: `chrome.debugger` from an extension does NOT pause on `debugger` statements unless `Debugger.enable` is explicitly called. Claw'd does NOT call `Debugger.enable`, so this detection method **does not trigger** against Claw'd's extension.

#### Method 2: Window Dimensions Delta

```javascript
// Detection: DevTools panel changes outerHeight vs innerHeight
setInterval(() => {
  const threshold = 160; // DevTools panel is at least ~160px
  const heightDiff = window.outerHeight - window.innerHeight;
  const widthDiff = window.outerWidth - window.innerWidth;
  if (heightDiff > threshold || widthDiff > threshold) {
    // DevTools is open (docked)
  }
}, 500);
```

**Countermeasure**:
```javascript
// Override the properties
Object.defineProperty(window, 'outerHeight', {
  get: () => window.innerHeight + 80 // Normal chrome height
});
Object.defineProperty(window, 'outerWidth', {
  get: () => window.innerWidth + 0
});
```

**Note**: This doesn't detect undocked DevTools. Also doesn't detect `chrome.debugger` from an extension (no DevTools panel opened).

#### Method 3: `console.log` Getter Trick

```javascript
// Detection: DevTools evaluates toString/getter when displaying objects in console
const detector = {};
let devtoolsOpen = false;
Object.defineProperty(detector, 'id', {
  get: function() {
    devtoolsOpen = true; // Triggered only when DevTools console renders this
    return 'detector';
  }
});
setInterval(() => {
  devtoolsOpen = false;
  console.log(detector);
  console.clear();
  if (devtoolsOpen) {
    // DevTools console is open and rendering objects
  }
}, 1000);
```

**Countermeasure**:
```javascript
// Override console.log to prevent getter triggering
const noop = () => {};
window.console = new Proxy(console, {
  get: (target, prop) => {
    if (['log', 'debug', 'info', 'warn', 'error', 'table', 'dir'].includes(prop)) {
      return noop;
    }
    return target[prop];
  }
});
```

**Note**: This only detects when DevTools console panel is actively open. `chrome.debugger` from extension doesn't open the console panel.

#### Method 4: `Firebug`/DevTools Object Detection

```javascript
// Detection: check for Firebug or Chrome DevTools global
if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ||
    window.__REDUX_DEVTOOLS_EXTENSION__ ||
    window.Firebug) {
  // Dev extension detected (not the same as F12)
}
```

#### Method 5: `toString()` on RegExp/Function

```javascript
// Detection: DevTools calls toString when auto-completing
const re = /./;
re.toString = function() {
  // This fires when DevTools console inspects the value
  devtoolsDetected = true;
  return '/./' ;
};
```

### 2.2 Summary: Does Claw'd Trigger These?

| Detection Method | Triggered by `chrome.debugger` extension? |
|-----------------|------------------------------------------|
| `debugger` statement timing | ❌ No (Debugger domain not enabled) |
| Window dimensions | ❌ No (no DevTools panel opened) |
| `console.log` getter | ❌ No (no console panel opened) |
| `toString()` inspection | ❌ No (no console panel opened) |
| `__REACT_DEVTOOLS_GLOBAL_HOOK__` | ❌ No (unrelated) |

**Verdict**: `chrome.debugger` from an extension does NOT trigger any standard DevTools detection methods. The yellow infobar is visible to the user but NOT detectable by page JavaScript.

---

## 3. HttpOnly Cookie Challenges {#3-httponly-cookies}

### 3.1 The Problem

HttpOnly cookies cannot be read by `document.cookie` in JavaScript. This is a security feature preventing XSS from stealing session tokens.

```javascript
// This CANNOT read HttpOnly cookies
document.cookie; // Only returns non-HttpOnly cookies
```

### 3.2 Extension Solutions

#### `chrome.cookies` API — ✅ CAN Read HttpOnly Cookies

```javascript
// Extension service worker / background script
// Requires "cookies" permission + host_permissions in manifest.json

// Read ALL cookies for a domain (including HttpOnly)
const cookies = await chrome.cookies.getAll({ domain: '.example.com' });
cookies.forEach(c => {
  console.log(c.name, c.value, c.httpOnly); // httpOnly: true/false
});

// Read specific cookie
const cookie = await chrome.cookies.get({
  url: 'https://example.com',
  name: 'session_id'
});
// Works even if HttpOnly — extension has elevated privilege

// Set a cookie (can set HttpOnly too)
await chrome.cookies.set({
  url: 'https://example.com',
  name: 'session_id',
  value: 'abc123',
  httpOnly: true,
  secure: true,
  sameSite: 'lax'
});
```

**Manifest permissions needed**:
```json
{
  "permissions": ["cookies"],
  "host_permissions": ["<all_urls>"]
}
```

#### `chrome.webRequest` — ✅ CAN Intercept Set-Cookie Headers

```javascript
// MV2 style (webRequest blocking)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const setCookies = details.responseHeaders.filter(
      h => h.name.toLowerCase() === 'set-cookie'
    );
    setCookies.forEach(h => {
      console.log('Set-Cookie:', h.value); // Includes HttpOnly cookies
    });
    return { responseHeaders: details.responseHeaders };
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders'] // extraHeaders needed for Set-Cookie
);
```

#### `chrome.declarativeNetRequest` (MV3) — ⚠️ Limited

MV3's declarativeNetRequest can **modify** headers via rules but **cannot read** cookie values programmatically. It's declarative, not event-driven.

```json
// Can ADD/REMOVE/SET headers, but can't inspect values
{
  "id": 1,
  "priority": 1,
  "action": {
    "type": "modifyHeaders",
    "responseHeaders": [
      { "header": "set-cookie", "operation": "remove" }
    ]
  },
  "condition": { "urlFilter": "*" }
}
```

#### CDP `Network.getCookies` — ✅ Full Access

```javascript
// Via chrome.debugger (what Claw'd could use)
const result = await chrome.debugger.sendCommand(
  { tabId },
  'Network.getCookies',
  { urls: ['https://example.com'] }
);
result.cookies.forEach(c => {
  // Full access: name, value, httpOnly, secure, sameSite, etc.
  console.log(c.name, c.value, c.httpOnly);
});

// Can also SET cookies via CDP
await chrome.debugger.sendCommand({ tabId }, 'Network.setCookie', {
  name: 'session',
  value: 'abc123',
  domain: '.example.com',
  httpOnly: true,
  secure: true
});
```

### 3.3 Summary

| Method | Read HttpOnly | Write HttpOnly | MV3 Compatible |
|--------|:---:|:---:|:---:|
| `document.cookie` | ❌ | ❌ | N/A (page JS) |
| `chrome.cookies` API | ✅ | ✅ | ✅ |
| `chrome.webRequest` (blocking) | ✅ (headers) | ✅ (modify headers) | ❌ (MV2 only for blocking) |
| `chrome.webRequest` (non-blocking, MV3) | ✅ (read headers) | ❌ | ✅ |
| `chrome.declarativeNetRequest` | ❌ (declarative) | ⚠️ (can remove/add) | ✅ |
| CDP `Network.getCookies` | ✅ | ✅ | ✅ (via `chrome.debugger`) |

**Recommendation for Claw'd**: Add `"cookies"` permission to manifest.json and use `chrome.cookies.getAll()` for cookie access. Alternatively, use existing CDP `Network.getCookies` via `chrome.debugger`.

---

## 4. Extension-Based Automation vs CDP Stealth {#4-extension-vs-cdp}

### 4.1 Content Script Isolation Model

Chrome extensions inject content scripts in an **isolated world** — a separate JavaScript execution context that shares the DOM but NOT JavaScript variables with the page.

```
┌─────────────────────────────────────────┐
│ Web Page (Main World)                    │
│  - window, document, page's JS vars     │
│  - CANNOT see content script vars       │
│  - CAN see DOM modifications            │
├─────────────────────────────────────────┤
│ Content Script (Isolated World)          │
│  - Shares DOM with page                 │
│  - Has own window, own JS globals       │
│  - Can use chrome.runtime.sendMessage   │
│  - CANNOT access page's JS variables    │
├─────────────────────────────────────────┤
│ Service Worker (Background)              │
│  - chrome.debugger, chrome.tabs, etc.   │
│  - No DOM access                         │
│  - WebSocket to server                   │
└─────────────────────────────────────────┘
```

### 4.2 Can Pages Detect Content Scripts?

| Vector | Detectable? | Details |
|--------|:-----------:|---------|
| Content script JS variables | ❌ | Isolated world — page can't see them |
| DOM modifications by content script | ✅ | MutationObserver can see added elements, style changes |
| `chrome.runtime.sendMessage` | ❌ | Runs in isolated world, not exposed to page |
| Content script modifying `document.cookie` | ✅ | Shared DOM property |
| Extension's `web_accessible_resources` | ✅ | Page can probe `chrome-extension://[id]/resource.png` to detect installed extension |
| Extension icon in toolbar | ❌ | Not accessible to page JS |
| `chrome.debugger` attachment | ⚠️ | Yellow infobar visible to user, but NOT detectable by page JS |

#### DOM Modification Detection

```javascript
// Page can detect elements added by content scripts
const observer = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.id?.startsWith('__clawd-') || node.className?.includes('clawd')) {
        // Extension UI element detected
      }
    }
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });
```

**Claw'd's exposure**: Content script injects `__clawd-agent-overlay`, `__clawd-cursor-style`, `__clawd-activity-cursor` — these element IDs are discoverable. **Mitigation**: Use randomized/obfuscated element IDs if stealth is desired.

#### `web_accessible_resources` Probing

```javascript
// Page can detect if specific extension is installed
const img = new Image();
img.onload = () => console.log('Extension detected!');
img.onerror = () => console.log('Not installed');
img.src = 'chrome-extension://KNOWN_EXTENSION_ID/icons/app-icon-128.png';
```

**Claw'd's exposure**: If extension ID is known, icons are probeable. **Mitigation**: Don't list resources in `web_accessible_resources` unless needed.

### 4.3 `chrome.scripting.executeScript` with `world: "MAIN"`

```javascript
// Execute in page's main world — CAN access page JS variables
await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  world: 'MAIN',
  func: () => {
    // This runs as if it were page's own JS
    // Can access React state, Redux store, etc.
    return window.__NEXT_DATA__;
  }
});
```

**Detection**: Scripts injected via `chrome.scripting.executeScript({ world: 'MAIN' })` run in the page's main world. The page CANNOT distinguish these from its own code, UNLESS:
1. The script modifies detectable globals
2. The injection timing is observable (e.g., script runs before page expects certain state)
3. Stack traces reveal `chrome-extension://` origins (in some contexts)

### 4.4 Extension vs CDP: Stealth Comparison

| Factor | Extension Content Scripts | Extension + `chrome.debugger` (CDP) | Puppeteer/Playwright (CDP) |
|--------|:---:|:---:|:---:|
| `navigator.webdriver` | ❌ Not set | ❌ Not set | 🔴 Set (unless patched) |
| `cdc_` variables | ❌ None | ❌ None | ❌ None (ChromeDriver only) |
| Headless indicators | ❌ Real browser | ❌ Real browser | 🔴 Many (unless patched) |
| Runtime.enable artifacts | ❌ None | ⚠️ Called | ⚠️ Called |
| Yellow debugger infobar | ❌ None | 🟡 Visible | ❌ None (unless DevTools open) |
| `sourceURL` in stacks | ❌ None | ⚠️ Possible | 🔴 Present |
| DOM fingerprint | ⚠️ Injected elements | ⚠️ If content script active | ❌ None |
| Port scanning | ❌ N/A | ❌ N/A | ⚠️ If debug port exposed |
| Browser profile | ✅ Real user profile | ✅ Real user profile | 🔴 Fresh/empty |
| Canvas/WebGL fingerprint | ✅ Real GPU | ✅ Real GPU | 🔴 SwiftShader/emulated |
| Behavioral (mouse/timing) | ⚠️ Synthetic events | ⚠️ CDP Input events | 🔴 CDP Input events |
| **Overall stealth** | **🟢 Highest** | **🟡 Good** | **🔴 Lowest** |

---

## 5. Anti-Bot Detection Frameworks {#5-anti-bot-frameworks}

### 5.1 Cloudflare Turnstile

**Detection signals** (what their JS challenge checks):
- Browser environment fingerprint: `navigator` properties, screen dimensions, timezone, language
- Canvas/WebGL fingerprinting: renders shapes, hashes pixel data
- Mouse movement entropy: tracks movement patterns for human-likeness (speed variance, bezier curves)
- Keyboard timing: inter-keystroke intervals (too uniform = bot)
- TLS fingerprint (JA3/JA4): Headless Chrome has different TLS fingerprint than real Chrome
- `navigator.webdriver` check
- WebRTC ICE candidates (leak detection)
- JavaScript challenge execution timing
- HTTP/2 frame ordering fingerprint
- DOM interaction timing patterns

**What works (2025)**:
- Real browser with real user profile (extension approach) → highest success
- Residential proxy + undetectable-chromedriver → moderate success
- API solvers (CapSolver, 2Captcha Turnstile) → works but adds latency/cost
- Playwright with stealth plugin + residential IP → occasional success
- **Pure headless**: increasingly failing against Turnstile

### 5.2 DataDome

**Detection signals**:
- Device fingerprinting (canvas, WebGL, audio context)
- Behavioral analysis (mouse, scroll, touch patterns)
- Cookie & storage analysis (fresh vs. returning visitor)
- HTTP header order and values
- TLS/JA3 fingerprinting
- Bot-like request patterns (rate, timing regularity)

**What works**:
- Real browser sessions strongly preferred
- Residential proxies essential (datacenter IPs mostly blocked)
- Human-like delays and randomized interaction patterns
- Maintaining session cookies across requests
- DataDome specifically tracks `dd_s` and `datadome` cookies

### 5.3 PerimeterX / HUMAN (px.js)

**How px.js works**:
1. Loads challenge script from `client.perimeterx.net` or first-party domain
2. Collects 100+ signals: browser APIs, timing, WebGL, canvas, fonts, etc.
3. Generates `_px3` cookie containing encrypted assessment
4. Server validates `_px3` on each request
5. Risk score determines: pass / challenge (CAPTCHA) / block

**Key fingerprints checked**:
```javascript
// PerimeterX checks (simplified):
{
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  webdriver: navigator.webdriver,
  languages: navigator.languages,
  plugins: navigator.plugins.length,
  screenRes: [screen.width, screen.height, screen.colorDepth],
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  canvasHash: /* canvas fingerprint */,
  webglVendor: /* UNMASKED_VENDOR_WEBGL */,
  webglRenderer: /* UNMASKED_RENDERER_WEBGL */,
  audioContext: /* AudioContext fingerprint */,
  fonts: /* available font list via CSS/canvas */,
  touchSupport: 'ontouchstart' in window,
  devtoolsOpen: /* various checks */,
  domAutomation: /* checks for automation frameworks */,
  phantom: window.callPhantom || window._phantom,
  selenium: document.$cdc_asdjflasutopfhvcZLmcfl_,
  webdriverPresent: navigator.webdriver
}
```

**What works**:
- Must solve/maintain `_px3` cookie
- Real browser + realistic fingerprints
- Cannot bypass server-side validation without valid cookie
- Some success with intercepting and replaying challenge responses

### 5.4 Akamai Bot Manager

**Detection signals**:
- `sensor_data` — large encrypted payload collected client-side
- Contains: mouse movements, keyboard events, touch events, device orientation
- JavaScript execution environment checks (stack length, function source matching)
- Cookie: `_abck` is the assessment cookie
- HTTP request characteristics: header order, TLS fingerprint

**Sensor data collection** (simplified):
```javascript
// Akamai collects vast behavioral data into sensor_data:
// - Mouse events: positions, timestamps, velocity, acceleration
// - Keyboard events: keydown/keyup intervals, key codes
// - Touch events: positions, pressure, touch area
// - Device motion: accelerometer, gyroscope data
// - Page visibility events
// - Performance timing data
// - All packed into encrypted string sent to /akam/13/pixel_* endpoint
```

**What works**:
- Must generate valid `sensor_data` — extremely difficult to fake
- Real browser with human interaction is most reliable
- Some tools (e.g., `akamai-sensor-generator`) attempt to replicate but constantly cat-and-mouse
- Residential proxies critical

### 5.5 Kasada

**How it works**:
- Serves a JavaScript challenge (PoW — Proof of Work)
- Client must solve computational challenge proving JS execution
- Generates `x-kpsdk-ct` token
- Checks for: headless indicators, timing anomalies, TLS fingerprint
- Server validates PoW solution + environmental fingerprint

**What works**:
- Extremely difficult to bypass without real browser
- PoW must be solved with their exact JS (can't replay/fake)
- Some success with patched Chrome + residential proxy
- Browser profile age and consistency matters

### 5.6 Universal Anti-Bot Evasion Principles (2025)

| Principle | Why | Implementation |
|-----------|-----|---------------|
| **Real browser, real profile** | Eliminates 90% of fingerprint mismatches | Extension-based approach wins |
| **Residential proxy** | Datacenter IPs are pre-blocked | Use residential proxy services |
| **Consistent fingerprint** | Mix of real+fake signals = detection | Don't patch individual signals, use real hardware |
| **Human-like behavior** | Behavioral analysis is primary signal | Bezier mouse curves, varied timing, scrolling |
| **TLS fingerprint matching** | JA3/JA4 mismatch = instant block | Use real Chrome (not headless) or utls library |
| **Session continuity** | Fresh sessions are suspicious | Maintain cookies, localStorage across visits |
| **Don't fight the challenge** | Solving > bypassing | Use CAPTCHA solving services for hard challenges |

---

## 6. Stealth Techniques in Modern Tools {#6-stealth-tools}

### 6.1 puppeteer-extra-plugin-stealth

**All patches applied** (as of v2.11+):

| Patch | What it does |
|-------|-------------|
| `chrome.app` | Adds `window.chrome.app` object (missing in headless) |
| `chrome.csi` | Adds `window.chrome.csi()` function |
| `chrome.loadTimes` | Adds `window.chrome.loadTimes()` function |
| `chrome.runtime` | Fakes `window.chrome.runtime` with `connect()`, `sendMessage()` |
| `iframe.contentWindow` | Fixes `contentWindow` access on cross-origin iframes |
| `media.codecs` | Adds expected media codec support |
| `navigator.hardwareConcurrency` | Spoofs core count (default: 4) |
| `navigator.languages` | Ensures `navigator.languages` returns `['en-US', 'en']` |
| `navigator.permissions` | Patches `Permissions.query()` to return `'prompt'` for notifications |
| `navigator.plugins` | Spoofs `navigator.plugins` and `navigator.mimeTypes` |
| `navigator.webdriver` | Removes `navigator.webdriver` via `Object.defineProperty` |
| `sourceurl` | Strips `//# sourceURL=` from injected scripts |
| `user-agent-override` | Sets realistic UA string, patches `navigator.userAgent/platform/appVersion` |
| `webgl.vendor` | Spoofs `UNMASKED_VENDOR_WEBGL` and `UNMASKED_RENDERER_WEBGL` |
| `window.outerdimensions` | Fixes `outerWidth/outerHeight` to not reveal DevTools |

**Usage**:
```javascript
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const browser = await puppeteer.launch({ headless: 'new' });
```

### 6.2 undetectable-chromedriver (Python)

**What it does**:
1. Downloads matching ChromeDriver version automatically
2. Binary-patches chromedriver to rename `cdc_` variable
3. Launches Chrome with these flags:
   - `--disable-blink-features=AutomationControlled`
   - `--exclude-switches=enable-automation` (removes "Chrome is being controlled" banner)
   - `--no-first-run`
   - Randomized window size
4. Patches `navigator.webdriver` via CDP
5. Uses real Chrome binary (not Chromium)

```python
import undetected_chromedriver as uc
driver = uc.Chrome(headless=False, use_subprocess=False)
driver.get('https://nowsecure.nl')  # Common bot detection test
```

### 6.3 Playwright Stealth (Community)

**playwright-stealth** (npm package) applies similar patches to Playwright:

```javascript
const { chromium } = require('playwright');
const { newInjectedContext } = require('playwright-stealth');

const browser = await chromium.launch();
const context = await newInjectedContext(browser, {
  // stealth options
});
```

**Patches**: Similar to puppeteer-stealth — webdriver, plugins, WebGL, chrome.runtime, etc.

**Playwright's own stealth features** (built-in as of 2025):
- `--disable-blink-features=AutomationControlled` by default in headed mode
- Realistic viewport sizes
- `Page.addInitScript()` for early injection
- Device emulation with realistic parameters

### 6.4 Camoufox / NopeCHA / FlareSolverr

| Tool | Approach | Status (2025) |
|------|----------|---------------|
| **Camoufox** | Modified Firefox with anti-fingerprinting. Patches canvas, WebGL, etc. at browser level | Active, effective against most |
| **NopeCHA** | Browser extension that auto-solves CAPTCHAs | Active, supports reCAPTCHA, hCaptcha, Turnstile |
| **FlareSolverr** | Proxy that solves Cloudflare challenges via headless browser | Active but less effective against latest Turnstile |
| **curl-impersonate** | curl with TLS/HTTP2 fingerprint matching real browsers | Active, great for API-level scraping |
| **got-scraping** | Node.js HTTP client with browser-like TLS fingerprints | Active |
| **Botright** | Playwright wrapper with anti-detection and CAPTCHA solving | Active |

---

## 7. Extension-Native Automation (No CDP) {#7-extension-native}

### 7.1 What's Possible Without CDP

Using ONLY `chrome.tabs`, `chrome.scripting`, content scripts, and other extension APIs:

| Capability | Possible? | API | Limitation |
|-----------|:---------:|-----|------------|
| Navigate to URL | ✅ | `chrome.tabs.update(tabId, {url})` | |
| Click element | ✅ | `chrome.scripting.executeScript` → `el.click()` | Synthetic — some React apps detect synthetic clicks |
| Type in input | ✅ | `executeScript` → `el.value = x; el.dispatchEvent(new Event('input'))` | Some frameworks need `KeyboardEvent` sequence |
| Read page content | ✅ | `executeScript` → `document.body.innerText` | |
| Screenshot | ✅ | `chrome.tabs.captureVisibleTab()` | Only visible viewport, only active tab |
| Full-page screenshot | ❌ | N/A without CDP | Need CDP `Page.captureScreenshot` with clip |
| Read HttpOnly cookies | ✅ | `chrome.cookies.getAll()` | Needs `cookies` permission |
| Intercept network | ⚠️ | `chrome.webRequest` / `declarativeNetRequest` | MV3: can observe but not block/modify body |
| File upload | ❌ | Cannot programmatically set file input | CDP `DOM.setFileInputFiles` needed |
| Handle JS dialogs | ❌ | Cannot dismiss alert/confirm/prompt | CDP `Page.handleJavaScriptDialog` needed |
| Iframe interaction | ⚠️ | `executeScript` with `frameIds` | Cross-origin iframes need `<all_urls>` |
| Read `window` variables | ✅ | `executeScript({ world: 'MAIN' })` | |
| Keyboard shortcuts | ⚠️ | `dispatchEvent(new KeyboardEvent(...))` | Synthetic events, may not trigger all listeners |
| Drag & drop | ⚠️ | Complex synthetic event sequence | Unreliable in many frameworks |
| Scroll | ✅ | `executeScript` → `window.scrollTo()` | |
| Get element coordinates | ✅ | `executeScript` → `el.getBoundingClientRect()` | |
| Multi-tab management | ✅ | `chrome.tabs.*` | |
| Download files | ✅ | `chrome.downloads.download()` | |
| PDF generation | ❌ | N/A without CDP | CDP `Page.printToPDF` needed |
| Frame tree enumeration | ⚠️ | `chrome.webNavigation.getAllFrames()` | Less detail than CDP |
| Touch events | ❌ | Synthetic touch events unreliable | CDP `Input.dispatchTouchEvent` needed |
| Device emulation | ❌ | N/A | CDP `Emulation.*` needed |
| Network throttling | ❌ | N/A | CDP `Network.emulateNetworkConditions` needed |
| Console/error capture | ⚠️ | Content script can override `console.*` | Not as clean as CDP `Runtime.consoleAPICalled` |
| Performance metrics | ⚠️ | `PerformanceObserver` in content script | Less than CDP `Performance.*` |

### 7.2 Critical Limitations Without CDP

1. **File uploads**: `<input type="file">` cannot be set programmatically from JS (security restriction). CDP's `DOM.setFileInputFiles` is the only way
2. **JS dialogs**: `alert()`, `confirm()`, `prompt()` block JS execution. Without CDP `Page.handleJavaScriptDialog`, the page freezes
3. **Full-page screenshots**: `captureVisibleTab` only captures the viewport. CDP allows specifying clip regions and full-page capture
4. **Synthetic vs trusted events**: Events dispatched from JS are marked `isTrusted: false`. Some sites reject untrusted events. CDP `Input.dispatch*` produces trusted events
5. **HTTP authentication**: Cannot handle HTTP 401 Basic/Digest auth programmatically without CDP Fetch domain

### 7.3 Hybrid Approach: Extension APIs + Selective CDP

The sweet spot — use extension APIs for most operations (stealthiest), fall back to CDP only when needed:

```
Stealth Tier 1 (Extension-only, zero CDP fingerprint):
  ✅ Navigation via chrome.tabs
  ✅ DOM reading/clicking via chrome.scripting
  ✅ Cookie access via chrome.cookies
  ✅ Viewport screenshots via captureVisibleTab
  ✅ Download management via chrome.downloads

Stealth Tier 2 (CDP for enhanced capabilities):
  ⚠️ Input.dispatchMouseEvent for trusted click events
  ⚠️ Input.dispatchKeyEvent for trusted keyboard events
  ⚠️ Page.captureScreenshot for full-page/element screenshots

Stealth Tier 3 (CDP required, higher detection risk):
  🔴 Runtime.evaluate for JS execution in frames
  🔴 DOM.setFileInputFiles for file uploads
  🔴 Page.handleJavaScriptDialog for alerts/confirms
  🔴 Emulation.* for device simulation
```

### 7.4 Extension-Only Architecture Pattern

```javascript
// manifest.json (NO debugger permission)
{
  "manifest_version": 3,
  "permissions": ["activeTab", "tabs", "scripting", "cookies", "downloads"],
  "host_permissions": ["<all_urls>"],
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content-script.js"],
    "run_at": "document_idle"
  }]
}

// service-worker.js — Extension-only automation
async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  return new Promise(resolve => {
    chrome.tabs.onUpdated.addListener(function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function click(tabId, selector) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN', // run in page context for isTrusted events
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: 'Element not found' };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { success: true };
    },
    args: [selector]
  });
  return result.result;
}

async function type(tabId, selector, text) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (sel, txt) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false };
      el.focus();
      el.value = '';
      // Simulate realistic typing with individual KeyboardEvents
      for (const char of txt) {
        el.value += char;
        el.dispatchEvent(new InputEvent('input', { 
          data: char, inputType: 'insertText', bubbles: true 
        }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    },
    args: [selector, text]
  });
  return result.result;
}

async function screenshot(tabId) {
  // Must be active tab in focused window
  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'png'
  });
  return dataUrl;
}

async function getCookies(domain) {
  return chrome.cookies.getAll({ domain });
}

async function getPageContent(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      title: document.title,
      url: location.href,
      text: document.body.innerText.substring(0, 50000)
    })
  });
  return result.result;
}
```

**Note on `isTrusted`**: Even with `world: 'MAIN'`, synthetic events dispatched via `el.click()` or `new MouseEvent()` have `isTrusted: false`. Only actual user gestures and CDP `Input.dispatch*` commands produce `isTrusted: true` events. This is the #1 limitation of pure extension approach.

---

## 8. Recommendations for Claw'd {#8-recommendations}

### 8.1 Current State Assessment

Claw'd's extension currently uses `chrome.debugger` for ALL operations. This is:
- **Functional**: Full CDP access, everything works
- **Stealthy enough**: No `navigator.webdriver`, no `cdc_`, no headless artifacts, real browser profile
- **Main weakness**: `Runtime.enable` called on every `ensureDebugger()`, yellow infobar visible

### 8.2 Recommended Changes (Priority Order)

#### P0: Add `cookies` Permission
```json
// manifest.json — add "cookies" to permissions
"permissions": ["activeTab", "tabs", "scripting", "debugger", 
                "offscreen", "storage", "downloads", "downloads.ui",
                "cookies", "<all_urls>"]
```
Enables `chrome.cookies.getAll()` for HttpOnly cookie access without CDP.

#### P1: Obfuscate Content Script DOM Fingerprint
Claw'd injects elements with IDs like `__clawd-agent-overlay`, `__clawd-cursor-style`. If stealth matters:
```javascript
// Generate random prefix per session
const prefix = '__' + Math.random().toString(36).substring(2, 8);
// Use: `${prefix}-overlay` instead of `__clawd-agent-overlay`
```

#### P2: Hybrid CDP — Lazy Attachment
Only attach debugger when CDP-specific features are needed (file upload, dialog handling, element screenshots). Use extension APIs for navigation, clicking, typing, viewport screenshots.

```javascript
// Smart dispatch: use extension API when possible, CDP when needed
async function dispatchCommand(method, params) {
  const cdpRequired = ['file_upload', 'dialog', 'emulate', 'touch', 'frames'];
  if (cdpRequired.includes(method)) {
    await ensureDebugger(params.tabId);
    return dispatchViaCDP(method, params);
  }
  return dispatchViaExtensionAPI(method, params);
}
```

#### P3: Minimize `Runtime.enable` Exposure
If CDP is needed, consider NOT calling `Runtime.enable` unless frame context tracking is actually required. `Page.enable` and `Fetch.enable` are less detectable.

### 8.3 When to Use What

| Scenario | Approach |
|----------|---------|
| Controlling user's own browser (Claw'd's use case) | Extension + selective CDP ✅ |
| Scraping with stealth requirements | Extension-only or Camoufox |
| Testing automation | Playwright (stealth not needed) |
| Bypassing heavy anti-bot (Cloudflare, Akamai) | Real browser + residential proxy + human solver |

---

## 9. Unresolved Questions {#9-unresolved}

1. **`Runtime.enable` detection in practice** — No public documentation confirms that anti-bot scripts specifically check for `Runtime.enable` side effects via `chrome.debugger`. Needs empirical testing against Turnstile, DataDome, etc.

2. **Yellow infobar detection from JS** — Confirmed that page JS cannot detect the "debugging" infobar, but can Cloudflare's TLS/browser fingerprint detect the extension's debugger attachment at a lower level?

3. **`chrome.scripting.executeScript({ world: 'MAIN' })` stack traces** — Can page code detect that a script was injected via `chrome.scripting` by examining `Error().stack`? Needs testing.

4. **Trusted events without CDP** — Is there ANY way to dispatch `isTrusted: true` events from an extension without using `chrome.debugger` / CDP? (Current answer: No. The `isTrusted` property is read-only and set by the browser.)

5. **Anti-bot frameworks testing `chrome.debugger`** — Do any current anti-bot systems specifically test for `chrome.debugger` attachment (separate from DevTools detection)? Claw'd's approach is unusual enough that it may fly under the radar.

6. **MV3 `chrome.webRequest` in 2026** — Google has indicated `webRequest` blocking will be further restricted. How will this affect cookie header interception?

7. **Extension fingerprinting via timing** — Can sites detect extension presence by timing `chrome.runtime.sendMessage` response times or content script injection delays?

---

*Research based on: codebase analysis of Claw'd browser extension (manifest.json, service-worker.js, content-script.js), Chrome Extension MV3 documentation, Chromium source code analysis, puppeteer-extra-plugin-stealth source, undetectable-chromedriver source, and domain expertise in browser automation and anti-bot systems.*
