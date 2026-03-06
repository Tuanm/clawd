/**
 * Worker Manager - Manages per-channel-per-agent worker loops
 *
 * Each active agent in a channel gets its own WorkerLoop instance.
 * The manager loads initial config from SQLite and responds to
 * add/remove agent requests from the API.
 */

import type { AppConfig } from "./config";
import type { SchedulerManager } from "./scheduler/manager";
import { WorkerLoop, type WorkerLoopConfig } from "./worker-loop";
import { MCPManager } from "./agent/src/mcp/client";
import { getChannelMCPServers } from "./agent/src/api/provider-config";
import { loadOAuthToken } from "./mcp-oauth";

import type { SpaceManager } from "./spaces/manager";
import type { SpaceWorkerManager } from "./spaces/worker";

export interface AgentConfig {
  /** Channel ID (e.g., "chat-task") */
  channel: string;
  /** Agent display name (e.g., "Claw'd") */
  agentId: string;
  /** Provider to use (e.g., "copilot", "openai", "anthropic") */
  provider?: string;
  /** Model to use (e.g., "default", "sonnet", "opus") */
  model: string;
  /** Whether the agent is active (auto-start on startup) */
  active: boolean;
  /** Per-agent project root */
  project?: string;
  /** Whether the agent is sleeping (paused) */
  sleeping?: boolean;
  /** Worker token for remote worker binding */
  workerToken?: string;
}

export class WorkerManager {
  private loops: Map<string, WorkerLoop> = new Map();
  private config: AppConfig;
  private scheduler?: SchedulerManager;
  private spaceManager?: SpaceManager;
  private spaceWorkerManager?: SpaceWorkerManager;
  /** Channel-scoped MCP managers: channel → MCPManager */
  private channelMcp: Map<string, MCPManager> = new Map();
  /** Pending MCP setup promises to prevent double-creation on concurrent agent starts */
  private channelMcpPending: Map<string, Promise<MCPManager | null>> = new Map();

  constructor(config: AppConfig, scheduler?: SchedulerManager) {
    this.config = config;
    this.scheduler = scheduler;
  }

  setSpaceInfra(spaceManager: SpaceManager, spaceWorkerManager: SpaceWorkerManager): void {
    this.spaceManager = spaceManager;
    this.spaceWorkerManager = spaceWorkerManager;
  }

  /** Start the worker manager -- loads agents from DB and starts active loops */
  async start(): Promise<void> {
    console.log("[WorkerManager] Starting...");

    // Load agents from the chat server's database
    const agents = await this.loadAgentsFromDb();
    console.log(`[WorkerManager] Found ${agents.length} configured agent(s)`);

    // Start active agents
    for (const agent of agents) {
      if (agent.active) {
        await this.startAgent(agent);
      }
    }

    console.log(`[WorkerManager] ${this.loops.size} worker loop(s) running`);
  }

  /** Stop all worker loops */
  async stop(): Promise<void> {
    console.log("[WorkerManager] Stopping all worker loops...");
    const stopPromises = Array.from(this.loops.values()).map((loop) => loop.stop());
    await Promise.all(stopPromises);
    this.loops.clear();

    // Disconnect all channel MCP managers
    for (const [channel, mcp] of this.channelMcp) {
      try {
        await mcp.disconnectAll();
        console.log(`[WorkerManager] Disconnected channel MCP: ${channel}`);
      } catch (err) {
        console.error(`[WorkerManager] Error disconnecting channel MCP ${channel}:`, err);
      }
    }
    this.channelMcp.clear();
    this.channelMcpPending.clear();

    console.log("[WorkerManager] All worker loops stopped");
  }

  /** Add and start a new agent */
  async startAgent(agent: AgentConfig): Promise<boolean> {
    const key = `${agent.channel}:${agent.agentId}`;

    if (this.loops.has(key)) {
      console.log(`[WorkerManager] Agent ${key} already running`);
      return false;
    }

    // Ensure channel MCP servers are running (starts on first agent in channel)
    const channelMcpManager = await this.ensureChannelMcp(agent.channel);

    const loopConfig: WorkerLoopConfig = {
      channel: agent.channel,
      agentId: agent.agentId,
      provider: agent.provider,
      model: agent.model,
      projectRoot: agent.project || this.config.projectRoot,
      chatApiUrl: this.config.chatApiUrl,
      debug: this.config.debug,
      yolo: this.config.yolo,
      contextMode: this.config.contextMode,
      scheduler: this.scheduler,
      spaceManager: this.spaceManager,
      spaceWorkerManager: this.spaceWorkerManager,
      channelMcpManager: channelMcpManager || undefined,
      workerToken: agent.workerToken,
    };

    const loop = new WorkerLoop(loopConfig);
    this.loops.set(key, loop);

    // Set sleeping state before starting (if was sleeping before restart)
    if (agent.sleeping) {
      loop.setSleeping(true);
      console.log(`[WorkerManager] Agent ${key} starting in sleep mode`);
    }

    loop.start();

    console.log(
      `[WorkerManager] Started agent: ${key} (provider: ${agent.provider || "copilot"}, model: ${agent.model}, sleeping: ${agent.sleeping || false})`,
    );
    return true;
  }

