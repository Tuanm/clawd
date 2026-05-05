/**
 * Tests for /api/agent.setLastProcessed endpoint.
 *
 * Pins two safety properties that prevent the "Tuan stuck on octopos" class of
 * bug, where a non-numeric value (e.g. an ISO date string) landed in
 * agent_seen.last_processed_ts and made every subsequent message look
 * "already processed" because pollack's lex-compare filter said
 * "1777..." < "2026..." for every new ts.
 *
 *   1. Format validation — only numeric epoch strings are accepted; ISO dates,
 *      letters, negatives, and empty/missing values are rejected with 400.
 *   2. No-regression guard — a smaller numeric ts must NOT overwrite a larger
 *      one (would force the agent to re-process old messages).
 *   3. Self-heal — if the existing row is corrupt (non-numeric), a valid
 *      numeric write replaces it (CAST yields the leading-digit prefix or 0,
 *      which any current epoch ts will exceed).
 */

import Database from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const DDL = `
  CREATE TABLE IF NOT EXISTS agent_seen (
    agent_id TEXT,
    channel TEXT,
    last_seen_ts TEXT,
    last_processed_ts TEXT,
    updated_at INTEGER,
    PRIMARY KEY (agent_id, channel)
  );
`;

let memDb: Database;

mock.module("../../../database", () => {
  memDb = new Database(":memory:");
  memDb.exec(DDL);
  return {
    db: memDb,
    getAgent: () => null,
    getOrRegisterAgent: () => {},
    getMessageSeenBy: () => [],
    listAgents: () => [],
    markMessagesSeen: () => {},
    setAgentSleeping: () => {},
    setAgentStreaming: () => {},
    toSlackMessage: (m: unknown) => m,
    writeLastProcessed: (agentId: string, channel: string, rawTs: unknown): string | null => {
      if (rawTs === null || rawTs === undefined || rawTs === "") return null;
      const ts = String(rawTs);
      if (!/^\d+(\.\d+)?$/.test(ts)) return null;
      memDb.run(
        `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
         VALUES (?, ?, ?, ?, strftime('%s', 'now'))
         ON CONFLICT(agent_id, channel) DO UPDATE SET
           last_processed_ts = CASE
             WHEN CAST(excluded.last_processed_ts AS REAL) > CAST(COALESCE(last_processed_ts, '0') AS REAL)
             THEN excluded.last_processed_ts
             ELSE last_processed_ts
           END,
           updated_at = strftime('%s', 'now')`,
        [agentId, channel, ts, ts],
      );
      return ts;
    },
  };
});

mock.module("../../../../db/factory", () => ({
  getMemoryDb: () => null,
}));

mock.module("../../../websocket", () => ({
  broadcastAgentStreaming: () => {},
  broadcastAgentToken: () => {},
  broadcastAgentToolCall: () => {},
  broadcastMessage: () => {},
  broadcastMessageSeen: () => {},
  broadcastUpdate: () => {},
}));

mock.module("../../messages", () => ({
  getPendingMessages: () => [],
}));

const { handleAgentStatusRoutes } = await import("../status");

