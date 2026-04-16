/**
 * Unit tests for handleTrajectoriesRequest.
 *
 * Uses an in-memory SQLite DB patched in via mock.module so the route handler
 * writes/reads from a controlled instance instead of the real chat.db.
 */

import Database from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

// ── In-memory DB ──────────────────────────────────────────────────────────────

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

let memDb: Database;

mock.module("../../database", () => {
  memDb = new Database(":memory:");
  memDb.exec(TRAJECTORIES_DDL);
  return { db: memDb };
});

import { mock } from "bun:test";

const { handleTrajectoriesRequest } = await import("../trajectories");

// ── Helpers ───────────────────────────────────────────────────────────────────

function insertRow(opts: {
  channel: string;
  agent_id?: string;
  user_message?: string;
  assistant_response?: string;
  reward?: number;
  created_at?: number;
}): void {
  memDb.run(
    `INSERT INTO trajectories (session_id, channel, agent_id, turn_index, user_message, assistant_response, reward, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-1",
      opts.channel,
      opts.agent_id ?? "agent-1",
      0,
      opts.user_message ?? "hello",
      opts.assistant_response ?? "hi",
      opts.reward ?? null,
      opts.created_at ?? Math.floor(Date.now() / 1000),
    ],
  );
}

async function get(url: string): Promise<{ status: number; body: any; text: string }> {
  const req = new Request(url);
  const res = await handleTrajectoriesRequest(req);
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

async function post(url: string, data: any): Promise<{ status: number; body: any }> {
  const req = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const res = await handleTrajectoriesRequest(req);
  const body = await res.json();
  return { status: res.status, body };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/trajectories", () => {
  beforeEach(() => {
    memDb.exec("DELETE FROM trajectories");
  });

  test("returns rows for the specified channel", async () => {
    insertRow({ channel: "devops" });
    insertRow({ channel: "devops" });
    insertRow({ channel: "other" });

    const { status, body } = await get("http://localhost/api/trajectories?channel=devops");
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.trajectories).toHaveLength(2);
    expect(body.trajectories.every((r: any) => r.channel === "devops")).toBe(true);
  });

  test("returns 400 when channel param is missing", async () => {
    const { status, body } = await get("http://localhost/api/trajectories");
    expect(status).toBe(400);
    expect(body.error).toContain("channel");
  });

  test("returns JSONL format with proper structure", async () => {
    insertRow({ channel: "test-ch", user_message: "user msg", assistant_response: "asst msg" });

    const req = new Request("http://localhost/api/trajectories?format=jsonl&channel=test-ch");
    const res = await handleTrajectoriesRequest(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("ndjson");

    const text = await res.text();
    const line = JSON.parse(text.trim());
    expect(line.messages).toHaveLength(2);
    expect(line.messages[0].role).toBe("user");
    expect(line.messages[1].role).toBe("assistant");
  });

  test("returns only labeled rows when labeled=true", async () => {
    insertRow({ channel: "labeled-ch", reward: 1 });
    insertRow({ channel: "labeled-ch" }); // no reward

    const { status, body } = await get("http://localhost/api/trajectories?labeled=true&channel=labeled-ch");
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.trajectories[0].reward).toBe(1);
  });

  test("returns 400 for invalid 'from' parameter", async () => {
    const { status, body } = await get("http://localhost/api/trajectories?channel=x&from=invalid");
    expect(status).toBe(400);
    expect(body.error).toContain("from");
  });

  test("returns 400 for invalid 'to' parameter", async () => {
    const { status, body } = await get("http://localhost/api/trajectories?channel=x&to=notanumber");
    expect(status).toBe(400);
    expect(body.error).toContain("to");
  });
});

describe("POST /api/trajectories/:id/reward", () => {
  beforeEach(() => {
    memDb.exec("DELETE FROM trajectories");
  });

  test("updates reward for correct channel", async () => {
    insertRow({ channel: "reward-ch" });
    const id = (memDb.query("SELECT id FROM trajectories LIMIT 1").get() as any).id;

    const { status, body } = await post(`http://localhost/api/trajectories/${id}/reward?channel=reward-ch`, {
      reward: 1,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const row = memDb.query("SELECT reward FROM trajectories WHERE id = ?").get(id) as any;
    expect(row.reward).toBe(1);
  });

  test("returns 404 when channel does not match", async () => {
    insertRow({ channel: "correct-ch" });
    const id = (memDb.query("SELECT id FROM trajectories LIMIT 1").get() as any).id;

    const { status, body } = await post(`http://localhost/api/trajectories/${id}/reward?channel=wrong-ch`, {
      reward: 1,
    });
    expect(status).toBe(404);
    expect(body.error).toBe("not found");
  });

  test("returns 400 for invalid reward value", async () => {
    insertRow({ channel: "val-ch" });
    const id = (memDb.query("SELECT id FROM trajectories LIMIT 1").get() as any).id;

    const { status, body } = await post(`http://localhost/api/trajectories/${id}/reward?channel=val-ch`, { reward: 5 });
    expect(status).toBe(400);
    expect(body.error).toContain("reward");
  });

  test("returns 400 when channel param is missing", async () => {
    insertRow({ channel: "any-ch" });
    const id = (memDb.query("SELECT id FROM trajectories LIMIT 1").get() as any).id;

    const { status, body } = await post(`http://localhost/api/trajectories/${id}/reward`, { reward: 1 });
    expect(status).toBe(400);
    expect(body.error).toContain("channel");
  });
});
