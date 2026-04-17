/**
 * Unit tests for buildContextPreamble
 *
 * Uses an in-memory SessionManager via the _manager option so no filesystem
 * side-effects occur and no module monkey-patching is needed.
 *
 * Coverage:
 * 1. Empty / non-existent session → returns ''
 * 2. Normal messages → well-formed preamble
 * 3. Tool call / tool result rows are excluded
 * 4. Assistant messages with only tool_calls (no text) are excluded
 * 5. Long content is truncated
 * 6. autoCompact fires when session exceeds token threshold
 * 7. Preamble respects maxMessages cap
 * 8. Messages with empty/whitespace content are skipped
 * 9. Error in manager → returns '' without throwing
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "../api/client";
import { buildContextPreamble } from "./context-injector";
import { SessionManager } from "./manager";

// ── Helpers ────────────────────────────────────────────────────────────────

function userMsg(content: string): Message {
  return { role: "user", content };
}

function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

function toolCallMsg(callId: string): Message {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: `call_${callId}`, type: "function", function: { name: "bash", arguments: "{}" } }],
  };
}

function toolResultMsg(callId: string, content: string): Message {
  return { role: "tool", content, tool_call_id: `call_${callId}` };
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe("buildContextPreamble", () => {
  const SESSION = "test-channel-agent1";
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager(":memory:");
  });

  afterEach(() => {
    mgr.close();
  });

  const opts = (extra: object = {}) => ({ _manager: mgr, ...extra });

  // ── 1. Empty / non-existent ──────────────────────────────────────────────

  test("returns empty string for empty session name (prevents LIKE '%' wildcard match)", () => {
    // If sessionName is empty, getSession("") runs `WHERE id LIKE '%'` which
    // matches every row and returns a random session — guard must fire first.
    mgr.getOrCreateSession("some-session", "model");
    expect(buildContextPreamble("", opts())).toBe("");
  });

  test("returns empty string when session does not exist", () => {
    expect(buildContextPreamble("non-existent-session", opts())).toBe("");
  });

  test("returns empty string for a session with no messages", () => {
    mgr.getOrCreateSession(SESSION, "model");
    expect(buildContextPreamble(SESSION, opts())).toBe("");
  });

  // ── 2. Normal messages ───────────────────────────────────────────────────

  test("builds a preamble with user and assistant messages", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    mgr.addMessage(session.id, userMsg("Hello, world!"));
    mgr.addMessage(session.id, assistantMsg("[Sent to chat]: Hi there!"));

    const result = buildContextPreamble(SESSION, opts());

    expect(result).toContain("<conversation_history>");
    expect(result).toContain("</conversation_history>");
    expect(result).toContain("[Human]: Hello, world!");
    // Legacy [Sent to chat] rows render as "you: <text>" in the current format
    // (unified with [CC-Turn] rows — agent recognises its own messages).
    expect(result).toContain("you: Hi there!");
  });

  test("labels plain user messages as [Human] (fallback) and filters raw assistant text", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    mgr.addMessage(session.id, userMsg("u"));
    // Raw assistant text (no [Sent to chat]: prefix) is filtered — it's noisy internal streaming
    mgr.addMessage(session.id, assistantMsg("a"));

    const result = buildContextPreamble(SESSION, opts());

    expect(result).toContain("[Human]: u");
    // Raw assistant blob must NOT appear — only [Sent to chat]: prefixed lines are surfaced
    expect(result).not.toContain("[Assistant]: a");
    expect(result).not.toContain("you: a");
  });

  test("renders [Sent to chat] as 'you: <text>' regardless of agentId (unified format)", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    mgr.addMessage(session.id, assistantMsg("[Sent to chat]: Done!"));

    const result = buildContextPreamble(SESSION, opts({ agentId: "claude-1" }));

    expect(result).toContain("you: Done!");
    // agentId is no longer used as the legacy-row label — we use 'you' for consistency
    // with [CC-Turn] rows so the agent recognises its own messages uniformly.
    expect(result).not.toContain("[claude-1]: Done!");
  });

  test("extracts per-sender lines from formatted prompt blobs (with timestamps)", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    // Simulate a real formatMessageLine() style prompt
    const prompt = [
      `# Messages on Channel "general" (poll start)`,
      ``,
      `[1705001234567] human: hey can you fix the auth bug`,
      `[1705001235678] verify-agent: I checked the auth module, found an issue`,
      ``,
      `[REMINDER: Your streaming text output goes to the agentic framework only]`,
    ].join("\n");
    mgr.addMessage(session.id, userMsg(prompt));
    mgr.addMessage(session.id, assistantMsg("[Sent to chat]: On it!"));

    const result = buildContextPreamble(SESSION, opts({ agentId: "claude-1" }));

    // Current format preserves timestamps for channel-message lines.
    expect(result).toContain("[1705001234567] human: hey can you fix the auth bug");
    expect(result).toContain("[1705001235678] verify-agent: I checked the auth module, found an issue");
    expect(result).toContain("you: On it!");
    // Boilerplate must not appear
    expect(result).not.toContain("# Messages on Channel");
    expect(result).not.toContain("REMINDER");
  });

  // ── 3. Tool rows excluded ────────────────────────────────────────────────

  test("excludes tool result messages", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    mgr.addMessage(session.id, userMsg("Run a command"));
    mgr.addMessage(session.id, toolCallMsg("abc123"));
    mgr.addMessage(session.id, toolResultMsg("abc123", "command output here"));
    mgr.addMessage(session.id, assistantMsg("[Sent to chat]: Done!"));

    const result = buildContextPreamble(SESSION, opts());

    expect(result).not.toContain("command output here");
    expect(result).toContain("[Human]: Run a command");
    expect(result).toContain("you: Done!");
  });

  // ── 4. Tool-call-only assistant messages excluded ────────────────────────

  test("excludes assistant messages with only tool_calls and no content", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    mgr.addMessage(session.id, userMsg("Do something"));
    mgr.addMessage(session.id, toolCallMsg("xyz789")); // no content
    mgr.addMessage(session.id, toolResultMsg("xyz789", "result"));

    const result = buildContextPreamble(SESSION, opts());

    expect(result).toContain("[Human]: Do something");
    expect((result.match(/\[Assistant\]:/g) ?? []).length).toBe(0);
  });

  // ── 5. Long content truncated ────────────────────────────────────────────

  test("truncates long message content", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    mgr.addMessage(session.id, userMsg("x".repeat(20_000)));

    const result = buildContextPreamble(SESSION, opts({ maxContentLength: 500 }));

    expect(result).toContain("[Human]:");
    const humanLine = result.split("\n").find((l) => l.startsWith("[Human]:")) ?? "";
    expect(humanLine.length).toBeLessThan(700);
  });

  // ── 6. autoCompact fires ─────────────────────────────────────────────────

  test("triggers autoCompact when session exceeds token threshold", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    for (let i = 0; i < 60; i++) {
      mgr.addMessage(
        session.id,
        i % 2 === 0 ? userMsg(`user ${i} ${"a".repeat(100)}`) : assistantMsg(`assistant ${i} ${"b".repeat(100)}`),
      );
    }

    expect(mgr.getSessionStats(session.id).messageCount).toBe(60);

    buildContextPreamble(SESSION, opts({ maxTokensBeforeCompact: 100, keepCountAfterCompact: 10 }));

    // keepCountAfterCompact=10 keeps 10 messages + 1 summary row inserted at epoch 0
    expect(mgr.getSessionStats(session.id).messageCount).toBeLessThanOrEqual(11);
  });

  // ── 7. maxMessages cap ───────────────────────────────────────────────────

  test("respects maxMessages cap", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    for (let i = 0; i < 20; i++) {
      mgr.addMessage(session.id, i % 2 === 0 ? userMsg(`user ${i}`) : assistantMsg(`assistant ${i}`));
    }

    const result = buildContextPreamble(SESSION, opts({ maxMessages: 4 }));

    // Each line starts with "[label]:" — count them regardless of label name
    const total = (result.match(/^\[.+?\]:/gm) ?? []).length;
    expect(total).toBeLessThanOrEqual(4);
  });

  // ── 8. Empty/whitespace content skipped ─────────────────────────────────

  test("skips messages with whitespace-only content", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    mgr.addMessage(session.id, userMsg("   "));
    mgr.addMessage(session.id, assistantMsg("[Sent to chat]: Real response"));

    const result = buildContextPreamble(SESSION, opts());

    expect((result.match(/\[Human\]:/g) ?? []).length).toBe(0);
    expect(result).toContain("you: Real response");
  });

  test("returns empty string when all messages have empty content", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    mgr.addMessage(session.id, userMsg("  "));
    mgr.addMessage(session.id, assistantMsg("  "));

    expect(buildContextPreamble(SESSION, opts())).toBe("");
  });

  // ── 9. Error resilience ──────────────────────────────────────────────────

  test("returns empty string when getSession throws", () => {
    const badManager = {
      autoCompact: () => {},
      getSession: () => {
        throw new Error("db error");
      },
    } as any;
    expect(() => buildContextPreamble("any", { _manager: badManager })).not.toThrow();
    expect(buildContextPreamble("any", { _manager: badManager })).toBe("");
  });

  test("returns empty string when autoCompact throws after getSession succeeds", () => {
    const badManager = {
      getSession: () => ({ id: "x", name: "x", model: "m", created_at: 0, updated_at: 0 }),
      autoCompact: () => {
        throw new Error("compact error");
      },
    } as any;
    expect(() => buildContextPreamble("x", { _manager: badManager })).not.toThrow();
    expect(buildContextPreamble("x", { _manager: badManager })).toBe("");
  });

  test("returns empty string when getRecentMessagesCompact throws", () => {
    const badManager = {
      getSession: () => ({ id: "x", name: "x", model: "m", created_at: 0, updated_at: 0 }),
      autoCompact: () => false,
      getRecentMessagesCompact: () => {
        throw new Error("read error");
      },
    } as any;
    expect(() => buildContextPreamble("x", { _manager: badManager })).not.toThrow();
    expect(buildContextPreamble("x", { _manager: badManager })).toBe("");
  });

  test("returns empty string when session has only tool-call/result messages", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    mgr.addMessage(session.id, toolCallMsg("t1"));
    mgr.addMessage(session.id, toolResultMsg("t1", "some output"));
    expect(buildContextPreamble(SESSION, opts())).toBe("");
  });

  describe("summary row preservation", () => {
    test("summary rows always appear in preamble even when line budget is exhausted", () => {
      const session = mgr.getOrCreateSession(SESSION, "model");
      // Add many rows then compact — this produces a real summary row with created_at=0.
      for (let i = 0; i < 100; i++) {
        mgr.addMessage(session.id, userMsg(`[${1000 + i}] human: old message ${i}`));
      }
      mgr.compactSession(session.id, 5, "Summary body here");
      // Now add many more regular rows that would exceed maxLines on their own.
      for (let i = 0; i < 50; i++) {
        mgr.addMessage(session.id, userMsg(`[${2000 + i}] human: new message ${i}`));
      }

      const preamble = buildContextPreamble(SESSION, { ...opts(), maxLines: 10 });
      // Summary must appear — preserved unconditionally.
      expect(preamble).toContain("Context summary");
      expect(preamble).toContain("Summary body here");
    });

    test("emits 'N older turn rows omitted' marker when line budget truncates older regular rows", () => {
      const session = mgr.getOrCreateSession(SESSION, "model");
      // 30 user rows — each expands to 1 line.
      for (let i = 0; i < 30; i++) {
        mgr.addMessage(session.id, userMsg(`[${1000 + i}] human: msg ${i}`));
      }

      const preamble = buildContextPreamble(SESSION, { ...opts(), maxLines: 5 });
      expect(preamble).toMatch(/\[\d+ older turn rows? omitted from preamble\]/);
    });

    test("summary rows do not count toward the dropped count", () => {
      const session = mgr.getOrCreateSession(SESSION, "model");
      // Create a summary via real compaction
      for (let i = 0; i < 10; i++) {
        mgr.addMessage(session.id, userMsg(`[${1000 + i}] human: old ${i}`));
      }
      mgr.compactSession(session.id, 1, "body");
      // Now add many new regular rows
      for (let i = 0; i < 20; i++) {
        mgr.addMessage(session.id, userMsg(`[${2000 + i}] human: msg ${i}`));
      }

      const preamble = buildContextPreamble(SESSION, { ...opts(), maxLines: 3 });
      // The summary is always preserved; dropped count should exclude it.
      const match = preamble.match(/\[(\d+) older turn rows? omitted from preamble\]/);
      expect(match).toBeTruthy();
      const droppedCount = Number(match![1]);
      // Summary row is preserved (not counted). Dropped count is the regular rows
      // that didn't fit after subtracting the summary's line usage from budget.
      expect(droppedCount).toBeGreaterThan(0);
    });

    test("preamble with only summary rows (no regular rows) still renders", () => {
      const session = mgr.getOrCreateSession(SESSION, "model");
      for (let i = 0; i < 10; i++) {
        mgr.addMessage(session.id, userMsg(`old ${i}`));
      }
      mgr.compactSession(session.id, 0, "key points here");
      const preamble = buildContextPreamble(SESSION, opts());
      expect(preamble).toContain("<conversation_history>");
      expect(preamble).toContain("key points here");
    });
  });

  describe("[CC-Turn] rendering", () => {
    test("passes [CC-Turn] inner lines through verbatim", () => {
      const session = mgr.getOrCreateSession(SESSION, "model");
      const ccTurn =
        "[CC-Turn]:\n[1000] you: [Thought]: thinking\n[1001] you: [Action]: file_view(x.ts)\n    Output: code";
      mgr.addMessage(session.id, assistantMsg(ccTurn));
      const preamble = buildContextPreamble(SESSION, opts());
      expect(preamble).toContain("[1000] you: [Thought]: thinking");
      expect(preamble).toContain("[1001] you: [Action]: file_view(x.ts)");
      expect(preamble).toContain("    Output: code");
    });

    test("renders legacy [Sent to chat] as 'you: <text>'", () => {
      const session = mgr.getOrCreateSession(SESSION, "model");
      mgr.addMessage(session.id, assistantMsg("[Sent to chat]: hello world"));
      const preamble = buildContextPreamble(SESSION, opts());
      expect(preamble).toContain("you: hello world");
      expect(preamble).not.toContain("[Sent to chat]");
    });

    test("renders legacy [Actions taken] as 'you: [Action]: <list>'", () => {
      const session = mgr.getOrCreateSession(SESSION, "model");
      mgr.addMessage(session.id, assistantMsg("[Actions taken]: file_view(x.ts), bash('ls')"));
      const preamble = buildContextPreamble(SESSION, opts());
      expect(preamble).toContain("you: [Action]: file_view(x.ts), bash('ls')");
    });
  });
});
