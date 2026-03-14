/**
 * tmux-based Job Manager - Persistent Background Task Execution
 *
 * Uses a dedicated tmux socket so jobs:
 * 1. Survive agent process exit
 * 2. Are isolated from user's normal tmux sessions
 * 3. Can be recovered after restart
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Constants
// ============================================================================

// Use project-scoped jobs directory via getProjectJobsDir() from tools
// Falls back to ~/.clawd/jobs for backward compatibility
function getJobsDir(): string {
  // Try to use project-scoped directory
  try {
    const { getProjectJobsDir } = require("../tools/tools");
    return getProjectJobsDir();
  } catch {
    // Fallback if tools module not loaded yet
    return join(homedir(), ".clawd", "jobs");
  }
}

let _jobsDir: string | null = null;
function JOBS_DIR(): string {
  if (!_jobsDir) {
    _jobsDir = getJobsDir();
  }
  return _jobsDir;
}

function SOCKET_PATH(): string {
  return join(JOBS_DIR(), "tmux.sock");
}

const JOB_PREFIX = "clawd-job-";

// ============================================================================
// Types
// ============================================================================

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  name: string;
  command: string;
  status: JobStatus;
  exitCode?: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

interface JobMeta {
  id: string;
  name: string;
  command: string;
  createdAt: number;
  startedAt?: number;
}

// ============================================================================
// Helpers
// ============================================================================

function ensureJobsDir(): void {
  const dir = JOBS_DIR();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function getJobDir(id: string): string {
  return join(JOBS_DIR(), id);
}

function tmuxCmd(args: string): string {
  return `tmux -S "${SOCKET_PATH()}" ${args}`;
}

function execTmux(args: string): string {
  try {
    return execSync(tmuxCmd(args), { encoding: "utf8", timeout: 5000 }).trim();
  } catch (_err: any) {
    // tmux returns error if server not running or session not found
    return "";
  }
}

function sessionExists(sessionName: string): boolean {
  const result = execTmux(`has-session -t "${sessionName}" 2>/dev/null && echo yes`);
  return result === "yes";
}

function _listTmuxSessions(): string[] {
  const result = execTmux('list-sessions -F "#{session_name}" 2>/dev/null');
  if (!result) return [];
  return result.split("\n").filter((s) => s.startsWith(JOB_PREFIX));
}

// ============================================================================
// TmuxJobManager
// ============================================================================

export class TmuxJobManager {
  constructor() {
    ensureJobsDir();
  }

  // ==========================================================================
  // Submit Job
  // ==========================================================================

  submit(name: string, command: string): string {
    ensureJobsDir();

    const id = randomUUID();
    const sessionName = `${JOB_PREFIX}${id}`;
    const jobDir = getJobDir(id);
    const logFile = join(jobDir, "output.log");
    const metaFile = join(jobDir, "meta.json");
    const exitFile = join(jobDir, "exit_code");
    const scriptFile = join(jobDir, "run.sh");

    // Create job directory
    mkdirSync(jobDir, { recursive: true, mode: 0o700 });

    // Write job metadata
    const meta: JobMeta = {
      id,
      name,
      command,
      createdAt: Date.now(),
      startedAt: Date.now(),
    };
    writeFileSync(metaFile, JSON.stringify(meta, null, 2));

    // Write wrapper script to file (avoids quoting hell)
    // Use a subshell to capture exit code even if command contains 'exit'
    const scriptContent = `#!/bin/bash
exec > "${logFile}" 2>&1
(
${command}
)
EXIT_CODE=$?
echo $EXIT_CODE > "${exitFile}"
exit $EXIT_CODE
`;
    writeFileSync(scriptFile, scriptContent, { mode: 0o700 });

    // Start tmux session running the script
    try {
      execSync(tmuxCmd(`new-session -d -s "${sessionName}" "${scriptFile}"`), { encoding: "utf8", timeout: 5000 });
    } catch (err: any) {
      // Clean up on failure
      try {
        unlinkSync(metaFile);
        unlinkSync(scriptFile);
      } catch {}
      throw new Error(`Failed to start job: ${err.message}`);
    }

    return id;
  }

  // ==========================================================================
  // Get Job Status
  // ==========================================================================

  get(id: string): Job | undefined {
    const jobDir = getJobDir(id);
    const metaFile = join(jobDir, "meta.json");

    if (!existsSync(metaFile)) {
      return undefined;
    }

    const meta: JobMeta = JSON.parse(readFileSync(metaFile, "utf8"));
    const sessionName = `${JOB_PREFIX}${id}`;
    const exitFile = join(jobDir, "exit_code");

    // Check if tmux session is still running
    const isRunning = sessionExists(sessionName);

    let status: JobStatus;
    let exitCode: number | undefined;
    let completedAt: number | undefined;

    if (isRunning) {
      status = "running";
    } else if (existsSync(exitFile)) {
      const code = parseInt(readFileSync(exitFile, "utf8").trim(), 10);
      exitCode = code;
      // -1 indicates cancelled (we write this when cancel() is called)
      if (code === 0) {
        status = "completed";
      } else if (code === -1) {
        status = "cancelled";
      } else {
        status = "failed";
      }

      // Use file mtime as completion time
      try {
        const { mtimeMs } = statSync(exitFile);
        completedAt = mtimeMs;
      } catch {
        completedAt = Date.now();
      }
    } else {
      // Session ended but no exit code file - probably killed externally
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

    // Check both running tmux sessions and job directories on disk
    const jobsDir = JOBS_DIR();
    const dirs = existsSync(jobsDir) ? readdirSync(jobsDir) : [];

    for (const entry of dirs) {
      if (entry === "tmux.sock") continue;

      const metaFile = join(jobsDir, entry, "meta.json");
      if (!existsSync(metaFile)) continue;

      const job = this.get(entry);
      if (job) {
        if (!filter?.status || job.status === filter.status) {
          jobs.push(job);
        }
      }
    }

    // Sort by creation time (newest first)
    jobs.sort((a, b) => b.createdAt - a.createdAt);

    if (filter?.limit) {
      return jobs.slice(0, filter.limit);
    }

    return jobs;
  }

  // ==========================================================================
  // Get Job Logs
  // ==========================================================================

  getLogs(id: string, tail?: number): string {
    const logFile = join(getJobDir(id), "output.log");

    if (!existsSync(logFile)) {
      return "";
    }

    if (tail) {
      try {
        return execSync(`tail -n ${tail} "${logFile}"`, { encoding: "utf8" });
      } catch {
        return "";
      }
    }

    return readFileSync(logFile, "utf8");
  }

  // ==========================================================================
  // Cancel Job
  // ==========================================================================

  cancel(id: string): boolean {
    const sessionName = `${JOB_PREFIX}${id}`;

    if (!sessionExists(sessionName)) {
      return false;
    }

    try {
      execTmux(`kill-session -t "${sessionName}"`);

      // Write cancelled marker
      const exitFile = join(getJobDir(id), "exit_code");
      writeFileSync(exitFile, "-1"); // Use -1 to indicate cancelled

      return true;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Wait for Job
  // ==========================================================================

  async waitFor(id: string, timeoutMs: number = 60000): Promise<Job> {
    const startTime = Date.now();
    const pollInterval = 500; // 500ms

    while (Date.now() - startTime < timeoutMs) {
      const job = this.get(id);

      if (!job) {
        throw new Error(`Job ${id} not found`);
      }

      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }

      // Wait before polling again
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

    const jobsDirPath = JOBS_DIR();
    const dirs = existsSync(jobsDirPath) ? readdirSync(jobsDirPath) : [];

    for (const entry of dirs) {
      if (entry === "tmux.sock") continue;

      const jobDir = join(jobsDirPath, entry);
      const metaFile = join(jobDir, "meta.json");

      if (!existsSync(metaFile)) continue;

      try {
        const _meta: JobMeta = JSON.parse(readFileSync(metaFile, "utf8"));
        const job = this.get(entry);

        // Only clean up completed/failed/cancelled jobs older than maxAge
        if (job?.completedAt && now - job.completedAt > maxAgeMs) {
          // Remove job directory
          const files = readdirSync(jobDir);
          for (const file of files) {
            unlinkSync(join(jobDir, file));
          }
          rmdirSync(jobDir);
          cleaned++;
        }
      } catch {
        // Skip problematic entries
      }
    }

    return cleaned;
  }

  // ==========================================================================
  // Get Running Jobs (for exit check)
  // ==========================================================================

  getRunningJobs(): Job[] {
    return this.list({ status: "running" });
  }

  // ==========================================================================
  // Kill tmux Server (cleanup)
  // ==========================================================================

  killServer(): boolean {
    try {
      execTmux("kill-server");
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton instance
export const tmuxJobManager = new TmuxJobManager();
