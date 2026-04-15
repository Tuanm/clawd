/**
 * Unit tests for TrajectoryRecorder.
 *
 * Uses an in-memory SQLite DB with the trajectories schema applied directly.
 * Patches the module-level `db` import so TrajectoryRecorder writes to our
 * in-memory instance instead of the real chat.db.
 */

import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── In-memory DB setup ────────────────────────────────────────────────────────

const TRAJECTORIES_DDL = `
  CREATE TABLE IF NOT EXISTS trajectories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    user_message TEXT,
    tool_calls_json TEXT,
    assistant_response TEXT,
    reward INTEGER DEFAULT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`;

// We need to mock the db import before importing TrajectoryRecorder.
// Bun supports module mocking via mock.module().
let memDb: Database;

mock.module("../../server/database", () => {
  memDb = new Database(":memory:");
  memDb.exec(TRAJECTORIES_DDL);
  return { db: memDb };
});

// Import AFTER mock is set up
const { TrajectoryRecorder } = await import("../trajectory-recorder");

// ── Helpers ───────────────────────────────────────────────────────────────────

function countRows(): number {
  return (memDb.query("SELECT COUNT(*) as c FROM trajectories").get() as any).c;
}

function getRow(id = 1): any {
  return memDb.query("SELECT * FROM trajectories WHERE id = ?").get(id);
}

function getAllRows(): any[] {
  return memDb.query("SELECT * FROM trajectories ORDER BY id").all() as any[];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TrajectoryRecorder.commitTurn", () => {
  beforeEach(() => {
    memDb.exec("DELETE FROM trajectories");
  });

  test("inserts a row and increments turnIndex", () => {
    const rec = new TrajectoryRecorder("chan-1", "agent-1", "sess-1");
    rec.recordUserMessage("hello");
    rec.recordAssistantResponse("hi there");
    rec.commitTurn();

    expect(countRows()).toBe(1);
    const row = getAllRows()[0];
    expect(row.session_id).toBe("sess-1");
    expect(row.agent_id).toBe("agent-1");
    expect(row.channel).toBe("chan-1");
    expect(row.turn_index).toBe(0);
    expect(row.user_message).toBe("hello");
    expect(row.assistant_response).toBe("hi there");

    // Second turn should use turn_index=1
    rec.recordUserMessage("second message");
    rec.commitTurn();
    const rows = getAllRows();
    expect(rows[1].turn_index).toBe(1);
  });

  test("returns early (no insert) when both user_message and assistant_response are null", () => {
    const rec = new TrajectoryRecorder("chan-2", "agent-2", "sess-2");
    rec.commitTurn(); // nothing recorded
    expect(countRows()).toBe(0);
  });

  test("commits when only user_message is set", () => {
    const rec = new TrajectoryRecorder("chan-3", "agent-3", "sess-3");
    rec.recordUserMessage("user only");
    rec.commitTurn();
    expect(countRows()).toBe(1);
    expect(getAllRows()[0].assistant_response).toBeNull();
  });

  test("commits when only assistant_response is set", () => {
    const rec = new TrajectoryRecorder("chan-4", "agent-4", "sess-4");
    rec.recordAssistantResponse("assistant only");
    rec.commitTurn();
    expect(countRows()).toBe(1);
    expect(getAllRows()[0].user_message).toBeNull();
  });

  test("clears pending state after commit", () => {
    const rec = new TrajectoryRecorder("chan-5", "agent-5", "sess-5");
    rec.recordUserMessage("msg");
    rec.commitTurn();
    // Second commitTurn with no new data should be a no-op
    rec.commitTurn();
    expect(countRows()).toBe(1);
  });
});

describe("TrajectoryRecorder.abortTurn", () => {
  beforeEach(() => {
    memDb.exec("DELETE FROM trajectories");
  });

  test("clears pending state without inserting", () => {
    const rec = new TrajectoryRecorder("chan-6", "agent-6", "sess-6");
    rec.recordUserMessage("will be aborted");
    rec.recordAssistantResponse("also aborted");
    rec.abortTurn();

    expect(countRows()).toBe(0);

    // After abort, commitTurn should be a no-op (pending is null)
    rec.commitTurn();
    expect(countRows()).toBe(0);
  });
});

describe("TrajectoryRecorder.commitTurn DB failure", () => {
  test("does not throw on DB error and still increments turnIndex", () => {
    // Use a separate closed DB to simulate failure
    const failDb = new Database(":memory:");
    failDb.exec(TRAJECTORIES_DDL);

    // Patch memDb temporarily: replace run with a throwing function
    const originalRun = memDb.run.bind(memDb);
    let callCount = 0;
    (memDb as any).run = (...args: any[]) => {
      callCount++;
      throw new Error("simulated DB failure");
    };

    const rec = new TrajectoryRecorder("chan-err", "agent-err", "sess-err");
    rec.recordUserMessage("msg");

    // Should not throw
    expect(() => rec.commitTurn()).not.toThrow();

    // Restore
    (memDb as any).run = originalRun;

    // turnIndex should have advanced (Fix 5)
    // Verify by doing a successful commit next — turn_index should be 1
    memDb.exec("DELETE FROM trajectories");
    rec.recordUserMessage("second msg after failure");
    rec.commitTurn();

    const rows = getAllRows();
    expect(rows.length).toBe(1);
    expect(rows[0].turn_index).toBe(1); // advanced past 0 despite failure
  });
});

describe("TrajectoryRecorder tool call truncation", () => {
  beforeEach(() => {
    memDb.exec("DELETE FROM trajectories");
  });

  test("truncates tool_calls_json when 20 tool calls with 1KB content each exceed 16KB cap", () => {
    const rec = new TrajectoryRecorder("chan-trunc", "agent-trunc", "sess-trunc");
    rec.recordUserMessage("test truncation");

    // Add 20 tool calls each with ~1KB result
    const oneKb = "x".repeat(1_000);
    for (let i = 0; i < 20; i++) {
      rec.recordToolCall(`tool-${i}`, { arg: i }, oneKb, true);
    }

    rec.recordAssistantResponse("done");
    rec.commitTurn();

    expect(countRows()).toBe(1);
    const row = getAllRows()[0];
    expect(row.tool_calls_json).not.toBeNull();

    // Should be truncated — full 20 tool calls × 1KB = ~20KB > 16KB cap
    const parsed = row.tool_calls_json as string;
    expect(parsed.length).toBeLessThan(20_000);
    // Must remain valid JSON with sentinel entry instead of appended string
    const calls = JSON.parse(parsed) as Array<{ name: string; result: string; success: boolean }>;
    expect(Array.isArray(calls)).toBe(true);
    const sentinel = calls[calls.length - 1];
    expect(sentinel.name).toBe("__truncated__");
    expect(sentinel.result).toContain("tool calls omitted");
  });
});
