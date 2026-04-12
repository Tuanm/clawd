/**
 * Worker Manager - Manages per-channel-per-agent worker loops
 *
 * Each active agent in a channel gets its own WorkerLoop instance.
 * The manager loads initial config from SQLite and responds to
 * add/remove agent requests from the API.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAgentFile } from "./agent/agents/loader";
import {
  getAllChannelMCPServers,
  getChannelMCPServers,
  resolveProviderBaseType,
  saveChannelMCPServer,
} from "./agent/api/provider-config";
import type { MCPServerConfig } from "./agent/api/providers";
import { getCatalogEntry, resolveArgs } from "./agent/mcp/catalog";
import { MCPManager } from "./agent/mcp/client";
import {
  createWorktree,
  ensureClawdGitignore,
  isGitInstalled,
  isGitRepo,
  pruneWorktrees,
  safeDeleteWorktree,
} from "./agent/workspace/worktree";
import type { AppConfig } from "./config/config";
import { isWorktreeEnabled } from "./config/config-file";
import { INTERNAL_SERVICE_TOKEN } from "./internal-token";
import { loadOAuthToken, loadOrRefreshOAuthToken } from "./server/mcp/oauth";
import { validateServerConfig } from "./agent/api/mcp-validation";
import type { SchedulerManager } from "./scheduler/manager";
import { db, setAgentStreaming } from "./server/database";
import { broadcastUpdate } from "./server/websocket";
import { setAgentMcpInfra } from "./spaces/agent-mcp-tools";
import { getSpaceByChannel } from "./spaces/db";
import type { SpaceManager } from "./spaces/manager";
import type { SpaceWorkerManager } from "./spaces/worker";
import { createLogger } from "./utils/logger";
import { timedFetch } from "./utils/timed-fetch";
import { type AgentHealthSnapshot, type AgentWorker, WorkerLoop, type WorkerLoopConfig } from "./worker-loop";

const logger = createLogger("WorkerManager");

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
  /** Agent file type reference (e.g., "code-reviewer") */
  agentType?: string;
  /** Env vars available to this agent (for template resolution in MCP catalog auto-provision) */
  env?: Record<string, string>;
}

