/**
 * Config File Loader
 *
 * Reads app-level settings from ~/.clawd/config.json.
 * Safe to import at module level — uses synchronous file I/O.
 */

import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { matchesPattern } from "./utils/pattern";

export interface ConfigFile {
  host?: string;
  port?: number;
  debug?: boolean;
  yolo?: boolean;
  /**
   * Restrict new agent project paths to subdirectories of this folder.
   * When set, agents can only be created with a `project` path inside this root.
   * Applies in non-YOLO (sandbox) mode only.
   *
   * Example: `"root": "/home/user/projects"`
   */
  root?: string;
  contextMode?: boolean;
  dataDir?: string;
  uiDir?: string;
  providers?: Record<string, unknown>;
  /** Environment variables for native tool integrations (e.g., GEMINI_API_KEY) */
  env?: Record<string, string>;
  /** Quota tracking settings */
  quotas?: {
    /** Daily image generation limit (0 = unlimited). Default: 50 */
    daily_image_limit?: number;
  };
  /**
   * Enable agent workspace features (Docker containers, noVNC, browser tools).
   *
   * - `true`  — enabled for ALL channels
   * - `false` or omitted — disabled (default)
   * - `string[]` — enabled only for the listed channel names
   *
   * Example: `"workspaces": ["demo-agent-workspace", "dev"]`
   */
  workspaces?: boolean | string[];
  /**
   * Remote worker configuration.
   * - `true` → allow all workers on all channels (prints startup warning)
   * - `{ "channel-1": ["token-1", "token-2"] }` → channel-specific tokens
   */
  worker?: boolean | Record<string, string[]>;
  /**
   * Vision / image processing configuration.
   * Per-operation keys take precedence over top-level defaults.
   *
   * Example:
   *   "vision": {
   *     "read_image":     { "provider": "copilot", "model": "gpt-4.1" },
   *     "generate_image": { "provider": "minimax", "model": "image-01" },
   *     "edit_image":     { "provider": "minimax", "model": "image-01" }
   *   }
   *
   * Providers: "copilot" | "gemini" | "minimax"
   * If omitted, falls back to the built-in Gemini → MiniMax chain.
   */
  vision?: {
    provider?: string;
    model?: string;
    read_image?: { provider: string; model?: string };
    generate_image?: { provider: string; model?: string };
    edit_image?: { provider: string; model?: string };
  };
  /**
   * Enable browser automation tools (Chrome extension bridge).
   *
   * - `true`  — enabled for ALL channels, any browser can connect (no auth)
   * - `false` or omitted — disabled (default)
   * - `string[]` — enabled only for the listed channel names (no auth)
   * - `Record<string, string[]>` — per-channel auth tokens. Keys are channel
   *   names, values are arrays of auth tokens that browsers must provide.
   *   Only browsers with a matching token can be used by agents in that channel.
   *
   * Example: `"browser": { "dev": ["tok_abc", "tok_xyz"], "prod": ["tok_prod"] }`
   */
  browser?: boolean | string[] | Record<string, string[]>;
  /**
   * Agent long-term memory configuration.
   *
   * - `true`  — enabled with defaults for all agents
   * - `false` or omitted — disabled (default)
   * - Object — enabled with custom settings
   *
   * Example: `"memory": { "provider": "anthropic", "model": "claude-haiku-4.5" }`
   */
  memory?:
    | boolean
    | {
        /** Override provider for memory extraction LLM calls */
        provider?: string;
        /** Override model for memory extraction LLM calls */
        model?: string;
        /** Enable/disable auto-extraction from responses (default: true when memory enabled) */
        autoExtract?: boolean;
      };
  /**
   * Heartbeat monitor for automatic stuck-agent recovery.
   *
   * When enabled, periodically checks agent health and:
   * - Cancels agents stuck processing beyond `processingTimeoutMs`
   * - Injects [HEARTBEAT] signals for idle agents with a configured heartbeat_interval
   *
   * Example: `"heartbeat": { "enabled": true, "intervalMs": 10000 }`
   */
  heartbeat?: {
    enabled?: boolean;
    intervalMs?: number;
    processingTimeoutMs?: number;
    spaceIdleTimeoutMs?: number;
  };
  /**
   * API authentication configuration.
   *
   * Legacy:   `{ "token": "abc" }` — single global token (treated as `{ "*": ["abc"] }`)
   * Channel:  `{ "chan-*": ["tok1", "tok2"], "other": ["tok3"] }`
   *           Keys are glob patterns (* = any chars, ? treated as literal).
   *           Use "*" as a catch-all.
   *
   * When omitted, auth is disabled.
   */
  auth?: { token: string } | Record<string, string[]>;
  /**
   * Override token limits for specific models, organized by provider.
   * Merged with built-in defaults (overrides take precedence).
   * Model keys can be aliases or exact IDs.
   *
   * Example:
   * ```json
   * "model_token_limits": {
   *   "copilot": { "gpt-4.1": 64000, "gpt-4.1-mini": 32000 },
   *   "anthropic": { "claude-sonnet-4": 200000 },
   *   "ollama": { "llama3": 8000 }
   * }
   * ```
   */
  model_token_limits?: Record<string, Record<string, number>>;
  /**
   * Enable git worktree isolation for multi-agent channels.
   * Each agent gets its own worktree branch to prevent file conflicts.
   *
   * - `true`  — enabled for ALL channels
   * - `false` or omitted — disabled (default)
   * - `string[]` — enabled only for listed channel names
   */
  worktree?: boolean | string[];
  /**
   * Author identity for worktree commits.
   * If git local config has user.name/email: those are main author, this becomes Co-Authored-By trailer.
   * If git local config is missing: this becomes the main author via -c flags.
   */
  author?: {
    name: string;
    email: string;
  };
}

