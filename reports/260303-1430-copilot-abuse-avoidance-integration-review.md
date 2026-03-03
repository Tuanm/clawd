# Code Review: Copilot Abuse Avoidance Integration

**Date:** 2026-03-03  
**Scope:** Integration-only review  
**Files:** `key-pool.ts` (new), `provider-config.ts`, `client.ts`, `factory.ts`, `agent.ts`, `index.ts`, `subagent.ts`  
**Focus:** inFlight lifecycle, double-selectKey, factory path, restart persistence, selectKey sorting, checkCycleReset

---

## Summary

Six integration issues were investigated. Four are **confirmed bugs** of varying severity. Two are **confirmed correct** or minor. All confirmed bugs have concrete fixes below.

---

## Issue 1 — CONFIRMED CRITICAL: `getCopilotToken()` Permanently Leaks `inFlight`

### Root Cause

`getCopilotToken()` in `provider-config.ts:287` calls `keyPool.selectKey("agent")`, which atomically increments `inFlight` on the selected `KeyRecord`. The function discards the `KeyRecord` object and returns only the raw `token: string`. Since `inFlight` is only decremented by `keyPool.recordRequest()` or `keyPool.reportError()` — both of which are paired with actual HTTP requests — the increment from this path **is never reversed**.

### All Affected Call Sites

| File | Line | Call | Frequency |
|---|---|---|---|
| `factory.ts` | 134 | `createCopilotProvider()` | Once per agent start |
| `client.ts` | 255 | `complete()` initialToken | Once per non-streaming LLM call |
| `client.ts` | 376 | `stream()` initialToken | Once per streaming LLM call |
| `subagent.ts` | 262 | SubAgent constructor | Once per sub-agent spawn |
| `provider-config.ts` | 229 | `getApiKeyForProvider("copilot")` | Indirect — only if `providerType === "copilot"` |

Note: the three `getActiveApiKey()` calls in factory.ts at lines 195, 362, 700 (OpenAI/Anthropic/Ollama providers) do NOT route to `getCopilotToken()` — those providers are never constructed with `providerType: "copilot"`.

### Impact

With N requests, `inFlight` grows monotonically by N. Eventually:

```
filter((k) => rpm + k.inFlight < RPM_LIMIT)  // RPM_LIMIT = 8
```

This filter excludes all keys after just 8 leaked increments (one-key pool) or 8 × keyCount increments (multi-key pool). Once excluded, the fallback sort `available.sort((a, b) => a.inFlight - b.inFlight)[0]` still selects a key — so the system continues to **work** but the **RPM gate is permanently broken**. All requests bypass rate-limiting within minutes of first use.

### Fix

`getCopilotToken()` must not call `selectKey()`. It was designed as a "peek" to retrieve the token for pool initialization, not to book a slot. Replace the implementation:

```typescript
// provider-config.ts

/**
 * Get the API key for Copilot provider.
 * Does NOT increment inFlight — callers that make real HTTP requests must
 * call keyPool.selectKey(initiator) themselves.
 */
export function getCopilotToken(): string | null {
  ensureKeyPoolInitialized();

  try {
    // Peek at the best available key without booking a slot
    const available = keyPool.peekBestToken("agent");
    if (available) return available;
  } catch {
    // fall through
  }

  // Fallback: legacy single token from config (no KeyPool)
  const config = loadConfig();
  return config.providers?.copilot?.token || null;
}
```

Add a `peekBestToken()` method to `KeyPool` that returns the token of the best-healthy key without mutating `inFlight`:

