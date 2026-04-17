/**
 * Tests for stripReasoningBlocks — removes `<think>` / `<thinking>` inline
 * reasoning from assistant text before persisting to the session DB.
 *
 * Reason this matters: when the agent's own past reasoning leaks into its
 * conversation history, later turns see it and re-imitate the patterns,
 * producing duplicate replies and confused behavior (observed on MiniMax-
 * M2.7-highspeed in channel test-260418).
 */

import { describe, expect, test } from "bun:test";
import { stripReasoningBlocks } from "../agent";

describe("stripReasoningBlocks", () => {
  test("returns empty string for null / undefined / empty", () => {
    expect(stripReasoningBlocks(null)).toBe("");
    expect(stripReasoningBlocks(undefined)).toBe("");
    expect(stripReasoningBlocks("")).toBe("");
  });

  test("leaves plain text unchanged (trimmed)", () => {
    expect(stripReasoningBlocks("Hello world")).toBe("Hello world");
    expect(stripReasoningBlocks("  padded  ")).toBe("padded");
  });

  test("removes a single <think> block", () => {
    const input = "<think>internal reasoning</think>\nThe answer is 42.";
    expect(stripReasoningBlocks(input)).toBe("The answer is 42.");
  });

  test("removes multiple <think> blocks", () => {
    const input = "<think>step 1</think>\nFirst\n<think>step 2</think>\nSecond";
    expect(stripReasoningBlocks(input)).toBe("First\n\nSecond");
  });

  test("also removes <thinking> blocks (Anthropic-style)", () => {
    const input = "<thinking>reason</thinking>\n\nVisible output.";
    expect(stripReasoningBlocks(input)).toBe("Visible output.");
  });

  test("handles multi-line reasoning blocks", () => {
    const input = "<think>\nline1\nline2\nline3\n</think>\nResult";
    expect(stripReasoningBlocks(input)).toBe("Result");
  });

  test("returns empty string when input is reasoning-only", () => {
    expect(stripReasoningBlocks("<think>only reasoning</think>")).toBe("");
    expect(stripReasoningBlocks("<thinking>just thinking</thinking>\n<think>more</think>")).toBe("");
  });

  test("collapses excess blank lines left by the strip", () => {
    const input = "Before\n\n\n\n<think>x</think>\n\n\n\nAfter";
    expect(stripReasoningBlocks(input)).toBe("Before\n\nAfter");
  });

  test("case-insensitive tag matching", () => {
    expect(stripReasoningBlocks("<THINK>a</THINK>\nvisible")).toBe("visible");
    expect(stripReasoningBlocks("<Think>a</Think>\nvisible")).toBe("visible");
  });

  test("does not affect tool_use blocks or code", () => {
    const input = "Here is code:\n```ts\nconst x = 1;\n```\nDone.";
    expect(stripReasoningBlocks(input)).toBe("Here is code:\n```ts\nconst x = 1;\n```\nDone.");
  });
});
