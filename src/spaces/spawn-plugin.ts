/**
 * Spawn Agent Plugin — overrides spawn_agent to route through the sub-space system.
 *
 * Sub-agents respond directly to the parent chat channel via complete_task,
 * so no wait/poll/report tools are needed — the parent sees results in chat.
 */

import { type AgentFileConfig, listAgentFiles, loadAgentFile, resolveModelAlias } from "../agent/agents/loader";
import { resolveProviderBaseType } from "../agent/api/provider-config";
import type { ToolPlugin, ToolRegistration } from "../agent/tools/plugin";
import type { ToolResult } from "../agent/tools/tools";
import { getOrRegisterAgent } from "../server/database";
import { spaceAuthTokens, spaceCompleteCallbacks, spaceProjectRoots } from "../server/mcp";
import { timedFetch } from "../utils/timed-fetch";
import {
  ClaudeCodeSpaceWorker,
  getClaudeCodeWorker,
  registerClaudeCodeWorker,
  unregisterClaudeCodeWorker,
} from "./claude-code-worker";
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
  /** YOLO mode — bypass sandboxing for sub-agents (default: false) */
  yolo?: boolean;
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
  /** Agent file config used to spawn this space (preserved for retask) */
  agentFileConfig?: AgentFileConfig;
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
  // Cache project root for synchronous access in getTools()
  let _cachedProjectRoot: string | null = null;
  getAgentConfig(config.channel)
    .then((cfg) => {
      if (cfg?.project) _cachedProjectRoot = cfg.project;
    })
    .catch(() => {});

  return {
    name: "spawn-agent-spaces",

    getTools(): ToolRegistration[] {
      return [
        {
          name: "spawn_agent",
          description:
            "Spawn a sub-agent to handle a task asynchronously. The sub-agent works independently — you do NOT need to wait for it. Continue with other work immediately after spawning. The sub-agent will report back via complete_task when done. Use list_agents(type='running') to check status, get_agent_report(agent_id) to read results, or kill_agent(agent_id) to stop it.\n\nChoose the right agent type for the task:\n- agent='general' (DEFAULT) — full access: read, write, edit, bash. Use for implementation, fixes, multi-step tasks.\n- agent='explore' — read-only, fast (haiku model). Use ONLY for search, analysis, code review where no file changes are needed.\n- agent='plan' — read-only research for gathering context before planning.\n\nCustom agents from .clawd/agents/ are also available (use list_agents(type='available') to discover).\n\nIMPORTANT: Sub-agents can ONLY use complete_task to report results — they CANNOT use chat_send_message or other chat tools. Write the task as a self-contained work request. The result will be posted to the channel automatically when the sub-agent calls complete_task.",
          parameters: {
            task: { type: "string", description: "The task for the sub-agent" },
            name: { type: "string", description: "Optional friendly name" },
            agent: {
              type: "string",
              description:
                "Agent type. 'general' (default, full access), 'explore' (read-only, haiku — for search/analysis only), 'plan' (read-only research). Use list_agents(type='available') to see all.",
            },
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
            "List agents. Use type='running' for spawned sub-agents, type='available' for agent files you can spawn, or omit for both. Use query to search available agents by keyword.",
          parameters: {
            type: {
              type: "string",
              description: "'running' = spawned sub-agents, 'available' = agent files on disk, omit = both",
            },
            query: {
              type: "string",
              description:
                "Search available agents by keyword (matches name and description). Only applies to available agents.",
            },
          },
          required: [],
          handler: async (args) => {
            const type = args.type as string | undefined;
            const query = (args.query as string | undefined)?.toLowerCase();
            const result: Record<string, unknown> = {};

            // Spawned sub-agents (running, completed, and failed)
            if (!type || type === "running") {
              const spawned = Array.from(trackedSpaces.values()).map((t) => {
                const entry: Record<string, unknown> = {
                  id: t.spaceId,
                  name: t.name,
                  status: t.status,
                  started_at: new Date(t.startedAt).toISOString(),
                  duration_ms: Date.now() - t.startedAt,
                };
                if (t.result) entry.has_result = true;
                if (t.error) entry.error = t.error;
                if (t.agentFileConfig) entry.agent = t.agentFileConfig.name;
                return entry;
              });
              result.spawned = { count: spawned.length, agents: spawned };
            }

            // Available agent files
            if (!type || type === "available") {
              try {
                let available = listAgentFiles(_cachedProjectRoot || "").map((a) => ({
                  name: a.name,
                  description: a.description || "",
                  model: a.model || "inherit",
                  tools: a.tools || "all (inherited)",
                  source: a.source,
                }));
                // Filter by query if provided
                if (query) {
                  available = available.filter(
                    (a) => a.name.toLowerCase().includes(query) || a.description.toLowerCase().includes(query),
                  );
                }
                result.available = { count: available.length, agents: available };
              } catch {
                result.available = { count: 0, agents: [] };
              }
            }

            return { success: true, output: JSON.stringify(result, null, 2) };
          },
        },
        {
          name: "get_agent_report",
          description:
            "Get a spawned sub-agent's result, status, or error report by ID. Works for running, completed, or failed agents. Use to check on sub-agents you spawned earlier.",
          parameters: {
            agent_id: { type: "string", description: "The sub-agent ID (from list_agents output)" },
          },
          required: ["agent_id"],
          handler: async (args) => {
            const id = args.agent_id as string;
            if (!id) return { success: false, output: "", error: "Missing required parameter: agent_id" };

            const tracked = trackedSpaces.get(id);
            if (!tracked) {
              return { success: false, output: "", error: `No tracked agent with id '${id}'` };
            }

            const report: Record<string, unknown> = {
              id: tracked.spaceId,
              name: tracked.name,
              status: tracked.status,
              started_at: new Date(tracked.startedAt).toISOString(),
              duration_ms: Date.now() - tracked.startedAt,
            };
            if (tracked.agentFileConfig) report.agent = tracked.agentFileConfig.name;
            if (tracked.result) report.result = tracked.result;
            if (tracked.error) report.error = tracked.error;
            if (tracked.status === "running") report.note = "Agent is still running. Result not yet available.";

            return { success: true, output: JSON.stringify(report, null, 2) };
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
        {
          name: "stop_agent",
          description:
            "Stop a running sub-agent immediately. Use when the sub-agent is no longer needed, stuck, or the task has been superseded. The sub-agent's space is marked as failed and its resources are cleaned up.",
          parameters: {
            agent_id: {
              type: "string",
              description: "The sub-agent ID to stop (from list_agents or spawn_agent output)",
            },
            reason: { type: "string", description: "Optional reason for stopping (logged for debugging)" },
          },
          required: ["agent_id"],
          handler: async (args) => {
            const id = args.agent_id as string;
            const reason = (args.reason as string) || "Stopped by parent agent";
            if (!id) return { success: false, output: "", error: "Missing required parameter: agent_id" };

            const tracked = trackedSpaces.get(id);
            if (!tracked) {
              return { success: false, output: "", error: `No tracked agent with id '${id}'` };
            }
            if (tracked.status !== "running") {
              return {
                success: false,
                output: "",
                error: `Agent '${id}' is already ${tracked.status}, cannot stop`,
              };
            }

            // Mark as failed and stop the worker
            spaceManager.failSpace(id, reason);
            // Stop Claude Code worker or normal space worker
            const ccWorker = getClaudeCodeWorker(id);
            if (ccWorker) {
              ccWorker.stop();
              unregisterClaudeCodeWorker(id);
              spaceCompleteCallbacks.delete(id);
              spaceAuthTokens.delete(id);
              spaceProjectRoots.delete(id);
            } else {
              spaceWorkerManager.stopSpaceWorker(id);
            }
            tracked.status = "failed";
            tracked.error = reason;

            return {
              success: true,
              output: JSON.stringify({
                agent_id: id,
                name: tracked.name,
                status: "stopped",
                reason,
              }),
            };
          },
        },
      ];
    },
  };

  async function handleSpawnAgent(args: Record<string, any>): Promise<ToolResult> {
    const task = args.task as string;
    const context = (args.context as string) || "";

    if (!task) {
      return { success: false, output: "", error: "Missing required parameter: task" };
    }

    try {
      const agentConfig = await getAgentConfig(config.channel);
      if (!agentConfig) {
        return { success: false, output: "", error: `No agent configured for channel ${config.channel}` };
      }
      if (agentConfig.project) _cachedProjectRoot = agentConfig.project;

      // Load agent file config — explicit agent= param, or default to "general"
      const agentName = (args.agent as string) || "general";
      let agentFileConfig: AgentFileConfig | null = null;
      const projectRoot = agentConfig.project || "";
      agentFileConfig = loadAgentFile(agentName, projectRoot);
      if (!agentFileConfig) {
        return { success: false, output: "", error: `Agent file "${agentName}" not found` };
      }

      // Name: explicit > agent file name > fallback
      const name = (args.name as string) || agentFileConfig?.name || `sub-${Date.now()}`;

      const spaceId = crypto.randomUUID();
      const sanitizedTitle = name
        .replace(/[\n\r]/g, " ")
        .trim()
        .slice(0, 100);
      // Use friendly name as sub-agent ID (sanitized), with UUID suffix for uniqueness
      const safeName = sanitizedTitle.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
      const subAgentId = `${safeName}-${spaceId.slice(0, 6)}`;

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

      // Register sub-agent in parent channel so avatar color resolves for messages
      getOrRegisterAgent(subAgentId, config.channel, false);

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
      // Apply provider + model overrides from agent file if provided
      const effectiveProvider = agentFileConfig?.provider || agentConfig.provider;
      const effectiveModel = agentFileConfig?.model
        ? resolveModelAlias(agentFileConfig.model, agentConfig.model)
        : agentConfig.model;

      let completionPromise: Promise<string>;

      // Route claude-code provider to ClaudeCodeSpaceWorker (can't use WorkerLoop)
      if (resolveProviderBaseType(effectiveProvider) === "claude-code" || effectiveProvider === "claude-code") {
        let ccResolve: (v: string) => void;
        let ccSettled = false;

        const wrappedResolve = (summary: string) => {
          if (ccSettled) return;
          ccSettled = true;
          ccResolve?.(summary);
        };

        const ccWorker = new ClaudeCodeSpaceWorker({
          space,
          task,
          context,
          model: effectiveModel,
          agentId: subAgentId,
          apiUrl: config.apiUrl,
          projectRoot: _cachedProjectRoot || agentConfig.project || undefined,
          spaceManager,
          resolve: wrappedResolve,
          onComplete: () => unregisterClaudeCodeWorker(space.id),
          agentPrompt: agentFileConfig?.systemPrompt || undefined,
          providerName: effectiveProvider,
          yolo: config.yolo ?? false,
        });
        registerClaudeCodeWorker(space.id, ccWorker);
        spaceAuthTokens.set(space.id, ccWorker.getSpaceToken());

        spaceCompleteCallbacks.set(space.id, (result: string) => {
          const won = spaceManager.completeSpace(space.id, result);
          if (won) {
            timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                channel: config.channel,
                text: result,
                user: subAgentId,
                agent_id: subAgentId,
              }),
            }).catch(() => {});
            wrappedResolve(result);
            ccWorker.stop();
          }
        });

        const timeoutMs = (space.timeout_seconds || 600) * 1000;
        const timeoutTimer = setTimeout(() => {
          if (!ccSettled) {
            ccSettled = true;
            spaceManager.timeoutSpace(space.id);
            ccWorker.stop();
          }
        }, timeoutMs);
        if (typeof timeoutTimer === "object" && "unref" in timeoutTimer) (timeoutTimer as any).unref();

        completionPromise = new Promise<string>((resolve, reject) => {
          ccResolve = resolve;
          ccWorker
            .start()
            .then(() => {
              if (!ccSettled) {
                ccSettled = true;
                spaceManager.failSpace(space.id, "Claude Code exited without calling complete_task");
                reject(new Error("Claude Code exited without calling complete_task"));
              }
            })
            .catch((err) => {
              if (!ccSettled) {
                ccSettled = true;
                spaceManager.failSpace(space.id, err.message);
                reject(err);
              }
            })
            .finally(() => {
              clearTimeout(timeoutTimer);
              spaceCompleteCallbacks.delete(space.id);
              spaceAuthTokens.delete(space.id);
              spaceProjectRoots.delete(space.id);
              unregisterClaudeCodeWorker(space.id);
              ccWorker.cleanup();
            });
        });
      } else {
        // Normal LLM provider — use WorkerLoop via spaceWorkerManager
        try {
          completionPromise = spaceWorkerManager.startSpaceWorker(
            space,
            { ...agentConfig, agentId: subAgentId, provider: effectiveProvider, model: effectiveModel },
            agentFileConfig || undefined,
          );
        } catch (workerErr: any) {
          spaceManager.failSpace(space.id, workerErr.message);
          return { success: false, output: "", error: `Failed to start worker: ${workerErr.message}` };
        }
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
              user: subAgentId,
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
        agentFileConfig: agentFileConfig || undefined,
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
          message:
            "Sub-agent started and working independently. Do NOT wait — continue with other tasks. The sub-agent will report back when done. Use list_agents(type='running') to check status or get_agent_report(agent_id) to read results.",
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

      // Reuse the original sub-agent ID from the space record
      const subAgentId = space.agent_id;

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

      // Restart space worker (preserve agent file config from original spawn)
      const retaskProvider = tracked.agentFileConfig?.provider || agentConfig.provider;
      const retaskModel = tracked.agentFileConfig?.model
        ? resolveModelAlias(tracked.agentFileConfig.model, agentConfig.model)
        : agentConfig.model;
      let completionPromise: Promise<string>;

      // Route claude-code provider to ClaudeCodeSpaceWorker (mirrors handleSpawnAgent routing)
      if (resolveProviderBaseType(retaskProvider) === "claude-code" || retaskProvider === "claude-code") {
        let ccResolve: (v: string) => void;
        let ccSettled = false;
        const wrappedResolve = (summary: string) => {
          if (ccSettled) return;
          ccSettled = true;
          ccResolve?.(summary);
        };
        const ccWorker = new ClaudeCodeSpaceWorker({
          space,
          task,
          context: "",
          model: retaskModel,
          agentId: subAgentId,
          apiUrl: config.apiUrl,
          projectRoot: _cachedProjectRoot || agentConfig.project || undefined,
          spaceManager,
          resolve: wrappedResolve,
          onComplete: () => unregisterClaudeCodeWorker(space.id),
          agentPrompt: tracked.agentFileConfig?.systemPrompt || undefined,
          providerName: retaskProvider,
          yolo: config.yolo ?? false,
        });
        registerClaudeCodeWorker(space.id, ccWorker);
        spaceAuthTokens.set(space.id, ccWorker.getSpaceToken());
        spaceCompleteCallbacks.set(space.id, (result: string) => {
          const won = spaceManager.completeSpace(space.id, result);
          if (won) {
            timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                channel: config.channel,
                text: result,
                user: subAgentId,
                agent_id: subAgentId,
              }),
            }).catch(() => {});
          }
        });
        completionPromise = new Promise<string>((resolve, reject) => {
          ccResolve = resolve;
          ccWorker
            .start()
            .then(() => {
              if (!ccSettled) {
                ccSettled = true;
                resolve("Agent completed without explicit result");
              }
            })
            .catch(reject)
            .finally(() => {
              spaceCompleteCallbacks.delete(space.id);
              spaceAuthTokens.delete(space.id);
              spaceProjectRoots.delete(space.id);
              unregisterClaudeCodeWorker(space.id);
              ccWorker.cleanup();
            });
        });
      } else {
        // Normal LLM provider — use WorkerLoop via spaceWorkerManager
        try {
          completionPromise = spaceWorkerManager.startSpaceWorker(
            space,
            { ...agentConfig, agentId: subAgentId, provider: retaskProvider, model: retaskModel },
            tracked.agentFileConfig,
          );
        } catch (workerErr: any) {
          spaceManager.failSpace(space.id, workerErr.message);
          return { success: false, output: "", error: `Failed to start worker: ${workerErr.message}` };
        }
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
              user: subAgentId,
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
