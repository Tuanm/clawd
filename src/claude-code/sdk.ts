/**
 * Claude Code SDK Wrapper
 *
 * Wraps @anthropic-ai/claude-agent-sdk query() with Claw'd-specific:
 * - PreToolUse hook: blocks Bash run_in_background
 * - PostToolUse hook: broadcasts tool results via handleToolResult callback
 * - Streaming: broadcasts text/thinking deltas + saves to memory.db
 * - Session ID extraction from system init / result messages
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type {
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  McpServerConfig,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getSafeEnvVars } from "../agent/utils/sandbox";

// ============================================================================
// Types
// ============================================================================

export interface SDKQueryOptions {
  /** Prompt for the turn. Either a single string (wrapped as one user message)
   *  or an AsyncIterable of role-structured messages (used by the CC main worker
   *  to feed the SDK proper user+assistant turn history with attributed senders). */
  prompt: string | AsyncIterable<unknown>;
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
  /**
   * When true (YOLO mode), bypass all sandboxing — no bwrap, permissionMode bypassPermissions.
   * When false (default), enable bwrap OS-level sandbox. All domains are allowed (network
   * filtering happens at the Docker/firewall level). Security comes from OS-level isolation,
   * not permission prompts. Consistent across all CC agents (main + space workers).
   */
  yolo?: boolean;
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

/** PreToolUse: block run_in_background + protect ~/.clawd/config.json from all agents */
function createPreToolUseHook(): HookCallbackMatcher {
  const configPath = resolve(homedir(), ".clawd", "config.json");
  // Pre-resolve real path of config.json (guard against symlinks pointing to it)
  let configRealPath: string;
  try {
    configRealPath = realpathSync(configPath);
  } catch {
    configRealPath = configPath;
  }

  /** Resolve a path, following symlinks where possible */
  function realpath(p: string): string {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  }

  /** Return true if the resolved path equals the config file */
  function isConfigPath(p: string): boolean {
    const abs = realpath(p);
    return abs === configPath || abs === configRealPath;
  }

  const CONFIG_BLOCK = {
    decision: "block" as const,
    reason: "Access to ~/.clawd/config.json is restricted for all agents.",
  };

  const hook: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = input.tool_input as Record<string, any> | undefined;

    if (input.tool_name === "Bash") {
      // Block run_in_background
      if (toolInput?.run_in_background) {
        return {
          decision: "block" as const,
          reason:
            "run_in_background is not supported — background jobs are lost when the subprocess restarts. " +
            "Run the command synchronously, or use mcp__clawd__job_submit(name, command) for persistent background jobs. " +
            "Check with mcp__clawd__job_status(job_id), wait with mcp__clawd__job_wait(job_id), cancel with mcp__clawd__job_cancel(job_id).",
        };
      }
      // Best-effort block of Bash commands referencing ~/.clawd/config.json.
      // This is defence-in-depth only — shell variable indirection
      // (e.g. `D=clawd; cat ~/.$D/config.json`) cannot be caught by static
      // string matching. The authoritative protection is the file-tool hook above.
      const cmd: string = toolInput?.command ?? "";
      if (cmd.includes(".clawd/config.json")) {
        return CONFIG_BLOCK;
      }
      return {};
    }

    // Block direct file tool access to ~/.clawd/config.json (all modes)
    const fileTools: Record<string, string | undefined> = {
      Read: toolInput?.file_path,
      Write: toolInput?.file_path,
      Edit: toolInput?.file_path,
      NotebookEdit: toolInput?.notebook_path,
    };
    const MultiEditPaths: string[] =
      input.tool_name === "MultiEdit" && Array.isArray(toolInput?.edits)
        ? (toolInput!.edits as any[]).map((e) => e?.file_path).filter(Boolean)
        : [];

    const targetPaths =
      input.tool_name === "MultiEdit"
        ? MultiEditPaths
        : fileTools[input.tool_name]
          ? [fileTools[input.tool_name]!]
          : [];

    for (const p of targetPaths) {
      if (isConfigPath(p)) return CONFIG_BLOCK;
    }

    return {};
  };
  return { matcher: "*", hooks: [hook] };
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
    const { getProviderConfig } = require("../agent/api/provider-config");
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
  } catch {
    // Intentionally swallowed — model alias config is optional; env falls back to CLI defaults
  }
  return env;
}

