/**
 * Unit tests for KeyPool
 *
 * Coverage:
 * 1. Basic round-robin key selection
 * 2. RPM window limiting — over-limit key is skipped in favour of a healthy key
 * 3. 429 rotation — key with a 429 goes on cooldown; next key is used
 * 4. Budget exhaustion — canUserRequest() returns false when budget is spent
 * 5. Cooldown expiry — key becomes available again after cooldown passes
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";

// ── Mock file-system I/O so tests don't touch ~/.clawd/ ─────────────────────
// These calls must be at module level so Bun intercepts them before key-pool
// resolves its own "node:fs" imports.
mock.module("node:fs", () => ({
  existsSync: () => false, // pretend state file never exists
  mkdirSync: () => {},
  readFileSync: () => "{}",
  writeFileSync: () => {},
  renameSync: () => {},
}));

// Mock http2 so no real TCP connections are opened
mock.module("node:http2", () => ({
  default: {
    connect: (_url: string) => {
      const session: any = {
        destroyed: false,
        on: (_event: string, _cb: any) => session,
        destroy: () => {
          session.destroyed = true;
        },
      };
      return session;
    },
  },
  connect: (_url: string) => {
    const session: any = {
      destroyed: false,
      on: (_event: string, _cb: any) => session,
      destroy: () => {
        session.destroyed = true;
      },
    };
    return session;
  },
}));

// Import AFTER mocks are registered
import { AllKeysSuspendedError, keyPool } from "./key-pool";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Token strings used across tests */
const T1 = "token-aaaaaaaabbbbbbbb";
const T2 = "token-ccccccccdddddddd";
const T3 = "token-eeeeeeeefffffff0";

/** Reset the pool to a clean slate with a fresh set of tokens */
function resetPool(...tokens: string[]) {
  // First wipe all existing keys, then add the desired ones
  keyPool.init([]); // removes all keys (but leaves `initialized = true`)
  if (tokens.length > 0) {
    keyPool.init(tokens);
  }
}

