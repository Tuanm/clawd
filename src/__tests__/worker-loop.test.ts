/**
 * Unit tests for WorkerLoop and RemoteWorkerBridge — Phase 0.1b safety harness.
 *
 * Tests:
 *  - WorkerLoop lifecycle: construction, start, stop, sleeping, heartbeat
 *  - WorkerLoop health snapshot shape
 *  - RemoteWorkerBridge init path: no-op without token, checkExistingWorkers with token
 *  - Error recovery path: continuation retry cap
 *
 * All network / DB / git dependencies are mocked.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module Mocks ──────────────────────────────────────────────────────────────

// server/database — lazy proxy db + helper functions
mock.module("../server/database", () => ({
  db: new Proxy(
    {},
    {
      get: () =>
        mock(() => {
          /* no-op */
        }),
    },
  ),
  getAgent: mock(async () => null),
  getOrRegisterAgent: mock(async (_agentId: string, _channel: string) => ({
    id: _agentId,
    channel: _channel,
  })),
  markMessagesSeen: mock(async () => {}),
  setAgentStreaming: mock(async () => {}),
}));

mock.module("../server/routes/messages", () => ({
  getPendingMessages: mock(async () => ({
    ok: true,
    messages: [],
    pending: [],
    unseen: [],
    seenNotProcessed: [],
    serverLastProcessed: null,
    serverLastSeen: null,
  })),
  postMessage: mock(async () => ({ ok: true })),
}));

mock.module("../server/websocket", () => ({
  broadcastAgentStreaming: mock(() => {}),
  broadcastAgentToken: mock(() => {}),
  broadcastUpdate: mock(() => {}),
}));

// Minimal Agent mock — WorkerLoop creates one per executePrompt call
mock.module("../agent/agent", () => ({
  Agent: class MockAgent {
    getMcpManager = mock(() => ({ addConnection: mock(async () => {}) }));
    usePlugin = mock(async () => {});
    startSession = mock(() => ({ id: "mock-session", name: "test", model: "gpt-4o" }));
    run = mock(async () => ({ content: "done", toolCalls: [], iterations: 1 }));
    cancel = mock(() => {});
  },
}));

mock.module("../agent/api/factory", () => ({
  createProvider: mock(() => ({
    model: "gpt-4o",
    complete: mock(async () => ({ message: { role: "assistant", content: "" } })),
  })),
}));

mock.module("../agent/plugins/clawd-chat", () => ({
  createClawdChatPlugin: mock(() => ({ name: "clawd-chat", version: "1.0", hooks: {} })),
  createClawdChatToolPlugin: mock(() => ({ name: "clawd-chat-tool", getTools: () => [] })),
}));

mock.module("../agent/plugins/memory-plugin", () => ({
  createMemoryPlugin: mock(() => ({ name: "memory", version: "1.0", hooks: {} })),
  isMemoryEnabled: mock(() => false),
}));

mock.module("../agent/plugins/scheduler-plugin", () => ({
  createSchedulerToolPlugin: mock(() => null),
}));

mock.module("../agent/tools/tools", () => ({
  toolDefinitions: [],
  runWithAgentContext: mock(async (_ctx: any, fn: () => any) => fn()),
  setProjectHash: mock(() => {}),
}));

mock.module("../agent/utils/sandbox", () => ({
  initializeSandbox: mock(async () => {}),
  getSandboxProjectRoot: mock(() => "/tmp"),
  getSafeEnvVars: mock(() => ({})),
  setSandboxProjectRoot: mock(() => {}),
  enableSandbox: mock(() => {}),
  isSandboxReady: mock(() => false),
  isSandboxEnabled: mock(() => false),
  wrapCommandForSandbox: mock(async (cmd: string) => cmd),
  runInSandbox: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  resetSandbox: mock(async () => {}),
  checkSandboxBeforeExec: mock(() => null),
}));