function buildEnv(
  providerName?: string,
  extra?: Record<string, string | undefined>,
  sandbox?: boolean,
): Record<string, string | undefined> {
  const home = homedir();

  if (sandbox) {
    // Sandbox mode: start from a clean safe environment (same as other providers).
    // Only safe vars + CC-specific vars — no process.env leakage.
    // CLAUDE_TMPDIR=/tmp tells the CLI's internal sandbox to treat /tmp as writable tmpdir.
    const safeBase = getSafeEnvVars();
    const ccEnv = getClaudeCodeProviderEnv(providerName);
    return {
      ...safeBase,
      TERM: "dumb",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75",
      CLAUDE_AGENT_SDK_CLIENT_APP: "Claw'd/1.0",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_TMPDIR: "/tmp",
      ...ccEnv,
      ...extra,
    };
  }

  // YOLO mode: inherit full process.env so CLI gets all credentials, XDG paths, etc.
  const extraPaths = (process.env.PATH || "")
    .split(":")
    .filter((p) => /nvm|fnm|volta|nodejs/i.test(p))
    .join(":");
  const basePath = `${home}/.local/bin:${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;
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
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
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
  } catch {
    // Intentionally swallowed — require.resolve may fail if SDK not bundled; falls through to next location
  }

  // 2. Check extracted location (~/.clawd/bin/cli.js) — cross-platform
  const clawdBinDir = join(homedir(), ".clawd", "bin");
  const extractedPath = join(clawdBinDir, "cli.js");
  if (existsSync(extractedPath)) return { pathToClaudeCodeExecutable: extractedPath };

  // 3. Extract from embedded binary
  try {
    const { CLI_JS_GZIP_BASE64 } = require("../embedded/cli");
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
  } catch {
    // Intentionally swallowed — extraction attempt is best-effort; falls through to next location
  }

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

  // Build settings from provider config
  // Default: always skip Co-Authored-By attribution in CC agent commits
  const sdkSettings: Record<string, any> = {
    attribution: { commit: "", pr: "" },
  };
  try {
    const { getProviderConfig } = require("../agent/api/provider-config");
    const providerCfg = getProviderConfig(opts.providerName || "claude-code") || {};
    const settings = (providerCfg as any).settings;
    if (settings && typeof settings === "object") {
      Object.assign(sdkSettings, settings);
    }
    // Shorthand: skip_co_author at provider level (now redundant but kept for clarity)
    if ((providerCfg as any).skip_co_author === true) {
      sdkSettings.attribution = { commit: "", pr: "" };
    }
  } catch {
    // Intentionally swallowed — attribution config is optional; defaults remain if config read fails
  }

  // Sandbox control — mirrors other providers' YOLO/sandbox behaviour.
  // Non-YOLO: enable bwrap isolation. autoAllowBashIfSandboxed prevents per-command
  // permission prompts inside the sandbox. allowUnsandboxedCommands:false closes the
  // dangerouslyDisableSandbox escape hatch. All network domains allowed (Docker handles
  // network filtering).
  // YOLO: explicitly disable sandbox — fully unrestricted, no bwrap at all.
  const yolo = opts.yolo ?? false;
  sdkSettings.sandbox = sdkSettings.sandbox || {};
  if (!yolo) {
    sdkSettings.sandbox.enabled = sdkSettings.sandbox.enabled ?? true;
    sdkSettings.sandbox.autoAllowBashIfSandboxed = sdkSettings.sandbox.autoAllowBashIfSandboxed ?? true;
    sdkSettings.sandbox.allowUnsandboxedCommands = sdkSettings.sandbox.allowUnsandboxedCommands ?? false;
  } else {
    // YOLO: force sandbox off regardless of provider config settings
    sdkSettings.sandbox.enabled = false;
  }

  const baseOptions: Options = {
    model: opts.model || "sonnet",
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Disable CC's built-in tools — CC agents must use Claw'd MCP equivalents instead.
    // This ensures consistent project-root scoping, security, and UX across all providers.
    disallowedTools: [
      // File tools → use mcp__clawd__file_view/edit/multi_edit/create/glob/grep
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "LS",
      "NotebookRead",
      "NotebookEdit",
      // Shell → use mcp__clawd__bash
      "Bash",
      // Todo → use mcp__clawd__todo_read/write/update
      "TodoRead",
      "TodoWrite",
      // Task/agent lifecycle → use mcp__clawd__complete_task / mcp__clawd__stop_agent
      "TaskOutput",
      "TaskStop",
      // User interaction → use mcp__clawd__chat_send_message
      "AskUserQuestion",
      // CC-internal plan mode — no Claw'd equivalent, not meaningful outside CC UI
      "EnterPlanMode",
      "ExitPlanMode",
      // CC-internal git worktree management — not used in Claw'd spaces
      "EnterWorktree",
      "ExitWorktree",
      // Remote triggers → use mcp__clawd__scheduler_create/list etc.
      "RemoteTrigger",
      // Sub-agent spawning → use mcp__clawd__spawn_agent
      "Agent",
      // Claw'd provides its own schedule tools — disable CC's native cron tools
      "CronCreate",
      "CronDelete",
      "CronList",
      ...(opts.disallowedTools ?? []),
    ],
    agent: opts.agentName,
    agents: opts.agentDef,
    mcpServers: opts.mcpServers,
    abortController: opts.abortController,
    env: buildEnv(opts.providerName, opts.env, !yolo),
    includePartialMessages: true,
    // Resolve cli.js explicitly — compiled binaries can't use import.meta.url
    ...resolveSDKCliPath(),
    // Pass through settings (attribution, permissions, etc.)
    ...(Object.keys(sdkSettings).length > 0 ? { settings: sdkSettings } : {}),
    hooks: {
      PreToolUse: [createPreToolUseHook()],
      PostToolUse: [createPostToolUseHook(callbacks.onToolResult, callbacks.onActivity)],
    },
  };

  // Try with resume first; if session is stale, retry without it
  const options: Options = opts.resume ? { ...baseOptions, resume: opts.resume } : baseOptions;

  const runStream = async (runOptions: Options): Promise<void> => {
    // Cast prompt: the public SDK type names the iterable element as SDKUserMessage,
    // but the SDK runtime discriminates on `.type` and handles assistant-role
    // entries on the same channel (see build-sdk-messages.ts). We pass mixed
    // user/assistant role messages in the iterable path.
    const stream = query({ prompt: opts.prompt as any, options: runOptions });
    for await (const message of stream) {
      processMessage(message, callbacks, (sid) => {
        sessionId = sid;
      });
    }
  };

  const MAX_500_RETRIES = 2;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_500_RETRIES; attempt++) {
    try {
      await runStream(attempt === 0 ? options : baseOptions);
      return sessionId; // Success — exit early
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[claude-code-sdk] Query failed (attempt ${attempt + 1}): ${msg.slice(0, 200)}`);

      // Stale/corrupted session — retry without resume
      const isSessionError =
        msg.includes("exited with code") ||
        msg.includes("No conversation found") ||
        msg.includes("Invalid `signature` in `thinking` block");
      if (opts.resume && isSessionError && attempt === 0) {
        console.warn(`[claude-code-sdk] Clearing stale session ${opts.resume?.slice(0, 8)}... — retrying fresh`);
        callbacks.onSessionId(""); // Signal session cleared
        continue; // Next iteration uses baseOptions (no resume)
      }

      // 500/server error — retry with backoff
      const is500 = msg.includes("500") || msg.includes("Internal server error") || msg.includes("api_error");
      if (is500 && attempt < MAX_500_RETRIES) {
        const delay = 5000 * (attempt + 1);
        console.warn(`[claude-code-sdk] Server error, retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw err;
    }
  }

  throw lastErr;
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
