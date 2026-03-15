# Code Review: Multi-Agent Coordination Systems

**Date:** 2026-03-15
**Reviewer:** code-reviewer
**Scope:** Spaces (lifecycle, concurrency), Agent Bus (file I/O), Scheduler (tick loop), Message ordering, SQLite concurrency
**Files Reviewed:** 9 files, ~2100 LOC

## Overall Assessment

The multi-agent coordination layer is well-architected with thoughtful defensive patterns: atomic DB locks for space settlement, WAL+busy_timeout for SQLite concurrency, continuation retry caps, heartbeat-based stuck-agent recovery, and fire-and-forget semantics for sub-agents. The recent stream resilience changes (continuation cap, error tracking, heartbeat nudge-on-error) are solid additions.

Several edge cases and potential issues found, most at Medium severity. No critical security vulnerabilities.

---

## Critical Issues

**None found.** The system handles the major failure modes well.

---

## High Priority

### H1. Space Limit Checks Are Not Atomic (Race Condition)

**File:** `src/spaces/worker.ts:43-53`

The global and per-channel limit checks (lines 43-53) read `this.workers.size` and `getChannelWorkerCount()`, then later insert at line 121. Since `startSpaceWorker` is async (returns a Promise) and the caller in `spawn-plugin.ts` runs `await getAgentConfig()` and `await timedFetch()` *before* calling `startSpaceWorker`, two concurrent `spawn_agent` tool calls could both pass the limit check before either inserts into the Map.

**Impact:** Could exceed the per-channel=5 or global=20 limits by 1-2 under concurrent spawns.

**Mitigation:** The practical risk is low because (a) the limits are soft safety nets, not hard security boundaries, and (b) a single agent processes tool calls sequentially. However, if two agents in the same channel both spawn simultaneously:

```typescript
// Fix: Reserve the slot immediately, release on failure
startSpaceWorker(space, agentConfig): Promise<string> {
  // Check + insert atomically (synchronous)
  if (this.workers.size >= MAX_SPACE_WORKERS_GLOBAL) throw ...;
  if (this.getChannelWorkerCount(space.channel) >= MAX_SPACE_WORKERS_PER_CHANNEL) throw ...;

  // Reserve immediately with a placeholder
  const placeholder = { /* ... */ };
  this.workers.set(space.id, placeholder);
  // ... then set up the real entry
}
```

The current code *does* insert synchronously within the Promise executor, and `startSpaceWorker` itself is synchronous up to the `new Promise()` constructor. The window is actually very small. Confirmed: the check-then-insert happens in the same synchronous execution frame, so **this is safe in single-threaded Node/Bun**. Downgrading to informational.

**Revised assessment:** The limit enforcement is actually correct for single-threaded execution. The check + Map.set both happen synchronously before any `await`. No race condition exists.

### H2. Scheduler `executeToolCall` Missing `runningJobs.delete` on Outer `.catch`

**File:** `src/scheduler/manager.ts:322`

```typescript
this.executeToolCall(job, controller).catch((e) => this.handleJobError(job, e));
```

The `executeToolCall` method has its own `finally` block that calls `this.runningJobs.delete(job.id)` (line 425). However, if `executeToolCall` throws *synchronously* before reaching the try block (unlikely but possible if `this.toolCallExecutor` is reassigned to null between the check and the call), the outer `.catch()` handler (`handleJobError`) does NOT clean up `runningJobs`.

Same issue for `executeJob` at line 324: the outer `.catch` doesn't clean up `runningJobs`, but the inner `finally` does. This is fine as long as the inner try-finally always runs.

**Impact:** A leaked `runningJobs` entry would permanently consume one of the 3 concurrent slots until server restart.

**Likelihood:** Very low. The null-check at line 393-397 returns early and *does* call `this.runningJobs.delete(job.id)`. The only gap is if the method itself throws before entering the try block.

**Recommendation:** Wrap the fire-and-forget in a `.finally()` that always cleans up:

