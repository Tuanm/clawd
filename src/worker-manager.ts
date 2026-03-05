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
        this.startAgent(agent);
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
    console.log("[WorkerManager] All worker loops stopped");
  }

  /** Add and start a new agent */
  startAgent(agent: AgentConfig): boolean {
    const key = `${agent.channel}:${agent.agentId}`;

    if (this.loops.has(key)) {
      console.log(`[WorkerManager] Agent ${key} already running`);
      return false;
    }

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
    return this.startAgent(agent);
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
      const res = await fetch(`${this.config.chatApiUrl}/api/app.agents.list`, { signal: ctrl.signal }).finally(() =>
        clearTimeout(timer),
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
        }));
      }
    } catch (error) {
      console.log("[WorkerManager] No saved agents found (API not available yet), starting fresh");
    }

    return [];
  }
}