```typescript
// key-pool.ts
peekBestToken(initiator: "agent" | "user"): string | null {
  if (!this.initialized || this.keys.length === 0) return null;
  const now = Date.now();
  const available = this.keys.filter(
    (k) => !k.permanent && k.cooldownUntil < now,
  );
  if (available.length === 0) return null;

  if (initiator === "user") {
    available.sort((a, b) =>
      (PREMIUM_LIMIT_PER_KEY - a.premiumUnitsUsedCycle) - (PREMIUM_LIMIT_PER_KEY - b.premiumUnitsUsedCycle)
        ? -1 : 1
    );
  } else {
    available.sort((a, b) => {
      const aLoad = a.window60s.filter(t => t > now - RPM_WINDOW_MS).length + a.inFlight;
      const bLoad = b.window60s.filter(t => t > now - RPM_WINDOW_MS).length + b.inFlight;
      return aLoad - bLoad;
    });
  }
  return available[0].token;
}
```

---

## Issue 2 — CONFIRMED CRITICAL: Double `selectKey` → Double `inFlight` in `client.ts`

### Root Cause

Both `complete()` and `stream()` perform **two independent** `selectKey` calls per invocation:

```typescript
// client.ts:255-263 (complete) and client.ts:376-383 (stream) — same pattern

const initialToken = getCopilotToken() || this.token;  // ← selectKey #1 (inside getCopilotToken)
let key = (() => {
  try {
    return keyPool.selectKey(initiator);               // ← selectKey #2
  } catch {
    return null;
  }
})();
```

When KeyPool IS available (the normal path): `initialToken` is computed (leaking one inFlight) but **never used** — the code proceeds with `key.token`. This means:

- inFlight is incremented **twice** on potentially two different keys
- Only ONE `recordRequest()` is called at the end → net **+1 permanent leak per request**

When KeyPool is NOT available (fallback path): `initialToken` from `getCopilotToken()` is used in `_completeOnce`/`_streamOnce`, but since KeyPool isn't available, the leaked inFlight from `getCopilotToken()` is on a record that `recordRequest()` can never find (wrong token or pool not init'd).

### Impact

Compounds Issue 1: every real HTTP request through `complete()` or `stream()` produces **two** `inFlight` leaks — one from `getCopilotToken()` (Issue 1) plus one from `keyPool.selectKey(initiator)` that is never decremented on the key that `getCopilotToken()` selected (which may differ from the key returned by `selectKey(initiator)` if the pool re-sorts between the two calls).

### Fix

After applying Issue 1's fix (`getCopilotToken()` no longer calls `selectKey`), the double-call is resolved structurally. Additionally, the `getCopilotToken()` call in `complete()`/`stream()` should be replaced with `ensureKeyPoolInitialized()` since its only remaining purpose there is to guarantee the pool is warmed up:

```typescript
// client.ts — complete()
async complete(
  request: CompletionRequest,
  initiator: "agent" | "user" = "agent",
): Promise<CompletionResponse> {
  // Ensure KeyPool is initialized (no longer calls selectKey)
  ensureKeyPoolInitialized();
  const fallbackToken = this.token;

  let key = (() => {
    try {
      return keyPool.selectKey(initiator); // only ONE selectKey
    } catch {
      return null;
    }
  })();

  if (!key) {
    return this._completeOnce(request, fallbackToken, initiator);
  }
  // ... rest unchanged
```

Export `ensureKeyPoolInitialized` from `provider-config.ts`, or inline the pool-init guard in `client.ts` directly.

---

## Issue 3 — CONFIRMED HIGH: `factory.ts` `createCopilotProvider()` Leaks One `inFlight` at Construction Time

### Root Cause

`createCopilotProvider()` in `factory.ts:134` calls `getCopilotToken()` at construction time — before any HTTP request is made — purely to pass a `token: string` to the `CopilotClient` constructor:

```typescript
function createCopilotProvider(modelOverride?: string): LLMProvider {
  const token = getCopilotToken();           // ← selectKey → inFlight++ (never decremented)
  const model = modelOverride || getModelForProvider("copilot");
  const baseUrl = getBaseUrlForProvider("copilot") || "https://api.githubcopilot.com";
  return new CopilotClient(token || "", { model, baseUrl });
}
```

The same pattern exists in `subagent.ts:262`.

