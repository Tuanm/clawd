/**
 * Claude Code Space Worker
 *
 * Spawns a Claude Code CLI subprocess to handle a task within a Claw'd Space.
 * Claude Code runs autonomously with its built-in tools (Read, Write, Bash, etc.)
 * and signals completion via a single MCP tool: complete_task.
 *
 * All output is streamed to the UI via WebSocket events (same as normal agents):
 * - Text → broadcastAgentToken (content)
 * - Thinking → broadcastAgentToken (thinking)
 * - Tool calls → broadcastAgentToolCall (started/completed)
 * - Final result → posted as chat message to space channel
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { broadcastAgentStreaming, broadcastAgentToken, broadcastAgentToolCall } from "../server/websocket";
import { timedFetch } from "../utils/timed-fetch";
import type { Space } from "./db";
import type { SpaceManager } from "./manager";

// ============================================================================
// CLI Detection
// ============================================================================

/** Detect Claude Code CLI. Uses Bun.which for cross-platform support. */
function findClaudeCodeCLI(configPath?: string): string | null {
  if (configPath) {
    const resolved = resolve(configPath);
    if (existsSync(resolved)) return resolved;
    return null;
  }
  return Bun.which("claude") || null;
}

// ============================================================================
// Tmux Detection
// ============================================================================

let _tmuxAvailable: boolean | null = null;
function hasTmux(): boolean {
  if (_tmuxAvailable === null) {
    try {
      _tmuxAvailable = Bun.spawnSync(["which", "tmux"]).exitCode === 0;
    } catch {
      _tmuxAvailable = false;
    }
  }
  return _tmuxAvailable;
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
  spaceManager: SpaceManager;
  resolve: (summary: string) => void;
  onComplete?: () => void;
  /** Agent system prompt / directives (from agent file) */
  agentPrompt?: string;
}

// ============================================================================
// Worker
// ============================================================================

export class ClaudeCodeSpaceWorker {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private sessionId: string | null = null;
  private config: ClaudeCodeWorkerConfig;
  private stopped = false;
  private maxRetries = 3;
  private retryCount = 0;
  private spaceToken: string;
  private hookScriptPath: string;
  private logFilePath: string;
  private tmuxSession: string | null = null;

  constructor(config: ClaudeCodeWorkerConfig) {
    this.config = config;
    this.spaceToken = crypto.randomUUID();
    this.hookScriptPath = `/tmp/clawd-claude-code-hook-${config.space.id}.js`;
    this.logFilePath = `/tmp/clawd-claude-code-log-${config.space.id}.jsonl`;
  }

  async start(): Promise<void> {
    const cliPath = findClaudeCodeCLI();
    if (!cliPath) {
      throw new Error(
        "Claude Code CLI not installed. Install: npm install -g @anthropic-ai/claude-code, then run: claude /login",
      );
    }

    while (this.retryCount <= this.maxRetries && !this.stopped) {
      try {
        await this.runOnce(cliPath);
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
      this.proc?.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        this.proc?.kill("SIGKILL");
      } catch {}
    }, 5000);
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getPid(): number | undefined {
    return this.proc?.pid;
  }

  getSpaceToken(): string {
    return this.spaceToken;
  }

  cleanup(): void {
    this.stopTmuxMonitor();
    try {
      unlinkSync(this.hookScriptPath);
    } catch {}
    try {
      unlinkSync(this.logFilePath);
    } catch {}
  }

