/**
 * Agent MCP Tools — MCP tool definitions + handlers for spawn_agent, list_agents, etc.
 * Used by handleAgentMcpRequest to expose agent management tools via MCP.
 */

import type { SpaceManager } from "./manager";
import type { SpaceWorkerManager } from "./worker";
import {
  DEFAULT_AGENT_COLOR,
  DEFAULT_AGENT_TIMEOUT_SECONDS,
  DEFAULT_API_PORT,
  MAX_ACTIVE_SUB_AGENTS,
  MAX_CONTEXT_LENGTH,
  RETRY_BACKOFF_MS,
} from "../agent/constants/spaces";

// ============================================================================
// Global references (set by WorkerManager during startup)
// ============================================================================

let _spaceManager: SpaceManager | null = null;
let _spaceWorkerManager: SpaceWorkerManager | null = null;
let _chatApiUrl = `http://localhost:${DEFAULT_API_PORT}`;
let _yolo: boolean = false;

export function setAgentMcpInfra(
  spaceManager: SpaceManager,
  spaceWorkerManager: SpaceWorkerManager,
  chatApiUrl: string,
  yolo: boolean = false,
): void {
  _spaceManager = spaceManager;
  _spaceWorkerManager = spaceWorkerManager;
  _chatApiUrl = chatApiUrl;
  _yolo = yolo;
}

// ============================================================================
// Helpers
// ============================================================================

function surrogateSlice(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  let cut = maxLen;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return s.slice(0, cut);
}

// ============================================================================
// MCP Tool Definitions
// ============================================================================

export const AGENT_MCP_TOOLS = [
  {
    name: "spawn_agent",
    description:
      "Spawn a sub-agent to handle a task autonomously. The sub-agent works independently with full tool access (file read/write/edit, bash, grep, etc.).\n\nModel guide: 'sonnet' (default, general tasks), 'haiku' (quick/simple). Do NOT use opus for sub-agents — it's too expensive.\n\nThe sub-agent runs asynchronously. Use list_agents to check status and get_agent_report to read results.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task for the sub-agent to complete" },
        name: { type: "string", description: "Optional friendly name" },
        model: { type: "string", description: "Model: sonnet (default), haiku (quick). Do not use opus." },
        agent: {
          type: "string",
          description: "Agent type from .clawd/agents/ or .claude/agents/ — inherits system prompt and directives",
        },
        context: { type: "string", description: "Optional context to seed the sub-agent" },
      },
      required: ["task"],
    },
  },
  {
    name: "list_agents",
    description:
      "List spawned sub-agents and their status. Supports filtering by name/query and status, and limits results to avoid large outputs.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Filter by agent type: 'available' (registered agents, no result), 'spawned' (agents spawned by this agent), or omit for all. Default: 'available'.",
          enum: ["available", "spawned"],
        },
        status: {
          type: "string",
          description: "Filter by status: 'running', 'completed', 'failed', 'stopped'. Omit for all.",
        },
        query: {
          type: "string",
          description: "Search by agent name (case-insensitive substring match).",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 10, max: 50).",
        },
        offset: {
          type: "number",
          description: "Pagination offset (default: 0).",
        },
      },
      required: [],
    },
  },
  {
    name: "get_agent_report",
    description: "Get a sub-agent's result or status by ID.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The sub-agent ID" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "stop_agent",
    description: "Stop a running sub-agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The sub-agent ID to stop" },
        reason: { type: "string", description: "Optional reason" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "todo_write",
    description:
      "Write your Todo list. Creates or replaces the list. Each item needs content and status (pending/in_progress/completed).",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Todo items",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string" },
            },
            required: ["content"],
          },
        },
      },
      required: ["todos"],
    },
  },
  {
    name: "todo_read",
    description: "Read your current Todo list.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "todo_update",
    description: "Update a Todo item's status.",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "The item ID to update" },
        status: { type: "string", description: "New status: pending, in_progress, completed" },
      },
      required: ["item_id", "status"],
    },
  },
];

// ============================================================================
// Tool Execution
// ============================================================================