This is a **construction-time** leak distinct from the per-request leaks in Issue 2. Each agent start and each sub-agent spawn permanently consumes one `inFlight` unit on the most-available key.

### Impact

With 8 agents: 8 leaked inFlight at startup. Combined with Issue 2's per-request leaks, the pool's RPM gate degrades to effectively useless within the first minute of operation.

### Fix

After applying Issue 1's fix, `getCopilotToken()` becomes safe to call (no `selectKey` side effect). `createCopilotProvider()` and the subagent constructor require no further changes beyond the Issue 1 fix. The stored `token` in `CopilotClient` is a valid fallback token, not a booked slot.

However, the stored `token` in `CopilotClient` will go stale if key rotation occurs (a suspended key is replaced). The `complete()`/`stream()` methods already handle this via `keyPool.selectKey(initiator)` — the stored `this.token` is only used in the no-KeyPool fallback path, which is acceptable.

---

## Issue 4 — CONFIRMED (MINOR): `checkCycleReset()` Daily Reset Fires Every 60 Seconds

### Root Cause

The daily reset condition compares `key.billingCycleStart` (the 1st of the current month) against `todayStart` (today at midnight UTC):

```typescript
// key-pool.ts:617-621
const todayStart = new Date();
todayStart.setUTCHours(0, 0, 0, 0);
if (key.billingCycleStart < todayStart.getTime()) {
  key.premiumUnitsUsedToday = 0;
}
```

`billingCycleStart` is always the 1st of the current month (e.g., `2026-03-01T00:00:00Z`). On any day after the 1st, `todayStart` (e.g., `2026-03-15T00:00:00Z`) is always **greater** than `billingCycleStart`. The condition is permanently `true` for the entire month except on the 1st itself.

Result: `premiumUnitsUsedToday` is silently zeroed every 60 seconds for 29 or 30 days per month. The daily budget cap in `canUserRequest()` is completely ineffective.

The comment in the code (`"reset today's counter if last cycle start was before today's midnight UTC"`) reveals the original design intent was to use `billingCycleStart` as a proxy for "last daily reset" — but `billingCycleStart` is overwritten with the monthly value in the block just above, making this impossible.

### Fix

Add a dedicated `lastDailyResetAt: number` field to `KeyRecord` and `PersistedKeyState`:

```typescript
// key-pool.ts — KeyRecord interface
interface KeyRecord {
  // ... existing fields ...
  lastDailyResetAt: number;  // epoch ms of last premiumUnitsUsedToday reset (midnight UTC)
}

// init() — new key default
{
  // ...
  lastDailyResetAt: this.todayStartMs(),
}

// checkCycleReset() — fixed daily logic
private checkCycleReset(): void {
  const cycleStart = this.currentCycleStart();
  const todayStart = this.todayStartMs();

  for (const key of this.keys) {
    // Monthly reset
    if (key.billingCycleStart < cycleStart) {
      key.premiumUnitsUsedCycle = 0;
      key.cycleQuotaFromApi = null;
      key.billingCycleStart = cycleStart;
      key.premiumUnitsUsedToday = 0;          // also reset daily on new cycle
      key.lastDailyResetAt = todayStart;
      console.log(`[KEY POOL] key=${key.fingerprint} monthly cycle reset`);
    }
    // Daily reset — only if we haven't already reset today
    else if (key.lastDailyResetAt < todayStart) {
      key.premiumUnitsUsedToday = 0;
      key.lastDailyResetAt = todayStart;
      console.log(`[KEY POOL] key=${key.fingerprint} daily counter reset`);
    }
  }
}

private todayStartMs(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
```

Persist `lastDailyResetAt` alongside the other fields in `PersistedKeyState` and restore it in `restore()`.

---

## Issue 5 — CONFIRMED CORRECT: `selectKey` Sort Logic and Multi-Agent Concurrency

The concern about sorting correctness and off-by-one issues under 8 concurrent agents is **not a bug**.

