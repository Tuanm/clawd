# Spaces (Sub-Agent) System Efficiency Review

**Date:** 2026-03-15
**Scope:** spawn-plugin.ts, worker.ts, plugin.ts, worker-loop.ts, worker-manager.ts, spaces/db.ts, spaces/manager.ts
**Focus:** Startup overhead, context cold start, result delivery latency, parallel limits, agent reuse, progress visibility

---

## Overall Assessment

The Spaces system is architecturally sound -- clean separation of concerns, proper atomic locking, heartbeat recovery. However, it was designed for fire-and-forget sub-agents, not iterative collaboration. Every bottleneck below stems from that assumption. The highest-impact improvements are context seeding (2), result delivery (3), and agent reuse (5).

---

## 1. Sub-Agent Startup Overhead

### Current Flow (spawn_agent call to first message processed)

| Step | Operation | Estimated Latency |
|------|-----------|-------------------|
| 1 | `getAgentConfig` -- HTTP fetch to `app.agents.list` | 5-20ms |
| 2 | `createSpaceRecord` -- SQLite transaction: validate parent channel, INSERT channel, register agent, INSERT space | 1-5ms |
| 3 | Post preview card to parent channel -- HTTP POST | 5-20ms |
| 4 | Post task to space channel -- HTTP POST | 5-20ms |
| 5 | `startSpaceWorker` -- construct WorkerLoop, create plugins | <1ms |
| 6 | `loop.start()` -- first poll cycle (200ms sleep) | 200ms |
| 7 | First `pollPending` -- 3 HTTP fetches (getLastSeen, getLastProcessed, messages.pending) + markSeen POST | 20-50ms |
| 8 | `executePrompt` -- initialize sandbox, create Agent, create provider, register 3-4 plugins, load CLAWD.md, load agents.json, load role files | 50-200ms |
| 9 | First LLM API call | 500-3000ms (provider-dependent) |

**Total estimated: 800ms - 3500ms** from spawn to sub-agent processing its first message.

### Bottleneck Analysis

- **Steps 1, 3, 4 are sequential HTTP calls** (lines 88, 113, 140 in spawn-plugin.ts). Steps 3 and 4 could run in parallel -- they hit different channels and have no data dependency (card_ts update on line 135 is a nice-to-have, not blocking).
- **Step 6: mandatory 200ms sleep** before first poll. The WorkerLoop always does `await Bun.sleep(POLL_INTERVAL)` at the bottom of the loop (line 437). On first iteration with a fresh message already posted, this is pure waste.
- **Step 8: Agent construction is heavyweight**. Each sub-agent re-creates a Provider instance, re-reads CLAWD.md from disk, re-parses agents.json, re-initializes sandbox. None of this varies between sub-agents on the same channel.

### Proposed Improvements

**P1: Skip first poll delay for space agents.** Add an `immediateFirstPoll` flag to WorkerLoopConfig. When set, skip the trailing `Bun.sleep(POLL_INTERVAL)` on the first iteration. Saves 200ms per spawn.

```typescript
// In loop(), before the trailing sleep:
if (this.firstIteration && this.config.immediateFirstPoll) {
  this.firstIteration = false;
  continue; // Skip sleep on first iteration
}
```

**P2: Parallelize card post + task post.** In spawn-plugin.ts, fire both HTTP requests concurrently:

```typescript
const [cardRes, taskRes] = await Promise.all([
  timedFetch(cardPostUrl, cardOpts),
  timedFetch(taskPostUrl, taskOpts),
]);
```

Saves 5-20ms. Minor but free.

**P3: Cache shared resources per channel.** CLAWD.md content, agents.json, sandbox initialization state, and role files are identical for all agents on the same channel. Create a `ChannelContext` cache keyed by channel+projectRoot that memoizes these. Saves 10-50ms per spawn after the first.

---

## 2. Context Cold Start

### Current Problem

Sub-agents start with zero project knowledge. The only context they receive is:
- System prompt (~4000 chars max, truncated at `MAX_SYSTEM_INSTRUCTIONS_LENGTH`)
- The task string (max 500 chars in space description)
- CLAWD.md instructions
- Agent identity from agents.json

They must then independently:
- Discover project structure
- Read relevant files
- Understand codebase conventions

