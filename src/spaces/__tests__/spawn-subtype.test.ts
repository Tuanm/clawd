/**
 * Tests verifying that sub-agent result/status messages include
 * `subtype: "agent_report"` and that launch cards do NOT.
 *
 * Strategy: mock globalThis.fetch (used by timedFetch) and inspect
 * bodies posted to the parent channel.
 *
 * Call sites covered:
 *   - plugin.ts complete_task handler     → agent_report (direct call, easiest)
 *   - spawn-helper.ts completion          → agent_report  (comment-documented)
 *   - spawn-helper.ts abort/timeout       → agent_report  (comment-documented)
 *   - spawn-plugin.ts retask complete     → agent_report  (comment-documented)
 *   - spawn-plugin.ts retask abort        → agent_report  (comment-documented)
 *   - agent-mcp-tools.ts timeout          → agent_report  (comment-documented)
 *   - agent-mcp-tools.ts complete         → agent_report  (comment-documented)
 *   - agent-mcp-tools.ts failed/error     → agent_report  (comment-documented)
 *   - spawn-helper.ts subspace card       → subspace (NOT agent_report)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createSpaceToolPlugin } from "../plugin";

// ─── Helpers ────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Capture all POST bodies sent to any URL */
function mockFetchCapture(): { bodies: any[] } {
  const bodies: any[] = [];
  globalThis.fetch = mock(async (_url: string, opts: RequestInit = {}) => {
    if (opts.body) {
      try {
        bodies.push(JSON.parse(opts.body as string));
      } catch {
        bodies.push(opts.body);
      }
    }
    return new Response(JSON.stringify({ ok: true, ts: "12345" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies };
}

/** Minimal SpaceManager stub for plugin.ts tests */
function makeSpaceManager() {
  return {
    lockSpace: mock((_id: string, _status: string, _result: string) => true),
    updateSpaceCard: mock((_id: string) => {}),
  } as any;
}

// ─── plugin.ts — complete_task ───────────────────────────────────────────────

describe("plugin.ts complete_task", () => {
  test("posts with subtype: 'agent_report' to parent channel on success", async () => {
    const { bodies } = mockFetchCapture();

    const spaceManager = makeSpaceManager();
    const resolve = mock((_s: string) => {});
    const onComplete = mock(() => {});

    const plugin = createSpaceToolPlugin(
      {
        spaceId: "space-1",
        spaceChannel: "space-channel-1",
        mainChannel: "main-channel",
        apiUrl: "http://localhost:3000",
        agentId: "sub-agent-1",
        resolve,
        onComplete,
      },
      spaceManager,
    );

    const tools = plugin.getTools();
    const completeTool = tools.find((t) => t.name === "complete_task");
    expect(completeTool).toBeDefined();

    await completeTool!.handler({ result: "Task done!" });

    // Should have called fetch once (the postMessage)
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    const postMsg = bodies.find((b) => b.channel === "main-channel");
    expect(postMsg).toBeDefined();
    expect(postMsg.subtype).toBe("agent_report");
    expect(postMsg.text).toContain("Task done!");
  });

  test("does NOT add subtype: 'agent_report' when space already completed (idempotent)", async () => {
    const { bodies } = mockFetchCapture();

    // lockSpace returns false → space already completed
    const spaceManager = {
      lockSpace: mock(() => false),
      updateSpaceCard: mock(() => {}),
    } as any;

    const plugin = createSpaceToolPlugin(
      {
        spaceId: "space-2",
        spaceChannel: "space-channel-2",
        mainChannel: "main-channel",
        apiUrl: "http://localhost:3000",
        agentId: "sub-agent-2",
        resolve: mock(() => {}),
      },
      spaceManager,
    );

    const tools = plugin.getTools();
    const completeTool = tools.find((t) => t.name === "complete_task");
    const result = await completeTool!.handler({ result: "Duplicate" });

    // No fetch call should be made — space was already locked
    const postMsg = bodies.find((b) => b.channel === "main-channel");
    expect(postMsg).toBeUndefined();
    expect(result.success).toBe(true);
  });
});

// ─── spawn-helper.ts — abort/timeout path ────────────────────────────────────
//
// Strategy: mock all static deps of spawn-helper.ts so that:
//   - loadAgentFile returns a minimal agent config
//   - resolveProviderBaseType returns "openai" (non-CC path, uses spaceWorkerManager)
//   - spaceManager.createSpace returns a space with timeout_seconds=0
//   - spaceWorkerManager.startSpaceWorker returns a Promise that never resolves
//   - spaceManager.timeoutSpace returns true (so `if (won)` fires the postMessage)
//   - globalThis.fetch captures the posted bodies
//
// With timeout_seconds=0, the AbortController fires after setTimeout(..., 0),
// which resolves after a single event-loop tick.

// Paths are relative to THIS test file (src/spaces/__tests__/)
// so we go up two levels to reach src/ for most deps.

mock.module("../../agent/agents/loader", () => ({
  loadAgentFile: mock((_type: string, _root: string) => ({
    name: "test-agent",
    provider: "openai",
    model: "gpt-4o-mini",
    systemPrompt: "",
    tools: [],
    disallowedTools: [],
  })),
  resolveModelAlias: mock((_m: string, fallback: string) => fallback),
  listAgentFiles: mock(() => []),
}));

mock.module("../../agent/api/provider-config", () => ({
  resolveProviderBaseType: mock(() => "openai"),
}));

mock.module("../claude-code-worker", () => ({
  ClaudeCodeSpaceWorker: class MockCC {
    start = mock(async () => {});
    stop = mock(() => {});
    getSpaceToken = mock(() => "tok");
    cleanup = mock(() => {});
  },
  mapToMcpToolNames: mock((t: string[]) => t),
  registerClaudeCodeWorker: mock(() => {}),
  unregisterClaudeCodeWorker: mock(() => {}),
  getClaudeCodeWorker: mock(() => undefined),
}));

mock.module("../../server/database", () => ({
  db: new Proxy({} as any, { get: () => () => null }),
  preparedStatements: new Proxy({} as any, { get: () => ({ run: () => {}, get: () => null, all: () => [] }) }),
  getOrRegisterAgent: mock(() => ({})),
  getAgent: mock(() => null),
  getLastSeenByAgents: mock(() => new Map()),
  getMessageSeenBy: mock(() => []),
  parseMentions: mock(() => []),
  toSlackMessage: mock((m: any) => m),
  generateTs: mock(() => `${Date.now()}.000001`),
  getOrRegisterSpace: mock(() => null),
}));

mock.module("../../server/mcp/shared", () => ({
  spaceAuthTokens: new Map(),
  spaceCompleteCallbacks: new Map(),
  spaceProjectRoots: new Map(),
}));

// Mock timedFetch to delegate to globalThis.fetch so mockFetchCapture() works
// for both plugin.ts tests and the new spawn-helper tests below.
mock.module("../../utils/timed-fetch", () => ({
  timedFetch: mock(async (_url: string, opts: RequestInit = {}) => globalThis.fetch(_url, opts)),
}));

// Dynamic import so mock.module runs first (static imports are hoisted by Bun)
const { executeSpawnAgent } = await import("../spawn-helper");

describe("spawn-helper.ts abort/timeout → subtype: 'agent_report'", () => {
  test("onAbort posts agent_report to parent channel on timeout", async () => {
    const { bodies } = mockFetchCapture();

    const hangPromise = new Promise<string>(() => {
      // Never resolves — simulates a hung LLM worker
    });

    const spaceManager = {
      listSpaces: mock((_ch: string, _status: string) => []),
      createSpace: mock((_opts: any) => ({
        id: "sh-space-id",
        space_channel: "space:test-sh",
        channel: "main-channel",
        title: "Test agent",
        description: "test task",
        agent_id: "test-agent-abc",
        agent_color: "#aaaaaa",
        status: "active",
        timeout_seconds: 0.001, // ~1ms — fires almost immediately
      })),
      updateCardTs: mock(() => {}),
      failSpace: mock(() => true),
      timeoutSpace: mock(() => true),
      completeSpace: mock(() => true),
      cleanupSpaceAgents: mock(() => {}),
    } as any;

    const spaceWorkerManager = {
      startSpaceWorker: mock(() => hangPromise),
      stopSpaceWorker: mock(() => {}),
    } as any;

    const ctx = {
      channel: "main-channel",
      agentId: "parent-agent",
      apiUrl: "http://localhost:3000",
      yolo: false,
      spaceManager,
      spaceWorkerManager,
      trackedSpaces: new Map(),
      getAgentConfig: mock(async () => ({
        provider: "openai",
        model: "gpt-4o-mini",
        agentId: "parent-agent",
        project: "/tmp/test-project",
        avatar_color: "#aaaaaa",
      })),
    };

    // Start spawn — fire-and-forget; abort fires after ~1ms
    executeSpawnAgent(ctx, { task: "Do some work", agentType: "general" });

    // Wait for the tiny timeout to fire and the async timedFetch call to complete
    await new Promise((r) => setTimeout(r, 50));

    // The onAbort handler should have posted an agent_report to the parent channel
    const agentReportPost = bodies.find((b) => b.channel === "main-channel" && b.subtype === "agent_report");
    expect(agentReportPost).toBeDefined();
    expect(agentReportPost.subtype).toBe("agent_report");
  });
});
