/**
 * Scheduler Database — SQLite schema and CRUD operations for scheduled jobs
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getDataDir } from "../config-file";

const DB_PATH = join(getDataDir(), "scheduler.db");

let _db: Database | null = null;

function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_PATH, { strict: true });
    _db.exec("PRAGMA busy_timeout = 5000");
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA synchronous = NORMAL");
    _db.exec("PRAGMA cache_size = -8000"); // 8MB cache
    _db.exec("PRAGMA temp_store = MEMORY");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      created_by_agent TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('once','interval','cron','reminder','tool_call')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','paused','completed','failed','cancelled')),
      cron_expr TEXT,
      interval_ms INTEGER,
      run_at INTEGER,
      next_run INTEGER NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      timeout_seconds INTEGER DEFAULT 300,
      max_runs INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_run_at INTEGER,
      run_count INTEGER DEFAULT 0,
      consecutive_errors INTEGER DEFAULT 0,
      last_error TEXT,
      tool_name TEXT,
      tool_args_json TEXT
    );

    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('running','success','error','timeout')),
      error_message TEXT,
      output_summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_next_run
      ON scheduled_jobs(next_run) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_jobs_channel
      ON scheduled_jobs(channel);
    CREATE INDEX IF NOT EXISTS idx_runs_job
      ON job_runs(job_id, started_at);
  `);

  // Migrations for existing databases
  migrateSchedulerSchema(db);
}

// --- Migrations ---

function migrateSchedulerSchema(db: Database): void {
  // Check if tool_name column exists
  const cols = db.prepare("PRAGMA table_info(scheduled_jobs)").all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has("tool_name")) {
    db.exec("ALTER TABLE scheduled_jobs ADD COLUMN tool_name TEXT");
    db.exec("ALTER TABLE scheduled_jobs ADD COLUMN tool_args_json TEXT");
  }
}

// --- Types ---

export interface ScheduledJob {
  id: string;
  channel: string;
  created_by_agent: string;
  type: "once" | "interval" | "cron" | "reminder" | "tool_call";
  status: "active" | "paused" | "completed" | "failed" | "cancelled";
  cron_expr: string | null;
  interval_ms: number | null;
  run_at: number | null;
  next_run: number;
  title: string;
  prompt: string;
  timeout_seconds: number;
  max_runs: number | null;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  run_count: number;
  consecutive_errors: number;
  last_error: string | null;
  tool_name: string | null;
  tool_args_json: string | null;
}

export interface JobRun {
  id: string;
  job_id: string;
  started_at: number;
  completed_at: number | null;
  status: "running" | "success" | "error" | "timeout";
  error_message: string | null;
  output_summary: string | null;
}

// --- Prepared statements (lazy) ---

let _stmts: ReturnType<typeof prepareStatements> | null = null;

function stmts() {
  if (!_stmts) _stmts = prepareStatements(getDb());
  return _stmts;
}

function prepareStatements(db: Database) {
  return {
    insertJob: db.prepare(`
      INSERT INTO scheduled_jobs (id, channel, created_by_agent, type, status, cron_expr, interval_ms, run_at, next_run, title, prompt, timeout_seconds, max_runs, created_at, updated_at, tool_name, tool_args_json)
      VALUES ($id, $channel, $created_by_agent, $type, 'active', $cron_expr, $interval_ms, $run_at, $next_run, $title, $prompt, $timeout_seconds, $max_runs, $now, $now, $tool_name, $tool_args_json)
    `),
    getJob: db.prepare<ScheduledJob, [string]>("SELECT * FROM scheduled_jobs WHERE id = ?"),
    listByChannel: db.prepare<ScheduledJob, [string]>(
      "SELECT * FROM scheduled_jobs WHERE channel = ? ORDER BY next_run ASC",
    ),
    listByChannelAndStatus: db.prepare<ScheduledJob, [string, string]>(
      "SELECT * FROM scheduled_jobs WHERE channel = ? AND status = ? ORDER BY next_run ASC",
    ),
    countActiveByChannel: db.prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM scheduled_jobs WHERE channel = ? AND status = 'active'",
    ),
    getDueJobs: db.prepare<ScheduledJob, [number]>(
      "SELECT * FROM scheduled_jobs WHERE status = 'active' AND next_run <= ? ORDER BY next_run ASC",
    ),
    updateNextRun: db.prepare("UPDATE scheduled_jobs SET next_run = $next_run, updated_at = $now WHERE id = $id"),
    updateStatus: db.prepare("UPDATE scheduled_jobs SET status = $status, updated_at = $now WHERE id = $id"),
    incrementRun: db.prepare(
      "UPDATE scheduled_jobs SET run_count = run_count + 1, last_run_at = $now, updated_at = $now WHERE id = $id",
    ),
    incrementErrors: db.prepare(
      "UPDATE scheduled_jobs SET consecutive_errors = consecutive_errors + 1, last_error = $error, updated_at = $now WHERE id = $id",
    ),
    resetErrors: db.prepare(
      "UPDATE scheduled_jobs SET consecutive_errors = 0, last_error = NULL, updated_at = $now WHERE id = $id",
    ),
    insertRun: db.prepare(
      "INSERT INTO job_runs (id, job_id, started_at, status) VALUES ($id, $job_id, $started_at, 'running')",
    ),
    completeRun: db.prepare(
      "UPDATE job_runs SET status = $status, completed_at = $completed_at, error_message = $error_message, output_summary = $output_summary WHERE id = $id",
    ),
    getRunsForJob: db.prepare<JobRun, [string, number]>(
      "SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?",
    ),
    getZombieRuns: db.prepare<JobRun, []>("SELECT * FROM job_runs WHERE status = 'running'"),
    purgeOldRuns: db.prepare(
      "DELETE FROM job_runs WHERE job_id = ? AND id NOT IN (SELECT id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 100)",
    ),
  };
}

// --- CRUD Operations ---

export interface CreateJobParams {
  id: string;
  channel: string;
  created_by_agent: string;
  type: "once" | "interval" | "cron" | "reminder" | "tool_call";
  cron_expr?: string;
  interval_ms?: number;
  run_at?: number;
  next_run: number;
  title: string;
  prompt: string;
  timeout_seconds?: number;
  max_runs?: number;
  tool_name?: string;
  tool_args_json?: string;
}

export function createJob(params: CreateJobParams): ScheduledJob {
  const now = Date.now();
  stmts().insertJob.run({
    id: params.id,
    channel: params.channel,
    created_by_agent: params.created_by_agent,
    type: params.type,
    cron_expr: params.cron_expr ?? null,
    interval_ms: params.interval_ms ?? null,
    run_at: params.run_at ?? null,
    next_run: params.next_run,
    title: params.title,
    prompt: params.prompt,
    timeout_seconds: params.timeout_seconds ?? 300,
    max_runs: params.max_runs ?? null,
    now: now,
    tool_name: params.tool_name ?? null,
    tool_args_json: params.tool_args_json ?? null,
  });
  return stmts().getJob.get(params.id)!;
}

export function getJob(id: string): ScheduledJob | null {
  return stmts().getJob.get(id) ?? null;
}

export function listJobs(channel: string, status?: string): ScheduledJob[] {
  if (status && status !== "all") {
    return stmts().listByChannelAndStatus.all(channel, status);
  }
  return stmts().listByChannel.all(channel);
}

export function countActiveJobs(channel: string): number {
  return stmts().countActiveByChannel.get(channel)?.count ?? 0;
}

export function getDueJobs(now: number): ScheduledJob[] {
  return stmts().getDueJobs.all(now);
}

export function updateJobNextRun(id: string, nextRun: number): void {
  stmts().updateNextRun.run({ id, next_run: nextRun, now: Date.now() });
}

export function updateJobStatus(id: string, status: string): void {
  stmts().updateStatus.run({ id, status, now: Date.now() });
}

export function incrementRunCount(id: string): void {
  stmts().incrementRun.run({ id, now: Date.now() });
}

export function incrementErrors(id: string, error: string): void {
  stmts().incrementErrors.run({ id, error, now: Date.now() });
}

export function resetErrors(id: string): void {
  stmts().resetErrors.run({ id, now: Date.now() });
}

export function cancelJob(
  id: string,
  callerAgent: string,
  callerChannel: string,
): { success: boolean; error?: string } {
  const job = getJob(id);
  if (!job) return { success: false, error: "Job not found" };
  if (job.channel !== callerChannel) return { success: false, error: "Job belongs to another channel" };
  if (job.created_by_agent !== callerAgent)
    return { success: false, error: "Only the creating agent can cancel this job" };
  if (job.status === "cancelled" || job.status === "completed") {
    return { success: false, error: `Job is already ${job.status}` };
  }
  updateJobStatus(id, "cancelled");
  return { success: true };
}

export function pauseJob(id: string, callerAgent: string, callerChannel: string): { success: boolean; error?: string } {
  const job = getJob(id);
  if (!job) return { success: false, error: "Job not found" };
  if (job.channel !== callerChannel) return { success: false, error: "Job belongs to another channel" };
  if (job.created_by_agent !== callerAgent)
    return { success: false, error: "Only the creating agent can pause this job" };
  if (job.status !== "active") return { success: false, error: `Cannot pause job with status '${job.status}'` };
  updateJobStatus(id, "paused");
  return { success: true };
}

export function resumeJob(
  id: string,
  callerAgent: string,
  callerChannel: string,
): { success: boolean; error?: string } {
  const job = getJob(id);
  if (!job) return { success: false, error: "Job not found" };
  if (job.channel !== callerChannel) return { success: false, error: "Job belongs to another channel" };
  if (job.created_by_agent !== callerAgent)
    return { success: false, error: "Only the creating agent can resume this job" };
  if (job.status !== "paused") return { success: false, error: `Cannot resume job with status '${job.status}'` };
  updateJobStatus(id, "active");
  return { success: true };
}

// --- Run operations ---

export function insertRun(id: string, jobId: string): void {
  stmts().insertRun.run({ id, job_id: jobId, started_at: Date.now() });
}

export function completeRun(
  id: string,
  status: "success" | "error" | "timeout",
  errorMessage?: string,
  outputSummary?: string,
): void {
  stmts().completeRun.run({
    id,
    status,
    completed_at: Date.now(),
    error_message: errorMessage ?? null,
    output_summary: outputSummary ?? null,
  });
}

export function getRunsForJob(jobId: string, limit = 10): JobRun[] {
  return stmts().getRunsForJob.all(jobId, limit);
}

export function getZombieRuns(): JobRun[] {
  return stmts().getZombieRuns.all();
}

export function purgeOldRuns(jobId: string): void {
  stmts().purgeOldRuns.run(jobId, jobId);
}

// --- Cleanup ---

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _stmts = null;
  }
}