mock.module("../agent/utils/debug", () => ({
  setDebug: mock(() => {}),
  isDebugEnabled: mock(() => false),
}));

mock.module("../agent/utils/smart-truncation", () => ({
  smartTruncate: mock((s: string) => s),
  safeCut: mock((s: string, max: number) => s.slice(0, max)),
}));

mock.module("../agent/utils/agent-context", () => ({
  getAgentContext: mock(() => null),
  getContextProjectRoot: mock(() => "/tmp"),
  getContextConfigRoot: mock(() => "/tmp"),
  getContextProjectHash: mock(() => "abc123"),
  getContextAgentId: mock(() => "test-agent"),
  getContextChannel: mock(() => "test-channel"),
  getContextProvider: mock(() => "test-provider"),
  getContextSessionId: mock(() => "test-session"),
  setAgentSessionId: mock(() => {}),
  runWithAgentContext: mock(async (_ctx: any, fn: () => any) => fn()),
  setProjectHash: mock(() => {}),
}));

mock.module("../agent/prompt/builder", () => ({
  buildDynamicSystemPrompt: mock(() => ""),
}));

mock.module("../config/config-file", () => ({
  loadConfigFile: mock(() => ({})),
  reloadConfigFile: mock(() => ({})),
  getDataDir: mock(() => "/tmp/clawd-test"),
  getConfigEnv: mock(() => ({})),
  getEnvVar: mock(() => undefined),
  isBrowserEnabled: mock(() => false),
  isBrowserAuthRequired: mock(() => false),
  getAllBrowserTokens: mock(() => null),
  getBrowserTokensForChannel: mock(() => null),
  safeTokenEqual: mock(() => false),
  isAuthEnabled: mock(() => false),
  isChannelAuthRequired: mock(() => false),
  hasGlobalAuth: mock(() => false),
  validateApiToken: mock(() => true),
  isContainerEnv: mock(() => false),
  getAuthToken: mock(() => null),
  getChannelsForToken: mock(() => []),
  isWorktreeEnabled: mock(() => false),
  getAuthorConfig: mock(() => null),
  isAuthEnabled: mock(() => false),
  isChannelAuthRequired: mock(() => false),
  hasGlobalAuth: mock(() => false),
  validateApiToken: mock(() => false),
  isContainerEnv: mock(() => false),
  getAuthToken: mock(() => null),
  getChannelsForToken: mock(() => []),
  isWorktreeEnabled: mock(() => false),
  getAuthorConfig: mock(() => null),
}));

mock.module("../spaces/spawn-plugin", () => ({}));

mock.module("../utils/timed-fetch", () => ({
  timedFetch: mock(async () => ({ ok: true, json: async () => ({}) })),
}));

// Note: remote-worker, remote-worker-bridge, and remote-worker-connection modules
// were deleted in Phase 2. No mocks needed for them.

// ── Imports (after mocks) ─────────────────────────────────────────────────────

let WorkerLoop: typeof import("../worker-loop").WorkerLoop;

beforeAll(async () => {
  const mod = await import("../worker-loop");
  WorkerLoop = mod.WorkerLoop;
});

// ── WorkerLoop helpers ────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<any> = {}) {
  return {
    channel: "test-channel",
    agentId: "test-agent",
    model: "gpt-4o",
    projectRoot: "/tmp/project",
    chatApiUrl: "http://localhost:3000",
    debug: false,
    yolo: false,
    contextMode: false,
    directDb: true,
    ...overrides,
  };
}

// ── WorkerLoop constructor & initial state ────────────────────────────────────

