/**
 * Scheduler Tool Plugin — 9 tools for agent-controlled scheduling
 *
 * These tools manage RECURRING scheduled tasks (cron-like). They are different from
 * the job_* tools which run one-off background commands in tmux sessions.
 *
 * Tools: schedule_job, schedule_reminder, schedule_tool, schedule_wakeup, schedule_list,
 *        schedule_cancel, schedule_pause, schedule_resume, schedule_history
 */

import type { SchedulerManager } from "../../scheduler/manager";
import type { ToolPlugin, ToolRegistration } from "../tools/plugin";

interface SchedulerPluginConfig {
  scheduler: SchedulerManager;
  channel: string;
  agentId: string;
}

export function createSchedulerToolPlugin(config: SchedulerPluginConfig): ToolPlugin {
  const { scheduler, channel, agentId } = config;

  return {
    name: "scheduler",

    getTools(): ToolRegistration[] {
      return [
        {
          name: "schedule_job",
          description:
            "Schedule a job to run at a specific time or recurring interval. The job runs as a separate agent that posts results to this channel. " +
            'Schedule formats: "in 5 minutes", "every 2 hours", cron "0 9 * * *" (UTC), ISO 8601 "2024-12-25T10:00:00Z".',
          parameters: {
            title: { type: "string", description: "Short descriptive title for the job (max 200 chars)" },
            prompt: { type: "string", description: "The task prompt for the job agent to execute (max 10000 chars)" },
            schedule: {
              type: "string",
              description: 'When to run: "in 5 minutes", "every 2 hours", cron "0 9 * * *", or ISO 8601',
            },
            max_runs: {
              type: "number",
              description: "Maximum number of runs before auto-completing (optional, for recurring jobs)",
            },
            timeout_seconds: {
              type: "number",
              description: "Max execution time per run in seconds (default: 300, max: 3600)",
            },
          },
          required: ["title", "prompt", "schedule"],
          handler: async (args) => {
            const { title, prompt, schedule, max_runs, timeout_seconds } = args;
            const parsedMaxRuns = max_runs !== undefined ? Number(max_runs) : undefined;
            const parsedTimeout = timeout_seconds !== undefined ? Number(timeout_seconds) : undefined;
            if (
              parsedMaxRuns !== undefined &&
              (!Number.isFinite(parsedMaxRuns) || parsedMaxRuns <= 0 || !Number.isInteger(parsedMaxRuns))
            ) {
              return { success: false, output: "", error: "max_runs must be a positive integer" };
            }
            if (parsedTimeout !== undefined && (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0)) {
              return { success: false, output: "", error: "timeout_seconds must be a positive number" };
            }
            const result = scheduler.createJobFromTool({
              channel,
              agentId,
              title: String(title),
              prompt: String(prompt),
              schedule: String(schedule),
              maxRuns: parsedMaxRuns,
              timeoutSeconds: parsedTimeout,
            });
            if (!result.success) return { success: false, output: "", error: result.error! };
            const job = result.job!;
            return {
              success: true,
              output: `✅ Scheduled job "${job.title}" (ID: ${job.id})\nType: ${job.type}\nNext run: ${new Date(job.next_run).toISOString()}${job.max_runs ? `\nMax runs: ${job.max_runs}` : ""}`,
            };
          },
        },
        {
          name: "schedule_reminder",
          description:
            "Schedule a simple reminder message. Unlike jobs, reminders just post a message — no agent is spawned. " +
            'Schedule formats: "in 30 minutes", "every day", cron "0 9 * * 1" (UTC), ISO 8601.',
          parameters: {
            title: { type: "string", description: "Short title for the reminder (max 200 chars)" },
            message: { type: "string", description: "The reminder message to post (max 5000 chars)" },
            schedule: {
              type: "string",
              description: 'When to fire: "in 30 minutes", "every day", cron expression, or ISO 8601',
            },
            max_runs: {
              type: "number",
              description: "Maximum number of times to fire (optional, for recurring reminders)",
            },
          },
          required: ["title", "message", "schedule"],
          handler: async (args) => {
            const { title, message, schedule, max_runs } = args;
            const parsedMaxRuns = max_runs !== undefined ? Number(max_runs) : undefined;
            if (
              parsedMaxRuns !== undefined &&
              (!Number.isFinite(parsedMaxRuns) || parsedMaxRuns <= 0 || !Number.isInteger(parsedMaxRuns))
            ) {
              return { success: false, output: "", error: "max_runs must be a positive integer" };
            }
            const result = scheduler.createJobFromTool({
              channel,
              agentId,
              title: String(title),
              prompt: String(message),
              schedule: String(schedule),
              maxRuns: parsedMaxRuns,
              isReminder: true,
            });
            if (!result.success) return { success: false, output: "", error: result.error! };
            const job = result.job!;
            return {
              success: true,
              output: `🔔 Reminder set: "${job.title}" (ID: ${job.id})\nWill fire at: ${new Date(job.next_run).toISOString()}${job.max_runs ? `\nMax fires: ${job.max_runs}` : ""}`,
            };
          },
        },
        {
          name: "schedule_tool",
          description:
            "Schedule a tool call to run at a specific time or recurring interval. The tool is executed directly by the scheduler (no agent spawned). " +
            "Results appear as a status card in the channel. " +
            'Schedule formats: "in 5 minutes", "every 2 hours", cron "0 9 * * *" (UTC), ISO 8601 "2024-12-25T10:00:00Z".',
          parameters: {
            tool_name: { type: "string", description: "Name of the tool to execute (e.g. exec_command, read_file)" },
            tool_args: {
              type: "object",
              description: "Arguments to pass to the tool (JSON object)",
            },
            description: {
              type: "string",
              description: "Short description of what this scheduled tool call does (max 200 chars)",
            },
            schedule: {
              type: "string",
              description: 'When to run: "in 5 minutes", "every 2 hours", cron "0 9 * * *", or ISO 8601',
            },
            max_runs: {
              type: "number",
              description: "Maximum number of runs before auto-completing (optional, for recurring tool calls)",
            },
            timeout_seconds: {
              type: "number",
              description: "Max execution time per run in seconds (default: 300, max: 3600)",
            },
          },
          required: ["tool_name", "tool_args", "description", "schedule"],
          handler: async (args) => {
            const { tool_name, tool_args, description, schedule, max_runs, timeout_seconds } = args;
            const parsedMaxRuns = max_runs !== undefined ? Number(max_runs) : undefined;
            const parsedTimeout = timeout_seconds !== undefined ? Number(timeout_seconds) : undefined;
            if (
              parsedMaxRuns !== undefined &&
              (!Number.isFinite(parsedMaxRuns) || parsedMaxRuns <= 0 || !Number.isInteger(parsedMaxRuns))
            ) {
              return { success: false, output: "", error: "max_runs must be a positive integer" };
            }
            if (parsedTimeout !== undefined && (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0)) {
              return { success: false, output: "", error: "timeout_seconds must be a positive number" };
            }
            const result = scheduler.createJobFromTool({
              channel,
              agentId,
              title: String(description).slice(0, 200),
              prompt: String(description),
              schedule: String(schedule),
              maxRuns: parsedMaxRuns,
              timeoutSeconds: parsedTimeout,
              isToolCall: true,
              toolName: String(tool_name),
              toolArgs: typeof tool_args === "object" ? tool_args : {},
            });
            if (!result.success) return { success: false, output: "", error: result.error! };
            const job = result.job!;
            return {
              success: true,
              output: `🔧 Scheduled tool call "${job.title}" (ID: ${job.id})\nTool: ${tool_name}\nNext run: ${new Date(job.next_run).toISOString()}${job.max_runs ? `\nMax runs: ${job.max_runs}` : ""}`,
            };
          },
        },
        {
          name: "schedule_wakeup",
          description:
            "Schedule a wakeup heartbeat to be injected into THIS agent's loop at a future time. " +
            "When the wakeup fires, the agent receives a synthetic [HEARTBEAT] turn (with the given reason in context) — " +
            "useful for self-pacing long-running tasks, periodic check-ins, or resuming after a planned pause. " +
            "If the agent is sleeping when the wakeup fires, it is woken up. If the agent is mid-turn, the heartbeat is dropped (no queueing). " +
            'Schedule formats: "in 5 minutes", "every 1 hour", cron "0 9 * * *" (UTC), ISO 8601.',
          parameters: {
            reason: {
              type: "string",
              description:
                "Why you want to wake up — appears in the heartbeat payload as context. Capped at 200 chars (truncated if longer); same text used as both title and heartbeat reason.",
            },
            schedule: {
              type: "string",
              description: 'When to wake: "in 5 minutes", "every 1 hour", cron "0 9 * * *", or ISO 8601',
            },
            max_runs: {
              type: "number",
              description: "Maximum number of wake-ups before auto-completing (optional, for recurring wakeups)",
            },
          },
          required: ["reason", "schedule"],
          handler: async (args) => {
            const { reason, schedule, max_runs } = args;
            const parsedMaxRuns = max_runs !== undefined ? Number(max_runs) : undefined;
            if (
              parsedMaxRuns !== undefined &&
              (!Number.isFinite(parsedMaxRuns) || parsedMaxRuns <= 0 || !Number.isInteger(parsedMaxRuns))
            ) {
              return { success: false, output: "", error: "max_runs must be a positive integer" };
            }
            // Strip wrapper-breaking substrings — reason flows into the LLM heartbeat
            // turn inside <agent_signal>...</agent_signal>, alongside <system-reminder>
            // blocks parsed in agent.ts. Iterate until stable so nested splits like
            // "<<agent_signal>/agent_signal>" don't leave a trailing tag after one pass.
            let curr = String(reason);
            let prev: string;
            do {
              prev = curr;
              curr = curr.replace(/<\/?agent_signal>/gi, "").replace(/<\/?system-reminder>/gi, "");
            } while (curr !== prev);
            const reasonText = curr.slice(0, 200);
            const result = scheduler.createJobFromTool({
              channel,
              agentId,
              title: reasonText,
              prompt: reasonText,
              schedule: String(schedule),
              maxRuns: parsedMaxRuns,
              isWakeup: true,
            });
            if (!result.success) return { success: false, output: "", error: result.error! };
            const job = result.job!;
            return {
              success: true,
              output: `⏰ Wakeup scheduled "${job.title}" (ID: ${job.id})\nNext wake: ${new Date(job.next_run).toISOString()}${job.max_runs ? `\nMax wakeups: ${job.max_runs}` : ""}`,
            };
          },
        },
        {
          name: "schedule_list",
          description:
            "List recurring scheduled jobs/reminders in this channel (NOT background jobs — use job_status for those). " +
            "Filter by status: active, paused, completed, failed, cancelled.",
          parameters: {
            status: {
              type: "string",
              description:
                'Filter by status (default: "active"). Options: active, paused, completed, failed, cancelled',
            },
          },
          required: [],
          handler: async (args) => {
            const status = args.status ? String(args.status) : undefined;
            const jobs = scheduler.listJobsForChannel(channel, status);
            if (jobs.length === 0)
              return { success: true, output: `No ${status || "active"} schedules in this channel.` };
            const lines = jobs.map((j) => {
              const nextRun = j.status === "active" ? new Date(j.next_run).toISOString() : "—";
              const runs = j.max_runs ? `${j.run_count}/${j.max_runs}` : String(j.run_count);
              return `• **${j.title}** (ID: ${j.id})\n  Type: ${j.type} | Status: ${j.status} | Next: ${nextRun} | Runs: ${runs}`;
            });
            return {
              success: true,
              output: `${status || "Active"} schedules (${jobs.length}):\n\n${lines.join("\n\n")}`,
            };
          },
        },
        {
          name: "schedule_cancel",
          description:
            "Cancel a recurring scheduled job/reminder by its full schedule ID (from schedule_list). " +
            "This does NOT cancel background jobs — use job_cancel for those.",
          parameters: {
            id: { type: "string", description: "The full schedule ID (from schedule_list output)" },
          },
          required: ["id"],
          handler: async (args) => {
            const result = scheduler.cancelJobFromTool(String(args.id), agentId, channel);
            if (!result.success) return { success: false, output: "", error: result.error! };
            return { success: true, output: `❌ Cancelled schedule: "${result.title}"` };
          },
        },
        {
          name: "schedule_pause",
          description:
            "Pause an active recurring scheduled job/reminder. It can be resumed later with schedule_resume.",
          parameters: {
            id: { type: "string", description: "The full schedule ID (from schedule_list output)" },
          },
          required: ["id"],
          handler: async (args) => {
            const result = scheduler.pauseJobFromTool(String(args.id), agentId, channel);
            if (!result.success) return { success: false, output: "", error: result.error! };
            return { success: true, output: `⏸️ Paused schedule: "${result.title}"` };
          },
        },
        {
          name: "schedule_resume",
          description: "Resume a paused recurring scheduled job/reminder.",
          parameters: {
            id: { type: "string", description: "The full schedule ID (from schedule_list output)" },
          },
          required: ["id"],
          handler: async (args) => {
            const result = scheduler.resumeJobFromTool(String(args.id), agentId, channel);
            if (!result.success) return { success: false, output: "", error: result.error! };
            return { success: true, output: `▶️ Resumed schedule: "${result.title}"` };
          },
        },
        {
          name: "schedule_history",
          description: "View past run history for a recurring scheduled job, including status, duration, and errors.",
          parameters: {
            id: { type: "string", description: "The full schedule ID (from schedule_list output)" },
            limit: { type: "number", description: "Number of recent runs to show (default: 10, max: 50)" },
          },
          required: ["id"],
          handler: async (args) => {
            const limit = Math.min(args.limit ? Number(args.limit) : 10, 50);
            const runs = scheduler.getJobRunsForTool(String(args.id), limit, channel);
            if (runs.length === 0) return { success: true, output: "No run history found for this schedule." };
            const lines = runs.map((r, i) => {
              const started = new Date(r.started_at).toISOString();
              const duration = r.completed_at ? `${((r.completed_at - r.started_at) / 1000).toFixed(1)}s` : "running";
              const status =
                r.status === "success" ? "✅" : r.status === "error" ? "❌" : r.status === "timeout" ? "⏰" : "🔄";
              const error = r.error_message ? ` — ${r.error_message.slice(0, 100)}` : "";
              return `${i + 1}. ${status} ${started} (${duration})${error}`;
            });
            return { success: true, output: `Run history (last ${runs.length}):\n\n${lines.join("\n")}` };
          },
        },
      ];
    },
  };
}
