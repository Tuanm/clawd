/**
 * Unit tests for the `query_files` handler in execute.ts.
 *
 * Covers the filter/pagination contract that tool-defs.ts promises:
 *   - channel scopes every query (rows from other channels never bleed in).
 *   - ts/from_ts/to_ts cursor: order key (m.ts) matches pagination key.
 *   - name: case-insensitive substring.
 *   - mimetype: case-insensitive exact + trailing-"/" prefix.
 *   - uploader_ids, roles (bot/worker/human), agent_ids filters.
 *   - file_id: single-row lookup.
 *   - limit + has_more pagination signal.
 *   - image_hint annotation on image/* MIME.
 */

import Database from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── In-memory DB schema (minimal mirror of the real files ↔ messages shape) ──
const DDL = `
  CREATE TABLE IF NOT EXISTS messages (
    ts TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    user TEXT,
    agent_id TEXT,
    text TEXT
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    name TEXT,
    mimetype TEXT,
    size INTEGER,
    path TEXT,
    message_ts TEXT,
    uploaded_by TEXT,
    created_at INTEGER
  );
`;

let memDb: Database;

mock.module("../../database", () => {
  memDb = new Database(":memory:");
  memDb.exec(DDL);
  return {
    db: memDb,
    ATTACHMENTS_DIR: "/tmp/attachments",
    generateId: () => "Fxxx",
    generateTs: () => `${Date.now() / 1000}`,
    getAgent: () => null,
    getMessageSeenBy: () => [],
    markMessagesSeen: () => {},
    toSlackMessage: (m: any) => m,
  };
});

mock.module("../../multimodal", () => ({
  analyzeImage: async () => ({}),
  analyzeVideo: async () => ({}),
  editImage: async () => ({}),
  generateImage: async () => ({}),
  getImageQuotaStatus: () => ({}),
}));

mock.module("../../routes/files", () => ({
  getOptimizedFile: () => null,
  attachFilesToMessage: () => [],
}));

mock.module("../../routes/messages", () => ({
  getConversationHistory: () => ({ messages: [] }),
  getPendingMessages: () => [],
  postMessage: () => ({ ok: true, ts: "0" }),
}));

mock.module("../../websocket", () => ({
  broadcastMessage: () => {},
  broadcastMessageSeen: () => {},
  broadcastUpdate: () => {},
}));

mock.module("../shared", () => ({
  _scheduler: null,
  _workerManager: null,
}));

const { executeToolCall } = await import("../execute");

// ── Seeding helpers ────────────────────────────────────────────────────────

interface SeedMsg {
  ts: string;
  channel: string;
  user?: string;
  agent_id?: string;
}
interface SeedFile {
  id: string;
  name: string;
  mimetype: string;
  size?: number;
  message_ts: string;
  uploaded_by: string;
  created_at?: number;
}

function seedMessage(m: SeedMsg) {
  memDb.run(`INSERT INTO messages (ts, channel, user, agent_id, text) VALUES (?, ?, ?, ?, ?)`, [
    m.ts,
    m.channel,
    m.user ?? null,
    m.agent_id ?? null,
    "",
  ]);
}

