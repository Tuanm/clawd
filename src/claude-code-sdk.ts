/**
 * Claude Code SDK Wrapper
 *
 * Wraps @anthropic-ai/claude-agent-sdk query() with Claw'd-specific:
 * - PreToolUse hook: blocks Bash run_in_background
 * - PostToolUse hook: broadcasts tool results via handleToolResult callback
 * - Streaming: broadcasts text/thinking deltas + saves to memory.db
 * - Session ID extraction from system init / result messages
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  McpServerConfig,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// Types
// ============================================================================

export interface SDKQueryOptions {
  prompt: string;
  model: string;
  cwd: string;
  systemPrompt: string;
  agentName: string;
  agentDef: Record<string, { description: string; prompt: string }>;
  mcpServers: Record<string, McpServerConfig>;
  resume?: string;
  env?: Record<string, string | undefined>;
  abortController?: AbortController;
  disallowedTools?: string[];
}

export interface SDKStreamCallbacks {
  onTextDelta: (text: string) => void;
  onThinkingDelta: (text: string) => void;
  onAssistantMessage: (content: any[]) => void;
  onToolResult: (toolName: string, toolInput: unknown, toolResponse: unknown, toolUseId: string) => void;
  onSessionId: (sessionId: string) => void;
}

// ============================================================================
// Hooks
// ============================================================================

/** PreToolUse: block Bash run_in_background */
function createPreToolUseHook(): HookCallbackMatcher {
  const hook: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = input.tool_input as Record<string, any> | undefined;
    if (toolInput?.run_in_background) {
      return {
        decision: "block" as const,
        reason:
          "run_in_background is not supported — background jobs are lost when the subprocess restarts. " +
          "Run the command synchronously instead, or break long-running tasks into shorter sequential commands.",
      };
    }
    return {};
  };
  return { matcher: "Bash", hooks: [hook] };
}

/** PostToolUse: forward tool results to callback */
function createPostToolUseHook(onToolResult: SDKStreamCallbacks["onToolResult"]): HookCallbackMatcher {
  const hook: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    onToolResult(input.tool_name, input.tool_input, input.tool_response, input.tool_use_id);
    return { continue: true };
  };
  return { matcher: "*", hooks: [hook] };
}

// ============================================================================
// Environment
// ============================================================================

function buildEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  const home = homedir();
  const extraPaths = (process.env.PATH || "")
    .split(":")
    .filter((p) => /nvm|fnm|volta|nodejs/i.test(p))
    .join(":");
  const basePath = `${home}/.local/bin:${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;
  // Inherit process.env so the CLI subprocess gets auth credentials, XDG paths, etc.
  // Then override with our specifics
  return {
    ...process.env,
    HOME: home,
    PATH: extraPaths ? `${extraPaths}:${basePath}` : basePath,
    LANG: process.env.LANG || "C.UTF-8",
    TERM: "dumb",
    TMPDIR: "/tmp",
    USER: process.env.USER || "clawd",
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75",
    CLAUDE_AGENT_SDK_CLIENT_APP: "Claw'd/1.0",
    ...extra,
  };
}

// ============================================================================
// CLI Path Resolution
// ============================================================================

/**
 * Resolve the SDK's cli.js path. In dev mode (bun run src/...), the SDK finds
 * it relative to import.meta.url. In compiled binaries, import.meta.url points
 * to the binary itself, so we resolve it manually.
 */
function resolveSDKCliPath(): { pathToClaudeCodeExecutable: string } | {} {
  // Try require.resolve first — works in both dev and compiled if node_modules exists
  try {
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const cliJs = join(dirname(sdkEntry), "cli.js");
    if (existsSync(cliJs)) return { pathToClaudeCodeExecutable: cliJs };
  } catch {}

  // Fallback: search common locations
  const binDir = dirname(process.execPath);
  const candidates = [
    join(binDir, "cli.js"), // Next to compiled binary
    join(process.cwd(), "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js"),
    join(homedir(), ".clawd", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return { pathToClaudeCodeExecutable: c };
  }

  // Let SDK try its default resolution
  return {};
}

// ============================================================================
// SDK Query Runner
// ============================================================================

/**
 * Run a Claude Code SDK query with Claw'd hooks and streaming.
 * Returns the session_id (or null) when the query completes.
 */
export async function runSDKQuery(opts: SDKQueryOptions, callbacks: SDKStreamCallbacks): Promise<string | null> {
  let sessionId: string | null = null;

  const baseOptions: Options = {
    model: opts.model || "sonnet",
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: opts.disallowedTools ?? ["Agent", "TodoWrite"],
    agent: opts.agentName,
    agents: opts.agentDef,
    mcpServers: opts.mcpServers,
    abortController: opts.abortController,
    env: buildEnv(opts.env),
    includePartialMessages: true,
    // Resolve cli.js explicitly — compiled binaries can't use import.meta.url
    ...resolveSDKCliPath(),
    hooks: {
      PreToolUse: [createPreToolUseHook()],
      PostToolUse: [createPostToolUseHook(callbacks.onToolResult)],
    },
  };

  // Try with resume first; if session is stale, retry without it
  let options: Options = opts.resume ? { ...baseOptions, resume: opts.resume } : baseOptions;

  const runStream = async (runOptions: Options): Promise<void> => {
    const stream = query({ prompt: opts.prompt, options: runOptions });
    for await (const message of stream) {
      processMessage(message, callbacks, (sid) => {
        sessionId = sid;
      });
    }
  };

  try {
    await runStream(options);
  } catch (err: any) {
    const msg = err.message || "";
    console.error(`[claude-code-sdk] Query failed: ${msg.slice(0, 200)}`);

    // Stale session — retry without resume
    if (opts.resume && (msg.includes("exited with code") || msg.includes("No conversation found"))) {
      console.warn(`[claude-code-sdk] Clearing stale session ${opts.resume?.slice(0, 8)}... — retrying fresh`);
      callbacks.onSessionId(""); // Signal session cleared
      try {
        await runStream(baseOptions);
      } catch (retryErr: any) {
        console.error(`[claude-code-sdk] Retry also failed: ${retryErr.message?.slice(0, 200)}`);
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  return sessionId;
}

// ============================================================================
// Message Processing
// ============================================================================

function processMessage(message: SDKMessage, callbacks: SDKStreamCallbacks, onSessionId: (sid: string) => void): void {
  // stream_event: real-time deltas (text, thinking)
  if (message.type === "stream_event") {
    const ev = (message as any).event;
    if (ev?.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta" && ev.delta.text) {
        callbacks.onTextDelta(ev.delta.text);
      }
      if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
        callbacks.onThinkingDelta(ev.delta.thinking);
      }
    }
  }

  // assistant: complete turn with full content blocks
  if (message.type === "assistant") {
    const content = (message as any).message?.content;
    if (Array.isArray(content)) {
      callbacks.onAssistantMessage(content);
    }
  }

  // Handle error results — do NOT save session_id from errors
  if (message.type === "result" && (message as any).is_error) {
    const r = message as any;
    const errors = r.errors?.join("; ") || r.subtype || "unknown";
    console.error(`[claude-code-sdk] Result error: ${errors}`);
    throw new Error(`Claude Code returned an error result: ${errors}`);
  }

  // system init or successful result: extract session_id
  if (message.type === "system" || message.type === "result") {
    const sid = (message as any).session_id;
    if (sid) {
      onSessionId(sid);
      callbacks.onSessionId(sid);
    }
  }
}
