/**
 * Claude Code Main Worker
 *
 * Runs a Claude Code CLI subprocess as a main channel agent.
 * Polls for messages, spawns `claude -p` per interaction, and lets
 * Claude Code communicate via Claw'd's MCP tools (chat_send_message,
 * chat_mark_processed, claude_code, etc.).
 *
 * Implements AgentWorker interface for WorkerManager compatibility.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentFileConfig } from "./agent/agents/loader";
import { getSessionManager } from "./agent/session/manager";
import { broadcastAgentStreaming, broadcastAgentToken, broadcastAgentToolCall } from "./server/websocket";
import { db, getAgent, markMessagesSeen } from "./server/database";
import { getPendingMessages } from "./server/routes/messages";
import { broadcastUpdate } from "./server/websocket";
import { findClaudeCodeCLI, hasTmux, truncateToolResult, formatToolDescription } from "./spaces/claude-code-worker";
import type { AgentHealthSnapshot, AgentWorker } from "./worker-loop";

// ============================================================================
// Constants
// ============================================================================

const POLL_INTERVAL_MS = 200;
const SLEEP_BACKOFF_MS = 3000;
const SUBPROCESS_TIMEOUT_MS = 300_000; // 5 min per invocation
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
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private sessionId: string | null = null;
  private running = false;
  private sleeping = false;
  private processing = false;
  private lastActivityAt = Date.now();
  private processingStartedAt: number | null = null;
  private lastHeartbeatAt = Date.now();
  private hookScriptPath: string;
  private preHookScriptPath: string;
  private logFilePath: string;
  private tmuxSession: string | null = null;
  private stopped = false;
  private heartbeatPending = false;
  // Memory.db session for Thoughts history
  private memorySessionId: string | null = null;
  // Force-mark failsafe
  private pendingTimestamps: string[] = [];
  private forceMarkRetries = new Map<string, number>();

  constructor(config: ClaudeCodeMainConfig) {
    this.config = config;
    const shortId = `${config.channel}-${config.agentId}`.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 30);
    this.hookScriptPath = `/tmp/clawd-cc-main-hook-${shortId}.js`;
    this.preHookScriptPath = `/tmp/clawd-cc-main-prehook-${shortId}.js`;
    this.logFilePath = `/tmp/clawd-cc-main-log-${shortId}.jsonl`;
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
      // Broadcast sleeping state
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
      this.proc?.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        this.proc?.kill("SIGKILL");
      } catch {}
    }, 5000);
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
    // Set flag so the poll loop spawns a subprocess with [HEARTBEAT] prompt on next cycle
    this.heartbeatPending = true;
  }

  // --------------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    const cliPath = findClaudeCodeCLI();
    if (!cliPath) {
      console.error(`[claude-code-main] CLI not found for ${this.config.channel}:${this.config.agentId}`);
      return;
    }

    this.running = true;
    this.writeHookScript();
    this.writePreHookScript();
    this.restoreSessionId();
    this.initMemorySession();
    console.log(
      `[claude-code-main] Started: ${this.config.channel}:${this.config.agentId}` +
        (this.sessionId ? ` (resuming session ${this.sessionId.slice(0, 8)}...)` : " (new session)"),
    );

    while (this.running) {
      try {
        let pending = this.pollForMessages();

        // Check for heartbeat — spawn a subprocess with [HEARTBEAT] prompt
        if (pending.length === 0 && this.heartbeatPending) {
          this.heartbeatPending = false;
          this.sleeping = false;
          // Spawn with heartbeat prompt so the agent can check for sub-agent results, etc.
          pending = [{ ts: String(Date.now()), user: "UHUMAN", text: "[HEARTBEAT]" }];
        }

        if (pending.length === 0) {
          if (!this.sleeping) {
            this.sleeping = true;
          }
          await Bun.sleep(SLEEP_BACKOFF_MS);
          continue;
        }

        // Wake up
        this.sleeping = false;
        this.processing = true;
        this.processingStartedAt = Date.now();
        this.lastActivityAt = Date.now();
        this.pendingTimestamps = pending.map((m: any) => m.ts);

        // Mark messages as seen (user knows agent received them)
        try {
          markMessagesSeen(this.config.agentId, this.config.channel, pending[pending.length - 1].ts);
        } catch {}

        broadcastAgentStreaming(this.config.channel, this.config.agentId, true);

        // Start interrupt poller — checks for new messages during processing
        // If a new message arrives, kills the subprocess so the loop can restart with all messages
        let interrupted = false;
        const interruptPoller = setInterval(() => {
          if (!this.processing) return;
          const newPending = this.pollForMessages();
          // If there are NEW messages beyond what we're currently processing
          const newMessages = newPending.filter((m: any) => !this.pendingTimestamps.includes(m.ts));
          if (newMessages.length > 0) {
            interrupted = true;
            console.log(`[claude-code-main] Interrupted by ${newMessages.length} new message(s)`);
            try {
              this.proc?.kill("SIGTERM");
            } catch {}
          }
        }, 2000);

        try {
          await this.processMessages(cliPath, pending);
        } catch (err: any) {
          if (!interrupted) {
            console.error(`[claude-code-main] Error: ${err.message}`);
          }
        } finally {
          clearInterval(interruptPoller);
          broadcastAgentStreaming(this.config.channel, this.config.agentId, false);
          this.processing = false;
          this.processingStartedAt = null;
          this.lastActivityAt = Date.now();
        }

        // If interrupted, skip force-mark — the messages will be re-polled with the new ones
        if (interrupted) continue;

        // Force-mark failsafe
        this.forceMarkUnprocessed();
      } catch (err: any) {
        console.error(`[claude-code-main] Poll error: ${err.message}`);
        await Bun.sleep(POLL_INTERVAL_MS);
      }
    }

    // Cleanup on stop
    this.cleanupFiles();
    console.log(`[claude-code-main] Stopped: ${this.config.channel}:${this.config.agentId}`);
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    this.cancelProcessing();
  }

  // --------------------------------------------------------------------------
  // Message processing
  // --------------------------------------------------------------------------

  private pollForMessages(): any[] {
    // Get agent's last_processed_ts, then fetch messages after it
    const { channel, agentId } = this.config;
    const seen = db
      .query<{ last_processed_ts: string | null }, [string, string]>(
        `SELECT last_processed_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
      )
      .get(agentId, channel);
    const lastTs = seen?.last_processed_ts || undefined;

    // Get pending UHUMAN messages after last_processed_ts
    const result = getPendingMessages(channel, lastTs, false, 50);
    // Include UHUMAN messages + bot messages from OTHER agents (sub-agent results)
    // Exclude own messages to prevent self-processing loop
    const pending = ((result as any).messages || []).filter(
      (m: any) => m.ts > (lastTs || "0") && (m.user === "UHUMAN" || (m.agent_id && m.agent_id !== agentId)),
    );
    return pending;
  }

  private async processMessages(cliPath: string, messages: any[]): Promise<void> {
    const prompt = this.formatPrompt(messages);

    // Save user prompt to memory.db
    this.saveToMemory("user", prompt);

    // Subprocess timeout
    const timer = setTimeout(() => {
      console.warn(`[claude-code-main] Subprocess timeout after ${SUBPROCESS_TIMEOUT_MS}ms`);
      try {
        this.proc?.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          this.proc?.kill("SIGKILL");
        } catch {}
      }, 5000);
    }, SUBPROCESS_TIMEOUT_MS);

    try {
      this.proc = Bun.spawn([cliPath, ...this.buildArgs(prompt)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: this.getEnv(),
      });
      this.proc.stdin.end();

      this.startTmuxMonitor();
      await this.parseStream();

      const exitCode = await this.proc.exited;
      this.stopTmuxMonitor();

      if (exitCode !== 0 && !this.stopped) {
        let stderr = "";
        try {
          stderr = await new Response(this.proc.stderr).text();
        } catch {}
        console.error(`[claude-code-main] Exit ${exitCode}: ${stderr.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
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

  private buildArgs(prompt: string): string[] {
    const { channel, agentId, model } = this.config;
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools",
      "default",
      "--disallowedTools",
      "Agent",
      "TodoWrite",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      model || "sonnet",
      "--mcp-config",
      this.getMcpConfigJson(),
      "--agents",
      JSON.stringify(this.getAgentDef()),
      "--agent",
      "clawd-main",
      "--settings",
      JSON.stringify(this.getHookSettings()),
    ];
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }
    return args;
  }

  private getAgentDef(): Record<string, unknown> {
    const { channel, agentId, agentFileConfig } = this.config;
    const basePrompt = agentFileConfig?.systemPrompt ? `${agentFileConfig.systemPrompt}\n\n---\n\n` : "";

    return {
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
    };
  }

  private getMcpConfigJson(): string {
    let port = "3456";
    try {
      port = new URL(this.config.chatApiUrl).port || "3456";
    } catch {}
    const { channel, agentId } = this.config;

    // Start with Claw'd's agent-scoped MCP endpoint
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
        if (name === "clawd") continue; // Don't override our own endpoint

        if (cfg.transport === "http" || cfg.type === "http") {
          // HTTP MCP server
          const entry: any = { type: "http", url: cfg.url };
          if (cfg.headers) entry.headers = cfg.headers;
          mcpServers[name] = entry;
        } else {
          // stdio MCP server
          const entry: any = { command: cfg.command, args: cfg.args || [] };
          if (cfg.env) entry.env = cfg.env;
          mcpServers[name] = entry;
        }
      }
    } catch {}

    return JSON.stringify({ mcpServers });
  }

  // --------------------------------------------------------------------------
  // Stream parsing (same as sub-agent)
  // --------------------------------------------------------------------------

  private async parseStream(): Promise<void> {
    if (!this.proc) return;
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const { channel, agentId } = this.config;
    const logFile = this.tmuxSession ? Bun.file(this.logFilePath).writer() : null;

    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = (buffer + decoder.decode(value, { stream: true })).split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          if (logFile) {
            try {
              logFile.write(line + "\n");
              logFile.flush();
            } catch {}
          }

          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          // stream_event: real-time deltas
          if (parsed.type === "stream_event") {
            const ev = parsed.event;

            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
              broadcastAgentToken(channel, agentId, ev.delta.text);
            }

            if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
              broadcastAgentToken(channel, agentId, ev.delta.thinking, "thinking");
            }
          }

          // assistant: complete turn messages — save to memory.db for Thoughts history
          if (parsed.type === "assistant") {
            const content = parsed.message?.content;
            if (Array.isArray(content)) {
              // Extract text and tool_calls
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
              const text = textParts.join("\n") || null;
              if (text || toolCalls.length > 0) {
                this.saveToMemory("assistant", text || "", toolCalls.length > 0 ? toolCalls : undefined);
              }
            }
          }

          // Save session_id from system init event (available immediately on stream start)
          // Also save from result event (final confirmation)
          if ((parsed.type === "system" || parsed.type === "result") && parsed.session_id) {
            this.sessionId = parsed.session_id;
            // Persist to DB for restart recovery
            this.persistSessionId(parsed.session_id);
          }
        }
      }
    } finally {
      reader.releaseLock();
      try {
        logFile?.end();
      } catch {}
    }
  }

  // --------------------------------------------------------------------------
  // Hook script (PostToolUse → broadcast tool calls)
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

    // Save tool result to memory.db — use actual tool_use_id for Thoughts history grouping
    this.saveToMemory("tool", `${description}\n${result}`, undefined, toolUseId || `tool_${toolName}_${Date.now()}`);
  }

  private writeHookScript(): void {
    let port = "3456";
    try {
      port = new URL(this.config.chatApiUrl).port || "3456";
    } catch {}
    const channelAgentKey = `${this.config.channel}:${this.config.agentId}`;
    const nodePath = Bun.which("node") || Bun.which("bun") || "node";

    const script = `const h = require("http"), f = require("fs");
try {
  const d = JSON.parse(f.readFileSync(0, "utf8"));
  if (!d.tool_name) { process.exit(0); }
  const payload = JSON.stringify({
    worker_key: "${channelAgentKey}",
    tool_name: d.tool_name,
    tool_input: d.tool_input,
    tool_response: d.tool_response,
    tool_use_id: d.tool_use_id,
  });
  const r = h.request({
    hostname: "localhost", port: ${port},
    path: "/api/claude-code.mainToolResult",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeout: 2000,
  });
  r.on("timeout", () => r.destroy());
  r.on("error", () => {});
  r.write(payload);
  r.end();
} catch {}
console.log(JSON.stringify({ continue: true }));
`;
    writeFileSync(this.hookScriptPath, script);
  }

  private writePreHookScript(): void {
    const script = `const f = require("fs");
try {
  const d = JSON.parse(f.readFileSync(0, "utf8"));
  if (d.tool_name === "Bash" && d.tool_input && d.tool_input.run_in_background) {
    console.log(JSON.stringify({
      decision: "block",
      reason: "run_in_background is not supported in this environment — background jobs are lost when the agent subprocess restarts. " +
        "Instead, run the command synchronously, or for long-running tasks use the MCP tool mcp__clawd__job_submit(name, command) which persists via tmux. " +
        "Check job status with mcp__clawd__job_status(job_id) and cancel with mcp__clawd__job_cancel(job_id)."
    }));
  } else {
    console.log(JSON.stringify({ decision: "allow" }));
  }
} catch { console.log(JSON.stringify({ decision: "allow" })); }
`;
    writeFileSync(this.preHookScriptPath, script);
  }

  private getHookSettings(): Record<string, unknown> {
    const nodePath = Bun.which("node") || Bun.which("bun") || "node";
    const postCmd = `${nodePath} ${this.hookScriptPath}`;
    const preCmd = `${nodePath} ${this.preHookScriptPath}`;
    return {
      env: {
        // Auto-compact at 75% context usage (default ~95% is too late for long conversations)
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75",
      },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: preCmd }] }],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: postCmd }] }],
      },
    };
  }

  // --------------------------------------------------------------------------
  // Force-mark failsafe
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

  /** Initialize memory.db session for Thoughts history */
  private initMemorySession(): void {
    try {
      const sessions = getSessionManager();
      const sessionName = `${this.config.channel}-${this.config.agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const session = sessions.getOrCreateSession(sessionName, this.config.model);
      this.memorySessionId = session.id;
    } catch {}
  }

  /** Save a message to memory.db for Thoughts history */
  private saveToMemory(
    role: "user" | "assistant" | "tool",
    content: string,
    toolCalls?: any[],
    toolCallId?: string,
  ): void {
    if (!this.memorySessionId) return;
    try {
      const sessions = getSessionManager();
      sessions.addMessage(this.memorySessionId, {
        role,
        content,
        tool_calls: toolCalls,
        tool_call_id: toolCallId,
      });
    } catch {}
  }

  private forceMarkUnprocessed(): void {
    for (const ts of this.pendingTimestamps) {
      const retries = this.forceMarkRetries.get(ts) || 0;
      if (retries >= MAX_FORCE_MARK_RETRIES) {
        // Force-mark after max retries
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

  // --------------------------------------------------------------------------
  // Environment + tmux
  // --------------------------------------------------------------------------

  private getEnv(): Record<string, string> {
    const home = homedir();
    const extraPaths = (process.env.PATH || "")
      .split(":")
      .filter((p) => /nvm|fnm|volta|nodejs/i.test(p))
      .join(":");
    const basePath = `${home}/.local/bin:${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;
    return {
      HOME: home,
      PATH: extraPaths ? `${extraPaths}:${basePath}` : basePath,
      LANG: process.env.LANG || "C.UTF-8",
      TERM: "dumb",
      TMPDIR: "/tmp",
      USER: process.env.USER || "clawd",
    };
  }

  private startTmuxMonitor(): void {
    if (!hasTmux()) return;
    const shortId = `${this.config.channel}-${this.config.agentId}`.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 20);
    this.tmuxSession = `clawd-main-${shortId}`;
    try {
      writeFileSync(this.logFilePath, "");
      Bun.spawnSync([
        "tmux",
        "new-session",
        "-d",
        "-s",
        this.tmuxSession,
        "-x",
        "200",
        "-y",
        "50",
        `tail -f ${this.logFilePath}`,
      ]);
      console.log(`[claude-code-main] tmux: ${this.tmuxSession}`);
    } catch {
      this.tmuxSession = null;
    }
  }

  private stopTmuxMonitor(): void {
    if (this.tmuxSession) {
      try {
        Bun.spawnSync(["tmux", "kill-session", "-t", this.tmuxSession]);
      } catch {}
      this.tmuxSession = null;
    }
  }

  private cleanupFiles(): void {
    this.stopTmuxMonitor();
    try {
      unlinkSync(this.hookScriptPath);
    } catch {}
    try {
      unlinkSync(this.preHookScriptPath);
    } catch {}
    try {
      unlinkSync(this.logFilePath);
    } catch {}
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
