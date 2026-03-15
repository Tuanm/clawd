# Code Review: API Authentication Implementation

**Date:** 2026-03-15
**Scope:** Auth config, middleware, worker-loop headers, UI auth wrapper, backward compatibility, security
**Files reviewed:** `src/config-file.ts`, `src/index.ts`, `src/worker-loop.ts`, `src/worker-manager.ts`, `packages/ui/src/App.tsx`, `packages/ui/src/McpDialog.tsx`, `packages/ui/src/AgentDialog.tsx`, `packages/ui/src/ProjectsDialog.tsx`, `packages/ui/src/ArticlePage.tsx`, `packages/ui/src/PlanModal.tsx`, `packages/ui/src/SearchModal.tsx`, `packages/ui/src/MessageList.tsx`, `packages/ui/src/ArticleModal.tsx`

## Overall Assessment

The auth implementation covers the core happy path well -- config, middleware, worker self-calls, and the primary App.tsx wrapper. However, **the majority of UI component files use raw `fetch()` instead of `authFetch`**, which means auth is completely bypassed for those API calls when auth is enabled. This is the dominant finding.

---

## Critical Issues

### 1. [CRITICAL] 16+ raw `fetch()` calls bypass authentication in UI components

`authFetch` is defined as a **private function in `App.tsx`** -- it is NOT exported, NOT importable. Every other component uses raw `fetch()`:

| File | Raw `fetch()` calls to `/api/*` |
|---|---|
| `McpDialog.tsx` | 3 calls (`app.mcp.list`, `app.mcp.add`, `app.mcp.toggle`) |
| `AgentDialog.tsx` | 7 calls (`app.providers.list`, `app.agents.list`, `app.agents.add`, `app.agents.update`, `app.agents.remove`, `app.agents.identity`, `app.folders.list`) |
| `ProjectsDialog.tsx` | 4 calls (`app.agents.list`, and 3 more) |
| `ArticlePage.tsx` | 1 call (`articles.get`) |
| `PlanModal.tsx` | 4 calls (`plans.list`, `plans.get`, `plans.getTasks`, `tasks.get`) |
| `SearchModal.tsx` | 1 call (`conversations.search`) |
| `MessageList.tsx` | 1 call (`articles.create`) |
| `ArticleModal.tsx` | 1 call (`articles.get`) |

**Impact:** When `auth.token` is configured, all these calls will receive 401 responses and silently fail. Users won't see agents, MCP servers, plans, search results, or articles.

**Fix:** Extract `authFetch` (and `getStoredAuthToken`) into a shared utility module (e.g., `src/auth.ts`) and import it in all components. Or use a React context/provider pattern.

### 2. [CRITICAL] `WorkerManager.loadAgentsFromDb()` has no auth headers

```typescript
// worker-manager.ts:497
const res = await timedFetch(`${this.config.chatApiUrl}/api/app.agents.list?internal=1`);
```

This call goes through the `/api/` middleware which checks auth, but no `Authorization` header is sent. The `?internal=1` query param has **no server-side bypass logic** -- the auth middleware does not check for it. When auth is enabled, `WorkerManager.start()` will fail to load any agents from DB.

**Impact:** With auth enabled, no agents will start on boot. The system appears dead.

**Fix:** `WorkerManager` already calls `getAuthToken()` (line 167 passes it to WorkerLoopConfig). Add auth headers to the `loadAgentsFromDb` fetch:
```typescript
const authToken = getAuthToken();
const headers: Record<string, string> = {};
if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
const res = await timedFetch(`${this.config.chatApiUrl}/api/app.agents.list?internal=1`, { headers });
```

---

## High Priority

### 3. [HIGH] Token comparison is not timing-safe

```typescript
// index.ts:682
if (bearer !== authToken) {
```

And for WebSocket:
```typescript
// index.ts:592
if (wsToken !== authToken) {
```

Both use JavaScript `!==` string comparison, which is vulnerable to timing side-channel attacks. An attacker can infer the token character-by-character by measuring response times.

**Fix:** Use `crypto.timingSafeEqual` (available in Node.js and Bun):
```typescript
import { timingSafeEqual } from "crypto";
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
```

### 4. [HIGH] WS auth token in URL query parameter

```typescript
// App.tsx:1217
const wsToken = token ? `&token=${encodeURIComponent(token)}` : "";
const wsUrl = `...?user=UHUMAN${wsToken}`;
```

The auth token is passed as a URL query parameter for WebSocket connections. This means:
- Token appears in server access logs
- Token appears in browser history
- Token may be cached by proxies
- Token is visible in `Referer` headers if any resources are loaded

**Mitigation options:**
- Use a short-lived WS ticket: client calls `POST /api/auth.wsTicket` to get a single-use nonce, passes that as `?ticket=...`
- Or use the first WS message as an auth handshake instead of query params

### 5. [HIGH] Only one `fetch()` call checks for 401 response

