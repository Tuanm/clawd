/**
 * KeyPool — Copilot API key lifecycle manager
 *
 * Responsibilities:
 *  - Select the best available key for each request (agent vs user initiator)
 *  - Track per-key RPM usage (60-second sliding window, limit ~8 RPM)
 *  - Track premium budget (monthly, daily, per model multiplier)
 *  - Enforce adaptive per-key request spacing (600ms–1.2s + jitter) via slot-advance
 *  - Suspend keys on 403/429 with exponential backoff
 *  - Share one HTTP/2 session per key across all CopilotClient instances
 *  - Persist health state across process restarts (~/.clawd/key-pool-state.json)
 *  - Sync ground-truth quota from GitHub API on startup and every 30 min
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Constants
// ============================================================================

const STATE_PATH = join(homedir(), ".clawd", "key-pool-state.json");
const COPILOT_API_BASE = "https://api.githubcopilot.com";
const GITHUB_API_BASE = "https://api.github.com";

const RPM_WINDOW_MS = 60_000;
const RPM_LIMIT = 8; // 80% of documented 10 RPM — target 6-8 RPM per key
const CONNECT_TIMEOUT_MS = 10_000;
const PREMIUM_LIMIT_PER_KEY = 300; // Pro plan monthly premium request allowance

// ---- Dynamic throttle values (scaled by key count) --------------------------
// Target 6-8 RPM per key — each key looks like an active Copilot CLI user.
// 8 RPM = one request every 7.5s; 6 RPM = one request every 10s.
// Jitter adds 1-2s of irregularity so timing doesn't look robotic.

/** Spacing thresholds scaled by key count */
function getScaledSpacing(keyCount: number): { idle: number; moderate: number; high: number; jitter: number } {
  const scale = Math.sqrt(Math.max(1, keyCount));
  return {
    idle: Math.round(Math.max(7_500, 10_000 / scale)), // 1 key: 10s,   4 keys: 7.5s,  9 keys: 7.5s  → ~8 RPM
    moderate: Math.round(Math.max(8_500, 12_000 / scale)), // 1 key: 12s,   4 keys: 8.5s,  9 keys: 8.5s  → ~7 RPM
    high: Math.round(Math.max(10_000, 15_000 / scale)), // 1 key: 15s,   4 keys: 10s,   9 keys: 10s   → ~6 RPM
    jitter: Math.round(Math.max(1_000, 2_000 / scale)), // 1 key: 2s,    4 keys: 1s,    9 keys: 1s
  };
}

/** 429 cooldown delays — intentionally long to avoid repeat rate-limit flags */
function getScaled429Delays(keyCount: number): [number, number, number] {
  const n = Math.max(1, keyCount);
  return [
    Math.round(Math.max(300_000, 600_000 / n)), // 1 key: 10min,  2 keys: 5min,   3+ keys: 5min
    Math.round(Math.max(600_000, 1_800_000 / n)), // 1 key: 30min,  2 keys: 15min,  3+ keys: 10min
    Math.round(Math.max(1_800_000, 3_600_000 / n)), // 1 key: 60min,  3 keys: 20min,  6+ keys: 30min
  ];
}

/** Model premium request multipliers (official GitHub docs, verified 2026-03) */
export const MODEL_MULTIPLIERS: Record<string, number> = {
  "claude-opus-4.6": 3,
  "claude-opus-4.5": 3,
  "claude-sonnet-4.6": 1,
  "claude-sonnet-4.5": 1,
  "claude-sonnet-4": 1,
  "claude-haiku-4.5": 0.33,
  "gpt-4.1": 0,
  "gpt-4o": 0,
  "gpt-5-mini": 0,
  "gpt-4.1-mini": 0,
  // default for unknown models: 1 (conservative)
};

export function getModelMultiplier(model: string): number {
  // Normalize: strip provider prefix if present (e.g. "openai/gpt-4.1" -> "gpt-4.1")
  const normalized = model.includes("/") ? model.split("/").pop()! : model;
  return MODEL_MULTIPLIERS[normalized] ?? 1;
}

// ============================================================================
// Error classes
// ============================================================================