```typescript
this.executeToolCall(job, controller)
  .catch((e) => this.handleJobError(job, e))
  .finally(() => this.runningJobs.delete(job.id)); // Belt-and-suspenders
```

Note: double-delete from Map is safe (no-op on missing key).

### H3. Scheduler Reminder Missing `runningJobs.delete` on Error Path

**File:** `src/scheduler/manager.ts:320`

```typescript
this.executeReminder(job).finally(() => this.runningJobs.delete(job.id));
```

This correctly cleans up via `.finally()`. But inside `executeReminder`, the catch block calls `this.handleJobError(job, err)` -- and `handleJobError` at line 429 checks `wasAborted` but the reminder path doesn't pass it. Since `handleJobError` defaults `wasAborted` to `false`, this works correctly. No issue here.

---

## Medium Priority

### M1. Agent Bus Registry: No File Locking on Shared JSON

**File:** `src/agent/plugins/clawd-agent-bus/plugin.ts:151-163, 174-185`

Multiple agents read-modify-write `registry.json` (read at 188, write at 162). `safeWriteJson` uses `writeFileSync` which is atomic at the OS level (on most filesystems), but the read-modify-write cycle is not:

```
Agent A: reads registry {agents: {A: online}}
Agent B: reads registry {agents: {A: online}}
Agent A: writes {agents: {A: online, B_status_update}}  // B's heartbeat lost
Agent B: writes {agents: {A: online, B: online}}        // A's update lost
```

**Impact:** Lost heartbeat updates. An agent could appear offline when it's actually online. The 2-minute stale threshold (line 261) makes this self-healing, but during the window, `agent_discover` returns incorrect status.

**Recommendation:** Use a per-agent file (`registry/{agentName}.json`) instead of a shared registry. Or use a lock file (e.g., `proper-lockfile` package). Since this is a file-based bus for local dev, the impact is acceptable.

### M2. Agent Bus Topic Publish: Same Read-Modify-Write Race

**File:** `src/agent/plugins/clawd-agent-bus/plugin.ts:362-384`

`agentPublish` reads topic JSON, increments version, pushes message, writes back. Two agents publishing to the same topic simultaneously will lose one message.

**Impact:** Lost topic messages under concurrent publish. The cursor-based subscribe mechanism (line 426) will also mis-track because the version counter can go out of sync with the actual message count.

**Recommendation:** Use append-only message files (one file per message, similar to inbox) or a lock file around topic writes.

### M3. Agent Bus RPC Polling Loop Blocks the Agent

**File:** `src/agent/plugins/clawd-agent-bus/plugin.ts:443-488`

`agentRequest` uses a busy-wait polling loop with 500ms sleep intervals, up to 30 seconds. During this time, the agent's tool call is blocked -- it cannot process other messages, respond to interrupts, or handle new tool calls.

**Impact:** A 30-second RPC timeout monopolizes the agent's execution. If the target agent is offline, this wastes 30 seconds of model API time/cost.

**Recommendation:** Consider making this non-blocking by returning a request ID and letting the agent poll manually, or reduce the default timeout. The current approach is acceptable for short-lived RPC calls.

### M4. Agent Bus Inbox: Read-and-Delete Without Locking

**File:** `src/agent/plugins/clawd-agent-bus/plugin.ts:322-359`

`agentReceive` reads files from the inbox and deletes them. If `scanInbox` (called from fs.watch debounce) runs concurrently with `agentReceive`, a message could be added to `pendingMessages` after `agentReceive` filters but before it splices. This could cause the same message to be returned twice (once from pending, once from a re-scan).

The `pendingMessages.find` dedup check (line 224) prevents duplicates in the array, but if a message file is unlinked (line 342) and then re-scanned, the file won't exist, so no harm. The dedup is adequate.

**Revised assessment:** Low risk due to the dedup check and single-threaded execution model.

### M5. Space Worker: `onComplete` Deletes from Map Before Promise Settlement

**File:** `src/spaces/worker.ts:78-85`

