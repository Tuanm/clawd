import { WorkerLoop } from "../worker-loop";
import type { SpaceManager } from "./manager";
import type { Space } from "./db";
import { createSpaceToolPlugin } from "./plugin";

const MAX_SPACE_WORKERS = 5;

interface SpaceWorkerEntry {
  loop: WorkerLoop;
  resolve: (summary: string) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

interface AgentConfig {
  provider: string;
  model: string;
  agentId: string;
  project?: string;
}

export class SpaceWorkerManager {
  private workers = new Map<string, SpaceWorkerEntry>();

  constructor(
    private config: { chatApiUrl: string; projectRoot: string; debug: boolean; yolo: boolean },
    private spaceManager: SpaceManager,
  ) {}

  startSpaceWorker(space: Space, agentConfig: AgentConfig): Promise<string> {
    if (this.workers.size >= MAX_SPACE_WORKERS) {
      throw new Error(`Max space workers (${MAX_SPACE_WORKERS}) exceeded`);
    }

    if (this.workers.has(space.id)) {
      throw new Error(`Space worker ${space.id} already running`);
    }

    return new Promise<string>((resolve, reject) => {
      const entry: SpaceWorkerEntry = {
        loop: null as any,
        resolve,
        reject,
        settled: false,
      };

      const wrappedResolve = (summary: string) => {
        if (entry.settled) return;
        entry.settled = true;
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
        additionalPlugins: [{ toolPlugin: spacePlugin }],
      });

      entry.loop = loop;
      this.workers.set(space.id, entry);

      loop.start();
    });
  }

  stopSpaceWorker(spaceId: string): void {
    const entry = this.workers.get(spaceId);
    if (!entry) return;

    entry.loop.stop();
    this.workers.delete(spaceId);

    if (!entry.settled) {
      entry.settled = true;
      entry.reject(new Error("Space worker stopped"));
    }
  }

  runningCount(): number {
    return this.workers.size;
  }

  isRunning(spaceId: string): boolean {
    return this.workers.has(spaceId);
  }

  async stopAll(): Promise<void> {
    for (const [id] of this.workers) {
      this.stopSpaceWorker(id);
    }
  }
}
