/**
 * Claude Code Main Worker
 *
 * Runs a Claude Code agent via the official SDK as a main channel agent.
 * Polls for messages, runs SDK query() per interaction, and lets Claude Code
 * communicate via Claw'd's MCP tools (chat_send_message, chat_mark_processed, etc.).
 */

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentFileConfig } from "./agent/agents/loader";
import {
  broadcastAgentStreaming,
  broadcastAgentToken,
  broadcastAgentToolCall,
  broadcastMessageSeen,
  broadcastUpdate,
} from "./server/websocket";
import { db, getAgent, markMessagesSeen, setAgentStreaming } from "./server/database";
import { getPendingMessages } from "./server/routes/messages";
import { truncateToolResult, formatToolDescription, findClaudeCodeCLI } from "./claude-code-utils";
import { initMemorySession, saveToMemory } from "./claude-code-memory";
import { runSDKQuery } from "./claude-code-sdk";
import type { AgentHealthSnapshot, AgentWorker } from "./worker-loop";

// ============================================================================
// Constants
// ============================================================================

const SLEEP_BACKOFF_MS = 3000;
const MAX_FORCE_MARK_RETRIES = 3;
const MAX_MESSAGE_LENGTH = 10000;
const MAX_COMBINED_PROMPT_LENGTH = 40000;

// ============================================================================
// Types
// ============================================================================

export interface ClaudeCodeMainConfig {
  channel: string;
  agentId: string;
  model: string;
  projectRoot: string;
  chatApiUrl: string;
  debug: boolean;
  agentFileConfig?: AgentFileConfig;
  heartbeatInterval?: number;
}

// ============================================================================
// Worker
// ============================================================================

export class ClaudeCodeMainWorker implements AgentWorker {
  private config: ClaudeCodeMainConfig;
  private sessionId: string | null = null;
  private running = false;
  private sleeping = false;
  private processing = false;
  private lastActivityAt = Date.now();
  private processingStartedAt: number | null = null;
  private lastHeartbeatAt = Date.now();
  private stopped = false;
  private heartbeatPending = false;
  private memorySessionId: string | null = null;
  private pendingTimestamps: string[] = [];
  private forceMarkRetries = new Map<string, number>();
  private abortController: AbortController | null = null;

