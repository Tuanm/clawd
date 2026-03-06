/**
 * Scheduler Runner — executes scheduled jobs, reminders, and tool calls
 */
import type { ScheduledJob } from "./db";
import type { SchedulerManager } from "./manager";
import type { AppConfig } from "../config";
import type { SpaceManager } from "../spaces/manager";
import type { SpaceWorkerManager } from "../spaces/worker";

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

interface RunnerConfig {
  appConfig: AppConfig;
  scheduler: SchedulerManager;
  spaceManager: SpaceManager;
  spaceWorkerManager: SpaceWorkerManager;
  getAgentConfig: (
    channel: string,
  ) => Promise<{ provider: string; model: string; agentId: string; project?: string } | null>;
  executeToolFn?: (toolName: string, args: Record<string, any>, channel: string) => Promise<ToolResult>;
}

/**
 * Initialize the runner — sets job+reminder executors on the SchedulerManager
 */
export function initRunner(config: RunnerConfig): void {
  const { appConfig, scheduler, spaceManager, spaceWorkerManager, getAgentConfig, executeToolFn } = config;

  // Reminder executor: just post a message (unchanged — no space needed)
  scheduler.setReminderExecutor(async (job: ScheduledJob) => {
    const agentConfig = await getAgentConfig(job.channel);
    if (!agentConfig) throw new Error(`No agent configured for channel ${job.channel}`);

    await postToChannel(appConfig.chatApiUrl, job.channel, job.prompt, "Cron");
  });

  // Job executor: create a sub-space with its own worker loop
  scheduler.setJobExecutor(async (job: ScheduledJob, _runId: string, controller: AbortController) => {
    const agentConfig = await getAgentConfig(job.channel);
    if (!agentConfig) throw new Error(`No agent configured for channel ${job.channel}`);

    const sanitizedTitle = job.title.replace(/[\n\r]/g, " ").trim();
    const spaceId = crypto.randomUUID();

    // 1. Create space (transactional: space + channel + agent)
    const space = spaceManager.createSpace({
      id: spaceId,
      channel: job.channel,
      title: sanitizedTitle,
      description: job.prompt,
      agent_id: agentConfig.agentId,
      agent_color: "#6366f1",
      source: "scheduler",
      source_id: job.id,
      timeout_seconds: job.timeout_seconds || 300,
    });

    // 2. Post preview card to main channel
    const cardCtrl = new AbortController();
    const cardTimer = setTimeout(() => cardCtrl.abort(), 10000);
    const cardRes = await fetch(`${appConfig.chatApiUrl}/api/chat.postMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: job.channel,
        text: `🔄 **Sub-space: ${sanitizedTitle}**`,
        user: "UBOT",
        agent_id: "Cron",
        subtype: "subspace",
        subspace_json: JSON.stringify({
          id: space.id,
          title: space.title,
          description: space.description,
          agent_id: space.agent_id,
          agent_color: space.agent_color,
          status: space.status,
          channel: space.channel,
        }),
      }),
      signal: cardCtrl.signal,
    }).finally(() => clearTimeout(cardTimer));
    if (cardRes.ok) {
      const cardData = (await cardRes.json()) as any;
      if (cardData.ts) spaceManager.updateCardTs(space.id, cardData.ts);
    }

    // 3. Post initial task to space channel
    await postToChannel(appConfig.chatApiUrl, space.space_channel, `📋 **Task:** ${job.prompt}`, "Cron");

    // 4. Start space worker — returns promise that resolves when complete_space is called
    const completionPromise = spaceWorkerManager.startSpaceWorker(space, agentConfig);

    // 5. Abort handler
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const reason = controller.signal.reason;
      const isTimeout = reason === "timeout";
      const emoji = isTimeout ? "⏰" : "❌";
      const status = isTimeout ? "timed_out" : "failed";
      const won = isTimeout ? spaceManager.timeoutSpace(space.id) : spaceManager.failSpace(space.id, String(reason));
      if (won) {
        postToChannel(appConfig.chatApiUrl, job.channel, `${emoji} Space ${status}: ${sanitizedTitle}`, "Cron").catch(
          () => {},
        );
      }
      spaceWorkerManager.stopSpaceWorker(space.id);
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();

    try {
      const summary = await completionPromise;
      settled = true;
      return summary;
    } catch (err) {
      if (!settled) {
        settled = true;
        const won = spaceManager.failSpace(space.id, (err as Error).message);
        if (won) {
          postToChannel(appConfig.chatApiUrl, job.channel, `❌ Space failed: ${sanitizedTitle}`, "Cron").catch(
            () => {},
          );
        }
        spaceWorkerManager.stopSpaceWorker(space.id);
      }
      throw err;
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      spaceWorkerManager.stopSpaceWorker(space.id); // idempotent
    }
  });

  // Tool call executor: execute a tool directly and post result card
  if (executeToolFn) {
    scheduler.setToolCallExecutor(async (job: ScheduledJob, _runId: string, controller: AbortController) => {
      const toolName = job.tool_name;
      if (!toolName) throw new Error("No tool_name set on tool_call job");

      const toolArgs = job.tool_args_json ? JSON.parse(job.tool_args_json) : {};
      const description = job.prompt || job.title;

      // Post "running" card
      const cardTs = await postToolResultCard(appConfig.chatApiUrl, job.channel, {
        tool_name: toolName,
        description,
        status: "running",
        args: toolArgs,
        job_id: job.id,
      });

      let result: ToolResult;
      try {
        if (controller.signal.aborted) throw new Error("Aborted before execution");
        result = await executeToolFn(toolName, toolArgs, job.channel);
      } catch (err: any) {
        // Update card to failed
        if (cardTs) {
          await updateToolResultCard(appConfig.chatApiUrl, job.channel, cardTs, {
            tool_name: toolName,
            description,
            status: "failed",
            args: toolArgs,
            error: err.message || String(err),
            job_id: job.id,
          });
        }
        throw err;
      }

      // Update card to final status
      const finalStatus = result.success ? "succeeded" : "failed";
      if (cardTs) {
        await updateToolResultCard(appConfig.chatApiUrl, job.channel, cardTs, {
          tool_name: toolName,
          description,
          status: finalStatus,
          args: toolArgs,
          result: result.output || undefined,
          error: result.error || undefined,
          job_id: job.id,
        });
      }

      if (!result.success) throw new Error(result.error || "Tool execution failed");
      return result.output?.slice(0, 500);
    });
  }
}

async function postToChannel(apiUrl: string, channel: string, text: string, agentId: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  const res = await fetch(`${apiUrl}/api/chat.postMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel,
      text,
      user: "UBOT",
      agent_id: agentId,
    }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) {
    throw new Error(`Failed to post message: ${res.status}`);
  }
}

interface ToolResultCard {
  tool_name: string;
  description: string;
  status: "running" | "succeeded" | "failed";
  args: Record<string, any>;
  result?: any;
  error?: string;
  job_id?: string;
}

async function postToolResultCard(apiUrl: string, channel: string, card: ToolResultCard): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${apiUrl}/api/chat.postMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel,
        text: "",
        user: "UBOT",
        agent_id: "Cron",
        subtype: "tool_result",
        tool_result_json: JSON.stringify(card),
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (res.ok) {
      const data = (await res.json()) as any;
      return data.ts || null;
    }
  } catch {
    // Best-effort
  }
  return null;
}

async function updateToolResultCard(apiUrl: string, channel: string, ts: string, card: ToolResultCard): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    await fetch(`${apiUrl}/api/chat.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel,
        ts,
        text: "",
        tool_result_json: JSON.stringify(card),
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
  } catch {
    // Best-effort
  }
}