JavaScript is single-threaded. All 8 `selectKey("agent")` calls dispatched in the same async "turn" execute serially in the same microtask/macrotask. Each call sees the `inFlight` value already incremented by all prior calls in the sequence:

```
Call 1: key A → inFlight=0 → selects A → inFlight=1
Call 2: key A → inFlight=1 → selects A → inFlight=2  (if A still best)
...
Call 9: key A → inFlight=8 → filtered out (RPM_LIMIT=8) → fallback
```

The `available.sort()` call mutates the locally-filtered `available` array (not `this.keys`), which is safe. The fallback `available.sort((a, b) => a.inFlight - b.inFlight)[0]` after the filtered-sort path also operates on the same local array. No off-by-one.

One stylistic note: the in-place `.sort()` on `available` in the `initiator === "user"` branch overwrites the array order, meaning the `available` variable is no longer sorted by insertion order if referenced again — but it is not referenced again in that branch, so this is harmless.

---

## Issue 6 — CONFIRMED CORRECT (with qualification): Process Restart Persistence

`keyPool.init()` is called lazily via `ensureKeyPoolInitialized()` inside `getCopilotToken()`. On restart:

1. `keyPool` singleton starts fresh (`keys = []`, `initialized = false`)
2. First call to `getCopilotToken()` → `ensureKeyPoolInitialized()` → `keyPool.init(tokens)` → `restore()`
3. `restore()` matches persisted `KeyRecord`s by **fingerprint** (not raw token) and rehydrates health state
4. Periodic timers (persist, quota sync) are registered once inside `init()`

**This path is correct.** State is reliably restored.

**Minor qualifying issue:** `index.ts` imports `keyPool` directly for two endpoints:
- `GET /api/copilot/keys` → `keyPool.getStatus()` (line 538)
- `POST /api/copilot/sync` → `keyPool.syncAllQuotas()` (line 541)

If either endpoint is called before any agent has made a request (i.e., before `getCopilotToken()` is ever called), `keyPool` is not yet initialized (`keys = []`). `getStatus()` returns `[]` (harmless but confusing). `syncAllQuotas()` iterates `this.keys` which is empty and silently no-ops — quota data remains stale until an agent request triggers init.

**Fix:** Call `ensureKeyPoolInitialized()` (exported from `provider-config.ts`) early in `index.ts` startup, after the config is loaded but before the HTTP server starts accepting connections. This eliminates the lazy-init race:

```typescript
// index.ts — after loadConfig() and validateConfig()
import { ensureKeyPoolInitialized } from "./agent/src/api/provider-config";
ensureKeyPoolInitialized(); // warm up KeyPool before first request
```

---

## Prioritized Action List

| # | Issue | Severity | Effort |
|---|---|---|---|
| 1 | Remove `selectKey` from `getCopilotToken()`; add `peekBestToken()` | **Critical** | ~1h |
| 2 | Remove `getCopilotToken()` call from `complete()`/`stream()`; replace with `ensureKeyPoolInitialized()` | **Critical** | 30min |
| 3 | `factory.ts` / `subagent.ts` are fixed by Issue 1 automatically | — | — |
| 4 | Fix `checkCycleReset()` daily logic with `lastDailyResetAt` field | **High** | ~1h |
| 5 | Eager `ensureKeyPoolInitialized()` call in `index.ts` startup | **Low** | 5min |

Issues 1 + 2 together eliminate all `inFlight` corruption. Issue 4 is independent and must be fixed to make the daily premium budget meaningful. Issue 5 is a one-liner quality-of-life improvement.

---

## Metrics

- Confirmed critical bugs: **2** (inFlight leak, double selectKey)
- Confirmed high bugs: **1** (daily reset fires continuously)
- Confirmed correct: **2** (sort/concurrency logic, restart persistence)
- Minor: **1** (eager init in index.ts)
- Files requiring changes: `key-pool.ts`, `provider-config.ts`, `client.ts`, `index.ts`
