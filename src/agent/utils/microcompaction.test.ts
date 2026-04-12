/**
 * Unit tests for MicroCompactor
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../api/client";
import { clearMicroCompactor, getMicroCompactor, MicroCompactor } from "./microcompaction";

// ---

const TEST_DIR = join("/tmp", "microcompaction-test-" + Date.now());

function setupDir() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function cleanupDir() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function microstatePath(): string {
  return join(TEST_DIR, "microstate.json");
}

function readMicrostate(): object | null {
  if (!existsSync(microstatePath())) return null;
  return JSON.parse(readFileSync(microstatePath(), "utf-8"));
}

beforeEach(setupDir);
afterEach(cleanupDir);

// ---

function userMsg(content: string): Message {
  return { role: "user", content };
}

function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

function toolCallMsg(name: string, id?: string): Message {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: id || `call_${name}_${Date.now()}`,
        type: "function",
        function: { name, arguments: "{}" },
      },
    ],
  };
}

function toolResultMsg(id: string, content: string): Message {
  return { role: "tool", content, tool_call_id: id };
}

function manyMessages(n: number, role: "user" | "assistant" = "user"): Message[] {
  return Array.from({ length: n }, (_, i) =>
    role === "user" ? userMsg(`user message ${i}`) : assistantMsg(`assistant reply ${i}`),
  );
}

// ---

describe("MicroCompactor", () => {
  afterEach(() => {
    clearMicroCompactor(TEST_DIR);
  });

  // ---

  describe("shouldCompact() threshold", () => {
    test("returns false when under message threshold", () => {
      const compactor = new MicroCompactor(TEST_DIR, { messageThreshold: 15 });
      compactor.onMessagesAdded(10);
      expect(compactor.shouldCompact()).toBe(false);
    });

    test("returns false when under turn threshold", () => {
      const compactor = new MicroCompactor(TEST_DIR, { turnThreshold: 10 });
      compactor.onTurn();
      compactor.onTurn();
      expect(compactor.shouldCompact()).toBe(false);
    });

    test("returns true when messagesSinceCompaction >= threshold", () => {
      const compactor = new MicroCompactor(TEST_DIR, { messageThreshold: 5 });
      compactor.onMessagesAdded(5);
      expect(compactor.shouldCompact()).toBe(true);
    });

    test("returns true when both thresholds exceeded", () => {
      const compactor = new MicroCompactor(TEST_DIR, {
        messageThreshold: 5,
        turnThreshold: 100, // large so message threshold triggers
      });
      compactor.onMessagesAdded(6);
      expect(compactor.shouldCompact()).toBe(true);
    });
  });

  // ---

  describe("compact() preserves FULL-stage messages", () => {
    test("system message (FULL stage) is always kept", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 5 });
      const msgs: Message[] = [{ role: "system", content: "system prompt" }, ...manyMessages(60)];

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(true);
      expect(result.messages.some((m) => m.role === "system")).toBe(true);
    });

    test("first user message (task definition) is kept as anchor", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 5 });
      const msgs: Message[] = [userMsg("Please implement the feature")];

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(false); // not over keepCount
      expect(result.messages[0].content).toContain("Please implement");
    });
  });

  // ---

  describe("compact() preserves tail buffer", () => {
    test("last N messages are always kept regardless of score", () => {
      const compactor = new MicroCompactor(TEST_DIR, {
        keepCount: 20,
        tailBuffer: 10,
      });
      const msgs = manyMessages(60);

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(true);

      const tailContent = msgs.slice(-10).map((m) => m.content);
      for (const content of tailContent) {
        expect(result.messages.some((m) => m.content === content)).toBe(true);
      }
    });

    test("tail buffer kept even if tail buffer overlaps with anchors", () => {
      const compactor = new MicroCompactor(TEST_DIR, {
        keepCount: 20,
        tailBuffer: 5,
      });
      const msgs = manyMessages(30);

      const result = compactor.compact(msgs);
      expect(result.messages.length).toBeGreaterThan(0);
    });
  });

  // ---

  describe("compact() preserves anchors (tool calls)", () => {
    test("assistant message with tool_calls is kept", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 10 });
      const msgs: Message[] = [
        userMsg("task"),
        ...manyMessages(20),
        toolCallMsg("readFile"),
        toolResultMsg("call_abc", "file content"),
        userMsg("done"),
      ];

      const result = compactor.compact(msgs);
      expect(result.keptCount).toBeGreaterThan(0);
    });

    test("messages with unresolved errors are kept as anchors", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 10 });
      const msgs: Message[] = [
        userMsg("task"),
        ...manyMessages(20),
        assistantMsg("ERROR: file not found"),
        userMsg("fixed it"),
      ];

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(true);
      expect(result.messages.some((m) => m.content?.includes("ERROR"))).toBe(true);
    });
  });

  // ---

  describe("compact() deletes low-score messages", () => {
    test("compact() removes old low-scoring messages", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 10 });
      const msgs = manyMessages(50);

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(true);
      expect(result.messages.length).toBeLessThan(msgs.length);
    });

    test("deletedCount reflects number of removed messages", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 10 });
      const msgs = manyMessages(50);

      const result = compactor.compact(msgs);
      expect(result.deletedCount).toBeGreaterThan(0);
      expect(result.didCompact).toBe(true);
      expect(result.keptCount).toBeGreaterThanOrEqual(msgs.length - result.deletedCount);
      expect(result.keptCount).toBeLessThanOrEqual(msgs.length - result.deletedCount + 1);
    });
  });

  // ---

  describe("compact() keeps atomic groups together", () => {
    test("tool_call + tool_result pair is kept together", () => {
      const compactor = new MicroCompactor(TEST_DIR, {
        keepCount: 5,
        tailBuffer: 3,
      });
      const msgs: Message[] = [
        assistantMsg("System: ready"),
        ...manyMessages(30), // indices 1-30 (deleted)
        toolCallMsg("writeFile", "call_write"), // index 31 — within tail (28-33)
        toolResultMsg("call_write", "wrote 100 bytes"), // index 32 — within tail (28-33)
        assistantMsg("final response"), // index 33 — within tail (28-33)
      ];

      const result = compactor.compact(msgs);
      const keptCall = result.messages.some(
        (m) => m.role === "assistant" && m.tool_calls?.some((tc) => tc.id === "call_write"),
      );
      const keptResult = result.messages.some((m) => m.role === "tool" && m.tool_call_id === "call_write");
      expect(keptCall).toBe(true);
      expect(keptResult).toBe(true);
    });
  });

  // ---

  describe("compact() injects summary when messages are deleted", () => {
    test("summary message prepended when messages are deleted", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 5 });
      const msgs: Message[] = [userMsg("initial task"), ...manyMessages(30)];

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(true);
      expect(result.deletedCount).toBeGreaterThan(0);

      const first = result.messages[0];
      expect(first.role).toBe("user");
      expect(first.content).toContain("[Compacted");
    });

    test("no summary when no messages are deleted", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 100 });
      const msgs = manyMessages(10);

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(false);
      expect(result.messages[0].content).toBe("user message 0");
    });

    test("summary mentions tools used", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 5 });
      const msgs: Message[] = [
        userMsg("task"),
        toolCallMsg("readFile", "call_1"),
        toolResultMsg("call_1", "content"),
        toolCallMsg("writeFile", "call_2"),
        toolResultMsg("call_2", "done"),
        ...manyMessages(40),
      ];

      const result = compactor.compact(msgs);
      const summary = result.messages[0].content;
      expect(summary).toContain("Tools used:");
      expect(summary).toContain("readFile");
    });
  });

  // ---

  describe("deferred compaction", () => {
    test("shouldCompact() returns false while deferred via deferCompactionUntilTurn", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 5 });
      compactor["state"].deferCompactionUntilTurn = compactor["state"].turnCount + 5;
      expect(compactor.shouldCompact()).toBe(false);
    });

    test("shouldCompact() fires after deferred turn passes", () => {
      const compactor = new MicroCompactor(TEST_DIR, {
        keepCount: 5,
        turnThreshold: 1,
      });
      compactor["state"].deferCompactionUntilTurn = compactor["state"].turnCount + 2;
      compactor.onTurn(); // turn 1
      compactor.onTurn(); // turn 2
      compactor.onTurn(); // turn 3 — now turnCount=3 > deferCompactionUntilTurn=2
      compactor.onMessagesAdded(999); // message threshold met
      expect(compactor.shouldCompact()).toBe(true);
    });
  });

  // ---

  describe("state persistence", () => {
    test("microstate.json is written after onMessagesAdded", () => {
      const compactor = new MicroCompactor(TEST_DIR);
      compactor.onMessagesAdded(5);

      const state = readMicrostate();
      expect(state).not.toBeNull();
      expect((state as any).messagesSinceCompaction).toBe(5);
    });

    test("microstate.json is written after onTurn", () => {
      const compactor = new MicroCompactor(TEST_DIR);
      compactor.onTurn();

      const state = readMicrostate();
      expect(state).not.toBeNull();
      expect((state as any).turnCount).toBe(1);
    });

    test("state is restored on new MicroCompactor instance", () => {
      const compactor1 = new MicroCompactor(TEST_DIR);
      compactor1.onMessagesAdded(8);
      compactor1.onTurn();

      const compactor2 = new MicroCompactor(TEST_DIR);
      const state = compactor2.getState();
      expect(state.messagesSinceCompaction).toBe(0);
      expect(state.turnCount).toBe(1);
    });

    test("corrupted microstate.json creates fresh state", () => {
      writeFileSync(microstatePath(), "not valid json {{{");
      mkdirSync(TEST_DIR, { recursive: true }); // ensure dir exists

      const compactor = new MicroCompactor(TEST_DIR);
      const state = compactor.getState();
      expect(state.version).toBe(1);
      expect(state.messagesSinceCompaction).toBe(0);
    });
  });

  // ---

  describe("reset()", () => {
    test("reset() clears state to defaults", () => {
      const compactor = new MicroCompactor(TEST_DIR);
      compactor.onMessagesAdded(20);
      compactor.onTurn();
      compactor.onTurn();

      compactor.reset();

      const state = compactor.getState();
      expect(state.messagesSinceCompaction).toBe(0);
      expect(state.turnCount).toBe(0);
    });

    test("reset() updates microstate.json", () => {
      const compactor = new MicroCompactor(TEST_DIR);
      compactor.onMessagesAdded(15);
      compactor.reset();

      const state = readMicrostate();
      expect((state as any).messagesSinceCompaction).toBe(0);
    });
  });

  // ---

  describe("onTurn()", () => {
    test("increments turnCount", () => {
      const compactor = new MicroCompactor(TEST_DIR);
      expect(compactor.getState().turnCount).toBe(0);

      compactor.onTurn();
      expect(compactor.getState().turnCount).toBe(1);

      compactor.onTurn();
      expect(compactor.getState().turnCount).toBe(2);
    });

    test("resets messagesSinceCompaction", () => {
      const compactor = new MicroCompactor(TEST_DIR);
      compactor.onMessagesAdded(15);
      expect(compactor.getState().messagesSinceCompaction).toBe(15);

      compactor.onTurn();
      expect(compactor.getState().messagesSinceCompaction).toBe(0);
    });
  });

  // ---

  describe("onMessagesAdded()", () => {
    test("increments messagesSinceCompaction by count", () => {
      const compactor = new MicroCompactor(TEST_DIR);
      expect(compactor.getState().messagesSinceCompaction).toBe(0);

      compactor.onMessagesAdded(3);
      expect(compactor.getState().messagesSinceCompaction).toBe(3);

      compactor.onMessagesAdded(5);
      expect(compactor.getState().messagesSinceCompaction).toBe(8);
    });

    test("accumulates across multiple calls", () => {
      const compactor = new MicroCompactor(TEST_DIR);
      compactor.onMessagesAdded(2);
      compactor.onMessagesAdded(2);
      compactor.onMessagesAdded(2);
      expect(compactor.getState().messagesSinceCompaction).toBe(6);
    });
  });

  // ---

  describe("compact() respects keepCount", () => {
    test("returns didCompact=false when messages <= keepCount", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 50 });
      const msgs = manyMessages(30);

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(false);
      expect(result.keptCount).toBe(30);
      expect(result.deletedCount).toBe(0);
    });

    test("compacts when messages > keepCount", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 10 });
      const msgs = manyMessages(30);

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(true);
      expect(result.keptCount).toBeLessThan(30);
    });
  });

  // ---

  describe("edge cases", () => {
    test("compact() handles empty array without crashing", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 10 });
      const result = compactor.compact([]);
      expect(result.didCompact).toBe(false);
      expect(result.messages).toEqual([]);
      expect(result.keptCount).toBe(0);
      expect(result.deletedCount).toBe(0);
    });

    test("compact() handles single message without crashing", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 10 });
      const msgs = [userMsg("only message")];
      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(false);
      expect(result.messages).toEqual(msgs);
    });

    test("compact() handles messages equal to keepCount without compaction", () => {
      const compactor = new MicroCompactor(TEST_DIR, {
        keepCount: 40,
        tailBuffer: 10,
      });
      const msgs = manyMessages(40);
      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(false);
      expect(result.messages.length).toBe(40);
    });
  });

  // ---

  describe("role alternation repair", () => {
    test("summary + user message are merged (consecutive same role)", () => {
      // With 21 total messages, early messages (i=1-4) score ~56-59 → COMPRESSED (< FULL threshold 60)
      // keepCount=15, tailBuffer=1 → tailStart=20. Only index 20 is in tail.
      // Kept: {0 (system), 5-20} = 17 messages + summary = 18 before repair
      // After repair: summary(user) + tail_user(user) → merged → 17 messages
      const compactor = new MicroCompactor(TEST_DIR, {
        keepCount: 15,
        tailBuffer: 1,
      });
      const msgs: Message[] = [
        { role: "system" as const, content: "system" },
        ...manyMessages(20), // indices 1-20
      ];

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(true);
      expect(result.deletedCount).toBeGreaterThan(0);
      // After role alternation repair: summary (user) merged with tail user (user) → 1 message
      expect(result.messages.length).toBeLessThan(msgs.length);
      // Check no consecutive user messages at start (summary merged with tail user)
      let consecutiveUser = 0;
      for (const msg of result.messages) {
        if (msg.role === "user") consecutiveUser++;
        else break;
      }
      expect(consecutiveUser).toBeLessThanOrEqual(1);
    });

    test("compaction preserves valid role alternation when no merging needed", () => {
      const compactor = new MicroCompactor(TEST_DIR, {
        keepCount: 5,
        tailBuffer: 4,
      });
      const msgs: Message[] = [
        userMsg("task A"),
        assistantMsg("response A"),
        userMsg("task B"),
        assistantMsg("response B"),
        toolCallMsg("read", "c1"),
        toolResultMsg("c1", "content"),
        assistantMsg("response C"),
        userMsg("task C"),
      ];

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(true);
      // Should not crash and should produce valid compacted output
      expect(result.messages.length).toBeGreaterThan(0);
    });
  });

  // ---

  describe("keptCount semantics", () => {
    test("keptCount is the final compacted array length (including summary)", () => {
      const compactor = new MicroCompactor(TEST_DIR, { keepCount: 5 });
      const msgs: Message[] = [
        userMsg("old1"),
        userMsg("old2"),
        userMsg("old3"),
        userMsg("old4"),
        userMsg("old5"),
        userMsg("old6"), // 6 messages, > keepCount=5, so compaction runs
      ];

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(true);
      // keptCount = number of messages in final compacted array
      expect(result.keptCount).toBe(result.messages.length);
      // deletedCount = original length - keptCount + 1 (for summary)
      // But in this case, many messages are kept due to tail buffer, so keptCount may be > keepCount
      expect(result.keptCount).toBeGreaterThan(0);
    });

    test("keptCount can exceed keepCount when tailBuffer + anchors preserve more messages", () => {
      const compactor = new MicroCompactor(TEST_DIR, {
        keepCount: 5,
        tailBuffer: 20,
      });
      const msgs = manyMessages(30);

      const result = compactor.compact(msgs);
      expect(result.didCompact).toBe(true);
      // tailBuffer=20 means last 20 messages are always kept
      // So keptCount >= tailBuffer, which exceeds keepCount=5
      expect(result.keptCount).toBeGreaterThanOrEqual(20);
    });
  });

  // ---

  describe("custom config", () => {
    test("custom messageThreshold changes compaction trigger", () => {
      const compactor = new MicroCompactor(TEST_DIR, { messageThreshold: 3 });
      compactor.onMessagesAdded(3);
      expect(compactor.shouldCompact()).toBe(true);
    });

    test("custom tailBuffer changes how many recent messages are always kept", () => {
      const compactor = new MicroCompactor(TEST_DIR, {
        keepCount: 10,
        tailBuffer: 20,
      });
      const msgs = manyMessages(50);

      const result = compactor.compact(msgs);
      // Last 20 messages should be preserved
      const tailContent = msgs.slice(-20).map((m) => m.content);
      for (const content of tailContent) {
        expect(result.messages.some((m) => m.content === content)).toBe(true);
      }
    });
  });
});

// ── Module-level factory tests ─────────────────────────────────────────────────

describe("getMicroCompactor factory", () => {
  const SESSION_A = join("/tmp", "mc-factory-a-" + Date.now());
  const SESSION_B = join("/tmp", "mc-factory-b-" + Date.now());

  afterEach(() => {
    clearMicroCompactor(SESSION_A);
    clearMicroCompactor(SESSION_B);
  });

  test("returns same instance for same sessionDir", () => {
    const a1 = getMicroCompactor(SESSION_A);
    const a2 = getMicroCompactor(SESSION_A);
    expect(a1).toBe(a2);
  });

  test("returns different instances for different sessionDirs", () => {
    const a = getMicroCompactor(SESSION_A);
    const b = getMicroCompactor(SESSION_B);
    expect(a).not.toBe(b);
  });

  test("factory instances share microstate with direct constructor", () => {
    mkdirSync(SESSION_A, { recursive: true });
    const factory = getMicroCompactor(SESSION_A);
    factory.onMessagesAdded(7);

    const direct = new MicroCompactor(SESSION_A);
    expect(direct.getState().messagesSinceCompaction).toBe(7);
  });

  test("clearMicroCompactor removes instance", () => {
    const a1 = getMicroCompactor(SESSION_A);
    clearMicroCompactor(SESSION_A);
    const a2 = getMicroCompactor(SESSION_A);
    expect(a2).not.toBe(a1);
  });
});
