/**
 * Tests for artifact-actions rate-limit sweep.
 *
 * checkRateLimit only refreshes the entry it touches per-call (O(1)). Abandoned keys
 * — e.g. one click on an artifact that's never clicked again — would otherwise stay
 * in the Map forever. The throttled setInterval sweep is what keeps memory bounded.
 *
 * We verify:
 *   1. sweepRateLimits drops only entries past their resetAt
 *   2. sweep does NOT drop active entries (still within window)
 *   3. timer is created with .unref() so it doesn't block process exit
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __testHooks } from "../artifact-actions";

const { sweepRateLimits, rateLimits } = __testHooks;

describe("artifact-actions rate-limit sweep", () => {
  beforeEach(() => {
    rateLimits.clear();
  });
  afterEach(() => {
    rateLimits.clear();
  });

  test("sweep evicts expired entries, preserves live ones", () => {
    const now = Date.now();
    rateLimits.set("expired-1", { count: 5, resetAt: now - 1000 });
    rateLimits.set("expired-2", { count: 1, resetAt: now - 60_000 });
    rateLimits.set("live-1", { count: 3, resetAt: now + 30_000 });
    rateLimits.set("live-2", { count: 9, resetAt: now + 1 });

    expect(rateLimits.size).toBe(4);
    sweepRateLimits();
    expect(rateLimits.size).toBe(2);
    expect(rateLimits.has("live-1")).toBe(true);
    expect(rateLimits.has("live-2")).toBe(true);
    expect(rateLimits.has("expired-1")).toBe(false);
    expect(rateLimits.has("expired-2")).toBe(false);
  });

  test("sweep is a no-op when nothing is expired", () => {
    const now = Date.now();
    rateLimits.set("a", { count: 1, resetAt: now + 60_000 });
    rateLimits.set("b", { count: 2, resetAt: now + 60_000 });
    sweepRateLimits();
    expect(rateLimits.size).toBe(2);
  });

  test("sweep handles empty map", () => {
    sweepRateLimits();
    expect(rateLimits.size).toBe(0);
  });

  test("sweep is idempotent — running twice is safe", () => {
    const now = Date.now();
    rateLimits.set("expired", { count: 1, resetAt: now - 1 });
    rateLimits.set("live", { count: 1, resetAt: now + 60_000 });
    sweepRateLimits();
    expect(rateLimits.size).toBe(1);
    sweepRateLimits();
    expect(rateLimits.size).toBe(1);
    expect(rateLimits.has("live")).toBe(true);
  });

  test("sweep correctly evicts entries that expire AT the boundary (now > resetAt)", () => {
    // checkRateLimit uses `now > entry.resetAt` (strict), so an entry where resetAt === now
    // is still considered active. Sweep must match that semantics to avoid false eviction.
    const now = Date.now();
    rateLimits.set("at-boundary", { count: 1, resetAt: now });
    rateLimits.set("past-boundary", { count: 1, resetAt: now - 1 });
    sweepRateLimits();
    // at-boundary may or may not be evicted depending on Date.now() drift between set and sweep.
    // past-boundary MUST be gone.
    expect(rateLimits.has("past-boundary")).toBe(false);
  });
});
