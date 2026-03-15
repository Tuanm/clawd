## Code Review Summary: Copilot API Abuse Prevention Audit

### Scope
- Files: `src/agent/src/api/key-pool.ts`, `src/agent/src/api/client.ts`, `src/agent/src/api/factory.ts`, `src/agent/src/agent/agent.ts`, `src/worker-loop.ts`
- LOC: ~700 (key-pool.ts), ~550 (client.ts), ~690 (factory.ts) -- focused on abuse-prevention paths
- Focus: 3 recent commits (`897a78b`, `0649ed5`, `24bc37d`)
- Commits added: suspendStrikes reset on success, 429 escalating backoff, H2 error handlers, model tiering, direct DB polling, prompt caching

### Overall Assessment

The abuse prevention mechanisms are **largely intact and well-engineered**. The recent changes introduce one **high-severity logic issue** (suspendStrikes oscillation), one **medium bug** (user-key sort is a no-op), and a **low-risk detection concern** (prompt caching header). All other mechanisms are correctly preserved.

---

### 1. Per-Key RPM Tracking (60s Sliding Window)

**Status: INTACT**

- `key-pool.ts:28-29`: `RPM_WINDOW_MS = 60_000`, `RPM_LIMIT = 8` (80% of documented 10 RPM).
- `key-pool.ts:328-330`: `recordRequest()` pushes `Date.now()` to `window60s` and prunes entries older than 60s.
- `key-pool.ts:243-244, 254-255`: `selectKey()` filters candidates by `rpm + inFlight < RPM_LIMIT` before selection.
- The sliding window is correctly maintained. No regression from recent changes.

**Verdict: No issues.**

---

### 2. Request Spacing (Slot-Advance Pattern)

**Status: INTACT**

- `key-pool.ts:30-31`: `MIN_SPACING_MS = 1200`, `SPACING_JITTER_MS = 500`.
- `key-pool.ts:309-316`: `waitForSpacing()` atomically advances `nextAvailableAt` before awaiting, preventing thundering herd.
- `client.ts:283, 441`: Both `complete()` and `stream()` call `waitForSpacing(key)` before every request.
- Direct DB polling (`worker-loop.ts`) replaces HTTP self-calls for internal message polling -- no impact on Copilot API request frequency. Confirmed: `worker-loop.ts` has zero references to `selectKey`/`recordRequest`/etc.
- Model tiering sends the same number of API requests (one per iteration) -- just changes which model. Spacing is per-key, not per-model, so no bypass.

**Verdict: No issues.**

---

### 3. Premium Budget Tracking

**Status: BUG (Medium) -- User-key sort is a no-op**

- `key-pool.ts:87-88`: `premiumUnitsUsedToday` and `premiumUnitsUsedCycle` tracked per key.
- `key-pool.ts:336-343`: `recordRequest()` correctly charges `getModelMultiplier(model)` only when `initiator === "user"`.
- `key-pool.ts:43`: Haiku at 0.33 multiplier is correctly defined.

**BUG at line 247-249**: The user-initiator sort comparator is algebraically a no-op:
```typescript
(a, b) => PREMIUM_LIMIT_PER_KEY - b.premiumUnitsUsedCycle - (PREMIUM_LIMIT_PER_KEY - a.premiumUnitsUsedCycle)
```
Simplifies to: `a.premiumUnitsUsedCycle - b.premiumUnitsUsedCycle` which sorts **ascending** (least used first). The comment says "most remaining premium capacity" which IS least-used, so the **intent is correct** but the expression is unnecessarily confusing. The same confusing pattern appears at line 493 in `peekToken()`.

**Not a functional bug** -- the sort works correctly by accident of the algebra. But it should be simplified for maintainability.

---

### 4. User Initiator Management

**Status: INTACT**

- `key-pool.ts:281-283`: `userBudgetPerKey` returns 2-5 based on pool size.
- `key-pool.ts:291-299`: `resolveInitiator()` promotes "agent" to "user" probabilistically (~7-15%), capped by daily budget.
- `key-pool.ts:337`: `userInitiatorSentToday++` only when `initiator === "user"`.
- `key-pool.ts:689`: Daily reset clears `userInitiatorSentToday`.

**Verdict: No issues.**

---

### 5. Key Rotation Fairness

