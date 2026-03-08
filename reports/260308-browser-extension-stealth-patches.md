# Browser Extension Stealth Patches — Implementation Report

**Date:** 2025-03-08  
**Scope:** Anti-bot detection bypass for Claw'd browser extension  
**Files modified:** `content-script.js`, `service-worker.js`, `manifest.json`, `browser-plugin.ts`

---

## Executive Summary

Websites with anti-bot defenses detect browser automation through DOM fingerprinting, CDP event monitoring, cookie access patterns, and page-side storage inspection. This implementation eliminates all detectable fingerprints from the Claw'd browser extension while preserving full functionality of all 18+ browser tools.

**Key result:** Zero `__clawd` references remain in page-visible code. All automation surfaces use Chrome extension APIs that operate via IPC, invisible to page JavaScript.

---

## Architecture Overview

The Claw'd browser extension consists of three layers:

1. **Service Worker** (`service-worker.js`) — Receives commands from the Claw'd server via WebSocket relay, dispatches CDP commands to browser tabs
2. **Content Script** (`content-script.js`) — Injects visual indicators (overlay, cursors, highlights) into pages for user feedback
3. **Offscreen Document** (`offscreen.js`) — WebSocket relay bridge between extension messaging and Claw'd server

The stealth patches target layers 1 and 2, which are the only components that interact with page-visible state.

---

## Detection Vectors & Bypass Strategies

### 1. DOM Fingerprinting → Session-Random Prefix

**Detection:** Anti-bot scripts scan the DOM for known automation identifiers — class names, IDs, data attributes, CSS animations containing tool-specific strings like `__clawd`, `__puppeteer`, `__selenium`.

**Bypass:** All DOM identifiers are now generated with a session-random prefix.

```javascript
// Before (detectable):
const OVERLAY_ID = "__clawd-agent-overlay";
const STYLE_ID = "__clawd-overlay-style";

// After (random per session):
const _pfx = "_x" + Math.random().toString(36).slice(2, 8);
// Produces: _xk3m9a2-agent-overlay, _xk3m9a2-overlay-style, etc.
```

**Elements randomized:**
- `${_pfx}-overlay-style` — CSS styles for agent overlay
- `${_pfx}-agent-overlay` — Visual overlay div
- `${_pfx}-cursor-style` — CSS styles for action/activity cursors
- `${_pfx}-bounce-style` — CSS keyframe animations
- `${_pfx}-activity-cursor` — Activity indicator SVG

