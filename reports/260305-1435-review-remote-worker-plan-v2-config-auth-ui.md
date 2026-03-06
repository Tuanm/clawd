# Code Review: Remote Worker Plan v2 — Config-Based Auth & UI Changes

**Date**: 2025-03-05  
**Scope**: Plan review (pre-implementation) — config-file.ts, AgentDialog.tsx, agents.ts, plan.md  
**Focus**: Config pattern consistency, auth flow completeness, UI design, database schema, hot reload, edge cases

---

## Overall Assessment

The v2 plan is well-structured and addresses the 14 critical + 21 high findings from Round 1. The config-based auth model is a good simplification vs. a REST token CRUD API. The architecture follows established patterns (browser-bridge, workspace-plugin). However, **3 critical gaps** remain that must be addressed before implementation, plus several high-priority design decisions that need resolution.

---

## Critical Issues

### C1. Hot Reload Is Broken — `loadConfigFile()` Is Cached

**The plan states** (line 1143-1145): _"To revoke: remove token from config.json → hot-reload config → server finds worker with that tokenHash → sends shutdown"_

**The code** (`config-file.ts:79`): `loadConfigFile()` returns a cached `_cached` object after first call. `isTokenAllowed()` in the plan (line 794) calls `loadConfigFile()`, which will **always return the stale cached config**.

The only way to bust the cache is `reloadConfigFile()`, which is only triggered by `POST /api/config/reload` (index.ts:678-681). The plan never mentions this endpoint, nor does it call `reloadConfigFile()` before token validation.

**Impact**: Token revocation **does not work**. Removed tokens are still accepted until server restart or manual API call.

**Fix** — choose one:
```typescript
// Option A: Use reloadConfigFile() in isTokenAllowed (simple but reads disk on every WS upgrade)
function isTokenAllowed(token: string, channel?: string): boolean {
  const config = reloadConfigFile(); // Force re-read
  // ...
}

// Option B: Add file watcher (better, no disk I/O on every upgrade)
import { watch } from "node:fs";
watch(CONFIG_PATH, { persistent: false }, () => {
  reloadConfigFile();
  // Also: iterate connected workers, check if their tokens are still valid
  // If not: send { type: "shutdown", reason: "token_revoked" }
});

// Option C: Document that /api/config/reload must be called after edits
// (Least desirable — admin must remember)
```

**Recommendation**: Option B is the best fit. It's consistent with the plan's claim of "hot-reload" and enables active revocation. The file watcher should live in `remote-worker.ts` and trigger both config reload AND worker eviction.

---

### C2. Race Condition — Worker Connects Before Agent Starts

**The plan** (line 997-998): `RemoteWorkerToolPlugin` subscribes to `workerEvents.on("worker:registered", ...)` in the constructor.

**The gap**: If the worker is already connected and registered **before** the agent is created (or restarted), the plugin misses the `"worker:registered"` event entirely. The agent starts without remote worker tools — permanently, until the worker disconnects and reconnects.

This is a common startup order issue: worker connects first → user then creates agent with matching token → agent never sees the worker.

**Fix**:
```typescript
constructor(mcpManager: MCPManager, channel: string, workerToken?: string) {
  // ... existing code ...
  
  // Check if a worker with matching token is ALREADY connected
  if (this.agentTokenHash) {
    const existingWorker = getWorkerByTokenHash(this.agentTokenHash);
    if (existingWorker && existingWorker.status === "connected") {
      // Synthetically trigger registration for already-connected worker
      this.onWorkerRegistered({
        tokenHash: existingWorker.data.tokenHash,
        name: existingWorker.data.name,
        projectRoot: existingWorker.data.projectRoot || "",
        platform: existingWorker.data.platform || "linux",
        tools: existingWorker.data.tools || [],
        channels: getTokenChannels(workerToken!),
      });
    }
  }
}
```

Need to export `getWorkerByTokenHash()` from `remote-worker.ts`.

---

### C3. Event Listener Leak — No `destroy()` / Unsubscribe

**The plan** (line 997-1003): `RemoteWorkerToolPlugin` subscribes to `workerEvents` in the constructor with anonymous arrow functions. It has **no `destroy()` method** and never calls `removeListener()`.

