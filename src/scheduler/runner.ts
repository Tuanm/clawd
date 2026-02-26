/**
 * Scheduler Runner — executes scheduled jobs and reminders
 */
import type { ScheduledJob } from "./db";
import type { SchedulerManager } from "./manager";
import type { AppConfig } from "../config";
import type { SpaceManager } from "../spaces/manager";
import type { SpaceWorkerManager } from "../spaces/worker";

interface RunnerConfig {
  appConfig: AppConfig;
  scheduler: SchedulerManager;
  spaceManager: SpaceManager;
  spaceWorkerManager: SpaceWorkerManager;
  getAgentConfig: (
    channel: string,
  ) => Promise<{ provider: string; model: string; agentId: string; project?: string } | null>;
}

/**
 * Initialize the runner — sets job+reminder executors on the SchedulerManager
 */
export function initRunner(config: RunnerConfig): void {
  const { appConfig, scheduler, spaceManager, spaceWorkerManager, getAgentConfig } = config;

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
    });
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
}

async function postToChannel(apiUrl: string, channel: string, text: string, agentId: string): Promise<void> {
  const res = await fetch(`${apiUrl}/api/chat.postMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel,
      text,
      user: "UBOT",
      agent_id: agentId,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to post message: ${res.status}`);
  }
}
