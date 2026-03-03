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
