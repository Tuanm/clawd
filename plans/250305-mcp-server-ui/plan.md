---
title: "MCP Server Management UI + OAuth Support"
description: "Add MCP server CRUD dialog, backend API routes, and OAuth flow for HTTP MCP servers"
status: pending
priority: P1
effort: 12h
branch: main
tags: [mcp, ui, oauth, api]
created: 2026-03-05
---

# MCP Server Management UI + OAuth Support

## Overview

Add a UI dialog to manage MCP servers per channel (add/remove/connect/disconnect), backend API routes for CRUD operations, and OAuth support for HTTP-based MCP servers. Mirrors the existing `AgentDialog` pattern.

---

## Architecture Summary

```
┌──────────────────┐   HTTP API    ┌───────────────────────┐
│  McpDialog.tsx    │ ────────────→ │ src/api/mcp-servers.ts│
│  (React portal)  │              │  registerMcpRoutes()   │
└──────────────────┘              └──────────┬────────────┘
                                             │
                              ┌──────────────┼──────────────┐
                              ▼              ▼              ▼
                     WorkerManager    Config R/W    MCPManager
                     .addChannel      ~/.clawd/     .addServer()
                     McpServer()      config.json   .removeServer()
                                                            │
                              ┌──────────────────────────────┘
                              ▼
                    OAuth callback route
                    /api/mcp/oauth/callback
                    → token exchange → store
                      ~/.clawd/mcp-oauth-tokens.json
```

---

## Phase 1: Backend — Config Persistence + Types (2h)

### 1.1 Update `MCPServerConfig` type in `src/agent/src/api/providers.ts`

**File:** `src/agent/src/api/providers.ts` (MODIFY)

Add `enabled` and `oauth` fields to the existing `MCPServerConfig`:

```ts
// line ~158, existing interface
export interface MCPServerConfig {
  command?: string;        // was required, make optional (http servers have no command)
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: "stdio" | "http";
  enabled?: boolean;       // NEW — defaults to true if omitted
  oauth?: {                // NEW — for HTTP servers requiring OAuth
    client_id: string;
    scopes?: string[];
  };
}
```

> **Note:** `command` must become optional since HTTP servers only need `url`.

### 1.2 Add config save helpers in `src/agent/src/api/provider-config.ts`

**File:** `src/agent/src/api/provider-config.ts` (MODIFY)

Add functions to write mcp_servers section back to `~/.clawd/config.json`:

```ts
import { writeFileSync, mkdirSync } from "node:fs";

/** Save full config back to disk (merges mcp_servers into existing config) */
export function saveChannelMCPServer(channel: string, name: string, config: MCPServerConfig): void {
  // Read raw JSON, merge mcp_servers[channel][name], write back
}

export function removeChannelMCPServer(channel: string, name: string): void {
  // Read raw JSON, delete mcp_servers[channel][name], write back
}

export function updateChannelMCPServerEnabled(channel: string, name: string, enabled: boolean): void {
  // Read raw JSON, set mcp_servers[channel][name].enabled, write back
}
```

Implementation notes:
- Read raw JSON (not cached config) to avoid overwriting unrelated fields
- Use `JSON.parse(readFileSync(...))`, mutate, `writeFileSync` with 2-space indent
- Call `clearConfigCache()` after write to invalidate the read cache
- Create `~/.clawd/` dir if missing

### 1.3 Add `getServerStatuses()` to MCPManager

**File:** `src/agent/src/mcp/client.ts` (MODIFY)

Add method to expose connection status for the list API:

```ts
// In MCPManager class
getServerStatuses(): Array<{ name: string; connected: boolean; tools: number }> {
  return Array.from(this.connections.entries()).map(([name, conn]) => ({
    name,
    connected: conn.connected,
    tools: conn.tools.length,
  }));
}
```

---

## Phase 2: Backend — WorkerManager Integration (1.5h)

### 2.1 Add MCP server management methods to WorkerManager

**File:** `src/worker-manager.ts` (MODIFY)

Add three new public methods + expose channel MCP for status queries:

