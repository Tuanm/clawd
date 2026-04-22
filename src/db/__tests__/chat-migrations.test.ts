/**
 * Tests for chat-migrations.ts
 *
 * Verifies that migrations apply correctly to a fresh in-memory DB and that
 * idempotent re-runs are safe. Specifically covers v52 which adds
 * agent_seen.pending_seen_ts_json for crash-safe seen-but-unprocessed tracking.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "../migrations";
import { chatMigrations } from "../migrations/chat-migrations";

describe("chatMigrations", () => {
  test("v1 creates agent_seen table with the expected columns", () => {
    const db = new Database(":memory:");
    runMigrations(db, chatMigrations);
    const columns = db.query("PRAGMA table_info(agent_seen)").all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain("agent_id");
    expect(names).toContain("channel");
    expect(names).toContain("last_seen_ts");
    expect(names).toContain("last_processed_ts");
  });

  test("v52 adds pending_seen_ts_json column to agent_seen", () => {
    const db = new Database(":memory:");
    runMigrations(db, chatMigrations);
    const columns = db.query("PRAGMA table_info(agent_seen)").all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain("pending_seen_ts_json");
  });

  test("pending_seen_ts_json column accepts JSON string and NULL", () => {
    const db = new Database(":memory:");
    runMigrations(db, chatMigrations);
    // Insert a row with JSON
    db.run(
      `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, pending_seen_ts_json)
       VALUES ('agent1', 'chan1', '1000', ?)`,
      [JSON.stringify(["ts1", "ts2", "ts3"])],
    );
    const row = db.query("SELECT pending_seen_ts_json FROM agent_seen WHERE agent_id = 'agent1'").get() as {
      pending_seen_ts_json: string | null;
    };
    expect(row.pending_seen_ts_json).toBe('["ts1","ts2","ts3"]');

    // Update to NULL
    db.run(`UPDATE agent_seen SET pending_seen_ts_json = NULL WHERE agent_id = 'agent1'`);
    const row2 = db.query("SELECT pending_seen_ts_json FROM agent_seen WHERE agent_id = 'agent1'").get() as {
      pending_seen_ts_json: string | null;
    };
    expect(row2.pending_seen_ts_json).toBeNull();
  });

  test("migrations are idempotent — running twice does not fail", () => {
    const db = new Database(":memory:");
    runMigrations(db, chatMigrations);
    // Second run should be a no-op (user_version already at latest)
    expect(() => runMigrations(db, chatMigrations)).not.toThrow();
  });

  test("v51 creates trajectories table with all RL training columns", () => {
    const db = new Database(":memory:");
    runMigrations(db, chatMigrations);
    const columns = db.query("PRAGMA table_info(trajectories)").all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain("session_id");
    expect(names).toContain("channel");
    expect(names).toContain("agent_id");
    expect(names).toContain("turn_index");
    expect(names).toContain("user_message");
    expect(names).toContain("tool_calls_json");
    expect(names).toContain("assistant_response");
    expect(names).toContain("reward");
  });

  test("user_version matches the highest migration version after apply", () => {
    const db = new Database(":memory:");
    runMigrations(db, chatMigrations);
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    const maxVersion = Math.max(...chatMigrations.map((m) => m.version));
    expect(row.user_version).toBe(maxVersion);
    expect(maxVersion).toBeGreaterThanOrEqual(52);
  });

  test("v52 is idempotent with partial state (column already exists from ALTER TABLE)", () => {
    const db = new Database(":memory:");
    // Run only v1
    const v1 = chatMigrations.find((m) => m.version === 1)!;
    db.transaction(() => {
      v1.up(db);
      db.exec("PRAGMA user_version = 1");
    })();
    // Manually add the column (simulates a partial migration from a prior failure)
    db.exec("ALTER TABLE agent_seen ADD COLUMN pending_seen_ts_json TEXT");
    // Now run all migrations — v52 should handle "column already exists" gracefully
    expect(() => runMigrations(db, chatMigrations)).not.toThrow();
  });
});