This means every sub-agent wastes its first 2-5 tool calls (and 1-3 LLM round trips) on orientation. For a 5-agent parallel spawn, that is 10-25 wasted tool calls.

### Proposed Improvements

**P1 (High Impact): Context seeding parameter in spawn_agent.**

Add an optional `context` parameter to the spawn_agent tool:

```typescript
{
  name: "spawn_agent",
  parameters: {
    task: { type: "string", description: "The task" },
    name: { type: "string", description: "Optional name" },
    context: { type: "string", description: "Project context, file contents, or prior findings to seed the sub-agent" },
  }
}
```

The parent agent already has project knowledge in its session. Allowing it to pass a context block (project structure, key file contents, relevant code snippets) eliminates the orientation phase. This context gets prepended to the task message posted to the space channel.

Implementation: In spawn-plugin.ts line 144, change:
```typescript
text: `**Task:** ${task}`,
// to:
text: `**Context:**\n${args.context || 'None provided'}\n\n**Task:** ${task}`,
```

**Expected impact:** Saves 2-5 LLM round trips per sub-agent (10-30 seconds each). This is the single highest-ROI improvement.

**P2 (Medium Impact): Session inheritance.**

Allow sub-agents to inherit a read-only snapshot of the parent's session context. The parent's `SessionManager` already stores conversation history. A lightweight approach: extract the last N tool results from the parent session and inject them as "prior knowledge" into the sub-agent's first prompt.

More complex to implement but eliminates cold start entirely for follow-up spawns.

---

## 3. Result Delivery Latency

### Current Flow

1. Sub-agent calls `respond_to_parent` (plugin.ts line 27-65)
2. Posts result as chat message to parent channel via HTTP (line 44-54)
3. Resolves the completion promise via `config.resolve(result)` (line 61)
4. Parent's WorkerLoop must poll for new messages (200ms cadence)
5. Parent sees the message in `pollPending` as an unseen message
6. Parent's Agent processes it

**Total latency from respond_to_parent to parent processing: 200-400ms** (poll interval + HTTP round trip + message filtering)

### The Real Problem

The completion promise (step 3) resolves immediately, but the parent never uses it. Look at spawn-plugin.ts lines 205-232: `completionPromise.then()` only updates the `tracked` status. The parent agent has no mechanism to be notified that a sub-agent completed -- it relies on seeing the chat message in its normal poll cycle.

This means the parent treats sub-agent results identically to human messages: poll, discover, process. There is no fast path.

### Proposed Improvements

**P1 (High Impact): Wake-on-complete signal.**

When a sub-agent completes, immediately trigger the parent's poll cycle instead of waiting for the next 200ms tick. Add a `wakeUp()` method to WorkerLoop:

```typescript
wakeUp(): void {
  // Interrupt the current Bun.sleep in the poll loop
  this.wakeSignal?.resolve();
}
```

In the spawn-plugin's `completionPromise.then()`, call the parent loop's `wakeUp()`. This requires the spawn plugin to hold a reference to the parent WorkerLoop.

**Expected impact:** Reduces result delivery from 200-400ms to <50ms.

**P2 (Medium Impact): Direct result injection.**

Instead of posting to the chat channel and waiting for the parent to poll it, inject the result directly into the parent's next prompt. The `trackedSpaces` map already has the result (line 211). A custom prompt builder could check `trackedSpaces` for newly completed spaces and include their results inline.

This bypasses the chat API entirely for result delivery. Saves one HTTP round trip + poll cycle.

---

## 4. Parallel Spawn Limits

### Current Limits

- `MAX_SPACE_WORKERS_PER_CHANNEL = 5` (worker.ts line 7)
- `MAX_SPACE_WORKERS_GLOBAL = 20` (worker.ts line 8)

### Resource Cost Per Sub-Agent

Each sub-agent consumes:
- 1 WorkerLoop instance (lightweight -- just a polling loop)
- 1 Agent instance (~5-10MB memory for tool registrations, session state)
- 1 LLM connection (the dominant cost -- API rate limits, token consumption)
- 1 SQLite row + 1 channel record
- N HTTP polls at 200ms cadence (3-4 fetches per cycle = 15-20 HTTP requests/sec per agent)
- Shared MCPManager reference (no additional MCP connections)