const CONFIG_PATH = join(homedir(), ".clawd", "config.json");

let _cached: ConfigFile | null = null;

// Watch ~/.clawd/config.json for changes and auto-invalidate the cache.
// Uses { persistent: false } so the watcher never prevents process exit.
// Debounced 200 ms to coalesce rapid save events (editors often write twice).
let _watchDebounce: ReturnType<typeof setTimeout> | null = null;
try {
  watch(CONFIG_PATH, { persistent: false }, () => {
    if (_watchDebounce) clearTimeout(_watchDebounce);
    _watchDebounce = setTimeout(() => {
      _cached = null;
      _watchDebounce = null;
    }, 200);
  });
} catch {
  // File may not exist yet — watcher will be absent until next restart.
  // This is fine; the cache will still be invalidated via reloadConfigFile().
}

/** Load and cache ~/.clawd/config.json */
export function loadConfigFile(): ConfigFile {
  if (_cached) return _cached;

  if (!existsSync(CONFIG_PATH)) {
    _cached = {};
    return _cached;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    _cached = JSON.parse(raw) as ConfigFile;
  } catch {
    _cached = {};
  }

  return _cached;
}

/** Invalidate the cached config so the next loadConfigFile() re-reads from disk. */
export function reloadConfigFile(): ConfigFile {
  _cached = null;
  return loadConfigFile();
}

/** Get data directory from config file or default */
export function getDataDir(): string {
  const config = loadConfigFile();
  return config.dataDir || join(homedir(), ".clawd", "data");
}