  /** Stop and remove an agent */
  async stopAgent(channel: string, agentId: string): Promise<boolean> {
    const key = `${channel}:${agentId}`;
    const loop = this.loops.get(key);

    if (!loop) {
      console.log(`[WorkerManager] Agent ${key} not found`);
      return false;
    }

    await loop.stop();
    this.loops.delete(key);

    // Tear down channel MCP if this was the last agent in the channel
    await this.teardownChannelMcpIfEmpty(channel);

    console.log(`[WorkerManager] Stopped agent: ${key}`);
    return true;
  }

  /** Set agent sleeping state */
  setAgentSleeping(channel: string, agentId: string, sleeping: boolean): boolean {
    const key = `${channel}:${agentId}`;
    const loop = this.loops.get(key);

    if (!loop) {
      return false;
    }

    loop.setSleeping(sleeping);
    return true;
  }

  /** Restart an agent (e.g., after model change) */
  async restartAgent(agent: AgentConfig): Promise<boolean> {
    await this.stopAgent(agent.channel, agent.agentId);
    return await this.startAgent(agent);
  }

  /**
   * Reset all agents in a channel: cancel active runs and wipe their sessions.
   * Called after a /clear command so agents start with a clean slate.
   */
  async resetChannel(channel: string): Promise<void> {
    const resets: Promise<void>[] = [];
    for (const [key, loop] of this.loops) {
      if (key.startsWith(`${channel}:`)) {
        resets.push(loop.resetSession());
      }
    }
    await Promise.allSettled(resets);
    console.log(`[WorkerManager] Reset ${resets.length} agent(s) for channel: ${channel}`);
  }

  /** Get status of all running loops */
  getStatus(): { key: string; running: boolean }[] {
    return Array.from(this.loops.entries()).map(([key, loop]) => ({
      key,
      running: loop.isRunning,
    }));
  }

  /** Check if an agent is running */
  isAgentRunning(channel: string, agentId: string): boolean {
    const key = `${channel}:${agentId}`;
    const loop = this.loops.get(key);
    return loop?.isRunning || false;
  }

  /** Load agent configs from the chat server database via API */
  private async loadAgentsFromDb(): Promise<AgentConfig[]> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(`${this.config.chatApiUrl}/api/app.agents.list?internal=1`, {
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      const data = (await res.json()) as any;

      if (data.ok && Array.isArray(data.agents)) {
        return data.agents.map((a: any) => ({
          channel: a.channel,
          agentId: a.agent_id,
          provider: a.provider || "copilot",
          model: a.model || "default",
          active: a.active !== false,
          project: a.project || "",
          sleeping: a.sleeping === true,
          workerToken: a.worker_token || undefined,
        }));
      }
    } catch (error) {
      console.log("[WorkerManager] No saved agents found (API not available yet), starting fresh");
    }

    return [];
  }

  // ===========================================================================
  // Channel MCP Lifecycle
  // ===========================================================================

  /** Count running agents in a channel */
  private getChannelAgentCount(channel: string): number {
    let count = 0;
    for (const key of this.loops.keys()) {
      if (key.startsWith(`${channel}:`)) count++;
    }
    return count;
  }

