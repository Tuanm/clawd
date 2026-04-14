/**
 * Shared Sub-Agent Spawn Helper
 *
 * Core spawning logic extracted from spawn-plugin.ts for reuse.
 * Both spawn-plugin and chat-tools.ts use this to spawn sub-agents.
 *
 * This module handles:
 * - Agent file loading (built-in + custom)
 * - Space creation and worker startup
 * - Result reporting to parent channel
 * - Timeout and eviction management
 */

import type { AgentFileConfig } from "../agent/agents/loader";
import { loadAgentFile, resolveModelAlias } from "../agent/agents/loader";
import { resolveProviderBaseType } from "../agent/api/provider-config";
import type { ToolResult } from "../agent/tools/definitions";
import {
  DEFAULT_SPAWN_AGENT_COLOR,
  DEFAULT_SPAWN_TIMEOUT_SECONDS,
  MAX_ACTIVE_SUB_AGENTS,
  MAX_CONTEXT_LENGTH,
  SPACE_EVICTION_MS,
} from "../agent/constants/spaces";
import {
  ClaudeCodeSpaceWorker,
  mapToMcpToolNames,
  registerClaudeCodeWorker,
  unregisterClaudeCodeWorker,
} from "./claude-code-worker";
import type { SpaceManager } from "./manager";
import type { SpaceWorkerManager } from "./worker";
import { getOrRegisterAgent } from "../server/database";
import { spaceAuthTokens, spaceCompleteCallbacks, spaceProjectRoots } from "../server/mcp/shared";
import { timedFetch } from "../utils/timed-fetch";

/** Build disallowedTools list for Claude Code sub-agents */
function buildCcDisallowedTools(
  agentCfg: AgentFileConfig | null | undefined,
  providerName: string,
): string[] | undefined {
  const fromConfig = agentCfg?.disallowedTools ? mapToMcpToolNames(agentCfg.disallowedTools) : [];
  const extra = providerName !== "claude-code" ? ["WebSearch", "WebFetch"] : [];
  const merged = [...fromConfig, ...extra];
  return merged.length > 0 ? merged : undefined;
}

/** Surrogate-safe string slice — avoids cutting UTF-16 surrogate pairs */
function surrogateSlice(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  let cut = maxLen;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return s.slice(0, cut);
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
  agentFileConfig?: AgentFileConfig;
}

export interface SpawnContext {
  channel: string;
  agentId: string;
  apiUrl: string;
  yolo?: boolean;
  spaceManager: SpaceManager;
  spaceWorkerManager: SpaceWorkerManager;
  trackedSpaces: Map<string, TrackedSpace>;
  /** Called to get agent config for a channel */
  getAgentConfig: (
    channel: string,
  ) => Promise<{ provider: string; model: string; agentId: string; project?: string; avatar_color?: string } | null>;
}

export interface ExecuteSpawnOptions {
  task: string;
  agentType: string;
  context?: string;
  name?: string;
  model?: string;
}

/**
 * Core spawn logic — used by both spawn-plugin (via createSpawnAgentPlugin)
 * and chat-tools.ts (via lazy import).
 */
