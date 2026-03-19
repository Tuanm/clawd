import type { AgentFileConfig } from "../agent/agents/loader";
import type { MCPManager } from "../agent/mcp/client";
import { type AgentHealthSnapshot, WorkerLoop } from "../worker-loop";
import type { Space } from "./db";
import type { SpaceManager } from "./manager";
import { createSpaceToolPlugin } from "./plugin";

const MAX_SPACE_WORKERS_PER_CHANNEL = 5;
const MAX_SPACE_WORKERS_GLOBAL = 20;

interface SpaceWorkerEntry {
  loop: WorkerLoop;
  resolve: (summary: string) => void;
  reject: (err: Error) => void;
  /** Shared mutable settlement state — closures and stopSpaceWorker both reference this object. */
  state: { settled: boolean };
  /** Parent channel that spawned this space (for per-channel limiting) */
  parentChannel: string;
}

interface AgentConfig {
  provider: string;
  model: string;
  agentId: string;
  project?: string;
}

export class SpaceWorkerManager {
  private workers = new Map<string, SpaceWorkerEntry>();
  /** Callback to retrieve the parent channel's shared MCPManager */
  private getChannelMcp?: (channel: string) => MCPManager | undefined;

  constructor(
    private config: { chatApiUrl: string; projectRoot: string; debug: boolean; yolo: boolean },
    private spaceManager: SpaceManager,
  ) {}

  /** Set the callback used to look up a channel's shared MCPManager */
  setChannelMcpLookup(fn: (channel: string) => MCPManager | undefined): void {
    this.getChannelMcp = fn;
  }

  startSpaceWorker(space: Space, agentConfig: AgentConfig, agentFileConfig?: AgentFileConfig): Promise<string> {
    if (this.workers.size >= MAX_SPACE_WORKERS_GLOBAL) {
      throw new Error(`Max global space workers (${MAX_SPACE_WORKERS_GLOBAL}) exceeded`);
    }

    // Per-channel limit prevents a single channel from starving others
    const channelCount = this.getChannelWorkerCount(space.channel);
    if (channelCount >= MAX_SPACE_WORKERS_PER_CHANNEL) {
      throw new Error(
        `Max space workers per channel (${MAX_SPACE_WORKERS_PER_CHANNEL}) exceeded for channel ${space.channel}`,
      );
    }

    if (this.workers.has(space.id)) {
      throw new Error(`Space worker ${space.id} already running`);
    }

    return new Promise<string>((resolve, reject) => {
      // Shared settlement state object — closures and entry both reference
      // the same object so mutations are visible everywhere.
      const state = { settled: false };

      const wrappedResolve = (summary: string) => {
        if (state.settled) return;
        state.settled = true;
        resolve(summary);
      };

      const spacePlugin = createSpaceToolPlugin(
        {
          spaceId: space.id,
          spaceChannel: space.space_channel,
          mainChannel: space.channel,
          apiUrl: this.config.chatApiUrl,
          agentId: agentConfig.agentId,
          resolve: wrappedResolve,
          onComplete: () => {
            // Stop the worker loop immediately after completion to prevent further processing
            const w = this.workers.get(space.id);
            if (w) {
              w.loop.stop();
              this.workers.delete(space.id);
            }
          },
        },
        this.spaceManager,
      );

      const loop = new WorkerLoop({
        channel: space.space_channel,
        agentId: agentConfig.agentId,
        model: agentConfig.model,
        provider: agentConfig.provider,
        projectRoot: agentConfig.project || this.config.projectRoot,
        chatApiUrl: this.config.chatApiUrl,
        debug: this.config.debug,
        yolo: this.config.yolo,
        contextMode: true,
        isSpaceAgent: true,
        heartbeatInterval: 5, // Sub-agents always get a 5-second heartbeat to stay responsive
        channelMcpManager: this.getChannelMcp?.(space.channel),
        onLoopExit: () => {
          // If the loop exits without the promise being settled, reject it
          if (!state.settled) {
            state.settled = true;
            this.workers.delete(space.id);
            reject(new Error("Space worker loop exited without completing"));
          }
        },
        additionalPlugins: [{ plugin: { name: "space-tools", version: "1.0.0", hooks: {} }, toolPlugin: spacePlugin }],
        agentFileConfig,
      });

      const entry: SpaceWorkerEntry = {
        loop,
        resolve,
        reject,
        state,
        parentChannel: space.channel,
      };
      this.workers.set(space.id, entry);

      loop.start();
    });
  }

  stopSpaceWorker(spaceId: string): void {
    const entry = this.workers.get(spaceId);
    if (!entry) return;

    entry.loop.stop();
    this.workers.delete(spaceId);

    if (!entry.state.settled) {
      entry.state.settled = true;
      entry.reject(new Error("Space worker stopped"));
    }
  }

  runningCount(): number {
    return this.workers.size;
  }

  isRunning(spaceId: string): boolean {
    return this.workers.has(spaceId);
  }

  /** Get health snapshots for all space workers (used by heartbeat monitor) */
  getWorkerHealthSnapshots(): Array<{ spaceId: string; health: AgentHealthSnapshot }> {
    return Array.from(this.workers.entries()).map(([spaceId, entry]) => ({
      spaceId,
      health: entry.loop.getHealthSnapshot(),
    }));
  }

  /** Get the WorkerLoop for a specific space (used by heartbeat to cancel/inject heartbeat) */
  getWorkerLoop(spaceId: string): WorkerLoop | null {
    return this.workers.get(spaceId)?.loop ?? null;
  }

  /** Count running space workers for a specific parent channel */
  private getChannelWorkerCount(channel: string): number {
    let count = 0;
    for (const entry of this.workers.values()) {
      if (entry.parentChannel === channel) count++;
    }
    return count;
  }

  async stopAll(): Promise<void> {
    for (const [id] of this.workers) {
      this.stopSpaceWorker(id);
    }
  }
}
