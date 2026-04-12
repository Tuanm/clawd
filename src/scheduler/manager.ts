/**
 * Scheduler Manager — singleton that manages the tick loop and job lifecycle
 */
import type { AppConfig } from "../config/config";
import {
  type CreateJobParams,
  closeDb,
  completeRun,
  countActiveJobs,
  createJob,
  cancelJob as dbCancelJob,
  pauseJob as dbPauseJob,
  resumeJob as dbResumeJob,
  getDueJobs,
  getJob,
  getRunsForJob,
  getZombieRuns,
  incrementErrors,
  incrementRunCount,
  insertRun,
  type JobRun,
  listJobs,
  purgeOldRuns,
  resetErrors,
  type ScheduledJob,
  updateJobNextRun,
  updateJobStatus,
} from "./db";
import { calculateNextCronRun, parseSchedule } from "./parse-schedule";

const MAX_CONCURRENT = 3;
const MAX_JOBS_PER_CHANNEL = 25;
const TICK_INTERVAL_MS = 10_000;
const MAX_TITLE_LENGTH = 200;
const MAX_PROMPT_LENGTH = 10_000;
const MAX_REMINDER_LENGTH = 5_000;
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_TIMEOUT_SECONDS = 300;
const STARTUP_MAX_MISSED_ONCE = 5;
const STARTUP_MISSED_WINDOW_MS = 3_600_000; // 1 hour

export type JobExecutor = (
  job: ScheduledJob,
  runId: string,
  controller: AbortController,
) => Promise<string | undefined>;
export type ReminderExecutor = (job: ScheduledJob) => Promise<void>;
export type ToolCallExecutor = (
  job: ScheduledJob,
  runId: string,
  controller: AbortController,
) => Promise<string | undefined>;
export type BroadcastFn = (channel: string, event: object) => void;

export class SchedulerManager {
  private tickInterval: Timer | null = null;
  private isTickRunning = false;
  private stopping = false;
  readonly runningJobs = new Map<string, AbortController>();

  private jobExecutor: JobExecutor | null = null;
  private reminderExecutor: ReminderExecutor | null = null;
  private toolCallExecutor: ToolCallExecutor | null = null;

  constructor(
    private config: AppConfig,
    private broadcast: BroadcastFn,
  ) {}

  /** Set the job execution handler (set by runner.ts after Phase 2) */
  setJobExecutor(executor: JobExecutor): void {
    this.jobExecutor = executor;
  }

  /** Set the reminder execution handler */
  setReminderExecutor(executor: ReminderExecutor): void {
    this.reminderExecutor = executor;
  }

  /** Set the tool call execution handler */
  setToolCallExecutor(executor: ToolCallExecutor): void {
    this.toolCallExecutor = executor;
  }

  /** Start the scheduler: recover from startup, begin tick loop */
  start(): void {
    console.log("[Scheduler] Starting...");
    this.recoverOnStartup();
    this.tickInterval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    console.log("[Scheduler] Running (tick every 10s)");
  }

  /** Graceful shutdown */
  async stop(): Promise<void> {
    console.log("[Scheduler] Stopping...");
    this.stopping = true;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    // Abort all running jobs
    for (const [, controller] of this.runningJobs) {
      controller.abort("shutdown");
    }

    // Wait up to 30s for running jobs to finish
    const deadline = Date.now() + 30_000;
    while (this.runningJobs.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }

    // Mark any still-running as error
    for (const [id] of this.runningJobs) {
      // Find the running job_run for this job and mark error
      const runs = getRunsForJob(id, 1);
      if (runs.length > 0 && runs[0].status === "running") {
        completeRun(runs[0].id, "error", "Server shutdown");
      }
    }
    this.runningJobs.clear();

    closeDb();
    console.log("[Scheduler] Stopped");
  }

  registerRecoveredJob(jobId: string, controller: AbortController): void {
    this.runningJobs.set(jobId, controller);
  }

  unregisterRecoveredJob(jobId: string): void {
    this.runningJobs.delete(jobId);
  }

  checkJobCompletion(jobId: string): void {
    const job = getJob(jobId);
    if (job) this.checkCompletion(job);
  }

