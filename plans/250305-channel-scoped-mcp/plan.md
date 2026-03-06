---
title: "Channel-Scoped MCP Servers"
description: "Share MCP server instances per channel instead of per agent, with lifecycle tied to agent presence"
status: pending
priority: P1
effort: 6h
branch: main
tags: [mcp, worker-manager, agent, config]
created: 2025-03-05
---

# Channel-Scoped MCP Servers

## Problem

Currently each Agent spawns its own stdio MCP child processes via `mcpManager`. If a channel has 3 agents and 2 MCP servers configured, that's **6 child processes** doing the same thing. Wasteful and potentially conflicting (e.g., filesystem-based MCPs).

Additionally, there's no way to scope MCP servers to specific channels — `mcp_servers` in config is global.

## Goal

1. New config key `mcpServers` in `~/.clawd/config.json` — maps channel → server configs
2. Shared MCPManager per channel, lifecycle tied to agent presence
3. Zero duplicate stdio processes for same-channel agents

## Config Format

```json
{
  "mcpServers": {
    "dev-channel": {
      "notion": {
        "command": "npx",
        "args": ["-y", "@notionhq/mcp-server"],
        "env": { "NOTION_TOKEN": "..." }
      },
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/projects"]
      }
    },
    "design-channel": {
      "figma": {
        "command": "npx",
        "args": ["-y", "figma-mcp-server"],
        "env": { "FIGMA_TOKEN": "..." }
      }
    }
  }
}
```

Backward compat: existing `mcp_servers` (global, flat) remains untouched — those are still loaded by `getMCPServers()` in provider-config.ts and injected per-agent by the clawd-chat plugin.

## Architecture

```
WorkerManager
  ├── loops: Map<"ch:agent", WorkerLoop>          (existing)
  └── channelMcp: Map<"channel", MCPManager>      (NEW)

Agent
  ├── mcpManager: MCPManager         (own — clawd-chat HTTP, workspace, etc.)
  └── sharedMcpManager?: MCPManager  (NEW — channel-scoped, read-only reference)
```

### Lifecycle

```
startAgent("dev-channel", "agent-1")
  → first agent in dev-channel
  → WorkerManager creates MCPManager, connects servers from mcpServers["dev-channel"]
  → stores in channelMcp.set("dev-channel", mgr)
  → passes mgr ref to WorkerLoop

startAgent("dev-channel", "agent-2")
  → channelMcp already has "dev-channel"
  → passes existing mgr ref to WorkerLoop

stopAgent("dev-channel", "agent-2")
  → still 1 agent left in dev-channel → no-op on MCP

stopAgent("dev-channel", "agent-1")
  → 0 agents left in dev-channel
  → channelMcp.get("dev-channel").disconnectAll()
  → channelMcp.delete("dev-channel")
```

### Tool Resolution Order (in Agent)

1. Built-in tools (`toolDefinitions`)
2. Own `mcpManager` tools (clawd-chat HTTP, workspace MCP)
3. **Shared `sharedMcpManager` tools** (channel-scoped)
4. Plugin tools (`toolPluginManager`)

Deduplication: later sources skip tools already registered by earlier sources (existing pattern via `toolNames` Set).

### Agent Close Behavior

`Agent.close()` calls `this.mcpManager.disconnectAll()` — this only disconnects the agent's **own** manager. The shared manager is NOT disconnected by Agent; WorkerManager owns that lifecycle.

---

## Implementation Phases

### Phase 1: Config Loading (30m)

**File: `src/agent/src/api/providers.ts`**

Add `mcpServers` to the `Config` interface:

```typescript
export interface Config {
  providers: Record<string, ProviderConfig | CopilotProviderConfig | OllamaProviderConfig>;
  mcp_servers?: Record<string, MCPServerConfig>;
  /** Channel-scoped MCP servers: channel name → server name → config */
  mcpServers?: Record<string, Record<string, MCPServerConfig>>;
}
```

**File: `src/agent/src/api/provider-config.ts`**

Add helper to read channel-scoped config:

```typescript
/**
 * Get MCP servers scoped to a specific channel.
 * Reads from ~/.clawd/config.json under mcpServers[channel].
 */
export function getChannelMCPServers(channel: string): Record<string, MCPServerConfig> {
  const config = loadConfig();
  return config.mcpServers?.[channel] || {};
}
```

### Phase 2: WorkerManager Channel MCP Lifecycle (1.5h)

