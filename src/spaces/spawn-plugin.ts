/**
 * Spawn Agent Plugin — overrides spawn_agent to route through the sub-space system.
 *
 * Sub-agents respond directly to the parent chat channel via respond_to_parent,
 * so no wait/poll/report tools are needed — the parent sees results in chat.
 */

import type { ToolPlugin, ToolRegistration } from "../agent/src/tools/plugin";
import type { ToolResult } from "../agent/src/tools/tools";
import { timedFetch } from "../utils/timed-fetch";
import type { SpaceManager } from "./manager";
import type { SpaceWorkerManager } from "./worker";

/** Surrogate-safe string slice — avoids cutting UTF-16 surrogate pairs */
function surrogateSlice(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  let cut = maxLen;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return s.slice(0, cut);
}

export interface SpawnPluginConfig {
  /** Parent channel where the main agent operates */
  channel: string;
  /** Agent ID of the main agent */
  agentId: string;
  /** Chat API URL */
  apiUrl: string;
}

export interface TrackedSpace {
  spaceId: string;
  name: string;
  promise: Promise<string>;
  startedAt: number;
  result?: string;
  error?: string;
  status: "running" | "completed" | "failed";
  evictionTimer?: ReturnType<typeof setTimeout>;
}

export function createSpawnAgentPlugin(
  config: SpawnPluginConfig,
  spaceManager: SpaceManager,
  spaceWorkerManager: SpaceWorkerManager,
  getAgentConfig: (
    channel: string,
  ) => Promise<{ provider: string; model: string; agentId: string; project?: string; avatar_color?: string } | null>,
  trackedSpaces: Map<string, TrackedSpace>,
): ToolPlugin {
  return {
    name: "spawn-agent-spaces",

    getTools(): ToolRegistration[] {
      return [
        {
          name: "spawn_agent",
          description:
            "Spawn a sub-agent in a sub-space to handle a task. The sub-agent will respond directly to this chat channel when done — no need to wait or poll for results.",
          parameters: {
            task: { type: "string", description: "The task for the sub-agent" },
            name: { type: "string", description: "Optional friendly name" },
            context: {
              type: "string",
              description:
                "Optional context to seed the sub-agent with (project structure, file contents, findings). Reduces cold-start time.",
            },
          },
          required: ["task"],
          handler: async (args) => handleSpawnAgent(args),
        },
        {
          name: "list_agents",
          description:
            "List all spawned sub-agents and their current status. Useful to check which agents are running before using kill_agent.",
          parameters: {},
          required: [],
          handler: async () => {
            const agents = Array.from(trackedSpaces.values()).map((t) => ({
              id: t.spaceId,
              name: t.name,
              status: t.status,
              started_at: new Date(t.startedAt).toISOString(),
              duration_ms: Date.now() - t.startedAt,
            }));
            return { success: true, output: JSON.stringify({ count: agents.length, agents }, null, 2) };
          },
        },
        {
          name: "retask_agent",
          description:
            "Re-use a completed sub-agent by resetting it and posting a new follow-up task. Only works on agents with status 'completed'.",
          parameters: {
            agent_id: { type: "string", description: "The ID of the completed sub-agent to retask" },
            task: { type: "string", description: "The new follow-up task to assign" },
          },
          required: ["agent_id", "task"],
          handler: async (args) => handleRetaskAgent(args),
        },
      ];
    },
  };

  async function handleSpawnAgent(args: Record<string, any>): Promise<ToolResult> {
    const task = args.task as string;
    const name = (args.name as string) || `sub-${Date.now()}`;
    const context = (args.context as string) || "";

    if (!task) {
      return { success: false, output: "", error: "Missing required parameter: task" };
    }

    try {
      const agentConfig = await getAgentConfig(config.channel);
      if (!agentConfig) {
        return { success: false, output: "", error: `No agent configured for channel ${config.channel}` };
      }

      const spaceId = crypto.randomUUID();
      const sanitizedTitle = name
        .replace(/[\n\r]/g, " ")
        .trim()
        .slice(0, 100);
      const subAgentId = `Agent-${spaceId.slice(0, 8)}`;

      // 1. Create space (sub-agent registered as non-worker gets proper avatar color)
      const space = spaceManager.createSpace({
        id: spaceId,
        channel: config.channel,
        title: sanitizedTitle,
        description: task.slice(0, 500),
        agent_id: subAgentId,
        agent_color: agentConfig.avatar_color || "#6366f1",
        source: "spawn_agent",
        timeout_seconds: 600,
      });

      // 2+3. Post preview card and task in parallel (no data dependency)
      const [cardRes, taskRes] = await Promise.all([
        // Preview card to main channel
        timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: config.channel,
            text: "",
            user: config.agentId,
            agent_id: config.agentId,
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
        }),
        // Task to space channel
        timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: space.space_channel,
            text: context ? `**Context:**\n${surrogateSlice(context, 4000)}\n\n**Task:** ${task}` : `**Task:** ${task}`,
            user: "UBOT",
            agent_id: config.agentId,
          }),
        }),
      ]);

      if (cardRes.ok) {
        const cardData = (await cardRes.json()) as any;
        if (cardData.ts) spaceManager.updateCardTs(space.id, cardData.ts);
      }
      if (!taskRes.ok) {
        spaceManager.failSpace(space.id, "Failed to post task to space channel");
        return { success: false, output: "", error: "Failed to post task to space channel" };
      }

      // 4. Start space worker (use sub-agent ID so it differs from main agent)
      let completionPromise: Promise<string>;
      try {
        completionPromise = spaceWorkerManager.startSpaceWorker(space, { ...agentConfig, agentId: subAgentId });
      } catch (workerErr: any) {
        // Worker failed to start — mark space as failed and update card
        spaceManager.failSpace(space.id, workerErr.message);
        return { success: false, output: "", error: `Failed to start worker: ${workerErr.message}` };
      }

      // 5. Set up timeout controller
      const timeoutMs = (space.timeout_seconds || 600) * 1000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
      if (typeof timer === "object" && "unref" in timer) (timer as any).unref();
      let settled = false;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        const isTimeout = controller.signal.reason === "timeout";
        const won = isTimeout
          ? spaceManager.timeoutSpace(space.id)
          : spaceManager.failSpace(space.id, String(controller.signal.reason));
        if (won) {
          const prefix = isTimeout ? "Sub-space timed out" : "Sub-space failed";
          timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel: config.channel,
              text: `${prefix}: ${sanitizedTitle}`,
              user: "UWORKER-SUBAGENT",
              agent_id: subAgentId,
            }),
          }).catch(() => {});
        }
        spaceWorkerManager.stopSpaceWorker(space.id);
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });

      // 6. Track the space
      const tracked: TrackedSpace = {
        spaceId,
        name: sanitizedTitle,
        promise: completionPromise,
        startedAt: Date.now(),
        status: "running",
      };

      completionPromise
        .then((summary) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
          }
          tracked.status = "completed";
          tracked.result = summary;
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            // Update DB and card on failure
            spaceManager.failSpace(spaceId, (err as Error).message);
          }
          tracked.status = "failed";
          tracked.error = (err as Error).message;
        })
        .finally(() => {
          controller.signal.removeEventListener("abort", onAbort);
          spaceWorkerManager.stopSpaceWorker(space.id);
          // Kill the sub-agent immediately
          spaceManager.cleanupSpaceAgents(space.id);
          // Evict from memory after 30 minutes (DB fallback still works)
          const evictTimer = setTimeout(() => trackedSpaces.delete(spaceId), 30 * 60 * 1000);
          if (typeof evictTimer === "object" && "unref" in evictTimer) (evictTimer as any).unref();
          // Store so retask_agent can cancel this eviction
          const t = trackedSpaces.get(spaceId);
          if (t) t.evictionTimer = evictTimer;
        });

      trackedSpaces.set(spaceId, tracked);

      return {
        success: true,
        output: JSON.stringify({
          agent_id: spaceId,
          name: sanitizedTitle,
          status: "spawned",
          space_channel: space.space_channel,
          message: "Sub-agent started. It will respond directly to this channel when done.",
        }),
      };
    } catch (err: any) {
      // If a space was created before the error, mark it as failed to prevent orphans
      try {
        const activeSpaces = spaceManager.listSpaces(config.channel, "active");
        const orphan = activeSpaces.find((s) => s.description === task.slice(0, 500));
        if (orphan) spaceManager.failSpace(orphan.id, err.message);
      } catch {
        /* best-effort cleanup */
      }
      return { success: false, output: "", error: err.message };
    }
  }

  async function handleRetaskAgent(args: Record<string, any>): Promise<ToolResult> {
    const agentId = args.agent_id as string;
    const task = args.task as string;

    if (!agentId || !task) {
      return { success: false, output: "", error: "Missing required parameters: agent_id, task" };
    }

    const tracked = trackedSpaces.get(agentId);
    if (!tracked) {
      return { success: false, output: "", error: `No tracked agent with id '${agentId}'` };
    }
    if (tracked.status !== "completed") {
      return {
        success: false,
        output: "",
        error: `Agent '${agentId}' is not completed (status: ${tracked.status}). Can only retask completed agents.`,
      };
    }

    // Cancel the pending eviction so the space stays in memory
    if (tracked.evictionTimer !== undefined) {
      clearTimeout(tracked.evictionTimer);
      tracked.evictionTimer = undefined;
    }

    // Reset the space in DB (only succeeds if status is 'completed')
    const reset = spaceManager.resetSpace(agentId);
    if (!reset) {
      return {
        success: false,
        output: "",
        error: `Failed to reset space '${agentId}' — it may no longer be in 'completed' state`,
      };
    }

    const space = spaceManager.getSpace(agentId);
    if (!space) {
      return { success: false, output: "", error: `Space '${agentId}' not found after reset` };
    }

    try {
      const agentConfig = await getAgentConfig(config.channel);
      if (!agentConfig) {
        return { success: false, output: "", error: `No agent configured for channel ${config.channel}` };
      }

      const subAgentId = `Agent-${agentId.slice(0, 8)}`;

      // Post follow-up task to space channel
      const taskRes = await timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: space.space_channel,
          text: `**Task:** ${task}`,
          user: "UBOT",
          agent_id: config.agentId,
        }),
      });

      if (!taskRes.ok) {
        spaceManager.failSpace(space.id, "Failed to post retask to space channel");
        return { success: false, output: "", error: "Failed to post retask to space channel" };
      }

      // Restart space worker
      let completionPromise: Promise<string>;
      try {
        completionPromise = spaceWorkerManager.startSpaceWorker(space, { ...agentConfig, agentId: subAgentId });
      } catch (workerErr: any) {
        spaceManager.failSpace(space.id, workerErr.message);
        return { success: false, output: "", error: `Failed to start worker: ${workerErr.message}` };
      }

      // Set up timeout controller
      const timeoutMs = (space.timeout_seconds || 600) * 1000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
      if (typeof timer === "object" && "unref" in timer) (timer as any).unref();
      let settled = false;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        const isTimeout = controller.signal.reason === "timeout";
        const won = isTimeout
          ? spaceManager.timeoutSpace(space.id)
          : spaceManager.failSpace(space.id, String(controller.signal.reason));
        if (won) {
          const prefix = isTimeout ? "Sub-space timed out" : "Sub-space failed";
          timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel: config.channel,
              text: `${prefix}: ${tracked.name}`,
              user: "UWORKER-SUBAGENT",
              agent_id: subAgentId,
            }),
          }).catch(() => {});
        }
        spaceWorkerManager.stopSpaceWorker(space.id);
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });

      // Reset tracked entry for the new run
      tracked.promise = completionPromise;
      tracked.startedAt = Date.now();
      tracked.status = "running";
      tracked.result = undefined;
      tracked.error = undefined;

      completionPromise
        .then((summary) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
          }
          tracked.status = "completed";
          tracked.result = summary;
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            spaceManager.failSpace(agentId, (err as Error).message);
          }
          tracked.status = "failed";
          tracked.error = (err as Error).message;
        })
        .finally(() => {
          controller.signal.removeEventListener("abort", onAbort);
          spaceWorkerManager.stopSpaceWorker(space.id);
          spaceManager.cleanupSpaceAgents(space.id);
          const evictTimer = setTimeout(() => trackedSpaces.delete(agentId), 30 * 60 * 1000);
          if (typeof evictTimer === "object" && "unref" in evictTimer) (evictTimer as any).unref();
          const t = trackedSpaces.get(agentId);
          if (t) t.evictionTimer = evictTimer;
        });

      return {
        success: true,
        output: JSON.stringify({
          agent_id: agentId,
          name: tracked.name,
          status: "retasked",
          space_channel: space.space_channel,
          message: "Sub-agent retasked. It will respond directly to this channel when done.",
        }),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }
}
