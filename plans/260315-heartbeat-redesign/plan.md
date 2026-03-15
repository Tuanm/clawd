---
title: "Heartbeat Mechanism Redesign — Per-Agent LLM-Direct Heartbeat"
description: "Replace chat-nudge heartbeat with per-agent configurable LLM-direct [HEARTBEAT] messages for idle agents"
status: pending
priority: P1
effort: 8h
branch: main
tags: [heartbeat, refactor, agents, worker-loop, ui]
created: 2026-03-15
---

# Heartbeat Mechanism Redesign

## Summary

Replace the current nudge-based heartbeat (posts chat messages via `chat.postMessage`) with a per-agent configurable interval that sends `[HEARTBEAT]` directly to the LLM API as a system/assistant message. Only idle agents receive heartbeats. The UI Agents dialog gains a heartbeat interval field and editable Provider/Model/Project fields.

## Current State

- **Global heartbeat config** in `config.json` (`heartbeat.enabled`, `heartbeat.intervalMs`, etc.) drives a single monitor timer in `WorkerManager`.
- `runHeartbeatCheck()` iterates all loops, calls `loop.postNudge()` which calls `sendNudgeMessage()` — this posts a real chat message as "System" agent via `chat.postMessage` API / direct DB insert.
- Nudge messages appear in chat history, polluting conversations.
- No per-agent heartbeat interval; the interval is global.
- Agent details in UI are read-only for Provider/Model/Project.

## Target State

1. **Per-agent `heartbeat_interval`** (seconds) stored in `channel_agents` DB table. 0/null/negative = disabled.
2. **LLM-direct heartbeat**: Instead of posting to chat, inject a `[HEARTBEAT]` message into the LLM conversation (system or user role) that only the LLM sees.
3. **Idle-only**: Only fire heartbeat for agents not currently streaming/processing.
4. **UI editable fields**: Provider, Model, Project become editable inline; new heartbeat interval input added.
5. **System prompt update**: Explain `[HEARTBEAT]` semantics to agent.
6. **Remove old nudge logic**: `postNudge`, `sendNudgeMessage`, `nudgeCount` tracking, global heartbeat config.

---

## Files Requiring Changes

### 1. `src/server/database.ts` (schema migration)

**What changes:**
- Add migration for `heartbeat_interval` column on `channel_agents` table:
  ```sql
  ALTER TABLE channel_agents ADD COLUMN heartbeat_interval INTEGER DEFAULT 0
  ```
- Column stores interval in **seconds**. Default 0 = disabled.

**Lines of interest:** ~162-170 (agent_seen table), but the real target is `channel_agents` which is defined in `src/api/agents.ts:initAgentsTable()`.

---

### 2. `src/api/agents.ts` (agent CRUD + DB schema)

**What changes:**

a) **`initAgentsTable()`** (~line 320-364): Add `heartbeat_interval` column migration:
```typescript
try {
  db.exec(`ALTER TABLE channel_agents ADD COLUMN heartbeat_interval INTEGER NOT NULL DEFAULT 0`);
} catch { /* already exists */ }
```

b) **`/api/app.agents.add`** (~line 417-489): Accept `heartbeat_interval` in request body, include in INSERT.

c) **`/api/app.agents.update`** (~line 513-618): Accept `heartbeat_interval` in request body, include in UPDATE. When heartbeat_interval changes, restart agent to pick up new config.

d) **`/api/app.agents.list`** (~line 376-413): Return `heartbeat_interval` in enriched agent data.

e) **Pass `heartbeat_interval` to `WorkerManager.startAgent()`** — update the `AgentConfig` interface (defined in `worker-manager.ts`) and the `startAgent` call.

---

### 3. `src/worker-manager.ts` (heartbeat monitor overhaul)

**What changes:**

a) **`AgentConfig` interface** (~line 33-50): Add `heartbeatInterval?: number` field (seconds).

b) **Remove global `HeartbeatConfig` interface** (~line 23-31) and `this.heartbeatConfig` (~line 64). The global config becomes only about `processingTimeoutMs` and `spaceIdleTimeoutMs` (still needed for stuck-agent cancellation).

c) **`startAgent()`** (~line 138-184): Pass `heartbeatInterval` into `WorkerLoopConfig`.

