/**
 * Claude Code Main Worker
 *
 * Runs a Claude Code agent via the official SDK as a main channel agent.
 * Polls for messages, runs SDK query() per interaction, and lets Claude Code
 * communicate via Claw'd's MCP tools (chat_send_message, chat_mark_processed, etc.).
 */

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentFileConfig, buildAgentSystemPrompt, listAgentFiles, loadAgentFile } from "./agent/agents/loader";
import { buildDynamicSystemPrompt, type PromptContext } from "./agent/prompt/builder";
import {
  broadcastAgentStreaming,
  broadcastAgentToken,
  broadcastAgentToolCall,
  broadcastMessageSeen,
  broadcastUpdate,
} from "./server/websocket";
import { db, getAgent, markMessagesSeen, setAgentStreaming } from "./server/database";
import { getPendingMessages } from "./server/routes/messages";
import { truncateToolResult, formatToolDescription } from "./claude-code-utils";
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
const MAX_WAKEUP_MESSAGES = 3; // On wakeup, only process this many recent messages

// ============================================================================
// Types
// ============================================================================

export interface ClaudeCodeMainConfig {
  channel: string;
  agentId: string;
  model: string;
  provider?: string;
  projectRoot: string;
  chatApiUrl: string;
  debug: boolean;
  agentFileConfig?: AgentFileConfig;
  heartbeatInterval?: number;
  /** When false (default), sandbox restrictions apply. When true, bypasses all permission checks. */
  yolo?: boolean;
}

// ============================================================================
// Worker
// ============================================================================

export class ClaudeCodeMainWorker implements AgentWorker {
  private config: ClaudeCodeMainConfig;
  private sessionId: string | null = null;
  private running = false;
  private sleeping = false;
  private userSleeping = false; // Explicitly put to sleep by user — don't auto-wake
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
  private wasCancelledByHeartbeat = false;
  // Re-injection state: track per-turn whether chat_send_message was called
  private turnChatSent = false;
  private turnStreamText = "";

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
    this.userSleeping = sleeping;
    if (sleeping) {
      // Cancel in-flight processing
      try {
        this.abortController?.abort();
      } catch {}
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
    this.wasCancelledByHeartbeat = true;
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
    if (this.processing || this.sleeping) return;
    this.lastHeartbeatAt = Date.now();
    this.heartbeatPending = true;
  }

  // --------------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
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
        // Skip polling entirely when user has put the agent to sleep
        if (this.userSleeping) {
          await Bun.sleep(5000);
          continue;
        }

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

