# Code Review: Browser Extension Connection Flow — End-to-End Trace

## Scope
- **Files:** 11 files (3,295 LOC)
  - `src/index.ts` (fetch handler, WS upgrade routing)
  - `src/server/browser-bridge.ts` (WS server, command relay)
  - `src/server/websocket.ts` (WS dispatcher)
  - `src/config-file.ts` (config loader + cache)
  - `packages/browser-extension/` (manifest, service-worker, offscreen, popup, content-script)
- **Focus:** End-to-end WebSocket connection trace — extension → server
- **Branch:** `feat/browser` (commits `230fb38`, `96ff5ce`)

## Overall Assessment

The browser extension architecture is well-designed — offscreen document for persistent WS, service worker for chrome.* APIs, clean JSON-RPC protocol. However, the connection flow has **one critical silent-failure bug** and **two high-priority code quality issues** that together explain the "Connecting..." / no-logs symptom.

---

## End-to-End Trace: What SHOULD Happen vs What ACTUALLY Happens

### Step 1: User loads extension via "Load unpacked" ✅
- `chrome.runtime.onInstalled` fires in `service-worker.js:486`
- Calls `ensureOffscreen()` at line 24
- **Verdict:** Works correctly. Manifest has `"offscreen"` permission, `"reasons": ["WORKERS"]` matches `createDocument()` call. URL `"src/offscreen.html"` resolves correctly relative to extension root.

### Step 2: Offscreen document created ✅
- `offscreen.html` loads `offscreen.js` via `<script src="offscreen.js">` (relative to `src/`, resolves to `src/offscreen.js`)
- Bottom of `offscreen.js` (line 222-223): `keepAlive()` then `connect()` execute

### Step 3: `connect()` builds WebSocket URL ✅
- Reads `chrome.storage.local` for saved config
- Generates `extensionId = crypto.randomUUID().slice(0, 8)` → e.g. `"550e8400"` (hex chars only)
- Builds URL: `ws://localhost:3456/browser/ws?extId=550e8400`
- `new WebSocket(url)` creates connection attempt

### Step 4: HTTP upgrade request hits Bun.serve `fetch` handler ⚠️
- `src/index.ts:462`: `const url = new URL(req.url)` → pathname = `/browser/ws` ✅
- `src/index.ts:463`: `const path = url.pathname` → `/browser/ws` (no query params) ✅
- `src/index.ts:466`: `path === "/ws"` → false, skips chat WS ✅
- `src/index.ts:473`: `path === "/browser/ws"` → **true, enters browser WS block** ✅
- Route ordering is correct — browser WS is BEFORE catch-all static file serving (line 502) and `handleRequest` (line 510) ✅

### Step 5: `isBrowserEnabled()` gate check — 🔴 CRITICAL SILENT FAILURE POINT

```typescript
// index.ts:474-477
const { isBrowserEnabled } = require("./config-file");
if (!isBrowserEnabled()) {
  return new Response("Browser features not enabled", { status: 403 });
}
```

**Three problems here:**

#### 5a. Config is permanently cached — no reload possible

`loadConfigFile()` in `config-file.ts:74-90` caches to a module-level `_cached` variable with NO invalidation:

```typescript
let _cached: ConfigFile | null = null;
export function loadConfigFile(): ConfigFile {
  if (_cached) return _cached;  // NEVER re-reads after first load
  // ... reads ~/.clawd/config.json, caches forever
}
```

If the server was started before `"browser": true` was added to `~/.clawd/config.json`, `isBrowserEnabled()` returns `false` forever. **The user MUST restart the server** after adding `browser: true`. Nothing in the README or error message indicates this.

#### 5b. Silent 403 — ZERO logging 🔴

When `isBrowserEnabled()` returns `false`, the server returns `403` with **NO console.log**. The server truly shows "no connection logs" because it actively suppresses its only chance to log. This is the **primary reason for the debugging dead-end**.

Compare with every other rejection path in the server which logs its decisions.

#### 5c. `require()` instead of static `import`

