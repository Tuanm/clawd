# API Key Distribution & Rate Limiting for Multi-Agent GitHub Copilot Usage

**Date:** 2025-03-03  
**Context:** TypeScript/Bun server (`clawd`) running multiple concurrent AI agents against GitHub Copilot API  
**Current state:** Basic round-robin counter in `provider-config.ts` — no TTL tracking, no health scoring, no backoff on key selection

---

## 1. Per-Agent Key Assignment vs Global Round-Robin Rotation

### Per-Agent (Sticky) Assignment
Each agent gets one key for its lifetime (or session).

**Pros:**
- Stable, human-like usage pattern per key — one "user" doing consistent work
- Zero coordination overhead between agents
- Simplest mental model for debugging ("agent-3 always uses key-C")
- Natural cooldown when agent is idle

**Cons:**
- Uneven load if agents have different workloads (one agent hammers, others idle)
- Hot agent = hot key, no escape valve
- Key compromise or block takes out a specific agent permanently
- Wasted capacity when idle agents hold keys

### Global Round-Robin (Current)
Keys are picked from a pool per-request across all agents.

**Pros:**
- Natural load leveling across all keys
- Any agent can use any key, maximizing throughput

**Cons:**
- Consecutive requests from multiple agents may land on same key simultaneously — looks like burst traffic from one "user"
- A single 429 response doesn't tell you which key is hot
- Round-robin doesn't account for key health (uses a rate-limited key immediately after backing off)

### **Recommendation: Weighted Least-Recently-Used (LRU) + Health Score**
Neither pure sticky nor pure round-robin. Use a **key pool with health scoring**:
- Select the key with the **highest score** (score = combination of: time-since-last-use, request count in window, recent error rate)
- This naturally distributes load while avoiding hot keys
- Agents don't own keys; they borrow them from the pool for the duration of one request

---

## 2. Token Bucket vs Leaky Bucket

### Token Bucket
- Has capacity N tokens; tokens refill at rate R tokens/second
- A request consumes 1 token; if no tokens → wait or reject
- **Allows bursting** up to capacity N, then enforces average rate R
- Best for Copilot: mirrors real user behavior (type → think → type → burst)

### Leaky Bucket
- Requests enter a fixed-size queue; they exit at a fixed rate R
- No bursting — strict constant output rate
- Better for preventing abuse detection via strict metering

### **Recommendation: Token Bucket per key with conservative burst**
```typescript
interface TokenBucket {
  capacity: number;      // max burst (e.g., 5 for Copilot)
  tokens: number;        // current tokens
  refillRate: number;    // tokens per second (e.g., 0.5 = 1 req/2s)
  lastRefill: number;    // timestamp ms
}

function refill(bucket: TokenBucket): void {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillRate);
  bucket.lastRefill = now;
}

function tryConsume(bucket: TokenBucket): boolean {
  refill(bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

function timeUntilToken(bucket: TokenBucket): number {
  refill(bucket);
  if (bucket.tokens >= 1) return 0;
  return ((1 - bucket.tokens) / bucket.refillRate) * 1000; // ms
}
```

**Conservative settings for Copilot (no published limits):**
- capacity: 3 (allow small burst)
- refillRate: 0.2 tokens/s (1 request per 5 seconds per key, per agent)

---

## 3. Sliding Window Rate Limiter

Tracks exact timestamps of requests in a rolling window. More accurate than fixed windows.

```typescript
class SlidingWindowCounter {
  private timestamps: number[] = []; // sorted ascending

  constructor(
    private readonly windowMs: number,  // e.g., 60_000 for 60s
    private readonly limit: number       // max requests in window
  ) {}

  private evict(): void {
    const cutoff = Date.now() - this.windowMs;
    // Binary search would be faster but linear is fine for small arrays
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] < cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
  }

  count(): number {
    this.evict();
    return this.timestamps.length;
  }

  canRequest(): boolean {
    return this.count() < this.limit;
  }

  record(): void {
    this.timestamps.push(Date.now());
  }

  /** ms until oldest request expires and frees a slot */
  msUntilSlot(): number {
    this.evict();
    if (this.timestamps.length < this.limit) return 0;
    return this.timestamps[0] + this.windowMs - Date.now();
  }
}
```