function seedFile(f: SeedFile) {
  memDb.run(
    `INSERT INTO files (id, name, mimetype, size, path, message_ts, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [f.id, f.name, f.mimetype, f.size ?? 100, `/tmp/${f.id}`, f.message_ts, f.uploaded_by, f.created_at ?? 1700000000],
  );
}

async function callQueryFiles(args: Record<string, unknown>) {
  const result = await executeToolCall("query_files", args);
  const text = (result.content as { text: string }[])[0].text;
  return JSON.parse(text) as {
    ok: boolean;
    files: Array<Record<string, unknown>>;
    count: number;
    has_more: boolean;
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("query_files — filters + pagination", () => {
  beforeEach(() => {
    memDb.run(`DELETE FROM files`);
    memDb.run(`DELETE FROM messages`);
  });

  test("channel scopes results — rows from other channels never leak", async () => {
    seedMessage({ ts: "1.0", channel: "C1", user: "UHUMAN" });
    seedMessage({ ts: "2.0", channel: "C2", user: "UHUMAN" });
    seedFile({ id: "F1", name: "doc-c1.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UHUMAN" });
    seedFile({ id: "F2", name: "doc-c2.pdf", mimetype: "application/pdf", message_ts: "2.0", uploaded_by: "UHUMAN" });

    const res = await callQueryFiles({ channel: "C1" });
    expect(res.count).toBe(1);
    expect(res.files[0]?.id).toBe("F1");
  });

  test("ts filters to a single message's attachments", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    seedMessage({ ts: "2.0", channel: "C1" });
    seedFile({ id: "F1", name: "a.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UHUMAN" });
    seedFile({ id: "F2", name: "b.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UHUMAN" });
    seedFile({ id: "F3", name: "c.pdf", mimetype: "application/pdf", message_ts: "2.0", uploaded_by: "UHUMAN" });

    const res = await callQueryFiles({ channel: "C1", ts: "1.0" });
    expect(res.count).toBe(2);
    expect(res.files.map((f) => f.id).sort()).toEqual(["F1", "F2"]);
  });

  test("from_ts / to_ts use m.ts cursor (ordering matches pagination key)", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    seedMessage({ ts: "2.0", channel: "C1" });
    seedMessage({ ts: "3.0", channel: "C1" });
    // created_at is deliberately NOT aligned with ts to prove we order by m.ts
    seedFile({
      id: "F1",
      name: "old.pdf",
      mimetype: "application/pdf",
      message_ts: "1.0",
      uploaded_by: "UHUMAN",
      created_at: 9999,
    });
    seedFile({
      id: "F2",
      name: "mid.pdf",
      mimetype: "application/pdf",
      message_ts: "2.0",
      uploaded_by: "UHUMAN",
      created_at: 1,
    });
    seedFile({
      id: "F3",
      name: "new.pdf",
      mimetype: "application/pdf",
      message_ts: "3.0",
      uploaded_by: "UHUMAN",
      created_at: 5000,
    });

    // from_ts (exclusive) — should return F2, F3
    const after = await callQueryFiles({ channel: "C1", from_ts: "1.0" });
    expect(after.files.map((f) => f.id)).toEqual(["F2", "F3"]);

    // to_ts (exclusive) — should return F1, F2
    const before = await callQueryFiles({ channel: "C1", to_ts: "3.0" });
    expect(before.files.map((f) => f.id)).toEqual(["F1", "F2"]);

    // Combined: strict window
    const window = await callQueryFiles({ channel: "C1", from_ts: "1.0", to_ts: "3.0" });
    expect(window.files.map((f) => f.id)).toEqual(["F2"]);
  });

  test("desc order returns newest-ts first", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    seedMessage({ ts: "2.0", channel: "C1" });
    seedFile({ id: "F1", name: "a.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UHUMAN" });
    seedFile({ id: "F2", name: "b.pdf", mimetype: "application/pdf", message_ts: "2.0", uploaded_by: "UHUMAN" });

    const res = await callQueryFiles({ channel: "C1", order: "desc" });
    expect(res.files.map((f) => f.id)).toEqual(["F2", "F1"]);
  });

  test("name filter: case-insensitive substring", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    seedFile({
      id: "F1",
      name: "Report-Final.PDF",
      mimetype: "application/pdf",
      message_ts: "1.0",
      uploaded_by: "UHUMAN",
    });
    seedFile({ id: "F2", name: "notes.txt", mimetype: "text/plain", message_ts: "1.0", uploaded_by: "UHUMAN" });

    const res = await callQueryFiles({ channel: "C1", name: "report" });
    expect(res.count).toBe(1);
    expect(res.files[0]?.id).toBe("F1");
  });

  test("mimetype: exact match is case-insensitive", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    seedFile({ id: "F1", name: "a.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UHUMAN" });
    seedFile({ id: "F2", name: "b.txt", mimetype: "TEXT/PLAIN", message_ts: "1.0", uploaded_by: "UHUMAN" });

    const res = await callQueryFiles({ channel: "C1", mimetype: "text/plain" });
    expect(res.count).toBe(1);
    expect(res.files[0]?.id).toBe("F2");
  });

  test("mimetype: trailing '/' → prefix match, case-insensitive", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    seedFile({ id: "F1", name: "a.png", mimetype: "image/png", message_ts: "1.0", uploaded_by: "UHUMAN" });
    seedFile({ id: "F2", name: "b.jpg", mimetype: "IMAGE/JPEG", message_ts: "1.0", uploaded_by: "UHUMAN" });
    seedFile({ id: "F3", name: "c.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UHUMAN" });

    const res = await callQueryFiles({ channel: "C1", mimetype: "image/" });
    expect(res.count).toBe(2);
    expect(res.files.map((f) => f.id).sort()).toEqual(["F1", "F2"]);
  });

  test("mimetype: 'image' alone (no trailing slash) matches nothing", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    seedFile({ id: "F1", name: "a.png", mimetype: "image/png", message_ts: "1.0", uploaded_by: "UHUMAN" });

    const res = await callQueryFiles({ channel: "C1", mimetype: "image" });
    expect(res.count).toBe(0);
  });

  test("uploader_ids: filter by specific users", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    seedFile({ id: "F1", name: "a.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UHUMAN" });
    seedFile({ id: "F2", name: "b.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UWORKER-x" });
    seedFile({ id: "F3", name: "c.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UBOT" });

    const res = await callQueryFiles({ channel: "C1", uploader_ids: ["UHUMAN", "UBOT"] });
    expect(res.files.map((f) => f.id).sort()).toEqual(["F1", "F3"]);
  });

  test("roles: bot/worker/human map to UBOT / UWORKER-*/UHUMAN", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    seedFile({ id: "F1", name: "h.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UHUMAN" });
    seedFile({ id: "F2", name: "w.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UWORKER-abc" });
    seedFile({ id: "F3", name: "b.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UBOT" });

    const human = await callQueryFiles({ channel: "C1", roles: ["human"] });
    expect(human.files.map((f) => f.id)).toEqual(["F1"]);

    const worker = await callQueryFiles({ channel: "C1", roles: ["worker"] });
    expect(worker.files.map((f) => f.id)).toEqual(["F2"]);

    const bot = await callQueryFiles({ channel: "C1", roles: ["bot"] });
    expect(bot.files.map((f) => f.id)).toEqual(["F3"]);

    const humanOrBot = await callQueryFiles({ channel: "C1", roles: ["human", "bot"] });
    expect(humanOrBot.files.map((f) => f.id).sort()).toEqual(["F1", "F3"]);
  });

  test("agent_ids: filter by attaching message's agent_id", async () => {
    seedMessage({ ts: "1.0", channel: "C1", agent_id: "agent-alpha" });
    seedMessage({ ts: "2.0", channel: "C1", agent_id: "agent-beta" });
    seedFile({ id: "F1", name: "a.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UWORKER-a" });
    seedFile({ id: "F2", name: "b.pdf", mimetype: "application/pdf", message_ts: "2.0", uploaded_by: "UWORKER-b" });

    const res = await callQueryFiles({ channel: "C1", agent_ids: ["agent-alpha"] });
    expect(res.files.map((f) => f.id)).toEqual(["F1"]);
  });

  test("file_id: returns single row, ignores limit+1 pattern", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    seedFile({ id: "F1", name: "a.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UHUMAN" });
    seedFile({ id: "F2", name: "b.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UHUMAN" });

    const res = await callQueryFiles({ channel: "C1", file_id: "F1" });
    expect(res.count).toBe(1);
    expect(res.files[0]?.id).toBe("F1");
    expect(res.has_more).toBe(false);
  });

  test("limit + has_more: signals pagination when more rows exist", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    for (let i = 1; i <= 5; i++) {
      seedFile({
        id: `F${i}`,
        name: `f${i}.pdf`,
        mimetype: "application/pdf",
        message_ts: "1.0",
        uploaded_by: "UHUMAN",
      });
    }

    const page1 = await callQueryFiles({ channel: "C1", limit: 2 });
    expect(page1.count).toBe(2);
    expect(page1.has_more).toBe(true);

    const page2 = await callQueryFiles({ channel: "C1", limit: 10 });
    expect(page2.count).toBe(5);
    expect(page2.has_more).toBe(false);
  });

  test("image_hint annotates image/* MIME rows, not others", async () => {
    seedMessage({ ts: "1.0", channel: "C1" });
    seedFile({ id: "F1", name: "pic.png", mimetype: "image/png", message_ts: "1.0", uploaded_by: "UHUMAN" });
    seedFile({ id: "F2", name: "doc.pdf", mimetype: "application/pdf", message_ts: "1.0", uploaded_by: "UHUMAN" });

    const res = await callQueryFiles({ channel: "C1" });
    const pic = res.files.find((f) => f.id === "F1")!;
    const doc = res.files.find((f) => f.id === "F2")!;
    expect(pic.image_hint).toBeDefined();
    expect(pic.image_hint).toContain("read_image");
    expect(doc.image_hint).toBeUndefined();
  });
});
