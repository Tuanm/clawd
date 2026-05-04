/**
 * Tests for working-state decisions cap.
 *
 * The cap (DECISIONS_CAP = 50) is "reject 51st" semantics — we never evict the first
 * 50, and additional addDecision() calls become no-ops once at cap. This keeps the
 * decisions block bounded for prompt-cache stability while preserving early decisions
 * (which set up the task and tend to be the most load-bearing).
 */

import { describe, expect, test } from "bun:test";
import { addDecision, createEmptyState } from "./working-state";

describe("working-state decisions cap", () => {
  test("addDecision dedupes by 'what'", () => {
    const state = createEmptyState();
    addDecision(state, { what: "use-bun", why: "perf", alternatives: [] });
    addDecision(state, { what: "use-bun", why: "different reason", alternatives: [] });
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]!.why).toBe("perf");
  });

  test("rejects 51st distinct decision (cap = 50)", () => {
    const state = createEmptyState();
    for (let i = 0; i < 50; i++) {
      addDecision(state, { what: `decision-${i}`, why: `reason-${i}` });
    }
    expect(state.decisions).toHaveLength(50);

    // 51st: distinct 'what' but should be rejected.
    addDecision(state, { what: "decision-50", why: "shouldn't-be-added" });
    expect(state.decisions).toHaveLength(50);

    // First 50 unchanged (no FIFO eviction — we want the early decisions preserved).
    expect(state.decisions[0]!.what).toBe("decision-0");
    expect(state.decisions[49]!.what).toBe("decision-49");
    // Verify the rejected decision is NOT present.
    expect(state.decisions.find((d) => d.what === "decision-50")).toBeUndefined();
  });

  test("dedupe still works at cap (no double-reject)", () => {
    const state = createEmptyState();
    for (let i = 0; i < 50; i++) {
      addDecision(state, { what: `decision-${i}`, why: `reason-${i}` });
    }
    // Re-adding existing 'what' is dedup'd by the first guard, never reaches cap-check.
    addDecision(state, { what: "decision-0", why: "duplicate" });
    expect(state.decisions).toHaveLength(50);
    expect(state.decisions[0]!.why).toBe("reason-0");
  });

  test("cap doesn't block under-cap additions after early dedupe", () => {
    const state = createEmptyState();
    // 10 decisions, then 5 dups, then 40 more — final count should be 50, not less.
    for (let i = 0; i < 10; i++) addDecision(state, { what: `early-${i}`, why: "x" });
    for (let i = 0; i < 5; i++) addDecision(state, { what: `early-${i}`, why: "dup" });
    for (let i = 0; i < 40; i++) addDecision(state, { what: `later-${i}`, why: "y" });
    expect(state.decisions).toHaveLength(50);
    // 51st rejected.
    addDecision(state, { what: "overflow", why: "rejected" });
    expect(state.decisions).toHaveLength(50);
  });
});