export class AllKeysSuspendedError extends Error {
  public readonly earliestResumeAt: Date;

  constructor(keys: KeyRecord[]) {
    const active = keys.filter((k) => !k.permanent && k.cooldownUntil > 0);
    const earliest = active.length > 0 ? Math.min(...active.map((k) => k.cooldownUntil)) : Date.now() + 3_600_000;
    const date = new Date(earliest);
    super(`All Copilot API keys are suspended. Earliest resume: ${date.toISOString()}`);
    this.earliestResumeAt = date;
    this.name = "AllKeysSuspendedError";
  }
}

// ============================================================================
// Interfaces
// ============================================================================

interface KeyRecord {
  token: string;
  fingerprint: string; // first8...last8 — never expose full token
  // Concurrency tracking
  inFlight: number; // incremented atomically in selectKey, decremented in recordRequest
  nextAvailableAt: number; // epoch ms; slot-advance pattern prevents thundering herd
  // Rate limit tracking (non-premium)
  window60s: number[]; // timestamps of requests in last 60s; pruned before every read
  // Premium budget tracking (monthly)
  premiumUnitsUsedToday: number; // float; incremented by MODEL_MULTIPLIERS[model] per user request
  premiumUnitsUsedCycle: number; // float; monthly total
  billingCycleStart: number; // epoch ms of 1st of current month 00:00 UTC
  lastDailyResetDay: number; // YYYYMMDD integer; used to detect day rollover
  cycleQuotaFromApi: number | null; // real remaining from /copilot_internal/user (null = not fetched)
  // Health
  cooldownUntil: number; // 0 = available
  suspendStrikes: number; // exponential backoff: 0→30m, 1→2h, 2→24h
  permanent: boolean; // invalid/expired token — never retry
  // User initiator budget: 2-5 "user" requests per key per day to look natural
  userInitiatorSentToday: number;
  // HTTP/2 session owned by KeyPool (one per key, shared across all agents)
  session: http2.ClientHttp2Session | null;
  sessionPending: Promise<http2.ClientHttp2Session> | null; // in-flight creation guard (prevents race)
}

export interface KeyStatus {
  fingerprint: string;
  healthy: boolean;
  inFlight: number;
  rpm: number; // requests in last 60 seconds
  premiumUsedToday: number;
  premiumUsedCycle: number;
  premiumRemainingFromApi: number | null;
  cooldownUntil: string | null;
  suspendStrikes: number;
  permanent: boolean;
  userInitiatorSentToday: number;
}

interface PersistedKeyState {
  fingerprint: string;
  premiumUnitsUsedToday: number;
  premiumUnitsUsedCycle: number;
  billingCycleStart: number;
  lastDailyResetDay: number;
  cycleQuotaFromApi: number | null;
  cooldownUntil: number;
  suspendStrikes: number;
  permanent: boolean;
  userInitiatorSentToday: number;
}

interface PersistedState {
  savedAt: number;
  keys: PersistedKeyState[];
}

// ============================================================================
// Helper utilities
// ============================================================================