### Analysis

The per-channel limit of 5 is reasonable for typical workflows. The real constraint is:

1. **HTTP polling load:** 5 agents x 20 req/sec = 100 requests/sec to the chat API from polling alone. At 10 agents this becomes 200 req/sec. The local chat server can likely handle this, but it creates unnecessary load.

2. **LLM API rate limits:** Most providers cap concurrent requests. 5 parallel agents hitting the same API key will compete for rate limits. This is the true bottleneck, not the per-channel limit.

3. **Token budget:** 5 agents each consuming 50k-128k context windows = 250k-640k tokens in flight simultaneously.

### Proposed Improvements

**P1: Make limits configurable.** Move to config file rather than hardcoded constants:

```typescript
const MAX_SPACE_WORKERS_PER_CHANNEL = config.spaces?.maxPerChannel ?? 5;
const MAX_SPACE_WORKERS_GLOBAL = config.spaces?.maxGlobal ?? 20;
```

**P2: Reduce polling overhead.** Switch space agents from fixed 200ms polling to event-driven or long-polling. Since the chat server is local (same process), use an in-process EventEmitter or BroadcastChannel instead of HTTP polling. This eliminates 15-20 HTTP requests/sec per sub-agent.

**P3: Raise per-channel to 8, lower global to 15.** Based on resource analysis, 8 per channel is safe for most LLM providers. Lower global to 15 since each agent's HTTP polling load compounds.

---

## 5. Sub-Agent Reuse

### Current Problem

Every `spawn_agent` call creates a new:
- Space record in SQLite
- Channel in SQLite
- Agent registration
- WorkerLoop instance
- Agent instance with full plugin chain
- LLM session

When the sub-agent completes:
- Space is locked
- Worker loop is stopped
- Agent is closed
- Channel agents are deleted
- TrackedSpace evicted after 30 minutes

For iterative workflows (research -> implement -> test), the parent spawns 3 sequential agents. Each cold-starts independently. There is no way to re-task a completed agent.

### Proposed Improvements

**P1 (High Impact): Warm agent pool.**

Instead of destroying agents on completion, keep them in a "warm" pool for the channel:

```typescript
interface WarmAgent {
  loop: WorkerLoop;
  spaceChannel: string;
  lastUsedAt: number;
  // Agent instance stays alive with session history
}
```

When `spawn_agent` is called, check the warm pool first. If a warm agent exists:
1. Post the new task to its existing space channel
2. Re-associate it with a new space record
3. Skip all initialization steps

This reduces spawn latency from 800-3500ms to <50ms for follow-up tasks.

**Eviction policy:** TTL of 60 seconds idle. Max 2 warm agents per channel. On eviction, clean up normally.

**Complexity:** Medium-high. Requires careful session management to prevent context pollution between tasks. The agent's session would need a "task boundary" marker.

**P2 (Medium Impact): `retask_agent` tool.**

Simpler alternative: add a `retask_agent` tool that sends a new task to a running sub-agent without going through the full spawn cycle. The sub-agent's `respond_to_parent` would be replaced with `report_progress` (non-terminal) and `complete_task` (terminal).

```typescript
{
  name: "retask_agent",
  parameters: {
    agent_id: { type: "string" },
    task: { type: "string" },
  }
}
```

This is simpler than warm pooling because the agent never stops -- it just receives a new message in its channel.

---

## 6. Progress Visibility

### Current Problem

The parent has exactly two states for a sub-agent: running or done. There is no intermediate visibility. The `list_agents` tool (spawn-plugin.ts line 59-75) shows only: id, name, status (running/completed/failed), started_at, duration_ms.

The parent cannot see:
- What step the sub-agent is on
- Whether it is making progress or stuck
- How much work remains
- Whether it needs help or is blocked

This forces the parent to either wait blindly or set conservative timeouts.

### Proposed Improvements

**P1 (High Impact): `report_progress` tool for sub-agents.**

Add a non-terminal reporting tool alongside `respond_to_parent`:

```typescript
{
  name: "report_progress",
  description: "Send a progress update to the parent without completing the sub-space.",
  parameters: {
    status: { type: "string", description: "Brief status (e.g., 'reading files', 'running tests')" },
    percent: { type: "number", description: "Estimated completion percentage (0-100)" },
    details: { type: "string", description: "Optional detailed progress info" },
  },
  required: ["status"],
}
```