```ts
/** Get the MCPManager for a channel (for status inspection) */
getChannelMcpManager(channel: string): MCPManager | undefined {
  return this.channelMcp.get(channel);
}

/** Add an MCP server to a running channel (or create MCPManager if needed) */
async addChannelMcpServer(channel: string, name: string, config: MCPServerConfig): Promise<void> {
  let mcp = this.channelMcp.get(channel);
  if (!mcp) {
    mcp = new MCPManager();
    this.channelMcp.set(channel, mcp);
  }
  await mcp.addServer({ name, ...config });
  // Update existing worker loops in this channel to use the MCPManager
  this.updateChannelLoopsMcp(channel, mcp);
}

/** Remove an MCP server from a channel */
async removeChannelMcpServer(channel: string, name: string): Promise<void> {
  const mcp = this.channelMcp.get(channel);
  if (!mcp) return;
  await mcp.removeServer(name);
  // If no servers left, keep MCPManager alive (user may add more)
}

/** Toggle an MCP server (connect/disconnect) */
async toggleChannelMcpServer(channel: string, name: string, enabled: boolean): Promise<void> {
  // If enabling: addServer; if disabling: removeServer from MCPManager
  // Config persistence is handled by the API layer
}

/** Push MCPManager ref to all running loops in a channel */
private updateChannelLoopsMcp(channel: string, mcp: MCPManager): void {
  for (const [key, loop] of this.loops) {
    if (key.startsWith(`${channel}:`)) {
      loop.setChannelMcpManager(mcp);
    }
  }
}
```

### 2.2 Add `setChannelMcpManager()` to WorkerLoop

**File:** `src/worker-loop.ts` (MODIFY)

Check if WorkerLoop has a setter for `channelMcpManager`. If not, add:

```ts
setChannelMcpManager(mcp: MCPManager): void {
  this.channelMcpManager = mcp;
}
```

This allows live-updating the MCPManager reference on running agents when servers are added/removed.

---

## Phase 3: Backend — API Routes (2h)

### 3.1 Create `src/api/mcp-servers.ts`

**File:** `src/api/mcp-servers.ts` (CREATE, ~200 lines)

Pattern: follows `registerAgentRoutes` exactly.

```ts
export function registerMcpServerRoutes(
  workerManager: WorkerManager
): (req: Request, url: URL, path: string) => Response | null {
  return (req, url, path) => {
    // GET /api/app.mcp.list?channel=X
    // POST /api/app.mcp.add   { channel, name, type, command?, args?, env?, url?, oauth? }
    // POST /api/app.mcp.remove { channel, name }
    // POST /api/app.mcp.toggle { channel, name, enabled }
    return null;
  };
}
```

#### Route details:

**`GET /api/app.mcp.list?channel=X`**
1. Load config servers: `getChannelMCPServers(channel)` → gives configured servers
2. Get runtime status: `workerManager.getChannelMcpManager(channel)?.getServerStatuses()`
3. Merge: for each config entry, attach `connected` + `tools` from runtime (default `false`/`0` if no runtime)
4. Return: `{ ok: true, servers: [{ name, type, command?, url?, connected, tools, enabled }] }`

**`POST /api/app.mcp.add`**
1. Parse body: `{ channel, name, type, command?, args?, env?, url?, oauth? }`
2. Validate: name required, type must be "stdio"|"http", stdio needs command, http needs url
3. Build `MCPServerConfig` from body
4. Try connecting via `workerManager.addChannelMcpServer(channel, name, config)`
5. On success: save to config via `saveChannelMCPServer(channel, name, config)`
6. Return: `{ ok: true }` or `{ ok: false, error: "..." }`

**`POST /api/app.mcp.remove`**
1. Parse body: `{ channel, name }`
2. `workerManager.removeChannelMcpServer(channel, name)`
3. `removeChannelMCPServer(channel, name)` — config persistence
4. Return: `{ ok: true }`

