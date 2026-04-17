/**
 * Tests for bridgeConversationSummary — forced summary generation on risky
 * config changes (provider/model/project/agent_type). Dependencies (SessionManager
 * + summarizer) are injected via `opts` to keep tests fast, hermetic, and free
 * of real API traffic.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { agentSessionName, bridgeConversationSummary, formatRowsForSummary } from "./bridge-summary";
import { SessionManager } from "./manager";

let mgr: SessionManager;
beforeEach(() => {
  mgr = new SessionManager(":memory:");
});

describe("agentSessionName", () => {
  test("sanitizes non-alphanumeric chars in agent id", () => {
    expect(agentSessionName("chan-1", "My Agent.2")).toBe("chan-1-My_Agent_2");
  });

  test("matches the canonical form used by CC and non-CC workers", () => {
    expect(agentSessionName("test-260418", "Tuan")).toBe("test-260418-Tuan");
  });
});

describe("formatRowsForSummary", () => {
  test("emits [user]/[you]/[tool-result] lines", () => {
    const rows = [
      {
        id: 1,
        session_id: "s",
        role: "user",
        content: "[100] human: hi",
        tool_calls: null,
        tool_call_id: null,
        created_at: 100,
      },
      {
        id: 2,
        session_id: "s",
        role: "assistant",
        content: "sure, on it",
        tool_calls: null,
        tool_call_id: null,
        created_at: 101,
      },
      {
        id: 3,
        session_id: "s",
        role: "tool",
        content: "result body",
        tool_calls: null,
        tool_call_id: "call_1",
        created_at: 102,
      },
    ];
    const lines = formatRowsForSummary(rows as any);
    expect(lines).toEqual(["[user]: [100] human: hi", "[you]: sure, on it", "[tool-result]: result body"]);
  });

  test("renders a prior [CONTEXT SUMMARY] row verbatim so the new summary incorporates it", () => {
    const rows = [
      {
        id: 1,
        session_id: "s",
        role: "user",
        content: "[CONTEXT SUMMARY] old summary",
        tool_calls: null,
        tool_call_id: null,
        created_at: 0,
      },
      {
        id: 2,
        session_id: "s",
        role: "user",
        content: "[200] human: new",
        tool_calls: null,
        tool_call_id: null,
        created_at: 200,
      },
    ];
    const lines = formatRowsForSummary(rows as any);
    expect(lines[0]).toBe("[CONTEXT SUMMARY] old summary");
    expect(lines[1]).toBe("[user]: [200] human: new");
  });

  test("handles tool-use-only assistant rows (empty content + tool_calls JSON)", () => {
    const rows = [
      {
        id: 1,
        session_id: "s",
        role: "assistant",
        content: "",
        tool_calls: '[{"id":"x"}]',
        tool_call_id: null,
        created_at: 100,
      },
    ];
    const lines = formatRowsForSummary(rows as any);
    expect(lines).toEqual(["[you]: (used tools)"]);
  });
});

describe("bridgeConversationSummary", () => {
  test("returns false + does nothing when session does not exist", async () => {
    const result = await bridgeConversationSummary("ch", "nobody", "sonnet", { _manager: mgr });
    expect(result).toBe(false);
  });

  test("returns false + skips LLM call when session has only an existing summary (no real rows)", async () => {
    const session = mgr.createSession(agentSessionName("ch", "ag"), "m");
    mgr.setConversationSummary(session.id, "old summary");

    let summarizerCalled = false;
    const result = await bridgeConversationSummary("ch", "ag", "sonnet", {
      _manager: mgr,
      _summarize: async () => {
        summarizerCalled = true;
        return "new";
      },
    });
    expect(result).toBe(false);
    expect(summarizerCalled).toBe(false);
  });

  test("calls LLM and writes summary when session has real content", async () => {
    const session = mgr.createSession(agentSessionName("ch", "ag2"), "m");
    mgr.addMessage(session.id, { role: "user", content: "[100] human: hello" });
    mgr.addMessage(session.id, { role: "assistant", content: "hi there" });

    let seenModel: string | undefined;
    const result = await bridgeConversationSummary("ch", "ag2", "sonnet", {
      _manager: mgr,
      _summarize: async (_text, _count, model) => {
        seenModel = model;
        return "Agent said hi after human greeted.";
      },
    });
    expect(result).toBe(true);
    expect(seenModel).toBe("sonnet");

    const summaries = mgr.getCompactionSummariesByName(agentSessionName("ch", "ag2"));
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain("Agent said hi after human greeted.");
    // Real rows are untouched (bridge does NOT delete history).
    expect(mgr.getMessages(session.id).length).toBe(3); // summary + 2 originals
  });

  test("incorporates a prior summary into the new one (feeds it into the LLM input)", async () => {
    const session = mgr.createSession(agentSessionName("ch", "ag3"), "m");
    mgr.setConversationSummary(session.id, "Turn 1: greeted.");
    mgr.addMessage(session.id, { role: "user", content: "[200] human: what next?" });

    let llmInput = "";
    const ok = await bridgeConversationSummary("ch", "ag3", "sonnet", {
      _manager: mgr,
      _summarize: async (text) => {
        llmInput = text;
        return "Turn 1: greeted. Turn 2: user asked what's next.";
      },
    });
    expect(ok).toBe(true);
    expect(llmInput).toContain("Turn 1: greeted.");
    expect(llmInput).toContain("[200] human: what next?");
    void session;
  });

  test("returns false on LLM failure, leaves previous summary intact", async () => {
    const session = mgr.createSession(agentSessionName("ch", "ag4"), "m");
    mgr.setConversationSummary(session.id, "Old summary survives.");
    mgr.addMessage(session.id, { role: "user", content: "new msg" });

    const ok = await bridgeConversationSummary("ch", "ag4", "sonnet", {
      _manager: mgr,
      _summarize: async () => {
        throw new Error("LLM timeout");
      },
    });
    expect(ok).toBe(false);

    const summaries = mgr.getCompactionSummariesByName(agentSessionName("ch", "ag4"));
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain("Old summary survives.");
    void session;
  });

  test("returns false when LLM returns empty string (doesn't overwrite with garbage)", async () => {
    const session = mgr.createSession(agentSessionName("ch", "ag5"), "m");
    mgr.setConversationSummary(session.id, "Old summary.");
    mgr.addMessage(session.id, { role: "user", content: "new" });

    const ok = await bridgeConversationSummary("ch", "ag5", undefined, {
      _manager: mgr,
      _summarize: async () => "   ",
    });
    expect(ok).toBe(false);
    const summaries = mgr.getCompactionSummariesByName(agentSessionName("ch", "ag5"));
    expect(summaries[0]).toContain("Old summary.");
    void session;
  });
});