```typescript
// App.tsx:928
if (res.status === 401) {
  setAuthRequired(true);
  return;
}
```

Only `fetchMessages` checks for 401. All other `authFetch` calls in App.tsx (12+ calls) do not check for 401. If the token expires or is revoked, the user won't see a login prompt -- they'll just see broken UI with empty data.

**Fix:** Wrap `authFetch` to globally intercept 401 responses:
```typescript
async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await rawFetch(input, init);
  if (res.status === 401) {
    setAuthRequired(true); // needs to be surfaced via state/event
  }
  return res;
}
```

---

## Medium Priority

### 6. [MEDIUM] localStorage token storage is vulnerable to XSS

The auth token is stored in `localStorage` which is accessible to any JavaScript running on the page. If an XSS vulnerability exists (e.g., through markdown rendering, artifact sandboxes), the token can be exfiltrated.

**Current mitigations observed:** The codebase has sanitization (`sanitize-schema.ts`), sandboxed iframes for artifacts. These reduce risk but don't eliminate it.

**Alternatives:** `httpOnly` cookies (server-set) would be immune to XSS token theft. However, this requires server changes and CSRF protection.

### 7. [MEDIUM] `auth.test` endpoint always returns success

```typescript
// index.ts:929-931
if (path === "/api/auth.test") {
  return json({ ok: true, user_id: "UBOT", team_id: "T001", user: "Claw'd App" });
}
```

This is inside `handleRequest()` which is called AFTER the auth middleware check, so it does validate the token. This is correct. However, the response is hardcoded and provides no useful signal about which token/user is authenticated.

### 8. [MEDIUM] No logout mechanism

The comment on line 75 says "call localStorage.removeItem to logout" but no UI button or function implements this. Users with a wrong token must manually clear localStorage.

### 9. [MEDIUM] Config caching means token changes require restart

`loadConfigFile()` caches the config permanently (line 126-145). `reloadConfigFile()` exists but is only called on specific admin endpoints. If the auth token is rotated in `~/.clawd/config.json`, the server will continue using the old token until restart.

---

## Low Priority

### 10. [LOW] LoginPrompt has no rate limiting

The login form submits tokens with no delay or lockout. An attacker could brute-force tokens client-side (though the server's timing-unsafe comparison makes this even easier -- see issue #3).

### 11. [LOW] No token format validation

`getAuthToken()` accepts any non-empty string. No minimum length, no format requirements. A single-character token would be accepted.

---

## Backward Compatibility Assessment

**GOOD:** Backward compatibility is well-handled:
- `getAuthToken()` returns `null` when no `auth` config exists
- Middleware checks `if (authToken)` before enforcing -- no auth = open access
- `authHeaders()` in WorkerLoop returns empty object when no token
- `authFetch` in UI passes through to plain `fetch` when no token stored
- WS upgrade skips token check when auth is disabled

No breaking changes for users who don't configure auth.

---

## Positive Observations

1. Clean separation: config (`getAuthToken`) -> middleware (index.ts) -> worker headers (`authHeaders()`) -> UI wrapper (`authFetch`)
2. WorkerLoopConfig properly receives authToken from WorkerManager
3. All 7 `timedFetch` calls in `worker-loop.ts` include `this.authHeaders()` -- thorough coverage
4. CORS headers correctly include `Authorization` in `Access-Control-Allow-Headers`
5. Auth is opt-in, preserving zero-config experience

---

## Recommended Actions (Priority Order)

1. **[P0] Extract `authFetch` to shared module** and replace all 22+ raw `fetch()` calls in UI components
2. **[P0] Add auth headers to `WorkerManager.loadAgentsFromDb()`** -- system won't boot with auth enabled
3. **[P1] Use `crypto.timingSafeEqual`** for token comparison in middleware and WS upgrade
4. **[P1] Add global 401 interception** in `authFetch` wrapper
5. **[P2] Replace WS query-param token** with ticket-based or first-message auth
6. **[P2] Add logout button** to UI
7. **[P3] Consider `httpOnly` cookies** as alternative to localStorage
8. **[P3] Add minimum token length validation** (e.g., 16+ chars)

---

## Metrics

- **Auth-covered API calls (server):** 100% of `/api/*` routes (middleware is path-based)
- **Auth-covered fetch calls (UI - App.tsx):** ~15/15 use `authFetch`
- **Auth-covered fetch calls (UI - other components):** **0/22** -- all use raw `fetch()`
- **Auth-covered internal calls (server-to-self):** 7/8 -- `loadAgentsFromDb` missing
- **401 detection in UI:** 1 location out of ~25 fetch calls

## Unresolved Questions

1. Is there a plan to support multiple auth tokens (e.g., per-user)?
2. Should `/mcp` and `/health` endpoints eventually require auth?
3. Is the `?internal=1` query param on `loadAgentsFromDb` intended to eventually bypass auth for server-to-self calls?
