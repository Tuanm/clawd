/**
 * Workspace Pool Manager
 *
 * Pre-warms and manages a pool of Docker workspace containers so agents
 * can acquire a running workspace in ~200ms instead of waiting for a cold
 * container start (~5-10s).
 *
 * Usage:
 *   const ws = await pool.acquire({ projectPath: '/my/project' });
 *   // ... agent does work in ws ...
 *   await pool.release(ws.id);
 */

import {
  spawnWorkspace,
  destroyWorkspace,
  getWorkspace,
  probeTcp,
  type WorkspaceHandle,
  type WorkspaceOptions,
} from "./container.js";

export interface PoolOptions {
  /** Number of pre-warmed containers to keep ready. Default: 1 */
  poolSize?: number;
  /** Docker image to use for all pool containers. Default: clawd-workspace:base */
  image?: string;
  /** Memory limit for each container. Default: 1g */
  memory?: string;
  /** CPU limit for each container. Default: 1 */
  cpus?: string;
}

export class WorkspacePool {
  private available: WorkspaceHandle[] = [];
  private inUse = new Map<string, WorkspaceHandle>();
  private readonly poolSize: number;
  private readonly spawnOpts: WorkspaceOptions;
  private warming = false;
  private started = false;

  constructor(opts: PoolOptions = {}) {
    this.poolSize = opts.poolSize ?? 1;
    this.spawnOpts = {
      image: opts.image ?? "clawd-workspace:base",
      memory: opts.memory ?? "1g",
      cpus: opts.cpus ?? "1",
    };
  }

  /**
   * Pre-warm containers up to poolSize. Safe to call multiple times.
   */
  async warmUp(): Promise<void> {
    if (this.warming) return;
    this.warming = true;
    try {
      const needed = this.poolSize - this.available.length;
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < needed; i++) {
        tasks.push(
          spawnWorkspace(this.spawnOpts)
            .then((handle) => {
              this.available.push(handle);
            })
            .catch((err) => {
              console.warn(`[workspace-pool] Pre-warm failed: ${err.message}`);
            }),
        );
      }
      await Promise.allSettled(tasks);
    } finally {
      this.warming = false;
    }
    this.started = true;
  }

  /**
   * Acquire a workspace. Returns a pre-warmed one if available, otherwise cold-starts.
   * After acquiring, refills pool in background.
   */
  async acquire(opts?: Pick<WorkspaceOptions, "projectPath" | "image" | "vncEnabled">): Promise<WorkspaceHandle> {
    // If a specific image is requested different from the pool image, always cold-start
    const wantsCustomImage = opts?.image && opts.image !== this.spawnOpts.image;

    let handle: WorkspaceHandle | undefined;
    if (!wantsCustomImage) {
      // Pop a healthy pre-warmed workspace — verify with live TCP probe
      while (this.available.length > 0) {
        const candidate = this.available.pop()!;
        const isAlive = await probeTcp("127.0.0.1", candidate.mcpPort, 500).catch(() => false);
        if (isAlive) {
          handle = candidate;
          break;
        }
        // Container crashed since warm-up — discard and clean up
        await destroyWorkspace(candidate.id).catch(() => {});
      }
    }

    if (!handle) {
      // Cold start
      handle = await spawnWorkspace({
        ...this.spawnOpts,
        ...opts,
      });
    } else if (opts?.projectPath) {
      // Pre-warmed containers don't have a project mounted — can't bind after start.
      // Return the pre-warmed one for general use; caller can copy files in via rsync/worktree.
      // Mount the project path is noted in the handle metadata only.
    }

    this.inUse.set(handle.id, handle);

    // Refill pool in background (don't await)
    if (!wantsCustomImage) {
      this.refillBackground();
    }

    return handle;
  }

  /**
   * Release a workspace back. Optionally recycles it into the pool.
   * If pool is full or recycling is disabled, the workspace is destroyed.
   */
  async release(id: string, opts: { recycle?: boolean } = {}): Promise<void> {
    const handle = this.inUse.get(id);
    if (!handle) {
      // May have been acquired directly via spawnWorkspace — try to destroy by id
      const h = getWorkspace(id);
      if (h) await destroyWorkspace(id).catch(() => {});
      return;
    }
    // Recycling is disabled by default until workspace state reset is implemented.
    // Recycled containers would carry prior session's Chrome profile, cookies, and files.
    const shouldRecycle = opts.recycle ?? false;
    if (shouldRecycle && this.available.length < this.poolSize && handle.status === "running") {
      this.available.push(handle);
    } else {
      try {
        await destroyWorkspace(id);
        this.inUse.delete(id);
      } catch (err: any) {
        // Keep in inUse so shutdown() can retry; log for diagnostics
        console.warn(`[workspace-pool] Destroy failed for ${id}: ${err.message}`);
      }
      return;
    }
    this.inUse.delete(id);
  }

  /**
   * Get a workspace by ID regardless of pool state.
   */
  get(id: string): WorkspaceHandle | undefined {
    return this.inUse.get(id) ?? this.available.find((h) => h.id === id);
  }

  /**
   * Destroy all pool and active workspaces. Call on Claw'd shutdown.
   */
  async shutdown(): Promise<void> {
    const all = [...this.available.map((h) => h.id), ...Array.from(this.inUse.keys())];
    await Promise.allSettled(all.map((id) => destroyWorkspace(id).catch(() => {})));
    this.available = [];
    this.inUse.clear();
  }

  /** Total pool-managed workspaces */
  get size(): number {
    return this.available.length + this.inUse.size;
  }

  /** Stats for debugging */
  stats(): { available: number; inUse: number; poolSize: number } {
    return {
      available: this.available.length,
      inUse: this.inUse.size,
      poolSize: this.poolSize,
    };
  }

  private refillBackground(): void {
    setImmediate(() => {
      if (this.available.length < this.poolSize && !this.warming) {
        this.warmUp().catch(() => {});
      }
    });
  }
}

/** Default singleton pool — used when workspace plugin is registered */
export const defaultPool = new WorkspacePool();