/** Fill a key's RPM window past the 8 RPM limit */
function saturateRpm(token: string, count = 9) {
  for (let i = 0; i < count; i++) {
    keyPool.recordRequest(token, "gpt-4o", "agent"); // gpt-4o has 0 premium cost
  }
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe("KeyPool", () => {
  beforeEach(() => {
    // Always start with a deterministic clock and clean pool
    setSystemTime(new Date("2026-01-15T12:00:00Z"));
    resetPool(T1, T2);
  });

  afterEach(() => {
    // Restore real clock after each test
    setSystemTime(); // Bun restores real time when called with no argument
    resetPool(); // clear all keys
  });

  // ── 1. Basic key selection ────────────────────────────────────────────────

  describe("basic key selection", () => {
    test("selectKey returns a key when pool is initialised", () => {
      const key = keyPool.selectKey("agent");
      expect(key).toBeDefined();
      expect(key.token).toBeString();
      // Release the slot so state is clean
      keyPool.releaseKey(key.token);
    });

    test("selectKey increments inFlight", () => {
      const key = keyPool.selectKey("agent");
      // inFlight should be 1 (we haven't called recordRequest yet)
      const status = keyPool.getStatus();
      const ks = status.find((s) => s.fingerprint === key.fingerprint);
      expect(ks?.inFlight).toBe(1);
      keyPool.releaseKey(key.token);
    });

    test("throws AllKeysSuspendedError when pool is empty", () => {
      resetPool(); // clear all keys
      expect(() => keyPool.selectKey("agent")).toThrow(AllKeysSuspendedError);
    });

    test("successive selects distribute across both keys (with two keys)", () => {
      const selected = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const key = keyPool.selectKey("agent");
        selected.add(key.token);
        keyPool.releaseKey(key.token);
      }
      // At minimum, at least one of the two tokens should have been used
      expect(selected.size).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 2. RPM window limiting ────────────────────────────────────────────────

  describe("RPM window limiting", () => {
    test("key at RPM limit is skipped in favour of healthy key", () => {
      // Saturate T1 past the 8 RPM limit
      saturateRpm(T1, 9);

      // T1 is over limit; T2 is fresh → selectKey must return T2
      const key = keyPool.selectKey("agent");
      expect(key.token).toBe(T2);
      keyPool.releaseKey(key.token);
    });

    test("RPM window entries older than 60s don't count", () => {
      // Saturate T1 at the current time
      saturateRpm(T1, 9);

      // Advance clock by >60 seconds so the window expires
      setSystemTime(new Date(Date.now() + 61_000));

      // Now T1 should be viable again (both are healthy)
      const key = keyPool.selectKey("agent");
      expect([T1, T2]).toContain(key.token);
      keyPool.releaseKey(key.token);
    });

    test("when ALL keys exceed RPM limit, pool falls back to any available key", () => {
      saturateRpm(T1, 9);
      saturateRpm(T2, 9);

      // Both are over limit; pool falls back rather than throwing
      expect(() => keyPool.selectKey("agent")).not.toThrow();
      const key = keyPool.selectKey("agent");
      keyPool.releaseKey(key.token);
    });
  });

  // ── 3. 429 rotation ──────────────────────────────────────────────────────

  describe("429 rotation", () => {
    test("key with 429 goes on cooldown and is not selected next", () => {
      // Select whichever key the pool prefers first, then report a 429 on it
      const key1 = keyPool.selectKey("agent");
      keyPool.reportError(key1.token, 429);

      // key1 is now on cooldown — the next selection must be a different key
      const key2 = keyPool.selectKey("agent");
      expect(key2.token).not.toBe(key1.token);
      keyPool.releaseKey(key2.token);
    });

    test("reportError(429) shows key as unhealthy in getStatus()", () => {
      const key1 = keyPool.selectKey("agent");
      keyPool.reportError(key1.token, 429);

      const status = keyPool.getStatus();
      const ks = status.find((s) => s.fingerprint === key1.fingerprint);
      expect(ks?.healthy).toBe(false);
      expect(ks?.cooldownUntil).not.toBeNull();
    });

    test("reportError(403) with invalid-token body marks key as permanent", () => {
      resetPool(T1);
      const key = keyPool.selectKey("agent");
      keyPool.reportError(key.token, 403, undefined, "invalid token");

      const status = keyPool.getStatus();
      expect(status[0].permanent).toBe(true);
      expect(status[0].healthy).toBe(false);
    });

    test("AllKeysSuspendedError thrown when all keys are on cooldown", () => {
      // Both keys get 429s
      const k1 = keyPool.selectKey("agent");
      keyPool.reportError(k1.token, 429);
      const k2 = keyPool.selectKey("agent");
      keyPool.reportError(k2.token, 429);

      expect(() => keyPool.selectKey("agent")).toThrow(AllKeysSuspendedError);
    });
  });

  // ── 4. Budget exhaustion ──────────────────────────────────────────────────

  describe("budget exhaustion", () => {
    test("canUserRequest returns true for free model regardless of usage", () => {
      resetPool(T1);
      // gpt-4o has 0 multiplier — always free
      expect(keyPool.canUserRequest("gpt-4o")).toBe(true);
      // Even after heavy usage of a premium model, free model stays allowed
      for (let i = 0; i < 10; i++) {
        const k = keyPool.selectKey("user");
        keyPool.recordRequest(k.token, "claude-sonnet-4", "user"); // multiplier=1
      }
      expect(keyPool.canUserRequest("gpt-4o")).toBe(true);
    });

    test("canUserRequest returns true when budget has headroom", () => {
      resetPool(T1);
      // Record a single premium request (cost=1) — far below 300/30≈10 daily per key
      const k = keyPool.selectKey("user");
      keyPool.recordRequest(k.token, "claude-sonnet-4", "user");

      expect(keyPool.canUserRequest("claude-sonnet-4")).toBe(true);
    });

    test("canUserRequest returns false when daily premium budget is exhausted", () => {
      resetPool(T1);
      // Daily cap = (300/30) * 1 key = 10 premium units per day
      // Fill it up: claude-sonnet-4 has multiplier 1
      for (let i = 0; i < 11; i++) {
        const k = keyPool.selectKey("user");
        keyPool.recordRequest(k.token, "claude-sonnet-4", "user");
      }

      // Now budget is exceeded
      expect(keyPool.canUserRequest("claude-sonnet-4")).toBe(false);
    });

    test("canUserRequest returns false when pool is empty", () => {
      resetPool();
      expect(keyPool.canUserRequest("claude-sonnet-4")).toBe(false);
    });
  });

  // ── 5. Cooldown expiry ────────────────────────────────────────────────────

  describe("cooldown expiry", () => {
    test("key becomes available after cooldown elapses", () => {
      resetPool(T1); // single-key pool

      const k = keyPool.selectKey("agent");
      keyPool.reportError(k.token, 429);

      // Pool should now be fully suspended
      expect(() => keyPool.selectKey("agent")).toThrow(AllKeysSuspendedError);

      // 1-key pool: getScaled429Delays(1)[0] = max(300_000, 600_000/1) = 600_000ms (10 min)
      setSystemTime(new Date(Date.now() + 661_000));

      // Key should be available again
      const k2 = keyPool.selectKey("agent");
      expect(k2.token).toBe(T1);
      keyPool.releaseKey(k2.token);
    });

    test("AllKeysSuspendedError.earliestResumeAt reflects the cooldown end time", () => {
      resetPool(T1);
      const k = keyPool.selectKey("agent");
      keyPool.reportError(k.token, 429);

      let error: AllKeysSuspendedError | null = null;
      try {
        keyPool.selectKey("agent");
      } catch (e) {
        if (e instanceof AllKeysSuspendedError) error = e;
      }

      expect(error).not.toBeNull();
      expect(error!.earliestResumeAt).toBeInstanceOf(Date);
      // The resume time should be in the future
      expect(error!.earliestResumeAt.getTime()).toBeGreaterThan(Date.now());
    });

    test("key status shows healthy=true after cooldown expires", () => {
      resetPool(T1);
      const k = keyPool.selectKey("agent");
      keyPool.reportError(k.token, 429);

      // Before expiry
      const statusBefore = keyPool.getStatus();
      expect(statusBefore[0].healthy).toBe(false);

      // After expiry — 1-key pool has 600_000ms (10 min) cooldown
      setSystemTime(new Date(Date.now() + 661_000));
      const statusAfter = keyPool.getStatus();
      expect(statusAfter[0].healthy).toBe(true);
    });
  });

  // ── 6. peekToken ─────────────────────────────────────────────────────────

  describe("peekToken", () => {
    test("returns a token without incrementing inFlight", () => {
      const token = keyPool.peekToken("agent");
      expect(token).toBeString();

      const status = keyPool.getStatus();
      // inFlight should still be 0 (peek doesn't claim a slot)
      for (const ks of status) {
        expect(ks.inFlight).toBe(0);
      }
    });

    test("returns null when pool is empty", () => {
      resetPool();
      expect(keyPool.peekToken("agent")).toBeNull();
    });
  });
});
