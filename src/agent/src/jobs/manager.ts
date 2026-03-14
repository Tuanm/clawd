/**
 * Background Job Manager - Async Task Execution with Status Tracking
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

// ============================================================================
// Types
// ============================================================================

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  name: string;
  description: string;
  status: JobStatus;
  progress: number; // 0-100
  result?: any;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  metadata?: Record<string, any>;
}

export interface JobTask {
  name: string;
  description: string;
  execute: (progress: (pct: number, message?: string) => void, signal: AbortSignal) => Promise<any>;
  metadata?: Record<string, any>;
}

// ============================================================================
// Job Manager
// ============================================================================

export class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private abortControllers = new Map<string, AbortController>();
  private maxConcurrent: number;
  private runningCount = 0;
  private queue: Array<{ id: string; task: JobTask }> = [];

  constructor(maxConcurrent = 5) {
    super();
    this.maxConcurrent = maxConcurrent;
  }

  // ============================================================================
  // Submit Job
  // ============================================================================

  submit(task: JobTask): string {
    const id = randomUUID();
    const job: Job = {
      id,
      name: task.name,
      description: task.description,
      status: "pending",
      progress: 0,
      createdAt: Date.now(),
      metadata: task.metadata,
    };

    this.jobs.set(id, job);
    this.queue.push({ id, task });
    this.emit("job:created", job);

    // Try to start immediately
    this.processQueue();

    return id;
  }

  // ============================================================================
  // Process Queue
  // ============================================================================

  private processQueue() {
    while (this.runningCount < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.executeJob(item.id, item.task);
    }
  }

  // ============================================================================
  // Execute Job
  // ============================================================================

  private async executeJob(id: string, task: JobTask) {
    const job = this.jobs.get(id);
    if (!job) return;

    const abortController = new AbortController();
    this.abortControllers.set(id, abortController);
    this.runningCount++;

    job.status = "running";
    job.startedAt = Date.now();
    this.emit("job:started", job);

    const progress = (pct: number, message?: string) => {
      job.progress = Math.min(100, Math.max(0, pct));
      if (message) {
        job.metadata = { ...job.metadata, lastMessage: message };
      }
      this.emit("job:progress", job);
    };

    try {
      const result = await task.execute(progress, abortController.signal);

      if (abortController.signal.aborted) {
        job.status = "cancelled";
        this.emit("job:cancelled", job);
      } else {
        job.status = "completed";
        job.result = result;
        job.progress = 100;
        this.emit("job:completed", job);
      }
    } catch (error: any) {
      if (abortController.signal.aborted) {
        job.status = "cancelled";
        this.emit("job:cancelled", job);
      } else {
        job.status = "failed";
        job.error = error.message || String(error);
        this.emit("job:failed", job);
      }
    } finally {
      job.completedAt = Date.now();
      this.abortControllers.delete(id);
      this.runningCount--;
      this.processQueue();
    }
  }

  // ============================================================================
  // Cancel Job
  // ============================================================================

  cancel(id: string): boolean {
    const controller = this.abortControllers.get(id);
    if (controller) {
      controller.abort();
      return true;
    }

    // Check if in queue
    const queueIndex = this.queue.findIndex((item) => item.id === id);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      const job = this.jobs.get(id);
      if (job) {
        job.status = "cancelled";
        job.completedAt = Date.now();
        this.emit("job:cancelled", job);
      }
      return true;
    }

    return false;
  }

  // ============================================================================
  // Get Job
  // ============================================================================

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  // ============================================================================
  // List Jobs
  // ============================================================================

  list(filter?: { status?: JobStatus; limit?: number }): Job[] {
    let jobs = [...this.jobs.values()];

    if (filter?.status) {
      jobs = jobs.filter((j) => j.status === filter.status);
    }

    jobs.sort((a, b) => b.createdAt - a.createdAt);

    if (filter?.limit) {
      jobs = jobs.slice(0, filter.limit);
    }

    return jobs;
  }

  // ============================================================================
  // Wait for Job
  // ============================================================================

  async waitFor(id: string, timeoutMs?: number): Promise<Job> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job ${id} not found`);

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return job;
    }

    return new Promise((resolve, reject) => {
      let timeout: Timer | undefined;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        this.off("job:completed", onComplete);
        this.off("job:failed", onFail);
        this.off("job:cancelled", onCancel);
      };

      const onComplete = (j: Job) => {
        if (j.id === id) {
          cleanup();
          resolve(j);
        }
      };

      const onFail = (j: Job) => {
        if (j.id === id) {
          cleanup();
          resolve(j);
        }
      };

      const onCancel = (j: Job) => {
        if (j.id === id) {
          cleanup();
          resolve(j);
        }
      };

      this.on("job:completed", onComplete);
      this.on("job:failed", onFail);
      this.on("job:cancelled", onCancel);

      if (timeoutMs) {
        timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Job ${id} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  // ============================================================================
  // Cleanup Old Jobs
  // ============================================================================

  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.completedAt && now - job.completedAt > maxAgeMs) {
        this.jobs.delete(id);
      }
    }
  }
}

// Singleton
export const jobManager = new JobManager();