  // --- CRUD (called by ToolPlugin) ---

  createJobFromTool(params: {
    channel: string;
    agentId: string;
    title: string;
    prompt: string;
    schedule: string;
    maxRuns?: number;
    timeoutSeconds?: number;
    isReminder?: boolean;
    isToolCall?: boolean;
    toolName?: string;
    toolArgs?: Record<string, any>;
  }): { success: boolean; job?: ScheduledJob; error?: string } {
    // Validate limits
    const sanitizedTitle = params.title.replace(/[\n\r]/g, " ").trim();
    if (!sanitizedTitle) {
      return { success: false, error: "Title must not be empty" };
    }
    if (sanitizedTitle.length > MAX_TITLE_LENGTH) {
      return { success: false, error: `Title must be ${MAX_TITLE_LENGTH} chars or less` };
    }
    const maxLen = params.isReminder ? MAX_REMINDER_LENGTH : MAX_PROMPT_LENGTH;
    if (params.prompt.length > maxLen) {
      return { success: false, error: `${params.isReminder ? "Message" : "Prompt"} must be ${maxLen} chars or less` };
    }

    // Check channel limit
    const activeCount = countActiveJobs(params.channel);
    if (activeCount >= MAX_JOBS_PER_CHANNEL) {
      return {
        success: false,
        error: `Channel has ${activeCount} active jobs (limit: ${MAX_JOBS_PER_CHANNEL}). Cancel existing jobs first.`,
      };
    }

    // Parse schedule
    const parsed = parseSchedule(params.schedule);
    if (!parsed.success) return { success: false, error: (parsed as any).error };

    // Validate timeout
    const timeout = Math.min(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);

    const type = params.isToolCall ? "tool_call" : params.isReminder ? "reminder" : parsed.schedule.type;
    const id = crypto.randomUUID();

    const jobParams: CreateJobParams = {
      id,
      channel: params.channel,
      created_by_agent: params.agentId,
      type: type as "once" | "interval" | "cron" | "reminder" | "tool_call",
      title: sanitizedTitle,
      prompt: params.prompt,
      next_run: parsed.schedule.next_run,
      timeout_seconds: timeout,
      max_runs: params.maxRuns,
      tool_name: params.toolName,
      tool_args_json: params.toolArgs ? JSON.stringify(params.toolArgs) : undefined,
    };

    if (parsed.schedule.type === "once") {
      jobParams.run_at = parsed.schedule.run_at;
    } else if (parsed.schedule.type === "interval") {
      jobParams.interval_ms = parsed.schedule.interval_ms;
    } else if (parsed.schedule.type === "cron") {
      jobParams.cron_expr = parsed.schedule.cron_expr;
    }

    const job = createJob(jobParams);
    console.log(
      `[Scheduler] Created job: ${job.id} "${job.title}" (${job.type}, next: ${new Date(job.next_run).toISOString()})`,
    );

    this.broadcast(params.channel, {
      type: "scheduler_event",
      event: "created",
      job_id: job.id,
      title: job.title,
      job_type: job.type,
      next_run: job.next_run,
    });

    return { success: true, job };
  }

  listJobsForChannel(channel: string, status?: string): ScheduledJob[] {
    return listJobs(channel, status);
  }

  cancelJobFromTool(
    id: string,
    callerAgent: string,
    callerChannel: string,
  ): { success: boolean; error?: string; title?: string } {
    const job = getJob(id);
    if (!job) return { success: false, error: "Job not found" };

    // If job is currently running, abort it (S20)
    // Don't delete from runningJobs here — the executeJob finally block handles cleanup
    const controller = this.runningJobs.get(id);
    if (controller) {
      controller.abort("cancelled");
    }

    const result = dbCancelJob(id, callerAgent, callerChannel);
    if (result.success) {
      this.broadcast(callerChannel, { type: "scheduler_event", event: "cancelled", job_id: id, title: job.title });
    }
    return { ...result, title: job.title };
  }