**Impact**: When agents are stopped and restarted (which happens on model/provider/project changes — see agents.ts:563), old plugin instances keep their event listeners active. Over time, this causes:
- Memory leak (orphaned closures retain `mcpManager` references)
- Duplicate tool registration (old listener fires alongside new one)
- `MaxListenersExceededWarning` from EventEmitter

**Fix**:
```typescript
export class RemoteWorkerToolPlugin implements ToolPlugin {
  private onRegistered: (info: any) => void;
  private onDisconnected: (info: any) => void;

  constructor(mcpManager: MCPManager, channel: string, workerToken?: string) {
    // ... existing setup ...
    
    // Store bound references for cleanup
    this.onRegistered = (info) => this.onWorkerRegistered(info);
    this.onDisconnected = (info) => this.onWorkerDisconnected(info);
    
    workerEvents.on("worker:registered", this.onRegistered);
    workerEvents.on("worker:disconnected", this.onDisconnected);
  }

  async destroy(): Promise<void> {
    workerEvents.off("worker:registered", this.onRegistered);
    workerEvents.off("worker:disconnected", this.onDisconnected);
    // Disconnect any active MCP connection
    if (this.agentTokenHash) {
      const connName = `remote-worker-${/* workerName */}`;
      await this.mcpManager.removeServer(connName).catch(() => {});
    }
  }
}
```

This follows the pattern already established by `WorkspaceToolPlugin.destroy()` (workspace-plugin.ts:363-373).

---

## High Priority

### H1. Raw Token Stored in SQLite — Security Concern

**The plan** (line 1211-1217): `channel_agents.worker_token TEXT DEFAULT ''` stores the raw token in the database.

**Comparison with existing patterns**: The browser bridge stores `authToken` only in-memory on `ws.data` (browser-bridge.ts:34) — it's never persisted to disk beyond config.json. The worker plan persists the raw token in SQLite, which is on disk and may be backed up, copied, or accessed by other processes.

**Risk**: If the SQLite DB is compromised, all worker tokens are exposed. Attacker can connect as any worker.

**Recommendation**: This is an acceptable tradeoff for v1 since:
- The token is also in config.json (same disk)
- The DB file has the same filesystem permissions
- The agent needs the raw token to compute SHA-256 for matching

But add a comment documenting the risk, and consider encrypting at rest in a future version.

### H2. Database Column Should Be NULL, Not Empty String

**Plan** (line 1213): `ALTER TABLE channel_agents ADD COLUMN worker_token TEXT DEFAULT '';`

**Issue**: Empty string `''` is ambiguous — it's indistinguishable from "user explicitly cleared the token." Use `NULL` for "not set":

```sql
ALTER TABLE channel_agents ADD COLUMN worker_token TEXT DEFAULT NULL;
```

In code:
```typescript
worker_token: newWorkerToken || null,  // not undefined, not ''
```

This matches the semantic: "no token configured" vs "has a token."

### H3. `worker: true` Accepts ANY Token — Needs Warning

**Plan** (line 799): `if (workerConfig === true) return true;`

When `"worker": true`, **any string** presented as a token is accepted. This is convenient for dev but dangerous for production — anyone who discovers the WS endpoint can connect.

**Fix**: Log a warning on startup, similar to the `--insecure` flag pattern:
```typescript
if (workerConfig === true) {
  console.warn("[remote-worker] ⚠️  worker=true: accepting ALL tokens on ALL channels (dev mode)");
}
```

### H4. Token Format Validation Missing

Browser bridge has `AUTH_TOKEN_PATTERN = /^[a-zA-Z0-9_\-.:]{1,256}$/;` (browser-bridge.ts:67) to reject malformed tokens before expensive lookups.

The plan's `isTokenAllowed()` and `upgradeRemoteWorkerWs()` do no format validation on the incoming token. A malicious client could send megabytes of garbage in the Authorization header.

**Fix**: Add token format validation in `upgradeRemoteWorkerWs()`:
```typescript
const WORKER_TOKEN_PATTERN = /^[a-zA-Z0-9_\-.:]{1,256}$/;
if (!WORKER_TOKEN_PATTERN.test(token)) {
  return new Response("Invalid token format", { status: 400 });
}
```

### H5. `addConnection()` on MCPManager — Redundant with `addServer()`

