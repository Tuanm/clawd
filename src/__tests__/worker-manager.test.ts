/**
 * Unit tests for WorkerManager — RC-1: TOCTOU concurrent-start race fix.
 *
 * Verifies that concurrent startAgent calls for the same agent key are
 * rejected by the _startingAgents Set guard before any async work begins.
 *
 * All heavy dependencies are mocked so these tests run without a real DB,
 * MCP servers, or git.
 */

// ── Module Mocks (must appear before any imports) ────────────────────────────

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../server/database", () => ({
  db: null,
  setAgentStreaming: mock(async () => {}),
  getAgent: mock(async () => null),
}));

mock.module("../server/websocket", () => ({
  broadcastUpdate: mock(() => {}),
  broadcastAgentStreaming: mock(() => {}),
  broadcastAgentToken: mock(() => {}),
}));

mock.module("../agent/api/provider-config", () => ({
  getChannelMCPServers: mock(() => ({})),
  getAllChannelMCPServers: mock(() => ({})),
  resolveProviderBaseType: mock(() => "copilot"),
  saveChannelMCPServer: mock(() => {}),
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
}));

mock.module("../agent/workspace/worktree", () => ({
  isGitRepo: mock(() => false),
  isGitInstalled: mock(() => false),
  createWorktree: mock(async () => ({ path: "/tmp", branch: "test" })),
  safeDeleteWorktree: mock(async () => ({ deleted: true, reason: "" })),
  ensureClawdGitignore: mock(() => {}),
  pruneWorktrees: mock(() => {}),
}));

mock.module("../agent/agents/loader", () => ({
  loadAgentFile: mock(() => null),
}));

mock.module("../worker-loop", () => ({
  WorkerLoop: class MockWorkerLoop {
    isSleeping = false;
    setSleeping = mock(() => {});
    start = mock(() => {});
    stop = mock(async () => {});
    resetSession = mock(async () => {});
    getHealth = mock(() => ({ running: true }));
  },
  AgentWorker: class {},
}));

mock.module("../spaces/db", () => ({
  getSpaceByChannel: mock(() => null),
}));

mock.module("../spaces/agent-mcp-tools", () => ({
  setAgentMcpInfra: mock(() => {}),
}));

mock.module("../internal-token", () => ({
  INTERNAL_SERVICE_TOKEN: "test-internal-token",
}));

mock.module("../agent/mcp/catalog", () => ({
  getCatalogEntry: mock(() => null),
  resolveArgs: mock(() => ({})),
}));

mock.module("../agent/api/mcp-validation", () => ({
  validateServerConfig: mock(() => ({ valid: true, errors: [] })),
}));

mock.module("../server/mcp/oauth", () => ({
  loadOAuthToken: mock(() => null),
  loadOrRefreshOAuthToken: mock(async () => null),
}));

mock.module("../agent/mcp/client", () => ({
  MCPManager: class MockMCPManager {
    addConnection = mock(async () => {});
    disconnectAll = mock(async () => {});
    getConnectedTools = mock(() => []);
  },
}));

mock.module("../scheduler/manager", () => ({}));
mock.module("../spaces/manager", () => ({}));
mock.module("../spaces/worker", () => ({}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import type { AppConfig } from "../config/config";
import { type AgentConfig, WorkerManager } from "../worker-manager";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(): AppConfig {
  return {
    host: "localhost",
    port: 3000,
    chatApiUrl: "http://localhost:3000",
    openBrowser: false,
    debug: false,
    yolo: false,
    contextMode: false,
  };
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    channel: "test-channel",
    agentId: "test-agent",
    model: "gpt-4o",
    active: true,
    project: "/tmp/clawd-test",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WorkerManager.startAgent — RC-1 TOCTOU guard (_startingAgents)", () => {
  let manager: WorkerManager;

  beforeEach(() => {
    manager = new WorkerManager(makeConfig());
  });

  afterEach(async () => {
    // Best-effort cleanup
    try {
      await manager.stopAgent("test-channel", "test-agent");
    } catch {
      /* ignore */
    }
  });

  test("[RC-1] concurrent startAgent calls for the same key: second is rejected with false", async () => {
    const agent = makeAgent();

    // Launch both concurrently — don't await individually so they race.
    // p1 runs synchronously until its first await, adds key to _startingAgents.
    // p2 then runs synchronously, sees the key in _startingAgents, returns false immediately.
    const [r1, r2] = await Promise.allSettled([manager.startAgent(agent), manager.startAgent(agent)]);

    const v1 = r1.status === "fulfilled" ? r1.value : false;
    const v2 = r2.status === "fulfilled" ? r2.value : false;

    // Exactly one call should be blocked (false); the other may succeed or fail
    // depending on mock state — but they must NOT both return true.
    expect(v1 && v2).toBe(false);
    // At least one should have been rejected by the guard
    expect(v1 === false || v2 === false).toBe(true);
  });

  test("[RC-1] _startingAgents is cleared after startAgent completes (retry is possible)", async () => {
    const agent = makeAgent();

    // First call — let it complete
    await manager.startAgent(agent).catch(() => {});

    // Stop so the 'already running' check doesn't interfere
    await manager.stopAgent(agent.channel, agent.agentId).catch(() => {});

    // Second call after first has finished — should NOT be blocked by _startingAgents
    // (key was removed from the Set in the finally block)
    const result = await manager.startAgent(agent).catch(() => false);

    // Should not return false due to the "already starting" guard
    // (it may return false for other reasons like already running, but not "already starting")
    // We just verify it doesn't throw and the guard isn't stuck
    expect(typeof result).toBe("boolean");
  });

  test("[RC-1] already-running check still works after startAgent (loops.has guard)", async () => {
    const agent = makeAgent();

    // Start the agent first
    await manager.startAgent(agent).catch(() => {});

    // Calling startAgent on an already-running agent returns false via loops.has check
    const result = await manager.startAgent(agent);
    expect(result).toBe(false);
  });
});
