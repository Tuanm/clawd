/**
 * Unit tests for the `reply` handler in execute.ts.
 *
 * Covers the two behaviours that chat_send_message+chat_mark_processed were
 * merged into:
 *   - SILENT path: empty/[SILENT] text skips postMessage but still writes
 *     agent_seen.last_processed_ts when a timestamp is supplied.
 *   - Visible path: text is routed to postMessage, and last_processed_ts is
 *     returned alongside the postMessage result when timestamp is supplied.
 */

import Database from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── In-memory DB (only agent_seen + a trivial messages row for broadcast) ──
const DDL = `
  CREATE TABLE IF NOT EXISTS agent_seen (
    agent_id TEXT,
    channel TEXT,
    last_seen_ts TEXT,
    last_processed_ts TEXT,
    updated_at INTEGER,
    PRIMARY KEY (agent_id, channel)
  );
  CREATE TABLE IF NOT EXISTS messages (
    ts TEXT PRIMARY KEY,
    channel TEXT,
    text TEXT,
    agent_id TEXT,
    user TEXT
  );
`;

let memDb: Database;
const postMessageMock = mock((args: any) => {
  const ts = `${Date.now() / 1000}`;
  memDb.run(`INSERT INTO messages (ts, channel, text, agent_id, user) VALUES (?, ?, ?, ?, ?)`, [
    ts,
    args.channel,
    args.text ?? "",
    args.agent_id ?? null,
    args.user ?? null,
  ]);
  return { ok: true, ts, channel: args.channel };
});
const broadcastMessageMock = mock(() => {});

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

const attachFilesToMessageMock = mock((ts: string, fileIds: string[]) =>
  fileIds.map((id) => ({
    id,
    name: `${id}.bin`,
    mimetype: "application/octet-stream",
    size: 42,
    url_private: `/api/files/${id}`,
  })),
);

mock.module("../../routes/files", () => ({
  getOptimizedFile: () => null,
  attachFilesToMessage: attachFilesToMessageMock,
}));

mock.module("../../routes/messages", () => ({
  getConversationHistory: () => ({ messages: [] }),
  getPendingMessages: () => [],
  postMessage: postMessageMock,
}));

mock.module("../../websocket", () => ({
  broadcastMessage: broadcastMessageMock,
  broadcastMessageSeen: () => {},
  broadcastUpdate: () => {},
}));

mock.module("../shared", () => ({
  _scheduler: null,
  _workerManager: null,
}));

const { executeToolCall } = await import("../execute");

// ── Helpers ────────────────────────────────────────────────────────────────