**File: `src/worker-manager.ts`**

Add `channelMcp` map and lifecycle methods:

```typescript
import { MCPManager } from "./agent/src/mcp/client";
import { getChannelMCPServers } from "./agent/src/api/provider-config";

export class WorkerManager {
  private loops: Map<string, WorkerLoop> = new Map();
  private channelMcp: Map<string, MCPManager> = new Map();
  // ... existing fields ...

  /** Count running (non-sleeping) loops for a channel */
  private countChannelAgents(channel: string): number {
    let count = 0;
    for (const [key, loop] of this.loops) {
      if (key.startsWith(`${channel}:`) && loop.isRunning) {
        count++;
      }
    }
    return count;
  }

  /** Start channel MCP servers if this is the first agent */
  private async ensureChannelMcp(channel: string): Promise<MCPManager | undefined> {
    if (this.channelMcp.has(channel)) {
      return this.channelMcp.get(channel);
    }

    const serverConfigs = getChannelMCPServers(channel);
    const entries = Object.entries(serverConfigs);
    if (entries.length === 0) return undefined;

    console.log(`[WorkerManager] Starting ${entries.length} channel MCP server(s) for "${channel}"`);
    const mgr = new MCPManager();

    for (const [name, cfg] of entries) {
      try {
        await mgr.addServer({
          name,
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
          url: cfg.url,
          transport: cfg.transport || "stdio",
        });
        console.log(`[WorkerManager] Channel MCP "${name}" connected for "${channel}"`);
      } catch (err: any) {
        console.error(`[WorkerManager] Channel MCP "${name}" failed for "${channel}": ${err.message}`);
      }
    }

    this.channelMcp.set(channel, mgr);
    return mgr;
  }

  /** Stop channel MCP if no agents remain */
  private async maybeStopChannelMcp(channel: string): Promise<void> {
    if (this.countChannelAgents(channel) > 0) return;

    const mgr = this.channelMcp.get(channel);
    if (!mgr) return;

    console.log(`[WorkerManager] Stopping channel MCP servers for "${channel}" (no agents left)`);
    await mgr.disconnectAll();
    this.channelMcp.delete(channel);
  }
```

**Modify `startAgent()`:**

```typescript
  async startAgent(agent: AgentConfig): Promise<boolean> {  // make async
    const key = `${agent.channel}:${agent.agentId}`;
    if (this.loops.has(key)) {
      console.log(`[WorkerManager] Agent ${key} already running`);
      return false;
    }

    // Ensure channel MCP is up before creating the loop
    const channelMcpManager = await this.ensureChannelMcp(agent.channel);

    const loopConfig: WorkerLoopConfig = {
      // ... existing fields ...
      channelMcpManager,  // NEW
    };

    // ... rest unchanged ...
  }
```

> Note: `startAgent` changes from sync → async. Callers in `start()` already `await` nothing but call `this.startAgent(agent)` without await. Fix: `await this.startAgent(agent)` in the startup loop.

**Modify `stopAgent()`:**

```typescript
  async stopAgent(channel: string, agentId: string): Promise<boolean> {
    const key = `${channel}:${agentId}`;
    const loop = this.loops.get(key);
    if (!loop) { /* ... */ return false; }

    await loop.stop();
    this.loops.delete(key);

    // Check if channel MCP should be torn down
    await this.maybeStopChannelMcp(channel);

    console.log(`[WorkerManager] Stopped agent: ${key}`);
    return true;
  }
```

**Modify `stop()` (shutdown all):**

```typescript
  async stop(): Promise<void> {
    console.log("[WorkerManager] Stopping all worker loops...");
    const stopPromises = Array.from(this.loops.values()).map((loop) => loop.stop());
    await Promise.all(stopPromises);
    this.loops.clear();

    // Disconnect all channel MCP managers
    for (const [channel, mgr] of this.channelMcp) {
      console.log(`[WorkerManager] Disconnecting channel MCP for "${channel}"`);
      await mgr.disconnectAll();
    }
    this.channelMcp.clear();

    console.log("[WorkerManager] All worker loops stopped");
  }
```

### Phase 3: WorkerLoop Passes Shared MCPManager (30m)

**File: `src/worker-loop.ts`**

Add to `WorkerLoopConfig`:

```typescript
export interface WorkerLoopConfig {
  // ... existing fields ...
  /** Shared channel-scoped MCP manager (owned by WorkerManager) */
  channelMcpManager?: import("./agent/src/mcp/client").MCPManager;
}
```

