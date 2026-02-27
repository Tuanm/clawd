/**
 * Spawn Agent Plugin — overrides spawn_agent to route through the sub-space system.
 *
 * Sub-agents respond directly to the parent chat channel via respond_to_parent,
 * so no wait/poll/report tools are needed — the parent sees results in chat.
 */

import type { ToolPlugin, ToolRegistration } from "../agent/src/tools/plugin";
import type { ToolResult } from "../agent/src/tools/tools";
import type { SpaceManager } from "./manager";
import type { SpaceWorkerManager } from "./worker";

// Fetch with timeout to prevent hangs on self-calls
function timedFetch(url: string, options: RequestInit = {}, ms = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
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
      ];
    },
  };

  async function handleSpawnAgent(args: Record<string, any>): Promise<ToolResult> {
    const task = args.task as string;
    const name = (args.name as string) || `sub-${Date.now()}`;

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

      // 2. Post preview card to main channel (use main agent ID as author)
      const cardRes = await timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
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
      });
      if (cardRes.ok) {
        const cardData = (await cardRes.json()) as any;
        if (cardData.ts) spaceManager.updateCardTs(space.id, cardData.ts);
      }

      // 3. Post task to space channel (use main agent ID so it shows correct avatar;
      //    worker picks it up because agent_id !== worker's own agentId)
      const taskRes = await timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: space.space_channel,
          text: `📋 **Task:** ${task}`,
          user: "UBOT",
          agent_id: config.agentId,
        }),
      });
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
          const emoji = isTimeout ? "⏰" : "❌";
          timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel: config.channel,
              text: `${emoji} Sub-space ${isTimeout ? "timed out" : "failed"}: ${sanitizedTitle}`,
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
      return { success: false, output: "", error: err.message };
    }
  }
}