d) **`runHeartbeatCheck()`** (~line 292-372): Significant rewrite:
   - **Keep**: Processing timeout check (CHECK 1) — still cancels hung agents.
   - **Keep**: Space agent idle check (CHECK 2) — still auto-fails unresponsive spaces, but change nudge to use LLM-direct heartbeat instead of chat message.
   - **Replace CHECK 3** (main agent error idle nudge): Instead of posting chat message, call a new `loop.injectHeartbeat()` method.
   - **Remove**: All `postNudge()` calls — replace with `loop.injectHeartbeat()`.
   - **Add per-agent timer logic**: Each agent tracks its own last heartbeat time. `runHeartbeatCheck()` checks if `now - lastHeartbeatAt > agent.heartbeatInterval * 1000` for each idle agent.

e) **`handleIdleSpaceAgent()`** (~line 385-415): Replace `loop.postNudge()` with `loop.injectHeartbeat()`.

f) **`checkSpaceWorkerHealth()`** (~line 418-484): Same — replace `postNudge()` with `injectHeartbeat()`.

g) **`loadAgentsFromDb()`** (~line 560-582): Map `heartbeat_interval` from API response into `AgentConfig`.

h) **Keep** `startHeartbeatMonitor()` / `stopHeartbeatMonitor()` / `scheduleNextHeartbeat()` — the global timer still runs at a fixed interval (e.g. 10s) to check all agents. The per-agent interval determines whether each agent actually gets a heartbeat.

---

### 4. `src/worker-loop.ts` (core agent loop)

**What changes:**

a) **`WorkerLoopConfig` interface** (~line 106-141): Add `heartbeatInterval?: number` (seconds).

b) **New method `injectHeartbeat()`**: Replaces `postNudge()`. Instead of posting to chat, this method:
   - Checks `!this.isProcessing && this.running && !this.sleeping` (idle guard).
   - Appends a `[HEARTBEAT]` message to the agent's in-memory session (or triggers a wake via the agent's `run()` method with a synthetic heartbeat prompt).
   - The simplest approach: set a flag `this.heartbeatPending = true` that the poll loop picks up and injects `[HEARTBEAT] You have been idle. Check for pending work or continue your current task.` as a user-role message in the next LLM call.

c) **New field `lastHeartbeatAt: number`**: Tracks when the last heartbeat was sent for this agent.

d) **`postNudge()` (~line 248-264)**: Remove entirely.

e) **`sendNudgeMessage()` (~line 822-855)**: Remove entirely.

f) **`nudgeCount` field** (~line 156): Remove. Replace with a simple `heartbeatCount` for logging purposes only (no max-nudge exhaustion logic — that's handled differently now).

g) **`AgentHealthSnapshot` interface** (~line 90-104): Remove `nudgeCount`. Add `lastHeartbeatAt: number`. Keep `lastExecutionHadError`.

h) **`getHealthSnapshot()`** (~line 215-231): Update to return `lastHeartbeatAt` instead of `nudgeCount`.

i) **`resetNudgeCount()` (~line 267)**: Remove or rename to `resetHeartbeatCount()`.

j) **Poll loop integration** (~line 490+): Before calling `executePrompt()`, check `this.heartbeatPending`. If true, prepend `[HEARTBEAT]` context to the prompt so the LLM sees it as an internal wake signal, not as a chat message.

k) **Remove** `clearLastExecutionError()` (~line 272) — error handling for nudges no longer needed.

---

### 5. `src/agent/src/agent/agent.ts` (system prompt)

**What changes:**

Add `[HEARTBEAT]` explanation to `DEFAULT_SYSTEM_PROMPT` (~line 100-188). Insert after the Context Awareness section:

```
## Heartbeat Signal
- When you receive a [HEARTBEAT] message, it is an internal wake signal — NOT a user message.
- [HEARTBEAT] means you have been idle. Check if there is pending work (unprocessed messages, incomplete tasks) and continue.
- Do NOT reply to [HEARTBEAT] in chat unless you have actual results to report.
- If there is nothing to do, simply acknowledge internally and return to idle.
```

---

### 6. `packages/ui/src/AgentDialog.tsx` (UI overhaul)

**What changes:**

a) **`Agent` interface** (~line 7-17): Add `heartbeat_interval: number`.

b) **Editable fields for existing agents**: Currently Provider/Model/Project are `readOnly` inputs (~line 437-468). Make them editable with save/cancel UX:
   - Add local state for editing: `editProvider`, `editModel`, `editProject`, `editHeartbeat`.
   - On selecting an agent, populate edit state from agent data.
   - Add "Save" button (calls `app.agents.update` with changed fields).
   - Add dirty-tracking to show/hide Save button (similar to identity dirty tracking).

