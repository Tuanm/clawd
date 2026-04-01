/**
 * Claude Code Space Worker
 *
 * Runs a Claude Code agent via the official SDK to handle a task within a Claw'd Space.
 * All output is streamed to the UI via WebSocket events.
 */

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { setAgentStreaming } from "../server/database";
import { broadcastAgentStreaming, broadcastAgentToken, broadcastAgentToolCall } from "../server/websocket";
import { timedFetch } from "../utils/timed-fetch";
import { truncateToolResult, formatToolDescription, hasTmux } from "../claude-code-utils";
import { initMemorySession, saveToMemory } from "../claude-code-memory";
import { startTmuxMonitor, stopTmuxMonitor, type TmuxMonitor } from "../claude-code-tmux";
import { runSDKQuery } from "../claude-code-sdk";
import { loadOAuthToken } from "../mcp-oauth";
import { spaceProjectRoots } from "../server/mcp";
import type { Space } from "./db";
import type { SpaceManager } from "./manager";
import { getPendingMessages } from "../server/routes/messages";
import { countCustomScripts } from "../agent/plugins/custom-tool-plugin";

// Re-export utils for backward compatibility (main-worker, spawn-plugin import from here)
export { hasTmux, truncateToolResult, formatToolDescription };

// ============================================================================
// Tool name mapping
// ============================================================================

/**
 * Maps Claw'd short tool names (used in agent YAML `tools`/`disallowedTools`)
 * AND Claude Code native tool names (PascalCase) to their MCP full names.
 *
 * This is used when spawning a CC sub-agent with an agent file config so that
 * tool restrictions from the YAML are honoured even though CC native tools are
 * replaced by MCP equivalents at the SDK level.
 */
export const CLAWD_TOOL_NAME_MAP: Record<string, string> = {
  // Short names (Claw'd agent YAML format)
  bash: "mcp__clawd__bash",
  view: "mcp__clawd__file_view",
  edit: "mcp__clawd__file_edit",
  multi_edit: "mcp__clawd__file_multi_edit",
  multiedit: "mcp__clawd__file_multi_edit",
  create: "mcp__clawd__file_create",
  glob: "mcp__clawd__file_glob",
  grep: "mcp__clawd__file_grep",
  today: "mcp__clawd__today",
  get_environment: "mcp__clawd__get_environment",
  web_search: "mcp__clawd__web_search",
  web_fetch: "mcp__clawd__web_fetch",
  custom_script: "mcp__clawd__custom_script",
  // Claude Code native tool names (PascalCase)
  Bash: "mcp__clawd__bash",
  Read: "mcp__clawd__file_view",
  Write: "mcp__clawd__file_create",
  Edit: "mcp__clawd__file_edit",
  MultiEdit: "mcp__clawd__file_multi_edit",
  Glob: "mcp__clawd__file_glob",
  Grep: "mcp__clawd__file_grep",
};

/**
 * Translates an array of tool names (short or CC native) to MCP full names.
 * Names that are already MCP full names (mcp__*) are passed through unchanged.
 * Unknown names are passed through as-is.
 */
export function mapToMcpToolNames(tools: string[]): string[] {
  return tools.map((t) => CLAWD_TOOL_NAME_MAP[t] ?? t);
}

// ============================================================================
// Types
// ============================================================================

export interface ClaudeCodeWorkerConfig {
  space: Space;
  task: string;
  context?: string;
  model?: string;
  agentId: string;
  apiUrl: string;
  projectRoot?: string;
  spaceManager: SpaceManager;
  resolve: (summary: string) => void;
  onComplete?: () => void;
  agentPrompt?: string;
  /** Provider name to use for auth/env injection (e.g. "my-claude"). Defaults to "claude-code". */
  providerName?: string;
  /** When false (default), sandbox restrictions apply. When true, bypasses all permission checks. */
  yolo?: boolean;
  /**
   * Allowlist of MCP tool names this agent may use (translated from agent YAML `tools`).
   * When provided, injected into the system prompt as an explicit instruction.
   */
  allowedTools?: string[];
  /**
   * Denylist of MCP tool names this agent must NOT use (translated from agent YAML `disallowedTools`).
   * Passed to the SDK's `disallowedTools` to hard-block the tools at the SDK level.
   */
  disallowedTools?: string[];
}

// ============================================================================
// Worker
// ============================================================================

export class ClaudeCodeSpaceWorker {
  private sessionId: string | null = null;
  private config: ClaudeCodeWorkerConfig;
  private stopped = false;
  private maxRetries = 3;
  private retryCount = 0;
  private spaceToken: string;
  private tmuxMonitor: TmuxMonitor | null = null;
  private memorySessionId: string | null = null;
  private abortController: AbortController | null = null;
  private lastHumanTs: string = "0";

