/**
 * Tests for formatAuthor — the single source of truth that converts a channel
 * message into the author label embedded in agent prompts.
 *
 * Reason this matters: prior to consolidation, 7-8 sites formatted the author
 * inline with subtle drift (`human` vs `Human`, `bot` vs `unknown` fallback,
 * missing `[Sub-agent: ...]` wrapper). The agent then mis-attributed turns and
 * duplicated replies. These cases lock in the contract so a future tweak that
 * breaks one branch fails loudly here instead of silently in production.
 */

import { describe, expect, test } from "bun:test";
import { formatAuthor } from "../utils/format-author";

describe("formatAuthor", () => {
  test("UHUMAN renders as 'human'", () => {
    expect(formatAuthor({ user: "UHUMAN" })).toBe("human");
    expect(formatAuthor({ user: "UHUMAN", agent_id: "anything" })).toBe("human");
  });

  test("USYSTEM renders as 'system' (synthetic context messages)", () => {
    expect(formatAuthor({ user: "USYSTEM" })).toBe("system");
    expect(formatAuthor({ user: "USYSTEM", agent_id: "ignored" })).toBe("system");
  });

  test("UWORKER-* renders as '[Sub-agent: <agent_id>]'", () => {
    expect(formatAuthor({ user: "UWORKER-abc123", agent_id: "scout" })).toBe("[Sub-agent: scout]");
    expect(formatAuthor({ user: "UWORKER-xyz", agent_id: "researcher-1" })).toBe("[Sub-agent: researcher-1]");
  });

  test("UWORKER-* without agent_id falls back to 'unknown'", () => {
    expect(formatAuthor({ user: "UWORKER-abc" })).toBe("[Sub-agent: unknown]");
    expect(formatAuthor({ user: "UWORKER-abc", agent_id: null })).toBe("[Sub-agent: unknown]");
    expect(formatAuthor({ user: "UWORKER-abc", agent_id: "" })).toBe("[Sub-agent: unknown]");
  });

  test("regular bot rows prefer agent_id over user id", () => {
    expect(formatAuthor({ user: "UBOT-1", agent_id: "echo-bot" })).toBe("echo-bot");
    expect(formatAuthor({ user: "UBOT-2", agent_id: "claude-haiku" })).toBe("claude-haiku");
  });

  test("falls back to user when agent_id missing", () => {
    expect(formatAuthor({ user: "UBOT-1" })).toBe("UBOT-1");
    expect(formatAuthor({ user: "UBOT-1", agent_id: null })).toBe("UBOT-1");
    expect(formatAuthor({ user: "UBOT-1", agent_id: "" })).toBe("UBOT-1");
  });

  test("returns 'unknown' when both fields are missing", () => {
    expect(formatAuthor({})).toBe("unknown");
    expect(formatAuthor({ user: null, agent_id: null })).toBe("unknown");
    expect(formatAuthor({ user: "", agent_id: "" })).toBe("unknown");
  });
});