**Use two windows per key:**
- `window60s`: 60-second window, limit ~10 requests (conservative)
- `window24h`: 24-hour window, limit ~500 requests (adjust based on plan)

---

## 4. Per-Key Request Counters with TTL (60s + 24h)

```typescript
interface KeyMetrics {
  // Sliding windows
  window60s: SlidingWindowCounter;   // track req/min
  window24h: SlidingWindowCounter;   // track req/day

  // Health signals
  lastUsedAt: number;                // ms timestamp
  lastErrorAt: number;               // ms timestamp, 0 if no errors
  consecutiveErrors: number;
  cooldownUntil: number;             // ms timestamp, 0 if not cooling

  // Backoff state
  backoffAttempt: number;            // current exponential backoff step
  backoffUntil: number;              // ms timestamp
}

function createKeyMetrics(): KeyMetrics {
  return {
    window60s: new SlidingWindowCounter(60_000, 10),
    window24h: new SlidingWindowCounter(86_400_000, 500),
    lastUsedAt: 0,
    lastErrorAt: 0,
    consecutiveErrors: 0,
    cooldownUntil: 0,
    backoffAttempt: 0,
    backoffUntil: 0,
  };
}
```

**Memory cost:** For 10 keys × 500 timestamps per 24h window = 5,000 numbers = ~40KB. Negligible.

**Cleanup:** Call `window60s.count()` and `window24h.count()` on any access (they self-evict).

---

## 5. Exponential Backoff Strategies for 429 / 403

### Full Jitter (recommended by AWS)
```typescript
function fullJitterDelay(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.random() * cap; // uniform random in [0, cap]
}
```

### Decorrelated Jitter (best for multi-agent scenarios)
Avoids thundering herd: each client tracks its own previous sleep.
```typescript
function decorrelatedJitter(prevSleep: number, baseMs = 1000, maxMs = 60_000): number {
  return Math.min(maxMs, Math.random() * (prevSleep * 3 - baseMs) + baseMs);
}
```

### **For 429 (Rate Limited):**
- Read `Retry-After` header if present — use it directly
- Otherwise: decorrelated jitter starting at 5s base, cap 120s
- Mark key in backoff; skip it for selection during backoff period
- Do NOT rotate to next key immediately on 429 — you'll hammer other keys too

### **For 403 (Forbidden / Abuse Detected):**
- 403 is more serious than 429 — likely token expired, revoked, or abuse flag
- Stop using key immediately; mark as `suspended`
- Log the key prefix for visibility; don't retry on same key for 1h+
- Check: is it an OAuth token expiry? Refresh token if possible

```typescript
function handleResponseError(
  key: string,
  metrics: KeyMetrics,
  status: number,
  retryAfterHeader?: string
): void {
  const now = Date.now();
  metrics.lastErrorAt = now;
  metrics.consecutiveErrors++;

  if (status === 429) {
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader) * 1000 : 0;
    const backoffMs = retryAfter || decorrelatedJitter(
      metrics.backoffAttempt > 0 ? 1000 * 2 ** (metrics.backoffAttempt - 1) : 1000,
      5_000,
      120_000
    );
    metrics.backoffUntil = now + backoffMs;
    metrics.backoffAttempt = Math.min(metrics.backoffAttempt + 1, 8);

  } else if (status === 403) {
    metrics.cooldownUntil = now + 3_600_000; // 1 hour hard cooldown
    metrics.backoffAttempt = 8; // max backoff
  }
}

function handleResponseSuccess(metrics: KeyMetrics): void {
  metrics.consecutiveErrors = 0;
  metrics.backoffAttempt = Math.max(0, metrics.backoffAttempt - 1); // decay on success
}
```

---

## 6. Request Queuing: Per-Key vs Global

### Per-Key Queue
- Each key has its own FIFO queue; requests are routed to a specific key upfront
- Simple; natural backpressure per key

**Problem:** If key A is rate-limited, its queue grows while key B is idle.

### Global Queue with Key Selection at Dequeue
- Single queue for all pending requests
- Dequeue picks the **best available key** at that moment

**This is the correct approach.** Analogy: a bank with multiple tellers — customers queue globally, not per-teller.

