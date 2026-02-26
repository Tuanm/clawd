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
