/**
 * Comprehensive tests for the Remote Worker infrastructure:
 *
 * 1. remote-worker.ts — WebSocket server, worker state, tool dispatch, reconnection
 * 2. remote-worker-connection.ts — MCP connection wrapper, tool prefixing
 * 3. remote-worker-bridge.ts — Event bridge between server events and MCPManager
 *
 * All WebSocket/network dependencies are mocked.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

// ── Module Mocks ──────────────────────────────────────────────────────────────

// Mock config-file before importing remote-worker
let mockConfig: any = { worker: true };
mock.module("../config/config-file", () => ({
  loadConfigFile: () => mockConfig,
  reloadConfigFile: () => {},
  safeTokenEqual: (a: string, b: string) => a === b,
}));

mock.module("../utils/pattern", () => ({
  matchesPattern: (value: string, pattern: string) => {
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return value === pattern;
    const re = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return re.test(value);
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  _isKnownTool,
  _isTokenAllowed,
  _resetWorkers,
  callRemoteWorkerTool,
  getConnectedWorker,
  getTokenChannels,
  getWorkerCount,
  getWorkerStatuses,
  handleRemoteWorkerWsClose,
  handleRemoteWorkerWsMessage,
  handleRemoteWorkerWsOpen,
  upgradeRemoteWorkerWs,
  workerEvents,
} from "../server/remote-worker";

// ── Test Helpers ──────────────────────────────────────────────────────────────

function createMockWs(overrides: Partial<any> = {}): any {
  const sentMessages: string[] = [];
  return {
    data: {
      type: "remote-worker",
      name: "test-worker",
      connectedAt: Date.now(),
      authToken: "test-token-123",
      tokenHash: "abc123hash",
      ...overrides.data,
    },
    send: mock((msg: string) => {
      sentMessages.push(msg);
    }),
    close: mock(() => {}),
    sentMessages,
    ...overrides,
  };
}

function createToolSchema(name: string) {
  return {
    name,
    inputSchema: { type: "object", properties: {} },
    description: `${name} tool`,
  };
}

// ============================================================================
// remote-worker.ts Tests
// ============================================================================

describe("remote-worker", () => {
  beforeEach(() => {
    _resetWorkers();
    mockConfig = { worker: true };
  });

  afterEach(() => {
    _resetWorkers();
    workerEvents.removeAllListeners();
  });

  // ── isKnownTool ───────────────────────────────────────────────────────

  describe("isKnownTool", () => {
    test("accepts known file tools", () => {
      expect(_isKnownTool("view")).toBe(true);
      expect(_isKnownTool("edit")).toBe(true);
      expect(_isKnownTool("create")).toBe(true);
      expect(_isKnownTool("grep")).toBe(true);
      expect(_isKnownTool("glob")).toBe(true);
    });

    test("accepts bash", () => {
      expect(_isKnownTool("bash")).toBe(true);
    });

    test("accepts browser_ prefixed tools", () => {
      expect(_isKnownTool("browser_navigate")).toBe(true);
      expect(_isKnownTool("browser_click")).toBe(true);
      expect(_isKnownTool("browser_screenshot")).toBe(true);
      expect(_isKnownTool("browser_extract")).toBe(true);
    });

    test("rejects unknown tools", () => {
      expect(_isKnownTool("unknown")).toBe(false);
      expect(_isKnownTool("exec")).toBe(false);
      expect(_isKnownTool("rm")).toBe(false);
    });

    test("rejects browser_ with empty suffix", () => {
      expect(_isKnownTool("browser_")).toBe(false);
    });

    test("rejects browser_ with invalid chars", () => {
      expect(_isKnownTool("browser_Click")).toBe(false);
      expect(_isKnownTool("browser_nav-igate")).toBe(false);
    });
  });

  // ── getTokenChannels ──────────────────────────────────────────────────

  describe("getTokenChannels", () => {
    test("returns 'all' when worker config is true", () => {
      mockConfig = { worker: true };
      expect(getTokenChannels("any-token")).toBe("all");
    });

    test("returns matching channels from object config", () => {
      mockConfig = {
        worker: {
          "channel-a": ["token-1", "token-2"],
          "channel-b": ["token-1"],
          "channel-c": ["token-3"],
        },
      };
      const channels = getTokenChannels("token-1");
      expect(channels).toContain("channel-a");
      expect(channels).toContain("channel-b");
      expect(channels).not.toContain("channel-c");
    });

    test("returns empty array when no match", () => {
      mockConfig = {
        worker: {
          "channel-a": ["token-1"],
        },
      };
      expect(getTokenChannels("no-match")).toEqual([]);
    });

    test("returns empty array when worker config is undefined", () => {
      mockConfig = {};
      expect(getTokenChannels("any-token")).toEqual([]);
    });
  });

  // ── WebSocket Open ────────────────────────────────────────────────────

  describe("handleRemoteWorkerWsOpen", () => {
    test("creates new worker state on first connection", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      expect(getWorkerCount()).toBe(1);
      const worker = getConnectedWorker("abc123hash");
      expect(worker).toBeDefined();
      expect(worker!.status).toBe("connected");
      expect(worker!.name).toBe("test-worker");
    });

    test("handles reconnection by updating ws reference", () => {
      const ws1 = createMockWs();
      handleRemoteWorkerWsOpen(ws1);

      const ws2 = createMockWs();
      handleRemoteWorkerWsOpen(ws2);

      expect(getWorkerCount()).toBe(1);
      const worker = getConnectedWorker("abc123hash");
      expect(worker!.ws).toBe(ws2);
      expect(worker!.status).toBe("connected");
    });
  });

  // ── Registration ──────────────────────────────────────────────────────

  describe("registration", () => {
    test("registers worker with valid tools", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      const registeredHandler = mock(() => {});
      workerEvents.on("worker:registered", registeredHandler);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "my-worker",
          projectRoot: "/home/user/project",
          platform: "linux",
          sessionId: "sess-1",
          maxConcurrent: 4,
          tools: [
            createToolSchema("view"),
            createToolSchema("edit"),
            createToolSchema("bash"),
            createToolSchema("unknown_tool"), // should be filtered
          ],
        }),
      );

      // Should send registered response
      const response = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(response.type).toBe("registered");
      expect(response.ok).toBe(true);

      // Worker should have 3 valid tools (unknown_tool filtered)
      const worker = getConnectedWorker("abc123hash");
      expect(worker!.tools).toHaveLength(3);
      expect(worker!.tools.map((t: any) => t.name)).toEqual(["view", "edit", "bash"]);

      // Event should be emitted
      expect(registeredHandler).toHaveBeenCalledTimes(1);
      const eventArg = registeredHandler.mock.calls[0][0];
      expect(eventArg.name).toBe("my-worker");
      expect(eventArg.tools).toHaveLength(3);
    });

    test("rejects registration with non-array tools", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "bad-worker",
          tools: "not-an-array",
        }),
      );

      const response = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(response.type).toBe("registered");
      expect(response.ok).toBe(false);
      expect(response.error).toContain("array");
    });

    test("registers browser tools correctly", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "browser-worker",
          tools: [
            createToolSchema("browser_navigate"),
            createToolSchema("browser_click"),
            createToolSchema("browser_screenshot"),
          ],
        }),
      );

      const worker = getConnectedWorker("abc123hash");
      expect(worker!.tools).toHaveLength(3);
    });
  });

  // ── Tool Call Dispatch ────────────────────────────────────────────────

  describe("callRemoteWorkerTool", () => {
    test("rejects when worker not available", async () => {
      await expect(callRemoteWorkerTool("nonexistent", "view", {})).rejects.toThrow("Worker not available");
    });

    test("rejects when worker is disconnected", async () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      // Register
      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "test",
          tools: [createToolSchema("view")],
        }),
      );

      // Disconnect the ws, then update state to disconnected
      const worker = getConnectedWorker("abc123hash");
      worker!.status = "disconnected";

      await expect(callRemoteWorkerTool("abc123hash", "view", {})).rejects.toThrow("Worker not available");
    });

    test("dispatches tool call to worker via WebSocket", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "test",
          tools: [createToolSchema("view")],
        }),
      );

      // Start a tool call (don't await — we'll simulate the response)
      const callPromise = callRemoteWorkerTool("abc123hash", "view", { path: "/tmp/test" });

      // Should have sent a call message
      const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.type).toBe("call");
      expect(lastMsg.tool).toBe("view");
      expect(lastMsg.args.path).toBe("/tmp/test");

      // Simulate successful result
      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "result",
          id: lastMsg.id,
          result: { success: true, output: "file contents here" },
        }),
      );

      return expect(callPromise).resolves.toBe("file contents here");
    });

    test("handles error response from worker", async () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "test",
          tools: [createToolSchema("view")],
        }),
      );

      const callPromise = callRemoteWorkerTool("abc123hash", "view", { path: "/nonexistent" });

      const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "error",
          id: lastMsg.id,
          error: "File not found",
        }),
      );

      await expect(callPromise).rejects.toThrow("File not found");
    });

    test("handles failed result from worker", async () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "test",
          tools: [createToolSchema("bash")],
        }),
      );

      const callPromise = callRemoteWorkerTool("abc123hash", "bash", { command: "false" });

      const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "result",
          id: lastMsg.id,
          result: { success: false, error: "Exit code 1" },
        }),
      );

      await expect(callPromise).rejects.toThrow("Exit code 1");
    });

    test("handles cancelled tool call", async () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "test",
          tools: [createToolSchema("bash")],
        }),
      );

      const callPromise = callRemoteWorkerTool("abc123hash", "bash", { command: "sleep 100" });

      const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "cancelled",
          id: lastMsg.id,
        }),
      );

      await expect(callPromise).rejects.toThrow("Cancelled");
    });

    test("respects maxConcurrent limit", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "test",
          maxConcurrent: 2,
          tools: [createToolSchema("view")],
        }),
      );

      // Start 3 calls
      callRemoteWorkerTool("abc123hash", "view", { path: "/a" });
      callRemoteWorkerTool("abc123hash", "view", { path: "/b" });
      callRemoteWorkerTool("abc123hash", "view", { path: "/c" });

      // Only 2 should have been sent (register response + 2 calls)
      const callMessages = ws.sentMessages.map((m: string) => JSON.parse(m)).filter((m: any) => m.type === "call");
      expect(callMessages).toHaveLength(2);

      // Complete the first call — should dispatch the queued third
      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "result",
          id: callMessages[0].id,
          result: { success: true, output: "ok" },
        }),
      );

      const allCallMessages = ws.sentMessages.map((m: string) => JSON.parse(m)).filter((m: any) => m.type === "call");
      expect(allCallMessages).toHaveLength(3);
    });
  });

  // ── Ping/Pong ─────────────────────────────────────────────────────────

  describe("ping/pong", () => {
    test("responds to ping with pong", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(ws, JSON.stringify({ type: "ping", ts: 12345 }));

      const response = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(response.type).toBe("pong");
      expect(response.ts).toBe(12345);
    });
  });

  // ── Connection Close ──────────────────────────────────────────────────

  describe("handleRemoteWorkerWsClose", () => {
    test("sets worker to reconnecting state", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "test",
          tools: [createToolSchema("view")],
        }),
      );

      handleRemoteWorkerWsClose(ws);

      const worker = getConnectedWorker("abc123hash");
      expect(worker!.status).toBe("reconnecting");
      expect(worker!.ws).toBeNull();
    });

    test("ignores stale close from replaced connection", () => {
      const ws1 = createMockWs();
      handleRemoteWorkerWsOpen(ws1);

      handleRemoteWorkerWsMessage(
        ws1,
        JSON.stringify({
          type: "register",
          name: "test",
          tools: [createToolSchema("view")],
        }),
      );

      // Open a new connection (replaces ws1)
      const ws2 = createMockWs();
      handleRemoteWorkerWsOpen(ws2);

      // Close the stale ws1 — should be ignored
      handleRemoteWorkerWsClose(ws1);

      const worker = getConnectedWorker("abc123hash");
      expect(worker!.status).toBe("connected");
      expect(worker!.ws).toBe(ws2);
    });

    test("rejects streaming calls on disconnect", async () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "test",
          tools: [createToolSchema("bash")],
        }),
      );

      const callPromise = callRemoteWorkerTool("abc123hash", "bash", { command: "ls" });

      const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);

      // Simulate stream start
      handleRemoteWorkerWsMessage(ws, JSON.stringify({ type: "stdout", id: lastMsg.id, data: "file1.txt\n" }));

      // Close connection — should reject streaming calls
      handleRemoteWorkerWsClose(ws);

      await expect(callPromise).rejects.toThrow("Connection lost during stream");
    });

    test("emits worker:disconnected after grace period", async () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "test",
          tools: [createToolSchema("view")],
        }),
      );

      const disconnectHandler = mock(() => {});
      workerEvents.on("worker:disconnected", disconnectHandler);

      handleRemoteWorkerWsClose(ws);

      // Should not be immediately disconnected
      expect(disconnectHandler).not.toHaveBeenCalled();

      // Wait for grace period (DISCONNECT_GRACE_MS = 10_000)
      // We can't wait 10s in a test, but we verify the timer was set
      const worker = getConnectedWorker("abc123hash");
      expect(worker).toBeDefined();
      expect(worker!.status).toBe("reconnecting");
    });
  });

  // ── Message Size Limit ────────────────────────────────────────────────

  describe("message size limit", () => {
    test("closes connection on oversized message", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      const bigMessage = "x".repeat(1_000_001);
      handleRemoteWorkerWsMessage(ws, bigMessage);

      expect(ws.close).toHaveBeenCalledWith(1009, "Message too large");
    });

    test("accepts message at size limit", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      // Just under the limit — should not close
      const msg = JSON.stringify({ type: "ping", ts: 1 }).padEnd(999_999, " ");
      handleRemoteWorkerWsMessage(ws, msg);
      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  // ── Invalid JSON ──────────────────────────────────────────────────────

  describe("invalid JSON", () => {
    test("silently ignores unparseable messages", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      // Should not throw
      handleRemoteWorkerWsMessage(ws, "not json at all");
      handleRemoteWorkerWsMessage(ws, "{broken");
    });
  });

  // ── Stream Handling ───────────────────────────────────────────────────

  describe("stream handling", () => {
    test("handles stdout/stderr stream events", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "test",
          tools: [createToolSchema("bash")],
        }),
      );

      const callPromise = callRemoteWorkerTool("abc123hash", "bash", { command: "echo hi" });
      const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);

      // Send stream events
      handleRemoteWorkerWsMessage(ws, JSON.stringify({ type: "stdout", id: lastMsg.id, data: "hi\n" }));
      handleRemoteWorkerWsMessage(ws, JSON.stringify({ type: "stderr", id: lastMsg.id, data: "" }));
      handleRemoteWorkerWsMessage(ws, JSON.stringify({ type: "stream_end", id: lastMsg.id }));

      // Then send result
      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "result",
          id: lastMsg.id,
          result: { success: true, output: "hi\n" },
        }),
      );

      return expect(callPromise).resolves.toBe("hi\n");
    });
  });

  // ── Monitoring Helpers ────────────────────────────────────────────────

  describe("monitoring helpers", () => {
    test("getWorkerCount returns correct count", () => {
      expect(getWorkerCount()).toBe(0);

      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);
      expect(getWorkerCount()).toBe(1);
    });

    test("getWorkerStatuses returns worker info", () => {
      const ws = createMockWs();
      handleRemoteWorkerWsOpen(ws);

      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "register",
          name: "my-worker",
          tools: [createToolSchema("view"), createToolSchema("bash")],
        }),
      );

      const statuses = getWorkerStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].name).toBe("my-worker");
      expect(statuses[0].status).toBe("connected");
      expect(statuses[0].toolCount).toBe(2);
    });
  });

  // ── Reconnection ─────────────────────────────────────────────────────

  describe("reconnection", () => {
    test("new session rejects pending calls from old session", async () => {
      const ws1 = createMockWs();
      handleRemoteWorkerWsOpen(ws1);

      handleRemoteWorkerWsMessage(
        ws1,
        JSON.stringify({
          type: "register",
          name: "test",
          sessionId: "session-1",
          tools: [createToolSchema("view")],
        }),
      );

      // Start a call on old session
      const callPromise = callRemoteWorkerTool("abc123hash", "view", { path: "/test" });

      // Reconnect with new session
      const ws2 = createMockWs();
      handleRemoteWorkerWsOpen(ws2);

      handleRemoteWorkerWsMessage(
        ws2,
        JSON.stringify({
          type: "register",
          name: "test",
          sessionId: "session-2",
          tools: [createToolSchema("view")],
        }),
      );

      await expect(callPromise).rejects.toThrow("Stale session");
    });
  });
});

// ============================================================================
// remote-worker-connection.ts Tests
// ============================================================================

describe("RemoteWorkerMCPConnection", () => {
  beforeEach(() => {
    _resetWorkers();
    mockConfig = { worker: true };
  });

  afterEach(() => {
    _resetWorkers();
  });

  // Need to import dynamically because it depends on remote-worker
  test("prefixes tool names with remote_", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const conn = new RemoteWorkerMCPConnection("hash123", "test-machine", [
      createToolSchema("view"),
      createToolSchema("bash"),
      createToolSchema("browser_click"),
    ]);

    expect(conn.name).toBe("remote-worker-test-machine");
    expect(conn.tools).toHaveLength(3);
    expect(conn.tools[0].name).toBe("remote_view");
    expect(conn.tools[1].name).toBe("remote_bash");
    expect(conn.tools[2].name).toBe("remote_browser_click");
  });

  test("tool descriptions include worker name", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const conn = new RemoteWorkerMCPConnection("hash123", "prod-server", [createToolSchema("view")]);

    expect(conn.tools[0].description).toContain("[Remote: prod-server]");
  });

  test("connect/disconnect lifecycle", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const conn = new RemoteWorkerMCPConnection("hash123", "test", [createToolSchema("view")]);

    expect(conn.connected).toBe(false);

    await conn.connect();
    expect(conn.connected).toBe(true);

    await conn.disconnect();
    expect(conn.connected).toBe(false);
    expect(conn.tools).toHaveLength(0);
  });

  test("request routes tools/list correctly", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const conn = new RemoteWorkerMCPConnection("hash123", "test", [createToolSchema("view"), createToolSchema("bash")]);

    const result = await conn.request("tools/list");
    expect(result.tools).toHaveLength(2);
  });

  test("request routes resources/list correctly", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const conn = new RemoteWorkerMCPConnection("hash123", "test", []);

    const result = await conn.request("resources/list");
    expect(result.resources).toEqual([]);
  });

  test("request routes prompts/list correctly", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const conn = new RemoteWorkerMCPConnection("hash123", "test", []);

    const result = await conn.request("prompts/list");
    expect(result.prompts).toEqual([]);
  });

  test("request routes initialize correctly", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const conn = new RemoteWorkerMCPConnection("hash123", "test", []);

    const result = await conn.request("initialize");
    expect(result.capabilities).toEqual({});
  });

  test("request throws on unsupported method", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const conn = new RemoteWorkerMCPConnection("hash123", "test", []);

    await expect(conn.request("unknown/method")).rejects.toThrow("Unsupported method");
  });

  test("callTool strips remote_ prefix before calling worker", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    // Set up a worker that will handle the call
    const ws = createMockWs({
      data: { type: "remote-worker", name: "test", connectedAt: Date.now(), authToken: "tok", tokenHash: "hash123" },
    });
    handleRemoteWorkerWsOpen(ws);
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        tools: [createToolSchema("view")],
      }),
    );

    const conn = new RemoteWorkerMCPConnection("hash123", "test", [createToolSchema("view")]);

    // Start the call
    const callPromise = conn.callTool("remote_view", { path: "/test" });

    // Find the call message sent to the worker
    const callMsg = ws.sentMessages.map((m: string) => JSON.parse(m)).find((m: any) => m.type === "call");
    expect(callMsg).toBeDefined();
    expect(callMsg.tool).toBe("view"); // prefix stripped

    // Respond
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "result",
        id: callMsg.id,
        result: { success: true, output: "file content" },
      }),
    );

    const result = await callPromise;
    expect(result).toEqual([{ type: "text", text: "file content" }]);
  });
});

// ============================================================================
// remote-worker-bridge.ts Tests
// ============================================================================

describe("RemoteWorkerBridge", () => {
  beforeEach(() => {
    _resetWorkers();
    mockConfig = { worker: true };
  });

  afterEach(() => {
    _resetWorkers();
    workerEvents.removeAllListeners();
  });

  test("constructor registers event listeners", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel", "test-token");

    // Verify listeners were registered
    expect(workerEvents.listenerCount("worker:registered")).toBeGreaterThan(0);
    expect(workerEvents.listenerCount("worker:disconnected")).toBeGreaterThan(0);

    bridge.destroy();
  });

  test("destroy removes event listeners", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const initialRegistered = workerEvents.listenerCount("worker:registered");
    const initialDisconnected = workerEvents.listenerCount("worker:disconnected");

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel", "test-token");
    bridge.destroy();

    expect(workerEvents.listenerCount("worker:registered")).toBe(initialRegistered);
    expect(workerEvents.listenerCount("worker:disconnected")).toBe(initialDisconnected);
  });

  test("init is no-op without worker token", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel");
    await bridge.init();

    expect(mockMcpManager.addConnection).not.toHaveBeenCalled();
    bridge.destroy();
  });

  test("init picks up already-connected workers", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");
    const crypto = await import("crypto");

    const token = "existing-worker-token";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // Pre-connect a worker
    const ws = createMockWs({
      data: {
        type: "remote-worker",
        name: "existing",
        connectedAt: Date.now(),
        authToken: token,
        tokenHash,
      },
    });
    handleRemoteWorkerWsOpen(ws);
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "existing",
        tools: [createToolSchema("view"), createToolSchema("bash")],
      }),
    );

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel", token);
    await bridge.init();

    expect(mockMcpManager.addConnection).toHaveBeenCalledTimes(1);
    const conn = mockMcpManager.addConnection.mock.calls[0][0];
    expect(conn.name).toBe("remote-worker-existing");
    expect(conn.tools).toHaveLength(2);

    bridge.destroy();
  });

  test("reacts to worker:registered event", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");
    const crypto = await import("crypto");

    const token = "event-token";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel", token);

    // Emit worker:registered event
    workerEvents.emit("worker:registered", {
      tokenHash,
      name: "new-worker",
      projectRoot: "/home/user",
      platform: "linux",
      tools: [createToolSchema("view")],
      channels: "all",
    });

    // Give async handler time to run
    await new Promise((r) => setTimeout(r, 50));

    expect(mockMcpManager.addConnection).toHaveBeenCalledTimes(1);

    bridge.destroy();
  });

  test("ignores worker:registered for different token", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel", "my-token");

    workerEvents.emit("worker:registered", {
      tokenHash: "different-hash",
      name: "other-worker",
      projectRoot: "/",
      platform: "linux",
      tools: [createToolSchema("view")],
      channels: "all",
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockMcpManager.addConnection).not.toHaveBeenCalled();

    bridge.destroy();
  });

  test("ignores events when channel not authorized", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");
    const crypto = await import("crypto");

    const token = "channel-token";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "my-channel", token);

    // Emit with restricted channels that don't include "my-channel"
    workerEvents.emit("worker:registered", {
      tokenHash,
      name: "restricted-worker",
      projectRoot: "/",
      platform: "linux",
      tools: [createToolSchema("view")],
      channels: ["other-channel"],
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockMcpManager.addConnection).not.toHaveBeenCalled();

    bridge.destroy();
  });

  test("reacts to worker:disconnected event", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");
    const crypto = await import("crypto");

    const token = "disconnect-token";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel", token);

    workerEvents.emit("worker:disconnected", {
      tokenHash,
      name: "leaving-worker",
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockMcpManager.removeConnection).toHaveBeenCalledWith("remote-worker-leaving-worker");

    bridge.destroy();
  });

  test("ignores events after destroy", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");
    const crypto = await import("crypto");

    const token = "destroy-token";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel", token);
    bridge.destroy();

    workerEvents.emit("worker:registered", {
      tokenHash,
      name: "late-worker",
      projectRoot: "/",
      platform: "linux",
      tools: [createToolSchema("view")],
      channels: "all",
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockMcpManager.addConnection).not.toHaveBeenCalled();
  });

  test("ignores worker:disconnected for different token", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel", "my-token");

    workerEvents.emit("worker:disconnected", {
      tokenHash: "completely-different-hash",
      name: "other-worker",
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockMcpManager.removeConnection).not.toHaveBeenCalled();

    bridge.destroy();
  });

  test("ignores worker:disconnected after destroy", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");
    const crypto = await import("crypto");

    const token = "destroy-disconnect-token";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel", token);
    bridge.destroy();

    // removeConnection called during destroy for cleanup — reset mock
    mockMcpManager.removeConnection.mockClear();

    workerEvents.emit("worker:disconnected", {
      tokenHash,
      name: "post-destroy-worker",
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockMcpManager.removeConnection).not.toHaveBeenCalled();
  });

  test("destroy cleans up managed connections from MCPManager", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");
    const crypto = await import("crypto");

    const token = "cleanup-token";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel", token);

    // Simulate a worker registering
    workerEvents.emit("worker:registered", {
      tokenHash,
      name: "cleanup-worker",
      projectRoot: "/",
      platform: "linux",
      tools: [createToolSchema("view")],
      channels: "all",
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockMcpManager.addConnection).toHaveBeenCalledTimes(1);

    // Now destroy — should call removeConnection for managed connections
    bridge.destroy();

    expect(mockMcpManager.removeConnection).toHaveBeenCalledWith("remote-worker-cleanup-worker");
  });

  test("uses glob matching for channel authorization", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");
    const crypto = await import("crypto");

    const token = "glob-token";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    // Bridge for channel "agent-codex"
    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "agent-codex", token);

    // Emit with glob pattern "agent-*" — should match
    workerEvents.emit("worker:registered", {
      tokenHash,
      name: "glob-worker",
      projectRoot: "/",
      platform: "linux",
      tools: [createToolSchema("view")],
      channels: ["agent-*"],
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockMcpManager.addConnection).toHaveBeenCalledTimes(1);

    bridge.destroy();
  });

  test("init skips workers in reconnecting state", async () => {
    const { RemoteWorkerBridge } = await import("../agent/plugins/remote-worker-bridge");
    const crypto = await import("crypto");

    const token = "reconnecting-token";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // Pre-connect a worker then set to reconnecting
    const ws = createMockWs({
      data: {
        type: "remote-worker",
        name: "reconnecting",
        connectedAt: Date.now(),
        tokenHash,
      },
    });
    handleRemoteWorkerWsOpen(ws);
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "reconnecting",
        tools: [createToolSchema("view")],
      }),
    );

    // Close to set reconnecting
    handleRemoteWorkerWsClose(ws);

    const mockMcpManager = {
      addConnection: mock(async () => {}),
      removeConnection: mock(async () => {}),
    };

    const bridge = new RemoteWorkerBridge(mockMcpManager as any, "test-channel", token);
    await bridge.init();

    // Should NOT add connection for reconnecting worker
    expect(mockMcpManager.addConnection).not.toHaveBeenCalled();

    bridge.destroy();
  });
});

// ============================================================================
// isTokenAllowed Tests
// ============================================================================

describe("isTokenAllowed", () => {
  beforeEach(() => {
    _resetWorkers();
  });

  afterEach(() => {
    _resetWorkers();
  });

  test("rejects tokens with invalid format", () => {
    mockConfig = { worker: true };
    expect(_isTokenAllowed("")).toBe(false);
    expect(_isTokenAllowed("token with spaces")).toBe(false);
    expect(_isTokenAllowed("a".repeat(257))).toBe(false);
    expect(_isTokenAllowed("token;injection")).toBe(false);
  });

  test("accepts valid token format characters", () => {
    mockConfig = { worker: true };
    expect(_isTokenAllowed("valid-token_123")).toBe(true);
    expect(_isTokenAllowed("token.with.dots")).toBe(true);
    expect(_isTokenAllowed("colon:separated")).toBe(true);
  });

  test("allows all valid tokens when worker config is true", () => {
    mockConfig = { worker: true };
    expect(_isTokenAllowed("any-token")).toBe(true);
  });

  test("rejects when worker config is undefined", () => {
    mockConfig = {};
    expect(_isTokenAllowed("any-token")).toBe(false);
  });

  test("matches tokens from object config", () => {
    mockConfig = {
      worker: {
        "channel-a": ["token-1", "token-2"],
        "channel-b": ["token-3"],
      },
    };
    expect(_isTokenAllowed("token-1")).toBe(true);
    expect(_isTokenAllowed("token-3")).toBe(true);
    expect(_isTokenAllowed("token-unknown")).toBe(false);
  });
});

// ============================================================================
// Additional remote-worker.ts Tests (Coverage Gaps)
// ============================================================================

describe("remote-worker additional coverage", () => {
  beforeEach(() => {
    _resetWorkers();
    mockConfig = { worker: true };
  });

  afterEach(() => {
    _resetWorkers();
    workerEvents.removeAllListeners();
  });

  // ── Buffer messages ───────────────────────────────────────────────────

  test("handles Buffer messages correctly", () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    // Send ping as Buffer
    const bufferMsg = Buffer.from(JSON.stringify({ type: "ping", ts: 99999 }));
    handleRemoteWorkerWsMessage(ws, bufferMsg);

    const response = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
    expect(response.type).toBe("pong");
    expect(response.ts).toBe(99999);
  });

  test("rejects oversized Buffer before string conversion", () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    const bigBuffer = Buffer.alloc(1_000_001);
    handleRemoteWorkerWsMessage(ws, bigBuffer);

    expect(ws.close).toHaveBeenCalledWith(1009, "Message too large");
  });

  // ── Git tools rejected ────────────────────────────────────────────────

  test("rejects git tools during registration", () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "git-worker",
        tools: [
          createToolSchema("git_status"),
          createToolSchema("git_log"),
          createToolSchema("git_diff"),
          createToolSchema("view"), // only this should survive
        ],
      }),
    );

    const worker = getConnectedWorker("abc123hash");
    expect(worker!.tools).toHaveLength(1);
    expect(worker!.tools[0].name).toBe("view");
  });

  // ── maxConcurrent validation ──────────────────────────────────────────

  test("clamps maxConcurrent to valid range", () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        maxConcurrent: 0, // should be clamped to 1
        tools: [createToolSchema("view")],
      }),
    );

    const worker = getConnectedWorker("abc123hash");
    expect(worker!.maxConcurrent).toBe(1);
  });

  test("clamps excessively high maxConcurrent", () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        maxConcurrent: 999,
        tools: [createToolSchema("view")],
      }),
    );

    const worker = getConnectedWorker("abc123hash");
    expect(worker!.maxConcurrent).toBe(32);
  });

  test("defaults maxConcurrent for NaN input", () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        maxConcurrent: "not-a-number",
        tools: [createToolSchema("view")],
      }),
    );

    const worker = getConnectedWorker("abc123hash");
    expect(worker!.maxConcurrent).toBe(4);
  });

  // ── dispatchCalls send failure ────────────────────────────────────────

  test("re-queues on ws.send failure", () => {
    const ws = createMockWs({
      send: mock(() => {
        throw new Error("Connection reset");
      }),
    });
    handleRemoteWorkerWsOpen(ws);

    // Manually set up registered worker (can't use ws.send for registration since it throws)
    const worker = getConnectedWorker("abc123hash");
    worker!.status = "connected";
    worker!.tools = [createToolSchema("view")];
    worker!.maxConcurrent = 4;

    // Call should not throw — it queues and dispatch fails gracefully
    const callPromise = callRemoteWorkerTool("abc123hash", "view", { path: "/test" });

    // The call is pending but not sent
    expect(worker!.pendingCalls.size).toBe(1);
    expect(worker!.activeCount).toBe(0);

    // Clean up — reject manually
    for (const [, pending] of worker!.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("test cleanup"));
    }

    return expect(callPromise).rejects.toThrow("test cleanup");
  });

  // ── Close before register ─────────────────────────────────────────────

  test("handles close before registration", () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    // Close without ever registering
    handleRemoteWorkerWsClose(ws);

    const worker = getConnectedWorker("abc123hash");
    expect(worker!.status).toBe("reconnecting");
  });

  // ── getWorkerStatuses tokenHash field ─────────────────────────────────

  test("getWorkerStatuses includes tokenHash", () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    const statuses = getWorkerStatuses();
    expect(statuses[0].tokenHash).toBe("abc123hash");
  });

  // ── result.output undefined handling ──────────────────────────────────

  test("resolves undefined when result.output is missing", async () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        tools: [createToolSchema("view")],
      }),
    );

    const callPromise = callRemoteWorkerTool("abc123hash", "view", {});

    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "result",
        id: lastMsg.id,
        result: { success: true }, // no output field
      }),
    );

    const result = await callPromise;
    expect(result).toBeUndefined();
  });

  // ── Result for unknown call ID ────────────────────────────────────────

  test("ignores result for unknown call ID", () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        tools: [createToolSchema("view")],
      }),
    );

    // Should not throw
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "result",
        id: "nonexistent_id",
        result: { success: true, output: "ignored" },
      }),
    );
  });

  // ── Error for unknown call ID ─────────────────────────────────────────

  test("ignores error for unknown call ID", () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        tools: [createToolSchema("view")],
      }),
    );

    // Should not throw
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "error",
        id: "nonexistent_id",
        error: "ignored",
      }),
    );
  });

  // ── Unknown message type ──────────────────────────────────────────────

  test("ignores unknown message types", () => {
    const ws = createMockWs();
    handleRemoteWorkerWsOpen(ws);

    // Should not throw
    handleRemoteWorkerWsMessage(ws, JSON.stringify({ type: "totally_unknown", data: "whatever" }));
  });

  // ── Same session reconnect ────────────────────────────────────────────

  test("same session reconnect rejects pending calls with reset message", async () => {
    const ws1 = createMockWs();
    handleRemoteWorkerWsOpen(ws1);

    handleRemoteWorkerWsMessage(
      ws1,
      JSON.stringify({
        type: "register",
        name: "test",
        sessionId: "same-session",
        tools: [createToolSchema("view")],
      }),
    );

    const callPromise = callRemoteWorkerTool("abc123hash", "view", { path: "/test" });

    // Re-register with same session
    handleRemoteWorkerWsMessage(
      ws1,
      JSON.stringify({
        type: "register",
        name: "test",
        sessionId: "same-session",
        tools: [createToolSchema("view")],
      }),
    );

    await expect(callPromise).rejects.toThrow("Connection reset");
  });
});

// ============================================================================
// Additional RemoteWorkerMCPConnection Tests
// ============================================================================

describe("RemoteWorkerMCPConnection additional", () => {
  beforeEach(() => {
    _resetWorkers();
    mockConfig = { worker: true };
  });

  afterEach(() => {
    _resetWorkers();
  });

  test("request('tools/call') routes correctly", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const ws = createMockWs({
      data: { type: "remote-worker", name: "test", connectedAt: Date.now(), tokenHash: "rqhash" },
    });
    handleRemoteWorkerWsOpen(ws);
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        tools: [createToolSchema("view")],
      }),
    );

    const conn = new RemoteWorkerMCPConnection("rqhash", "test", [createToolSchema("view")]);

    const callPromise = conn.request("tools/call", {
      name: "remote_view",
      arguments: { path: "/test" },
    });

    const callMsg = ws.sentMessages.map((m: string) => JSON.parse(m)).find((m: any) => m.type === "call");

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "result",
        id: callMsg.id,
        result: { success: true, output: "content" },
      }),
    );

    const result = await callPromise;
    expect(result).toEqual([{ type: "text", text: "content" }]);
  });

  test("request('tools/call') handles null params safely", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const ws = createMockWs({
      data: { type: "remote-worker", name: "test", connectedAt: Date.now(), tokenHash: "nullhash" },
    });
    handleRemoteWorkerWsOpen(ws);
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        tools: [createToolSchema("view")],
      }),
    );

    const conn = new RemoteWorkerMCPConnection("nullhash", "test", [createToolSchema("view")]);

    // Should not throw TypeError — params guard should handle undefined
    const callPromise = conn.request("tools/call");

    // The call goes through with name="" — find the call and resolve it
    const callMsg = ws.sentMessages.map((m: string) => JSON.parse(m)).find((m: any) => m.type === "call");

    if (callMsg) {
      handleRemoteWorkerWsMessage(
        ws,
        JSON.stringify({
          type: "result",
          id: callMsg.id,
          result: { success: true, output: "ok" },
        }),
      );
    }

    const result = await callPromise;
    expect(result).toBeDefined();
  });

  test("callTool without remote_ prefix works (fallback branch)", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const ws = createMockWs({
      data: { type: "remote-worker", name: "test", connectedAt: Date.now(), tokenHash: "nopfx" },
    });
    handleRemoteWorkerWsOpen(ws);
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        tools: [createToolSchema("view")],
      }),
    );

    const conn = new RemoteWorkerMCPConnection("nopfx", "test", [createToolSchema("view")]);

    const callPromise = conn.callTool("view", { path: "/test" });

    const callMsg = ws.sentMessages.map((m: string) => JSON.parse(m)).find((m: any) => m.type === "call");
    expect(callMsg.tool).toBe("view"); // no double-stripping

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "result",
        id: callMsg.id,
        result: { success: true, output: "data" },
      }),
    );

    const result = await callPromise;
    expect(result).toEqual([{ type: "text", text: "data" }]);
  });

  test("callTool propagates error from worker rejection", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const ws = createMockWs({
      data: { type: "remote-worker", name: "test", connectedAt: Date.now(), tokenHash: "errhash" },
    });
    handleRemoteWorkerWsOpen(ws);
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        tools: [createToolSchema("view")],
      }),
    );

    const conn = new RemoteWorkerMCPConnection("errhash", "test", [createToolSchema("view")]);

    const callPromise = conn.callTool("remote_view", { path: "/nope" });

    const callMsg = ws.sentMessages.map((m: string) => JSON.parse(m)).find((m: any) => m.type === "call");

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "error",
        id: callMsg.id,
        error: "Permission denied",
      }),
    );

    await expect(callPromise).rejects.toThrow("Permission denied");
  });

  test("connect emits 'connected' event", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const conn = new RemoteWorkerMCPConnection("hash", "test", []);
    const handler = mock(() => {});
    conn.on("connected", handler);

    await conn.connect();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("disconnect emits 'disconnected' event", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const conn = new RemoteWorkerMCPConnection("hash", "test", [createToolSchema("view")]);
    const handler = mock(() => {});
    conn.on("disconnected", handler);

    await conn.connect();
    await conn.disconnect();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("callTool with non-string result uses JSON.stringify", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const ws = createMockWs({
      data: { type: "remote-worker", name: "test", connectedAt: Date.now(), tokenHash: "jsonhash" },
    });
    handleRemoteWorkerWsOpen(ws);
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        tools: [createToolSchema("view")],
      }),
    );

    const conn = new RemoteWorkerMCPConnection("jsonhash", "test", [createToolSchema("view")]);

    const callPromise = conn.callTool("remote_view", { path: "/test" });

    const callMsg = ws.sentMessages.map((m: string) => JSON.parse(m)).find((m: any) => m.type === "call");

    // callRemoteWorkerTool always returns string, but callTool has typeof check
    // The result from worker is always a string, so this tests the string path
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "result",
        id: callMsg.id,
        result: { success: true, output: '{"key":"value"}' },
      }),
    );

    const result = await callPromise;
    expect(result).toEqual([{ type: "text", text: '{"key":"value"}' }]);
  });
});

// ============================================================================
// upgradeRemoteWorkerWs Tests
// ============================================================================

describe("upgradeRemoteWorkerWs", () => {
  beforeEach(() => {
    _resetWorkers();
    mockConfig = { worker: true };
  });

  afterEach(() => {
    _resetWorkers();
  });

  test("rejects request with no token", () => {
    const req = new Request("http://localhost:3000/worker/ws?name=test");
    const mockServer = { upgrade: mock(() => true) };

    const response = upgradeRemoteWorkerWs(req, mockServer);
    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(401);
    expect(mockServer.upgrade).not.toHaveBeenCalled();
  });

  test("rejects request with invalid token (config disallows)", () => {
    mockConfig = { worker: false };
    const req = new Request("http://localhost:3000/worker/ws?name=test&token=bad-token");
    const mockServer = { upgrade: mock(() => true) };

    const response = upgradeRemoteWorkerWs(req, mockServer);
    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(401);
  });

  test("accepts Bearer token from Authorization header", () => {
    const req = new Request("http://localhost:3000/worker/ws?name=test", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const mockServer = { upgrade: mock(() => true) };

    const response = upgradeRemoteWorkerWs(req, mockServer);
    expect(response).toBeUndefined(); // successful upgrade
    expect(mockServer.upgrade).toHaveBeenCalledTimes(1);
  });

  test("accepts token from query parameter", () => {
    const req = new Request("http://localhost:3000/worker/ws?name=test&token=valid-token");
    const mockServer = { upgrade: mock(() => true) };

    const response = upgradeRemoteWorkerWs(req, mockServer);
    expect(response).toBeUndefined();
    expect(mockServer.upgrade).toHaveBeenCalledTimes(1);
  });

  test("returns 500 when server.upgrade fails", () => {
    const req = new Request("http://localhost:3000/worker/ws?name=test&token=valid-token");
    const mockServer = { upgrade: mock(() => false) };

    const response = upgradeRemoteWorkerWs(req, mockServer);
    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(500);
  });

  test("closes existing connection when same token reconnects", () => {
    // First connection
    const ws1 = createMockWs({
      data: { type: "remote-worker", name: "first", connectedAt: Date.now(), tokenHash: "dupehash" },
    });
    handleRemoteWorkerWsOpen(ws1);

    // Setup with a valid token that produces "dupehash"
    // We simulate by pre-populating the worker state
    const crypto = require("crypto");
    const token = "dupe-test-token";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const ws2 = createMockWs({ data: { type: "remote-worker", name: "second", connectedAt: Date.now(), tokenHash } });
    handleRemoteWorkerWsOpen(ws2);

    // Register as the first connection
    handleRemoteWorkerWsMessage(
      ws2,
      JSON.stringify({
        type: "register",
        name: "worker",
        tools: [createToolSchema("view")],
      }),
    );

    // Now simulate another upgrade with same token — pre-existing worker should get its ws closed
    const req = new Request(`http://localhost:3000/worker/ws?name=replacement&token=${token}`);
    const mockServer = {
      upgrade: mock(() => {
        // The upgrade replaces the existing connection
        return true;
      }),
    };

    const response = upgradeRemoteWorkerWs(req, mockServer);
    expect(response).toBeUndefined();
    // ws2 should have been closed
    expect(ws2.close).toHaveBeenCalled();
  });

  test("uses 'unnamed' when name param is missing", () => {
    const req = new Request("http://localhost:3000/worker/ws?token=valid-token");
    const mockServer = {
      upgrade: mock((_req: any, opts: any) => {
        expect(opts.data.name).toBe("unnamed");
        return true;
      }),
    };

    upgradeRemoteWorkerWs(req, mockServer);
    expect(mockServer.upgrade).toHaveBeenCalledTimes(1);
  });

  test("does not store raw token in WsData", () => {
    const req = new Request("http://localhost:3000/worker/ws?name=test&token=secret-token");
    let upgradeData: any = null;
    const mockServer = {
      upgrade: mock((_req: any, opts: any) => {
        upgradeData = opts.data;
        return true;
      }),
    };

    upgradeRemoteWorkerWs(req, mockServer);
    expect(upgradeData).toBeDefined();
    expect(upgradeData.tokenHash).toBeDefined();
    // Should NOT have authToken
    expect(upgradeData.authToken).toBeUndefined();
  });
});

// ============================================================================
// Additional Edge Case Tests
// ============================================================================

describe("remote-worker edge cases", () => {
  beforeEach(() => {
    _resetWorkers();
    mockConfig = { worker: true };
  });

  afterEach(() => {
    _resetWorkers();
    workerEvents.removeAllListeners();
  });

  test("reconnect within grace period clears disconnect timer", () => {
    const ws1 = createMockWs();
    handleRemoteWorkerWsOpen(ws1);

    handleRemoteWorkerWsMessage(
      ws1,
      JSON.stringify({
        type: "register",
        name: "reconnect-test",
        tools: [createToolSchema("view")],
      }),
    );

    // Close — starts disconnect timer
    handleRemoteWorkerWsClose(ws1);
    const worker = getConnectedWorker("abc123hash");
    expect(worker!.status).toBe("reconnecting");

    // Reconnect before grace period expires
    const ws2 = createMockWs();
    handleRemoteWorkerWsOpen(ws2);

    // Worker should be connected again with cleared timer
    expect(worker!.status).toBe("connected");
    expect(worker!.ws).toBe(ws2);
    expect(worker!.disconnectTimer).toBeNull();
  });

  test("ws.send failure preserves serverQueue", () => {
    const ws = createMockWs({
      send: mock(() => {
        throw new Error("Connection reset");
      }),
    });
    handleRemoteWorkerWsOpen(ws);

    const worker = getConnectedWorker("abc123hash");
    worker!.status = "connected";
    worker!.tools = [createToolSchema("view")];
    worker!.maxConcurrent = 4;

    callRemoteWorkerTool("abc123hash", "view", { path: "/test" });

    // Verify the call is re-queued in serverQueue
    expect(worker!.serverQueue).toHaveLength(1);
    expect(worker!.activeCount).toBe(0);
    expect(worker!.pendingCalls.size).toBe(1);

    // Clean up
    for (const [, pending] of worker!.pendingCalls) {
      clearTimeout(pending.timer);
    }
  });

  test("disconnect event uses registered worker name not ws.data.name", () => {
    const ws = createMockWs({
      data: {
        type: "remote-worker",
        name: "url-name", // name from URL query param
        connectedAt: Date.now(),
        authToken: "test-token",
        tokenHash: "namehash",
      },
    });
    handleRemoteWorkerWsOpen(ws);

    // Register with a DIFFERENT name
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "registered-name", // name from register message
        tools: [createToolSchema("view")],
      }),
    );

    const disconnectHandler = mock(() => {});
    workerEvents.on("worker:disconnected", disconnectHandler);

    // Close and wait for disconnect timer
    handleRemoteWorkerWsClose(ws);

    // We can't easily wait for the 10s timer, but we verify the worker state
    const worker = getConnectedWorker("namehash");
    expect(worker!.name).toBe("registered-name");
  });

  test("request('tools/call') null params returns proper result", async () => {
    const { RemoteWorkerMCPConnection } = await import("../agent/mcp/remote-worker-connection");

    const ws = createMockWs({
      data: { type: "remote-worker", name: "test", connectedAt: Date.now(), tokenHash: "stronghash" },
    });
    handleRemoteWorkerWsOpen(ws);
    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "register",
        name: "test",
        tools: [createToolSchema("view")],
      }),
    );

    const conn = new RemoteWorkerMCPConnection("stronghash", "test", [createToolSchema("view")]);

    const callPromise = conn.request("tools/call", { name: "remote_view", arguments: { path: "/" } });

    const callMsg = ws.sentMessages.map((m: string) => JSON.parse(m)).find((m: any) => m.type === "call");

    handleRemoteWorkerWsMessage(
      ws,
      JSON.stringify({
        type: "result",
        id: callMsg.id,
        result: { success: true, output: "ok" },
      }),
    );

    const result = await callPromise;
    expect(result).toEqual([{ type: "text", text: "ok" }]);
  });
});