export class WorkerManager {
  private loops: Map<string, AgentWorker> = new Map();
  private config: AppConfig;
  private scheduler?: SchedulerManager;
  private spaceManager?: SpaceManager;
  private spaceWorkerManager?: SpaceWorkerManager;
  /** Channel-scoped MCP managers: channel → MCPManager */
  private channelMcp: Map<string, MCPManager> = new Map();
  /** Pending MCP setup promises to prevent double-creation on concurrent agent starts */
  private channelMcpPending: Map<string, Promise<MCPManager | null>> = new Map();
  /** OAuth proactive refresh timer */
  private oauthRefreshTimer?: ReturnType<typeof setInterval>;
  /** Prevents concurrent refresh for the same channel:server key */
  private oauthRefreshInFlight = new Set<string>();
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
      spaceIdleTimeoutMs: config.heartbeat?.spaceIdleTimeoutMs ?? 15_000,
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
    // Register for agent MCP tools (claude_code, list_agents, etc.)
    try {
      setAgentMcpInfra(spaceManager, spaceWorkerManager, this.config.chatApiUrl, this.config.yolo ?? false);
    } catch {
      // Intentionally swallowed — MCP infra registration is best-effort; agent tools register on first use
    }
  }

  /** Start the worker manager -- loads agents from DB and starts active loops */
  private _bulkStarting = false;

  async start(): Promise<void> {
    logger.info("Starting...");

    // Load agents from the chat server's database
    const agents = await this.loadAgentsFromDb();
    logger.info(`Found ${agents.length} configured agent(s)`);

    // Start active agents (bulk start defers inactive channels)
    this._bulkStarting = true;
    for (const agent of agents) {
      if (agent.active) {
        await this.startAgent(agent);
      }
    }
    this._bulkStarting = false;

    const deferredCount = this.deferredAgents.size;
    logger.info(
      `${this.loops.size} worker loop(s) running` +
        (deferredCount > 0 ? `, ${deferredCount} deferred (inactive channels)` : ""),
    );

    this.startHeartbeatMonitor();
    this.startOAuthRefreshTimer();
  }

  // ===========================================================================
  // OAuth Proactive Refresh
  // ===========================================================================

  /** Start a repeating timer (every ~5 min) that refreshes near-expiry OAuth tokens. */
  private startOAuthRefreshTimer(): void {
    const jitter = Math.random() * 60_000; // ±1 min per-process jitter
    this.oauthRefreshTimer = setInterval(
      () => {
        this.refreshExpiringTokens().catch((err) => {
          logger.warn("[worker-manager] refreshExpiringTokens failed:", err);
        });
      },
      5 * 60_000 + jitter,
    );
    // Don't prevent process exit
    if (typeof this.oauthRefreshTimer === "object" && "unref" in this.oauthRefreshTimer) {
      (this.oauthRefreshTimer as any).unref();
    }
  }

  /** Iterate all configured MCP servers; refresh tokens expiring within 15 min. */
  private async refreshExpiringTokens(): Promise<void> {
    const allServers = getAllChannelMCPServers();
    for (const [channel, servers] of Object.entries(allServers)) {
      // Skip channels with no live MCPManager (not running)
      const mcp = this.channelMcp.get(channel);
      if (!mcp) continue;
      // Build a set of live server names to avoid refreshing/disconnecting-removed servers
      const liveServers = new Set(mcp.listServers());
      for (const [name, cfg] of Object.entries(servers)) {
        if (!cfg.oauth?.client_id) continue;
        // Server was removed from MCPManager but still in config — skip to avoid
        // repeated expired broadcasts every 5 min for servers that won't reconnect
        if (!liveServers.has(name)) continue;
        const key = `${channel}:${name}`;
        if (this.oauthRefreshInFlight.has(key)) continue;
        this.oauthRefreshInFlight.add(key);
        try {
          const { token, reason } = await loadOrRefreshOAuthToken(channel, name, cfg);
          if (token) {
            // Push the refreshed token into the live HTTP connection so it
            // doesn't keep using the stale one until the next reconnect.
            this.channelMcp.get(channel)?.setServerToken(name, token);
          } else {
            const msg =
              reason === "refresh_failed"
                ? "OAuth token refresh failed — user re-auth needed"
                : "OAuth token expired — user re-auth needed";
            logger.warn(`MCP OAuth ${key}: ${msg}`);
            broadcastUpdate(channel, { type: "mcp_oauth_expired", server: name, reason });
          }
        } catch (err) {
          logger.warn(
            `MCP OAuth unexpected error refreshing ${key}:`,
            err instanceof Error ? err.message : String(err),
          );
        } finally {
          this.oauthRefreshInFlight.delete(key);
        }
      }
    }
  }

  /** Stop all worker loops */
  async stop(): Promise<void> {
    logger.info("Stopping all worker loops...");

    if (this.oauthRefreshTimer) {
      clearInterval(this.oauthRefreshTimer);
      this.oauthRefreshTimer = undefined;
    }

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
        logger.info(`Disconnected channel MCP: ${channel}`);
      } catch (err) {
        logger.error(`Error disconnecting channel MCP ${channel}:`, err);
      }
    }
    this.channelMcp.clear();
    this.channelMcpPending.clear();

    logger.info("All worker loops stopped");
  }

  /** Deferred agents: channels inactive >1 day are not started until a message arrives */
  private deferredAgents = new Map<string, AgentConfig>();

  /** In-flight startAgent calls keyed by channel:agentId — prevents TOCTOU concurrent-start races (RC-1) */
  private _startingAgents: Set<string> = new Set();

  /** Check if a channel has been inactive for more than the threshold */
  private isChannelInactive(channel: string, thresholdMs = 24 * 60 * 60 * 1000): boolean {
    try {
      const row = db
        .query<{ updated_at: number | null }, [string]>(
          `SELECT MAX(updated_at) as updated_at FROM agent_seen WHERE channel = ?`,
        )
        .get(channel);
      if (!row?.updated_at) return true; // No activity record — treat as inactive
      const lastActivityMs = row.updated_at * 1000;
      return Date.now() - lastActivityMs > thresholdMs;
    } catch {
      return false; // On error, don't defer
    }
  }

  /** Start a deferred agent for a channel (called when a new message arrives) */
  async startDeferredAgents(channel: string): Promise<void> {
    const deferred: AgentConfig[] = [];
    for (const [key, agent] of this.deferredAgents) {
      if (agent.channel === channel) {
        deferred.push(agent);
        this.deferredAgents.delete(key);
      }
    }
    for (const agent of deferred) {
      logger.info(`Starting deferred agent: ${agent.channel}:${agent.agentId}`);
      await this.startAgent(agent);
    }
  }

  /** Check if a channel has deferred agents waiting */
  hasDeferredAgents(channel: string): boolean {
    for (const agent of this.deferredAgents.values()) {
      if (agent.channel === channel) return true;
    }
    return false;
  }

  /** Add and start a new agent */
  async startAgent(agent: AgentConfig): Promise<boolean> {
    const key = `${agent.channel}:${agent.agentId}`;

    if (this.loops.has(key)) {
      logger.info(`Agent ${key} already running`);
      return false;
    }

    // RC-1: TOCTOU guard — reject concurrent startAgent calls for the same agent.
    // The Set is populated synchronously before the first await so any concurrent call
    // that reaches this point will see the key already present.
    if (this._startingAgents.has(key)) {
      logger.info(`Agent ${key} already starting`);
      return false;
    }
    this._startingAgents.add(key);

    try {
      // Defer startup for channels inactive >1 day (saves resources on startup)
      // Only applies during initial bulk start, not explicit startAgent calls from API
      if (this._bulkStarting && this.isChannelInactive(agent.channel)) {
        this.deferredAgents.set(key, agent);
        logger.info(`Deferred agent ${key} (channel inactive >1 day)`);
        return false;
      }

      // Resolve project root early so auto-provision can use it
      let effectiveProjectRoot = agent.project || this.defaultProjectRoot(agent.channel);

      // Auto-provision MCP servers from agent file frontmatter BEFORE ensureChannelMcp
      // so that newly saved servers are included when the MCPManager initializes
      if (agent.agentType) {
        const agentFile = loadAgentFile(agent.agentType, effectiveProjectRoot);
        if (agentFile) {
          const rawMcpIds = agentFile.rawFrontmatter.mcpServers;
          if (Array.isArray(rawMcpIds) && rawMcpIds.length > 0) {
            await this.autoProvisionAgentMcpServers(
              agent.channel,
              rawMcpIds as string[],
              agent.agentId,
              effectiveProjectRoot,
              agentFile.rawFrontmatter.env as Record<string, string> | undefined,
            );
          }
        }
      }

      // Ensure channel MCP servers are running (starts on first agent in channel)
      const channelMcpManager = await this.ensureChannelMcp(agent.channel);

      let worktreePath: string | undefined;
      let worktreeBranch: string | undefined;
      const originalProjectRoot = effectiveProjectRoot;

      // Ensure .gitignore files are set up for any git project (not just worktree)
      if (!agent.workerToken && isGitRepo(effectiveProjectRoot)) {
        try {
          ensureClawdGitignore(effectiveProjectRoot);
        } catch {
          // Intentionally swallowed — .gitignore setup is best-effort; doesn't block agent startup
        }
      }

      // Create worktree if enabled for this channel (skip remote workers — they manage their own filesystem)
      if (isWorktreeEnabled(agent.channel) && !agent.workerToken) {
        if (!isGitInstalled()) {
          logger.warn(`Worktree enabled but git is not installed — skipping isolation for ${key}`);
        } else if (!isGitRepo(effectiveProjectRoot)) {
          logger.warn(`Worktree enabled but ${effectiveProjectRoot} is not a git repo — skipping isolation for ${key}`);
        } else {
          try {
            // Prune stale worktree entries first (crash recovery)
            pruneWorktrees(effectiveProjectRoot);
            const wt = await createWorktree(effectiveProjectRoot, agent.agentId);
            worktreePath = wt.path;
            worktreeBranch = wt.branch;
            effectiveProjectRoot = wt.path;
            this.worktreeInfo.set(key, {
              path: wt.path,
              branch: wt.branch,
              originalRoot: originalProjectRoot,
            });
            // Persist to DB so worktree survives server restart
            this.persistWorktreeInfo(agent.channel, agent.agentId, wt.path, wt.branch);
            logger.info(`Worktree ready: ${wt.path} (branch: ${wt.branch})`);
          } catch (err) {
            logger.error(`Worktree creation failed for ${key}, using original project:`, err);
          }
        }
      } else if (isWorktreeEnabled(agent.channel) && agent.worktreePath && agent.worktreeBranch) {
        // Restore worktree info from DB (persisted from previous session) — only if worktree still enabled
        if (existsSync(agent.worktreePath)) {
          worktreePath = agent.worktreePath;
          worktreeBranch = agent.worktreeBranch;
          effectiveProjectRoot = agent.worktreePath;
          this.worktreeInfo.set(key, {
            path: agent.worktreePath,
            branch: agent.worktreeBranch,
            originalRoot: originalProjectRoot,
          });
          logger.info(`Restored worktree from DB: ${agent.worktreePath} (branch: ${agent.worktreeBranch})`);
        } else {
          // Worktree path from DB no longer exists — clear it
          this.persistWorktreeInfo(agent.channel, agent.agentId, null, null);
        }
      } else if (!isWorktreeEnabled(agent.channel) && agent.worktreePath) {
        // Worktree was disabled — clear stale DB entries
        this.persistWorktreeInfo(agent.channel, agent.agentId, null, null);
        logger.info(`Worktree disabled for ${key}, cleared stale DB entry`);
      }

      const loopConfig: WorkerLoopConfig = {
        channel: agent.channel,
        agentId: agent.agentId,
        provider: agent.provider,
        model: agent.model,
        projectRoot: effectiveProjectRoot,
        chatApiUrl: this.config.chatApiUrl,
        wsUrl: this.config.chatApiUrl.replace(/^http(s?):\/\//, "ws$1://").replace(/\/?$/, "/ws"),
        debug: this.config.debug,
        yolo: this.config.yolo ?? false,
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
        authToken: INTERNAL_SERVICE_TOKEN,
        worktreePath,
        worktreeBranch,
        originalProjectRoot: worktreePath ? originalProjectRoot : undefined,
      };

      // Load agent file config if agent_type is set (prompt + tool restrictions)
      // Model/provider from channel config take precedence — agent_type provides prompt only
      if (agent.agentType) {
        const agentFile = loadAgentFile(agent.agentType, effectiveProjectRoot);
        if (agentFile) {
          loopConfig.agentFileConfig = agentFile;
        } else {
          logger.warn(
            `Agent file not found for type "${agent.agentType}" (agent: ${key}) — starting without type config`,
          );
        }
      }

      // Create the appropriate worker type
      let worker: AgentWorker;

      const resolvedProvider = resolveProviderBaseType(agent.provider || "copilot");
      if (resolvedProvider === "claude-code") {
        // Claude Code main agent — subprocess-based, uses MCP for chat tools
        const { ClaudeCodeMainWorker, registerMainWorker } = await import("./claude-code/main-worker");
        const ccWorker = new ClaudeCodeMainWorker({
          channel: agent.channel,
          agentId: agent.agentId,
          model: agent.model,
          provider: agent.provider || "claude-code",
          projectRoot: effectiveProjectRoot,
          chatApiUrl: this.config.chatApiUrl,
          debug: this.config.debug,
          agentFileConfig: loopConfig.agentFileConfig,
          heartbeatInterval: agent.heartbeatInterval,
          yolo: this.config.yolo ?? false,
        });
        registerMainWorker(`${agent.channel}:${agent.agentId}`, ccWorker);
        worker = ccWorker;
      } else {
        // Normal LLM-based agent
        worker = new WorkerLoop(loopConfig);
      }

      this.loops.set(key, worker);

      // Set sleeping state before starting (if was sleeping before restart)
      if (agent.sleeping) {
        worker.setSleeping(true);
        logger.info(`Agent ${key} starting in sleep mode`);
      }

      worker.start();

      logger.info(
        `Started agent: ${key} (provider: ${agent.provider || "copilot"}, model: ${agent.model}${worktreeBranch ? `, worktree: ${worktreeBranch}` : ""}, sleeping: ${agent.sleeping || false})`,
      );
      return true;
    } finally {
      // RC-1: always remove from in-flight set so restarts are not blocked
      this._startingAgents.delete(key);
    }
  }

  /** Stop and remove an agent */
  async stopAgent(channel: string, agentId: string): Promise<boolean> {
    const key = `${channel}:${agentId}`;
    const loop = this.loops.get(key);

    if (!loop) {
      logger.info(`Agent ${key} not found`);
      return false;
    }

    await loop.stop();
    this.loops.delete(key);

    // Clean up Claude Code main worker registry if applicable
    try {
      const { unregisterMainWorker } = await import("./claude-code/main-worker");
      unregisterMainWorker(key);
    } catch {
      // Intentionally swallowed — CC worker deregistration is best-effort; worker already stopped
    }

    // Clean up worktree if one was created
    const wtInfo = this.worktreeInfo.get(key);
    if (wtInfo) {
      try {
        const result = await safeDeleteWorktree(wtInfo.path, wtInfo.originalRoot);
        if (result.deleted) {
          logger.info(`Cleaned up worktree: ${wtInfo.path}`);
        } else {
          logger.warn(`Worktree kept (${result.reason}): ${wtInfo.path}`);
        }
      } catch (err) {
        logger.error(`Failed to clean up worktree ${wtInfo.path}:`, err);
      }
      this.worktreeInfo.delete(key);
    }

    // Tear down channel MCP if this was the last agent in the channel
    await this.teardownChannelMcpIfEmpty(channel);

    logger.info(`Stopped agent: ${key}`);
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
  getChannelWorktreeInfo(channel: string): Array<{
    agentId: string;
    path: string;
    branch: string;
    originalRoot: string;
  }> {
    const results: Array<{
      agentId: string;
      path: string;
      branch: string;
      originalRoot: string;
    }> = [];
    for (const [key, info] of this.worktreeInfo) {
      if (key.startsWith(`${channel}:`)) {
        const agentId = key.slice(channel.length + 1);
        results.push({ agentId, ...info });
      }
    }
    return results;
  }

  /** Get all git-capable agent info for a channel (worktree + non-worktree) */
  getChannelGitInfo(channel: string): Array<{
    agentId: string;
    path: string;
    branch: string;
    originalRoot: string;
    isWorktree: boolean;
  }> {
    const results: Array<{
      agentId: string;
      path: string;
      branch: string;
      originalRoot: string;
      isWorktree: boolean;
    }> = [];
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
            results.push({
              agentId,
              path: projectRoot,
              branch: "",
              originalRoot: projectRoot,
              isWorktree: false,
            });
          }
        }
      }
    }

    return results;
  }

  /** Persist worktree info to DB so it survives server restart */
  private persistWorktreeInfo(channel: string, agentId: string, path: string | null, branch: string | null): void {
    try {
      timedFetch(`${this.config.chatApiUrl}/api/app.agents.update`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: INTERNAL_SERVICE_TOKEN, // raw token, no "Bearer " prefix
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
    // Preserve sleeping state across restart
    const key = `${agent.channel}:${agent.agentId}`;
    const existingLoop = this.loops.get(key);
    const wasSleeping = agent.sleeping ?? existingLoop?.isSleeping ?? false;

    await this.stopAgent(agent.channel, agent.agentId);
    return await this.startAgent({ ...agent, sleeping: wasSleeping });
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
    logger.info(`Reset ${resets.length} agent(s) for channel: ${channel}`);
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
    logger.info(
      `Heartbeat monitor started (interval: ${this.heartbeatConfig.intervalMs}ms, ` +
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
          logger.info(`Heartbeat processing timeout: ${key} (${Math.round(health.processingDurationMs / 1000)}s)`);
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

        // CHECK 3: Per-agent heartbeat interval — inject heartbeat when agent has been idle for the configured duration
        if (!health.processing && loop.heartbeatInterval > 0) {
          if (health.idleDurationMs > loop.heartbeatInterval * 1000) {
            heartbeatActions.push(async () => {
              loop.injectHeartbeat();
              logger.info(`Heartbeat injected for agent: ${key} (interval: ${loop.heartbeatInterval}s)`);
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
      logger.error("Heartbeat error during health check:", err);
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
  private static readonly MAX_SPACE_HEARTBEATS = 30;
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
      logger.info(`Heartbeat: space agent ${key} unresponsive after ${count} heartbeats, failing space`);
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
    logger.info(`Heartbeat injected for idle space agent: ${key} (${count}/${WorkerManager.MAX_SPACE_HEARTBEATS})`);
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
        logger.info(`Heartbeat processing timeout: ${key} (${Math.round(health.processingDurationMs / 1000)}s)`);
        const loop = this.spaceWorkerManager.getWorkerLoop(spaceId);
        if (loop) loop.cancelProcessing();
        this.clearAgentStreamingState(health.channel, health.agentId);
        this.broadcastHeartbeatEvent(health.channel, health.agentId, "processing_timeout");
        continue;
      }

      // CHECK 2: Space agent idle with incomplete task — inject heartbeat (with circuit breaker)
      if (!health.processing && health.idleDurationMs > this.heartbeatConfig.spaceIdleTimeoutMs) {
        const spaceStatus = this.getSpaceStatus(health.channel);
        if (!spaceStatus || !spaceStatus.active || spaceStatus.locked) continue;

        // Circuit breaker: auto-fail space worker after too many consecutive heartbeats
        const count = (this.spaceHeartbeatCounts.get(key) || 0) + 1;
        this.spaceHeartbeatCounts.set(key, count);

        if (count > WorkerManager.MAX_SPACE_HEARTBEATS) {
          logger.info(`Heartbeat: space worker ${key} unresponsive after ${count} heartbeats, failing space`);
          if (this.spaceManager) {
            this.spaceManager.failSpace(
              spaceStatus.spaceId,
              "Heartbeat: agent unresponsive after max heartbeat attempts",
            );
            this.spaceWorkerManager.stopSpaceWorker(spaceStatus.spaceId);
          }
          this.spaceHeartbeatCounts.delete(key);
          this.broadcastHeartbeatEvent(health.channel, health.agentId, "space_auto_failed");
          continue;
        }

        const loop = this.spaceWorkerManager.getWorkerLoop(spaceId);
        if (loop) {
          heartbeatActions.push(async () => {
            loop.injectHeartbeat();
            logger.info(
              `Heartbeat injected for idle space worker: ${key} (${count}/${WorkerManager.MAX_SPACE_HEARTBEATS})`,
            );
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
      const res = await timedFetch(
        `${this.config.chatApiUrl}/api/app.agents.list?internal=1`,
        { headers: { Authorization: INTERNAL_SERVICE_TOKEN } }, // raw token, no "Bearer " prefix
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
          agentType: a.agent_type || undefined,
        }));
      }
    } catch (error) {
      logger.info("No saved agents found (API not available yet), starting fresh");
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

  // ===========================================================================
  // Agent File Auto-Provision
  // ===========================================================================

  /**
   * Auto-provision catalog MCP servers declared in an agent file's frontmatter.
   * Additive-only (no clobber — user config always wins).
   * Saves entries to config and emits `mcp_auto_provisioned` channel notification.
   * Provisioned servers persist after agent run ends (provision once, reuse).
   */
  private async autoProvisionAgentMcpServers(
    channel: string,
    catalogIds: string[],
    agentId: string,
    projectRoot: string,
    env?: Record<string, string>,
  ): Promise<void> {
    const existing = getChannelMCPServers(channel);
    const provisioned: Array<{ id: string; name: string; envRequired: string[] }> = [];

    for (const id of catalogIds) {
      if (typeof id !== "string") continue;

      const entry = getCatalogEntry(id);
      if (!entry) {
        logger.warn(`Auto-provision: catalog entry "${id}" not found (agent: ${agentId})`);
        continue;
      }

      // Skip if already configured — user config wins; log if env differs
      if (existing[entry.id] !== undefined) {
        logger.debug(`Auto-provision: "${id}" already configured for channel ${channel} — skipping`);
        continue;
      }

      // Resolve template vars ({PROJECT_ROOT} etc.)
      let resolvedArgs: string[];
      try {
        resolvedArgs = resolveArgs(entry.args || [], { PROJECT_ROOT: projectRoot, ...(env || {}) });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Auto-provision: cannot resolve args for "${id}": ${message}`);
        continue;
      }

      // Build minimal server config
      const mcpConfig: MCPServerConfig & { autoProvisioned: boolean; autoProvisionedBy: string } = {
        transport: entry.transport,
        ...(entry.logo ? { logo: entry.logo } : {}),
        autoProvisioned: true,
        autoProvisionedBy: agentId,
      };
      if (entry.transport === "stdio") {
        mcpConfig.command = entry.command;
        mcpConfig.args = resolvedArgs;
        if (env && Object.keys(env).length > 0) mcpConfig.env = env;
      } else {
        mcpConfig.url = entry.url;
      }

      // Validate (async — includes DNS rebinding check for http)
      try {
        await validateServerConfig(entry.id, mcpConfig);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Auto-provision: validation failed for "${id}": ${message}`);
        continue;
      }

      saveChannelMCPServer(channel, entry.id, mcpConfig);
      provisioned.push({ id: entry.id, name: entry.name, envRequired: entry.envRequired || [] });
      logger.info(`Auto-provisioned MCP server "${id}" for channel ${channel} (agent: ${agentId})`);
    }

    // Notify UI so it can show a dismissable banner
    if (provisioned.length > 0) {
      broadcastUpdate(channel, {
        type: "mcp_auto_provisioned",
        servers: provisioned,
      });
    }
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
      logger.info(`Starting ${enabledEntries.length} MCP server(s) for channel: ${channel}`);

      for (const [name, config] of enabledEntries) {
        try {
          // Skip HTTP+OAuth servers without a valid token (need browser OAuth flow)
          let token: string | undefined;
          if (config.oauth?.client_id) {
            const stored = loadOAuthToken(channel, name);
            token = stored?.access_token;
            if (!token) {
              logger.info(`Skipping MCP server ${name} (no OAuth token — connect via UI)`);
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
          logger.info(`Connected MCP server: ${name} (channel: ${channel})`);
        } catch (err) {
          logger.error(`Failed to connect MCP server ${name} for channel ${channel}: ${(err as any)?.message || err}`);
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
      logger.error(`Failed to setup channel MCP for ${channel}:`, err);
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
      logger.info(`Disconnected channel MCP: ${channel} (last agent stopped)`);
    } catch (err) {
      logger.error(`Error disconnecting channel MCP ${channel}:`, err);
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
      logger.info(`Added MCP server: ${name} (channel: ${channel}, ${tools} tools)`);
      // Reset CC agent sessions so they pick up the new tools via clawd MCP proxy
      this.resetChannelAgentSessions(channel);
      return { success: true, tools };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to add MCP server ${name} for channel ${channel}: ${message}`);
      return { success: false, tools: 0, error: message };
    }
  }

  /** Remove a single MCP server from a channel */
  async removeChannelMcpServer(channel: string, name: string): Promise<boolean> {
    const mgr = this.channelMcp.get(channel);
    if (!mgr) return false;

    try {
      await mgr.removeServer(name);
    } catch (err) {
      logger.error(`Error removing MCP server ${name} from ${channel}:`, err);
    }
    logger.info(`Removed MCP server: ${name} (channel: ${channel})`);

    // Reset CC agent sessions so they drop the removed server's tools
    this.resetChannelAgentSessions(channel);

    // Clean up empty MCPManager if no servers left and no agents
    if (mgr.listServers().length === 0 && this.getChannelAgentCount(channel) === 0) {
      this.channelMcp.delete(channel);
      this.channelMcpPending.delete(channel);
    }
    return true;
  }

  /**
   * Reset sessions for all agents in a channel.
   * Called when channel MCP servers change so CC agents pick up the new tool list
   * via the clawd MCP proxy on their next query (fresh session = fresh tools/list).
   */
  private resetChannelAgentSessions(channel: string): void {
    let count = 0;
    for (const [key, loop] of this.loops) {
      if (key.startsWith(`${channel}:`)) {
        loop.resetSession().catch((err) => {
          logger.warn("[worker-manager] resetSession failed:", err);
        });
        count++;
      }
    }
    if (count > 0) {
      logger.info(`Reset ${count} agent session(s) for channel ${channel} (MCP config changed)`);
    }
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
