# Error Recovery & Retry Efficiency Review

**Date:** 2026-03-15
**Scope:** 5-layer error recovery stack across agent.ts, client.ts, key-pool.ts, worker-loop.ts, worker-manager.ts
**Focus:** Recovery overlap, wasted retries, backoff efficiency, key rotation, heartbeat nudge latency, context loss

---

## Overall Assessment

The 5-layer recovery system is well-structured and mostly non-interfering. The recent changes (heartbeat error-flag tracking, bounded nudge concurrency, timedFetch consolidation) are solid improvements. However, there are **4 concrete efficiency gaps** that cause wasted compute, unnecessary latency, or recovery blind spots.

---

## 1. Recovery Overlap Analysis

### How the 5 layers interact on a stream error

| Step | Layer | Action | Time |
|------|-------|--------|------|
| 1 | Stream idle timeout (client.ts:548) | Aborts after 60-120s silence | 0s |
| 2 | Agent backoff (agent.ts:2014-2027) | Exponential 2s-60s sleep | +2s |
| 3 | Consecutive error cap (agent.ts:2007-2012) | Stops after 5-10 errors | per-error |
| 4 | Worker loop error tracking (worker-loop.ts:399-405) | Sets `lastExecutionHadError` | after agent returns |
| 5 | Heartbeat nudge (worker-manager.ts:326-351) | Posts nudge message after 60s idle | +60s min |

**Verdict: Layers 1-3 operate within a single `run()` call; layers 4-5 operate after `run()` returns. No direct interference.** The handoff is clean: layer 3 terminates the agent loop, layer 4 flags it, layer 5 nudges it back. One minor concern below.

### Minor overlap risk (Medium)

When the agent hits `maxConsecutiveStreamErrors` (layer 3) and stops, the output contains `[Agent stopped` which triggers `lastExecutionHadError = true` (layer 4). The heartbeat then nudges (layer 5), which posts a new message, which the poll loop picks up as a new message (not continuation), which starts a fresh `executePrompt()`. This is correct behavior. However: the nudge posts as user "UBOT" / agent_id "System" -- the agent's poll loop calls `pollPending()` which fetches `messages.pending` including bot messages. The nudge message is correctly picked up.

**No interference found.** The layers complement each other.

---

## 2. Wasted Retries on Permanent Failures (HIGH)

**Location:** `agent.ts:2003-2031`

**Problem:** All stream errors are treated as retriable. The agent retries up to 5 (or 10 with tool results pending) times for errors that will never succeed:

- Content policy / moderation blocks (HTTP 400 with specific messages)
- Invalid request structure (malformed tool calls, invalid JSON schema)
- Authentication failures (401, non-rate-limit 403)
- Model not found / not available

Each retry includes exponential backoff (2s, 4s, 8s, 16s), wasting up to 30s before the inevitable failure. With `toolResultPending = true`, this extends to 10 retries and up to ~120s of wasted time (2+4+8+16+32+60+60+60+60+60).

**Proposed fix:**

```typescript
// After line 2003 (consecutiveStreamErrors++)
// Classify permanent failures — skip backoff, stop immediately
const isPermanent =
  errorMsg.includes("content_filter") ||
  errorMsg.includes("content management policy") ||
  errorMsg.includes("invalid_request") ||
  errorMsg.includes("model_not_found") ||
  (errorMsg.includes("401") && !errorMsg.includes("429")) ||
  (errorMsg.includes("403") && !errorMsg.includes("rate"));

if (isPermanent) {
  console.error(`[Agent] Permanent error, not retrying: ${errorMsg}`);
  finalContent = `[Agent stopped: non-retriable error: ${errorMsg}]`;
  break;
}
```

**Expected gain:** Eliminates 30-120s of wasted backoff on permanent failures. In production, content policy errors are not uncommon with user-generated prompts.

---

## 3. Backoff Efficiency: Missing Immediate First Retry (HIGH)

**Location:** `agent.ts:2014-2027`

**Problem:** The current backoff logic:
- Error 1: no sleep (good)
- Error 2: 2s sleep
- Error 3: 4s sleep
- Rate limit: always 30s fixed

The first retry (error 1) has no backoff, which is good. But the second retry (error 2) jumps to 2s. For transient network errors (connection reset, DNS hiccup), a resolution within 100-500ms is common. The 2s wait is fine.

**However**, there is a real problem with rate limit handling:

**Rate limit backoff is a flat 30s regardless of Retry-After header.** The API returns `retryAfterMs` (used by key-pool.ts for cooldown), but the agent-level backoff in agent.ts ignores it and hard-codes 30s. If the API says "retry in 5s", the agent waits 30s. If the API says "retry in 120s", the agent waits only 30s and hits the rate limit again.

**Proposed fix:**

```typescript
if (isRateLimit) {
  // Use Retry-After from error if available, otherwise 30s default
  const retryAfterMatch = errorMsg.match(/retry.after.*?(\d+)/i);
  const retryMs = retryAfterMatch
    ? Math.min(parseInt(retryAfterMatch[1]) * 1000, 120_000)
    : 30_000;
  console.log(`[Agent] Rate limited, sleeping ${retryMs}ms before retry...`);
  await new Promise((resolve) => setTimeout(resolve, retryMs));
}
```

**Expected gain:** Reduces unnecessary wait on short rate limits (5-10s actual vs 30s hardcoded). Prevents re-hitting rate limits when server says to wait longer.

---

## 4. AllKeysSuspendedError Propagation (GOOD, one gap)

**Location:** `client.ts:258-318`, `agent.ts:1791-1810`

