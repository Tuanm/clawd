/**
 * Scheduler Runner — executes scheduled jobs and reminders
 */
import { Agent, type AgentConfig } from "../agent/src/agent/agent";
import { createProvider } from "../agent/src/api/factory";
import { createClawdChatPlugin, createClawdChatToolPlugin, type ClawdChatConfig } from "../agent/plugins/clawd-chat";
import type { ScheduledJob } from "./db";
import type { SchedulerManager } from "./manager";
import type { AppConfig } from "../config";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const SESSION_DIR = join(homedir(), ".clawd", "sessions");

interface RunnerConfig {
  appConfig: AppConfig;
  scheduler: SchedulerManager;
  getAgentConfig: (channel: string) => Promise<{ provider: string; model: string; agentId: string } | null>;
}

/**
 * Initialize the runner — sets job+reminder executors on the SchedulerManager
 */
export function initRunner(config: RunnerConfig): void {
  const { appConfig, scheduler, getAgentConfig } = config;

  // Reminder executor: just post a message
  scheduler.setReminderExecutor(async (job: ScheduledJob) => {
    const agentConfig = await getAgentConfig(job.channel);
    if (!agentConfig) throw new Error(`No agent configured for channel ${job.channel}`);

    const safeTitle = job.title.replace(/[\n\r]/g, " ").trim();
    const text = `🔔 **Reminder: ${safeTitle}**\n${job.prompt}`;
    await postToChannel(appConfig.chatApiUrl, job.channel, text, agentConfig.agentId);
  });

  // Job executor: spawn one-shot agent
  scheduler.setJobExecutor(async (job: ScheduledJob, runId: string, controller: AbortController) => {
    const agentConfig = await getAgentConfig(job.channel);
    if (!agentConfig) throw new Error(`No agent configured for channel ${job.channel}`);

    const sessionName = `scheduler-${job.id}-${runId}`;
    const provider = createProvider(agentConfig.provider);

    const sanitizedTitle = job.title.replace(/[\n\r]/g, " ").trim();
    const agentCfg: AgentConfig = {
      model: agentConfig.model,
      maxTurns: 20,
      systemPrompt: `You are executing a scheduled job for channel #${job.channel}.\nTitle: ${sanitizedTitle}\n\nPost your findings to the channel. Be concise.`,
      projectRoot: appConfig.projectRoot,
    };

    const agent = new Agent(provider, agentCfg);

    // Register clawd-chat plugin (isWorker=true, NO scheduler tools — S6)
    const chatConfig: ClawdChatConfig = {
      apiUrl: appConfig.chatApiUrl,
      channel: job.channel,
      agentId: agentConfig.agentId,
      isWorker: true,
    };

    await agent.usePlugin({
      plugin: createClawdChatPlugin(chatConfig),
      toolPlugin: createClawdChatToolPlugin(chatConfig),
    });

    // Handle abort
    const abortHandler = () => {
      agent.close().catch(() => {});
    };
    controller.signal.addEventListener("abort", abortHandler, { once: true });

    let output: string | undefined;
    try {
      // Post start notification
      await postToChannel(
        appConfig.chatApiUrl,
        job.channel,
        `📋 **Scheduled Job: ${sanitizedTitle}** (running...)`,
        agentConfig.agentId,
      );

      const result = await agent.run(job.prompt, sessionName);
      output = result.content;

      // Only treat as timeout if agent didn't complete successfully
      // If agent.run() resolved, the job succeeded regardless of abort state
    } catch (err: any) {
      if (controller.signal.aborted) {
        await postToChannel(
          appConfig.chatApiUrl,
          job.channel,
          `⏰ **Job Timed Out: ${sanitizedTitle}**\nExceeded ${job.timeout_seconds || 300}s limit.`,
          agentConfig.agentId,
        ).catch(() => {});
      } else {
        await postToChannel(
          appConfig.chatApiUrl,
          job.channel,
          `⚠️ **Scheduled Job Failed: ${sanitizedTitle}**\nError: ${err.message}`,
          agentConfig.agentId,
        ).catch(() => {});
      }
      throw err;
    } finally {
      controller.signal.removeEventListener("abort", abortHandler);
      await agent.close().catch(() => {});
      // S18: Clean up session directory
      cleanupSession(sessionName);
    }

    return output;
  });
}

async function postToChannel(apiUrl: string, channel: string, text: string, agentId: string): Promise<void> {
  const res = await fetch(`${apiUrl}/api/chat.postMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel,
      text,
      user: "UWORKER-SCHEDULER",
      agent_id: agentId,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to post message: ${res.status}`);
  }
}

function cleanupSession(sessionName: string): void {
  const sessionPath = join(SESSION_DIR, sessionName);
  try {
    if (existsSync(sessionPath)) {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[Scheduler] Failed to cleanup session ${sessionName}:`, err);
  }
}