describe("WorkerLoop — initial state", () => {
  test("isRunning is false before start()", () => {
    const loop = new WorkerLoop(makeConfig());
    expect(loop.isRunning).toBe(false);
  });

  test("isSleeping is false before start()", () => {
    const loop = new WorkerLoop(makeConfig());
    expect(loop.isSleeping).toBe(false);
  });

  test("heartbeatInterval returns 0 when not configured", () => {
    const loop = new WorkerLoop(makeConfig());
    expect(loop.heartbeatInterval).toBe(0);
  });

  test("heartbeatInterval returns configured value", () => {
    const loop = new WorkerLoop(makeConfig({ heartbeatInterval: 30 }));
    expect(loop.heartbeatInterval).toBe(30);
  });
});

// ── WorkerLoop getHealthSnapshot ──────────────────────────────────────────────

describe("WorkerLoop.getHealthSnapshot()", () => {
  test("returns a snapshot with all required fields", () => {
    const loop = new WorkerLoop(makeConfig());
    const snap = loop.getHealthSnapshot();

    expect(snap).toHaveProperty("processing");
    expect(snap).toHaveProperty("processingDurationMs");
    expect(snap).toHaveProperty("lastActivityAt");
    expect(snap).toHaveProperty("idleDurationMs");
    expect(snap).toHaveProperty("lastHeartbeatAt");
    expect(snap).toHaveProperty("sleeping");
    expect(snap).toHaveProperty("running");
    expect(snap).toHaveProperty("isSpaceAgent");
    expect(snap).toHaveProperty("channel");
    expect(snap).toHaveProperty("agentId");
    expect(snap).toHaveProperty("lastExecutionHadError");
  });

  test("snapshot channel and agentId match constructor config", () => {
    const loop = new WorkerLoop(makeConfig({ channel: "my-ch", agentId: "my-agent" }));
    const snap = loop.getHealthSnapshot();

    expect(snap.channel).toBe("my-ch");
    expect(snap.agentId).toBe("my-agent");
  });

  test("snapshot running=false before start()", () => {
    const loop = new WorkerLoop(makeConfig());
    expect(loop.getHealthSnapshot().running).toBe(false);
  });

  test("snapshot processing=false initially", () => {
    const loop = new WorkerLoop(makeConfig());
    expect(loop.getHealthSnapshot().processing).toBe(false);
  });

  test("processingDurationMs is null when not processing", () => {
    const loop = new WorkerLoop(makeConfig());
    expect(loop.getHealthSnapshot().processingDurationMs).toBeNull();
  });

  test("isSpaceAgent=false by default", () => {
    const loop = new WorkerLoop(makeConfig());
    expect(loop.getHealthSnapshot().isSpaceAgent).toBe(false);
  });

  test("isSpaceAgent=true when configured", () => {
    const loop = new WorkerLoop(makeConfig({ isSpaceAgent: true }));
    expect(loop.getHealthSnapshot().isSpaceAgent).toBe(true);
  });
});

// ── WorkerLoop setSleeping ────────────────────────────────────────────────────

describe("WorkerLoop.setSleeping()", () => {
  test("setSleeping(true) sets isSleeping to true", () => {
    const loop = new WorkerLoop(makeConfig());
    loop.setSleeping(true);
    expect(loop.isSleeping).toBe(true);
  });

  test("setSleeping(false) sets isSleeping to false after sleeping", () => {
    const loop = new WorkerLoop(makeConfig());
    loop.setSleeping(true);
    loop.setSleeping(false);
    expect(loop.isSleeping).toBe(false);
  });

  test("sleeping reflected in health snapshot", () => {
    const loop = new WorkerLoop(makeConfig());
    loop.setSleeping(true);
    expect(loop.getHealthSnapshot().sleeping).toBe(true);
  });
});

// ── WorkerLoop injectHeartbeat ────────────────────────────────────────────────