The plan proposes adding a new `addConnection(connection: IMCPConnection)` method. Looking at `MCPManager.addServer()` (client.ts:481-496), it:
1. Creates an `IMCPConnection`
2. Wires up event listeners
3. Calls `connect()`
4. Stores in `connections` Map

`addConnection()` does the same but accepts a pre-created connection. This is clean and the right approach — BUT ensure the method name doesn't confuse maintainers about which to use. Consider naming it `addExternalConnection()` to distinguish:

```typescript
/** Add a pre-built connection (for plugins that manage their own transport). */
async addExternalConnection(connection: IMCPConnection): Promise<void> { ... }
```

---

## Medium Priority

### M1. `workersEnabled` Detection Is Underspecified

**Plan** (line 1199-1207) gives two alternatives:
1. New endpoint `GET /api/app.workers.enabled?channel=dev-team`
2. Include `workersEnabled: boolean` in existing `agents.list` response

**Recommendation**: Option 2 (piggyback on agents.list). This avoids a new endpoint and the UI already fetches agents.list on dialog open + 5s interval. Add to the response:
```typescript
return json({
  ok: true,
  agents: enriched,
  workersEnabled: isWorkerEnabled(channel),  // NEW
});
```

### M2. Agent Detail View (Read-Only) Should Show Worker Status

The plan only adds `worker_token` to the **add form** (line 1173-1185). The read-only detail view (AgentDialog.tsx:371-419) doesn't show:
- Whether a worker token is configured (masked)
- Whether the worker is currently connected (green/red dot)

**Recommendation**: Add to the detail view:
```tsx
{selectedAgent.worker_token && (
  <div className="agent-field-row">
    <input type="text" className="agent-field-input" placeholder="Worker"
      value={selectedAgent.worker_token}  // Already masked from API: "wkr_***123"
      readOnly />
    <span className={`worker-status-dot ${selectedAgent.worker_connected ? 'connected' : 'disconnected'}`} />
  </div>
)}
```

The API should return `worker_connected: boolean` by checking the workers Map for a matching tokenHash.

### M3. Masking Format — `wkr_***123` Is Inconsistent with Browser Bridge

Browser bridge uses this algorithm (browser-bridge.ts:158-163):
```typescript
if (token.length <= 5) return "***";
if (token.length <= 8) return `${token.slice(0, 1)}***${token.slice(-1)}`;
if (token.length <= 12) return `${token.slice(0, 2)}***${token.slice(-2)}`;
return `${token.slice(0, 3)}***${token.slice(-3)}`;
```

The plan says `"wkr_***123"` — showing prefix `wkr_` + last 3 chars. This reveals the prefix convention. **Reuse the existing `maskToken()` function** from browser-bridge.ts (extract to a shared util) for consistency.

### M4. `type="password"` — Appropriate but Add Show/Hide Toggle

`type="password"` is correct for masking tokens. But users copying a token from config.json may want to verify they pasted correctly. Consider a show/hide toggle (eye icon) — common UX pattern. Not blocking for v1.

### M5. Config Type Intentionally Differs from `browser` — Document Why

**Plan** (line 1094): `worker?: boolean | Record<string, string[]>`  
**Existing**: `browser?: boolean | string[] | Record<string, string[]>`

The `string[]` variant (channels without auth) is correctly omitted for workers — you always want token auth. But this divergence should be documented:

```typescript
/**
 * Enable remote worker connections.
 *
 * - `true` — accept any worker token on any channel (dev/personal only)
 * - `Record<string, string[]>` — per-channel auth tokens
 *
 * Unlike `browser`, there is no `string[]` (channels-without-tokens) variant
 * because workers execute arbitrary code and MUST be authenticated.
 */
worker?: boolean | Record<string, string[]>;
```

---

## Low Priority

### L1. Plan Uses `this.toolPluginManager.register(rwPlugin)` — Wrong Architecture

**Plan** (line 1042-1044): Registers the remote worker plugin as a `ToolPlugin` via `toolPluginManager.register()`.

But looking at the plan's `RemoteWorkerToolPlugin` implementation, it doesn't implement `getTools()` at registration time (tools are dynamic — registered when worker connects via `mcpManager.addConnection()`). The plugin is really an **MCP bridge**, not a tool plugin.