        if (this.sleeping) {
          this.sleeping = false;
          const agent = getAgent(this.config.agentId, this.config.channel);
          if (agent) {
            broadcastUpdate(this.config.channel, {
              type: "message",
              ts: "",
              user: this.config.agentId,
              text: "",
              agent_id: this.config.agentId,
              avatar_color: agent.avatar_color || "#D97706",
              is_sleeping: false,
            } as any);
          }

          // Wakeup handling: if many messages accumulated during sleep,
          // skip old ones and only process recent messages with context
          if (pending.length > MAX_WAKEUP_MESSAGES) {
            const skipped = pending.length - MAX_WAKEUP_MESSAGES;
            const skippedMessages = pending.slice(0, skipped);
            pending = pending.slice(skipped);

            // Mark skipped messages as processed so they don't reappear
            const lastSkippedTs = skippedMessages[skippedMessages.length - 1].ts;
            try {
              db.run(
                `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
                 VALUES (?, ?, ?, ?, strftime('%s', 'now'))
                 ON CONFLICT(agent_id, channel) DO UPDATE SET
                   last_processed_ts = MAX(last_processed_ts, ?),
                   updated_at = strftime('%s', 'now')`,
                [this.config.agentId, this.config.channel, lastSkippedTs, lastSkippedTs, lastSkippedTs],
              );
            } catch {}

            // Build a conversation summary of skipped messages
            const convoLines: string[] = [];
            for (const m of skippedMessages) {
              const user = m.user === "UHUMAN" ? "Human" : m.agent_id || m.user || "unknown";
              const text = (m.text || "").slice(0, 200).replace(/\n/g, " ");
              convoLines.push(`${user}: ${text}`);
            }
            const summary = convoLines.join("\n");

            pending.unshift({
              ts: "0",
              user: "UHUMAN",
              text: [
                `[WAKEUP] You've just woken up from sleep.`,
                ``,
                `While you were sleeping, ${skipped} message(s) were exchanged on this channel.`,
                `Here is a summary of the conversation you missed (already processed — do NOT call chat_mark_processed for any of these):`,
                ``,
                `--- Missed conversation ---`,
                summary,
                `--- End of missed conversation ---`,
                ``,
                `Now focus ONLY on the new message(s) below. Use the missed conversation as context to understand what happened, but only respond to the new messages. If something from the missed conversation still needs your attention, the user will ask again.`,
              ].join("\n"),
            });

            console.log(
              `[claude-code-main] Wakeup: skipped ${skipped} old messages, processing ${pending.length - 1} recent`,
            );
          }
        }
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
          if (!interrupted && !this.wasCancelledByHeartbeat) {
            console.error(`[claude-code-main] Error: ${err.message}`);
            // Clear stale/corrupted session so next attempt starts fresh
            const msg = err.message || "";
            if (msg.includes("No conversation found") || msg.includes("Invalid `signature` in `thinking` block")) {
              console.warn(`[claude-code-main] Corrupted session — resetting for fresh start`);
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

    // Track whether the agent successfully sent a message this turn (CC SDK uses mcp__ prefix)
    if (toolName === "mcp__clawd__chat_send_message" && !response?.error) {
      this.turnChatSent = true;
    }

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
    this.wasCancelledByHeartbeat = false;
    const prompt = this.formatPrompt(messages);
    saveToMemory(this.memorySessionId, "user", prompt);

    this.abortController = new AbortController();
    const { channel, agentId, model, agentFileConfig } = this.config;
    const basePrompt = this.loadIdentity();

    // Build the system prompt using the shared dynamic builder (same as clawd-chat path)
    // with MCP prefix so all tool references use the full mcp__clawd__ namespace.
    const ccCtx: PromptContext = {
      agentId: this.config.agentId,
      projectRoot: this.config.projectRoot,
      isSpaceAgent: false,
      availableTools: [
        "bash",
        "spawn_agent",
        "todo_write",
        "todo_read",
        "memory_search",
        // MCP file tools (Phase 2) — project-root-scoped, sandboxed
        "file_view",
        "file_edit",
        "file_multi_edit",
        "file_create",
        "file_glob",
        "file_grep",
      ],
      platform: process.platform,
      model: this.config.model || "sonnet",
      gitRepo: false,
      browserEnabled: false,
      contextMode: false,
      agentFileConfig: this.config.agentFileConfig,
      mcpPrefix: "mcp__clawd__",
    };
    const systemPrompt = buildDynamicSystemPrompt(ccCtx);

    // Detect heartbeat-initiated turns — suppress re-injection for these
    const isHeartbeatTurn = messages.length === 1 && messages[0]?.text === "[HEARTBEAT]";

    // Reset per-turn re-injection state
    this.turnChatSent = false;
    this.turnStreamText = "";

    const sdkOpts = {
      prompt,
      model: model || "sonnet",
      cwd: this.config.projectRoot,
      providerName: this.config.provider,
      systemPrompt: basePrompt,
      agentName: "clawd-main",
      agentDef: {
        "clawd-main": {
          description: "Main channel agent for Claw'd",
          prompt: `${basePrompt}${systemPrompt}`,
        },
      },
      mcpServers: this.buildMcpServers(),
      resume: this.sessionId || undefined,
      abortController: this.abortController,
      yolo: this.config.yolo ?? false,
    };

    const newSessionId = await runSDKQuery(sdkOpts, {
      onTextDelta: (text) => {
        this.turnStreamText += text;
        broadcastAgentToken(channel, agentId, text);
      },
      onThinkingDelta: (text) => broadcastAgentToken(channel, agentId, text, "thinking"),
      onAssistantMessage: (content) => this.handleAssistantMessage(content),
      onToolResult: (name, input, response, id) => this.handleToolResult(name, input, response, id),
      onActivity: () => {
        // Refresh timestamps to prevent stale streaming cleanup AND heartbeat timeout
        setAgentStreaming(agentId, channel, true);
        this.processingStartedAt = Date.now();
        this.lastActivityAt = Date.now();
      },
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
    });

    if (newSessionId) {
      this.sessionId = newSessionId;
      this.persistSessionId(newSessionId);
    }

    // Re-injection: if agent produced substantial text but never called chat_send_message,
    // send one ephemeral follow-up prompt so it can deliver the response.
    // Skip for: heartbeat turns, cancelled/aborted turns, or aborted signal.
    if (
      !this.turnChatSent &&
      this.turnStreamText.trim().length > 100 &&
      !this.wasCancelledByHeartbeat &&
      !isHeartbeatTurn &&
      !this.abortController?.signal.aborted
    ) {
      const reinjectionPrompt =
        "[NOTICE: Your previous turn produced output but did not call `mcp__clawd__chat_send_message` to deliver it — the human cannot see what you wrote.\n\n" +
        "If you intended to respond to the human, call `mcp__clawd__chat_send_message` with your response now.\n" +
        "If you intentionally chose not to respond, produce only [SILENT] and do nothing else.]";

      // Use a fresh AbortController for re-injection (the original may have been aborted).
      // Update this.abortController so cancelProcessing()/setSleeping() can still cancel it.
      const reinjAbort = new AbortController();
      this.abortController = reinjAbort;
      let reinjectionText = "";
      try {
        await runSDKQuery(
          { ...sdkOpts, prompt: reinjectionPrompt, resume: this.sessionId || undefined, abortController: reinjAbort },
          {
            onTextDelta: (text) => {
              reinjectionText += text;
            },
            onThinkingDelta: () => {},
            onAssistantMessage: () => {},
            onToolResult: (name, input, response, id) => this.handleToolResult(name, input, response, id),
            onActivity: () => {
              this.lastActivityAt = Date.now();
            },
            onSessionId: (sid) => {
              if (sid) {
                this.sessionId = sid;
                this.persistSessionId(sid);
              }
            },
          },
        );
      } catch (err) {
        // Re-injection is best-effort — ignore errors
        console.error(`[cc-main-worker] Re-injection failed: ${err}`);
      }

      // If agent replied [SILENT], produced nothing, or already sent via chat_send_message, discard
      if (reinjectionText.trim() && !reinjectionText.includes("[SILENT]") && !this.turnChatSent) {
        broadcastAgentToken(channel, agentId, reinjectionText);
      }
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

    parts.push(
      `\n[REMINDER: Your streaming text output goes to the agentic framework only — the human CANNOT see it. Call mcp__clawd__chat_send_message to send a visible response to the chat UI.]`,
    );
    return parts.join("\n");
  }

  // --------------------------------------------------------------------------
  // Identity (same 4 layers as WorkerLoop.loadClawdInstructions)
  // --------------------------------------------------------------------------

  private identityCache: string | null = null;
  private identityMtimes: Record<string, number> = {};

  /** Check if any identity source file has been modified since last cache */
  private identityFilesChanged(): boolean {
    for (const [path, mtime] of Object.entries(this.identityMtimes)) {
      try {
        const current = statSync(path).mtimeMs;
        if (current !== mtime) return true;
      } catch {
        return true; // File removed
      }
    }
    return false;
  }

  private loadIdentity(): string {
    // Return cache if files haven't changed
    if (this.identityCache !== null && !this.identityFilesChanged()) {
      return this.identityCache;
    }

    const { projectRoot, agentId, agentFileConfig } = this.config;
    const contexts: string[] = [];
    const mtimes: Record<string, number> = {};

    // 1. Global CLAWD.md from ~/.clawd/CLAWD.md
    const globalPath = join(homedir(), ".clawd", "CLAWD.md");
    if (existsSync(globalPath)) {
      try {
        contexts.push(readFileSync(globalPath, "utf-8"));
        mtimes[globalPath] = statSync(globalPath).mtimeMs;
      } catch {}
    }

    // 2. Project CLAWD.md from {projectRoot}/CLAWD.md
    const projectPath = join(projectRoot, "CLAWD.md");
    if (existsSync(projectPath) && projectPath !== globalPath) {
      try {
        contexts.push(`## Project-Specific Instructions\n\n${readFileSync(projectPath, "utf-8")}`);
        mtimes[projectPath] = statSync(projectPath).mtimeMs;
      } catch {}
    }

    // 3. Agent type instructions (from agentFileConfig)
    if (agentFileConfig) {
      const typeIdentity = buildAgentSystemPrompt(agentFileConfig, []);
      if (typeIdentity) {
        contexts.push(`# Agent Type Configuration\n\n${typeIdentity}`);
      }
    }

    // 4. Per-agent identity (from .clawd/agents/{agentId}.md)
    const agent = loadAgentFile(agentId, projectRoot);
    if (agent) {
      const allAgents = listAgentFiles(projectRoot);
      const diskIdentity = buildAgentSystemPrompt(agent, allAgents);
      if (diskIdentity) {
        contexts.push(`# Agent Identity & Configuration\n\n${diskIdentity}`);
      }
    }

    this.identityMtimes = mtimes;
    this.identityCache = contexts.length > 0 ? contexts.join("\n\n---\n\n") + "\n\n---\n\n" : "";
    return this.identityCache;
  }

  // --------------------------------------------------------------------------
  // MCP config
  // --------------------------------------------------------------------------

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