/** Get environment variables from config file's env section */
export function getConfigEnv(): Record<string, string> {
  const config = loadConfigFile();
  const env = config.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  // Filter to string values only (defense against malformed config)
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

/** Get a specific environment variable: config env → process.env fallback */
export function getEnvVar(key: string): string | undefined {
  const configEnv = getConfigEnv();
  if (key in configEnv) return configEnv[key];
  return process.env[key];
}

/**
 * Check if workspace features are enabled.
 * - No channel arg: returns true if workspaces are enabled at all (any channel).
 * - With channel arg: returns true if workspaces are enabled for that specific channel.
 */
export function isWorkspacesEnabled(channel?: string): boolean {
  const config = loadConfigFile();
  const ws = config.workspaces;
  if (ws === undefined || ws === false) return false;
  if (ws === true) return true;
  if (Array.isArray(ws)) {
    if (!channel) return ws.length > 0;
    return ws.includes(channel);
  }
  return false;
}

/**
 * Check if browser automation features are enabled.
 * - No channel arg: returns true if browser is enabled at all (any channel).
 * - With channel arg: returns true if browser is enabled for that specific channel.
 */
export function isBrowserEnabled(channel?: string): boolean {
  const config = loadConfigFile();
  const br = config.browser;
  if (br === undefined || br === false) return false;
  if (br === true) return true;
  if (Array.isArray(br)) {
    if (!channel) return br.length > 0;
    return br.includes(channel);
  }
  // Record<string, string[]> — per-channel auth tokens (wildcard-aware)
  if (typeof br === "object" && br !== null) {
    if (!channel) return Object.keys(br).length > 0;
    return Object.keys(br as Record<string, unknown>).some((p) => matchesPattern(channel, p));
  }
  return false;
}

/**
 * Check if browser auth tokens are required (config is a token map, not boolean/array).
 */
export function isBrowserAuthRequired(): boolean {
  const config = loadConfigFile();
  const br = config.browser;
  return typeof br === "object" && br !== null && !Array.isArray(br);
}

/**
 * Get the set of valid auth tokens across all channels (for connection validation).
 * Returns null if no auth is required (browser: true or string[]).
 */
export function getAllBrowserTokens(): Set<string> | null {
  const config = loadConfigFile();
  const br = config.browser;
  if (typeof br !== "object" || br === null || Array.isArray(br)) return null;
  const tokens = new Set<string>();
  for (const arr of Object.values(br)) {
    if (Array.isArray(arr)) {
      for (const t of arr) {
        if (typeof t === "string" && t.length > 0) tokens.add(t);
      }
    }
  }
  return tokens;
}

/**
 * Get the auth tokens valid for a specific channel (wildcard-aware).
 * Returns null if no auth is required; empty array if channel has no tokens.
 */
export function getBrowserTokensForChannel(channel: string): string[] | null {
  const config = loadConfigFile();
  const br = config.browser;
  if (typeof br !== "object" || br === null || Array.isArray(br)) return null;
  const tokens: string[] = [];
  for (const [pattern, toks] of Object.entries(br as Record<string, unknown>)) {
    if (!Array.isArray(toks)) continue;
    if (matchesPattern(channel, pattern)) {
      tokens.push(...toks.filter((t): t is string => typeof t === "string" && t.length > 0));
    }
  }
  return tokens;
}

// timing-safe token comparison — used across this module and remote-worker.ts
/** Constant-time string equality check (prevents timing attacks on token validation). */
export function safeTokenEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

function isLegacyAuth(auth: ConfigFile["auth"]): auth is { token: string } {
  return (
    typeof auth === "object" &&
    auth !== null &&
    "token" in auth &&
    typeof (auth as { token: unknown }).token === "string"
  );
}

function normaliseAuthConfig(auth: ConfigFile["auth"]): Record<string, string[]> | null {
  if (!auth) return null;
  if (isLegacyAuth(auth)) {
    if (!auth.token.trim()) return null; // empty/whitespace → auth disabled
    return { "*": [auth.token] };
  }
  const result: Record<string, string[]> = {};
  for (const [pattern, tokens] of Object.entries(auth as Record<string, unknown>)) {
    if (!Array.isArray(tokens)) continue; // skip malformed entries
    const valid = tokens.filter((t): t is string => typeof t === "string" && t.length > 0);
    if (valid.length > 0) result[pattern] = valid;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function isAuthEnabled(): boolean {
  return normaliseAuthConfig(loadConfigFile().auth) !== null;
}

export function isChannelAuthRequired(channel: string): boolean {
  const map = normaliseAuthConfig(loadConfigFile().auth);
  if (!map) return false;
  return Object.entries(map).some(([p]) => matchesPattern(channel, p));
}

/**
 * Returns true if a catch-all "*" auth pattern is configured (global auth gate).
 * When false, auth is channel-scoped only — unauthenticated channels and
 * channel-agnostic endpoints (WebSocket, global API calls) should be allowed through.
 */
export function hasGlobalAuth(): boolean {
  const map = normaliseAuthConfig(loadConfigFile().auth);
  if (!map) return false;
  return "*" in map;
}

/**
 * Validate a token for a channel (timing-safe, single config snapshot).
 * Pass INTERNAL_SERVICE_TOKEN check BEFORE calling this (handled in middleware).
 * - channel provided: validates against tokens for that channel's patterns only
 * - no channel: validates against all tokens across all patterns (used by WS upgrade)
 */
export function validateApiToken(token: string | null | undefined, channel?: string): boolean {
  if (!token) return false;
  const map = normaliseAuthConfig(loadConfigFile().auth); // single config read
  if (!map) return true; // auth not configured → allow
  // Inline pattern filter — no second loadConfigFile() call (v4 fix)
  const candidates = channel
    ? Object.entries(map)
        .filter(([p]) => matchesPattern(channel, p))
        .flatMap(([, toks]) => toks)
    : Object.values(map).flat();
  return candidates.some((c) => safeTokenEqual(c, token));
}

/**
 * @deprecated Use isAuthEnabled() + validateApiToken() for new code.
 * Returns the single global token if legacy config is used, or null.
 * Under channel-based config without a "*" key, returns null even if auth IS active.
 */
export function getAuthToken(): string | null {
  const map = normaliseAuthConfig(loadConfigFile().auth);
  if (!map) return null;
  const tok = map["*"]?.[0] ?? null;
  if (tok === null && isAuthEnabled()) {
    console.warn(
      "[getAuthToken] @deprecated: channel-based auth is active but no '*' catch-all key exists." +
        " Migrate this caller to isAuthEnabled() / validateApiToken().",
    );
  }
  return tok;
}

/** Returns matching glob patterns for a given browser token. Timing-safe (v4). */
export function getChannelsForToken(token: string): string[] {
  const config = loadConfigFile();
  const br = config.browser;
  if (typeof br !== "object" || br === null || Array.isArray(br)) return [];
  return Object.entries(br as Record<string, unknown>)
    .filter(
      ([, toks]) => Array.isArray(toks) && (toks as string[]).some((t) => safeTokenEqual(t, token)), // timing-safe (v4 fix)
    )
    .map(([pattern]) => pattern);
}

/**
 * Check if worktree isolation is enabled.
 * - No channel arg: returns true if worktree is enabled at all.
 * - With channel arg: returns true if worktree is enabled for that specific channel.
 */
export function isWorktreeEnabled(channel?: string): boolean {
  const config = loadConfigFile();
  const wt = config.worktree;
  if (wt === undefined || wt === false) return false;
  if (wt === true) return true;
  if (Array.isArray(wt)) {
    if (!channel) return wt.length > 0;
    return wt.includes(channel);
  }
  return false;
}

/**
 * Get the configured author identity for worktree commits.
 * Returns null if not configured.
 */
export function getAuthorConfig(): { name: string; email: string } | null {
  const config = loadConfigFile();
  const a = config.author;
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  if (typeof a.name !== "string" || typeof a.email !== "string") return null;
  if (!a.name.trim() || !a.email.trim()) return null;
  return { name: a.name.trim(), email: a.email.trim() };
}
