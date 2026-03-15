/**
 * Worker Manager - Manages per-channel-per-agent worker loops
 *
 * Each active agent in a channel gets its own WorkerLoop instance.
 * The manager loads initial config from SQLite and responds to
 * add/remove agent requests from the API.
 */

import { getChannelMCPServers } from "./agent/src/api/provider-config";
import { MCPManager } from "./agent/src/mcp/client";
import type { AppConfig } from "./config";
import { loadOAuthToken } from "./mcp-oauth";
import type { SchedulerManager } from "./scheduler/manager";
import { setAgentStreaming } from "./server/database";
import { broadcastUpdate } from "./server/websocket";
import { getSpaceByChannel } from "./spaces/db";
import type { SpaceManager } from "./spaces/manager";
import type { SpaceWorkerManager } from "./spaces/worker";
import { timedFetch } from "./utils/timed-fetch";
import { type AgentHealthSnapshot, WorkerLoop, type WorkerLoopConfig } from "./worker-loop";

/** Resolved heartbeat configuration (all fields required, defaults applied) */
interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  processingTimeoutMs: number;
  spaceIdleTimeoutMs: number;
  /** Idle timeout for main channel agents after error (shorter than space agents) */
  mainAgentErrorIdleTimeoutMs: number;
  maxNudges: number;
}

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

  // Heartbeat monitor state
  private heartbeatConfig: HeartbeatConfig;
  private heartbeatTimer: Timer | null = null;
  private heartbeatInProgress = false;

  constructor(config: AppConfig, scheduler?: SchedulerManager) {
    this.config = config;
    this.scheduler = scheduler;
    this.heartbeatConfig = {
      enabled: config.heartbeat?.enabled ?? true,
      intervalMs: config.heartbeat?.intervalMs ?? 30_000,
      processingTimeoutMs: config.heartbeat?.processingTimeoutMs ?? 300_000,
      spaceIdleTimeoutMs: config.heartbeat?.spaceIdleTimeoutMs ?? 60_000,
      mainAgentErrorIdleTimeoutMs: config.heartbeat?.mainAgentErrorIdleTimeoutMs ?? 20_000,
      maxNudges: config.heartbeat?.maxNudges ?? 5,
    };
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

    // Start heartbeat monitor after all agents are running
    this.startHeartbeatMonitor();
  }

  /** Stop all worker loops */
  async stop(): Promise<void> {
    console.log("[WorkerManager] Stopping all worker loops...");

    // Stop heartbeat monitor first and wait for in-flight check to drain
    this.stopHeartbeatMonitor();
    const drainStart = Date.now();
    while (this.heartbeatInProgress && Date.now() - drainStart < 2000) {
      await Bun.sleep(50);
    }

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
      wsUrl: this.config.chatApiUrl.replace(/^http(s?):\/\//, "ws$1://"),
      debug: this.config.debug,
      yolo: this.config.yolo,
      contextMode: this.config.contextMode,
      scheduler: this.scheduler,
      spaceManager: this.spaceManager,
      spaceWorkerManager: this.spaceWorkerManager,
      channelMcpManager: channelMcpManager || undefined,
      workerToken: agent.workerToken,
      // Remote workers go through the HTTP API; in-process agents use direct DB access
      directDb: !agent.workerToken,
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

  // ===========================================================================
  // Heartbeat Monitor — automatic recovery for stuck agents
  // ===========================================================================

  private startHeartbeatMonitor(): void {
    if (!this.heartbeatConfig.enabled) return;
    this.scheduleNextHeartbeat();
    console.log(
      `[Heartbeat] Monitor started (interval: ${this.heartbeatConfig.intervalMs}ms, ` +
        `processingTimeout: ${this.heartbeatConfig.processingTimeoutMs}ms, ` +
        `spaceIdleTimeout: ${this.heartbeatConfig.spaceIdleTimeoutMs}ms, ` +
        `maxNudges: ${this.heartbeatConfig.maxNudges})`,
    );
  }

  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** setTimeout chain (not setInterval) — prevents overlapping async checks */
  private scheduleNextHeartbeat(): void {
    this.heartbeatTimer = setTimeout(async () => {
      await this.runHeartbeatCheck();
      if (this.heartbeatTimer !== null) {
        this.scheduleNextHeartbeat();
      }
    }, this.heartbeatConfig.intervalMs);
    // Don't keep the process alive just for heartbeat
    if (typeof this.heartbeatTimer === "object" && "unref" in this.heartbeatTimer) {
      (this.heartbeatTimer as any).unref();
    }
  }

  /** Main heartbeat check — iterates all main agent loops + space workers */
  private async runHeartbeatCheck(): Promise<void> {
    if (this.heartbeatInProgress) return; // Reentrance guard
    this.heartbeatInProgress = true;
    try {
      // Collect async nudge actions to run in parallel (bounded concurrency).
      // Synchronous actions (cancelProcessing, clearError) run inline.
      const nudgeActions: Array<() => Promise<void>> = [];

      // Check main channel agent loops
      for (const [key, loop] of this.loops) {
        const health = loop.getHealthSnapshot();

        // GUARD: Never touch sleeping agents
        if (health.sleeping) continue;
        // GUARD: Skip stopped loops
        if (!health.running) continue;

        // CHECK 1: Processing timeout — agent has been processing for too long
        if (
          health.processing &&
          health.processingDurationMs !== null &&
          health.processingDurationMs > this.heartbeatConfig.processingTimeoutMs
        ) {
          console.log(`[Heartbeat] Processing timeout: ${key} (${Math.round(health.processingDurationMs / 1000)}s)`);
          loop.cancelProcessing();
          this.clearAgentStreamingState(health.channel, health.agentId);
          this.broadcastHeartbeatEvent(health.channel, health.agentId, "processing_timeout");
          continue;
        }

        // CHECK 2: Space agent idle with incomplete task (main loop space agents)
        if (
          health.isSpaceAgent &&
          !health.processing &&
          health.idleDurationMs > this.heartbeatConfig.spaceIdleTimeoutMs
        ) {
          nudgeActions.push(() => this.handleIdleSpaceAgent(key, loop, health));
          continue;
        }

        // CHECK 3: Main channel agent idle after error — nudge to retry
        // Uses shorter timeout than space agents (20s vs 60s) for faster recovery
        if (
          !health.isSpaceAgent &&
          !health.processing &&
          health.lastExecutionHadError &&
          health.idleDurationMs > this.heartbeatConfig.mainAgentErrorIdleTimeoutMs
        ) {
          if (health.nudgeCount >= this.heartbeatConfig.maxNudges) {
            console.log(`[Heartbeat] Max nudges exhausted for ${key} after error, giving up`);
            loop.clearLastExecutionError();
            this.broadcastHeartbeatEvent(health.channel, health.agentId, "max_nudges_exhausted");
            continue;
          }
          nudgeActions.push(async () => {
            const nudged = await loop.postNudge(
              "Agent idle after stream error — retrying",
              this.heartbeatConfig.maxNudges,
            );
            if (nudged) {
              console.log(
                `[Heartbeat] Nudged idle agent after error: ${key} (attempt ${health.nudgeCount + 1}/${this.heartbeatConfig.maxNudges})`,
              );
              this.broadcastHeartbeatEvent(health.channel, health.agentId, "nudge_sent");
            }
          });
        }
      }

      // Run collected nudge actions with bounded concurrency (max 5 parallel)
      // to prevent a large number of agents from flooding the event loop.
      await this.runWithConcurrencyLimit(nudgeActions, 5);

      // Check space workers (stored in SpaceWorkerManager, NOT in this.loops)
      await this.checkSpaceWorkerHealth();
    } catch (err) {
      console.error("[Heartbeat] Error during health check:", err);
    } finally {
      this.heartbeatInProgress = false;
    }
  }

  /** Run async actions with bounded concurrency */
  private async runWithConcurrencyLimit(actions: Array<() => Promise<void>>, limit: number): Promise<void> {
    if (actions.length === 0) return;
    // Process in batches of `limit`
    for (let i = 0; i < actions.length; i += limit) {
      const batch = actions.slice(i, i + limit);
      await Promise.allSettled(batch.map((fn) => fn()));
    }
  }

  /** Handle an idle space agent that may need nudging or auto-failing */
  private async handleIdleSpaceAgent(key: string, loop: WorkerLoop, health: AgentHealthSnapshot): Promise<void> {
    const spaceStatus = this.getSpaceStatus(health.channel);
    if (!spaceStatus || !spaceStatus.active || spaceStatus.locked) return;

    if (health.nudgeCount >= this.heartbeatConfig.maxNudges) {
      // Exhausted nudges — auto-fail the space
      console.log(`[Heartbeat] Max nudges exhausted for ${key}, failing space`);
      this.autoFailSpace(
        health.channel,
        spaceStatus.spaceId,
        spaceStatus.parentChannel,
        spaceStatus.title,
        spaceStatus.agentId,
      );
      this.broadcastHeartbeatEvent(health.channel, health.agentId, "max_nudges_exhausted");
      return;
    }

    // Post nudge
    const nudged = await loop.postNudge(
      "Agent idle with incomplete task",
      this.heartbeatConfig.maxNudges,
      spaceStatus.description,
    );
    if (nudged) {
      console.log(
        `[Heartbeat] Nudged agent: ${key} (attempt ${health.nudgeCount + 1}/${this.heartbeatConfig.maxNudges})`,
      );
      this.broadcastHeartbeatEvent(health.channel, health.agentId, "nudge_sent");
    }
  }

  /** Check space worker health — the MAIN recovery path for stuck subspace agents */
  private async checkSpaceWorkerHealth(): Promise<void> {
    if (!this.spaceWorkerManager) return;
    const snapshots = this.spaceWorkerManager.getWorkerHealthSnapshots();
    const nudgeActions: Array<() => Promise<void>> = [];

    for (const { spaceId, health } of snapshots) {
      // GUARD: Never touch sleeping agents
      if (health.sleeping) continue;
      if (!health.running) continue;

      const key = `space:${spaceId}`;

      // CHECK 1: Processing timeout (synchronous — no backpressure concern)
      if (
        health.processing &&
        health.processingDurationMs !== null &&
        health.processingDurationMs > this.heartbeatConfig.processingTimeoutMs
      ) {
        console.log(`[Heartbeat] Processing timeout: ${key} (${Math.round(health.processingDurationMs / 1000)}s)`);
        const loop = this.spaceWorkerManager.getWorkerLoop(spaceId);
        if (loop) loop.cancelProcessing();
        this.clearAgentStreamingState(health.channel, health.agentId);
        this.broadcastHeartbeatEvent(health.channel, health.agentId, "processing_timeout");
        continue;
      }

      // CHECK 2: Space agent idle with incomplete task
      if (!health.processing && health.idleDurationMs > this.heartbeatConfig.spaceIdleTimeoutMs) {
        const spaceStatus = this.getSpaceStatus(health.channel);
        if (!spaceStatus || !spaceStatus.active || spaceStatus.locked) continue;

        if (health.nudgeCount >= this.heartbeatConfig.maxNudges) {
          console.log(`[Heartbeat] Max nudges exhausted for ${key}, failing space`);
          this.autoFailSpace(
            health.channel,
            spaceStatus.spaceId,
            spaceStatus.parentChannel,
            spaceStatus.title,
            spaceStatus.agentId,
          );
          this.broadcastHeartbeatEvent(health.channel, health.agentId, "max_nudges_exhausted");
          continue;
        }

        const loop = this.spaceWorkerManager.getWorkerLoop(spaceId);
        if (loop) {
          nudgeActions.push(async () => {
            const nudged = await loop.postNudge(
              "Agent idle with incomplete task",
              this.heartbeatConfig.maxNudges,
              spaceStatus.description,
            );
            if (nudged) {
              console.log(
                `[Heartbeat] Nudged space agent: ${key} ` +
                  `(attempt ${health.nudgeCount + 1}/${this.heartbeatConfig.maxNudges})`,
              );
              this.broadcastHeartbeatEvent(health.channel, health.agentId, "nudge_sent");
            }
          });
        }
      }
    }

    // Run space nudges with bounded concurrency (same limit as main agent nudges)
    await this.runWithConcurrencyLimit(nudgeActions, 5);
  }

  /** Get space status by space_channel (direct DB query, no network call) */
  private getSpaceStatus(spaceChannel: string): {
    spaceId: string;
    active: boolean;
    locked: boolean;
    description: string | null;
    parentChannel: string;
    title: string;
    agentId: string;
  } | null {
    const space = getSpaceByChannel(spaceChannel);
    if (!space) return null;
    return {
      spaceId: space.id,
      active: space.status === "active",
      locked: !!space.locked,
      description: space.description,
      parentChannel: space.channel,
      title: space.title,
      agentId: space.agent_id,
    };
  }

  /** Auto-fail a space when nudges are exhausted — sub-agent fails immediately */
  private autoFailSpace(
    spaceChannel: string,
    spaceId: string,
    parentChannel: string,
    title: string,
    agentId: string,
  ): void {
    if (!this.spaceManager) return;
    const won = this.spaceManager.failSpace(spaceId, "Heartbeat: agent unresponsive after max recovery attempts");
    // stopSpaceWorker rejects the space promise, causing the parent agent to see the failure immediately
    this.spaceWorkerManager?.stopSpaceWorker(spaceId);
    // Notify parent channel so the parent agent knows (matches spawn-plugin onAbort pattern)
    if (won) {
      timedFetch(`${this.config.chatApiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: parentChannel,
          text: `Sub-space failed (unresponsive): ${title}`,
          user: "UBOT",
          agent_id: agentId,
        }),
      }).catch(() => {});
    }
  }

  /** Clear streaming DB flag for an agent */
  private clearAgentStreamingState(_channel: string, agentId: string): void {
    try {
      setAgentStreaming(agentId, _channel, false);
    } catch {
      // Best-effort; streaming state will eventually be cleared by clearStaleStreamingStates()
    }
  }

  /** Broadcast heartbeat event via WebSocket for UI awareness */
  private broadcastHeartbeatEvent(channel: string, agentId: string, event: string): void {
    try {
      broadcastUpdate(channel, {
        type: "agent_heartbeat",
        agent_id: agentId,
        event,
        timestamp: Date.now(),
      });
    } catch {
      // Non-critical: UI just won't see the event
    }
  }

  /** Load agent configs from the chat server database via API */
  private async loadAgentsFromDb(): Promise<AgentConfig[]> {
    try {
      const res = await timedFetch(`${this.config.chatApiUrl}/api/app.agents.list?internal=1`);
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
            headers: config.headers,
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
      headers?: Record<string, string>;
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
        headers: config.headers,
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