  pauseJobFromTool(
    id: string,
    callerAgent: string,
    callerChannel: string,
  ): { success: boolean; error?: string; title?: string } {
    const job = getJob(id);
    if (!job) return { success: false, error: "Job not found" };
    const result = dbPauseJob(id, callerAgent, callerChannel);
    return { ...result, title: job.title };
  }

  resumeJobFromTool(
    id: string,
    callerAgent: string,
    callerChannel: string,
  ): { success: boolean; error?: string; title?: string } {
    const job = getJob(id);
    if (!job) return { success: false, error: "Job not found" };
    const result = dbResumeJob(id, callerAgent, callerChannel);
    return { ...result, title: job.title };
  }

  getJobRunsForTool(jobId: string, limit = 10, callerChannel?: string): JobRun[] {
    // Validate channel ownership if callerChannel provided
    if (callerChannel) {
      const job = getJob(jobId);
      if (!job || job.channel !== callerChannel) return [];
    }
    return getRunsForJob(jobId, limit);
  }

  // --- Tick Loop ---

  private async tick(): Promise<void> {
    if (this.isTickRunning || this.stopping) return;
    this.isTickRunning = true;

    try {
      const now = Date.now();
      const dueJobs = getDueJobs(now);

      for (const job of dueJobs) {
        if (this.runningJobs.size >= MAX_CONCURRENT) break;
        if (this.runningJobs.has(job.id)) continue; // S16: same job already running

        // Calculate next run time
        const nextRun = this.calculateNextRun(job);
        if (
          nextRun === null &&
          (job.type === "cron" ||
            job.type === "interval" ||
            (job.type === "reminder" && (job.cron_expr || job.interval_ms)))
        ) {
          // Null next_run for recurring job means schedule is invalid — mark failed to prevent infinite loop
          console.error(`[Scheduler] Cannot calculate next run for ${job.type} job ${job.id}, marking failed`);
          updateJobStatus(job.id, "failed");
          continue;
        }

        // Insert run record BEFORE advancing next_run to prevent silent job loss
        // on crash. If the process dies between these two operations, the run record
        // exists as evidence, and the job's next_run hasn't advanced yet (so it will
        // re-trigger on restart).
        const runId = crypto.randomUUID();
        insertRun(runId, job.id);

        // Now advance next_run (safe — run record already exists)
        if (nextRun !== null) {
          updateJobNextRun(job.id, nextRun);
        }

        // Reserve slot in runningJobs BEFORE async execution (prevents race with next tick)
        const controller = new AbortController();
        this.runningJobs.set(job.id, controller);

        // Fire and forget — .finally() ensures the runningJobs slot is always released,
        // even if the method throws before entering its internal try block.
        if (job.type === "reminder") {
          this.executeReminder(job, runId).finally(() => this.runningJobs.delete(job.id));
        } else if (job.type === "tool_call") {
          this.executeToolCall(job, controller, runId)
            .catch((e) => this.handleJobError(job, e))
            .finally(() => this.runningJobs.delete(job.id));
        } else {
          this.executeJob(job, controller, runId)
            .catch((e) => this.handleJobError(job, e))
            .finally(() => this.runningJobs.delete(job.id));
        }
      }
    } catch (err) {
      console.error("[Scheduler] Tick error:", err);
    } finally {
      this.isTickRunning = false;
    }
  }

  private async executeReminder(job: ScheduledJob, runId: string): Promise<void> {
    // Run record already inserted by tick()

    try {
      if (this.reminderExecutor) {
        await this.reminderExecutor(job);
      }
      completeRun(runId, "success", undefined, job.prompt.slice(0, 500));
      incrementRunCount(job.id);
      resetErrors(job.id);
      this.checkCompletion(job);
      purgeOldRuns(job.id);
    } catch (err: unknown) {
      completeRun(runId, "error", err instanceof Error ? err.message : String(err));
      // Don't re-throw — handleJobError is called here, not in outer .catch()
      this.handleJobError(job, err);
    }
  }