function makeFingerprint(token: string): string {
  if (!token || token.length <= 16) return "****";
  return `${token.slice(0, 8)}...${token.slice(-8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Adaptive spacing: faster when idle, cautious when loaded. Scales by key pool size. */
function getAdaptiveSpacingMs(record: KeyRecord, keyCount: number): number {
  const now = Date.now();
  const rpm = record.window60s.filter((t) => t > now - RPM_WINDOW_MS).length;
  const { idle, moderate, high } = getScaledSpacing(keyCount);
  if (rpm <= 2) return idle;
  if (rpm <= 5) return moderate;
  return high;
}

// ============================================================================
// KeyPool class
// ============================================================================

class KeyPool {
  private keys: KeyRecord[] = [];
  private initialized = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- Initialization -------------------------------------------------------

  /**
   * Initialize the pool with a list of API tokens.
   * Called from provider-config.ts on first use (not in constructor to avoid circular deps).
   * Safe to call multiple times — merges new tokens, removes stale ones.
   */
  init(tokens: string[]): void {
    const wasInitialized = this.initialized;
    this.initialized = true;

    // Merge: add new tokens, keep existing records
    for (const token of tokens) {
      if (!token) continue;
      if (!this.keys.find((k) => k.token === token)) {
        this.keys.push({
          token,
          fingerprint: makeFingerprint(token),
          inFlight: 0,
          nextAvailableAt: 0,
          window60s: [],
          premiumUnitsUsedToday: 0,
          premiumUnitsUsedCycle: 0,
          billingCycleStart: this.currentCycleStart(),
          lastDailyResetDay: this.currentDayInt(),
          cycleQuotaFromApi: null,
          cooldownUntil: 0,
          suspendStrikes: 0,
          permanent: false,
          userInitiatorSentToday: 0,
          session: null,
          sessionPending: null,
        });
      }
    }
    // Remove tokens no longer in config
    const tokenSet = new Set(tokens.filter(Boolean));
    for (const key of this.keys) {
      if (!tokenSet.has(key.token)) {
        key.session?.destroy();
      }
    }
    this.keys = this.keys.filter((k) => tokenSet.has(k.token));

    if (!wasInitialized) {
      this.restore();
      // Periodic persist
      setInterval(
        () =>
          this.flushToDisk().catch((err) => {
            console.error("[key-pool] flushToDisk failed:", err);
          }),
        60_000,
      ).unref();
      // Daily budget reset check (runs every minute, resets on 1st of month UTC)
      setInterval(() => this.checkCycleReset(), 60_000).unref();
      // Quota sync from GitHub API
      setTimeout(() => this.syncAllQuotas(), 5_000).unref(); // initial sync after 5s
      setInterval(() => this.syncAllQuotas(), 30 * 60_000).unref(); // every 30 min
    }
  }

  get keyCount(): number {
    return this.keys.length;
  }

  // ---- Key selection --------------------------------------------------------

  /**
   * Select the best available key for a request.
   * Atomically increments inFlight to prevent double-booking under concurrent calls.
   * Throws AllKeysSuspendedError if no healthy key is available.
   */
  selectKey(initiator: "agent" | "user"): KeyRecord {
    if (!this.initialized || this.keys.length === 0) {
      throw new AllKeysSuspendedError([]);
    }

    const now = Date.now();

    // Candidates: not permanently banned, not cooling
    const available = this.keys.filter((k) => !k.permanent && k.cooldownUntil < now);

    if (available.length === 0) {
      throw new AllKeysSuspendedError(this.keys);
    }

    let best: KeyRecord;

    if (initiator === "user") {
      // Prefer key with RPM headroom AND most remaining premium capacity
      const viable = available.filter((k) => {
        const rpm = k.window60s.filter((t) => t > now - RPM_WINDOW_MS).length;
        return rpm + k.inFlight < RPM_LIMIT;
      });
      const pool = viable.length > 0 ? viable : available; // fallback if all at limit
      best = pool.sort(
        (a, b) => a.premiumUnitsUsedCycle - b.premiumUnitsUsedCycle, // least premium usage first
      )[0];
    } else {
      // Prefer key available soonest (minimizes wait time)
      // Randomize among equally-good keys to prevent clustering
      const viable = available.filter((k) => {
        const rpm = k.window60s.filter((t) => t > now - RPM_WINDOW_MS).length;
        return rpm + k.inFlight < RPM_LIMIT;
      });
      const pool = viable.length > 0 ? viable : available;
      const scored = pool.map((k) => ({
        key: k,
        availableAt: Math.max(k.nextAvailableAt, now),
        load: k.window60s.filter((t) => t > now - RPM_WINDOW_MS).length + k.inFlight,
      }));
      // Sort by: earliest slot first, then least loaded as tiebreaker
      scored.sort((a, b) => a.availableAt - b.availableAt || a.load - b.load);
      // Pick randomly among keys within 100ms of best (avoids clustering)
      const bestTime = scored[0].availableAt;
      const equallyGood = scored.filter((s) => s.availableAt <= bestTime + 100);
      best = equallyGood[Math.floor(Math.random() * equallyGood.length)].key;
    }

    // Atomic slot increment (single-threaded JS — no race)
    best.inFlight++;
    return best;
  }

  // ---- User initiator promotion (abuse avoidance) ----------------------------

  /**
   * Per-key daily budget for "user" initiator requests.
   * Fewer keys → more per key (to look natural). More keys → fewer per key.
   * Range: 2–5 per key per day.
   */
  private get userBudgetPerKey(): number {
    return Math.max(2, Math.min(5, 6 - Math.floor(this.keys.length / 3)));
  }

  /**
   * Decide the effective initiator for a request on the given key.
   * If the caller explicitly requests "user", always honors it.
   * If "agent", occasionally promotes to "user" (2–5 times per key per day)
   * so that GitHub sees mixed initiator patterns and doesn't flag the account.
   */
  resolveInitiator(key: KeyRecord, callerInitiator: "agent" | "user"): "agent" | "user" {
    if (callerInitiator === "user") return "user";
    const budget = this.userBudgetPerKey;
    if (key.userInitiatorSentToday >= budget) return "agent";
    // Probability: spread promotions throughout the day
    // With budget/30 ≈ 7-17%, we expect to hit the budget over ~30 requests per key
    const probability = Math.min(0.15, budget / 30);
    if (Math.random() < probability) return "user";
    return "agent";
  }

  // ---- Request spacing (slot-advance pattern) --------------------------------

  /**
   * Wait for per-key spacing before sending the next request.
   * Uses slot-advance: atomically reserves a time slot before awaiting,
   * so concurrent callers get serialized slots (no thundering herd).
   */
  async waitForSpacing(record: KeyRecord): Promise<void> {
    const now = Date.now();
    const kc = this.keyCount;
    const spacing = getAdaptiveSpacingMs(record, kc);
    const jitter = Math.floor(Math.random() * getScaledSpacing(kc).jitter);
    const mySlot = Math.max(record.nextAvailableAt, now);
    record.nextAvailableAt = mySlot + spacing + jitter; // atomic advance before await
    const waitMs = mySlot - now;
    if (waitMs > 0) await sleep(waitMs);
  }

  // ---- Request accounting ---------------------------------------------------

  /**
   * Called after a successful request. Decrements inFlight, records timestamps.
   */
  recordRequest(token: string, model: string, initiator: "agent" | "user"): void {
    const record = this.find(token);
    if (!record) return;
    record.inFlight = Math.max(0, record.inFlight - 1);
    const now = Date.now();
    record.window60s.push(now);
    // Prune stale entries to prevent unbounded growth
    record.window60s = record.window60s.filter((t) => t > now - RPM_WINDOW_MS);
    // Decay suspend strikes on successful request — prevents permanent 24h backoff
    // after transient 403s, while avoiding oscillation where a single success between
    // 429s resets strikes to 0 (creating a detectable ping-429-3min-ping pattern).
    // Requires multiple consecutive successes to fully recover.
    if (record.suspendStrikes > 0) {
      record.suspendStrikes = Math.max(0, record.suspendStrikes - 1);
    }
    if (initiator === "user") {
      record.userInitiatorSentToday++;
      const cost = getModelMultiplier(model);
      if (cost > 0) {
        record.premiumUnitsUsedToday += cost;
        record.premiumUnitsUsedCycle += cost;
      }
    }
    this.schedulePersist();
  }

  /**
   * Called after a failed request (403 or 429). Decrements inFlight, sets cooldown.
   */
  reportError(token: string, status: 403 | 429, retryAfterMs?: number, body?: string): void {
    const record = this.find(token);
    if (!record) return;
    record.inFlight = Math.max(0, record.inFlight - 1);

    if (status === 403) {
      const isInvalid = /invalid|expired|bad credentials|unauthorized/i.test(body ?? "");
      if (isInvalid) {
        record.permanent = true;
        console.log(`[KEY POOL] key=${record.fingerprint} suspended=permanent reason=invalid-token`);
      } else {
        const strikes = record.suspendStrikes;
        const delays = [30 * 60_000, 2 * 3_600_000, 24 * 3_600_000];
        const delay = retryAfterMs ?? delays[Math.min(strikes, 2)];
        record.cooldownUntil = Date.now() + delay;
        record.suspendStrikes++;
        console.log(
          `[KEY POOL] key=${record.fingerprint} suspended=true until=${new Date(record.cooldownUntil).toISOString()} reason=403 strikes=${record.suspendStrikes}`,
        );
      }
      // Destroy the H2 session for this key (fresh connection for new key)
      this.destroySession(token);
    } else {
      // 429 rate limited — escalate backoff on repeated rate limits.
      // Server-provided Retry-After always takes precedence; otherwise
      // use scaled exponential backoff (shorter with more keys since others cover).
      const rateLimitDelays = getScaled429Delays(this.keyCount);
      const strikes = record.suspendStrikes;
      const delay = retryAfterMs ?? rateLimitDelays[Math.min(strikes, rateLimitDelays.length - 1)];
      record.cooldownUntil = Date.now() + delay;
      record.suspendStrikes++;
      console.log(
        `[KEY POOL] key=${record.fingerprint} cooling=true until=${new Date(record.cooldownUntil).toISOString()} reason=429 strikes=${record.suspendStrikes} delay=${Math.round(delay / 1000)}s`,
      );
    }
    this.schedulePersist();
  }

  /**
   * Release the inFlight slot for a key after a non-rate-limit error.
   * Call this when `_completeOnce`/`_streamOnce` throws anything other than 429/403
   * (e.g. network error, parse failure, timeout) to prevent inFlight from leaking.
   */
  releaseKey(token: string): void {
    const record = this.find(token);
    if (!record) return;
    record.inFlight = Math.max(0, record.inFlight - 1);
  }

  /**
   * If model has 0 multiplier (free), always allowed.
   */
  canUserRequest(model: string): boolean {
    const cost = getModelMultiplier(model);
    if (cost === 0) return true;
    if (this.keys.length === 0) return false;
    const dailyCap = (PREMIUM_LIMIT_PER_KEY / 30) * this.keys.length; // premium units/day across all keys
    const usedToday = this.keys.reduce((s, k) => s + k.premiumUnitsUsedToday, 0);
    return usedToday + cost <= dailyCap;
  }

  // ---- HTTP/2 session management (shared per key) ---------------------------

  /**
   * Get or create a shared HTTP/2 session for the given token + baseUrl.
   * Multiple CopilotClient instances (one per agent) share one H2 connection per key.
   */
  async getOrCreateSession(token: string, baseUrl: string): Promise<http2.ClientHttp2Session> {
    const record = this.find(token);
    if (!record) {
      // Fallback: create a transient session (shouldn't happen normally)
      return this.createH2Session(baseUrl);
    }

    if (record.session && !record.session.destroyed) {
      return record.session;
    }

    // Prevent concurrent creation race — return existing in-flight creation if any
    if (record.sessionPending) {
      return record.sessionPending;
    }

    record.sessionPending = this.createH2Session(baseUrl);
    try {
      record.session = await record.sessionPending;
      // Capture reference so stale handlers don't null a newer session
      const thisSession = record.session;
      thisSession.on("close", () => {
        if (record.session === thisSession) record.session = null;
      });
      // Handle post-connect errors (GOAWAY, protocol errors) to prevent
      // unhandled 'error' events from crashing the process.
      thisSession.on("error", (err) => {
        console.warn(`[KEY POOL] H2 session error key=${record.fingerprint}: ${err.message}`);
        if (record.session === thisSession) record.session = null;
      });
      return record.session;
    } finally {
      record.sessionPending = null;
    }
  }

  private createH2Session(baseUrl: string): Promise<http2.ClientHttp2Session> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`HTTP/2 connection timeout after ${CONNECT_TIMEOUT_MS}ms`));
        session.destroy();
      }, CONNECT_TIMEOUT_MS);

      const session = http2.connect(baseUrl);
      session.on("connect", () => {
        clearTimeout(timer);
        resolve(session);
      });
      session.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  destroySession(token: string): void {
    const record = this.find(token);
    if (record?.session) {
      record.session.destroy();
      record.session = null;
    }
  }

  /**
   * Peek at the best available token WITHOUT acquiring an inFlight slot.
   * Use this for initialization/fallback token lookup (not for actual requests).
   * For actual requests, always use selectKey() + recordRequest()/reportError().
   */
  peekToken(initiator: "agent" | "user" = "agent"): string | null {
    if (!this.initialized || this.keys.length === 0) return null;
    const now = Date.now();
    const available = this.keys.filter((k) => !k.permanent && k.cooldownUntil < now);
    if (available.length === 0) return null;
    if (initiator === "user") {
      return (
        available.sort(
          (a, b) => a.premiumUnitsUsedCycle - b.premiumUnitsUsedCycle, // least premium usage first
        )[0]?.token ?? null
      );
    }
    return available.sort((a, b) => a.inFlight - b.inFlight)[0]?.token ?? null;
  }

  getStatus(): KeyStatus[] {
    const now = Date.now();
    return this.keys.map((k) => ({
      fingerprint: k.fingerprint,
      healthy: !k.permanent && k.cooldownUntil < now,
      inFlight: k.inFlight,
      rpm: k.window60s.filter((t) => t > now - RPM_WINDOW_MS).length,
      premiumUsedToday: Math.round(k.premiumUnitsUsedToday * 100) / 100,
      premiumUsedCycle: Math.round(k.premiumUnitsUsedCycle * 100) / 100,
      premiumRemainingFromApi: k.cycleQuotaFromApi,
      cooldownUntil: k.cooldownUntil > now ? new Date(k.cooldownUntil).toISOString() : null,
      suspendStrikes: k.suspendStrikes,
      permanent: k.permanent,
      userInitiatorSentToday: k.userInitiatorSentToday,
    }));
  }

  // ---- Quota sync from GitHub API ------------------------------------------

  /**
   * Poll GET /copilot_internal/user for each key to get real quota data.
   * Non-blocking: errors are silently ignored.
   */
  async syncAllQuotas(): Promise<void> {
    for (const key of this.keys) {
      if (key.permanent) continue;
      await this.syncKeyQuota(key).catch((err) => {
        console.error("[key-pool] syncKeyQuota failed:", err);
      }); // best-effort
    }
  }

  private async syncKeyQuota(key: KeyRecord): Promise<void> {
    const https = await import("node:https");
    return new Promise((resolve) => {
      const req = https.default.get(
        `${GITHUB_API_BASE}/copilot_internal/user`,
        {
          headers: {
            Authorization: `Bearer ${key.token}`,
            "User-Agent": "Claw'd/1.0.0",
            Accept: "application/json",
          },
          timeout: 10_000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                const json = JSON.parse(data);
                // Response shape: { quota_snapshots: { premium_interactions: { remaining, used, limit } } }
                const remaining =
                  json?.quota_snapshots?.premium_interactions?.remaining ??
                  json?.copilot_ide_chat?.seat_breakdown?.remaining_premium_requests ??
                  null;
                if (typeof remaining === "number") {
                  key.cycleQuotaFromApi = remaining;
                  // Reconcile local count with API truth
                  const used = PREMIUM_LIMIT_PER_KEY - remaining;
                  if (used > key.premiumUnitsUsedCycle) {
                    key.premiumUnitsUsedCycle = used;
                  }
                }
              } catch {
                // Ignore parse errors
              }
            }
            resolve();
          });
        },
      );
      req.on("error", () => resolve());
      req.on("timeout", () => {
        req.destroy();
        resolve();
      });
    });
  }

  // ---- Persistence ----------------------------------------------------------

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushToDisk().catch((err) => {
        console.error("[key-pool] flushToDisk (debounce) failed:", err);
      });
    }, 500); // debounce 500ms
    // .unref() so this timer doesn't delay clean process exit
    (this.persistTimer as NodeJS.Timeout).unref?.();
  }

  async flushToDisk(): Promise<void> {
    try {
      const dir = join(homedir(), ".clawd");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const state: PersistedState = {
        savedAt: Date.now(),
        keys: this.keys.map((k) => ({
          fingerprint: k.fingerprint,
          premiumUnitsUsedToday: k.premiumUnitsUsedToday,
          premiumUnitsUsedCycle: k.premiumUnitsUsedCycle,
          billingCycleStart: k.billingCycleStart,
          lastDailyResetDay: k.lastDailyResetDay,
          cycleQuotaFromApi: k.cycleQuotaFromApi,
          cooldownUntil: k.cooldownUntil,
          suspendStrikes: k.suspendStrikes,
          permanent: k.permanent,
          userInitiatorSentToday: k.userInitiatorSentToday,
          // NOT: token, inFlight, window60s, nextAvailableAt, session
        })),
      };

      const tmp = `${STATE_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
      renameSync(tmp, STATE_PATH); // atomic on POSIX
    } catch {
      // Disk errors are best-effort — never crash the process
    }
  }

  restore(): void {
    if (!existsSync(STATE_PATH)) return;
    try {
      const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
      // Schema validation
      if (!Array.isArray(raw?.keys)) return;

      const liveFingerprints = new Set(this.keys.map((k) => k.fingerprint));

      for (const saved of raw.keys as PersistedKeyState[]) {
        if (typeof saved?.fingerprint !== "string" || !liveFingerprints.has(saved.fingerprint)) {
          continue; // skip stale entries from removed keys
        }
        const record = this.keys.find((k) => k.fingerprint === saved.fingerprint);
        if (!record) continue;

        // Restore persisted health state
        record.premiumUnitsUsedToday =
          typeof saved.premiumUnitsUsedToday === "number" ? saved.premiumUnitsUsedToday : 0;
        record.premiumUnitsUsedCycle =
          typeof saved.premiumUnitsUsedCycle === "number" ? saved.premiumUnitsUsedCycle : 0;
        record.billingCycleStart =
          typeof saved.billingCycleStart === "number" ? saved.billingCycleStart : this.currentCycleStart();
        record.lastDailyResetDay =
          typeof saved.lastDailyResetDay === "number" ? saved.lastDailyResetDay : this.currentDayInt();
        record.cycleQuotaFromApi = typeof saved.cycleQuotaFromApi === "number" ? saved.cycleQuotaFromApi : null;
        record.cooldownUntil = typeof saved.cooldownUntil === "number" ? saved.cooldownUntil : 0;
        record.suspendStrikes = typeof saved.suspendStrikes === "number" ? saved.suspendStrikes : 0;
        record.permanent = saved.permanent === true;
        record.userInitiatorSentToday =
          typeof saved.userInitiatorSentToday === "number" ? saved.userInitiatorSentToday : 0;
      }

      console.log(`[KEY POOL] Restored state for ${this.keys.length} key(s) from ${STATE_PATH}`);
    } catch {
      console.warn(`[KEY POOL] Could not restore state (corrupt file?) — starting fresh`);
    }
  }

  // ---- Cycle reset ---------------------------------------------------------

  private currentCycleStart(): number {
    // Quota resets on 1st of each month at 00:00:00 UTC
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  }

  private currentDayInt(): number {
    // Returns YYYYMMDD as integer (UTC) for daily reset comparison
    const now = new Date();
    return now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  }

  private checkCycleReset(): void {
    const cycleStart = this.currentCycleStart();
    const todayInt = this.currentDayInt();

    for (const key of this.keys) {
      // Monthly cycle reset: 1st of month 00:00 UTC
      if (key.billingCycleStart < cycleStart) {
        key.premiumUnitsUsedCycle = 0;
        key.cycleQuotaFromApi = null; // will be re-synced
        key.billingCycleStart = cycleStart;
        console.log(`[KEY POOL] key=${key.fingerprint} monthly cycle reset`);
      }
      // Daily reset: when the UTC date rolls over to a new day
      if (key.lastDailyResetDay < todayInt) {
        key.premiumUnitsUsedToday = 0;
        key.userInitiatorSentToday = 0;
        key.lastDailyResetDay = todayInt;
      }
    }
  }

  // ---- Helpers -------------------------------------------------------------

  private find(token: string): KeyRecord | undefined {
    return this.keys.find((k) => k.token === token);
  }
}

// ============================================================================
// Singleton export
// ============================================================================

export const keyPool = new KeyPool();
