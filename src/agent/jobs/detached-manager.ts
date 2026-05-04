/**
 * Detached Job Manager — Persistent Background Tasks Without tmux
 *
 * Fallback for `TmuxJobManager` on hosts without tmux. Spawns each job as a
 * detached subprocess whose stdout/stderr go to a log file via numeric fd.
 * The child is `unref`-ed so the agent can exit without taking it down; on
 * POSIX it's also moved to its own process group via `detached: true` so we
 * can later kill the whole tree with `kill(-pid, …)`.
 *
 * Implements the same shape as `TmuxJobManager` so callers can swap them.
 *
 * NOTE: POSIX-only. Windows support is a separate concern (no tmux there
 * either, so anything we add must use cmd.exe wrappers — out of scope here).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Job, JobStatus } from "./tmux-manager";

// ============================================================================
// Constants
// ============================================================================

function getJobsDir(): string {
  try {
    const { getProjectJobsDir } = require("../tools/definitions");
    return getProjectJobsDir();
  } catch {
    return join(homedir(), ".clawd", "jobs");
  }
}

let _jobsDir: string | null = null;
function JOBS_DIR(): string {
  if (!_jobsDir) _jobsDir = getJobsDir();
  return _jobsDir;
}

// ============================================================================
// Types
// ============================================================================

interface DetachedJobMeta {
  id: string;
  name: string;
  command: string;
  pid?: number;
  createdAt: number;
  startedAt?: number;
  /** Marker so `list()` can ignore tmux-flavored job dirs left by another run. */
  kind: "detached";
}

// ============================================================================
// Helpers
// ============================================================================