Line 89 already does `import { loadConfigFile, isWorkspacesEnabled } from "./config-file"` but `isBrowserEnabled` is loaded via `require()` on line 474. This is inconsistent:
- `isWorkspacesEnabled` is a static ESM import (line 89)
- `isBrowserEnabled` is a CJS `require()` at call-time (line 474)

In Bun, `require()` and `import` *usually* share the module cache for .ts files, but mixing them is a code smell that could cause dual-instance issues in other bundlers and makes the code harder to reason about.

### Step 6: Async WebSocket upgrade — ⚠️ HIGH risk pattern

```typescript
// index.ts:478
return import("./server/browser-bridge").then(({ upgradeBrowserWs }) =>
  upgradeBrowserWs(req, server)
);
```

**The upgrade happens inside an async `import().then()` callback**, meaning `server.upgrade(req)` executes one microtask later than the synchronous chat WS upgrade.

Compare — chat WS (synchronous, line 466-469):
```typescript
if (server.upgrade(req, { data: { userId } })) return undefined;  // SYNC
```

Browser WS (async, line 478):
```typescript
return import("./server/browser-bridge").then(...)  // ASYNC microtask
```

**Mitigating factor:** The workspace noVNC proxy at line 484 uses the identical `import().then()` pattern, and `browser-bridge.ts` is already eagerly loaded via the `websocket.ts` import chain (`websocket.ts:10-15` → `import { handleBrowserWsOpen, ... } from "./browser-bridge"`). So the dynamic `import()` resolves from cache instantly. Bun's docs confirm async upgrades work.

**However:** This is unnecessary indirection. The module is already loaded — the dynamic import serves no purpose.

### Step 7: `upgradeBrowserWs()` — extId validation ✅ (with dead code)

```typescript
// browser-bridge.ts:164-165
const extId = rawExtId && EXT_ID_PATTERN.test(rawExtId)
  ? rawExtId
  : `ext_${randomBytes(4).toString("hex")}`;  // <-- DEAD CODE for invalid extId

// browser-bridge.ts:167-169
if (rawExtId && !EXT_ID_PATTERN.test(rawExtId)) {
  return new Response("Invalid extension ID", { status: 400 });  // Returns BEFORE fallback is used
}
```

The fallback `extId` on line 165 is never used when `rawExtId` is invalid because line 168 returns 400 first. The extension sends valid hex IDs (`crypto.randomUUID().slice(0, 8)` → `[0-9a-f]{8}`), which pass the regex `/^[a-zA-Z0-9_-]{1,64}$/`. So this doesn't cause the bug — it's just dead code.

### Step 8-12: If upgrade succeeds ✅

Once `server.upgrade()` returns `true`:
- `handleWebSocketOpen` in `websocket.ts:36-43` dispatches via `ws.data.type === "browser-extension"` ✅
- `handleBrowserWsOpen` logs `"[browser-bridge] Extension connected: ..."` ✅
- Extension's `ws.onopen` fires → `broadcastStatus(true)` ✅
- Popup receives `connection-status` message → shows "Connected" ✅

**This path is correctly implemented. The problem is that the flow never reaches here.**

---

## Root Cause Diagnosis

### 🔴 PRIMARY ROOT CAUSE: Silent 403 from stale config cache

**Scenario:** Server starts → reads `~/.clawd/config.json` → `browser` field is absent or `false` → cached permanently. User later adds `"browser": true` to config. Extension attempts WebSocket connection. Server checks `isBrowserEnabled()` → reads stale cache → returns `false` → sends `403` with **zero logging** → extension gets `onerror` + `onclose` → enters reconnect loop forever.

The extension's `ws.onerror` fires (generic error, no details), then `ws.onclose` fires with a non-1000 code. `broadcastStatus(false)` is called. The popup would show "Disconnected" (after a brief flash of "Connecting..." from the initial HTML state).