**`POST /api/app.mcp.toggle`**
1. Parse body: `{ channel, name, enabled }`
2. `workerManager.toggleChannelMcpServer(channel, name, enabled)`
3. `updateChannelMCPServerEnabled(channel, name, enabled)`
4. Return: `{ ok: true }`

### 3.2 Register routes in `src/index.ts`

**File:** `src/index.ts` (MODIFY)

```ts
// ~line 86: add import
import { registerMcpServerRoutes } from "./api/mcp-servers";

// ~line 285: register handler
const handleMcpServerRoute = registerMcpServerRoutes(workerManager);

// ~line 609 (inside handleRequest, after articleResponse check):
const mcpServerResponse = handleMcpServerRoute(req, url, path);
if (mcpServerResponse) return mcpServerResponse;
```

---

## Phase 4: Frontend — McpDialog Component (3h)

### 4.1 Create `packages/ui/src/McpDialog.tsx`

**File:** `packages/ui/src/McpDialog.tsx` (CREATE, ~300 lines)

Structure mirrors `AgentDialog.tsx`:

```tsx
interface McpServer {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  connected: boolean;
  enabled: boolean;
  tools: number;
  oauth?: { client_id: string; scopes?: string[] };
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function McpDialog({ channel, isOpen, onClose }: Props) {
  // State: servers list, selectedServer, showAddForm, addForm fields, error
  // Effects: load servers on open (poll every 5s), reset on close
  // Handlers: handleAdd, handleRemove, handleToggle
  // Render: portal → overlay → dialog with same class structure
}
```

#### Layout (reuses stream-dialog + agent-dialog CSS classes):

```
┌─────────────────────────────────┐
│ MCP Servers                   × │  ← stream-dialog-header
├─────────────────────────────────┤
│ [🔌 notion] [🔌 slack] [+ Add] │  ← stream-agent-bar (reused)
├─────────────────────────────────┤
│                                 │
│  Name:    notion       (readonly)│  ← agent-fields (reused)
│  Type:    stdio        (readonly)│
│  Command: bunx         (readonly)│
│  Status:  ● Connected (3 tools) │
│                                 │
│  [Disconnect]  [Remove]         │  ← agent-buttons (reused)
│                                 │
└─────────────────────────────────┘
```

#### Add Form — conditional fields:

```
Type: [stdio ▼]  →  shows Command, Arguments, Env Vars
Type: [http  ▼]  →  shows URL, OAuth Client ID (optional), OAuth Scopes (optional)
```

Fields:
- **Name**: text input (always)
- **Type**: `<select>` with "stdio" | "http" (always)
- **Command**: text input (stdio only)
- **Arguments**: text input, comma-separated → split to array (stdio only)
- **Environment Variables**: textarea, one `KEY=VALUE` per line → parse to Record (stdio only)
- **URL**: text input (http only)
- **OAuth Client ID**: text input (http only, optional)
- **OAuth Scopes**: text input, comma-separated (http only, optional, shown if client_id filled)

#### Server icon in avatar bar:

```tsx
// Reuse stream-agent-avatar-btn structure
// Icon: plug SVG for each server
// Color: green dot if connected, gray if not
// Label: server name
```

### 4.2 McpDialog — API integration

```ts
const API_URL = "";

// Load servers
const loadServers = async () => {
  const res = await fetch(`${API_URL}/api/app.mcp.list?channel=${encodeURIComponent(channel)}`);
  const data = await res.json();
  if (data.ok) setServers(data.servers);
};

// Add server
const handleAdd = async () => {
  const body = { channel, name, type, command, args: argsStr.split(",").map(s=>s.trim()).filter(Boolean), env: parseEnv(envStr), url, oauth: clientId ? { client_id: clientId, scopes: scopesStr.split(",").map(s=>s.trim()).filter(Boolean) } : undefined };
  const res = await fetch(`${API_URL}/api/app.mcp.add`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // handle response...
};

// Remove / Toggle follow same pattern
```

---

## Phase 5: Frontend — Integration in App.tsx + MessageComposer (1h)

### 5.1 Add MCP icon button to MessageComposer

