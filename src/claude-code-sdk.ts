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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  /** Provider name for config lookup (e.g. "claude-code", "claude-code-2") */
  providerName?: string;
}

export interface SDKStreamCallbacks {
  onTextDelta: (text: string) => void;
  onThinkingDelta: (text: string) => void;
  onAssistantMessage: (content: any[]) => void;
  onToolResult: (toolName: string, toolInput: unknown, toolResponse: unknown, toolUseId: string) => void;
  onSessionId: (sessionId: string) => void;
  /** Called on each tool completion to refresh activity timestamp */
  onActivity?: () => void;
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
          "Run the command synchronously, or use mcp__clawd__job_submit(name, command) for persistent background jobs. " +
          "Check with mcp__clawd__job_status(job_id), wait with mcp__clawd__job_wait(job_id), cancel with mcp__clawd__job_cancel(job_id).",
      };
    }
    return {};
  };
  return { matcher: "Bash", hooks: [hook] };
}

/** PostToolUse: forward tool results to callback + refresh activity */
function createPostToolUseHook(
  onToolResult: SDKStreamCallbacks["onToolResult"],
  onActivity?: SDKStreamCallbacks["onActivity"],
): HookCallbackMatcher {
  const hook: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    onToolResult(input.tool_name, input.tool_input, input.tool_response, input.tool_use_id);
    onActivity?.();
    return { continue: true };
  };
  return { matcher: "*", hooks: [hook] };
}

// ============================================================================
// Environment
// ============================================================================

/**
 * Read claude-code provider config from ~/.clawd/config.json and map to
 * environment variables that the Claude Code CLI/SDK understands.
 */
function getClaudeCodeProviderEnv(providerName = "claude-code"): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const { getProviderConfig } = require("./agent/api/provider-config");
    // Look up the specific provider name first, fall back to "claude-code"
    const config = getProviderConfig(providerName) || getProviderConfig("claude-code");
    if (!config) return env;

    if (config.base_url) env.ANTHROPIC_BASE_URL = config.base_url;
    if (config.api_key) env.ANTHROPIC_AUTH_TOKEN = config.api_key;

    // Model aliases — Claude Code CLI resolves "sonnet", "opus", "haiku" via these
    const models = (config as any).models as Record<string, string> | undefined;
    if (models) {
      if (models.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = models.sonnet;
      if (models.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = models.opus;
      if (models.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = models.haiku;
      if (models.default) env.ANTHROPIC_MODEL = models.default;
    }
  } catch {}
  return env;
}

function buildEnv(
  providerName?: string,
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const home = homedir();
  const extraPaths = (process.env.PATH || "")
    .split(":")
    .filter((p) => /nvm|fnm|volta|nodejs/i.test(p))
    .join(":");
  const basePath = `${home}/.local/bin:${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;
  // Inherit process.env so the CLI subprocess gets auth credentials, XDG paths, etc.
  // Then override with our specifics + claude-code provider config
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
    ...getClaudeCodeProviderEnv(providerName),
    ...extra,
  };
}

// ============================================================================
// CLI Path Resolution
// ============================================================================

/**
 * Resolve the SDK's cli.js path. Search order:
 * 1. node_modules (dev mode)
 * 2. Extracted from embedded binary (~/.clawd/bin/cli.js)
 * 3. Next to the compiled binary
 * 4. Let SDK try its default resolution
 */
function resolveSDKCliPath(): { pathToClaudeCodeExecutable: string } | {} {
  // 1. Try require.resolve — works in dev mode
  try {
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const cliJs = join(dirname(sdkEntry), "cli.js");
    if (existsSync(cliJs)) return { pathToClaudeCodeExecutable: cliJs };
  } catch {}

  // 2. Check extracted location (~/.clawd/bin/cli.js) — cross-platform
  const clawdBinDir = join(homedir(), ".clawd", "bin");
  const extractedPath = join(clawdBinDir, "cli.js");
  if (existsSync(extractedPath)) return { pathToClaudeCodeExecutable: extractedPath };

  // 3. Extract from embedded binary
  try {
    const { CLI_JS_GZIP_BASE64 } = require("./embedded-cli");
    if (CLI_JS_GZIP_BASE64) {
      mkdirSync(clawdBinDir, { recursive: true });
      const compressed = Buffer.from(CLI_JS_GZIP_BASE64, "base64");
      const raw = gunzipSync(compressed);
      writeFileSync(extractedPath, raw, { mode: 0o755 });
      console.log(
        `[claude-code-sdk] Extracted cli.js to ${extractedPath} (${(raw.length / 1024 / 1024).toFixed(1)}MB)`,
      );
      return { pathToClaudeCodeExecutable: extractedPath };
    }
  } catch {}

  // 4. Next to compiled binary
  const binDir = dirname(process.execPath);
  const nextToBinary = join(binDir, "cli.js");
  if (existsSync(nextToBinary)) return { pathToClaudeCodeExecutable: nextToBinary };

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
    env: buildEnv(opts.providerName, opts.env),
    includePartialMessages: true,
    // Resolve cli.js explicitly — compiled binaries can't use import.meta.url
    ...resolveSDKCliPath(),
    hooks: {
      PreToolUse: [createPreToolUseHook()],
      PostToolUse: [createPostToolUseHook(callbacks.onToolResult, callbacks.onActivity)],
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

    // Stale/corrupted session — retry without resume
    const isSessionError =
      msg.includes("exited with code") ||
      msg.includes("No conversation found") ||
      msg.includes("Invalid `signature` in `thinking` block");
    if (opts.resume && isSessionError) {
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
  // Check subtype (not is_error) — is_error can be true even for successful completions
  if (message.type === "result" && (message as any).subtype?.startsWith("error_")) {
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