  constructor(config: ClaudeCodeMainConfig) {
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // AgentWorker interface
  // --------------------------------------------------------------------------

  get isSleeping(): boolean {
    return this.sleeping;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get heartbeatInterval(): number {
    return this.config.heartbeatInterval || 0;
  }

  setSleeping(sleeping: boolean): void {
    this.sleeping = sleeping;
    if (sleeping) {
      const agent = getAgent(this.config.agentId, this.config.channel);
      if (agent) {
        broadcastUpdate(this.config.channel, {
          ts: "",
          type: "message",
          user: this.config.agentId,
          text: "",
          agent_id: this.config.agentId,
          avatar_color: agent.avatar_color || "#D97706",
          is_sleeping: true,
        } as any);
      }
    }
  }

  getHealthSnapshot(): AgentHealthSnapshot {
    return {
      processing: this.processing,
      processingDurationMs: this.processingStartedAt ? Date.now() - this.processingStartedAt : null,
      lastActivityAt: this.lastActivityAt,
      idleDurationMs: Date.now() - this.lastActivityAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      sleeping: this.sleeping,
      running: this.running,
      isSpaceAgent: false,
      channel: this.config.channel,
      agentId: this.config.agentId,
      lastExecutionHadError: false,
    };
  }

  cancelProcessing(): void {
    try {
      this.abortController?.abort();
    } catch {}
  }

  getProjectRoot(): string {
    return this.config.projectRoot;
  }

  async resetSession(): Promise<void> {
    this.sessionId = null;
    this.persistSessionId(null);
  }

  injectHeartbeat(): void {
    this.lastHeartbeatAt = Date.now();
    this.heartbeatPending = true;
  }

  // --------------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!findClaudeCodeCLI()) {
      console.error(`[claude-code-main] CLI not found for ${this.config.channel}:${this.config.agentId}`);
      return;
    }

    this.running = true;
    this.restoreSessionId();
    const sessionName = `${this.config.channel}-${this.config.agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;
    this.memorySessionId = initMemorySession(sessionName, this.config.model);

    console.log(
      `[claude-code-main] Started: ${this.config.channel}:${this.config.agentId}` +
        (this.sessionId ? ` (resuming session ${this.sessionId.slice(0, 8)}...)` : " (new session)"),
    );

    while (this.running) {
      try {
        let pending = this.pollForMessages();

        if (pending.length === 0 && this.heartbeatPending) {
          this.heartbeatPending = false;
          this.sleeping = false;
          pending = [{ ts: String(Date.now()), user: "UHUMAN", text: "[HEARTBEAT]" }];
        }

        if (pending.length === 0) {
          if (!this.sleeping) this.sleeping = true;
          // Keep agent_seen.updated_at fresh so listAgents() doesn't
          // mark us as sleeping while we're still polling for sub-agent results
          this.touchActivity();
          await Bun.sleep(SLEEP_BACKOFF_MS);
          continue;
        }

        this.sleeping = false;
        this.processing = true;
        this.processingStartedAt = Date.now();
        this.lastActivityAt = Date.now();
        this.pendingTimestamps = pending.map((m: any) => m.ts);

        // Mark messages as seen and broadcast to UI
        try {
          const tsList = pending.map((m: any) => m.ts);
          const newlySeen = markMessagesSeen(this.config.channel, this.config.agentId, tsList);
          if (newlySeen.length > 0) {
            const lastHumanTs = pending.filter((m: any) => m.user === "UHUMAN").slice(-1)[0]?.ts;
            if (lastHumanTs && newlySeen.includes(lastHumanTs)) {
              broadcastMessageSeen(this.config.channel, lastHumanTs, this.config.agentId);
            }
          }
        } catch {}

        setAgentStreaming(this.config.agentId, this.config.channel, true);
        broadcastAgentStreaming(this.config.channel, this.config.agentId, true);

        // Interrupt poller — aborts SDK query if new messages arrive
        let interrupted = false;
        const interruptPoller = setInterval(() => {
          if (!this.processing) return;
          const newPending = this.pollForMessages();
          const newMessages = newPending.filter((m: any) => !this.pendingTimestamps.includes(m.ts));
          if (newMessages.length > 0) {
            interrupted = true;
            console.log(`[claude-code-main] Interrupted by ${newMessages.length} new message(s)`);
            try {
              this.abortController?.abort();
            } catch {}
          }
        }, 2000);

        try {
          await this.processMessages(pending);
        } catch (err: any) {
          if (!interrupted) {
            console.error(`[claude-code-main] Error: ${err.message}`);
            // Clear stale session ID so next attempt starts fresh
            if (err.message?.includes("No conversation found")) {
              console.warn(`[claude-code-main] Stale session — resetting for fresh start`);
              this.sessionId = null;
              this.persistSessionId(null);
            }
          }
        } finally {
          clearInterval(interruptPoller);
          setAgentStreaming(this.config.agentId, this.config.channel, false);
          broadcastAgentStreaming(this.config.channel, this.config.agentId, false);
          this.processing = false;
          this.processingStartedAt = null;
          this.lastActivityAt = Date.now();
        }

        if (interrupted) continue;
        this.forceMarkUnprocessed();
      } catch (err: any) {
        console.error(`[claude-code-main] Poll error: ${err.message}`);
        await Bun.sleep(200);
      }
    }

    console.log(`[claude-code-main] Stopped: ${this.config.channel}:${this.config.agentId}`);
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    this.cancelProcessing();
  }

  // --------------------------------------------------------------------------
  // Tool result handler (called by PostToolUse hook in-process)
  // --------------------------------------------------------------------------

  handleToolResult(toolName: string, toolInput: unknown, toolResponse: unknown, toolUseId?: string): void {
    const { channel, agentId } = this.config;
    const input = (toolInput || {}) as Record<string, any>;
    const response = toolResponse as any;
    const status = response?.error ? "error" : "completed";
    const result = truncateToolResult(response);
    const description = formatToolDescription(toolName, input);

    broadcastAgentToolCall(channel, agentId, toolName, input, "started");
    broadcastAgentToolCall(channel, agentId, toolName, input, status, `${description}\n${result}`);
    saveToMemory(
      this.memorySessionId,
      "tool",
      `${description}\n${result}`,
      undefined,
      toolUseId || `tool_${toolName}_${Date.now()}`,
    );
  }

  // --------------------------------------------------------------------------
  // Message processing
  // --------------------------------------------------------------------------

  private pollForMessages(): any[] {
    const { channel, agentId } = this.config;
    const seen = db
      .query<{ last_processed_ts: string | null }, [string, string]>(
        `SELECT last_processed_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
      )
      .get(agentId, channel);
    const lastTs = seen?.last_processed_ts || undefined;