  /**
   * Ensure channel MCP servers are running.
   * Creates and connects an MCPManager for the channel on first agent start.
   * Uses a pending-promise map to prevent double-creation on concurrent starts.
   */
  private async ensureChannelMcp(channel: string): Promise<MCPManager | null> {
    // Already running
    if (this.channelMcp.has(channel)) {
      return this.channelMcp.get(channel)!;
    }

    // Another agent is concurrently setting up — wait for it
    if (this.channelMcpPending.has(channel)) {
      return this.channelMcpPending.get(channel)!;
    }

    // Load channel MCP server configs
    const serverConfigs = getChannelMCPServers(channel);
    const serverNames = Object.keys(serverConfigs);
    if (serverNames.length === 0) {
      return null; // No MCP servers configured for this channel
    }

    // Create and connect
    const setupPromise = (async (): Promise<MCPManager | null> => {
      const mcpManager = new MCPManager();
      const enabledEntries = Object.entries(serverConfigs).filter(([, c]) => c.enabled !== false);
      console.log(`[WorkerManager] Starting ${enabledEntries.length} MCP server(s) for channel: ${channel}`);

      for (const [name, config] of enabledEntries) {
        try {
          // Skip HTTP+OAuth servers without a valid token (need browser OAuth flow)
          let token: string | undefined;
          if (config.oauth?.client_id) {
            const stored = loadOAuthToken(channel, name);
            token = stored?.access_token;
            if (!token) {
              console.log(`[WorkerManager] Skipping MCP server ${name} (no OAuth token — connect via UI)`);
              continue;
            }
          }
          await mcpManager.addServer({
            name,
            command: config.command,
            args: config.args,
            env: config.env,
            url: config.url,
            transport: config.transport,
            token,
          });
          console.log(`[WorkerManager] Connected MCP server: ${name} (channel: ${channel})`);
        } catch (err) {
          console.error(
            `[WorkerManager] Failed to connect MCP server ${name} for channel ${channel}: ${(err as any)?.message || err}`,
          );
        }
      }

      this.channelMcp.set(channel, mcpManager);
      this.channelMcpPending.delete(channel);
      return mcpManager;
    })();

    this.channelMcpPending.set(channel, setupPromise);

    try {
      return await setupPromise;
    } catch (err) {
      this.channelMcpPending.delete(channel);
      console.error(`[WorkerManager] Failed to setup channel MCP for ${channel}:`, err);
      return null;
    }
  }

  /** Tear down channel MCP if no more agents in the channel */
  private async teardownChannelMcpIfEmpty(channel: string): Promise<void> {
    if (this.getChannelAgentCount(channel) > 0) return;

    const mcp = this.channelMcp.get(channel);
    if (!mcp) return;

    try {
      await mcp.disconnectAll();
      console.log(`[WorkerManager] Disconnected channel MCP: ${channel} (last agent stopped)`);
    } catch (err) {
      console.error(`[WorkerManager] Error disconnecting channel MCP ${channel}:`, err);
    }
    this.channelMcp.delete(channel);
  }

  // ===========================================================================
  // MCP Server CRUD (for UI)
  // ===========================================================================

  /** Get or create the MCPManager for a channel */
  async getOrCreateChannelMcp(channel: string): Promise<MCPManager> {
    const existing = this.channelMcp.get(channel);
    if (existing) return existing;

    // Wait for any in-flight ensureChannelMcp() to finish first
    const pending = this.channelMcpPending.get(channel);
    if (pending) {
      const result = await pending;
      if (result) return result;
    }

    const mgr = new MCPManager();
    this.channelMcp.set(channel, mgr);
    return mgr;
  }

  /** Add a single MCP server to a channel (hot-add at runtime) */
  async addChannelMcpServer(
    channel: string,
    name: string,
    config: {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      transport?: "stdio" | "http";
      token?: string;
    },
  ): Promise<{ success: boolean; tools: number; error?: string }> {
    const mgr = await this.getOrCreateChannelMcp(channel);

    // Remove existing if re-adding
    if (mgr.listServers().includes(name)) {
      await mgr.removeServer(name);
    }

    try {
      await mgr.addServer({
        name,
        command: config.command,
        args: config.args,
        env: config.env,
        url: config.url,
        transport: config.transport,
        token: config.token,
      });
      const tools = mgr.getAllTools().filter((t) => t.server === name).length;
      console.log(`[WorkerManager] Added MCP server: ${name} (channel: ${channel}, ${tools} tools)`);
      return { success: true, tools };
    } catch (err: any) {
      console.error(`[WorkerManager] Failed to add MCP server ${name} for channel ${channel}: ${err.message}`);
      return { success: false, tools: 0, error: err.message };
    }
  }

  /** Remove a single MCP server from a channel */
  async removeChannelMcpServer(channel: string, name: string): Promise<boolean> {
    const mgr = this.channelMcp.get(channel);
    if (!mgr) return false;

    try {
      await mgr.removeServer(name);
    } catch (err) {
      console.error(`[WorkerManager] Error removing MCP server ${name} from ${channel}:`, err);
    }
    console.log(`[WorkerManager] Removed MCP server: ${name} (channel: ${channel})`);

    // Clean up empty MCPManager if no servers left and no agents
    if (mgr.listServers().length === 0 && this.getChannelAgentCount(channel) === 0) {
      this.channelMcp.delete(channel);
      this.channelMcpPending.delete(channel);
    }
    return true;
  }

  /** Get runtime status of all MCP servers for a channel */
  getChannelMcpStatus(channel: string): Array<{ name: string; connected: boolean; tools: number }> {
    const mgr = this.channelMcp.get(channel);
    if (!mgr) return [];
    return mgr.getServerStatuses();
  }

  /** Get the shared MCPManager for a channel (if any) */
  getChannelMcpManager(channel: string): MCPManager | undefined {
    return this.channelMcp.get(channel);
  }
}