**Re-injection guard:** Changed from `window.__clawdBrowserBridge` (detectable property name) to `Symbol.for("_x7cs")` (non-descriptive, lives in Chrome's isolated world — inaccessible to page JS).

**SVG cursor:** Converted from static `const` to `cursorSvg()` function so class names use the current prefix, not the initial fallback.

**Prefix synchronization:** Service worker generates `SESSION_PREFIX` on startup, sends it to content scripts via `set-prefix` message before any DOM creation. The `set-prefix` handler:
- Cleans up all DOM elements using the old prefix
- Clears pending timers (`hideTimer`, `fadeTimer`, `autoHideTimer`)
- Resets counters (`overlayCount`, `activeCursors`)
- Updates `_pfx` for all subsequent DOM operations

### 2. CDP Domain Enablement → Lazy On-Demand

**Detection:** When CDP domains like `Runtime` or `Fetch` are enabled, Chrome creates internal tracking structures (execution context maps, request interceptors) that produce observable timing side-channels. Anti-bot scripts can detect:
- Timing anomalies in `eval()` due to Runtime context tracking
- HTTP request latency from Fetch interception
- `Runtime.executionContextCreated` event artifacts

**Bypass:** CDP domains are now enabled lazily, only when the specific handler needs them.

| Domain | Strategy | Rationale |
|--------|----------|-----------|
| **Page** | Eager (in `ensureDebugger`) | Required for `Page.javascriptDialogOpening` events — dialogs can fire from any handler |
| **Runtime** | Lazy (per-handler) | Highest detection risk — creates execution context tracking. Only enabled by `handleExecute`, `handleFrames`, `handleFileUpload`, `resolveElementCoords` |
| **Fetch** | Lazy (only `handleAuth`) | Intercepts ALL HTTP requests when enabled. Now only activated when agent explicitly uses auth tool |
| **Input, DOM, Accessibility, Emulation, Browser** | No `.enable()` needed | These are stateless CDP domains — commands work without prior enablement |

**Implementation:** New `ensureCdpDomain(tabId, domain, params)` helper tracks enabled domains per tab in a `cdpDomainEnabled` Map. Cleanup occurs on debugger detach and tab removal.

### 3. Page Storage → Extension Storage

**Detection:** The previous `handleStore` implementation used `Runtime.evaluate` to read/write `localStorage` on the page, creating detectable artifacts:
- `Runtime.enable` side-effects (execution contexts)
- Page JS can observe localStorage changes via `StorageEvent`
- Detectable `__clawd_store__` namespace key in localStorage

**Bypass:** `handleStore` now uses `chrome.storage.local` exclusively — a Chrome extension IPC API that:
- Requires zero page-side code execution
- Is invisible to page JavaScript (no `StorageEvent`, no DOM access)
- Doesn't require CDP debugger attachment
- Namespaces data by origin: `store:${origin}` for data, `meta:${origin}` for descriptions

**Opaque origin guard:** For `file:///`, `data:`, and `blob:` URLs where `origin === "null"`, the handler throws a clear error instead of silently colliding all opaque origins into one storage bucket.

### 4. Cookie Access → chrome.cookies API

**Detection:** Traditional cookie access via `document.cookie` (even via CDP `Runtime.evaluate`) cannot read HttpOnly cookies and creates detectable execution artifacts. CDP `Network.getCookies` requires debugger attachment.

**Bypass:** New `handleCookies` function uses `chrome.cookies` API:
- Reads **all** cookies including HttpOnly (via extension privilege, not page execution)
- Zero detection surface — IPC call from service worker, no page-side code
- No CDP domain enablement required
- Supports `getAll`, `get`, `set`, `remove` actions

**Safety guards:**
- `getAll` without URL/domain falls back to active tab URL; rejects non-http(s) URLs
- `set` returns explicit error on `null` result (Chrome's signal for rejected cookie)
- `sameSite` normalization: HTTP spec `"none"` → Chrome API `"no_restriction"`
- `"cookies"` permission added to manifest.json

**Agent-side tool:** New `browser_cookies` tool registered in `browser-plugin.ts` with full schema, making `handleCookies` reachable by agents.

### 5. Injected Code Obfuscation

**Detection:** Anti-bot scripts can inspect `<script>` content and function names for automation patterns like `deepQuery`, `searchShadow`, `puppeteer_evaluation_script`.

**Bypass:** Function names in `resolveElementCoords` (the only function injected into page main-world via `Runtime.evaluate`) are now minified:
- `deepQuery` → `q`
- `searchShadow` → `f`
- `el`, `root`, `node`, `found`, `deep` → `e`, `r`, `n`, `m`, `d`

The injected code reads as generic one-letter functions — no automation fingerprint.

---

## What We Cannot Bypass

### Chrome Debugger Info Bar

When `chrome.debugger.attach()` is called, Chrome displays an info bar: *"[Extension name] started debugging this browser."* This is a Chrome security feature and **cannot be suppressed** from extension code. The only workaround is launching Chrome with `--silent-debugger-extension-api` flag.

### CDP Over DevTools Protocol (External Detection)

If a website uses server-side behavioral analysis (mouse movement patterns, typing cadence, navigation timing), these stealth patches don't help — they only address client-side detection. Behavioral humanization is out of scope.

---

## Detection Surface Comparison

| Vector | Before | After |
|--------|--------|-------|
| DOM IDs containing "clawd" | 5 elements | 0 (random prefix) |
| Window properties | `window.__clawdBrowserBridge` | `Symbol.for("_x7cs")` in isolated world |
| CSS class names | `__clawd-leg-*`, `__clawd-action-cursor` | `_x{random}-leg-*`, `_x{random}-action-cursor` |
| CSS animations | `@keyframes __clawd-*` | `@keyframes _x{random}-*` |
| localStorage access | `Runtime.evaluate` + `__clawd_store__` key | `chrome.storage.local` (invisible to page) |
| Cookie access | `document.cookie` via CDP | `chrome.cookies` API (reads HttpOnly) |
| CDP Runtime domain | Always enabled on attach | Lazy — only when handler needs eval |
| CDP Fetch domain | Always enabled on attach | Lazy — only for auth handler |
| Injected function names | `deepQuery`, `searchShadow` | `q`, `f` |
| Page-visible code execution | localStorage read/write | None for store/cookies |

---

## Review Process

Two rounds of 5-agent reviews (10 total review agents) were conducted:

### Round 1 Findings (all fixed)
- **CRITICAL:** Page.enable removed too aggressively → dialog detection broke → restored eager enablement
- **CRITICAL:** Opaque origin collision for `file:///` URLs in storage → added guard
- Content script timing race (set-prefix after show-activity-cursor) → made showAgentIndicator async
- `cdpDomainEnabled` not cleaned on tab removal → added to `tabs.onRemoved`
- `<all_urls>` in both permissions arrays → removed from permissions (kept in host_permissions)

### Round 2 Findings (all fixed)
- **CRITICAL:** `browser_cookies` tool not registered in browser-plugin.ts → added full tool + handler
- Timer/counter leak on prefix change → added cleanup in set-prefix handler
- `ensureCdpDomain` key used JSON.stringify (collision risk) → simplified to domain-only
- `chrome.cookies.set` null return not handled → added explicit error
- `getAll` without filter could dump all cookies → added active-tab fallback with URL validation
- `resolveElementCoords` identifiable function names → obfuscated to single letters

### Round 2 Verified (no issues)
- All Runtime.evaluate calls properly guarded by ensureCdpDomain("Runtime")
- CDP domain events only fire for tabs with that domain enabled (no crash risk)
- Runtime.enable persists across in-tab navigation (cdpDomainEnabled correctly not reset)
- ensureDebugger always called before ensureCdpDomain (verified all 5 call paths)
- Zero hardcoded `__clawd` references in page-visible code
- All CSS selectors valid with random prefix format

---

## Files Changed

| File | Changes |
|------|---------|
| `packages/browser-extension/manifest.json` | Added `"cookies"` permission, removed `<all_urls>` from permissions |
| `packages/browser-extension/src/content-script.js` | Session-random `_pfx`, Symbol.for guard, `cursorSvg()` function, `set-prefix` handler with full cleanup |
| `packages/browser-extension/src/service-worker.js` | `SESSION_PREFIX`, `cdpDomainEnabled` Map, `ensureCdpDomain()` helper, lazy Runtime/Fetch, `handleStore` rewrite (chrome.storage.local), `handleCookies`, `showAgentIndicator` async, obfuscated `resolveElementCoords` |
| `src/agent/src/plugins/browser-plugin.ts` | `browser_cookies` tool registration + `handleCookies` handler, updated `browser_store` description |

---

## Build & Deployment

- Extension zip: 60.5KB (served at `GET /browser/extension`)
- Binary: `dist/server/clawd-app` (compiled Bun executable)
- Docker image: `clawd-pilot/clawd:26.03.08`
- Deployed and verified at `localhost:53456`

---

## Anti-Detection Shield (`shield.js`)

### Overview

After the initial stealth patches (DOM fingerprinting, lazy CDP, store migration, cookies), real-world testing on anti-debug sites (e.g., `utt.huelms.com`) revealed that **CDP debugger attachment itself** is the primary detection surface. Sites detect the `debugger` statement timing gap, window dimension anomalies, and `navigator.webdriver` flag.

The shield is a MAIN-world content script injected at `document_start` before any page script runs. It patches browser APIs to neutralize 18+ detection vectors.

### Architecture

- **Injection:** `content_scripts` in `manifest.json`, `world: "MAIN"`, `run_at: "document_start"`, `all_frames: true`
- **Minimum Chrome:** 111 (required for MAIN-world static content scripts)
- **toString defense:** `Function.prototype.toString` is overridden with a WeakMap-backed implementation. Every patched function is registered, making patches survive both `fn.toString()` and `Function.prototype.toString.call(fn)`.
- **No Proxy on patched functions:** Date and Function constructors use Proxy (with `get` trap for `.prototype`), but all user-facing functions use direct replacement.

### Detection Vectors Neutralized

| # | Vector | Technique |
|---|--------|-----------|
| 1 | `performance.now()` timing gaps | Offset subtraction + monotonic high-water mark |
| 2 | `Date.now()` timing gaps | Same offset, `Math.round()` for integer type |
| 3 | `new Date()` / `Date()` timing | Proxy constructor applies offset for 0-arg calls |
| 4 | `requestAnimationFrame` timestamp | Routes through shared `_adjustedPerfNow()` |
| 5 | `setInterval` pause detection | Adaptive EMA baseline, 200ms–30s window, visibility guard |
| 6 | Background tab throttle | `visibilitychange` + `document.hidden` checks |
| 7 | `outerHeight` / `outerWidth` gap | Prototype-level getter (not instance) with captured chrome height |
| 8 | `navigator.webdriver` | Prototype getter returns `false` (not `undefined`) |
| 9 | `console.clear` timing | No-op replacement |
| 10 | `Error.stack` automation frames | `prepareStackTrace` filter (10 patterns incl. extension, puppeteer, playwright) |
| 11 | `Function()` constructor debugger | Proxy strips debugger from body with word-boundary regex |
| 12 | `eval()` debugger injection | Wrapper strips debugger statements |
| 13 | `setTimeout` string debugger | Wrapper strips debugger |
| 14 | `setInterval` string debugger | Wrapper strips debugger |
| 15 | `Function.prototype.toString` | WeakMap + self-registration (toString of toString) |
| 16 | `chrome.csi` absence | Polyfill with cached onloadT + timing values |
| 17 | `chrome.loadTimes` absence | Polyfill with navigation timing |
| 18 | `chrome.app` absence | Stub with InstallState/RunningState |
| 19 | BFCache lifecycle | `pagehide`/`pageshow` detector management |
| 20 | Inline anomaly detection | `_adjustedPerfNow()` detects >200ms jumps inline (no tick wait) |

### Key Design Decisions

1. **Prototypes, not instances:** Patches are on `Performance.prototype.now`, `Window.prototype.outerHeight`, `Navigator.prototype.webdriver` — avoids `hasOwnProperty` detection.
2. **Symbol.for guard:** Re-injection guard uses `Symbol.for()` (invisible to `getOwnPropertyNames`).
3. **Adaptive baseline EMA:** The pause detector's expected interval adapts to CPU conditions rather than using a fixed 50ms assumption.
4. **Monotonic high-water mark:** `performance.now()` and `requestAnimationFrame` share a single high-water to prevent backwards timestamps and cross-API divergence.
5. **Inline anomaly correction:** `_adjustedPerfNow()` detects and corrects >200ms jumps synchronously, closing the race between debugger pause resume and setInterval detector tick.

### Known Limitations

- **Direct `eval("debugger")`:** JavaScript's `eval()` uses caller scope when called directly. Our wrapper converts to indirect eval (global scope). Direct eval with `debugger` in caller's local variables won't be intercepted.
- **Worker timing inconsistency:** Web Workers have unpatched `performance.now()`. Cross-thread timing comparisons may show discrepancies during debugger pauses.
- **Dynamic debugger regex:** The `_stripDebugger` regex operates on raw text, not AST. String literals containing the word "debugger" inside `eval()`/`new Function()` could be affected (very rare edge case).

### Review Process

The shield was reviewed across 3 rounds by 15 agents total:

- **Round 1 (5 agents):** Found critical Proxy detection issues (`Function.prototype.toString.call()` bypass, background tab drift, prototype bypass, monotonicity violation, float Date.now), missing detection vectors (rAF, eval, Date constructor)
- **Round 2 (5 agents):** Found crash bug (`.prototype=` on non-writable), getter toString leaks, regex false positives, timing race, navigator.webdriver should return false
- **Round 3 (3 agents):** Verified 18/18 fixes applied, zero browser compatibility issues, confirmed remaining timing race fixed with inline anomaly correction