**Evidence:**
1. Server shows "no connection logs" — confirmed: the 403 path has no `console.log`
2. Config file on disk shows `"browser": true` — but the cached value may differ
3. The extension reconnect loop runs every 3 seconds — would produce periodic 403s, all silent

### ⚠️ CONTRIBUTING FACTOR: No diagnostic feedback to the extension

When the server returns 403, the extension's WebSocket gets a generic connection error. `ws.onerror` receives no status code or message (WebSocket API limitation). The offscreen document logs `"[clawd-offscreen] WebSocket error:"` but with no useful details. The user has no way to distinguish "server not running" from "browser feature disabled" from "upgrade failed."

---

## Issues by Priority

### Critical

| # | Issue | File:Line | Fix |
|---|-------|-----------|-----|
| 1 | **Silent 403 — no logging on browser gate rejection** | `index.ts:475-476` | Add `console.log("[browser] WS rejected: browser features not enabled in config")` before the 403 return |
| 2 | **Permanently cached config — no invalidation** | `config-file.ts:71-75` | Add cache TTL or `reloadConfig()` export; at minimum, don't cache on the WS upgrade hot path |

### High

| # | Issue | File:Line | Fix |
|---|-------|-----------|-----|
| 3 | **Mixed `require()` / `import` for same module** | `index.ts:89 vs 474` | Add `isBrowserEnabled` to the static import on line 89, remove `require()` |
| 4 | **Unnecessary dynamic `import()` for already-loaded module** | `index.ts:478` | Static-import `upgradeBrowserWs` from `./server/browser-bridge` and call it directly |
| 5 | **No server-side feedback on upgrade failure** | `browser-bridge.ts:180` | Add `console.warn("[browser-bridge] WebSocket upgrade failed for extId:", extId)` |

### Medium

| # | Issue | File:Line | Fix |
|---|-------|-----------|-----|
| 6 | **Dead code: fallback extId never used for invalid IDs** | `browser-bridge.ts:164-169` | Remove the ternary fallback; just validate and reject or use rawExtId directly |
| 7 | **No health-check endpoint for browser bridge status** | N/A | Add `/api/browser/status` that returns `{ enabled, connected, extensionCount }` |
| 8 | **Popup shows "Connecting..." before first status check completes** | `popup.html:107` | Initialize text to "Checking..." or trigger status check immediately with visual feedback |

### Low

| # | Issue | File:Line | Fix |
|---|-------|-----------|-----|
| 9 | **`waitForTab` uses anti-pattern: `new Promise(async ...)` in service-worker** | `service-worker.js:452` | Refactor to avoid async executor (swallows rejections) |
| 10 | **Content script re-injection guard uses `window.__clawdBrowserBridge`** | `content-script.js:10` | Use a Symbol or more unique key to avoid conflicts with page scripts |

---

## Recommended Fix (Ordered)

### Fix 1: Add logging + fix the import (addresses issues #1, #3, #4)

In `src/index.ts`, change lines 472-479 from:
```typescript
// Browser extension WebSocket bridge (only when browser enabled)
if (path === "/browser/ws") {
  const { isBrowserEnabled } = require("./config-file");
  if (!isBrowserEnabled()) {
    return new Response("Browser features not enabled", { status: 403 });
  }
  return import("./server/browser-bridge").then(({ upgradeBrowserWs }) => upgradeBrowserWs(req, server));
}
```

To:
```typescript
// Browser extension WebSocket bridge (only when browser enabled)
if (path === "/browser/ws") {
  if (!isBrowserEnabled()) {
    console.log("[browser] WebSocket rejected: browser features not enabled in ~/.clawd/config.json");
    return new Response("Browser features not enabled. Add \"browser\": true to ~/.clawd/config.json and restart.", {
      status: 403,
    });
  }
  return upgradeBrowserWs(req, server);
}
```

And at the top of the file (line 89), add the missing imports:
```typescript
import { loadConfigFile, isWorkspacesEnabled, isBrowserEnabled } from "./config-file";
```

Add to existing import section (or new line):
```typescript
import { upgradeBrowserWs } from "./server/browser-bridge";
```

