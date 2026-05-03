/**
 * Claude Code Space Worker
 *
 * Runs a Claude Code agent via the official SDK to handle a task within a Claw'd Space.
 * All output is streamed to the UI via WebSocket events.
 */

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_API_PORT,
  HEALTH_CHECK_INTERVAL_MS,
  MAX_CONTEXT_LENGTH,
  RETRY_BACKOFF_MS,
} from "../agent/constants/spaces";
import { countCustomScripts } from "../agent/plugins/custom-tool-plugin";
import { initMemorySession, saveToMemory } from "../claude-code/memory";
import { runSDKQuery } from "../claude-code/sdk";
import { startTmuxMonitor, stopTmuxMonitor, type TmuxMonitor } from "../claude-code/tmux";
import { formatToolDescription, hasTmux, truncateToolResult } from "../claude-code/utils";

import { getAgent, setAgentStreaming } from "../server/database";
import { spaceProjectRoots } from "../server/mcp";
import { getPendingMessages } from "../server/routes/messages";
import { broadcastAgentStreaming, broadcastAgentToken, broadcastAgentToolCall } from "../server/websocket";
import { timedFetch } from "../utils/timed-fetch";
import type { Space } from "./db";
import type { SpaceManager } from "./manager";

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
  WebSearch: "mcp__clawd__web_search",
  WebFetch: "mcp__clawd__web_fetch",
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
  // Avatar color cache: resolve once per worker, skip per-token getAgent() SQLite
  // SELECT in broadcast paths. Same pattern as ClaudeCodeMainWorker.getAvatarColor().
  // Only set once a non-fallback color is resolved — guards against the agent-row
  // not yet existing at first-token time (would otherwise pin the fallback color
  // for the whole worker lifetime).
  private _cachedAvatarColor?: string;

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
      } catch (err: unknown) {
        this.retryCount++;
        const errMsg = err instanceof Error ? err.message : String(err);
        const isAuth = errMsg.includes("Not logged in") || errMsg.includes("/login");
        if (isAuth || this.retryCount > this.maxRetries || this.stopped) {
          throw err;
        }
        await this.postSystemMessage(
          `Error: ${errMsg.slice(0, 100)}. Retrying (${this.retryCount}/${this.maxRetries})...`,
        );
        await Bun.sleep(RETRY_BACKOFF_MS * this.retryCount);
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

  /**
   * Resolve avatar color once and cache; only persist a real DB-resolved value
   * so a transient null at first-token time doesn't pin the fallback for the
   * worker's lifetime. Returns the fallback uncached if the row is still missing.
   */
  private getAvatarColor(): string {
    if (this._cachedAvatarColor) return this._cachedAvatarColor;
    const color = getAgent(this.config.agentId, this.config.space.space_channel)?.avatar_color;
    if (color) {
      this._cachedAvatarColor = color;
      return color;
    }
    return "#D97853";
  }

  cleanup(): void {
    if (this.tmuxMonitor) stopTmuxMonitor(this.tmuxMonitor);
    // Unregister project root from space MCP file tools (synchronous — uses static import).
    // Callers (.finally() in spawn-plugin/agent-mcp-tools) also delete synchronously first,
    // so this is belt-and-suspenders for any future callers that skip the synchronous delete.
    spaceProjectRoots.delete(this.config.space.id);
  }

  /** PreToolUse: fires before the tool actually runs so the UI can render a
   *  "running" indicator before the terminal status arrives from PostToolUse. */
  handleToolStart(toolName: string, toolInput: unknown, toolUseId?: string): void {
    const { space, agentId } = this.config;
    const input = (toolInput || {}) as Record<string, any>;
    broadcastAgentToolCall(
      space.space_channel,
      agentId,
      toolName,
      input,
      "started",
      undefined,
      toolUseId,
      this.getAvatarColor(),
    );
  }

  handleToolResult(toolName: string, toolInput: unknown, toolResponse: unknown, toolUseId?: string): void {
    const { space, agentId } = this.config;
    const input = (toolInput || {}) as Record<string, any>;
    const response = toolResponse as any;
    const result = truncateToolResult(response);
    // Match main-worker's error detection — SDK-level errors surface as `isError: true`
    // on the response, and some MCP tools return `"Error: ..."` text payloads.
    const status = response?.error || response?.isError || result.startsWith("Error: ") ? "error" : "completed";
    const description = formatToolDescription(toolName, input);

    console.log(`[claude-code] hook → ${status}: ${toolName} ${description.slice(0, 60)}`);
    broadcastAgentToolCall(
      space.space_channel,
      agentId,
      toolName,
      input,
      status,
      `${description}\n${result}`,
      toolUseId,
      this.getAvatarColor(),
    );
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
    const prompt = context ? `**Context:**\n${context.slice(0, MAX_CONTEXT_LENGTH)}\n\n**Task:** ${task}` : task;

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
    }, HEALTH_CHECK_INTERVAL_MS);

    // Register project root for space MCP file tools (before runSDKQuery)
    if (!this.config.projectRoot) {
      throw new Error(
        `[ClaudeCodeSpaceWorker] projectRoot is required but was not provided for space ${space.id}. ` +
          `Ensure the agent's channel_agents.project column is set in the database.`,
      );
    }
    const effectiveProjectRoot = this.config.projectRoot;
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

    // Inject ## Naming section so sub-agents know where to write outputs
    // (Claude Code hooks inject this via session-init.cjs, but Claw'd bypasses those hooks)
    const today = new Date().toISOString().slice(0, 10);
    const namingSection = agentPrompt
      ? `\n\n## Naming\n- Date: ${today}\n- Reports path: ${effectiveProjectRoot}/reports/\n- Plans path: ${effectiveProjectRoot}/plans/\n- Pattern: {date}-{slug}.md\n- NEVER write to ~/home, ~/plans, ~/research, or any user home directory\n- ALL outputs MUST be relative to the project root: ${effectiveProjectRoot}\n`
      : "";

    const basePrompt = agentPrompt
      ? `${agentPrompt}${namingSection}${toolAddendum}${customScriptAddendum}\n\n---\n\n`
      : `You are an autonomous coding agent. Complete the given task using your tools.\n\nFor file operations within the project, prefer the MCP file tools (mcp__clawd__file_view, mcp__clawd__file_edit, mcp__clawd__file_multi_edit, mcp__clawd__file_create, mcp__clawd__file_glob, mcp__clawd__file_grep) — they are project-root-scoped and sandbox-safe. Use Bash only for system commands that cannot be done with file tools.${toolAddendum}${customScriptAddendum}\n\n`;

    // Shared SDK callbacks (reused across initial run and interrupt resumes)
    const sdkCallbacks = {
      onTextDelta: (text: string) =>
        broadcastAgentToken(space.space_channel, agentId, text, "content", this.getAvatarColor()),
      onThinkingDelta: (text: string) =>
        broadcastAgentToken(space.space_channel, agentId, text, "thinking", this.getAvatarColor()),
      onAssistantMessage: (content: any[]) => this.handleAssistantMessage(content),
      onToolStart: (name: string, input: unknown, id: string) => this.handleToolStart(name, input, id),
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
      } catch (err: unknown) {
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
        } catch (err: unknown) {
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
    let port = DEFAULT_API_PORT;
    try {
      port = new URL(this.config.apiUrl).port || DEFAULT_API_PORT;
    } catch {}

    // Only the clawd space MCP server is passed to the CC SDK.
    // Channel MCP servers are proxied through the space MCP endpoint
    // (same architecture as main worker — avoids double-exposure and
    // prevents external server failures from blocking clawd tools).
    return {
      clawd: {
        type: "http",
        url: `http://localhost:${port}/mcp/space/${this.config.space.id}`,
        headers: { Authorization: `Bearer ${this.spaceToken}` },
      },
    };
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