**File:** `packages/ui/src/MessageComposer.tsx` (MODIFY)

Add `mcpButton` prop (same pattern as `searchButton`, `projectsButton`):

```tsx
// In Props interface (~line 133):
mcpButton?: React.ReactNode;

// In component params (~line 144):
mcpButton,

// In composer-toolbar section (~line 460, after projectsButton):
{mcpButton && (
  <>
    <div className="toolbar-divider" />
    {mcpButton}
  </>
)}

// In non-toolbar section (~line 607, after projectsButton):
{!showToolbar && mcpButton && mcpButton}
```

### 5.2 Wire McpDialog in App.tsx

**File:** `packages/ui/src/App.tsx` (MODIFY)

```tsx
// Import (~line 2-7):
import McpDialog from "./McpDialog";

// State (~line 466):
const [showMcpDialog, setShowMcpDialog] = useState(false);

// In MessageComposer props (~line 1942, after projectsButton):
mcpButton={
  <button className="mcp-btn" onClick={() => setShowMcpDialog(true)} title="MCP Servers">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  </button>
}

// Render dialog (~line 1974, after ProjectsDialog):
<McpDialog channel={activeChannel} isOpen={showMcpDialog} onClose={() => setShowMcpDialog(false)} />
```

The SVG is a "connection/network" icon (8 lines radiating from center circle — reminiscent of MCP/plug).

---

## Phase 6: Frontend — CSS Styles (0.5h)

### 6.1 Add MCP dialog styles

**File:** `packages/ui/src/styles.css` (MODIFY)

Mostly reuses existing `agent-dialog` styles. Only additions needed:

```css
/* MCP Dialog — extends agent-dialog */
.mcp-dialog {
  max-width: 480px;  /* same as agent-dialog */
}

/* MCP server status indicator */
.mcp-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  margin: 4px 0;
}

.mcp-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.mcp-status-dot.connected { background: #4caf50; }
.mcp-status-dot.disconnected { background: #888; }

/* MCP button in composer */
.mcp-btn {
  /* inherits search-btn / projects-btn styling via .action-btn or direct */
}

/* Type dropdown in add form */
.mcp-type-select {
  width: 100%;
  padding: 8px 12px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 14px;
}

/* Env vars textarea */
.mcp-env-textarea {
  width: 100%;
  min-height: 60px;
  padding: 8px 12px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 13px;
  font-family: monospace;
  resize: vertical;
}
```

---

## Phase 7: OAuth Support (2h)

### 7.1 Create `src/mcp-oauth.ts`

**File:** `src/mcp-oauth.ts` (CREATE, ~150 lines)

Handles the full OAuth 2.0 authorization code flow:

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TOKEN_PATH = join(homedir(), ".clawd", "mcp-oauth-tokens.json");

interface OAuthTokenEntry {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;  // Unix timestamp
  token_type: string;
  scope?: string;
}

// Token storage: keyed by "channel:server_name"
type TokenStore = Record<string, OAuthTokenEntry>;

/** Read all stored tokens */
export function loadOAuthTokens(): TokenStore { ... }

/** Save tokens to disk */
export function saveOAuthTokens(store: TokenStore): void { ... }

/** Get token for a specific channel+server */
export function getOAuthToken(channel: string, serverName: string): string | null {
  const store = loadOAuthTokens();
  const key = `${channel}:${serverName}`;
  const entry = store[key];
  if (!entry) return null;
  // Check expiry — if expired and refresh_token exists, try refresh
  if (entry.expires_at && Date.now() / 1000 > entry.expires_at - 60) {
    // Return null to trigger re-auth (refresh handled below)
    return null;
  }
  return entry.access_token;
}

/** Remove token for a channel+server */
export function removeOAuthToken(channel: string, serverName: string): void { ... }

/**
 * Generate the authorization URL for a given MCP server's OAuth config.
 * State param encodes channel + server name for the callback.
 */