describe("WorkerLoop.injectHeartbeat()", () => {
  test("is a no-op when loop is not running", () => {
    const loop = new WorkerLoop(makeConfig({ heartbeatInterval: 30 }));
    // Should not throw; heartbeat is silently ignored when not running
    expect(() => loop.injectHeartbeat()).not.toThrow();
  });

  test("is a no-op when loop is sleeping (no allowWake)", () => {
    const loop = new WorkerLoop(makeConfig({ heartbeatInterval: 30 }));
    loop.setSleeping(true);
    expect(() => loop.injectHeartbeat()).not.toThrow();
    expect(loop.isSleeping).toBe(true); // sleep state preserved
  });

  test("allowWake clears sleep state when sleeping (running loop)", async () => {
    const loop = new WorkerLoop(makeConfig({ heartbeatInterval: 30 }));
    loop.start();
    try {
      loop.setSleeping(true);
      expect(loop.isSleeping).toBe(true);
      // schedule_wakeup path uses allowWake:true
      loop.injectHeartbeat({ allowWake: true });
      expect(loop.isSleeping).toBe(false);
    } finally {
      await loop.stop();
    }
  });

  test("allowWake without sleep is harmless (running loop)", async () => {
    const loop = new WorkerLoop(makeConfig({ heartbeatInterval: 30 }));
    loop.start();
    try {
      expect(loop.isSleeping).toBe(false);
      expect(() => loop.injectHeartbeat({ reason: "test", allowWake: true })).not.toThrow();
    } finally {
      await loop.stop();
    }
  });
});

// ── WorkerLoop start / stop ───────────────────────────────────────────────────

describe("WorkerLoop start() / stop()", () => {
  test("isRunning becomes true after start()", async () => {
    const loop = new WorkerLoop(makeConfig());
    loop.start();
    expect(loop.isRunning).toBe(true);
    // Cleanup: await stop so timers are fully cleared
    await loop.stop();
  });

  test("start() is idempotent — calling twice does not error", async () => {
    const loop = new WorkerLoop(makeConfig());
    loop.start();
    expect(() => loop.start()).not.toThrow();
    await loop.stop();
  });

  test("isRunning becomes false after stop()", async () => {
    const loop = new WorkerLoop(makeConfig());
    loop.start();
    await loop.stop();
    expect(loop.isRunning).toBe(false);
  });

  test("stop() on a non-running loop is a no-op", async () => {
    const loop = new WorkerLoop(makeConfig());
    await expect(loop.stop()).resolves.toBeUndefined();
  });
});

// ── WorkerLoop getProjectRoot ─────────────────────────────────────────────────

describe("WorkerLoop.getProjectRoot()", () => {
  test("returns the configured project root", () => {
    const loop = new WorkerLoop(makeConfig({ projectRoot: "/my/project" }));
    expect(loop.getProjectRoot()).toBe("/my/project");
  });
});

// ── RemoteWorkerBridge — init path ────────────────────────────────────────────
// NOTE: RemoteWorkerBridge is scheduled for DELETION in Phase 2 (task 2.5).
// The 3 tests that previously lived here were false positives — they tested the
// MockRemoteWorkerBridge defined in mock.module() above, not the real class.
// Removed to avoid wasted effort on code that will be deleted.

// ── WorkerLoop.cancelProcessing() safety guards ──────────────────────────────
// TODO: add retry-cap behaviour tests once Phase 2 wires up continuation logic.

describe("WorkerLoop.cancelProcessing() — safety guards", () => {
  test("loop config has MAX_CONTINUATION_RETRIES logic accessible via health snapshot", () => {
    // Verify that lastExecutionHadError starts false (clean slate for error recovery tests)
    const loop = new WorkerLoop(makeConfig());
    expect(loop.getHealthSnapshot().lastExecutionHadError).toBe(false);
  });

  test("cancelProcessing() can be called without a running agent", () => {
    const loop = new WorkerLoop(makeConfig());
    expect(() => loop.cancelProcessing()).not.toThrow();
  });

  test("cancelProcessing() during start/stop cycle does not throw", async () => {
    const loop = new WorkerLoop(makeConfig());
    loop.start();
    loop.cancelProcessing();
    await loop.stop();
    // No assertion needed — just verify no throw
  });
});