  /**
   * Called by PostToolUse hook API to broadcast tool completion.
   * Fires broadcastAgentToolCall with "completed" status.
   */
  handleToolResult(toolName: string, toolInput: unknown, toolResponse: unknown): void {
    const { space, agentId } = this.config;
    const input = (toolInput || {}) as Record<string, any>;
    const response = toolResponse as any;
    const status = response?.error ? "error" : "completed";
    const result = truncateToolResult(response);
    const description = formatToolDescription(toolName, input);

    console.log(`[claude-code] hook → ${status}: ${toolName} ${description.slice(0, 60)}`);
    // Broadcast "started" then immediately "completed" so UI groups them as one tool_group.
    // This avoids mismatch when multiple tools of the same type run in parallel.
    broadcastAgentToolCall(space.space_channel, agentId, toolName, input, "started");
    broadcastAgentToolCall(space.space_channel, agentId, toolName, input, status, `${description}\n${result}`);
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async runOnce(cliPath: string): Promise<void> {
    const { space, task, context, agentId } = this.config;
    const prompt = context ? `**Context:**\n${context.slice(0, 4000)}\n\n**Task:** ${task}` : task;

    // Write hook script before spawning
    this.writeHookScript();

    this.proc = Bun.spawn([cliPath, ...this.buildArgs(prompt)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.getEnv(),
    });
    this.proc.stdin.end();

    this.startTmuxMonitor();
    broadcastAgentStreaming(space.space_channel, agentId, true);

    try {
      await this.parseStream();
    } finally {
      broadcastAgentStreaming(space.space_channel, agentId, false);
    }

    const exitCode = await this.proc.exited;
    this.stopTmuxMonitor();

    if (exitCode !== 0 && !this.stopped) {
      let stderr = "";
      try {
        stderr = await new Response(this.proc.stderr).text();
      } catch {}
      throw new Error(stderr.trim().slice(0, 200) || `Claude Code exited with code ${exitCode}`);
    }
  }

  private buildArgs(prompt: string): string[] {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools",
      "default",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      this.config.model || "sonnet",
      "--mcp-config",
      this.getMcpConfigJson(),
      "--agents",
      JSON.stringify(this.getAgentDef()),
      "--agent",
      "clawd-worker",
      "--settings",
      JSON.stringify(this.getHookSettings()),
    ];
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }
    return args;
  }

  private getAgentDef(): Record<string, unknown> {
    const { space, agentPrompt } = this.config;
    const basePrompt = agentPrompt
      ? `${agentPrompt}\n\n---\n\n`
      : "You are an autonomous coding agent. Complete the given task using your tools (Read, Write, Edit, Bash, Grep, Glob, etc.).\n\n";

    return {
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
    };
  }

  private getMcpConfigJson(): string {
    let port = "3456";
    try {
      port = new URL(this.config.apiUrl).port || "3456";
    } catch {}
    return JSON.stringify({
      mcpServers: {
        clawd: {
          type: "http",
          url: `http://localhost:${port}/mcp/space/${this.config.space.id}`,
          headers: { Authorization: `Bearer ${this.spaceToken}` },
        },
      },
    });
  }

  private writeHookScript(): void {
    let port = "3456";
    try {
      port = new URL(this.config.apiUrl).port || "3456";
    } catch {}

    // PostToolUse hook: broadcasts tool completion via Claw'd API
    const spaceId = this.config.space.id;
    const script = `const h = require("http"), f = require("fs");
try {
  const input = f.readFileSync(0, "utf8");
  f.appendFileSync("/tmp/clawd-hook-debug.log", new Date().toISOString() + " HOOK_FIRED input_len=" + input.length + "\\n");
  const d = JSON.parse(input);
  if (!d.tool_name) { process.exit(0); }
  f.appendFileSync("/tmp/clawd-hook-debug.log", "  tool=" + d.tool_name + " space=${spaceId}\\n");
  const payload = JSON.stringify({
    space_id: "${spaceId}",
    tool_name: d.tool_name,
    tool_input: d.tool_input,
    tool_response: d.tool_response,
  });
  const r = h.request({
    hostname: "localhost", port: ${port},
    path: "/api/claude-code.toolResult",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeout: 2000,
  });
  r.on("timeout", () => { f.appendFileSync("/tmp/clawd-hook-debug.log", "  TIMEOUT\\n"); r.destroy(); });
  r.on("error", (e) => { f.appendFileSync("/tmp/clawd-hook-debug.log", "  ERROR: " + e.message + "\\n"); });
  r.on("response", (res) => { f.appendFileSync("/tmp/clawd-hook-debug.log", "  RESPONSE: " + res.statusCode + "\\n"); });
  r.write(payload);
  r.end();
} catch(e) { try { f.appendFileSync("/tmp/clawd-hook-debug.log", "  CATCH: " + e.message + "\\n"); } catch {} }
console.log(JSON.stringify({ continue: true }));
`;
    writeFileSync(this.hookScriptPath, script);
  }

  private getHookSettings(): Record<string, unknown> {
    // Use absolute path — hook subprocesses may not inherit our PATH
    const nodePath = Bun.which("node") || Bun.which("bun") || "node";
    const cmd = `${nodePath} ${this.hookScriptPath}`;
    return {
      hooks: {
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd }] }],
      },
    };
  }

  private async parseStream(): Promise<void> {
    if (!this.proc) return;
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const { space, agentId } = this.config;
    const logFile = this.tmuxSession ? Bun.file(this.logFilePath).writer() : null;

    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = (buffer + decoder.decode(value, { stream: true })).split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          // Write to tmux log
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

            // Text streaming
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
              broadcastAgentToken(space.space_channel, agentId, ev.delta.text);
            }

            // Thinking streaming
            if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
              broadcastAgentToken(space.space_channel, agentId, ev.delta.thinking, "thinking");
            }

            // Note: tool_use start from stream_event is skipped here — we broadcast
            // "started" from the assistant block instead (which has the full input args).
          }

          // assistant: complete turn messages (has full content blocks)
          if (parsed.type === "assistant") {
            const content = parsed.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                // Post text as chat message
                if (block.type === "text" && block.text) {
                  await this.postAgentMessage(block.text);
                }
                // Tool use — don't broadcast "started" here.
                // The PostToolUse hook will broadcast "completed" with both args + result,
                // avoiding mismatch when multiple tools of the same type run in parallel.
              }
            }
          }

          // Result event → save session_id
          if (parsed.type === "result") {
            this.sessionId = parsed.session_id || this.sessionId;
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

  private startTmuxMonitor(): void {
    if (!hasTmux()) return;
    const shortId = this.config.space.id.slice(0, 8);
    this.tmuxSession = `clawd-cc-${shortId}`;
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
      console.log(`[claude-code] tmux session: ${this.tmuxSession} (tmux attach -t ${this.tmuxSession})`);
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

  private getEnv(): Record<string, string> {
    const home = homedir();
    // Include nvm/fnm/volta paths for node access (required by hook scripts)
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
      CLAWD_SPACE_ID: this.config.space.id,
      CLAWD_SPACE_TOKEN: this.spaceToken,
    };
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

// ============================================================================
// Helpers
// ============================================================================

function truncateToolResult(response: any): string {
  if (!response) return "";
  const text =
    response?.file?.content || response?.stdout || (typeof response === "string" ? response : JSON.stringify(response));
  return typeof text === "string" ? text.slice(0, 2000) : "";
}

function formatToolDescription(tool: string, input: Record<string, any>): string {
  if (!input) return tool;
  switch (tool) {
    case "Read":
      return input.file_path || "Read file";
    case "Edit":
      return `${input.file_path || "file"} (edit)`;
    case "Write":
    case "Create":
      return input.file_path || "Write file";
    case "Bash":
      return (input.command || "").slice(0, 80);
    case "Glob":
      return input.pattern || "Search files";
    case "Grep":
      return `/${input.pattern || ""}/ ${input.path || ""}`.trim();
    case "WebSearch":
      return input.query || "Web search";
    case "WebFetch":
      return input.url || "Fetch URL";
    default:
      return tool;
  }
}