The `onComplete` callback calls `this.workers.delete(space.id)` and then `w.loop.stop()`. Then separately, `stopSpaceWorker` (called from `spawn-plugin.ts:226`) also attempts `this.workers.delete(space.id)` and `entry.state.settled`. If `onComplete` fires first:
- Map entry is deleted
- `stopSpaceWorker` in `.finally()` finds no entry (line 129: `if (!entry) return`)
- The original `resolve` at line 67 is the unwrapped one (stored in `entry` at line 117), not `wrappedResolve`

Wait -- the `entry` stores `resolve` (line 117, the raw resolve), but the space plugin uses `wrappedResolve` (line 77). If `onComplete` fires and stops the loop, the `onLoopExit` (line 103-109) checks `state.settled`. Since `wrappedResolve` already set `state.settled = true`, `onLoopExit` won't double-reject. This is correct.

**Revised assessment:** The settlement state machine is properly guarded by the shared `state.settled` flag. No issue.

### M6. Scheduler Zombie Detection Gap on Unclean Shutdown

**File:** `src/scheduler/manager.ts:94-126`

During graceful shutdown, the code aborts all running jobs and waits 30 seconds. If the process is killed (SIGKILL, OOM), `recoverOnStartup` (line 518) correctly finds zombie runs via `getZombieRuns()` and marks them as error. This is sound.

However, if a job was in the `runningJobs` Map but hadn't yet called `insertRun` (the brief window between line 315 and line 362/400), the zombie detection won't find it because there's no run record. The job's `next_run` was already advanced (line 301), so it won't re-trigger.

**Impact:** A one-time job could be silently lost if the process crashes in the ~1ms window between `updateJobNextRun` and `insertRun`.

**Recommendation:** Insert the run record *before* advancing `next_run`, or wrap both in a transaction.

---

## Low Priority

### L1. fs.watch Reliability

**File:** `src/agent/plugins/clawd-agent-bus/plugin.ts:199-214`

`fs.watch` is known to be unreliable on some Linux filesystems (especially NFS, Docker volumes). The 100ms debounce is good practice. The initial `scanInbox()` call at init (line 121) and the re-scan on `agentReceive` (line 324) provide adequate fallback. No change needed.

### L2. `timedFetch` Replaced `fetch` in Worker Loop

**File:** `src/worker-loop.ts` (recent diff)

The recent changes imported `timedFetch` but the diff doesn't show all call sites. Ensure all `fetch` calls in the worker loop use `timedFetch` to prevent hanging connections from blocking the poll cycle.

### L3. Heartbeat Timer Uses `unref()`

**File:** `src/worker-manager.ts:279-281`

The heartbeat timer is `unref()`'d so it doesn't keep the process alive. This is correct for a monitoring timer. The space timeout timer in `spawn-plugin.ts:169` also uses `unref()`. Both are appropriate.

---

## Edge Cases Found by Scout

1. **Parent agent dies while sub-agent runs:** The `onLoopExit` callback (worker.ts:103-109) rejects the promise if not settled. The `spawn-plugin.ts` timeout controller with `AbortController` + `onAbort` listener provides a second safety net. The eviction timer (spawn-plugin.ts:230) cleans up memory after 30 minutes. If the parent *process* crashes, the sub-agent's loop dies with it (same process). **Covered.**

2. **Multiple agents responding to same message:** Each agent has its own `agent_seen` row with `last_seen_ts` and `last_processed_ts`. The `isRelevant` filter (worker-loop.ts:477-481) skips messages from the same `agent_id`. Two different agents in the same channel WILL both respond to the same human message -- this is by design (multi-agent channels). There's no dedup/claim mechanism. **By design.**

3. **Continuation retry cap overflow:** The new `MAX_CONTINUATION_RETRIES = 5` with `forceMarkProcessed` (worker-loop.ts:344-366) prevents infinite loops. If `forceMarkProcessed` API call fails, it backs off by `CONTINUATION_RETRY_DELAY * 2` (4 seconds). There's no cap on how many times the force-mark itself can fail -- it could loop indefinitely if the API is down. However, the loop body does `continue` and re-enters the while loop, which checks `this.running`, so stopping the loop breaks the cycle. **Acceptable.**