  private async executeJob(job: ScheduledJob, controller: AbortController, runId: string): Promise<void> {
    if (!this.jobExecutor) {
      console.warn("[Scheduler] No job executor set, skipping job:", job.id);
      return; // Outer .finally() handles runningJobs cleanup
    }
    // Run record already inserted by tick()

    // Timeout
    const timeout = setTimeout(
      () => {
        controller.abort("timeout");
      },
      (job.timeout_seconds || DEFAULT_TIMEOUT_SECONDS) * 1000,
    );

    try {
      const output = await this.jobExecutor(job, runId, controller);

      completeRun(runId, "success", undefined, output?.slice(0, 500));
      incrementRunCount(job.id);
      resetErrors(job.id);
      this.checkCompletion(job);
      purgeOldRuns(job.id);
    } catch (err: unknown) {
      const wasAborted = controller.signal.aborted;
      const errMsg = err instanceof Error ? err.message : String(err);
      const status = wasAborted && controller.signal.reason === "timeout" ? "timeout" : "error";
      completeRun(runId, status, errMsg);
      this.handleJobError(job, err, wasAborted);
    } finally {
      clearTimeout(timeout);
      // runningJobs cleanup handled by outer .finally() in tick()
    }
  }

  private async executeToolCall(job: ScheduledJob, controller: AbortController, runId: string): Promise<void> {
    if (!this.toolCallExecutor) {
      console.warn("[Scheduler] No tool call executor set, skipping:", job.id);
      return; // Outer .finally() handles runningJobs cleanup
    }
    // Run record already inserted by tick()

    const timeout = setTimeout(
      () => {
        controller.abort("timeout");
      },
      (job.timeout_seconds || DEFAULT_TIMEOUT_SECONDS) * 1000,
    );

    try {
      const output = await this.toolCallExecutor(job, runId, controller);

      completeRun(runId, "success", undefined, output?.slice(0, 500));
      incrementRunCount(job.id);
      resetErrors(job.id);
      this.checkCompletion(job);
      purgeOldRuns(job.id);
    } catch (err: unknown) {
      const wasAborted = controller.signal.aborted;
      const errMsg = err instanceof Error ? err.message : String(err);
      const status = wasAborted && controller.signal.reason === "timeout" ? "timeout" : "error";
      completeRun(runId, status, errMsg);
      this.handleJobError(job, err, wasAborted);
    } finally {
      clearTimeout(timeout);
      // runningJobs cleanup handled by outer .finally() in tick()
    }
  }

  private handleJobError(job: ScheduledJob, err: any, wasAborted = false): void {
    if (wasAborted) return; // Don't increment error counters for aborted jobs
    const errMsg = err.message || String(err);
    console.error(`[Scheduler] Job ${job.id} "${job.title}" error:`, errMsg);

    if (!isRetryableError(err)) {
      incrementErrors(job.id, errMsg);

      // Check auto-pause threshold
      const updated = getJob(job.id);
      if (updated && updated.consecutive_errors >= 5) {
        updateJobStatus(job.id, "paused");
        console.warn(`[Scheduler] Auto-paused job ${job.id} after 5 consecutive errors`);
        // Sanitize error for broadcast — don't expose internal details
        const safeError = errMsg.length > 200 ? errMsg.slice(0, 200) + "..." : errMsg;
        this.broadcast(job.channel, {
          type: "scheduler_event",
          event: "auto_paused",
          job_id: job.id,
          title: job.title,
          error: safeError,
        });
      }
    }
  }

  private checkCompletion(job: ScheduledJob): void {
    const updated = getJob(job.id);
    if (!updated) return;

    // Once jobs, single-fire reminders, and one-shot tool calls complete after one run
    const isOneShot =
      job.type === "once" ||
      (job.type === "reminder" && !job.interval_ms && !job.cron_expr) ||
      (job.type === "tool_call" && !job.interval_ms && !job.cron_expr);
    if (isOneShot) {
      updateJobStatus(job.id, "completed");
      return;
    }

    // Check max_runs (run_count already incremented by incrementRunCount)
    if (updated.max_runs != null && updated.max_runs > 0 && updated.run_count >= updated.max_runs) {
      updateJobStatus(job.id, "completed");
      this.broadcast(job.channel, {
        type: "scheduler_event",
        event: "completed",
        job_id: job.id,
        title: job.title,
        run_count: updated.run_count,
      });
    }
  }