  constructor(config: ClaudeCodeWorkerConfig) {
    this.config = config;
    this.spaceToken = crypto.randomUUID();
    const sessionName = `${config.space.space_channel}-${config.agentId}`.replace(/[^a-zA-Z0-9-]/g, "_");
    this.memorySessionId = initMemorySession(sessionName, "claude-code");
  }

  async start(): Promise<void> {
    while (this.retryCount <= this.maxRetries && !this.stopped) {
      try {
        await this.runOnce();
        return;
      } catch (err: any) {
        this.retryCount++;
        const isAuth = err.message?.includes("Not logged in") || err.message?.includes("/login");
        if (isAuth || this.retryCount > this.maxRetries || this.stopped) {
          throw err;
        }
        await this.postSystemMessage(
          `Error: ${err.message?.slice(0, 100)}. Retrying (${this.retryCount}/${this.maxRetries})...`,
        );
        await Bun.sleep(5000 * this.retryCount);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    try {
      this.abortController?.abort();
    } catch {}
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getSpaceToken(): string {
    return this.spaceToken;
  }

  cleanup(): void {
    if (this.tmuxMonitor) stopTmuxMonitor(this.tmuxMonitor);
    // Unregister project root from space MCP file tools (synchronous — uses static import).
    // Callers (.finally() in spawn-plugin/agent-mcp-tools) also delete synchronously first,
    // so this is belt-and-suspenders for any future callers that skip the synchronous delete.
    spaceProjectRoots.delete(this.config.space.id);
  }

  handleToolResult(toolName: string, toolInput: unknown, toolResponse: unknown, toolUseId?: string): void {
    const { space, agentId } = this.config;
    const input = (toolInput || {}) as Record<string, any>;
    const response = toolResponse as any;
    const status = response?.error ? "error" : "completed";
    const result = truncateToolResult(response);
    const description = formatToolDescription(toolName, input);

    console.log(`[claude-code] hook → ${status}: ${toolName} ${description.slice(0, 60)}`);
    broadcastAgentToolCall(space.space_channel, agentId, toolName, input, "started");
    broadcastAgentToolCall(space.space_channel, agentId, toolName, input, status, `${description}\n${result}`);
    saveToMemory(
      this.memorySessionId,
      "tool",
      `${description}\n${result}`,
      undefined,
      toolUseId || `tool_${toolName}_${Date.now()}`,
    );
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async runOnce(): Promise<void> {
    const { space, task, context, agentId, agentPrompt } = this.config;
    const prompt = context ? `**Context:**\n${context.slice(0, 4000)}\n\n**Task:** ${task}` : task;

    const shortId = space.id.slice(0, 8);
    const logFilePath = `/tmp/clawd-claude-code-log-${space.id}.jsonl`;
    this.tmuxMonitor = startTmuxMonitor(`cc-${shortId}`, logFilePath);

    setAgentStreaming(agentId, space.space_channel, true);
    broadcastAgentStreaming(space.space_channel, agentId, true);

    this.abortController = new AbortController();

    // Interrupt poller — aborts SDK query if human sends a message to the space channel
    let interrupted = false;
    let interruptMessages: string[] = [];
    const interruptPoller = setInterval(() => {
      try {
        const result = getPendingMessages(
          space.space_channel,
          this.lastHumanTs !== "0" ? this.lastHumanTs : undefined,
          false,
          20,
        );
        const humanMsgs = ((result as any).messages || []).filter((m: any) => m.user === "UHUMAN");
        if (humanMsgs.length > 0) {
          interrupted = true;
          // Accumulate messages (poller may fire multiple times before resume drains them)
          interruptMessages.push(...humanMsgs.map((m: any) => m.text));
          this.lastHumanTs = humanMsgs[humanMsgs.length - 1].ts;
          console.log(`[claude-code] Sub-agent interrupted by human message in ${space.space_channel}`);
          try {
            this.abortController?.abort();
          } catch {}
        }
      } catch {}
    }, 2000);

    // Register project root for space MCP file tools (before runSDKQuery)
    const effectiveProjectRoot = this.config.projectRoot || process.cwd();
    spaceProjectRoots.set(space.id, effectiveProjectRoot);

    // Build tool-restriction addendum (injected after the agent prompt when tools are restricted)
    const allowedTools = this.config.allowedTools;
    let toolAddendum = "";
    if (allowedTools && allowedTools.length > 0) {
      toolAddendum = `\n\nTOOL RESTRICTIONS: You may ONLY use the following tools: ${allowedTools.join(", ")}. Do NOT call any other tools.`;
    }

    // Custom scripts addendum
    let customScriptAddendum = "";
    try {
      const scriptCount = countCustomScripts(effectiveProjectRoot);
      if (scriptCount > 0) {
        customScriptAddendum = `\n\nYou have ${scriptCount} project-specific custom script${scriptCount === 1 ? "" : "s"} available via \`mcp__clawd__custom_script\`. Use it to list and execute them.`;
      }
    } catch {}

    const basePrompt = agentPrompt
      ? `${agentPrompt}${toolAddendum}${customScriptAddendum}\n\n---\n\n`
      : `You are an autonomous coding agent. Complete the given task using your tools.\n\nFor file operations within the project, prefer the MCP file tools (mcp__clawd__file_view, mcp__clawd__file_edit, mcp__clawd__file_multi_edit, mcp__clawd__file_create, mcp__clawd__file_glob, mcp__clawd__file_grep) — they are project-root-scoped and sandbox-safe. Use Bash only for system commands that cannot be done with file tools.${toolAddendum}${customScriptAddendum}\n\n`;

    // Shared SDK callbacks (reused across initial run and interrupt resumes)
    const sdkCallbacks = {
      onTextDelta: (text: string) => broadcastAgentToken(space.space_channel, agentId, text),
      onThinkingDelta: (text: string) => broadcastAgentToken(space.space_channel, agentId, text, "thinking"),
      onAssistantMessage: (content: any[]) => this.handleAssistantMessage(content),
      onToolResult: (name: string, input: unknown, response: unknown, id: string) =>
        this.handleToolResult(name, input, response, id),
      onActivity: () => {
        setAgentStreaming(agentId, space.space_channel, true);
      },
      onSessionId: (sid: string) => {
        this.sessionId = sid;
      },
    };

    const buildSdkOpts = (sdkPrompt: string) => ({
      prompt: sdkPrompt,
      model: this.config.model || "sonnet",
      cwd: effectiveProjectRoot,
      systemPrompt: basePrompt,
      providerName: this.config.providerName,
      agentName: "clawd-worker",
      agentDef: {
        "clawd-worker": {
          description: "Sub-agent worker for Claw'd",
          prompt: `${basePrompt}When your task is FULLY COMPLETE, you MUST call the MCP tool:
  mcp__clawd__complete_task(space_id="${space.id}", result="your summary here")

RULES:
- For file operations, use MCP file tools (mcp__clawd__file_view, mcp__clawd__file_edit, mcp__clawd__file_multi_edit, mcp__clawd__file_create, mcp__clawd__file_glob, mcp__clawd__file_grep); use Bash for system commands only
- Call complete_task ONCE when done — this is the ONLY way to signal completion
- If the task is unclear, do your best interpretation and complete
- Do NOT stop without calling complete_task`,
        },
      },
      mcpServers: this.buildMcpServers(),
      resume: this.sessionId || undefined,
      env: {
        CLAWD_SPACE_ID: space.id,
        CLAWD_SPACE_TOKEN: this.spaceToken,
      },
      abortController: this.abortController!,
      yolo: this.config.yolo ?? false,
      disallowedTools: this.config.disallowedTools,
    });

    try {
      // Run the initial prompt; if interrupted by human message, catch abort and resume below
      try {
        this.sessionId = await runSDKQuery(buildSdkOpts(prompt), sdkCallbacks);
      } catch (err: any) {
        // If this was a human-interrupt abort, fall through to the resume loop
        if (!interrupted) throw err;
        console.log(`[claude-code] Initial run aborted by human interrupt in ${space.space_channel}`);
      }

      // Resume loop — runs whenever the SDK was interrupted by a human message
      while (interrupted && !this.stopped) {
        if (!this.sessionId) {
          console.warn(`[claude-code] Resuming without session ID in ${space.space_channel} — starting fresh session`);
        }
        interrupted = false;
        this.abortController = new AbortController();
        // Drain accumulated messages and reset the buffer
        const pendingText = interruptMessages.join("\n");
        interruptMessages = [];
        const humanPrompt = `# New Messages on Channel\n\n${pendingText}\n\nPlease address these message(s). If they change your task, adjust accordingly. When done, call complete_task.`;
        console.log(`[claude-code] Resuming sub-agent with human message in ${space.space_channel}`);

        try {
          this.sessionId = await runSDKQuery(buildSdkOpts(humanPrompt), sdkCallbacks);
        } catch (err: any) {
          if (!interrupted) throw err;
          console.log(`[claude-code] Resume aborted by another human message in ${space.space_channel}`);
        }
      }
      // Warn if human message arrived at the exact completion boundary
      if (interrupted && this.stopped) {
        console.warn(
          `[claude-code] Human message in ${space.space_channel} arrived at completion boundary — not processed (space locked)`,
        );
      }
    } finally {
      clearInterval(interruptPoller);
      setAgentStreaming(agentId, space.space_channel, false);
      broadcastAgentStreaming(space.space_channel, agentId, false);
      if (this.tmuxMonitor) stopTmuxMonitor(this.tmuxMonitor);
    }
  }

  private handleAssistantMessage(content: any[]): void {
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) textParts.push(block.text);
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      }
    }
    if (textParts.length > 0 || toolCalls.length > 0) {
      saveToMemory(
        this.memorySessionId,
        "assistant",
        textParts.join("\n") || "",
        toolCalls.length > 0 ? toolCalls : undefined,
      );
    }
    // Post text blocks as chat messages
    for (const block of content) {
      if (block.type === "text" && block.text) {
        this.postAgentMessage(block.text);
      }
    }
  }

  private buildMcpServers(): Record<string, McpServerConfig> {
    let port = "3456";
    try {
      port = new URL(this.config.apiUrl).port || "3456";
    } catch {}

    const mcpServers: Record<string, any> = {
      clawd: {
        type: "http",
        url: `http://localhost:${port}/mcp/space/${this.config.space.id}`,
        headers: { Authorization: `Bearer ${this.spaceToken}` },
      },
    };

    // Merge channel-specific MCP servers from ~/.clawd/config.json
    try {
      const { getChannelMCPServers } = require("../agent/api/provider-config");
      const channelServers = getChannelMCPServers(this.config.space.channel);
      for (const [name, config] of Object.entries(channelServers)) {
        const cfg = config as any;
        if (cfg.enabled === false) continue;
        if (name === "clawd") continue;

        if (cfg.transport === "sse") {
          console.warn(
            `[claude-code-worker] MCP server "${name}" uses SSE transport (not supported by Claude Code SDK), skipping`,
          );
          continue;
        } else if (cfg.transport === "http" || cfg.type === "http") {
          if (!cfg.url) {
            console.warn(`[claude-code-worker] MCP server "${name}" missing url, skipping`);
            continue;
          }
          const entry: any = { type: "http", url: cfg.url };
          const headers: Record<string, string> = { ...(cfg.headers || {}) };
          if (cfg.oauth?.client_id) {
            const stored = loadOAuthToken(this.config.space.channel, name);
            if (!stored?.access_token) {
              console.log(`[claude-code-worker] Skipping MCP server ${name} (no OAuth token — connect via UI)`);
              continue;
            }
            headers["Authorization"] = `Bearer ${stored.access_token}`;
          }
          if (Object.keys(headers).length) entry.headers = headers;
          mcpServers[name] = entry;
        } else {
          if (!cfg.command) {
            console.warn(`[claude-code-worker] MCP server "${name}" missing command, skipping`);
            continue;
          }
          const entry: any = { command: cfg.command, args: cfg.args || [] };
          if (cfg.env) entry.env = cfg.env;
          mcpServers[name] = entry;
        }
      }
    } catch (err) {
      console.error(`[claude-code-worker] Failed to load channel MCP servers for ${this.config.space.channel}:`, err);
    }

    return mcpServers;
  }

  private async postAgentMessage(text: string): Promise<void> {
    if (!text) return;
    try {
      await timedFetch(`${this.config.apiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: this.config.space.space_channel,
          text,
          user: this.config.agentId,
          agent_id: this.config.agentId,
        }),
      });
    } catch {}
  }

  private async postSystemMessage(text: string): Promise<void> {
    try {
      await timedFetch(`${this.config.apiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: this.config.space.space_channel,
          text: `_${text}_`,
          user: "UBOT",
        }),
      });
    } catch {}
  }
}

// ============================================================================
// Worker Registry
// ============================================================================

const activeWorkers = new Map<string, ClaudeCodeSpaceWorker>();

export function registerClaudeCodeWorker(spaceId: string, worker: ClaudeCodeSpaceWorker): void {
  activeWorkers.set(spaceId, worker);
}

export function unregisterClaudeCodeWorker(spaceId: string): void {
  activeWorkers.delete(spaceId);
}

export function getClaudeCodeWorker(spaceId: string): ClaudeCodeSpaceWorker | undefined {
  return activeWorkers.get(spaceId);
}
