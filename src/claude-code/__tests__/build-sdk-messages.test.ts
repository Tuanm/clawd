/**
 * Tests for build-sdk-messages.ts
 *
 * Verifies the SDK message stream rebuilt from session DB rows:
 * - Emits user/assistant/tool-result messages with proper roles and types
 * - Preserves tool_use blocks inside assistant messages
 * - Pairs tool_use with tool_result correctly (orphan repair)
 * - Skips legacy [CC-Turn]/[Sent to chat]/[Actions taken] rows (clean break)
 * - Skips compaction summary rows (they go in system prompt instead)
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../agent/session/manager";
import { buildSdkPromptWithHeartbeat, collectSdkMessages } from "../build-sdk-messages";

let mgr: SessionManager;

beforeEach(() => {
  mgr = new SessionManager(":memory:");
});

function addUser(sessionId: string, content: string): void {
  mgr.addMessage(sessionId, { role: "user", content });
}

function addAssistant(
  sessionId: string,
  text: string,
  toolCalls?: Array<{ id: string; name: string; input: unknown }>,
): void {
  mgr.addMessage(sessionId, {
    role: "assistant",
    content: text,
    tool_calls: toolCalls
      ? toolCalls.map((tc) => ({
          id: `call_${tc.id}`,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }))
      : undefined,
  });
}

function addToolResult(sessionId: string, toolCallId: string, content: string): void {
  mgr.addMessage(sessionId, {
    role: "tool",
    content,
    tool_call_id: toolCallId,
  });
}

const collect = (name: string) => collectSdkMessages(name, { _manager: mgr });

describe("buildSdkMessages", () => {
  test("returns empty for non-existent session", async () => {
    const msgs = await collect("never-created");
    expect(msgs).toEqual([]);
  });

  test("emits user text messages from channel-message rows", async () => {
    const session = mgr.getOrCreateSession("s1", "model");
    addUser(session.id, "[1000] human: hello");
    addUser(session.id, "[2000] other-agent: reply");

    const out = (await collect("s1")) as any[];
    expect(out.length).toBe(2);
    expect(out[0].type).toBe("user");
    expect(out[0].message.role).toBe("user");
    expect(out[0].message.content[0]).toEqual({ type: "text", text: "[1000] human: hello" });
    expect(out[1].message.content[0].text).toBe("[2000] other-agent: reply");
  });

  test("emits assistant messages with text block", async () => {
    const session = mgr.getOrCreateSession("s2", "model");
    addAssistant(session.id, "Hello, working on it!");

    const out = (await collect("s2")) as any[];
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("assistant");
    expect(out[0].message.role).toBe("assistant");
    expect(out[0].message.content[0]).toEqual({ type: "text", text: "Hello, working on it!" });
  });

  test("emits assistant messages with text + tool_use blocks", async () => {
    const session = mgr.getOrCreateSession("s3", "model");
    addAssistant(session.id, "Let me check", [{ id: "abc123", name: "file_view", input: { path: "x.ts" } }]);
    addToolResult(session.id, "call_abc123", "file content");

    const out = (await collect("s3")) as any[];
    expect(out.length).toBe(2);
    expect(out[0].type).toBe("assistant");
    expect(out[0].message.content.length).toBe(2);
    expect(out[0].message.content[0]).toEqual({ type: "text", text: "Let me check" });
    expect(out[0].message.content[1].type).toBe("tool_use");
    expect(out[0].message.content[1].name).toBe("file_view");
    expect(out[0].message.content[1].input).toEqual({ path: "x.ts" });
    expect(out[1].type).toBe("user");
    expect(out[1].message.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_abc123",
      content: "file content",
    });
  });

  test("tool_use-only assistant message (no text) still emits with tool_use block", async () => {
    const session = mgr.getOrCreateSession("s4", "model");
    addAssistant(session.id, "", [{ id: "xyz", name: "bash", input: { command: "ls" } }]);
    addToolResult(session.id, "call_xyz", "out.txt");

    const out = (await collect("s4")) as any[];
    expect(out.length).toBe(2);
    expect(out[0].message.content.length).toBe(1);
    expect(out[0].message.content[0].type).toBe("tool_use");
  });

  test("repairs orphan tool_use by merging filler into next user message", async () => {
    const session = mgr.getOrCreateSession("s5", "model");
    // Simulate a crash mid-tool-execution: assistant called a tool but no result persisted.
    addAssistant(session.id, "", [{ id: "orphan1", name: "bash", input: { command: "echo hi" } }]);
    addUser(session.id, "[3000] human: are you there?");

    const out = (await collect("s5")) as any[];
    // Expected: assistant(tool_use) → user(filler tool_result + channel text MERGED)
    // Merging keeps tool_results for a given assistant contiguous in one user message,
    // which matches the stricter Anthropic Messages API pairing requirement.
    expect(out.length).toBe(2);
    expect(out[0].type).toBe("assistant");
    expect(out[1].type).toBe("user");
    expect(out[1].message.content[0].type).toBe("tool_result");
    expect(out[1].message.content[0].tool_use_id).toBe("call_orphan1");
    expect(out[1].message.content[0].is_error).toBe(true);
    expect(out[1].message.content[0].content).toContain("interrupted");
    expect(out[1].message.content[1].type).toBe("text");
    expect(out[1].message.content[1].text).toContain("are you there?");
  });

  test("skips legacy [CC-Turn] rows", async () => {
    const session = mgr.getOrCreateSession("s6", "model");
    mgr.addMessage(session.id, { role: "assistant", content: "[CC-Turn]:\nsome legacy blob" });
    addUser(session.id, "[4000] human: new message");

    const out = (await collect("s6")) as any[];
    expect(out.length).toBe(1);
    expect(out[0].message.content[0].text).toBe("[4000] human: new message");
  });

  test("skips legacy [Sent to chat] and [Actions taken] rows", async () => {
    const session = mgr.getOrCreateSession("s7", "model");
    mgr.addMessage(session.id, { role: "assistant", content: "[Sent to chat]: hi" });
    mgr.addMessage(session.id, { role: "assistant", content: "[Actions taken]: bash()" });
    addUser(session.id, "[5000] human: modern row");

    const out = (await collect("s7")) as any[];
    expect(out.length).toBe(1);
    expect(out[0].message.content[0].text).toBe("[5000] human: modern row");
  });

  test("skips compaction summary rows (they belong in system prompt)", async () => {
    const session = mgr.getOrCreateSession("s8", "model");
    for (let i = 0; i < 10; i++) addUser(session.id, `[${1000 + i}] human: old ${i}`);
    mgr.compactSession(session.id, 2, "Body of summary");
    addUser(session.id, "[6000] human: after compaction");

    const out = (await collect("s8")) as any[];
    const texts = out.map((m: any) => m.message.content[0]?.text).filter(Boolean) as string[];
    for (const t of texts) {
      expect(t).not.toContain("[CONTEXT SUMMARY");
      expect(t).not.toContain("Body of summary");
    }
  });

  test("tool_result is_error flag set when content starts with 'Error:'", async () => {
    const session = mgr.getOrCreateSession("s9", "model");
    addAssistant(session.id, "", [{ id: "fail1", name: "bash", input: { command: "xxx" } }]);
    addToolResult(session.id, "call_fail1", "Error: command not found");

    const out = (await collect("s9")) as any[];
    expect(out[1].message.content[0].is_error).toBe(true);
  });

  test("partial orphan — filler merges with FIRST following user to keep tool_result batch contiguous", async () => {
    const session = mgr.getOrCreateSession("partial", "model");
    // Assistant calls two tools; only one gets a result before crash/interrupt.
    addAssistant(session.id, "", [
      { id: "a1", name: "bash", input: { command: "ls" } },
      { id: "a2", name: "bash", input: { command: "pwd" } },
    ]);
    // Real result for a1 only
    addToolResult(session.id, "call_a1", "ls output");
    // Channel message follows (e.g. user asked a follow-up while a2 was pending)
    addUser(session.id, "[1000] human: any update?");

    const out = (await collect("partial")) as any[];
    // Expected sequence — filler for orphan a2 merges into the FIRST user message
    // after the assistant (the one already carrying tool_result a1), so ALL
    // tool_results for the assistant batch end up in ONE user message. Meeting
    // the stricter Anthropic Messages API pairing rule.
    //   [0] assistant(tool_use a1, tool_use a2)
    //   [1] user(filler a2 is_error + tool_result a1)  ← filler prepended
    //   [2] user(channel text) unchanged
    expect(out.length).toBe(3);
    expect(out[0].type).toBe("assistant");
    expect(out[1].type).toBe("user");
    // Both tool_results present in [1], fillers first
    expect(out[1].message.content.length).toBe(2);
    expect(out[1].message.content[0].type).toBe("tool_result");
    expect(out[1].message.content[0].tool_use_id).toBe("call_a2");
    expect(out[1].message.content[0].is_error).toBe(true);
    expect(out[1].message.content[1].type).toBe("tool_result");
    expect(out[1].message.content[1].tool_use_id).toBe("call_a1");
    // Channel text preserved as a separate user message
    expect(out[2].type).toBe("user");
    expect(out[2].message.content[0].type).toBe("text");
    expect(out[2].message.content[0].text).toContain("any update?");
  });

  test("orphan at end of stream emits standalone filler user message", async () => {
    const session = mgr.getOrCreateSession("tail-orphan", "model");
    addAssistant(session.id, "", [{ id: "tail1", name: "bash", input: {} }]);
    // No following user message at all

    const out = (await collect("tail-orphan")) as any[];
    expect(out.length).toBe(2);
    expect(out[0].type).toBe("assistant");
    expect(out[1].type).toBe("user");
    expect(out[1].message.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_tail1",
      is_error: true,
    });
  });

  test("chronological order preserved", async () => {
    const session = mgr.getOrCreateSession("s10", "model");
    addUser(session.id, "[1] human: first");
    addAssistant(session.id, "first reply");
    addUser(session.id, "[2] human: second");
    addAssistant(session.id, "second reply");

    const out = (await collect("s10")) as any[];
    expect(out.length).toBe(4);
    expect(out[0].message.content[0].text).toBe("[1] human: first");
    expect(out[1].message.content[0].text).toBe("first reply");
    expect(out[2].message.content[0].text).toBe("[2] human: second");
    expect(out[3].message.content[0].text).toBe("second reply");
  });

  test("session_id populated on every emitted message", async () => {
    const session = mgr.getOrCreateSession("s11", "model");
    addUser(session.id, "[1] human: x");
    addAssistant(session.id, "reply");

    const out = (await collect("s11")) as any[];
    for (const m of out) {
      expect(typeof m.session_id).toBe("string");
      expect(m.session_id.length).toBeGreaterThan(0);
    }
  });
});

describe("SessionManager.getCompactionSummariesByName", () => {
  test("returns empty for session with no compaction", () => {
    mgr.getOrCreateSession("cs1", "m");
    expect(mgr.getCompactionSummariesByName("cs1")).toEqual([]);
  });

  test("returns single most-recent summary (subsequent compactions replace older ones)", () => {
    // By design, compactSession deletes rows with id < threshold — this includes
    // prior summary rows. A new compaction is expected to incorporate the prior
    // summary's content into its own summary, so only ONE summary row is retained.
    const session = mgr.getOrCreateSession("cs2", "m");
    for (let i = 0; i < 10; i++) mgr.addMessage(session.id, { role: "user", content: `msg ${i}` });
    mgr.compactSession(session.id, 2, "First summary");
    for (let i = 0; i < 10; i++) mgr.addMessage(session.id, { role: "user", content: `new ${i}` });
    mgr.compactSession(session.id, 2, "Second summary");

    const summaries = mgr.getCompactionSummariesByName("cs2");
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain("Second summary");
  });

  test("returns the single summary after first compaction", () => {
    const session = mgr.getOrCreateSession("cs3", "m");
    for (let i = 0; i < 10; i++) mgr.addMessage(session.id, { role: "user", content: `msg ${i}` });
    mgr.compactSession(session.id, 2, "Only summary body");

    const summaries = mgr.getCompactionSummariesByName("cs3");
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain("Only summary body");
  });

  test("returns empty for non-existent session", () => {
    expect(mgr.getCompactionSummariesByName("cs-nope")).toEqual([]);
  });
});

describe("buildSdkPromptWithHeartbeat", () => {
  test("appends heartbeat with session.id (UUID), not session name", async () => {
    const session = mgr.getOrCreateSession("hb-session-name", "claude");
    const out: any[] = [];
    for await (const m of buildSdkPromptWithHeartbeat("hb-session-name", "[HEARTBEAT] wake up", { _manager: mgr })) {
      out.push(m);
    }

    // Only the heartbeat — session is empty.
    expect(out.length).toBe(1);
    const hb = out[0];
    expect(hb.type).toBe("user");
    expect(hb.message.role).toBe("user");
    expect(hb.message.content[0].text).toBe("[HEARTBEAT] wake up");
    // session_id must be the UUID, not the lookup name.
    expect(hb.session_id).toBe(session.id);
    expect(hb.session_id).not.toBe("hb-session-name");
  });

  test("heartbeat and buildSdkMessages rows share the same session_id", async () => {
    const session = mgr.getOrCreateSession("shared-sid", "claude");
    addUser(session.id, "hi");

    const out: any[] = [];
    for await (const m of buildSdkPromptWithHeartbeat("shared-sid", "[HEARTBEAT]", { _manager: mgr })) {
      out.push(m);
    }

    expect(out.length).toBe(2);
    expect(out[0].session_id).toBe(session.id);
    expect(out[1].session_id).toBe(session.id);
    // Belt-and-suspenders: all messages in a single iterable share one session_id.
    expect(new Set(out.map((m) => m.session_id)).size).toBe(1);
  });

  test("omits heartbeat when heartbeatText is null/undefined/empty", async () => {
    const session = mgr.getOrCreateSession("no-hb", "claude");
    addUser(session.id, "just a user msg");

    const outNull: any[] = [];
    for await (const m of buildSdkPromptWithHeartbeat("no-hb", null, { _manager: mgr })) outNull.push(m);
    expect(outNull.length).toBe(1); // only the user msg

    const outUndef: any[] = [];
    for await (const m of buildSdkPromptWithHeartbeat("no-hb", undefined, { _manager: mgr })) outUndef.push(m);
    expect(outUndef.length).toBe(1);

    const outEmpty: any[] = [];
    for await (const m of buildSdkPromptWithHeartbeat("no-hb", "", { _manager: mgr })) outEmpty.push(m);
    expect(outEmpty.length).toBe(1); // empty string is falsy, heartbeat omitted
  });

  test("falls back to sessionName if session does not exist (defensive)", async () => {
    const out: any[] = [];
    for await (const m of buildSdkPromptWithHeartbeat("nonexistent-session", "[HEARTBEAT]", { _manager: mgr })) {
      out.push(m);
    }
    // buildSdkMessages returns early for missing sessions, so no stream rows —
    // but the heartbeat is still emitted with the name as fallback session_id.
    expect(out.length).toBe(1);
    expect(out[0].session_id).toBe("nonexistent-session");
  });
});