In `executePrompt()`, pass to Agent via config:

```typescript
const agentConfig: AgentConfig = {
  // ... existing fields ...
  sharedMcpManager: this.config.channelMcpManager,  // NEW
};
```

### Phase 4: Agent Integrates Shared MCPManager (2h)

**File: `src/agent/src/agent/agent.ts`**

**4a. Add to AgentConfig interface:**

```typescript
export interface AgentConfig {
  // ... existing fields ...
  /** Shared MCP manager (channel-scoped, NOT owned by this agent) */
  sharedMcpManager?: MCPManager;
}
```

**4b. Store reference in constructor:**

```typescript
export class Agent {
  private mcpManager: MCPManager = new MCPManager();
  private sharedMcpManager: MCPManager | null = null;  // NEW
  // ...

  constructor(tokenOrProvider: string | LLMProvider, config: AgentConfig) {
    // ... existing code ...
    this.sharedMcpManager = config.sharedMcpManager || null;
  }
```

**4c. Modify `getTools()` — merge shared MCP tools:**

```typescript
  private getTools() {
    const tools = [...toolDefinitions];
    const toolNames = new Set(tools.map((t) => t.function.name));

    // Add own MCP tools (clawd-chat HTTP, workspace, etc.)
    const mcpTools = this.mcpManager.getToolDefinitions();
    for (const tool of mcpTools) {
      if (!toolNames.has(tool.function.name)) {
        tools.push(tool);
        toolNames.add(tool.function.name);
      }
    }

    // Add shared channel MCP tools (dedupe against own)
    if (this.sharedMcpManager) {
      const sharedTools = this.sharedMcpManager.getToolDefinitions();
      for (const tool of sharedTools) {
        if (!toolNames.has(tool.function.name)) {
          tools.push(tool);
          toolNames.add(tool.function.name);
        }
      }
    }

    // Add plugin tools (dedupe)
    const pluginTools = this.toolPluginManager.getToolDefinitions();
    for (const tool of pluginTools) {
      if (!toolNames.has(tool.function.name)) {
        tools.push(tool);
        toolNames.add(tool.function.name);
      }
    }

    return tools;
  }
```

**4d. Modify `executeSingleToolCall()` — check shared MCP:**

```typescript
    // Check if it's an MCP tool — own manager first, then shared
    if (this.mcpManager.hasTool(toolCall.function.name)) {
      // Own MCP tool (unchanged)
      const mcpResult = await this.mcpManager.executeMCPTool(toolCall.function.name, transformedArgs);
      result = {
        success: mcpResult.success,
        output: mcpResult.success ? JSON.stringify(mcpResult.result) : "",
        error: mcpResult.error,
      };
    } else if (this.sharedMcpManager?.hasTool(toolCall.function.name)) {
      // Shared channel MCP tool
      if (isDebugEnabled()) {
        console.log(`[Agent] Executing shared MCP tool: ${toolCall.function.name}`);
      }
      const mcpResult = await this.sharedMcpManager.executeMCPTool(toolCall.function.name, transformedArgs);
      result = {
        success: mcpResult.success,
        output: mcpResult.success ? JSON.stringify(mcpResult.result) : "",
        error: mcpResult.error,
      };
    } else if (this.toolPluginManager.hasPluginTool(toolCall.function.name)) {
      // ... existing plugin tool code ...
```

**4e. `close()` does NOT touch shared manager:**

The existing `close()` calls `this.mcpManager.disconnectAll()` — this is correct because it only disconnects the agent's own manager. `sharedMcpManager` is a borrowed reference; Agent never disconnects it. No change needed here.

### Phase 5: Fix startAgent Async + Startup (30m)

**File: `src/worker-manager.ts`**

`startAgent` must become `async` to `await ensureChannelMcp()`. Update the `start()` method:

```typescript
  async start(): Promise<void> {
    // ... load agents ...
    for (const agent of agents) {
      if (agent.active) {
        await this.startAgent(agent);  // was: this.startAgent(agent)
      }
    }
    // ...
  }
```

`restartAgent` already awaits stopAgent, then calls startAgent — update:

```typescript
  async restartAgent(agent: AgentConfig): Promise<boolean> {
    await this.stopAgent(agent.channel, agent.agentId);
    return await this.startAgent(agent);  // add await
  }
```

Check all other callers of `startAgent` across the codebase:

```bash
grep -rn "startAgent\|\.startAgent(" src/ --include="*.ts" | grep -v node_modules
```

Any caller that doesn't `await` needs updating.

### Phase 6: WorkspacePlugin Compatibility (15m)

`WorkspaceToolPlugin` takes `MCPManager` in constructor (line 1205 of agent.ts). It uses the agent's own manager to register workspace MCP connections. This is fine — workspace MCPs are per-agent, not channel-scoped. No change needed.

---

## Files Changed (Summary)

| File | Change |
|------|--------|
| `src/agent/src/api/providers.ts` | Add `mcpServers` to `Config` interface |
| `src/agent/src/api/provider-config.ts` | Add `getChannelMCPServers()` function |
| `src/worker-manager.ts` | Add `channelMcp` map, `ensureChannelMcp()`, `maybeStopChannelMcp()`, modify `startAgent` (async), `stopAgent`, `stop` |
| `src/worker-loop.ts` | Add `channelMcpManager` to `WorkerLoopConfig`, pass to `AgentConfig` |
| `src/agent/src/agent/agent.ts` | Add `sharedMcpManager` to `AgentConfig`, store in constructor, use in `getTools()` + `executeSingleToolCall()` |

**No changes to:**
- `src/agent/src/mcp/client.ts` — MCPManager is already sufficient
- `src/agent/plugins/clawd-chat/agent.ts` — `getMcpServers()` still returns global MCP + clawd-chat HTTP (agent-owned)
- `src/config-file.ts` — channel MCP config lives in provider-config's Config, not ConfigFile

## Edge Cases

1. **Config reload**: If user edits `mcpServers` while agents are running, changes won't take effect until agents restart. Acceptable — same as current `mcp_servers` behavior (file is cached).

2. **Sleeping agents**: A sleeping agent still counts as "present" in `countChannelAgents` (it's in the loops Map and `isRunning` is true). Channel MCP stays up. This is intentional — sleeping agents wake instantly and need tools ready.

3. **Empty channel config**: If `mcpServers["channel-x"]` is `{}` or absent, `ensureChannelMcp` returns `undefined`, WorkerLoop gets no shared manager, Agent behaves exactly as today.

4. **Tool name collision**: If a channel MCP server exposes a tool with the same name as a built-in or clawd-chat tool, the built-in/own-MCP version wins (deduplication). Logged in debug mode.

5. **Concurrent startAgent calls**: Two agents starting simultaneously for a new channel could race on `ensureChannelMcp`. Fix: the method checks `channelMcp.has(channel)` first, and since JS is single-threaded (no true parallelism in Bun's event loop for sync Map operations), the first `await` will set the map before the second enters. However, if both calls reach the method before either completes the async `addServer`, we could double-create. **Mitigation**: Add a `pendingChannelMcp: Map<string, Promise<MCPManager>>` to deduplicate:

```typescript
private channelMcpPending: Map<string, Promise<MCPManager | undefined>> = new Map();

private async ensureChannelMcp(channel: string): Promise<MCPManager | undefined> {
  if (this.channelMcp.has(channel)) return this.channelMcp.get(channel);
  if (this.channelMcpPending.has(channel)) return this.channelMcpPending.get(channel);

  const promise = this._createChannelMcp(channel);
  this.channelMcpPending.set(channel, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    this.channelMcpPending.delete(channel);
  }
}
```

## Testing Strategy

1. **Unit**: Mock `getChannelMCPServers` to return configs, verify `ensureChannelMcp` creates MCPManager with correct servers
2. **Integration**: Start 2 agents on same channel, verify only 1 MCPManager exists, stop both, verify disconnected
3. **Manual**: Add `mcpServers` to `~/.clawd/config.json`, start agents, check `[WorkerManager]` logs for "Starting channel MCP" / "Stopping channel MCP"

## Unresolved Questions

1. **Should sleeping agents keep channel MCP alive?** Current plan: yes (they count as present). Alternative: only count non-sleeping agents, start/stop MCP on wake/sleep transitions. This adds complexity for unclear benefit — sleeping agents wake quickly and need tools. **Recommendation: keep it simple, sleeping = alive.**

2. **Should global `mcp_servers` also be channel-scoped?** Not in this PR. Global MCP stays per-agent via the plugin path. If needed later, could add a `"*"` wildcard key in `mcpServers` for "all channels".

3. **Hot-reload of `mcpServers` config?** Not in scope. Would require file watching + diff logic. Users can restart agents to pick up changes.
