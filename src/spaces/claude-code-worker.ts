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
import type { Space } from "./db";
import type { SpaceManager } from "./manager";

// Re-export utils for backward compatibility (main-worker, spawn-plugin import from here)
export { hasTmux, truncateToolResult, formatToolDescription };

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
    let interruptMessage = "";
    const interruptPoller = setInterval(() => {
      try {
        const { getPendingMessages } = require("../server/routes/messages");
        const result = getPendingMessages(space.space_channel, undefined, false, 10);
        const humanMsgs = ((result as any).messages || []).filter(
          (m: any) => m.user === "UHUMAN" && m.ts > (this.lastHumanTs || "0"),
        );
        if (humanMsgs.length > 0) {
          interrupted = true;
          interruptMessage = humanMsgs.map((m: any) => m.text).join("\n");
          this.lastHumanTs = humanMsgs[humanMsgs.length - 1].ts;
          console.log(`[claude-code] Sub-agent interrupted by human message in ${space.space_channel}`);
          try {
            this.abortController?.abort();
          } catch {}
        }
      } catch {}
    }, 2000);

    const basePrompt = agentPrompt
      ? `${agentPrompt}\n\n---\n\n`
      : "You are an autonomous coding agent. Complete the given task using your tools (Read, Write, Edit, Bash, Grep, Glob, etc.).\n\n";

    try {
      this.sessionId = await runSDKQuery(
        {
          prompt,
          model: this.config.model || "sonnet",
          cwd: this.config.projectRoot || process.cwd(),
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
          onActivity: () => {
            setAgentStreaming(agentId, space.space_channel, true);
          },
          onSessionId: (sid) => {
            this.sessionId = sid;
          },
        },
      );

      // If interrupted by human, resume with the human's message
      while (interrupted && !this.stopped) {
        interrupted = false;
        this.abortController = new AbortController();
        const humanPrompt = `[HUMAN INTERRUPT] The user sent a new message while you were working:\n\n${interruptMessage}\n\nPlease address this message. If it changes your task, adjust accordingly. When done, call complete_task.`;
        console.log(`[claude-code] Resuming sub-agent with human interrupt in ${space.space_channel}`);

        this.sessionId = await runSDKQuery(
          {
            prompt: humanPrompt,
            model: this.config.model || "sonnet",
            cwd: this.config.projectRoot || process.cwd(),
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
            onActivity: () => {
              setAgentStreaming(agentId, space.space_channel, true);
            },
            onSessionId: (sid) => {
              this.sessionId = sid;
            },
          },
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