function readRow(agentId: string, channel: string) {
  return memDb
    .query<{ last_processed_ts: string | null }, [string, string]>(
      `SELECT last_processed_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
    )
    .get(agentId, channel);
}

async function call(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const url = new URL("http://localhost/api/agent.setLastProcessed");
  const req = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleAgentStatusRoutes(req, url, "/api/agent.setLastProcessed");
  if (!res) throw new Error("handler returned null");
  return { status: res.status, body: await res.json() };
}

describe("/api/agent.setLastProcessed", () => {
  beforeEach(() => {
    memDb.run("DELETE FROM agent_seen");
  });

  describe("format validation", () => {
    test("rejects ISO date string", async () => {
      const res = await call({
        agent_id: "Tuan",
        channel: "octopos",
        last_processed_ts: "2026-05-05T12:00:00.000Z",
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/numeric epoch/i);
      expect(readRow("Tuan", "octopos")).toBeNull();
    });

    test("rejects letters / mixed alphanumeric", async () => {
      const res = await call({ agent_id: "x", channel: "y", last_processed_ts: "abc123" });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    test("rejects negative numbers", async () => {
      const res = await call({ agent_id: "x", channel: "y", last_processed_ts: "-100" });
      expect(res.status).toBe(400);
    });

    test("rejects scientific notation", async () => {
      const res = await call({ agent_id: "x", channel: "y", last_processed_ts: "1.7e9" });
      expect(res.status).toBe(400);
    });

    test("rejects null / missing / empty", async () => {
      expect((await call({ agent_id: "x", channel: "y" })).status).toBe(400);
      expect((await call({ agent_id: "x", channel: "y", last_processed_ts: null })).status).toBe(400);
      expect((await call({ agent_id: "x", channel: "y", last_processed_ts: "" })).status).toBe(400);
    });

    test("accepts integer epoch seconds", async () => {
      const res = await call({ agent_id: "x", channel: "y", last_processed_ts: "1777951220" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(readRow("x", "y")?.last_processed_ts).toBe("1777951220");
    });

    test("accepts decimal epoch seconds", async () => {
      const res = await call({
        agent_id: "x",
        channel: "y",
        last_processed_ts: "1777951220.156497",
      });
      expect(res.status).toBe(200);
      expect(readRow("x", "y")?.last_processed_ts).toBe("1777951220.156497");
    });

    test("accepts numeric (non-string) epoch", async () => {
      const res = await call({
        agent_id: "x",
        channel: "y",
        last_processed_ts: 1777951220.156497,
      });
      expect(res.status).toBe(200);
      expect(readRow("x", "y")?.last_processed_ts).toBe("1777951220.156497");
    });
  });

  describe("no-regression guard", () => {
    test("smaller ts does NOT overwrite larger one", async () => {
      await call({ agent_id: "Tuan", channel: "octopos", last_processed_ts: "1777951220.156497" });
      const r = await call({
        agent_id: "Tuan",
        channel: "octopos",
        last_processed_ts: "1777000000.000000",
      });
      expect(r.status).toBe(200); // request succeeds
      // but the stored value is unchanged — older ts loses to existing newer ts
      expect(readRow("Tuan", "octopos")?.last_processed_ts).toBe("1777951220.156497");
    });

    test("equal ts keeps existing value", async () => {
      await call({ agent_id: "x", channel: "y", last_processed_ts: "1777951220" });
      await call({ agent_id: "x", channel: "y", last_processed_ts: "1777951220" });
      expect(readRow("x", "y")?.last_processed_ts).toBe("1777951220");
    });

    test("larger ts overwrites smaller", async () => {
      await call({ agent_id: "x", channel: "y", last_processed_ts: "1777000000" });
      await call({ agent_id: "x", channel: "y", last_processed_ts: "1777951220.156497" });
      expect(readRow("x", "y")?.last_processed_ts).toBe("1777951220.156497");
    });
  });

  describe("corrupt-row self-heal", () => {
    test("valid numeric write replaces an existing ISO-string row", async () => {
      // Pre-seed the bug condition that took down Tuan.
      memDb.run(
        `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
         VALUES ('Tuan', 'octopos', '0', '2026-05-05T12:00:00.000Z', 0)`,
      );
      const res = await call({
        agent_id: "Tuan",
        channel: "octopos",
        last_processed_ts: "1777951220.156497",
      });
      expect(res.status).toBe(200);
      // CAST('2026-05-05T...' AS REAL) → 2026; any current epoch is ~1.78e9, so
      // the numeric MAX picks the new value and the corrupt row gets healed.
      expect(readRow("Tuan", "octopos")?.last_processed_ts).toBe("1777951220.156497");
    });
  });
});