export function generateAuthUrl(params: {
  channel: string;
  serverName: string;
  authorizationEndpoint: string;
  clientId: string;
  scopes?: string[];
  callbackUrl: string;
}): string {
  const state = Buffer.from(JSON.stringify({
    channel: params.channel,
    server: params.serverName,
  })).toString("base64url");

  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (params.scopes?.length) {
    url.searchParams.set("scope", params.scopes.join(" "));
  }
  return url.toString();
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCodeForToken(params: {
  tokenEndpoint: string;
  code: string;
  clientId: string;
  redirectUri: string;
}): Promise<OAuthTokenEntry> { ... }
```

### 7.2 Add OAuth callback route in `src/index.ts`

**File:** `src/index.ts` (MODIFY)

Add inside `handleRequest()`, before the agent routes:

```ts
// OAuth callback for MCP servers
if (path === "/api/mcp/oauth/callback") {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // Decode state → { channel, server }
  // Look up server config → get token_endpoint from oauth config
  // Exchange code for token
  // Store token
  // Redirect to app with success message or return HTML success page
}
```

### 7.3 Wire OAuth tokens into MCPHttpConnection

When adding an HTTP MCP server with OAuth:
1. Check if token exists via `getOAuthToken(channel, name)`
2. If yes: pass `token` to `MCPServerConfig` → `MCPHttpConnection` uses it as Bearer
3. If no: return `{ ok: false, error: "oauth_required", auth_url: "..." }` → UI opens auth URL

**File:** `src/api/mcp-servers.ts` (within `app.mcp.add` handler)

```ts
if (type === "http" && body.oauth?.client_id) {
  const existingToken = getOAuthToken(channel, name);
  if (!existingToken) {
    const authUrl = generateAuthUrl({
      channel, serverName: name,
      authorizationEndpoint: /* from server's well-known or config */,
      clientId: body.oauth.client_id,
      scopes: body.oauth.scopes,
      callbackUrl: `http://localhost:${port}/api/mcp/oauth/callback`,
    });
    return json({ ok: false, error: "oauth_required", auth_url: authUrl });
  }
  // Use existing token
  serverConfig.token = existingToken;
}
```

### 7.4 UI handling for OAuth redirect

In `McpDialog.tsx`, when add response returns `oauth_required`:

```ts
if (data.error === "oauth_required" && data.auth_url) {
  window.open(data.auth_url, "_blank");
  setError("OAuth authorization required. Complete in the opened browser tab, then try again.");
  return;
}
```

---

## Task Checklist

### Phase 1 — Config + Types
- [ ] 1.1 Make `command` optional in `MCPServerConfig` (providers.ts), add `enabled`, `oauth` fields
- [ ] 1.2 Add `saveChannelMCPServer()`, `removeChannelMCPServer()`, `updateChannelMCPServerEnabled()` to provider-config.ts
- [ ] 1.3 Add `getServerStatuses()` method to `MCPManager` (client.ts)

### Phase 2 — WorkerManager
- [ ] 2.1 Add `getChannelMcpManager()`, `addChannelMcpServer()`, `removeChannelMcpServer()`, `toggleChannelMcpServer()` to WorkerManager
- [ ] 2.2 Add `setChannelMcpManager()` to WorkerLoop (if missing)
- [ ] 2.3 Add private `updateChannelLoopsMcp()` helper to WorkerManager

### Phase 3 — API Routes
- [ ] 3.1 Create `src/api/mcp-servers.ts` with `registerMcpServerRoutes()`
- [ ] 3.2 Implement `GET /api/app.mcp.list`
- [ ] 3.3 Implement `POST /api/app.mcp.add` (with connect-then-save semantics)
- [ ] 3.4 Implement `POST /api/app.mcp.remove`
- [ ] 3.5 Implement `POST /api/app.mcp.toggle`
- [ ] 3.6 Register routes in `src/index.ts`

### Phase 4 — McpDialog UI
- [ ] 4.1 Create `packages/ui/src/McpDialog.tsx`
- [ ] 4.2 Server list bar (avatar-bar style, plug icons)
- [ ] 4.3 Server detail view (readonly fields + status + actions)
- [ ] 4.4 Add form with type-conditional fields (stdio vs http)
- [ ] 4.5 API integration (fetch list, add, remove, toggle)

### Phase 5 — Integration
- [ ] 5.1 Add `mcpButton` prop to `MessageComposer.tsx`
- [ ] 5.2 Import `McpDialog`, add state + render in `App.tsx`
- [ ] 5.3 Pass MCP button to MessageComposer in `App.tsx`

### Phase 6 — CSS
- [ ] 6.1 Add MCP-specific styles to `styles.css` (status dots, type select, env textarea)

### Phase 7 — OAuth
- [ ] 7.1 Create `src/mcp-oauth.ts` (token storage, auth URL generation, code exchange)
- [ ] 7.2 Add `/api/mcp/oauth/callback` route in `src/index.ts`
- [ ] 7.3 Wire OAuth token lookup into `app.mcp.add` handler
- [ ] 7.4 Handle `oauth_required` response in McpDialog UI

---

## Dependency Graph

```
Phase 1 (Types + Config)
  ├──→ Phase 2 (WorkerManager) ──→ Phase 3 (API Routes)
  │                                      │
  │                                      ▼
  │                               Phase 5 (Integration)
  │                                      │
  └──→ Phase 4 (McpDialog UI) ──────────┘
                                         │
       Phase 6 (CSS) ───────────────────┘
                                         │
       Phase 7 (OAuth) ← depends on Phase 3 complete
```

Phases 1→2→3 are strictly sequential (backend). Phase 4 + 6 can start after Phase 1 (they only need types). Phase 5 merges frontend + backend. Phase 7 can be done last as an additive layer.

---

## Files Summary

| Action | File | Est. Lines Changed |
|--------|------|--------------------|
| MODIFY | `src/agent/src/api/providers.ts` | +10 |
| MODIFY | `src/agent/src/api/provider-config.ts` | +60 |
| MODIFY | `src/agent/src/mcp/client.ts` | +10 |
| MODIFY | `src/worker-manager.ts` | +60 |
| MODIFY | `src/worker-loop.ts` | +5 |
| CREATE | `src/api/mcp-servers.ts` | ~200 |
| MODIFY | `src/index.ts` | +15 |
| CREATE | `packages/ui/src/McpDialog.tsx` | ~300 |
| MODIFY | `packages/ui/src/MessageComposer.tsx` | +15 |
| MODIFY | `packages/ui/src/App.tsx` | +25 |
| MODIFY | `packages/ui/src/styles.css` | +50 |
| CREATE | `src/mcp-oauth.ts` | ~150 |

**Total new code:** ~900 lines

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| MCP server connection hangs on add | User waits forever | 30s timeout already in MCPStdioConnection/MCPHttpConnection; surface error to UI |
| Config file corruption on concurrent writes | Lost config | Read-modify-write is fast + single-threaded Bun; acceptable for local dev tool |
| WorkerLoop may not have MCP setter | Can't hot-swap MCPManager | Check `worker-loop.ts`; add `setChannelMcpManager()` if missing |
| OAuth token_endpoint unknown | Can't complete flow | For v1: require user to provide `authorization_endpoint` and `token_endpoint` in oauth config, or discover via `.well-known` |
| MCPManager tracks `connections` as private | Can't inspect status externally | Add `getServerStatuses()` public method |

---

## Unresolved Questions

1. **OAuth discovery**: Should we support `.well-known/oauth-authorization-server` auto-discovery, or require explicit `authorization_endpoint` + `token_endpoint` in the server's OAuth config? Recommendation: start with explicit endpoints, add discovery later.

2. **MCPManager lifecycle when no agents**: If a channel has MCP servers configured but no agents running, should we create the MCPManager eagerly (so UI shows "connected") or defer? Recommendation: create eagerly on `app.mcp.add` — the API already connects before saving.

3. **Token refresh**: Should we implement automatic token refresh in the background, or just re-prompt the user? Recommendation: start with re-prompt (simpler), add background refresh as follow-up.
