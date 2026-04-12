/**
 * Unit tests for Agent class — Phase 0.1a safety harness.
 *
 * Tests Agent lifecycle (constructor, startSession, cancel), plugin registration,
 * and asserts the workspace prompt section currently exists before Phase 2 removes it.
 *
 * All external dependencies (SQLite, config file, hooks) are mocked so tests are
 * hermetic and fast.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Minimal SessionManager mock ───────────────────────────────────────────────

const makeSession = (name: string) => ({
  id: `session-${name}`,
  name,
  model: "gpt-4o",
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const mockSessionManager = {
  getOrCreateSession: mock((name: string, _model: string) => makeSession(name)),
  getSession: mock((_id: string) => null),
  addMessage: mock((_sessionId: string, _msg: any) => {}),
  getMessages: mock((_sessionId: string) => []),
  getRecentMessages: mock((_sessionId: string, _limit: number) => []),
  getRecentMessagesValidated: mock((_sessionId: string, _limit: number) => []),
  getRecentMessagesCompact: mock((_sessionId: string, _limit: number, _maxChars: number) => []),
  getSessionStats: mock((_sessionId: string) => ({ estimatedTokens: 0, messageCount: 0 })),
  getMessagesWithIds: mock((_sessionId: string) => []),
  compactSessionByName: mock((_name: string, _keep: number, _summary: string) => 0),
  resetSession: mock((_name: string) => {}),
  deleteSession: mock((_id: string) => {}),
};

// ── Module Mocks (hoisted by bun:test before static imports) ──────────────────

mock.module("../session/manager", () => ({
  getSessionManager: () => mockSessionManager,
  SessionManager: class {},
}));

mock.module("../../config/config-file", () => ({
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
  validateApiToken: mock(() => false),
  isContainerEnv: mock(() => false),
  getAuthToken: mock(() => null),
  getChannelsForToken: mock(() => []),
  isWorktreeEnabled: mock(() => false),
  getAuthorConfig: mock(() => null),
}));

mock.module("../hooks/manager", () => ({
  HookManager: mock(),
  getHookManager: mock(() => ({ runHooks: mock(async () => []) })),
  initializeHooks: mock(async () => ({})),
  destroyHooks: mock(async () => {}),
}));

mock.module("../memory/memory", () => ({
  estimateMessagesTokens: mock(() => 0),
  estimateTokens: mock(() => 0),
}));

mock.module("../utils/agent-context", () => ({
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
}));

mock.module("../utils/sandbox", () => ({
  getSafeEnvVars: mock(() => ({})),
  initializeSandbox: mock(async () => {}),
  setSandboxProjectRoot: mock(() => {}),
  getSandboxProjectRoot: mock(() => "/tmp"),
  enableSandbox: mock(() => {}),
  isSandboxReady: mock(() => false),
  isSandboxEnabled: mock(() => false),
  wrapCommandForSandbox: mock(async (cmd: string) => cmd),
  runInSandbox: mock(async () => ({ output: "", exitCode: 0 })),
  resetSandbox: mock(async () => {}),
  checkSandboxBeforeExec: mock(() => null),
}));

mock.module("../tools/tools", () => ({
  toolDefinitions: [],
  executeTools: mock(async () => []),
  getSandboxProjectRoot: mock(() => "/tmp"),
  runWithAgentContext: mock(async (_ctx: any, fn: () => any) => fn()),
  setProjectHash: mock(() => {}),
}));

mock.module("../skills/manager", () => ({
  getSkillManager: mock(() => ({
    getSkills: () => [],
    getSkillsSummary: () => "",
  })),
}));

const mockMicroCompactor = {
  reset: mock(() => {}),
  onTurnEnd: mock(async () => null),
  isEnabled: mock(() => false),
};

mock.module("../utils/microcompaction", () => ({
  getMicroCompactor: mock(() => mockMicroCompactor),
  clearMicroCompactor: mock((_dir: string) => {}),
}));

mock.module("../agents/loader", () => ({
  resolveToolAliases: mock((tools: any[]) => tools),
  buildAgentSystemPrompt: mock(() => ""),
  listAgentFiles: mock(async () => []),
  loadAgentFile: mock(async () => null),
}));

mock.module("../api/key-pool", () => ({
  MODEL_MULTIPLIERS: {},
  getModelMultiplier: mock((_model: string) => 1),
  AllKeysSuspendedError: class AllKeysSuspendedError extends Error {},
  keyPool: {
    getNextKey: mock(() => null),
    markKeyFailed: mock(() => {}),
    markKeySuccess: mock(() => {}),
  },
}));

mock.module("../api/factory", () => ({
  createProvider: mock((_type: string, _model: string) => mockLLMProvider),
}));

// ── Mock LLM Provider ─────────────────────────────────────────────────────────

const mockLLMProvider = {
  model: "gpt-4o",
  complete: mock(async (_req: any) => ({
    message: { role: "assistant", content: "Mock response" },
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  })),
  completeStream: mock(async function* () {
    yield { type: "text", text: "Mock" };
  }),
};

// ── Import Agent (after mocks are in place) ───────────────────────────────────

let Agent: typeof import("../agent").Agent;
let AgentConfig: any;

beforeAll(async () => {
  const mod = await import("../agent");
  Agent = mod.Agent;
});

// ── Reset mocks between tests ─────────────────────────────────────────────────

beforeEach(() => {
  mockSessionManager.getOrCreateSession.mockClear();
  mockSessionManager.addMessage.mockClear();
  mockLLMProvider.complete.mockClear();
});

// ── Workspace Prompt Section (Post-Phase-2: all workspace items removed) ───────

describe("DEFAULT_SYSTEM_PROMPT — workspace section removed (Phase 2)", () => {
  // Phase 2 removed all workspace features. Assert they are gone.
  const agentSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../agent.ts"), "utf-8");

  test("source no longer contains ## Workspace Tools section", () => {
    expect(agentSrc).not.toContain("## Workspace Tools");
  });

  test("source no longer references spawn_workspace in workspace section", () => {
    expect(agentSrc).not.toContain("spawn_workspace");
  });

  test("source no longer references list_workspaces in workspace section", () => {
    expect(agentSrc).not.toContain("list_workspaces");
  });

  test("source no longer imports WorkspaceToolPlugin", () => {
    expect(agentSrc).not.toContain("WorkspaceToolPlugin");
  });

  test("source no longer contains _workspacePluginRegistered guard field", () => {
    expect(agentSrc).not.toContain("_workspacePluginRegistered");
  });
});

// ── Agent Constructor ─────────────────────────────────────────────────────────

describe("Agent constructor", () => {
  test("creates an Agent instance with an LLMProvider", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    expect(agent).toBeDefined();
    expect(agent).toBeInstanceOf(Agent);
  });

  test("exposes MCPManager via getMcpManager()", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    const mcpManager = agent.getMcpManager();
    expect(mcpManager).toBeDefined();
  });

  test("getPluginManager() returns null before any plugin is registered", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    expect(agent.getPluginManager()).toBeNull();
  });
});

// ── startSession ──────────────────────────────────────────────────────────────

describe("Agent.startSession()", () => {
  test("creates and returns a session with the given name", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    const session = agent.startSession("my-session");

    expect(session).toBeDefined();
    expect(session.name).toBe("my-session");
    expect(mockSessionManager.getOrCreateSession).toHaveBeenCalledWith("my-session", expect.any(String));
  });

  test("getSession() returns the session after startSession()", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    agent.startSession("test-session");

    const session = agent.getSession();
    expect(session).not.toBeNull();
    expect(session?.name).toBe("test-session");
  });

  test("getSession() returns null before startSession() is called", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    expect(agent.getSession()).toBeNull();
  });
});

// ── cancel / abort ────────────────────────────────────────────────────────────

describe("Agent.cancel()", () => {
  test("can be called without errors before a run", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    expect(() => agent.cancel()).not.toThrow();
  });

  test("can be called multiple times without errors", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    expect(() => {
      agent.cancel();
      agent.cancel();
      agent.cancel();
    }).not.toThrow();
  });
});

describe("Agent.abort()", () => {
  test("can be called without errors", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    expect(() => agent.abort()).not.toThrow();
  });
});

// ── Plugin Registration ───────────────────────────────────────────────────────

describe("Agent.usePlugin()", () => {
  test("registers a plugin and creates PluginManager on first call", async () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });

    expect(agent.getPluginManager()).toBeNull();

    const mockPlugin = {
      name: "test-plugin",
      version: "1.0.0",
      description: "Test plugin",
      hooks: {
        onInit: mock(async () => {}),
      },
    };

    await agent.usePlugin(mockPlugin);

    expect(agent.getPluginManager()).not.toBeNull();
    expect(mockPlugin.hooks.onInit).toHaveBeenCalledTimes(1);
  });

  test("registers multiple plugins independently", async () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });

    const pluginA = {
      name: "plugin-a",
      version: "1.0.0",
      hooks: { onInit: mock(async () => {}) },
    };
    const pluginB = {
      name: "plugin-b",
      version: "1.0.0",
      hooks: { onInit: mock(async () => {}) },
    };

    await agent.usePlugin(pluginA);
    await agent.usePlugin(pluginB);

    expect(pluginA.hooks.onInit).toHaveBeenCalledTimes(1);
    expect(pluginB.hooks.onInit).toHaveBeenCalledTimes(1);
  });

  test("throws when registering the same plugin name twice", async () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });

    const plugin = {
      name: "duplicate-plugin",
      version: "1.0.0",
      hooks: {},
    };

    await agent.usePlugin(plugin);
    await expect(agent.usePlugin({ ...plugin })).rejects.toThrow("already registered");
  });
});

describe("Agent.removePlugin()", () => {
  test("removes a registered plugin without errors", async () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });

    const plugin = {
      name: "removable-plugin",
      version: "1.0.0",
      hooks: {
        onShutdown: mock(async () => {}),
      },
    };

    await agent.usePlugin(plugin);
    await agent.removePlugin("removable-plugin");

    expect(plugin.hooks.onShutdown).toHaveBeenCalledTimes(1);
  });

  test("is a no-op when plugin was never registered", async () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    await expect(agent.removePlugin("nonexistent")).resolves.toBeUndefined();
  });
});

// ── resumeSession ─────────────────────────────────────────────────────────────

describe("Agent.resumeSession()", () => {
  test("returns null when session does not exist", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    mockSessionManager.getSession.mockImplementation(() => null);
    const result = agent.resumeSession("nonexistent-session-id");
    expect(result).toBeNull();
  });

  test("sets the active session when session exists", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o" });
    const fakeSession = makeSession("resumed-session");
    mockSessionManager.getSession.mockImplementation(() => fakeSession);

    const result = agent.resumeSession(fakeSession.id);
    expect(result).toEqual(fakeSession);
    expect(agent.getSession()).toEqual(fakeSession);
  });
});

// ── Context Metrics ───────────────────────────────────────────────────────────

describe("Agent.getContextMetrics()", () => {
  test("returns null when contextMode is not enabled", () => {
    const agent = new Agent(mockLLMProvider, { model: "gpt-4o", contextMode: false });
    expect(agent.getContextMetrics()).toBeNull();
  });
});
