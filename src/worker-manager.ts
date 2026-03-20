/**
 * Worker Manager - Manages per-channel-per-agent worker loops
 *
 * Each active agent in a channel gets its own WorkerLoop instance.
 * The manager loads initial config from SQLite and responds to
 * add/remove agent requests from the API.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getChannelMCPServers } from "./agent/api/provider-config";
import { MCPManager } from "./agent/mcp/client";
import {
  createWorktree,
  isGitInstalled,
  isGitRepo,
  pruneWorktrees,
  safeDeleteWorktree,
} from "./agent/workspace/worktree";
import type { AppConfig } from "./config";
import { getAuthToken, isWorktreeEnabled } from "./config-file";
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
  /** Per-agent heartbeat interval in seconds (0 = disabled) */
  heartbeatInterval?: number;
  /** Persisted worktree path (loaded from DB on restart) */
  worktreePath?: string;
  /** Persisted worktree branch (loaded from DB on restart) */
  worktreeBranch?: string;
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
  /** Worktree tracking: key → { path, branch, originalRoot } */
  private worktreeInfo: Map<string, { path: string; branch: string; originalRoot: string }> = new Map();

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
    };
  }

  /** Default project root: ~/.clawd/projects/{channel}, auto-created */
  private defaultProjectRoot(channel: string): string {
    const dir = join(homedir(), ".clawd", "projects", channel);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // best-effort
    }
    return dir;
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

    let effectiveProjectRoot = agent.project || this.defaultProjectRoot(agent.channel);
    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;
    const originalProjectRoot = effectiveProjectRoot;

    // Create worktree if enabled for this channel (skip remote workers — they manage their own filesystem)
    if (isWorktreeEnabled(agent.channel) && !agent.workerToken) {
      if (!isGitInstalled()) {
        console.warn(`[WorkerManager] Worktree enabled but git is not installed — skipping isolation for ${key}`);
      } else if (!isGitRepo(effectiveProjectRoot)) {
        console.warn(
          `[WorkerManager] Worktree enabled but ${effectiveProjectRoot} is not a git repo — skipping isolation for ${key}`,
        );
      } else {
        try {
          // Prune stale worktree entries first (crash recovery)
          pruneWorktrees(effectiveProjectRoot);
          const wt = await createWorktree(effectiveProjectRoot, agent.agentId);
          worktreePath = wt.path;
          worktreeBranch = wt.branch;
          effectiveProjectRoot = wt.path;
          this.worktreeInfo.set(key, { path: wt.path, branch: wt.branch, originalRoot: originalProjectRoot });
          // Persist to DB so worktree survives server restart
          this.persistWorktreeInfo(agent.channel, agent.agentId, wt.path, wt.branch);
          console.log(`[WorkerManager] Worktree ready: ${wt.path} (branch: ${wt.branch})`);
        } catch (err) {
          console.error(`[WorkerManager] Worktree creation failed for ${key}, using original project:`, err);
        }
      }
    } else if (isWorktreeEnabled(agent.channel) && agent.worktreePath && agent.worktreeBranch) {
      // Restore worktree info from DB (persisted from previous session) — only if worktree still enabled
      const { existsSync } = require("node:fs");
      if (existsSync(agent.worktreePath)) {
        worktreePath = agent.worktreePath;
        worktreeBranch = agent.worktreeBranch;
        effectiveProjectRoot = agent.worktreePath;
        this.worktreeInfo.set(key, {
          path: agent.worktreePath,
          branch: agent.worktreeBranch,
          originalRoot: originalProjectRoot,
        });
        console.log(
          `[WorkerManager] Restored worktree from DB: ${agent.worktreePath} (branch: ${agent.worktreeBranch})`,
        );
      } else {
        // Worktree path from DB no longer exists — clear it
        this.persistWorktreeInfo(agent.channel, agent.agentId, null, null);
      }
    } else if (!isWorktreeEnabled(agent.channel) && agent.worktreePath) {
      // Worktree was disabled — clear stale DB entries
      this.persistWorktreeInfo(agent.channel, agent.agentId, null, null);
      console.log(`[WorkerManager] Worktree disabled for ${key}, cleared stale DB entry`);
    }

    const loopConfig: WorkerLoopConfig = {
      channel: agent.channel,
      agentId: agent.agentId,
      provider: agent.provider,
      model: agent.model,
      projectRoot: effectiveProjectRoot,
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
      heartbeatInterval: agent.heartbeatInterval,
      // Pass auth token so internal HTTP self-calls include Authorization header
      authToken: getAuthToken() ?? undefined,
      worktreePath,
      worktreeBranch,
      originalProjectRoot: worktreePath ? originalProjectRoot : undefined,
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
      `[WorkerManager] Started agent: ${key} (provider: ${agent.provider || "copilot"}, model: ${agent.model}${worktreeBranch ? `, worktree: ${worktreeBranch}` : ""}, sleeping: ${agent.sleeping || false})`,
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

    // Clean up worktree if one was created
    const wtInfo = this.worktreeInfo.get(key);
    if (wtInfo) {
      try {
        const result = await safeDeleteWorktree(wtInfo.path, wtInfo.originalRoot);
        if (result.deleted) {
          console.log(`[WorkerManager] Cleaned up worktree: ${wtInfo.path}`);
        } else {
          console.warn(`[WorkerManager] Worktree kept (${result.reason}): ${wtInfo.path}`);
        }
      } catch (err) {
        console.error(`[WorkerManager] Failed to clean up worktree ${wtInfo.path}:`, err);
      }
      this.worktreeInfo.delete(key);
    }

    // Tear down channel MCP if this was the last agent in the channel
    await this.teardownChannelMcpIfEmpty(channel);

    console.log(`[WorkerManager] Stopped agent: ${key}`);
    return true;
  }

  /** Get worktree info for an agent (used by API endpoints) */
  getAgentWorktreeInfo(
    channel: string,
    agentId: string,
  ): { path: string; branch: string; originalRoot: string } | null {
    return this.worktreeInfo.get(`${channel}:${agentId}`) || null;
  }

  /** Get all worktree info for a channel */
  getChannelWorktreeInfo(
    channel: string,
  ): Array<{ agentId: string; path: string; branch: string; originalRoot: string }> {
    const results: Array<{ agentId: string; path: string; branch: string; originalRoot: string }> = [];
    for (const [key, info] of this.worktreeInfo) {
      if (key.startsWith(`${channel}:`)) {
        const agentId = key.slice(channel.length + 1);
        results.push({ agentId, ...info });
      }
    }
    return results;
  }

  /** Get all git-capable agent info for a channel (worktree + non-worktree) */
  getChannelGitInfo(
    channel: string,
  ): Array<{ agentId: string; path: string; branch: string; originalRoot: string; isWorktree: boolean }> {
    const results: Array<{ agentId: string; path: string; branch: string; originalRoot: string; isWorktree: boolean }> =
      [];
    const seen = new Set<string>();

    // First: agents with worktrees
    for (const [key, info] of this.worktreeInfo) {
      if (key.startsWith(`${channel}:`)) {
        const agentId = key.slice(channel.length + 1);
        results.push({
          agentId,
          path: info.path,
          branch: info.branch,
          originalRoot: info.originalRoot,
          isWorktree: true,
        });
        seen.add(agentId);
      }
    }

    // Second: agents without worktrees but with git repos
    for (const [key, loop] of this.loops) {
      if (key.startsWith(`${channel}:`)) {
        const agentId = key.slice(channel.length + 1);
        if (!seen.has(agentId)) {
          const projectRoot = loop.getProjectRoot();
          if (projectRoot && isGitRepo(projectRoot)) {
            results.push({ agentId, path: projectRoot, branch: "", originalRoot: projectRoot, isWorktree: false });
          }
        }
      }
    }

    return results;
  }

  /** Persist worktree info to DB so it survives server restart */
  private persistWorktreeInfo(channel: string, agentId: string, path: string | null, branch: string | null): void {
    try {
      const authToken = getAuthToken();
      timedFetch(`${this.config.chatApiUrl}/api/app.agents.update`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          channel,
          agent_id: agentId,
          worktree_path: path,
          worktree_branch: branch,
        }),
      }).catch(() => {
        // Best-effort — don't block agent startup
      });
    } catch {
      // Best-effort
    }
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
        `spaceIdleTimeout: ${this.heartbeatConfig.spaceIdleTimeoutMs}ms)`,
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
      const now = Date.now();
      // Collect async heartbeat inject actions to run in parallel (bounded concurrency).
      // Synchronous actions (cancelProcessing) run inline.
      const heartbeatActions: Array<() => Promise<void>> = [];

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
          heartbeatActions.push(() => this.handleIdleSpaceAgent(key, loop, health));
          continue;
        }

        // CHECK 3: Per-agent heartbeat interval — inject heartbeat for idle agents with configured interval
        if (!health.processing && loop.heartbeatInterval > 0) {
          const timeSinceLastHeartbeat = now - health.lastHeartbeatAt;
          if (timeSinceLastHeartbeat > loop.heartbeatInterval * 1000) {
            heartbeatActions.push(async () => {
              loop.injectHeartbeat();
              console.log(`[Heartbeat] Injected heartbeat for agent: ${key} (interval: ${loop.heartbeatInterval}s)`);
              this.broadcastHeartbeatEvent(health.channel, health.agentId, "heartbeat_sent");
            });
          }
        }
      }

      // Run collected heartbeat actions with bounded concurrency (max 5 parallel)
      await this.runWithConcurrencyLimit(heartbeatActions, 5);

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

  /** Max consecutive heartbeats for a space agent before auto-failing (circuit breaker) */
  private static readonly MAX_SPACE_HEARTBEATS = 10;
  /** Track consecutive heartbeat count per space (resets on activity) */
  private spaceHeartbeatCounts = new Map<string, number>();

  /** Handle an idle space agent that may need a heartbeat */
  private async handleIdleSpaceAgent(key: string, loop: WorkerLoop, health: AgentHealthSnapshot): Promise<void> {
    const spaceStatus = this.getSpaceStatus(health.channel);
    if (!spaceStatus || !spaceStatus.active || spaceStatus.locked) return;

    // Circuit breaker: auto-fail space after too many consecutive heartbeats
    const count = (this.spaceHeartbeatCounts.get(key) || 0) + 1;
    this.spaceHeartbeatCounts.set(key, count);

    if (count > WorkerManager.MAX_SPACE_HEARTBEATS) {
      console.log(`[Heartbeat] Space agent ${key} unresponsive after ${count} heartbeats, failing space`);
      if (this.spaceManager) {
        this.spaceManager.failSpace(spaceStatus.spaceId, "Heartbeat: agent unresponsive after max heartbeat attempts");
        this.spaceWorkerManager?.stopSpaceWorker(spaceStatus.spaceId);
      }
      this.spaceHeartbeatCounts.delete(key);
      this.broadcastHeartbeatEvent(health.channel, health.agentId, "space_auto_failed");
      return;
    }

    // Inject heartbeat to wake idle space agent
    loop.injectHeartbeat();
    console.log(
      `[Heartbeat] Injected heartbeat for idle space agent: ${key} (${count}/${WorkerManager.MAX_SPACE_HEARTBEATS})`,
    );
    this.broadcastHeartbeatEvent(health.channel, health.agentId, "heartbeat_sent");
  }

  /** Check space worker health — the MAIN recovery path for stuck subspace agents */
  private async checkSpaceWorkerHealth(): Promise<void> {
    if (!this.spaceWorkerManager) return;
    const snapshots = this.spaceWorkerManager.getWorkerHealthSnapshots();
    const heartbeatActions: Array<() => Promise<void>> = [];

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

      // CHECK 2: Space agent idle with incomplete task — inject heartbeat
      if (!health.processing && health.idleDurationMs > this.heartbeatConfig.spaceIdleTimeoutMs) {
        const spaceStatus = this.getSpaceStatus(health.channel);
        if (!spaceStatus || !spaceStatus.active || spaceStatus.locked) continue;

        const loop = this.spaceWorkerManager.getWorkerLoop(spaceId);
        if (loop) {
          heartbeatActions.push(async () => {
            loop.injectHeartbeat();
            console.log(`[Heartbeat] Injected heartbeat for idle space agent: ${key}`);
            this.broadcastHeartbeatEvent(health.channel, health.agentId, "heartbeat_sent");
          });
        }
      }
    }

    // Run space heartbeat actions with bounded concurrency
    await this.runWithConcurrencyLimit(heartbeatActions, 5);
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
      const authToken = getAuthToken();
      const res = await timedFetch(
        `${this.config.chatApiUrl}/api/app.agents.list?internal=1`,
        authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {},
      );
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
          heartbeatInterval: a.heartbeat_interval || 0,
          worktreePath: a.worktree_path || undefined,
          worktreeBranch: a.worktree_branch || undefined,
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