```typescript
class KeyPool {
  private keys: Map<string, KeyMetrics> = new Map();
  private queue: Array<{
    resolve: (key: string) => void;
    reject: (err: Error) => void;
    enqueuedAt: number;
  }> = [];

  addKey(key: string): void {
    this.keys.set(key, createKeyMetrics());
  }

  /** Try to acquire a key. Returns key string or null if none available. */
  tryAcquire(): string | null {
    const now = Date.now();
    let best: string | null = null;
    let bestScore = -Infinity;

    for (const [key, metrics] of this.keys) {
      if (metrics.backoffUntil > now) continue;
      if (metrics.cooldownUntil > now) continue;
      if (!metrics.window60s.canRequest()) continue;
      if (!metrics.window24h.canRequest()) continue;

      const score = this.scoreKey(metrics, now);
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }
    return best;
  }

  private scoreKey(metrics: KeyMetrics, now: number): number {
    const idleMs = now - metrics.lastUsedAt;
    const recentLoad = metrics.window60s.count();
    const errorPenalty = metrics.consecutiveErrors * 10;

    // Higher score = prefer this key
    return idleMs / 1000       // seconds idle (prefer more-rested keys)
      - recentLoad * 2         // penalize busy keys
      - errorPenalty;          // penalize errored keys
  }

  /** Acquire a key, waiting in queue if none available */
  async acquire(timeoutMs = 30_000): Promise<string> {
    const key = this.tryAcquire();
    if (key) {
      this.recordAcquire(key);
      return key;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter(e => e.resolve !== resolve);
        reject(new Error('Key pool timeout: no keys available'));
      }, timeoutMs);

      this.queue.push({
        resolve: (k) => { clearTimeout(timer); resolve(k); },
        reject,
        enqueuedAt: Date.now(),
      });
    });
  }

  private recordAcquire(key: string): void {
    const metrics = this.keys.get(key)!;
    metrics.lastUsedAt = Date.now();
    metrics.window60s.record();
    metrics.window24h.record();
  }

  /** Call after request completes (success or error) */
  release(key: string, status?: number, retryAfterHeader?: string): void {
    const metrics = this.keys.get(key);
    if (!metrics) return;

    if (status && (status === 429 || status === 403)) {
      handleResponseError(key, metrics, status, retryAfterHeader);
    } else if (status && status < 400) {
      handleResponseSuccess(metrics);
    }

    // Drain queue: check if any waiters can now be served
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const key = this.tryAcquire();
      if (!key) break; // Nothing available

      const waiter = this.queue.shift()!;
      this.recordAcquire(key);
      waiter.resolve(key);
    }
  }
}
```

---

## 7. Detecting a "Hot" Key and Cooling It Down

A key is "hot" if it has been used heavily in the recent window. Three signals:

| Signal | Threshold | Action |
|--------|-----------|--------|
| `window60s.count() > limit * 0.8` | 80% of 60s budget | Reduce score — deprioritize |
| `window60s.count() >= limit` | 100% of 60s budget | Block until window clears |
| `consecutiveErrors >= 3` | 3 consecutive failures | Force cooldown 5 min |
| `status === 429` received | Any | Set `backoffUntil` per §5 |
| `status === 403` received | Any | Set `cooldownUntil` = now + 1h |

**Proactive "pre-cool" pattern:**
```typescript
function isHot(metrics: KeyMetrics): boolean {
  const load = metrics.window60s.count();
  const capacity = metrics.window60s['limit']; // expose limit
  return load / capacity > 0.7; // >70% used = hot
}

// In scoreKey(), when isHot: apply additional penalty
// This naturally routes new requests to cooler keys
```

**Minimum spacing** (see §8) also serves as a passive cooldown.

---

## 8. Minimum Spacing Between Requests — Human-Like Behavior

GitHub's abuse detection looks for:
- Burst of identical-pattern requests
- No variation in inter-request timing
- Missing browser fingerprint headers (already handled by `BASE_HEADERS` in client.ts)
- Same key used from different IPs (if agents run in different containers)

**Recommended minimum spacing per key:**

| Scenario | Min spacing |
|----------|-------------|
| Single agent, single key | 3–5 seconds |
| Multiple agents, multiple keys | 2–3 seconds per key (not global) |
| After a 429 | Per backoff §5 (min 5s) |
| After long idle (>10 min) | Add 1–2s extra warmup delay |