**Propagation path:**
1. `keyPool.selectKey()` throws `AllKeysSuspendedError` when no key is available
2. `client.complete()` lets it propagate (line 263, 317)
3. `client.stream()` lets it propagate (line 420, 503)
4. `agent.ts:1792` catches it, notifies user, sets `_cancelled = true`, returns

**This is well-handled.** No tight retry loop. When all keys are suspended, the agent stops immediately with a user-facing message and earliest resume time.

**One gap:** After `AllKeysSuspendedError`, the agent returns an empty content string. The worker-loop checks `execResult.success` but the agent returns `{ content: "" }` without explicitly marking `success: false`. Need to verify whether the `executePrompt()` wrapper treats empty content as failure.

Let me check: `worker-loop.ts:399-405` checks `output.includes("[Agent stopped")` -- but `AllKeysSuspendedError` returns empty string `""`, not `[Agent stopped...]`. So `lastExecutionHadError` may be `false` (if `execResult.success` is true), and the heartbeat won't nudge. This is actually correct -- nudging when all keys are suspended would just hit the same error. But it means the agent goes completely silent with no recovery mechanism until keys resume.

**Recommendation (Low):** Add a scheduled wake-up based on `earliestResumeAt` rather than relying on the next user message.

---

## 5. Heartbeat Nudge End-to-End Recovery Time (MEDIUM)

**Recovery timeline for a stuck agent:**

| Event | Elapsed |
|-------|---------|
| Agent `run()` fails with stream errors | 0s |
| Agent exhausts 5 retries with backoff (2+4+8+16s) | ~30s |
| Agent returns, `lastExecutionHadError = true` | ~30s |
| Worker loop marks `isProcessing = false`, sets `lastActivityAt` | ~30s |
| Heartbeat interval fires (every 30s) | +0-30s (worst: 60s) |
| Heartbeat checks `idleDurationMs > 60_000` (spaceIdleTimeoutMs) | must wait 60s idle |
| Nudge posted via HTTP | +~100ms |
| Worker loop polls pending messages (200ms interval) | +0-200ms |
| Agent processes nudge message | +~5-30s (LLM call) |
| **Total: ~120-150s from first error to resumed work** | |

**The 60s idle timeout is the biggest bottleneck.** The agent has already been backing off for ~30s internally; then it sits idle for another 60s before the heartbeat notices.

**Proposed fix:** Reduce main-agent post-error idle timeout to 15-30s (separate from space agent idle timeout which should remain at 60s since space agents may be intentionally idle between steps).

```typescript
// In heartbeat config
mainAgentErrorIdleTimeoutMs: config.heartbeat?.mainAgentErrorIdleTimeoutMs ?? 15_000,
```

**Expected gain:** Reduces worst-case recovery from ~150s to ~75s.

---

## 6. Context Loss on Recovery (GOOD)

**Agent recovery preserves context well:**

1. **Session persistence:** Messages are saved to SQLite (`sessions.addMessage`) throughout execution, including partial content on stream errors (agent.ts:1970-1994)
2. **System prompt:** Rebuilt from config on each `run()` call -- not lost
3. **Tool definitions:** Rebuilt from registered tools on each `run()` call -- not lost
4. **Conversation history:** Loaded from session DB on each `run()` call via `getRecentMessagesCompact()`
5. **Checkpoints:** Preserved through `checkpointManager` across runs

**One concern:** After context overflow compaction (agent.ts:1902-1906), in the worst case, messages are reduced to just `[system, user]` -- all conversation history is lost. This is an intentional emergency measure and acceptable, but the user gets no notification beyond `[Context overflow -- compacted]` in the session.

---

## 7. Findings from Recent Diff

The uncommitted changes in `worker-loop.ts` and `worker-manager.ts` are quality improvements:

**Good:**
- `lastExecutionHadError` flag for heartbeat-driven recovery of main channel agents (previously only space agents were monitored)
- `wasCancelledByHeartbeat` flag prevents false-negative error detection
- Nudge counter reset after successful execution prevents permanent stuck state
- Bounded concurrency for nudge actions (`runWithConcurrencyLimit`)
- `timedFetch` consolidation removes boilerplate
- Session reset via `getSessionManager()` singleton eliminates SQLITE_BUSY risk

**Concern (Medium):**
- `worker-loop.ts:428` (catch block): sets `lastExecutionHadError = true` unconditionally on any exception, including non-error exceptions. This is fine for now since JS exceptions are almost always errors, but worth noting.

---

## Summary of Recommendations

| # | Priority | Issue | Expected Gain |
|---|----------|-------|---------------|
| 1 | **High** | Classify permanent errors as non-retriable | Saves 30-120s per permanent failure |
| 2 | **High** | Use Retry-After header for rate limit backoff | Better rate limit compliance, less wasted wait |
| 3 | **Medium** | Reduce main-agent post-error idle timeout to 15-30s | Cuts recovery time from ~150s to ~75s |
| 4 | **Low** | Schedule wake-up after AllKeysSuspendedError based on resumeAt | Auto-recovery when keys resume |
| 5 | **Low** | Add dedicated error-idle timeout separate from space-idle timeout | Cleaner configuration, independent tuning |

---

## Positive Observations

- AllKeysSuspendedError propagation is clean -- no tight retry loop
- Context preservation through stream errors is thorough (partial content saved)
- Context overflow recovery with calibrated correction factor is sophisticated
- Tool-result-pending grants more retries (10 vs 5) -- good pragmatic design
- Heartbeat bounded concurrency prevents event loop flooding
- The 5-layer design has clear separation of concerns with no deadlocks

---

## Metrics

- Recovery layers analyzed: 5
- Files reviewed: 5 (agent.ts, client.ts, key-pool.ts, worker-loop.ts, worker-manager.ts)
- Critical issues: 0
- High priority: 2
- Medium priority: 1
- Low priority: 2