4. **SQLite SQLITE_BUSY under load:** WAL mode + 5s busy_timeout (database.ts:22) is the standard approach. Bun's `bun:sqlite` uses synchronous API, so write contention is bounded by the single-threaded event loop. The scheduler uses a separate `scheduler.db` (scheduler/db.ts:8), reducing contention on `chat.db`. Memory/sessions use `memory.db` (separate file). **Three-database split is a good design.** The recent `resetSession` fix (worker-loop.ts diff) removed a second `Database` connection to `memory.db`, using the `SessionManager` singleton instead -- this eliminates a concurrent-connection SQLITE_BUSY risk. **Good fix.**

5. **Scheduler long-running jobs:** Jobs have configurable timeout (default 300s, max 3600s) with AbortController. The `MAX_CONCURRENT = 3` limit + `isTickRunning` guard (manager.ts:287) prevent the tick from overlapping. A job that ignores the abort signal could block a slot, but this is bounded by the timeout. After 5 consecutive errors, auto-pause kicks in (line 439-451). **Adequate.**

6. **Agent Bus message ordering:** Inbox messages are sorted by timestamp (plugin.ts:232). Since timestamps use `Date.now()` (millisecond precision), two messages in the same millisecond could have non-deterministic order. The random suffix in `generateMessageId` (line 67) doesn't affect sort. **Minor: could use a monotonic counter, but practically irrelevant for inter-agent messaging.**

---

## Positive Observations

1. **Atomic space locking** via `atomicLockSpace` (spaces/db.ts:93-100) using SQL `WHERE locked = 0` -- prevents double-settlement races cleanly.
2. **Three-database split** (chat.db, scheduler.db, memory.db) -- reduces write contention significantly.
3. **Heartbeat monitor** with bounded concurrency (`runWithConcurrencyLimit`, max 5 parallel nudges) -- prevents cascade effects.
4. **Stream resilience** additions (continuation retry cap, `forceMarkProcessed`, `wasCancelledByHeartbeat` flag) -- good defense against infinite loops.
5. **Timer hygiene** -- consistent use of `unref()` on background timers, `clearTimeout` in finally blocks.
6. **Session reset fix** -- using `SessionManager` singleton instead of opening a second SQLite connection eliminates a real SQLITE_BUSY risk.

---

## Recommended Actions (Prioritized)

1. **[H2] Add `.finally()` cleanup to scheduler fire-and-forget calls** for `executeJob` and `executeToolCall` to prevent leaked `runningJobs` entries. Low effort, high defensive value.
2. **[M6] Reorder `insertRun` before `updateJobNextRun`** in the tick loop to prevent silent job loss on crash. Alternatively, wrap in a DB transaction.
3. **[M1/M2] Accept or fix Agent Bus file contention.** If multi-agent bus usage grows beyond dev/prototyping, switch to per-agent registry files and append-only topic files.
4. **[M3] Document the RPC blocking behavior** so agent authors know `agent_request` is synchronous/blocking.

---

## Metrics

- **Type Coverage:** High (TypeScript strict mode, interfaces on all major structures)
- **Test Coverage:** Not assessed (no test files in scope)
- **Linting Issues:** 0 (no syntax or compile errors observed)

---

## Unresolved Questions

1. Is there a cleanup mechanism for orphaned space channels in the `channels` table? If spaces fail after creating the channel but before the worker starts, the channel record persists.
2. The `trackedSpaces` Map in `spawn-plugin.ts` grows unbounded until the 30-minute eviction timer fires. Under rapid spawn cycles, could this cause memory pressure?
3. The Agent Bus `agentRequest` polling loop (500ms, 30s default timeout) runs in the tool handler's async context. Does this block the model API billing/timeout, or is it handled upstream?
