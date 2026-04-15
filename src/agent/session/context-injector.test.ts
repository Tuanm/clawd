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
    expect(result).toContain("[Assistant]: Hi there!");
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
  });

  test("uses agentId as label for assistant turns when provided", () => {
    const session = mgr.getOrCreateSession(SESSION, "model");
    mgr.addMessage(session.id, assistantMsg("[Sent to chat]: Done!"));

    const result = buildContextPreamble(SESSION, opts({ agentId: "claude-1" }));

    expect(result).toContain("[claude-1]: Done!");
    expect(result).not.toContain("[Assistant]:");
  });

  test("extracts per-sender lines from formatted prompt blobs", () => {
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

    expect(result).toContain("[human]: hey can you fix the auth bug");
    expect(result).toContain("[verify-agent]: I checked the auth module, found an issue");
    expect(result).toContain("[claude-1]: On it!");
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
    expect(result).toContain("[Assistant]: Done!");
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
    expect(result).toContain("[Assistant]: Real response");
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
});
