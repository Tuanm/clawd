/**
 * Unit tests for levenshtein distance and isDuplicateSkill deduplication logic.
 */

import { describe, expect, test } from "bun:test";
import { isDuplicateSkill, levenshtein } from "../skill-review-plugin";

// ── levenshtein ───────────────────────────────────────────────────────────────

describe("levenshtein", () => {
  test("identical strings → 0", () => {
    expect(levenshtein("a", "a")).toBe(0);
    expect(levenshtein("cat", "cat")).toBe(0);
    expect(levenshtein("", "")).toBe(0);
  });

  test("empty vs non-empty → length of non-empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  test("single substitution ('cat' → 'bat') → 1", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  test("two edits ('cat' → 'cup') → 2", () => {
    expect(levenshtein("cat", "cup")).toBe(2);
  });

  test("insertion ('ab' → 'axb') → 1", () => {
    expect(levenshtein("ab", "axb")).toBe(1);
  });

  test("deletion ('abc' → 'ac') → 1", () => {
    expect(levenshtein("abc", "ac")).toBe(1);
  });
});

// ── isDuplicateSkill ──────────────────────────────────────────────────────────

describe("isDuplicateSkill", () => {
  test("name edit-distance ≤ 2 is duplicate", () => {
    // "file-ops" vs "file-op" → distance 1
    expect(isDuplicateSkill({ name: "file-op", triggers: [] }, [{ name: "file-ops", triggers: [] }])).toBe(true);
  });

  test("name edit-distance > 2 is not a duplicate (name alone)", () => {
    // "deploy-aws" vs "git-commit" → distance well above 2
    expect(isDuplicateSkill({ name: "deploy-aws", triggers: [] }, [{ name: "git-commit", triggers: [] }])).toBe(false);
  });

  test("shared trigger keyword makes it a duplicate", () => {
    expect(
      isDuplicateSkill({ name: "new-skill", triggers: ["deploy", "aws"] }, [
        { name: "old-skill", triggers: ["deploy"] },
      ]),
    ).toBe(true);
  });

  test("no shared trigger and name distance > 2 is not a duplicate", () => {
    expect(
      isDuplicateSkill({ name: "completely-different", triggers: ["alpha"] }, [
        { name: "nothing-alike", triggers: ["beta"] },
      ]),
    ).toBe(false);
  });

  test("empty existing array is never a duplicate", () => {
    expect(isDuplicateSkill({ name: "any-skill", triggers: ["trigger1"] }, [])).toBe(false);
  });

  test("exact name match (distance 0) is duplicate", () => {
    expect(isDuplicateSkill({ name: "my-skill", triggers: [] }, [{ name: "my-skill", triggers: [] }])).toBe(true);
  });

  test("trigger comparison is case-insensitive", () => {
    expect(
      isDuplicateSkill({ name: "new-skill", triggers: ["Deploy"] }, [{ name: "other-skill", triggers: ["deploy"] }]),
    ).toBe(true);
  });
});