c) **New heartbeat interval input**: Add below Project field:
   ```tsx
   <input
     type="number"
     className="agent-field-input"
     placeholder="Heartbeat interval (seconds, 0=disabled)"
     value={editHeartbeat}
     onChange={(e) => setEditHeartbeat(parseInt(e.target.value) || 0)}
     min={0}
   />
   ```

d) **Add form**: Add `heartbeat_interval` field to the add-agent form too (with default 0).

e) **`handleAddAgent()`** (~line 233-272): Include `heartbeat_interval` in request body.

f) **Save handler**: New `handleSaveAgent()` function that calls `app.agents.update` with Provider/Model/Project/HeartbeatInterval.

---

### 7. `src/config.ts` (AppConfig)

**What changes:**

- **`AppConfig.heartbeat`** (~line 29-42): Simplify. Remove `maxNudges` and `mainAgentErrorIdleTimeoutMs` since nudge logic is removed. Keep:
  - `enabled` — master switch for heartbeat monitor.
  - `intervalMs` — global check frequency (how often `runHeartbeatCheck` runs).
  - `processingTimeoutMs` — cancel threshold for stuck processing.
  - `spaceIdleTimeoutMs` — threshold before heartbeating idle space agents.

---

### 8. `src/config-file.ts` (ConfigFile type)

**What changes:**

- **`ConfigFile.heartbeat`** (~line 107-113): Remove `maxNudges` from type. Keep `enabled`, `intervalMs`, `processingTimeoutMs`, `spaceIdleTimeoutMs`.

---

### 9. `src/spaces/worker.ts` (SpaceWorkerManager)

**What changes:**

- **`getWorkerHealthSnapshots()`** (~line 149): No structural change, but the `AgentHealthSnapshot` type it returns will lose `nudgeCount` and gain `lastHeartbeatAt`. Type change only.

---

## Implementation Phases

### Phase 1: DB Schema + API (1.5h)
1. Add `heartbeat_interval` column migration in `src/api/agents.ts`
2. Update add/update/list endpoints to handle `heartbeat_interval`
3. Update `AgentConfig` interface in `worker-manager.ts`

### Phase 2: Worker Loop Refactor (2.5h)
1. Add `heartbeatInterval` to `WorkerLoopConfig`
2. Implement `injectHeartbeat()` method
3. Add `heartbeatPending` flag + poll loop integration
4. Remove `postNudge()`, `sendNudgeMessage()`, `nudgeCount`
5. Update `AgentHealthSnapshot`

### Phase 3: Worker Manager Refactor (2h)
1. Simplify `HeartbeatConfig` (remove nudge fields)
2. Rewrite `runHeartbeatCheck()` to use per-agent intervals + `injectHeartbeat()`
3. Update `handleIdleSpaceAgent()` and `checkSpaceWorkerHealth()`
4. Update `loadAgentsFromDb()` to map heartbeat_interval

### Phase 4: System Prompt + Config (0.5h)
1. Add `[HEARTBEAT]` section to `DEFAULT_SYSTEM_PROMPT`
2. Simplify `AppConfig.heartbeat` and `ConfigFile.heartbeat` types

### Phase 5: UI (1.5h)
1. Make Provider/Model/Project editable in agent detail view
2. Add heartbeat interval input
3. Add save handler for agent config changes
4. Add heartbeat_interval to add-agent form

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Heartbeat injection causes infinite loops (agent keeps responding to heartbeat) | System prompt explicitly says "do NOT reply in chat to [HEARTBEAT] unless you have work" + mark heartbeat as processed immediately |
| Per-agent timers drift or miss | Use global check interval (10s) with per-agent last-heartbeat tracking, not individual timers |
| Space agents lose auto-fail behavior | Keep `spaceIdleTimeoutMs` + heartbeat count tracking for spaces; after N heartbeats with no progress, still auto-fail |
| DB migration on existing deployments | Use `ALTER TABLE ADD COLUMN` with try/catch (existing pattern in codebase) |

## Unresolved Questions

1. **Heartbeat role**: Should `[HEARTBEAT]` be injected as `user` role or `system` role? User role is simpler (guaranteed to trigger a response cycle). System role is cleaner semantically but some providers ignore system messages mid-conversation.
2. **Space agent heartbeat**: Should space agents inherit `heartbeat_interval` from parent agent, or always use the global `spaceIdleTimeoutMs`?
3. **Max heartbeat cap**: Should there be a maximum number of heartbeats before giving up (replacing `maxNudges`)? Or should per-agent heartbeat just keep firing indefinitely as long as the agent is idle?