    const result = getPendingMessages(channel, lastTs, false, 50);
    const pending = ((result as any).messages || []).filter(
      (m: any) => m.ts > (lastTs || "0") && (m.user === "UHUMAN" || (m.agent_id && m.agent_id !== agentId)),
    );
    return pending;
  }

  private async processMessages(messages: any[]): Promise<void> {
    const prompt = this.formatPrompt(messages);
    saveToMemory(this.memorySessionId, "user", prompt);

    this.abortController = new AbortController();
    const { channel, agentId, model, agentFileConfig } = this.config;
    const basePrompt = agentFileConfig?.systemPrompt ? `${agentFileConfig.systemPrompt}\n\n---\n\n` : "";

    const newSessionId = await runSDKQuery(
      {
        prompt,
        model: model || "sonnet",
        cwd: this.config.projectRoot,
        systemPrompt: basePrompt,
        agentName: "clawd-main",
        agentDef: {
          "clawd-main": {
            description: "Main channel agent for Claw'd",
            prompt: `${basePrompt}You are a main channel agent. Respond to user messages and complete tasks.

COMMUNICATION — Use these MCP tools (channel and agent_id are auto-injected):
- mcp__clawd__chat_send_message(text="...") — respond to users
- mcp__clawd__chat_mark_processed(timestamp="...") — acknowledge each message

CRITICAL RULES:
1. After processing EACH user message, you MUST call chat_mark_processed with its timestamp (shown in [ts] prefix).
2. Send your response via chat_send_message BEFORE calling chat_mark_processed.
3. You have full coding tools (Read, Write, Edit, Bash, Grep, Glob, etc.) for working with the codebase.
4. For complex tasks, use mcp__clawd__claude_code to spawn sub-agents.
5. Do NOT use the Agent tool — use mcp__clawd__claude_code instead for sub-agents.`,
          },
        },
        mcpServers: this.buildMcpServers(),
        resume: this.sessionId || undefined,
        abortController: this.abortController,
      },
      {
        onTextDelta: (text) => broadcastAgentToken(channel, agentId, text),
        onThinkingDelta: (text) => broadcastAgentToken(channel, agentId, text, "thinking"),
        onAssistantMessage: (content) => this.handleAssistantMessage(content),
        onToolResult: (name, input, response, id) => this.handleToolResult(name, input, response, id),
        onSessionId: (sid) => {
          if (sid) {
            this.sessionId = sid;
            this.persistSessionId(sid);
          } else {
            // SDK cleared stale session — reset
            this.sessionId = null;
            this.persistSessionId(null);
          }
        },
      },
    );

    if (newSessionId) {
      this.sessionId = newSessionId;
      this.persistSessionId(newSessionId);
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
  }

  private formatPrompt(messages: any[]): string {
    const parts: string[] = [];
    parts.push(`# New Messages on Channel "${this.config.channel}"\n`);

    let totalLen = 0;
    for (const msg of messages) {
      const user = msg.user === "UHUMAN" ? "human" : msg.agent_id || msg.user || "unknown";
      let text = msg.text || "";
      if (text.length > MAX_MESSAGE_LENGTH) {
        text = text.slice(0, MAX_MESSAGE_LENGTH) + "\n[truncated]";
      }
      const line = `[${msg.ts}] ${user}: ${text}`;
      if (totalLen + line.length > MAX_COMBINED_PROMPT_LENGTH) break;
      parts.push(line);
      totalLen += line.length;
    }

    return parts.join("\n");
  }

  private buildMcpServers(): Record<string, McpServerConfig> {
    let port = "3456";
    try {
      port = new URL(this.config.chatApiUrl).port || "3456";
    } catch {}
    const { channel, agentId } = this.config;

    const mcpServers: Record<string, any> = {
      clawd: {
        type: "http",
        url: `http://localhost:${port}/mcp/agent/${encodeURIComponent(channel)}/${encodeURIComponent(agentId)}`,
      },
    };

    // Merge channel-specific MCP servers from config.json
    try {
      const { getChannelMCPServers } = require("./agent/api/provider-config");
      const channelServers = getChannelMCPServers(channel);
      for (const [name, config] of Object.entries(channelServers)) {
        const cfg = config as any;
        if (cfg.enabled === false) continue;
        if (name === "clawd") continue;

        if (cfg.transport === "http" || cfg.type === "http") {
          const entry: any = { type: "http", url: cfg.url };
          if (cfg.headers) entry.headers = cfg.headers;
          mcpServers[name] = entry;
        } else {
          const entry: any = { command: cfg.command, args: cfg.args || [] };
          if (cfg.env) entry.env = cfg.env;
          mcpServers[name] = entry;
        }
      }
    } catch {}

    return mcpServers;
  }

  // --------------------------------------------------------------------------
  // Activity tracking
  // --------------------------------------------------------------------------

  private lastTouchAt = 0;

  /** Throttled update to agent_seen.updated_at — keeps the agent "alive" in listAgents() */
  private touchActivity(): void {
    const now = Date.now();
    if (now - this.lastTouchAt < 30_000) return; // Throttle: once per 30s
    this.lastTouchAt = now;
    try {
      db.run(
        `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, updated_at)
         VALUES (?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
         ON CONFLICT(agent_id, channel) DO UPDATE SET updated_at = strftime('%s', 'now')`,
        [this.config.agentId, this.config.channel],
      );
    } catch {}
  }

  // --------------------------------------------------------------------------
  // Session & failsafe
  // --------------------------------------------------------------------------

  private persistSessionId(sessionId: string | null): void {
    try {
      db.run(`UPDATE channel_agents SET claude_code_session_id = ? WHERE channel = ? AND agent_id = ?`, [
        sessionId,
        this.config.channel,
        this.config.agentId,
      ]);
    } catch {}
  }

  private restoreSessionId(): void {
    try {
      const row = db
        .query<{ claude_code_session_id: string | null }, [string, string]>(
          `SELECT claude_code_session_id FROM channel_agents WHERE channel = ? AND agent_id = ?`,
        )
        .get(this.config.channel, this.config.agentId);
      if (row?.claude_code_session_id) {
        this.sessionId = row.claude_code_session_id;
      }
    } catch {}
  }

  private forceMarkUnprocessed(): void {
    for (const ts of this.pendingTimestamps) {
      const retries = this.forceMarkRetries.get(ts) || 0;
      if (retries >= MAX_FORCE_MARK_RETRIES) {
        try {
          db.run(
            `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
             VALUES (?, ?, ?, ?, strftime('%s', 'now'))
             ON CONFLICT(agent_id, channel) DO UPDATE SET
               last_processed_ts = MAX(last_processed_ts, ?),
               updated_at = strftime('%s', 'now')`,
            [this.config.agentId, this.config.channel, ts, ts, ts],
          );
          console.warn(`[claude-code-main] Force-marked ts=${ts} after ${MAX_FORCE_MARK_RETRIES} retries`);
        } catch {}
        this.forceMarkRetries.delete(ts);
      } else {
        this.forceMarkRetries.set(ts, retries + 1);
      }
    }
    this.pendingTimestamps = [];
  }
}

// ============================================================================
// Worker Registry (for hook API lookups)
// ============================================================================

const activeMainWorkers = new Map<string, ClaudeCodeMainWorker>();

export function registerMainWorker(key: string, worker: ClaudeCodeMainWorker): void {
  activeMainWorkers.set(key, worker);
}

export function unregisterMainWorker(key: string): void {
  activeMainWorkers.delete(key);
}

export function getMainWorker(key: string): ClaudeCodeMainWorker | undefined {
  return activeMainWorkers.get(key);
}
