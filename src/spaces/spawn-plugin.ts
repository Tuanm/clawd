/**
 * Spawn Agent Plugin — overrides spawn_agent/wait_for_agents/get_agent_report
 * to route through the sub-space system instead of tmux sessions.
 *
 * Registers tools with same names as local tools. Plugin tools take execution
 * priority over local tools (agent checks hasPluginTool before local).
 */

import type { ToolPlugin, ToolRegistration } from "../agent/src/tools/plugin";
import type { ToolResult } from "../agent/src/tools/tools";
import type { SpaceManager } from "./manager";
import type { SpaceWorkerManager } from "./worker";

export interface SpawnPluginConfig {
  /** Parent channel where the main agent operates */
  channel: string;
  /** Agent ID of the main agent */
  agentId: string;
  /** Chat API URL */
  apiUrl: string;
  /** Agent color for space cards */
  agentColor: string;
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
  getAgentConfig: (channel: string) => Promise<{ provider: string; model: string; agentId: string; project?: string } | null>,
  trackedSpaces: Map<string, TrackedSpace>,
): ToolPlugin {

  return {
    name: "spawn-agent-spaces",

    getTools(): ToolRegistration[] {
      // Register tools with same names as local tools — execution routes here
      // via hasPluginTool check (plugin > local in execution priority).
      // Tool definitions are deduped by getTools() so LLM sees local descriptions.
      return [
        {
          name: "spawn_agent",
          description: "Spawn a sub-agent in a sub-space",
          parameters: {
            task: { type: "string", description: "The task for the sub-agent" },
            name: { type: "string", description: "Optional friendly name" },
          },
          required: ["task"],
          handler: async (args) => handleSpawnAgent(args),
        },
        {
          name: "list_agents",
          description: "List all spawned sub-agents and their status",
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
          name: "get_agent_result",
          description: "Get status/result of a sub-agent by ID",
          parameters: {
            agent_id: { type: "string", description: "Sub-agent ID" },
          },
          required: ["agent_id"],
          handler: async (args) => {
            const res = await handleGetAgentReport(args);
            if (!res) {
              return { success: false, output: "", error: "Unknown agent ID — not space-tracked" };
            }
            return res;
          },
        },
        {
          name: "get_agent_report",
          description: "Get the result report of a sub-agent",
          parameters: {
            agent_id: { type: "string", description: "Sub-agent ID" },
          },
          required: ["agent_id"],
          handler: async (args) => {
            const res = await handleGetAgentReport(args);
            if (!res) {
              return { success: false, output: "", error: "Unknown agent ID — not space-tracked" };
            }
            return res;
          },
        },
        {
          name: "wait_for_agents",
          description: "Wait for sub-agents to complete",
          parameters: {
            agent_ids: { type: "array", items: { type: "string" }, description: "Agent IDs to wait for" },
            mode: { type: "string", description: '"all" or "any"' },
            timeout_ms: { type: "number", description: "Timeout in milliseconds" },
          },
          required: ["agent_ids"],
          handler: async (args) => {
            const res = await handleWaitForAgents(args);
            if (!res) {
              return { success: false, output: "", error: "Unknown agent IDs — not space-tracked" };
            }
            return res;
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
      const sanitizedTitle = name.replace(/[\n\r]/g, " ").trim().slice(0, 100);

      // 1. Create space
      const space = spaceManager.createSpace({
        id: spaceId,
        channel: config.channel,
        title: sanitizedTitle,
        description: task.slice(0, 500),
        agent_id: agentConfig.agentId,
        agent_color: config.agentColor,
        source: "spawn_agent",
        timeout_seconds: 600,
      });

      // 2. Post preview card to main channel
      const cardRes = await fetch(`${config.apiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: config.channel,
          text: `🔄 **Sub-space: ${sanitizedTitle}**`,
          user: `UWORKER-${config.agentId}`,
          agent_id: agentConfig.agentId,
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

      // 3. Post task to space channel
      const taskRes = await fetch(`${config.apiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: space.space_channel,
          text: `📋 **Task:** ${task}`,
          user: `UWORKER-${config.agentId}`,
          agent_id: agentConfig.agentId,
        }),
      });
      if (!taskRes.ok) {
        spaceManager.failSpace(space.id, "Failed to post task to space channel");
        return { success: false, output: "", error: "Failed to post task to space channel" };
      }

      // 4. Start space worker
      let completionPromise: Promise<string>;
      try {
        completionPromise = spaceWorkerManager.startSpaceWorker(space, agentConfig);
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
          fetch(`${config.apiUrl}/api/chat.postMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel: config.channel,
              text: `${emoji} Sub-space ${isTimeout ? "timed out" : "failed"}: ${sanitizedTitle}`,
              user: `UWORKER-${config.agentId}`,
              agent_id: agentConfig.agentId,
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
          message: "Sub-agent started in a sub-space. Use wait_for_agents to wait for completion.",
        }),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  async function handleWaitForAgents(args: Record<string, any>): Promise<ToolResult | null> {
    const agentIds = args.agent_ids as string[];
    const mode = (args.mode as string) || "all";
    const timeoutMs = (args.timeout_ms as number) || 600000;

    if (!agentIds || !Array.isArray(agentIds) || agentIds.length === 0) {
      return { success: false, output: "", error: "Missing required parameter: agent_ids (array)" };
    }

    // Check if IDs are tracked in-memory or exist as spaces in DB
    const allKnown = agentIds.every((id) => trackedSpaces.has(id) || spaceManager.getSpace(id));
    if (!allKnown) return null;

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const statuses = agentIds.map((id) => getAgentStatus(id));
      const completed = statuses.filter((s) => s.status !== "running" && s.status !== "active");

      if (mode === "any" && completed.length > 0) {
        return {
          success: true,
          output: JSON.stringify({ mode, completed: completed.length, total: agentIds.length, agents: statuses }, null, 2),
        };
      }

      if (mode === "all" && completed.length === agentIds.length) {
        return {
          success: true,
          output: JSON.stringify({ mode, completed: completed.length, total: agentIds.length, agents: statuses }, null, 2),
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const finalStatuses = agentIds.map((id) => getAgentStatus(id));

    return {
      success: false,
      output: JSON.stringify({ mode, error: "timeout", agents: finalStatuses }, null, 2),
      error: "Timed out waiting for agents",
    };
  }

  function getAgentStatus(id: string) {
    const tracked = trackedSpaces.get(id);
    if (tracked) {
      return {
        id,
        name: tracked.name,
        status: tracked.status,
        result: tracked.result,
        error: tracked.error,
        duration_ms: Date.now() - tracked.startedAt,
      };
    }
    // Fallback to DB for spaces from previous sessions
    const space = spaceManager.getSpace(id);
    if (space) {
      return {
        id,
        name: space.title,
        status: space.status,
        result: space.result_summary,
        duration_ms: 0,
      };
    }
    return { id, status: "not_found" };
  }

  async function handleGetAgentReport(args: Record<string, any>): Promise<ToolResult | null> {
    const agentId = args.agent_id as string;

    if (!agentId) {
      return { success: false, output: "", error: "Missing required parameter: agent_id" };
    }

    const tracked = trackedSpaces.get(agentId);
    if (tracked) {
      const space = spaceManager.getSpace(tracked.spaceId);
      return {
        success: true,
        output: JSON.stringify({
          agent_id: tracked.spaceId,
          name: tracked.name,
          status: tracked.status,
          result: tracked.result || space?.result_summary,
          error: tracked.error,
          duration_ms: Date.now() - tracked.startedAt,
          space_status: space?.status,
        }),
      };
    }

    // Fallback to DB for spaces from previous sessions
    const space = spaceManager.getSpace(agentId);
    if (space) {
      const isFailed = space.status === "failed" || space.status === "timed_out";
      return {
        success: true,
        output: JSON.stringify({
          agent_id: space.id,
          name: space.title,
          status: space.status,
          result: isFailed ? undefined : space.result_summary,
          error: isFailed ? space.result_summary : undefined,
          space_status: space.status,
        }),
      };
    }

    return null;
  }
}