export async function executeAgentToolCall(
  name: string,
  args: Record<string, unknown>,
  channel: string,
  agentId: string,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const textResult = (text: string) => ({ content: [{ type: "text", text }] });

  if (!_spaceManager) {
    return textResult(JSON.stringify({ ok: false, error: "Space manager not initialized" }));
  }

  switch (name) {
    case "spawn_agent": {
      const task = args.task as string;
      if (!task) return textResult(JSON.stringify({ ok: false, error: "Missing task" }));

      // Limit active sub-agents per channel to prevent resource exhaustion
      // MAX_ACTIVE_SUB_AGENTS imported from constants
      const activeSpaces = _spaceManager
        .listSpaces(channel, "active")
        .filter((s) => s.source === "spawn_agent" || s.source === "claude_code");
      if (activeSpaces.length >= MAX_ACTIVE_SUB_AGENTS) {
        return textResult(
          JSON.stringify({
            ok: false,
            error: `Channel has ${activeSpaces.length} active sub-agents (max ${MAX_ACTIVE_SUB_AGENTS}). Wait for existing agents to complete or stop some with stop_agent before spawning more.`,
          }),
        );
      }

      // Dynamic import to avoid circular deps
      const { ClaudeCodeSpaceWorker, registerClaudeCodeWorker, unregisterClaudeCodeWorker } = await import(
        "./claude-code-worker"
      );
      const { spaceCompleteCallbacks, spaceAuthTokens, spaceProjectRoots } = await import("../server/mcp");
      const { getOrRegisterAgent } = await import("../server/database");
      const { timedFetch } = await import("../utils/timed-fetch");
      const { loadAgentFile } = await import("../agent/agents/loader");

      let model = (args.model as string) || "sonnet";
      // Cap sub-agent model — opus is too expensive for sub-agents
      if (/opus/i.test(model)) {
        console.warn(`[spawn_agent] Downgrading model from "${model}" to "sonnet" — opus not allowed for sub-agents`);
        model = "sonnet";
      }
      const context = (args.context as string) || "";
      const agentType = args.agent as string | undefined;

      // Resolve parent agent's project root and provider early (needed for agent file loading + sub-agent CWD)
      let projectRoot: string | undefined;
      let parentProviderName: string | undefined;
      try {
        const { db } = await import("../server/database");
        const row = db
          .query<{ project: string | null; provider: string | null }, [string, string]>(
            `SELECT project, provider FROM channel_agents WHERE channel = ? AND agent_id = ?`,
          )
          .get(channel, agentId);
        if (row?.project) projectRoot = row.project;
        if (row?.provider) parentProviderName = row.provider;
      } catch (err) {
        throw new Error(
          `[agent-mcp-tools] Failed to resolve projectRoot for agent ${agentId} on channel ${channel}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!projectRoot) {
        throw new Error(
          `[agent-mcp-tools] projectRoot is required but not found for agent ${agentId} on channel ${channel}. ` +
            `Ensure channel_agents.project is set in the database.`,
        );
      }

      // Load agent file if specified (for system prompt / directives)
      let agentPrompt: string | undefined;
      if (agentType) {
        const agentFile = loadAgentFile(agentType, projectRoot);
        if (!agentFile) {
          return textResult(JSON.stringify({ ok: false, error: `Agent file "${agentType}" not found` }));
        }
        agentPrompt = agentFile.systemPrompt || undefined;
      }

      const taskName = (args.name as string) || agentType || `claude-code-${Date.now()}`;
      const sanitizedTitle = taskName
        .replace(/[\n\r]/g, " ")
        .trim()
        .slice(0, 100);
      const spaceId = crypto.randomUUID();
      const safeName = sanitizedTitle.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
      const subAgentId = `${safeName}-${spaceId.slice(0, 6)}`;

      const space = _spaceManager.createSpace({
        id: spaceId,
        channel,
        title: taskName.slice(0, 100),
        description: task.slice(0, 500),
        agent_id: subAgentId,
        agent_color: DEFAULT_AGENT_COLOR,
        source: "claude_code",
        timeout_seconds: DEFAULT_AGENT_TIMEOUT_SECONDS,
      });

      getOrRegisterAgent(subAgentId, channel, false);

      // Post preview card and save its timestamp (needed for status update on completion)
      try {
        const cardRes = await timedFetch(`${_chatApiUrl}/api/chat.postMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel,
            text: `[Claude Code sub-agent spawned: "${taskName}" (model: ${model})] ${task.slice(0, 200)}`,
            user: agentId,
            agent_id: agentId,
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
          if (cardData.ts) _spaceManager.updateCardTs(space.id, cardData.ts);
        }
      } catch {}

      // Post task to space channel
      timedFetch(`${_chatApiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: space.space_channel,
          text: context
            ? `**Context:**\n${surrogateSlice(context, MAX_CONTEXT_LENGTH)}\n\n**Task:** ${task}`
            : `**Task:** ${task}`,
          user: "UBOT",
          agent_id: agentId,
        }),
      }).catch((err) => {
        console.error("[agent-mcp] chat.postMessage (task start) failed:", err);
      });

      // Create worker
      let ccResolve: (v: string) => void;
      let ccSettled = false;

      const ccWorker = new ClaudeCodeSpaceWorker({
        space,
        task,
        context,
        model,
        agentId: subAgentId,
        apiUrl: _chatApiUrl,
        projectRoot,
        spaceManager: _spaceManager,
        agentPrompt,
        providerName: parentProviderName,
        yolo: _yolo,
        resolve: (summary: string) => {
          if (ccSettled) return;
          ccSettled = true;
          ccResolve?.(summary);
        },
        onComplete: () => unregisterClaudeCodeWorker(space.id),
      });
      registerClaudeCodeWorker(space.id, ccWorker);
      spaceAuthTokens.set(space.id, ccWorker.getSpaceToken());

      const timeoutMs = DEFAULT_AGENT_TIMEOUT_SECONDS * 1000;
      const timeoutTimer = setTimeout(() => {
        ccWorker.stop();
        if (!ccSettled) {
          ccSettled = true;
          if (_spaceManager) {
            _spaceManager.failSpace(space.id, "Timeout: sub-agent exceeded 30 minute limit");
          }
          timedFetch(`${_chatApiUrl}/api/chat.postMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel,
              text: `Sub-agent timed out: ${taskName} (30 min limit)`,
              user: subAgentId,
              agent_id: subAgentId,
            }),
          }).catch((err) => {
            console.error("[agent-mcp] chat.postMessage (timeout) failed:", err);
          });
        }
      }, timeoutMs);

      spaceCompleteCallbacks.set(space.id, (result: string) => {
        const won = _spaceManager ? _spaceManager.completeSpace(space.id, result) : false;
        if (won) {
          clearTimeout(timeoutTimer);
          timedFetch(`${_chatApiUrl}/api/chat.postMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel,
              text: result,
              user: subAgentId,
              agent_id: subAgentId,
            }),
          }).catch((err) => {
            console.error("[agent-mcp] chat.postMessage (complete) failed:", err);
          });
          if (!ccSettled) {
            ccSettled = true;
            ccResolve?.(result);
          }
          ccWorker.stop();
        }
      });

      // Start worker with retry on 500 errors
      const MAX_RETRIES = 2;
      const startWithRetry = async (): Promise<void> => {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            await ccWorker.start();
            return;
          } catch (err: unknown) {
            const is500 =
              err instanceof Error && (err.message?.includes("500") || err.message?.includes("Internal server error"));
            if (is500 && attempt < MAX_RETRIES) {
              const delay = RETRY_BACKOFF_MS * (attempt + 1);
              console.log(`[spawn_agent] 500 error on attempt ${attempt + 1}, retrying in ${delay / 1000}s...`);
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }
            throw err;
          }
        }
      };

      new Promise<string>((resolve, reject) => {
        ccResolve = resolve;
        startWithRetry()
          .then(async () => {
            if (!ccSettled) {
              ccSettled = true;
              let lastMsg = "";
              try {
                const { getPendingMessages } = await import("../server/routes/messages");
                const res = getPendingMessages(space.space_channel, undefined, true, 3);
                const msgs = ((res as any).messages || []).filter((m: any) => m.agent_id === subAgentId && m.text);
                if (msgs.length > 0) lastMsg = msgs[msgs.length - 1].text;
              } catch {}
              const errorMsg = lastMsg
                ? `Sub-agent exited without completing. Last message: ${lastMsg}`
                : "Sub-agent exited without completing";
              if (_spaceManager) {
                _spaceManager.failSpace(space.id, errorMsg);
              }
              const chatText = lastMsg
                ? `Sub-agent failed: ${taskName}\n\nLast message:\n${lastMsg}`
                : `Sub-agent failed: ${taskName} — exited without completing`;
              timedFetch(`${_chatApiUrl}/api/chat.postMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  channel,
                  text: chatText,
                  user: subAgentId,
                  agent_id: subAgentId,
                }),
              }).catch((err) => {
                console.error("[agent-mcp] chat.postMessage (failed) failed:", err);
              });
              reject(new Error(errorMsg));
            }
          })
          .catch((err: unknown) => {
            if (!ccSettled) {
              ccSettled = true;
              const errMsg = err instanceof Error ? err.message : String(err);
              _spaceManager?.failSpace(space.id, errMsg);
              timedFetch(`${_chatApiUrl}/api/chat.postMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  channel,
                  text: `Sub-agent error: ${taskName} — ${errMsg}`,
                  user: subAgentId,
                  agent_id: subAgentId,
                }),
              }).catch((postErr) => {
                console.error("[agent-mcp] chat.postMessage (error) failed:", postErr);
              });
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
      }).catch((err) => {
        console.error("[agent-mcp] spawn_agent outer promise failed:", err);
      }); // tracked via space status

      return textResult(
        JSON.stringify({
          ok: true,
          agent_id: spaceId,
          name: taskName,
          status: "spawned",
          message: "Claude Code sub-agent started. Use list_agents to check status, get_agent_report to read results.",
        }),
      );
    }

    case "list_agents": {
      const { getClaudeCodeWorker } = await import("./claude-code-worker");
      const agentType = (args.type as string) || "available";
      const statusFilter = args.status as string | undefined;
      const query = (args.query as string | undefined)?.toLowerCase();
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const offset = Number(args.offset) || 0;

      const spaces = _spaceManager.listSpaces(channel);
      let agents = spaces
        .filter((s) => {
          if (agentType === "available") return !s.result_summary;
          if (agentType === "spawned") return !!s.result_summary;
          return true;
        })
        .filter((s) => {
          if (query) return s.title.toLowerCase().includes(query);
          return true;
        })
        .filter((s) => {
          if (statusFilter) return s.status === statusFilter;
          return true;
        });

      const total = agents.length;
      agents = agents.slice(offset, offset + limit);

      const results = agents.map((s) => ({
        id: s.id,
        name: s.title,
        status: s.status,
        result: s.result_summary?.slice(0, 300),
      }));

      return textResult(JSON.stringify({ ok: true, total, count: results.length, offset, limit, agents: results }));
    }

    case "get_agent_report": {
      const id = args.agent_id as string;
      if (!id) return textResult(JSON.stringify({ ok: false, error: "Missing agent_id" }));
      const space = _spaceManager.getSpace(id);
      if (!space) return textResult(JSON.stringify({ ok: false, error: "Agent not found" }));
      return textResult(
        JSON.stringify({
          ok: true,
          id: space.id,
          name: space.title,
          status: space.status,
          result: space.result_summary,
        }),
      );
    }

    case "stop_agent": {
      const id = args.agent_id as string;
      const reason = (args.reason as string) || "Stopped by parent agent";
      if (!id) return textResult(JSON.stringify({ ok: false, error: "Missing agent_id" }));

      const { getClaudeCodeWorker, unregisterClaudeCodeWorker } = await import("./claude-code-worker");
      const {
        spaceCompleteCallbacks,
        spaceAuthTokens,
        spaceProjectRoots: stopSpaceRoots,
      } = await import("../server/mcp");

      const ccw = getClaudeCodeWorker(id);
      if (ccw) {
        ccw.stop();
        unregisterClaudeCodeWorker(id);
        spaceCompleteCallbacks.delete(id);
        spaceAuthTokens.delete(id);
        stopSpaceRoots.delete(id);
      }
      _spaceManager.failSpace(id, reason);

      return textResult(JSON.stringify({ ok: true, status: "stopped", reason }));
    }

    case "todo_write": {
      const { timedFetch } = await import("../utils/timed-fetch");
      const todos = args.todos || args.items;
      if (!todos) return textResult(JSON.stringify({ ok: false, error: "Missing todos" }));
      try {
        const res = await timedFetch(`${_chatApiUrl}/api/todos.write`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agentId, channel, items: todos }),
        });
        const data = (await res.json()) as any;
        return textResult(JSON.stringify(data));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(JSON.stringify({ ok: false, error: message }));
      }
    }

    case "todo_read": {
      const { timedFetch } = await import("../utils/timed-fetch");
      try {
        const res = await timedFetch(
          `${_chatApiUrl}/api/todos.read?agent_id=${encodeURIComponent(agentId)}&channel=${encodeURIComponent(channel)}`,
        );
        const data = (await res.json()) as any;
        return textResult(JSON.stringify(data));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(JSON.stringify({ ok: false, error: message }));
      }
    }

    case "todo_update": {
      const { timedFetch } = await import("../utils/timed-fetch");
      const { item_id, status } = args as { item_id?: string; status?: string };
      if (!item_id || !status) return textResult(JSON.stringify({ ok: false, error: "Missing item_id or status" }));
      try {
        const res = await timedFetch(`${_chatApiUrl}/api/todos.update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agentId, channel, item_id, status }),
        });
        const data = (await res.json()) as any;
        return textResult(JSON.stringify(data));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(JSON.stringify({ ok: false, error: message }));
      }
    }

    default:
      return textResult(JSON.stringify({ ok: false, error: `Unknown agent tool: ${name}` }));
  }
}
