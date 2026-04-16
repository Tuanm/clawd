/**
 * Unit tests for addReaction and removeReaction in messages.ts.
 *
 * Uses an in-memory SQLite DB patched in via mock.module so the route handler
 * reads/writes from a controlled instance instead of the real chat.db.
 */

import Database from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── In-memory DB ──────────────────────────────────────────────────────────────

const MESSAGES_DDL = `
  CREATE TABLE IF NOT EXISTS messages (
    ts TEXT PRIMARY KEY,
    channel TEXT,
    reactions_json TEXT DEFAULT '{}'
  );
`;

let memDb: Database;

mock.module("../../database", () => {
  memDb = new Database(":memory:");
  memDb.exec(MESSAGES_DDL);
  return {
    db: memDb,
    generateTs: () => `${Date.now()}.000001`,
    getOrRegisterAgent: () => {},
    getAgent: () => null,
    getLastSeenByAgents: () => [],
    getMessageSeenBy: () => [],
    parseMentions: () => [],
    preparedStatements: {
      insertMessage: { run: () => {} },
    },
    toSlackMessage: (m: any) => m,
    // Additional exports used by messages.ts routes (not needed by addReaction/removeReaction)
    getSpace: () => null,
    listSpaces: () => [],
    clearChannelHistory: () => ({ ok: true }),
    sanitizeText: (t: string) => t,
  };
});

const { addReaction, removeReaction } = await import("../messages");

// ── Helpers ───────────────────────────────────────────────────────────────────

let tsCounter = 1;

function insertMsg(ts?: string): string {
  const msgTs = ts ?? `${tsCounter++}000.000001`;
  memDb.run(`INSERT INTO messages (ts, channel, reactions_json) VALUES (?, ?, ?)`, [msgTs, "test-channel", "{}"]);
  return msgTs;
}

function getReactions(ts: string): Record<string, string[]> {
  const row = memDb
    .query<{ reactions_json: string }, [string]>(`SELECT reactions_json FROM messages WHERE ts = ?`)
    .get(ts);
  return JSON.parse(row?.reactions_json ?? "{}");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("addReaction", () => {
  beforeEach(() => {
    memDb.exec("DELETE FROM messages");
  });

  test("adds user to new emoji", () => {
    const ts = insertMsg();
    const result = addReaction({ channel: "test-channel", timestamp: ts, name: "thumbsup", user: "UHUMAN" });

    expect(result).toEqual({ ok: true });
    const reactions = getReactions(ts);
    expect(reactions["thumbsup"]).toEqual(["UHUMAN"]);
  });

  test("deduplication — same user+emoji twice is stored only once", () => {
    const ts = insertMsg();
    addReaction({ channel: "test-channel", timestamp: ts, name: "thumbsup", user: "UHUMAN" });
    addReaction({ channel: "test-channel", timestamp: ts, name: "thumbsup", user: "UHUMAN" });

    const reactions = getReactions(ts);
    expect(reactions["thumbsup"]).toHaveLength(1);
    expect(reactions["thumbsup"]).toEqual(["UHUMAN"]);
  });

  test("message_not_found — returns error when ts doesn't exist", () => {
    const result = addReaction({
      channel: "test-channel",
      timestamp: "nonexistent.ts",
      name: "thumbsup",
      user: "UHUMAN",
    });
    expect(result).toEqual({ ok: false, error: "message_not_found" });
  });
});

describe("removeReaction", () => {
  beforeEach(() => {
    memDb.exec("DELETE FROM messages");
  });

  test("removes user from emoji array", () => {
    const ts = insertMsg();
    addReaction({ channel: "test-channel", timestamp: ts, name: "thumbsup", user: "UHUMAN" });
    addReaction({ channel: "test-channel", timestamp: ts, name: "thumbsup", user: "UBOT" });

    const result = removeReaction({ channel: "test-channel", timestamp: ts, name: "thumbsup", user: "UHUMAN" });
    expect(result).toEqual({ ok: true });

    const reactions = getReactions(ts);
    expect(reactions["thumbsup"]).toEqual(["UBOT"]);
    expect(reactions["thumbsup"]).not.toContain("UHUMAN");
  });

  test("cleanup — removing last user of an emoji deletes the emoji key", () => {
    const ts = insertMsg();
    addReaction({ channel: "test-channel", timestamp: ts, name: "thumbsup", user: "UHUMAN" });
    removeReaction({ channel: "test-channel", timestamp: ts, name: "thumbsup", user: "UHUMAN" });

    const reactions = getReactions(ts);
    expect(Object.keys(reactions)).not.toContain("thumbsup");
  });

  test("message_not_found — returns error when ts doesn't exist", () => {
    const result = removeReaction({
      channel: "test-channel",
      timestamp: "nonexistent.ts",
      name: "thumbsup",
      user: "UHUMAN",
    });
    expect(result).toEqual({ ok: false, error: "message_not_found" });
  });

  test("non-existent emoji — no-op, no crash", () => {
    const ts = insertMsg();
    const result = removeReaction({ channel: "test-channel", timestamp: ts, name: "nonexistent", user: "UHUMAN" });

    expect(result).toEqual({ ok: true });
    const reactions = getReactions(ts);
    expect(Object.keys(reactions)).toHaveLength(0);
  });
});