export async function executeSpawnAgent(ctx: SpawnContext, opts: ExecuteSpawnOptions): Promise<ToolResult> {
  const { task, agentType, context = "", name, model: modelOverride } = opts;

  if (!task) {
    return { success: false, output: "", error: "Missing required parameter: task" };
  }

  // Runtime allowlist — enum is cosmetic only, enforce here
  const ALLOWED_AGENT_TYPES = new Set(["general", "explore", "plan"]);
  if (!ALLOWED_AGENT_TYPES.has(agentType)) {
    return {
      success: false,
      output: "",
      error: `agent type "${agentType}" not allowed. Use: general, explore, or plan.`,
    };
  }

  // Limit active sub-agents per channel
  const activeSpaces = ctx.spaceManager
    .listSpaces(ctx.channel, "active")
    .filter((s) => s.source === "spawn_agent" || s.source === "claude_code");
  if (activeSpaces.length >= MAX_ACTIVE_SUB_AGENTS) {
    return {
      success: false,
      output: "",
      error: `Channel has ${activeSpaces.length} active sub-agents (max ${MAX_ACTIVE_SUB_AGENTS}). Wait for existing agents to complete or stop some with stop_agent before spawning more.`,
    };
  }

  let cachedProjectRoot: string | null = null;

  try {
    const agentConfig = await ctx.getAgentConfig(ctx.channel);
    if (!agentConfig) {
      return { success: false, output: "", error: `No agent configured for channel ${ctx.channel}` };
    }
    if (!agentConfig.project) {
      return {
        success: false,
        output: "",
        error: `[SpawnHelper] projectRoot is required but not found for channel ${ctx.channel}. Ensure channel_agents.project is set.`,
      };
    }
    cachedProjectRoot = agentConfig.project;

    // Load agent file config — agentType is the name
    const projectRoot = agentConfig.project;
    const agentFileConfig = loadAgentFile(agentType, projectRoot);
    if (!agentFileConfig) {
      return { success: false, output: "", error: `Agent "${agentType}" not found` };
    }

    // Name: explicit > agent file name > fallback
    const resolvedName = name || agentFileConfig.name || `sub-${Date.now()}`;

    const spaceId = crypto.randomUUID();
    const sanitizedTitle = resolvedName
      .replace(/[\n\r]/g, " ")
      .trim()
      .slice(0, 100);
    const safeName = sanitizedTitle.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
    const subAgentId = `${safeName}-${spaceId.slice(0, 6)}`;

    // Create space
    const space = ctx.spaceManager.createSpace({
      id: spaceId,
      channel: ctx.channel,
      title: sanitizedTitle,
      description: task.slice(0, 500),
      agent_id: subAgentId,
      agent_color: agentConfig.avatar_color || DEFAULT_SPAWN_AGENT_COLOR,
      source: "spawn_agent",
      timeout_seconds: DEFAULT_SPAWN_TIMEOUT_SECONDS,
    });

    // Register sub-agent in parent channel
    getOrRegisterAgent(subAgentId, ctx.channel, false);

    // Post preview card and task in parallel
    const [cardRes, taskRes] = await Promise.all([
      timedFetch(`${ctx.apiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: ctx.channel,
          text: "",
          user: ctx.agentId,
          agent_id: ctx.agentId,
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
      timedFetch(`${ctx.apiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: space.space_channel,
          text: context
            ? `**Context:**\n${surrogateSlice(context, MAX_CONTEXT_LENGTH)}\n\n**Task:** ${task}`
            : `**Task:** ${task}`,
          user: "UBOT",
          agent_id: ctx.agentId,
        }),
      }),
    ]);

    if (cardRes.ok) {
      const cardData = (await cardRes.json()) as any;
      if (cardData.ts) ctx.spaceManager.updateCardTs(space.id, cardData.ts);
    }
    if (!taskRes.ok) {
      ctx.spaceManager.failSpace(space.id, "Failed to post task to space channel");
      return { success: false, output: "", error: "Failed to post task to space channel" };
    }

    // Resolve model: explicit override > agent file alias > parent model
    const effectiveModel = modelOverride
      ? resolveModelAlias(modelOverride, agentConfig.model)
      : agentFileConfig.model
        ? resolveModelAlias(agentFileConfig.model, agentConfig.model)
        : agentConfig.model;

    const effectiveProvider = agentFileConfig?.provider || agentConfig.provider;

    let completionPromise: Promise<string>;

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
        apiUrl: ctx.apiUrl,
        projectRoot: cachedProjectRoot || agentConfig.project,
        spaceManager: ctx.spaceManager,
        resolve: wrappedResolve,
        onComplete: () => unregisterClaudeCodeWorker(space.id),
        agentPrompt: agentFileConfig?.systemPrompt || undefined,
        providerName: effectiveProvider,
        yolo: ctx.yolo ?? false,
        allowedTools: agentFileConfig?.tools ? mapToMcpToolNames(agentFileConfig.tools) : undefined,
        disallowedTools: buildCcDisallowedTools(agentFileConfig, effectiveProvider),
      });
      registerClaudeCodeWorker(space.id, ccWorker);
      spaceAuthTokens.set(space.id, ccWorker.getSpaceToken());

      spaceCompleteCallbacks.set(space.id, (result: string) => {
        const won = ctx.spaceManager.completeSpace(space.id, result);
        if (won) {
          timedFetch(`${ctx.apiUrl}/api/chat.postMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel: ctx.channel,
              text: result,
              user: subAgentId,
              agent_id: subAgentId,
            }),
          }).catch((err) => {
            console.error("[SpawnHelper] chat.postMessage (complete) failed:", err);
          });
          wrappedResolve(result);
          ccWorker.stop();
        }
      });

      const timeoutMs = (space.timeout_seconds || 600) * 1000;
      const timeoutTimer = setTimeout(() => {
        if (!ccSettled) {
          ccSettled = true;
          ctx.spaceManager.timeoutSpace(space.id);
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
              ctx.spaceManager.failSpace(space.id, "Claude Code exited without calling complete_task");
              reject(new Error("Claude Code exited without calling complete_task"));
            }
          })
          .catch((err) => {
            if (!ccSettled) {
              ccSettled = true;
              ctx.spaceManager.failSpace(space.id, err.message);
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
        completionPromise = ctx.spaceWorkerManager.startSpaceWorker(
          space,
          { ...agentConfig, agentId: subAgentId, provider: effectiveProvider, model: effectiveModel },
          agentFileConfig || undefined,
        );
      } catch (workerErr: unknown) {
        const workerErrMsg = workerErr instanceof Error ? workerErr.message : String(workerErr);
        ctx.spaceManager.failSpace(space.id, workerErrMsg);
        return { success: false, output: "", error: `Failed to start worker: ${workerErrMsg}` };
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
        ? ctx.spaceManager.timeoutSpace(space.id)
        : ctx.spaceManager.failSpace(space.id, String(controller.signal.reason));
      if (won) {
        const prefix = isTimeout ? "Sub-space timed out" : "Sub-space failed";
        timedFetch(`${ctx.apiUrl}/api/chat.postMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: ctx.channel,
            text: `${prefix}: ${sanitizedTitle}`,
            user: subAgentId,
            agent_id: subAgentId,
          }),
        }).catch((err) => {
          console.error("[SpawnHelper] chat.postMessage (abort) failed:", err);
        });
      }
      ctx.spaceWorkerManager.stopSpaceWorker(space.id);
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });

    // Track the space
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
      .catch((err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ctx.spaceManager.failSpace(spaceId, err instanceof Error ? err.message : String(err));
        }
        tracked.status = "failed";
        tracked.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        controller.signal.removeEventListener("abort", onAbort);
        ctx.spaceWorkerManager.stopSpaceWorker(space.id);
        ctx.spaceManager.cleanupSpaceAgents(space.id);
        const evictTimer = setTimeout(() => ctx.trackedSpaces.delete(spaceId), SPACE_EVICTION_MS);
        if (typeof evictTimer === "object" && "unref" in evictTimer) (evictTimer as any).unref();
        const t = ctx.trackedSpaces.get(spaceId);
        if (t) t.evictionTimer = evictTimer;
      });

    ctx.trackedSpaces.set(spaceId, tracked);

    return {
      success: true,
      output: JSON.stringify({
        agent_id: spaceId,
        name: sanitizedTitle,
        status: "spawned",
        space_channel: space.space_channel,
        message:
          "Sub-agent started and working independently. Do NOT wait — continue with other tasks. The sub-agent will report back when done. Use list_agents(type='running') to check status, get_agent_report(agent_id) for structured results, or get_agent_logs(agent_id) for raw output.",
      }),
    };
  } catch (err: unknown) {
    try {
      const activeSpaces = ctx.spaceManager.listSpaces(ctx.channel, "active");
      const orphan = activeSpaces.find((s) => s.description === task.slice(0, 500));
      if (orphan) ctx.spaceManager.failSpace(orphan.id, err instanceof Error ? err.message : String(err));
    } catch {
      /* best-effort cleanup */
    }
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}