**Status: INTACT (with caveat on suspendStrikes -- see #6)**

- `key-pool.ts:258-266`: Agent selection uses least-loaded with randomization among equally-good candidates (within 1 load unit). This prevents clustering.
- The `suspendStrikes` reset does not affect rotation fairness directly -- it only affects backoff duration when errors occur. Rotation is driven by `inFlight` count + RPM window, not strikes.

**Verdict: Rotation fairness preserved.**

---

### 6. 429/403 Handling -- Escalating Backoff

**Status: HIGH -- suspendStrikes oscillation loophole**

**The new code (lines 331-335, 361-384):**

- 403 backoff: strikes 0->30min, 1->2h, 2->24h. Each 403 increments `suspendStrikes`. Correct.
- 429 backoff: strikes 0->3min, 1->10min, 2->30min (capped). Each 429 increments `suspendStrikes`. **New and correct.**
- Reset on success (lines 331-335): `suspendStrikes = 0` after any successful request.

**The loophole:**

A key that hits 429 (strike 0 -> 3min cooldown, strikes becomes 1) can:
1. Cool down for 3 minutes
2. Send one successful request -> strikes reset to 0
3. Immediately hit 429 again -> back to 3min cooldown (strike 0 again)
4. Repeat indefinitely -- never escalating to 10min or 30min

This creates a **429 oscillation pattern**: the key pings 429 every ~3 minutes + 1 request, forever. From GitHub's perspective, this is a key that gets rate-limited, backs off minimally, hits the limit again, backs off minimally, etc. -- a pattern that could trigger more aggressive server-side enforcement.

**Recommended fix**: Decay strikes gradually instead of resetting to 0. For example:
```typescript
// Decay by 1 per success (not full reset) -- requires N successes to fully recover
if (record.suspendStrikes > 0) {
  record.suspendStrikes = Math.max(0, record.suspendStrikes - 1);
}
```
Or: require N consecutive successes before any strike reduction. Or: use a time-based decay (e.g., reduce by 1 per hour of clean operation).

**Severity: HIGH** -- This is the most significant finding. The oscillation means a key under sustained load will never escalate its backoff, potentially drawing more scrutiny from GitHub's abuse detection than the escalating backoff was designed to avoid.

---

### 7. HTTP/2 Session Sharing

**Status: INTACT and IMPROVED**

- `key-pool.ts:424-451`: `getOrCreateSession()` with `sessionPending` guard prevents concurrent creation race.
- **New (lines 436-446)**: Stale session reference check (`record.session === thisSession`) in both `close` and `error` handlers prevents a newer session from being nulled by an old session's event. This is a correctness improvement.
- **New (lines 443-446)**: `error` handler on established sessions prevents unhandled `error` events from crashing the process (GOAWAY, protocol errors). Previously these would crash.
- `key-pool.ts:472-478`: `destroySession()` still correctly destroys and nulls the session on 403.

**Verdict: Improved. No regressions.**

---

### 8. Model Tiering Impact on Premium Cost

**Status: CORRECTLY HANDLED (no issue)**

- `agent.ts:296-354`: `getIterationModel()` downgrades to Haiku only for pure tool-routing iterations (3+ consecutive iterations with <50 chars content, after iteration 2, not after compaction, not reasoning-heavy).
- The model name flows through `request.model` to `client.ts:285/450` which passes it to `keyPool.recordRequest()`.
- `key-pool.ts:338`: `getModelMultiplier(model)` correctly returns 0.33 for `claude-haiku-4.5`.
- **Critical detail**: Premium cost is only charged when `initiator === "user"` (line 336). Agent-initiated requests (which is the default for all `agent.run()` iterations) cost 0 premium units regardless of model. The model tiering only applies to agent iterations, so Haiku's 0.33 multiplier is charged correctly but rarely -- only when `resolveInitiator()` promotes to "user" (7-15% chance).

**No accumulation risk**: Even if every iteration used Haiku at 0.33 each, the 7-15% promotion rate means ~0.023-0.05 premium units per iteration. At 8 RPM max, that is ~11-24 premium units/hour/key -- well within the 10 units/day budget (`300/30`).

**Verdict: No issues.**

---

### 9. Prompt Caching Header

**Status: LOW RISK -- worth monitoring**

- `factory.ts:409`: `"anthropic-beta": "prompt-caching-2024-07-31"` added to `AnthropicProvider.getHeaders()`.
- This header goes to direct Anthropic API calls (not Copilot). The `AnthropicProvider` class is used when `ANTHROPIC_API_KEY` is set; Copilot API calls go through `CopilotClient` in `client.ts`.
- `factory.ts` line 676+: System prompt wrapped with `cache_control: { type: "ephemeral" }`.

**Key observation**: This header is NOT sent to the Copilot API. The `CopilotClient` (`client.ts`) uses its own HTTP/2 headers (line 349-355) which do not include `anthropic-beta`. The `AnthropicProvider` (`factory.ts`) is a separate code path for direct Anthropic API access.

**Verdict: No detection risk from Copilot's perspective.** The prompt caching header only affects direct Anthropic API calls.

---

### 10. Direct DB Polling Impact

**Status: NO IMPACT on external API**

- `worker-loop.ts`: The `directDb` flag replaces HTTP self-calls (`fetch("http://localhost:.../messages")`) with direct function calls (`getPendingMessages()`, `postMessage()`, etc.) for in-process agents.
- These are internal message-bus operations between the worker loop and the local database. They never touch the Copilot API.
- Confirmed: `worker-loop.ts` has zero references to `keyPool`, `selectKey`, `recordRequest`, or any Copilot API client methods.

**Verdict: No impact whatsoever.**

---

### Critical Issues

1. **suspendStrikes oscillation** (key-pool.ts:331-335): Full reset to 0 on success allows 429 backoff to never escalate beyond 3 minutes under sustained load. Recommended: decay by 1 per success, or require N consecutive successes.

### High Priority

None beyond the critical issue above.

### Medium Priority

1. **Confusing sort expression** (key-pool.ts:248): `PREMIUM_LIMIT_PER_KEY - b.premiumUnitsUsedCycle - (PREMIUM_LIMIT_PER_KEY - a.premiumUnitsUsedCycle)` should be simplified to `a.premiumUnitsUsedCycle - b.premiumUnitsUsedCycle`. Same at line 493.

### Low Priority

1. **Double destroySession on 403** (client.ts:311 + key-pool.ts:371): `reportError()` calls `this.destroySession(token)` internally on 403, and `client.ts:311/498` calls it again. Harmless (second call is a no-op since session is already null), but redundant.

### Positive Observations

1. **Slot-advance pattern** (key-pool.ts:309-316): Atomic slot reservation before async wait is textbook thundering-herd prevention.
2. **H2 session stale-reference guard** (new): `record.session === thisSession` check is a clean fix for a subtle race condition.
3. **Process crash prevention** (new): Adding `error` handler on H2 sessions prevents GOAWAY from crashing the process.
4. **Conservative RPM limit**: 80% of documented limit (8 vs 10) provides safety margin.
5. **Fingerprint-based logging**: Never logs full tokens.
6. **Atomic persist with rename**: `writeFileSync` to `.tmp` then `renameSync` prevents corrupt state files.
7. **inFlight leak prevention**: `releaseKey()` in `finally` blocks ensures slots are always freed.
8. **Model tiering guards**: Multiple safety checks (iteration count, compaction, reasoning keywords, content history) prevent inappropriate downgrade.

### Recommended Actions (Prioritized)

1. **Fix suspendStrikes reset** -- Change line 334 from `record.suspendStrikes = 0` to `record.suspendStrikes = Math.max(0, record.suspendStrikes - 1)` or implement a consecutive-success counter.
2. **Simplify sort** -- Replace the confusing algebraic expression at lines 248 and 493.
3. **Remove redundant destroySession** -- In `client.ts:311` and `client.ts:498`, remove the `destroySession` call since `reportError()` already handles it for 403.

### Metrics

- Type Coverage: N/A (audit scope, not full project)
- Test Coverage: No unit tests found for key-pool.ts abuse prevention logic
- Linting Issues: 0 (TypeScript errors resolved in commit `24bc37d`)

### Unresolved Questions

1. **Missing key-pool tests**: There appear to be no automated tests for the backoff escalation, RPM window pruning, or user initiator budget logic. If these exist elsewhere, they were not in the audited files. Recommend adding tests for the oscillation scenario specifically.
2. **suspendStrikes persistence vs restart**: `suspendStrikes` is persisted to disk (`key-pool-state.json`). If the process restarts, strikes survive. But if a key was mid-cooldown, the cooldown timestamp also persists. A process restart during cooldown will correctly honor the remaining cooldown. Good.