### Fix 2: Add config reload for browser check (addresses issue #2)

In `config-file.ts`, add a targeted function that always re-reads the file for runtime-changeable settings:

```typescript
/** Check browser setting with fresh read (not cached) — used for WS gate */
export function isBrowserEnabledFresh(channel?: string): boolean {
  const raw = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) : {};
  const br = raw.browser;
  if (br === undefined || br === false) return false;
  if (br === true) return true;
  if (Array.isArray(br)) {
    if (!channel) return br.length > 0;
    return br.includes(channel);
  }
  return false;
}
```

Or simpler — add a cache-busting reload function:
```typescript
export function reloadConfigFile(): ConfigFile {
  _cached = null;
  return loadConfigFile();
}
```

### Fix 3: Add upgrade failure logging (addresses issue #5)

In `browser-bridge.ts:upgradeBrowserWs`, change:
```typescript
if (success) return undefined;
return new Response("WebSocket upgrade failed", { status: 400 });
```
To:
```typescript
if (success) return undefined;
console.warn(`[browser-bridge] WebSocket upgrade failed for extId: ${extId}`);
return new Response("WebSocket upgrade failed", { status: 400 });
```

---

## Positive Observations

1. **Excellent architecture** — Offscreen document for persistent WS is the correct MV3 pattern. Service worker for chrome.* APIs. Clean separation.
2. **Keep-alive mechanism** — The 25s port-ping from offscreen → service worker is well-designed to prevent MV3 idle timeout.
3. **Reconnect with backoff** — 3s reconnect delay prevents rapid-fire retries.
4. **Connection replacement** — `handleBrowserWsOpen` correctly replaces existing connections from the same extId.
5. **Clean JSON-RPC protocol** — Request/response with IDs, timeout handling, and pending request tracking.
6. **Robust WebSocket dispatcher** — `websocket.ts` uses discriminated union on `ws.data.type` to route to the right handler.
7. **Security gates** — `isBrowserEnabled()` config gate, extId regex validation, MAX_CONNECTIONS limit.
8. **CDP-based interactions** — Using `chrome.debugger` for element operations is the right approach vs fragile content script DOM manipulation.

---

## Answer to Specific Questions

### Q1: URL matching — could query params cause mismatch?
**No.** `url.pathname` (line 463) strips query parameters. `path === "/browser/ws"` matches exactly. ✅

### Q2: WebSocket upgrade mechanism in Bun
Bun handles WS upgrades in `fetch` via `server.upgrade()`. Returning `undefined` signals success. Both sync and async patterns work (confirmed by Bun docs and the identical workspace proxy pattern). ✅

### Q3: Route ordering — catch-all before /browser/ws?
**No.** `/browser/ws` (line 473) is checked before static files (line 502) and `handleRequest` (line 510). ✅

### Q4: extId validation — does UUID slice pass regex?
**Yes.** `crypto.randomUUID().slice(0, 8)` → `[0-9a-f]{8}` → passes `/^[a-zA-Z0-9_-]{1,64}$/`. Null extId gets a random fallback (no 400). ✅

### Q5: Does offscreen creation require the offscreen permission?
**Yes, and it's present.** `manifest.json:6` has `"offscreen"` in `permissions`, and the `offscreen` section declares `"reasons": ["WORKERS"]`. `ensureOffscreen()` checks `chrome.offscreen.hasDocument()` before creating. ✅

---

## Metrics
- **Type Coverage:** Server-side TypeScript is fully typed. Extension is plain JS (acceptable for MV3 extensions).
- **Test Coverage:** No tests found for the browser bridge flow.
- **Linting Issues:** 3 (dead code in extId fallback, async executor anti-pattern, mixed require/import)

## Unresolved Questions
1. Has the workspace noVNC proxy (same async `import().then()` upgrade pattern) been confirmed working? If not, it may have the same latent issue.
2. Is there a startup log that confirms `browser: true` was loaded from config? Would help users verify config state.