function ensureJobsDir(): void {
  const dir = JOBS_DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function getJobDir(id: string): string {
  return join(JOBS_DIR(), id);
}

/** `kill(pid, 0)` is the POSIX-standard liveness probe. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but we don't own it — still alive.
    if ((err as NodeJS.ErrnoException)?.code === "EPERM") return true;
    return false;
  }
}

// ============================================================================
// DetachedJobManager
// ============================================================================

export class DetachedJobManager {
  constructor() {
    ensureJobsDir();
  }

  // ==========================================================================
  // Submit Job
  // ==========================================================================

  submit(name: string, command: string): string {
    if (process.platform === "win32") {
      throw new Error("DetachedJobManager does not yet support Windows. Install tmux (WSL/Cygwin) or use foreground bash.");
    }
    ensureJobsDir();

    const id = randomUUID();
    const jobDir = getJobDir(id);
    const logFile = join(jobDir, "output.log");
    const metaFile = join(jobDir, "meta.json");
    const exitFile = join(jobDir, "exit_code");
    const scriptFile = join(jobDir, "run.sh");

    mkdirSync(jobDir, { recursive: true, mode: 0o700 });

    // Initial meta (pid filled in after spawn)
    const meta: DetachedJobMeta = {
      id,
      name,
      command,
      createdAt: Date.now(),
      startedAt: Date.now(),
      kind: "detached",
    };
    writeFileSync(metaFile, JSON.stringify(meta, null, 2));

    // Wrapper records the exit code so `get()` works even after agent restart.
    // Stdio is redirected via the parent-side fd, so no `exec >` here.
    const scriptContent = `#!/bin/bash
(
${command}
)
EXIT_CODE=$?
echo $EXIT_CODE > "${exitFile}"
exit $EXIT_CODE
`;
    writeFileSync(scriptFile, scriptContent, { mode: 0o700 });

    // Open log fd, hand it to child for stdout+stderr, then close our copy.
    // The child inherits its own duplicate, so the file keeps growing after
    // we exit (kernel keeps the inode alive while any fd refers to it).
    const fd = openSync(logFile, "a");
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("bash", [scriptFile], {
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }

    const pid = proc.pid;
    if (!pid) {
      // spawn errored synchronously — clean up so list() doesn't see a stub
      try {
        unlinkSync(metaFile);
        unlinkSync(scriptFile);
        rmdirSync(jobDir);
      } catch {}
      throw new Error("Failed to start detached job: spawn returned no pid");
    }

    // Persist pid for cross-restart status checks
    const finalMeta: DetachedJobMeta = { ...meta, pid };
    writeFileSync(metaFile, JSON.stringify(finalMeta, null, 2));

    // Detach from event loop so the agent process can exit cleanly
    proc.unref();

    return id;
  }

  // ==========================================================================
  // Get Job Status
  // ==========================================================================

  get(id: string): Job | undefined {
    const jobDir = getJobDir(id);
    const metaFile = join(jobDir, "meta.json");
    if (!existsSync(metaFile)) return undefined;

    let meta: DetachedJobMeta;
    try {
      meta = JSON.parse(readFileSync(metaFile, "utf8"));
    } catch {
      return undefined;
    }
    // Skip job dirs created by a different manager (e.g. tmux)
    if (meta.kind !== "detached") return undefined;

    const exitFile = join(jobDir, "exit_code");
    const isRunning = meta.pid != null && pidAlive(meta.pid);

    let status: JobStatus;
    let exitCode: number | undefined;
    let completedAt: number | undefined;

    if (isRunning) {
      status = "running";
    } else if (existsSync(exitFile)) {
      const code = Number.parseInt(readFileSync(exitFile, "utf8").trim(), 10);
      exitCode = code;
      if (code === 0) status = "completed";
      else if (code === -1) status = "cancelled";
      else status = "failed";
      try {
        completedAt = statSync(exitFile).mtimeMs;
      } catch {
        completedAt = Date.now();
      }
    } else {
      // Process is gone but never wrote exit_code — externally killed.
      status = "cancelled";
      completedAt = Date.now();
    }

    return {
      id: meta.id,
      name: meta.name,
      command: meta.command,
      status,
      exitCode,
      createdAt: meta.createdAt,
      startedAt: meta.startedAt,
      completedAt,
    };
  }

  // ==========================================================================
  // List Jobs
  // ==========================================================================

  list(filter?: { status?: JobStatus; limit?: number }): Job[] {
    ensureJobsDir();
    const jobs: Job[] = [];
    const dir = JOBS_DIR();
    const entries = existsSync(dir) ? readdirSync(dir) : [];

    for (const entry of entries) {
      if (entry === "tmux.sock") continue;
      const metaFile = join(dir, entry, "meta.json");
      if (!existsSync(metaFile)) continue;
      const job = this.get(entry);
      if (!job) continue;
      if (filter?.status && job.status !== filter.status) continue;
      jobs.push(job);
    }

    jobs.sort((a, b) => b.createdAt - a.createdAt);
    return filter?.limit ? jobs.slice(0, filter.limit) : jobs;
  }

  // ==========================================================================
  // Get Job Logs
  // ==========================================================================

  getLogs(id: string, tail?: number): string {
    const logFile = join(getJobDir(id), "output.log");
    if (!existsSync(logFile)) return "";

    const raw = readFileSync(logFile, "utf8");
    if (tail) {
      const lines = raw.split("\n");
      return lines.slice(-tail).join("\n");
    }
    const MAX_LOG_BYTES = 100 * 1024;
    if (raw.length <= MAX_LOG_BYTES) return raw;
    return "[...truncated, showing last 100KB...]\n" + raw.slice(raw.length - MAX_LOG_BYTES);
  }

  // ==========================================================================
  // Cancel Job
  // ==========================================================================

  cancel(id: string): boolean {
    const jobDir = getJobDir(id);
    const metaFile = join(jobDir, "meta.json");
    if (!existsSync(metaFile)) return false;

    let meta: DetachedJobMeta;
    try {
      meta = JSON.parse(readFileSync(metaFile, "utf8"));
    } catch {
      return false;
    }
    if (meta.kind !== "detached" || meta.pid == null) return false;
    if (!pidAlive(meta.pid)) return false;

    // Negative pid sends to the whole process group (set up by detached: true).
    // Falls back to single-pid kill if the group call fails (unlikely on POSIX).
    let killed = false;
    try {
      process.kill(-meta.pid, "SIGTERM");
      killed = true;
    } catch {
      try {
        process.kill(meta.pid, "SIGTERM");
        killed = true;
      } catch {}
    }

    if (killed) {
      // -1 sentinel mirrors TmuxJobManager so `get()` reports "cancelled"
      writeFileSync(join(jobDir, "exit_code"), "-1");
    }
    return killed;
  }

  // ==========================================================================
  // Wait for Job
  // ==========================================================================

  async waitFor(id: string, timeoutMs: number = 60000): Promise<Job> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
      const job = this.get(id);
      if (!job) throw new Error(`Job ${id} not found`);
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    throw new Error(`Job ${id} timed out after ${timeoutMs}ms`);
  }

  // ==========================================================================
  // Cleanup Old Jobs
  // ==========================================================================

  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    ensureJobsDir();
    let cleaned = 0;
    const now = Date.now();
    const dir = JOBS_DIR();
    const entries = existsSync(dir) ? readdirSync(dir) : [];

    for (const entry of entries) {
      if (entry === "tmux.sock") continue;
      const jobDir = join(dir, entry);
      const metaFile = join(jobDir, "meta.json");
      if (!existsSync(metaFile)) continue;

      try {
        const meta: DetachedJobMeta = JSON.parse(readFileSync(metaFile, "utf8"));
        if (meta.kind !== "detached") continue;
        const job = this.get(entry);
        if (job?.completedAt && now - job.completedAt > maxAgeMs) {
          for (const file of readdirSync(jobDir)) unlinkSync(join(jobDir, file));
          rmdirSync(jobDir);
          cleaned++;
        }
      } catch {}
    }
    return cleaned;
  }

  // ==========================================================================
  // Get Running Jobs
  // ==========================================================================

  getRunningJobs(): Job[] {
    return this.list({ status: "running" });
  }
}

export const detachedJobManager = new DetachedJobManager();