Updates are stored on the space record and visible via `list_agents`. No chat message posted (to avoid noise in parent channel). The heartbeat monitor could also use this to distinguish "active and progressing" from "stuck."

**P2 (Medium Impact): Automatic progress inference.**

Track tool call counts and last tool name on the WorkerLoop health snapshot:

```typescript
interface AgentHealthSnapshot {
  // ... existing fields ...
  toolCallCount: number;
  lastToolName: string | null;
  lastToolAt: number | null;
}
```

The `list_agents` tool can then show "Agent has made 12 tool calls, last: bash (3s ago)" without any changes to the sub-agent's behavior.

**P3 (Low Impact): WebSocket progress stream.**

Already partially implemented via `broadcastHeartbeatEvent`. Extend to broadcast sub-agent progress updates for UI rendering. Low priority since this helps the UI, not the parent agent's decision-making.

---

## Priority Matrix

| # | Improvement | Impact | Effort | Priority |
|---|-------------|--------|--------|----------|
| 2-P1 | Context seeding parameter | Very High | Low | **CRITICAL** |
| 3-P1 | Wake-on-complete signal | High | Low | **HIGH** |
| 1-P1 | Skip first poll delay | Medium | Very Low | **HIGH** |
| 5-P2 | retask_agent tool | High | Medium | **HIGH** |
| 6-P1 | report_progress tool | High | Low | **HIGH** |
| 1-P2 | Parallelize card+task posts | Low | Very Low | **MEDIUM** |
| 4-P2 | Event-driven sub-agent messaging | High | High | **MEDIUM** |
| 6-P2 | Automatic progress inference | Medium | Low | **MEDIUM** |
| 2-P2 | Session inheritance | High | High | **MEDIUM** |
| 1-P3 | Cache shared resources | Medium | Medium | **MEDIUM** |
| 4-P1 | Configurable limits | Low | Very Low | **LOW** |
| 5-P1 | Warm agent pool | Very High | High | **LOW** (complex) |
| 3-P2 | Direct result injection | Medium | Medium | **LOW** |
| 4-P3 | Adjust default limits | Low | Very Low | **LOW** |

---

## Recommended Implementation Order

**Phase 1 -- Quick wins (1-2 days):**
1. Context seeding parameter (2-P1) -- biggest ROI, ~30 lines changed
2. Skip first poll delay (1-P1) -- ~10 lines
3. Parallelize card+task posts (1-P2) -- ~5 lines
4. report_progress tool (6-P1) -- ~50 lines
5. Configurable limits (4-P1) -- ~10 lines

**Phase 2 -- Medium effort (3-5 days):**
6. Wake-on-complete signal (3-P1) -- requires WorkerLoop refactor for interruptible sleep
7. retask_agent tool (5-P2) -- new tool + lifecycle changes
8. Automatic progress inference (6-P2) -- extend health snapshot

**Phase 3 -- Architectural (1-2 weeks):**
9. Event-driven sub-agent messaging (4-P2) -- replace HTTP polling for spaces
10. Session inheritance (2-P2) -- session manager changes
11. Warm agent pool (5-P1) -- complex lifecycle management

---

## Edge Cases and Risks

- **Context seeding:** Large context strings could exceed `MAX_COMBINED_PROMPT_LENGTH` (40k chars). Add truncation.
- **Wake-on-complete:** Race condition if parent is mid-processing when wake fires. Guard with `isProcessing` check.
- **Agent reuse:** Session pollution between tasks. Prior task's tool results remain in context. Mitigate with explicit task boundary markers in the session.
- **report_progress:** Sub-agents may over-report, consuming LLM tokens on progress calls instead of actual work. Rate-limit to max 1 progress report per 10 seconds.
- **Event-driven messaging:** Removes the HTTP API as a debugging observation point. Keep HTTP as fallback for debugging.

---

## Unresolved Questions

1. What is the actual LLM API rate limit per provider? This determines the real ceiling for parallel agents.
2. Is there a plan to support cross-channel sub-agents (sub-agent works on a different project root than parent)?
3. Should sub-agents inherit MCP server connections or get their own? Currently they share via `channelMcpManager`.