  private calculateNextRun(job: ScheduledJob): number | null {
    const now = Date.now();

    switch (job.type) {
      case "once":
        // One-shot: mark next_run far in future (will be completed after run)
        return now + 365 * 24 * 60 * 60 * 1000;

      case "reminder":
        // Recurring reminders follow their schedule
        if (job.interval_ms) return now + job.interval_ms;
        if (job.cron_expr) return calculateNextCronRun(job.cron_expr.split(/\s+/));
        // One-shot reminder: mark far in future (will be completed after run)
        return now + 365 * 24 * 60 * 60 * 1000;

      case "interval":
        if (!job.interval_ms) return null;
        return now + job.interval_ms;

      case "cron":
        if (!job.cron_expr) return null;
        return calculateNextCronRun(job.cron_expr.split(/\s+/));

      case "tool_call":
        // Tool calls follow interval/cron if set, otherwise one-shot
        if (job.interval_ms) return now + job.interval_ms;
        if (job.cron_expr) return calculateNextCronRun(job.cron_expr.split(/\s+/));
        return now + 365 * 24 * 60 * 60 * 1000;

      default:
        return null;
    }
  }

  // --- Startup Recovery ---

  private recoverOnStartup(): void {
    // S19: Clear in-memory state and reconcile
    this.runningJobs.clear();

    // Mark zombie runs as error
    const zombies = getZombieRuns();
    for (const run of zombies) {
      completeRun(run.id, "error", "Interrupted by server restart");
      console.log(`[Scheduler] Cleaned zombie run: ${run.id} for job ${run.job_id}`);
    }

    // Handle missed once jobs
    const now = Date.now();
    const dueJobs = getDueJobs(now);
    let missedOnceCount = 0;

    for (const job of dueJobs) {
      // Recurring reminders/tool_calls (with interval or cron) should be rescheduled, not treated as one-shot
      const isOneShot =
        job.type === "once" ||
        (job.type === "reminder" && !job.interval_ms && !job.cron_expr) ||
        (job.type === "tool_call" && !job.interval_ms && !job.cron_expr);
      if (isOneShot) {
        const overdue = now - job.next_run;
        if (overdue < STARTUP_MISSED_WINDOW_MS && missedOnceCount < STARTUP_MAX_MISSED_ONCE) {
          // Will be picked up by next tick
          missedOnceCount++;
          console.log(
            `[Scheduler] Missed once job will run: ${job.id} "${job.title}" (overdue ${Math.round(overdue / 1000)}s)`,
          );
        } else {
          updateJobStatus(job.id, "failed");
          console.log(
            `[Scheduler] Missed once job expired: ${job.id} "${job.title}" (overdue ${Math.round(overdue / 1000)}s)`,
          );
        }
      } else {
        // Interval/cron/recurring reminder: skip to next occurrence
        const nextRun = this.calculateNextRun(job);
        if (nextRun) {
          updateJobNextRun(job.id, nextRun);
          console.log(
            `[Scheduler] Rescheduled ${job.type} job: ${job.id} "${job.title}" to ${new Date(nextRun).toISOString()}`,
          );
        } else {
          updateJobStatus(job.id, "failed");
          console.log(`[Scheduler] Cannot reschedule ${job.type} job: ${job.id} "${job.title}", marking failed`);
        }
      }
    }

    const activeCount = getDueJobs(now + 86_400_000).length; // Next 24h
    console.log(
      `[Scheduler] Recovery complete: ${zombies.length} zombies cleaned, ${missedOnceCount} missed jobs queued, ${activeCount} active jobs`,
    );
  }
}

/** Check if an error is retryable (shouldn't count toward auto-pause) */
function isRetryableError(err: any): boolean {
  const msg = (err.message || String(err)).toLowerCase();
  if (msg.includes("429") || msg.includes("rate limit")) return true;
  if (msg.includes("503") || msg.includes("service unavailable")) return true;
  if (msg.includes("500") || msg.includes("internal server error")) return true;
  if (msg.includes("econnrefused") || msg.includes("etimedout")) return true;
  if (msg.includes("econnreset") || msg.includes("fetch failed")) return true;
  return false;
}
