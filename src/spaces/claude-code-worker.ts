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
import { truncateToolResult, formatToolDescription, findClaudeCodeCLI, hasTmux } from "../claude-code-utils";
import { initMemorySession, saveToMemory } from "../claude-code-memory";
import { startTmuxMonitor, stopTmuxMonitor, type TmuxMonitor } from "../claude-code-tmux";
import { runSDKQuery } from "../claude-code-sdk";
import type { Space } from "./db";
import type { SpaceManager } from "./manager";

// Re-export utils for backward compatibility (main-worker, spawn-plugin import from here)
export { findClaudeCodeCLI, hasTmux, truncateToolResult, formatToolDescription };

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
  spaceManager: SpaceManager;
  resolve: (summary: string) => void;
  onComplete?: () => void;
  agentPrompt?: string;
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

  constructor(config: ClaudeCodeWorkerConfig) {
    this.config = config;
    this.spaceToken = crypto.randomUUID();
    const sessionName = `${config.space.space_channel}-${config.agentId}`.replace(/[^a-zA-Z0-9-]/g, "_");
    this.memorySessionId = initMemorySession(sessionName, "claude-code");
  }

  async start(): Promise<void> {
    // Verify CLI is installed (SDK bundles its own, but check user's for compatibility)
    if (!findClaudeCodeCLI()) {
      throw new Error(
        "Claude Code CLI not installed. Install: npm install -g @anthropic-ai/claude-code, then run: claude /login",
      );
    }

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

    const basePrompt = agentPrompt
      ? `${agentPrompt}\n\n---\n\n`
      : "You are an autonomous coding agent. Complete the given task using your tools (Read, Write, Edit, Bash, Grep, Glob, etc.).\n\n";

    try {
      this.sessionId = await runSDKQuery(
        {
          prompt,
          model: this.config.model || "sonnet",
          cwd: this.config.spaceManager?.getWorkingDirectory?.() || process.cwd(),
          systemPrompt: basePrompt,
          agentName: "clawd-worker",
          agentDef: {
            "clawd-worker": {
              description: "Sub-agent worker for Claw'd",
              prompt: `${basePrompt}When your task is FULLY COMPLETE, you MUST call the MCP tool:
  mcp__clawd__complete_task(space_id="${space.id}", result="your summary here")

RULES:
- Do your work using built-in tools (Read, Edit, Bash, etc.)
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
          abortController: this.abortController,
        },
        {
          onTextDelta: (text) => broadcastAgentToken(space.space_channel, agentId, text),
          onThinkingDelta: (text) => broadcastAgentToken(space.space_channel, agentId, text, "thinking"),
          onAssistantMessage: (content) => this.handleAssistantMessage(content),
          onToolResult: (name, input, response, id) => this.handleToolResult(name, input, response, id),
          onSessionId: (sid) => {
            this.sessionId = sid;
          },
        },
      );
    } finally {
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
    return {
      clawd: {
        type: "http",
        url: `http://localhost:${port}/mcp/space/${this.config.space.id}`,
        headers: { Authorization: `Bearer ${this.spaceToken}` },
      } as McpServerConfig,
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
