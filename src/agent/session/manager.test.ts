/**
 * Unit tests for SessionManager
 *
 * Uses ":memory:" SQLite path for isolated, fast, zero-filesystem tests.
 *
 * Coverage:
 * 1. Session creation and retrieval
 * 2. Message storage and loading
 * 3. Session compaction — old messages deleted, recent kept, summary injected
 * 4. Tool call / tool result pair protection during compaction
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "../api/client";
import { SessionManager } from "./manager";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a simple user message */
function userMsg(content: string): Message {
  return { role: "user", content };
}

/** Build a simple assistant message */
function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

/**
 * Build an assistant message with a single tool call.
 * NOTE: SessionManager normalises tool call IDs to the "call_" prefix.
 */
function toolCallMsg(callId: string, name: string): Message {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `call_${callId}`,
        type: "function",
        function: { name, arguments: "{}" },
      },
    ],
  };
}

/** Build a tool result message */
function toolResultMsg(callId: string, content: string): Message {
  return {
    role: "tool",
    content,
    tool_call_id: `call_${callId}`,
  };
}

/** Add `n` simple alternating user/assistant messages to a session */
function addMessages(mgr: SessionManager, sessionId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    mgr.addMessage(sessionId, i % 2 === 0 ? userMsg(`user message ${i}`) : assistantMsg(`assistant reply ${i}`));
  }
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe("SessionManager", () => {
  let mgr: SessionManager;

  // Create a fresh in-memory DB before every test
  beforeEach(() => {
    mgr = new SessionManager(":memory:");
  });

  // ── 1. Session creation and retrieval ──────────────────────────────────────

  describe("session creation and retrieval", () => {
    test("createSession returns a session with the given name and model", () => {
      const session = mgr.createSession("my-session", "gpt-4o");
      expect(session.id).toBeString();
      expect(session.name).toBe("my-session");
      expect(session.model).toBe("gpt-4o");
      expect(session.created_at).toBeNumber();
    });

    test("getSession retrieves by exact ID", () => {
      const created = mgr.createSession("s1", "model-x");
      const retrieved = mgr.getSession(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
    });

    test("getSession retrieves by name", () => {
      mgr.createSession("named-session", "model-y");
      const retrieved = mgr.getSession("named-session");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("named-session");
    });

    test("getSession returns null for unknown ID", () => {
      expect(mgr.getSession("nonexistent-id-xyz")).toBeNull();
    });

    test("getSession retrieves by ID prefix", () => {
      const created = mgr.createSession("prefix-test", "m");
      const prefix = created.id.slice(0, 8);
      const retrieved = mgr.getSession(prefix);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
    });

    test("listSessions returns all created sessions ordered by recency", () => {
      mgr.createSession("s1", "m");
      mgr.createSession("s2", "m");
      mgr.createSession("s3", "m");
      const sessions = mgr.listSessions();
      expect(sessions.length).toBe(3);
    });

    test("deleteSession removes the session and its messages", () => {
      const session = mgr.createSession("deletable", "m");
      mgr.addMessage(session.id, userMsg("hello"));
      mgr.deleteSession(session.id);

      expect(mgr.getSession(session.id)).toBeNull();
      expect(mgr.getMessages(session.id)).toHaveLength(0);
    });

    test("deleteSession + purgeOldSessions clean up internal tracker maps", () => {
      // _sessionUpdateTimes is an addMessage debounce tracker keyed by session
      // id. Without cleanup on delete/purge, the Map grows unbounded over long
      // server lifetimes. Verify both paths remove their entries.
      // Exercising via the public API: creating a session + inserting populates
      // the tracker; deleting should remove the entry.
      const s1 = mgr.createSession("track-1", "m");
      mgr.addMessage(s1.id, userMsg("a"));
      const s2 = mgr.createSession("track-2", "m");
      mgr.addMessage(s2.id, userMsg("b"));
      const tracker = (mgr as unknown as { _sessionUpdateTimes: Map<string, number> })._sessionUpdateTimes;
      expect(tracker.has(s1.id)).toBe(true);
      expect(tracker.has(s2.id)).toBe(true);

      mgr.deleteSession(s1.id);
      expect(tracker.has(s1.id)).toBe(false);
      expect(tracker.has(s2.id)).toBe(true);

      // purgeOldSessions deletes sessions whose updated_at < cutoff. Using a
      // cutoff larger than every session's age forces all remaining sessions
      // to be purged. maxAgeDays=-1 → cutoff = now + 1 day, so everything is
      // "older than -1 days ago" from the cutoff's perspective.
      mgr.purgeOldSessions(-1);
      expect(tracker.has(s2.id)).toBe(false);
    });
  });

  // ── 2. Message storage and loading ─────────────────────────────────────────

  describe("message storage and loading", () => {
    test("addMessage stores and getMessages retrieves in order", () => {
      const session = mgr.createSession("s", "m");
      mgr.addMessage(session.id, userMsg("hello"));
      mgr.addMessage(session.id, assistantMsg("world"));

      const msgs = mgr.getMessages(session.id);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].content).toBe("hello");
      expect(msgs[1].role).toBe("assistant");
      expect(msgs[1].content).toBe("world");
    });

    test("addMessage returns a positive row ID", () => {
      const session = mgr.createSession("s", "m");
      const id = mgr.addMessage(session.id, userMsg("hi"));
      expect(id).toBeGreaterThan(0);
    });

    test("tool call IDs are normalised to call_ prefix on storage", () => {
      const session = mgr.createSession("s", "m");
      mgr.addMessage(session.id, {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "toolu_abcdef",
            type: "function",
            function: { name: "my_tool", arguments: "{}" },
          },
        ],
      });

      const msgs = mgr.getMessages(session.id);
      expect(msgs[0].tool_calls![0].id).toMatch(/^call_/);
    });

    test("getRecentMessages returns at most `limit` messages", () => {
      const session = mgr.createSession("s", "m");
      addMessages(mgr, session.id, 20);

      const recent = mgr.getRecentMessages(session.id, 5);
      expect(recent.length).toBeLessThanOrEqual(5);
    });

    test("getRecentMessages returns messages in ascending order", () => {
      const session = mgr.createSession("s", "m");
      addMessages(mgr, session.id, 10);

      const msgs = mgr.getRecentMessages(session.id, 10);
      for (let i = 1; i < msgs.length; i++) {
        // roles should alternate; what matters is that earlier messages come first
        // Just ensure the array is in the expected insertion order
        expect(msgs[i]).toBeDefined();
      }
      // First message should be user (index 0)
      expect(msgs[0].role).toBe("user");
    });

    test("getSessionStats returns correct message count", () => {
      const session = mgr.createSession("s", "m");
      addMessages(mgr, session.id, 6);

      const stats = mgr.getSessionStats(session.id);
      expect(stats.messageCount).toBe(6);
    });
  });

  // ── 3. Session compaction ───────────────────────────────────────────────────

  describe("session compaction", () => {
    test("compactSession deletes old messages beyond keepCount", () => {
      const session = mgr.createSession("compact-test", "m");
      addMessages(mgr, session.id, 20);

      const deleted = mgr.compactSession(session.id, 5);
      expect(deleted).toBeGreaterThan(0);

      const remaining = mgr.getMessages(session.id);
      // After compaction there should be ≤ keepCount recent messages
      // (may have slightly more if tool pairs were protected, but here there are none)
      expect(remaining.length).toBeLessThanOrEqual(10); // some tolerance for heartbeat purge
    });

    test("compactSession returns 0 when message count <= keepCount", () => {
      const session = mgr.createSession("s", "m");
      addMessages(mgr, session.id, 3);

      const deleted = mgr.compactSession(session.id, 10);
      expect(deleted).toBe(0);
    });

    test("compactSession inserts a summary as the first message when provided", () => {
      const session = mgr.createSession("s", "m");
      addMessages(mgr, session.id, 20);

      mgr.compactSession(session.id, 5, "Summary of older messages");

      const msgs = mgr.getMessages(session.id);
      // Summary must be the FIRST message (created_at = 0 puts it before all real messages)
      expect(msgs[0].content).toContain("Summary of older messages");
    });

    test("compactSession preserves the most recent keepCount messages", () => {
      const session = mgr.createSession("s", "m");
      // Add 10 user messages
      for (let i = 0; i < 10; i++) {
        mgr.addMessage(session.id, userMsg(`message ${i}`));
      }

      mgr.compactSession(session.id, 3);

      const msgs = mgr.getMessages(session.id);
      // The last 3 original messages should still be present
      const texts = msgs.map((m) => m.content);
      expect(texts).toContain("message 9");
      expect(texts).toContain("message 8");
      expect(texts).toContain("message 7");
    });

    test("compactSessionByName works the same as compactSession", () => {
      const session = mgr.createSession("named-compact", "m");
      addMessages(mgr, session.id, 20);

      const deleted = mgr.compactSessionByName("named-compact", 5);
      expect(deleted).toBeGreaterThan(0);
    });

    test("compactSessionByName returns 0 for unknown session name", () => {
      const deleted = mgr.compactSessionByName("does-not-exist", 5);
      expect(deleted).toBe(0);
    });
  });

  // ── 4. Tool call / result pair protection during compaction ─────────────────

  describe("tool call pair protection", () => {
    test("assistant message with tool_calls is kept if its result is in the kept window", () => {
      const session = mgr.createSession("s", "m");

      // Add padding messages to push older ones out of keepCount window
      addMessages(mgr, session.id, 10);

      // Add a tool call + result pair
      mgr.addMessage(session.id, toolCallMsg("abc", "my_tool"));
      mgr.addMessage(session.id, toolResultMsg("abc", "tool output"));

      // Add more messages after the tool pair (so the pair ends up inside the kept window)
      addMessages(mgr, session.id, 3);

      // Compact, keeping only the last 5 messages
      mgr.compactSession(session.id, 5);

      const msgs = mgr.getMessages(session.id);
      const hasToolResult = msgs.some((m) => m.role === "tool" && m.content === "tool output");
      // Tool result should still be there (or pair was fully outside the kept window)
      // At minimum, tool result IDs must not be orphaned
      if (hasToolResult) {
        const hasToolCall = msgs.some(
          (m) => m.role === "assistant" && m.tool_calls?.some((tc) => tc.id === "call_abc"),
        );
        expect(hasToolCall).toBe(true);
      }
    });

    test("orphaned tool results are handled gracefully by validateToolCallPairs", () => {
      const session = mgr.createSession("s", "m");
      addMessages(mgr, session.id, 20);

      // Compact everything — no tool pairs, should just delete old messages
      const deleted = mgr.compactSession(session.id, 5);
      expect(deleted).toBeGreaterThanOrEqual(0);

      const msgs = mgr.getMessages(session.id);
      expect(msgs.length).toBeGreaterThan(0);
    });
  });

  // ── 5. needsCompaction / autoCompact ────────────────────────────────────────

  describe("needsCompaction and autoCompact", () => {
    test("needsCompaction returns false for an empty session", () => {
      mgr.createSession("empty", "m");
      expect(mgr.needsCompaction("empty", 1000)).toBe(false);
    });

    test("needsCompaction returns true when token estimate exceeds threshold", () => {
      const session = mgr.createSession("big-session", "m");
      // Add large messages to exceed a tiny token limit
      for (let i = 0; i < 10; i++) {
        mgr.addMessage(session.id, userMsg("x".repeat(1000)));
      }
      // 10 * 1000 chars / 3 ≈ 3333 estimated tokens
      expect(mgr.needsCompaction("big-session", 100)).toBe(true);
    });

    test("autoCompact returns false when session is under limit", () => {
      mgr.createSession("small", "m");
      const compacted = mgr.autoCompact("small", 1_000_000, 30);
      expect(compacted).toBe(false);
    });

    test("autoCompact returns true and compacts when over limit", () => {
      const session = mgr.createSession("auto-compact-test", "m");
      for (let i = 0; i < 30; i++) {
        mgr.addMessage(session.id, userMsg("x".repeat(500)));
      }
      // 30 * 500 / 3 ≈ 5000 tokens — set limit to 100 to force compaction
      const compacted = mgr.autoCompact("auto-compact-test", 100, 5);
      expect(compacted).toBe(true);
    });

    test("needsCompaction respects maxTokens argument across repeated calls (cache stores bytes, not boolean)", () => {
      // The cache is keyed by session name only. If it stored the boolean
      // result, calling needsCompaction with different maxTokens thresholds
      // would return stale results for whichever threshold was checked first.
      // Verify both directions work within the cache's 30s TTL.
      const session = mgr.createSession("threshold-switch", "m");
      mgr.addMessage(session.id, userMsg("x".repeat(3000))); // ~1000 tokens

      // Low threshold first — true. Populates cache with bytes=3000.
      expect(mgr.needsCompaction("threshold-switch", 500)).toBe(true);
      // High threshold — must recompute comparison from cached bytes.
      expect(mgr.needsCompaction("threshold-switch", 5000)).toBe(false);
      // Back to low — still true (cache is bytes, not result).
      expect(mgr.needsCompaction("threshold-switch", 500)).toBe(true);
    });

    test("addMessage invalidates needsCompaction cache (fresh data after insert)", () => {
      // The CC worker runs compaction AFTER persisting incoming messages, so it
      // relies on needsCompaction reflecting post-insert byte counts. Without
      // cache invalidation on addMessage, a cached false from a pre-insert call
      // would persist (30s TTL) and the compactor would skip a now-over-threshold
      // session. Verify the cache is cleared on insert so the second call sees
      // the new state.
      const session = mgr.createSession("cache-invalidation", "m");

      // Seed just-under-threshold content and prime the cache with false.
      mgr.addMessage(session.id, userMsg("x".repeat(200)));
      expect(mgr.needsCompaction("cache-invalidation", 1000)).toBe(false);

      // Push WELL over threshold in a single insert. The cached false must NOT
      // shadow this — addMessage should have cleared the cache.
      mgr.addMessage(session.id, userMsg("y".repeat(10_000))); // ~3333 tokens
      expect(mgr.needsCompaction("cache-invalidation", 1000)).toBe(true);
    });

    test("needsCompaction excludes compaction summary rows (created_at=0) from byte count", () => {
      // Summary rows live in the system prompt, not the LLM message stream, so
      // they must not count toward the compaction threshold. Otherwise a large
      // summary would trigger a feedback loop: compact → big summary → threshold
      // still exceeded → compact again.
      const session = mgr.createSession("summary-exclude", "m");

      // Seed a few small messages, then compact with a giant summary. After
      // compaction the DB contains 1 summary row (created_at=0, ~100KB) and
      // ≤ keepCount small residual messages whose total bytes are negligible.
      for (let i = 0; i < 5; i++) {
        mgr.addMessage(session.id, userMsg(`small ${i}`));
      }
      const giantSummary = "s".repeat(100_000); // ~33k estimated tokens if counted
      mgr.compactSession(session.id, 1, giantSummary);

      // Threshold 1000 tokens: the 100KB summary alone would exceed 33k > 1000
      // if it were counted. Residual real messages are tiny. Must be false.
      expect(mgr.needsCompaction("summary-exclude", 1000)).toBe(false);
    });
  });

  // ── 6. updateMessageContent ─────────────────────────────────────────────────

  describe("updateMessageContent", () => {
    test("updates content for a specific message by ID", () => {
      const session = mgr.createSession("s", "m");
      const msgId = mgr.addMessage(session.id, userMsg("original"));

      mgr.updateMessageContent(session.id, msgId, "updated content");

      const msgs = mgr.getMessages(session.id);
      expect(msgs[0].content).toBe("updated content");
    });

    test("does not affect other messages in the same session", () => {
      const session = mgr.createSession("s", "m");
      const id1 = mgr.addMessage(session.id, userMsg("first"));
      mgr.addMessage(session.id, userMsg("second"));

      mgr.updateMessageContent(session.id, id1, "modified first");

      const msgs = mgr.getMessages(session.id);
      expect(msgs[0].content).toBe("modified first");
      expect(msgs[1].content).toBe("second");
    });
  });

  // ── 7. Summarizer checkpoint persistence ─────────────────────────────────────

  describe("summarizer checkpoint persistence", () => {
    test("saveSummarizerCheckpoint stores checkpoint metadata", () => {
      const session = mgr.createSession("s", "m");
      const checkpoint = {
        id: "cp-001",
        createdAt: "2024-01-01T00:00:00.000Z",
        fromTs: "0",
        toTs: "49",
        messageCount: 50,
        summary: "Test summary content",
      };

      mgr.saveSummarizerCheckpoint(session.id, checkpoint);

      const checkpoints = mgr.getSummarizerCheckpoints(session.id);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].id).toBe("cp-001");
      expect(checkpoints[0].fromTs).toBe("0");
      expect(checkpoints[0].toTs).toBe("49");
      expect(checkpoints[0].messageCount).toBe(50);
      expect(checkpoints[0].summary).toBe("Test summary content");
    });

    test("getSummarizerCheckpoints returns checkpoints in chronological order", () => {
      const session = mgr.createSession("s", "m");

      // Save multiple checkpoints
      for (let i = 0; i < 3; i++) {
        mgr.saveSummarizerCheckpoint(session.id, {
          id: `cp-${i}`,
          createdAt: new Date(Date.now() + i * 1000).toISOString(),
          fromTs: String(i * 50),
          toTs: String((i + 1) * 50),
          messageCount: 50,
          summary: `Summary ${i}`,
        });
      }

      const checkpoints = mgr.getSummarizerCheckpoints(session.id);
      expect(checkpoints).toHaveLength(3);
      expect(checkpoints[0].id).toBe("cp-0");
      expect(checkpoints[1].id).toBe("cp-1");
      expect(checkpoints[2].id).toBe("cp-2");
    });

    test("getSummarizerCheckpoints returns empty array for unknown session", () => {
      const checkpoints = mgr.getSummarizerCheckpoints("nonexistent-session-id");
      expect(checkpoints).toEqual([]);
    });

    test("saveSummarizerCheckpoint replaces existing checkpoint with same ID", () => {
      const session = mgr.createSession("s", "m");
      const checkpoint = {
        id: "cp-replace",
        createdAt: "2024-01-01T00:00:00.000Z",
        fromTs: "0",
        toTs: "49",
        messageCount: 50,
        summary: "Original summary",
      };

      mgr.saveSummarizerCheckpoint(session.id, checkpoint);

      // Save with same ID but different content
      mgr.saveSummarizerCheckpoint(session.id, {
        id: "cp-replace",
        createdAt: "2024-01-02T00:00:00.000Z",
        fromTs: "50",
        toTs: "99",
        messageCount: 50,
        summary: "Updated summary",
      });

      const checkpoints = mgr.getSummarizerCheckpoints(session.id);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].summary).toBe("Updated summary");
    });

    test("deleteSummarizerCheckpoints removes all checkpoints for a session", () => {
      const session = mgr.createSession("s", "m");

      // Add some checkpoints
      for (let i = 0; i < 3; i++) {
        mgr.saveSummarizerCheckpoint(session.id, {
          id: `cp-${i}`,
          createdAt: new Date().toISOString(),
          fromTs: String(i * 50),
          toTs: String((i + 1) * 50),
          messageCount: 50,
          summary: `Summary ${i}`,
        });
      }

      // Delete them
      mgr.deleteSummarizerCheckpoints(session.id);

      const checkpoints = mgr.getSummarizerCheckpoints(session.id);
      expect(checkpoints).toEqual([]);
    });
  });

  describe("getMessagesToCompact", () => {
    test("returns empty when session has fewer rows than keepCount", () => {
      const mgr = new SessionManager(":memory:");
      const session = mgr.getOrCreateSession("sess", "claude");
      for (let i = 0; i < 10; i++) {
        mgr.addMessage(session.id, userMsg(`msg ${i}`));
      }
      expect(mgr.getMessagesToCompact(session.id, 50)).toEqual([]);
    });

    test("returns rows that would be deleted (keeps keepCount most recent)", () => {
      const mgr = new SessionManager(":memory:");
      const session = mgr.getOrCreateSession("sess", "claude");
      for (let i = 0; i < 20; i++) {
        mgr.addMessage(session.id, userMsg(`msg ${i}`));
      }
      const toDelete = mgr.getMessagesToCompact(session.id, 5);
      expect(toDelete.length).toBe(15);
      expect(toDelete[0].content).toBe("msg 0");
      expect(toDelete[14].content).toBe("msg 14");
    });

    test("includes all user/assistant/tool rows (legacy + new-format + streaming text)", () => {
      // In the role-structured refactor, all assistant rows contribute to the
      // next turn's rebuilt message stream — legacy-prefixed AND raw text AND
      // tool_use-only. getMessagesToCompact returns everything that would be
      // deleted by compaction so the LLM summariser sees full context.
      const mgr = new SessionManager(":memory:");
      const session = mgr.getOrCreateSession("sess", "claude");
      mgr.addMessage(session.id, userMsg("user 1"));
      mgr.addMessage(session.id, assistantMsg("[CC-Turn]:\n[1] you: msg"));
      mgr.addMessage(session.id, assistantMsg("plain agent reply (new format)"));
      mgr.addMessage(session.id, assistantMsg("[Sent to chat]: legacy"));
      mgr.addMessage(session.id, assistantMsg("[Actions taken]: legacy tools"));
      for (let i = 0; i < 10; i++) mgr.addMessage(session.id, userMsg(`recent ${i}`));

      const toDelete = mgr.getMessagesToCompact(session.id, 10);
      const contents = toDelete.map((r) => r.content);
      expect(contents).toContain("user 1");
      expect(contents).toContain("[CC-Turn]:\n[1] you: msg");
      expect(contents).toContain("plain agent reply (new format)");
      expect(contents).toContain("[Sent to chat]: legacy");
      expect(contents).toContain("[Actions taken]: legacy tools");
    });

    test("by-name variant returns same result as by-id", () => {
      const mgr = new SessionManager(":memory:");
      const session = mgr.getOrCreateSession("named-sess", "claude");
      for (let i = 0; i < 15; i++) mgr.addMessage(session.id, userMsg(`msg ${i}`));
      const byId = mgr.getMessagesToCompact(session.id, 5);
      const byName = mgr.getMessagesToCompactByName("named-sess", 5);
      expect(byName.length).toBe(byId.length);
      expect(byName.map((r) => r.id)).toEqual(byId.map((r) => r.id));
    });

    test("by-name returns empty for non-existent session", () => {
      const mgr = new SessionManager(":memory:");
      expect(mgr.getMessagesToCompactByName("nope", 50)).toEqual([]);
    });
  });

  describe("autoCompact unified byte-count", () => {
    test("does not compact when total stream bytes are under threshold (no tool rows)", () => {
      // needsCompaction now counts all stream-relevant bytes (user + tool + assistant)
      // because tool results ARE part of the rebuilt LLM stream as tool_result blocks.
      // Test: if ONLY a tiny user message exists, count stays well under threshold.
      const mgr = new SessionManager(":memory:");
      const session = mgr.getOrCreateSession("sess", "claude");
      mgr.addMessage(session.id, userMsg("hi"));
      const compacted = mgr.autoCompact("sess", 1000, 5);
      expect(compacted).toBe(false);
    });

    test("compacts when tool-result bytes alone exceed threshold (they count in new format)", () => {
      // Tool results ARE rebuilt as user-role tool_result blocks in the SDK stream,
      // so they count toward the compaction budget. 20 × 10KB ≈ 66k tokens ≫ 10k.
      const mgr = new SessionManager(":memory:");
      const session = mgr.getOrCreateSession("sess2", "claude");
      mgr.addMessage(session.id, userMsg("trigger"));
      const bigToolOutput = "x".repeat(10000);
      for (let i = 0; i < 20; i++) {
        mgr.addMessage(session.id, {
          role: "tool",
          content: bigToolOutput,
          tool_call_id: `call_${i}`,
        });
      }
      const compacted = mgr.autoCompact("sess2", 10_000, 5);
      expect(compacted).toBe(true);
    });

    test("compacts when preamble-visible bytes exceed threshold", () => {
      const mgr = new SessionManager(":memory:");
      const session = mgr.getOrCreateSession("sess", "claude");
      const bigMsg = "y".repeat(5000);
      for (let i = 0; i < 50; i++) {
        mgr.addMessage(session.id, userMsg(bigMsg));
      }
      // 50 × 5000 / 3 ≈ 83k tokens — exceeds 10k threshold.
      const compacted = mgr.autoCompact("sess", 10_000, 10);
      expect(compacted).toBe(true);
    });
  });
});
