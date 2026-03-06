/**
 * Config File Loader
 *
 * Reads app-level settings from ~/.clawd/config.json.
 * Safe to import at module level — uses synchronous file I/O.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ConfigFile {
  host?: string;
  port?: number;
  debug?: boolean;
  yolo?: boolean;
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
}

const CONFIG_PATH = join(homedir(), ".clawd", "config.json");

let _cached: ConfigFile | null = null;

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
  // Record<string, string[]> — per-channel auth tokens
  if (typeof br === "object" && br !== null) {
    if (!channel) return Object.keys(br).length > 0;
    return Object.hasOwn(br, channel);
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
 * Get the auth tokens valid for a specific channel.
 * Returns null if no auth is required; empty array if channel has no tokens.
 */
export function getBrowserTokensForChannel(channel: string): string[] | null {
  const config = loadConfigFile();
  const br = config.browser;
  if (typeof br !== "object" || br === null || Array.isArray(br)) return null;
  const tokens = br[channel];
  if (!Array.isArray(tokens)) return [];
  return tokens.filter((t) => typeof t === "string" && t.length > 0);
}

/**
 * Find which channels a given auth token belongs to.
 */
export function getChannelsForToken(token: string): string[] {
  const config = loadConfigFile();
  const br = config.browser;
  if (typeof br !== "object" || br === null || Array.isArray(br)) return [];
  const channels: string[] = [];
  for (const [channel, tokens] of Object.entries(br)) {
    if (Array.isArray(tokens) && token.length > 0 && tokens.includes(token)) {
      channels.push(channel);
    }
  }
  return channels;
}