**Two paths**:
1. Make it a proper ToolPlugin with `getTools()` returning empty initially, then re-registering when worker connects (messy)
2. Make it a lifecycle object that's not registered as a ToolPlugin but just lives alongside the agent and bridges events to MCPManager (cleaner — matches what the code actually does)

**Recommendation**: Path 2. The plan should clarify this — the `implements ToolPlugin` interface is misleading.

### L2. Config Helper Functions Missing

For `browser`, config-file.ts has 6 helper functions: `isBrowserEnabled()`, `isBrowserAuthRequired()`, `getAllBrowserTokens()`, `getBrowserTokensForChannel()`, `getChannelsForToken()`.

The plan should note parallel helpers for workers: `isWorkerEnabled(channel?)`, `isWorkerAuthRequired()`, `getAllWorkerTokens()`, `getWorkerTokensForChannel()`, `getChannelsForWorkerToken()`. These follow the same pattern and should be added to config-file.ts.

---

## Edge Cases Analysis

### Q: Agent has `worker_token` but no worker connected?

**Handled**: `callRemoteWorkerTool()` looks up by tokenHash in the workers Map. If not found, rejects immediately. Agent falls back to local tools (no remote tools registered). ✅

### Q: Config changed from `true` to channel-specific while workers connected?

**Partially handled**: Depends on C1 fix (hot reload). If file watcher is implemented, on config change:
1. Re-validate all connected workers' tokens against new config
2. Workers whose tokens are no longer valid get `{ type: "shutdown", reason: "token_revoked" }`
3. Workers whose tokens now map to different channels get re-emitted `"worker:registered"` events with updated channel lists

**Without C1 fix**: Not handled at all — stale cache means old config persists.

### Q: Same token appears in multiple channels?

**Handled correctly**: `getTokenChannels()` (line 818-833) iterates all channels and returns all matches. The plugin's channel check (line 1019) ensures each agent only sees workers authorized for its channel. ✅

### Q: Two workers connect with the same token?

**Handled by design**: Workers Map is keyed by tokenHash. Second connection replaces the first (plan line 843: "close old, replace"). This is correct — one token = one worker slot. ✅

### Q: Worker token in config but not in channel_agents DB?

**No issue**: Token in config only authorizes WS connections. Agent binding is separate (via DB's `worker_token` column). Unassigned tokens are authorized but unused. ✅

---

## Positive Observations

1. **Config-based auth is the right call** — avoids REST token CRUD API, single source of truth, consistent with browser pattern
2. **SHA-256 hashing for internal keying** — avoids raw token comparison in hot paths
3. **Reconnection grace period (10s) with call queuing** — excellent UX for flaky networks
4. **Channel-scoped token authorization** — proper multi-tenant isolation
5. **Tool name prefixing (`remote:name:tool`)** — prevents collision with built-in tools
6. **Both TS and Python workers** — good coverage for restricted environments
7. **Worker sends tool schemas in registration** — source of truth stays with the worker, not hardcoded on server

---

## Recommended Actions (Priority Order)

1. **[CRITICAL] Fix hot reload** — implement file watcher on config.json (C1)
2. **[CRITICAL] Handle already-connected workers** — initial check in plugin constructor (C2)
3. **[CRITICAL] Implement `destroy()`** — unsubscribe from workerEvents (C3)
4. **[HIGH] Use NULL not empty string** for worker_token column (H2)
5. **[HIGH] Add token format validation** in upgrade handler (H4)
6. **[HIGH] Log warning for `worker: true`** mode (H3)
7. **[MEDIUM] Add `workersEnabled` to agents.list response** (M1)
8. **[MEDIUM] Show worker status in detail view** (M2)
9. **[MEDIUM] Reuse shared `maskToken()` utility** (M3)
10. **[MEDIUM] Document why `string[]` variant omitted** (M5)

---

## Verdict

**NEEDS CHANGES** — 3 critical issues (C1 hot reload, C2 race condition, C3 listener leak) must be addressed in the plan before implementation. All three have clear fixes provided above. The rest are high/medium recommendations that can be addressed during implementation.

Once C1-C3 are incorporated into the plan: **READY TO IMPLEMENT**.