function readSeen(agentId: string, channel: string) {
  return memDb
    .query<{ last_seen_ts: string | null; last_processed_ts: string | null }, [string, string]>(
      `SELECT last_seen_ts, last_processed_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
    )
    .get(agentId, channel);
}

function parseResult(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("reply handler", () => {
  beforeEach(() => {
    memDb.run("DELETE FROM agent_seen");
    memDb.run("DELETE FROM messages");
    postMessageMock.mockClear();
    broadcastMessageMock.mockClear();
    attachFilesToMessageMock.mockClear();
  });

  test("empty text returns silent:true and skips postMessage", async () => {
    const result = await executeToolCall("reply", {
      channel: "test",
      text: "",
      agent_id: "Claw'd",
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.silent).toBe(true);
    expect(postMessageMock.mock.calls.length).toBe(0);
  });

  test("[SILENT] text returns silent:true and skips postMessage", async () => {
    const result = await executeToolCall("reply", {
      channel: "test",
      text: "[SILENT]",
      agent_id: "Claw'd",
    });
    const body = parseResult(result);
    expect(body.silent).toBe(true);
    expect(postMessageMock.mock.calls.length).toBe(0);
  });

  test("timestamp on SILENT call still writes last_processed_ts", async () => {
    const result = await executeToolCall("reply", {
      channel: "test",
      text: "[SILENT]",
      agent_id: "Claw'd",
      timestamp: "1700000000.111",
    });
    const body = parseResult(result);
    expect(body.silent).toBe(true);
    expect(body.last_processed_ts).toBe("1700000000.111");
    const seen = readSeen("Claw'd", "test");
    expect(seen?.last_processed_ts).toBe("1700000000.111");
  });

  test("visible text posts the message and returns last_processed_ts", async () => {
    const result = await executeToolCall("reply", {
      channel: "test",
      text: "Hello human",
      agent_id: "Claw'd",
      user: "UBOT",
      timestamp: "1700000000.222",
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.silent).toBeUndefined();
    expect(body.last_processed_ts).toBe("1700000000.222");
    expect(postMessageMock.mock.calls.length).toBe(1);
    expect(postMessageMock.mock.calls[0][0]).toMatchObject({
      channel: "test",
      text: "Hello human",
      user: "UBOT",
      agent_id: "Claw'd",
    });
    const seen = readSeen("Claw'd", "test");
    expect(seen?.last_processed_ts).toBe("1700000000.222");
  });

  test("no timestamp → no agent_seen row written, no last_processed_ts in result", async () => {
    const result = await executeToolCall("reply", {
      channel: "test",
      text: "Hi",
      agent_id: "Claw'd",
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.last_processed_ts).toBeUndefined();
    expect(readSeen("Claw'd", "test")).toBeNull();
  });

  test("last_processed_ts uses MAX — older ts does not regress newer one", async () => {
    await executeToolCall("reply", {
      channel: "test",
      text: "[SILENT]",
      agent_id: "Claw'd",
      timestamp: "1700000005.000",
    });
    await executeToolCall("reply", {
      channel: "test",
      text: "[SILENT]",
      agent_id: "Claw'd",
      timestamp: "1700000001.000",
    });
    expect(readSeen("Claw'd", "test")?.last_processed_ts).toBe("1700000005.000");
  });

  test("parameter-swap guard — short text + long agent_id returns PARAMETER_ORDER_ERROR", async () => {
    const longMessage =
      "Hello! This is a long message that was accidentally placed into the agent_id field instead of the text field.";
    const result = await executeToolCall("reply", {
      channel: "test",
      text: "Claw'd",
      agent_id: longMessage,
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("PARAMETER_ORDER_ERROR");
    expect(postMessageMock.mock.calls.length).toBe(0);
  });

  test("file_ids on visible text attaches files + returns them in result", async () => {
    const result = await executeToolCall("reply", {
      channel: "test",
      text: "Here you go",
      agent_id: "Claw'd",
      file_ids: ["Fabc", "Fdef"],
      timestamp: "1700000000.333",
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.files).toBeDefined();
    expect(body.files.length).toBe(2);
    expect(body.files[0].id).toBe("Fabc");
    expect(body.files[1].id).toBe("Fdef");
    expect(body.last_processed_ts).toBe("1700000000.333");
    expect(attachFilesToMessageMock.mock.calls.length).toBe(1);
    expect(attachFilesToMessageMock.mock.calls[0][1]).toEqual(["Fabc", "Fdef"]);
    expect(postMessageMock.mock.calls.length).toBe(1);
  });

  test("file_ids empty array does NOT trigger attachFilesToMessage", async () => {
    const result = await executeToolCall("reply", {
      channel: "test",
      text: "No attachments",
      agent_id: "Claw'd",
      file_ids: [],
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.files).toBeUndefined();
    expect(attachFilesToMessageMock.mock.calls.length).toBe(0);
  });

  test("file_ids on SILENT reply is ignored (no postMessage, no attach)", async () => {
    const result = await executeToolCall("reply", {
      channel: "test",
      text: "[SILENT]",
      agent_id: "Claw'd",
      file_ids: ["Fabc"],
    });
    const body = parseResult(result);
    expect(body.silent).toBe(true);
    expect(body.files).toBeUndefined();
    expect(postMessageMock.mock.calls.length).toBe(0);
    expect(attachFilesToMessageMock.mock.calls.length).toBe(0);
  });

  test("file_ids filters non-string entries", async () => {
    const result = await executeToolCall("reply", {
      channel: "test",
      text: "Mixed",
      agent_id: "Claw'd",
      file_ids: ["Fgood", 123, null, "Falso-good"],
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(attachFilesToMessageMock.mock.calls.length).toBe(1);
    expect(attachFilesToMessageMock.mock.calls[0][1]).toEqual(["Fgood", "Falso-good"]);
  });

  test("parameter-swap guard fires BEFORE markProcessed — swapped call does NOT regress last_processed_ts", async () => {
    const longMessage =
      "Hello! This is a long message that was accidentally placed into the agent_id field instead of the text field.";
    const result = await executeToolCall("reply", {
      channel: "test",
      text: "Claw'd",
      agent_id: longMessage,
      timestamp: "1700000099.000",
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    // Agent_seen must NOT have been written — the agent needs to retry correctly,
    // which requires the message to still appear in pending pollers.
    expect(readSeen(longMessage, "test")).toBeNull();
    expect(readSeen("Claw'd", "test")).toBeNull();
  });
});