```typescript
const MIN_SPACING_MS = 3_000; // 3 seconds between requests on same key
const JITTER_MS = 1_000;       // ±1s random jitter

function msUntilKeyReady(metrics: KeyMetrics): number {
  const now = Date.now();
  const sinceLastUse = now - metrics.lastUsedAt;
  const requiredSpacing = MIN_SPACING_MS + (Math.random() * JITTER_MS - JITTER_MS / 2);

  if (sinceLastUse < requiredSpacing) {
    return requiredSpacing - sinceLastUse;
  }
  return 0;
}
```

Add this check to `scoreKey()` or gate before `tryAcquire()` returns a key.

---

## Integration with Current Codebase

### Current State
`provider-config.ts` has:
```typescript
const keyRotationCounters: Partial<Record<ProviderType, number>> = {}; // simple counter
```
This is a round-robin counter with **no health tracking, no backoff, no spacing**.

### Recommended File: `src/agent/src/api/key-pool.ts`
Create a `KeyPool` class (from §6) that:
1. Initializes from `api_keys` array in config
2. Exposes `acquire()` / `release()` async API
3. Is a singleton per provider type

### Wire into `provider-config.ts`
Replace `getApiKeyForProvider()` and `getCopilotToken()` to use `KeyPool.acquire()` (async).

### Wire into `client.ts`
```typescript
// Before request:
const key = await keyPool.acquire();

// After response:
keyPool.release(key, response.status, response.headers['retry-after']);
```

The existing backoff in `client.ts` (lines 234–244, 315–329) should be replaced with pool-level backoff — the client should **not retry on same key** after 429; it should release and re-acquire (which will pick a different key or wait).

---

## Architecture Summary

```
┌──────────────────────────────────────────────┐
│                  KeyPool                       │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │  Key A  │  │  Key B  │  │  Key C  │       │
│  │ metrics │  │ metrics │  │ metrics │       │
│  │ buckets │  │ buckets │  │ buckets │       │
│  └─────────┘  └─────────┘  └─────────┘       │
│                                               │
│  Global FIFO Queue (waiters)                  │
│  [req1, req2, req3, ...]                      │
│                                               │
│  acquire() → score keys → return best         │
│  release(key, status) → update metrics        │
│                         → drain queue         │
└──────────────────────────────────────────────┘
         │
         ▼ per-request
┌─────────────────────┐
│    CopilotClient    │
│  (uses key for 1    │
│   request only)     │
└─────────────────────┘
```

---

## Recommended Settings (Conservative for Copilot)

```typescript
const COPILOT_KEY_POOL_CONFIG = {
  window60sLimit: 8,          // max 8 req/min per key (conservative)
  window24hLimit: 400,        // max 400 req/day per key
  minSpacingMs: 3_000,        // 3s between requests on same key
  jitterMs: 800,              // ±0.8s jitter
  backoffBaseMs: 5_000,       // 5s base for 429 backoff
  backoffMaxMs: 120_000,      // 2 min max backoff
  cooldownOn403Ms: 3_600_000, // 1h on 403
  acquireTimeoutMs: 30_000,   // 30s max queue wait
};
```

---

## Unresolved Questions

1. **GitHub Copilot actual limits** — No publicly documented rate limits for `api.githubcopilot.com`. The values above are conservative estimates. Need empirical testing or GitHub support confirmation.

2. **OAuth token expiry** — Copilot tokens (not PATs) expire; whether `getCopilotToken()` handles refresh is unclear from the codebase. The 403 handling should distinguish "revoked key" from "expired token" — the latter needs a refresh call, not a 1h cooldown.

3. **Cross-process key pool** — If `clawd` runs multiple OS processes (not just concurrent async agents in one process), the in-memory `KeyPool` won't coordinate. Needs SQLite or file-based coordination for multi-process scenarios.

4. **Per-model vs per-key limits** — Copilot may have separate limits per model (e.g., Claude Sonnet vs GPT-4o). The pool should potentially track per-key-per-model metrics.

5. **Abuse detection specifics** — Whether rotating keys across requests on the same IP triggers Copilot abuse detection is unknown. Per-agent sticky assignment may be safer if IP-based clustering is used by GitHub.
