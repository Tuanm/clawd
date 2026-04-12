/**
 * Tool Registry — Shared infrastructure for all tool modules.
 *
 * Provides:
 * - ToolResult / ToolHandler types
 * - tools Map + toolDefinitions array (the registry)
 * - registerTool() function
 * - Shared utilities (path safety, shell helpers, chat API state, etc.)
 */

import { basename, join, resolve } from "node:path";
import { timedFetch as _timedFetch } from "../../utils/timed-fetch";
import type { ToolDefinition } from "../api/client";
import { getAgentContext, getContextAgentId, getContextChannel, getContextConfigRoot } from "../utils/agent-context";
import {
  checkSandboxBeforeExec,
  getSandboxProjectRoot,
  isSandboxEnabled,
  isSandboxReady,
  runInSandbox,
  wrapCommandForSandbox,
} from "../utils/sandbox";

// Re-export sandbox utilities for consumers
export {
  getSandboxProjectRoot,
  isSandboxEnabled,
  isSandboxReady,
  runInSandbox,
  wrapCommandForSandbox,
  checkSandboxBeforeExec,
};
// Re-export agent context for consumers
export { getAgentContext, getContextAgentId, getContextChannel, getContextConfigRoot };

// ============================================================================
// Cross-platform shell helper
// ============================================================================

export const IS_WINDOWS = process.platform === "win32";

/** Validate and return a safe Windows shell executable from ComSpec */
export function getSafeWindowsShell(): string {
  const comSpec = process.env.ComSpec ?? "";
  const lower = comSpec.toLowerCase();
  // Only allow known-safe shells; reject anything that looks like a path traversal or injection
  if (lower.endsWith("\\cmd.exe") || lower.endsWith("/cmd.exe")) return comSpec;
  if (lower.endsWith("\\powershell.exe") || lower.endsWith("/powershell.exe")) return comSpec;
  // Fallback to a safe default
  return "cmd.exe";
}

/** Strip HTML tag blocks (e.g., <script>...</script>) from HTML content */
export function stripHtmlTagBlocks(html: string, tagName: string): string {
  // Use index-based approach to avoid regex issues with large content
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let result = html;
  let start = result.toLowerCase().indexOf(openTag.toLowerCase());
  while (start !== -1) {
    const end = result.toLowerCase().indexOf(closeTag.toLowerCase(), start);
    if (end === -1) break;
    result = result.slice(0, start) + result.slice(end + closeTag.length);
    start = result.toLowerCase().indexOf(openTag.toLowerCase());
  }
  return result;
}

/** Get shell and args for cross-platform execution */
export function getShellArgs(command: string): [string, string[]] {
  if (IS_WINDOWS) {
    const shell = getSafeWindowsShell();
    return [shell, ["/c", command]];
  }
  return ["bash", ["-c", command]];
}

// ============================================================================
// API Response Types (internal, used by chat-tools)
// ============================================================================

export interface ApiResponse {
  ok?: boolean;
  error?: string;
  [key: string]: any;
}

export interface ChatResponse extends ApiResponse {
  ts?: string;
  messages?: Record<string, unknown>[];
}

export interface TaskResponse extends ApiResponse {
  task?: any;
  tasks?: any[];
}

export interface PlanResponse extends ApiResponse {
  plan?: any;
  plans?: any[];
  phase?: any;
  phases?: any[];
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Safe JSON parse that returns a default value on failure
 */
export function _safeJsonParse<T = any>(text: string | undefined | null, defaultValue: T): T {
  if (!text) return defaultValue;
  try {
    return JSON.parse(text);
  } catch {
    return defaultValue;
  }
}

/**
 * Normalize tool arguments - handles LLM quirks like string-encoded arrays/objects
 */
export function normalizeToolArgs(args: Record<string, any>): Record<string, any> {
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
        try {
          normalized[key] = JSON.parse(trimmed);
          continue;
        } catch {
          // Not valid JSON, keep as string
        }
      }
    }
    normalized[key] = value;
  }
  return normalized;
}

// ============================================================================
// Project Hash / Directory
// ============================================================================

// Project hash for data isolation (agents, jobs, etc.)
let projectHashFallback: string = "";

export function setProjectHash(hash: string) {
  projectHashFallback = hash;
}

export function getProjectHash(): string {
  const ctx = getAgentContext();
  if (ctx?.projectHash) return ctx.projectHash;
  if (!projectHashFallback) {
    const { createHash } = require("node:crypto");
    const root = getSandboxProjectRoot();
    projectHashFallback = createHash("sha256").update(root).digest("hex").slice(0, 12);
  }
  return projectHashFallback;
}

export function getProjectDir(): string {
  const { homedir } = require("node:os");
  const { join } = require("node:path");
  return join(homedir(), ".clawd", "projects", getProjectHash());
}

export function getProjectAgentsDir(): string {
  const { join } = require("node:path");
  return join(getProjectDir(), "agents");
}

export function getProjectJobsDir(): string {
  const { join } = require("node:path");
  return join(getProjectDir(), "jobs");
}

// ============================================================================
// Path Security
// ============================================================================

export function isSensitiveFile(targetPath: string): boolean {
  const resolved = resolve(targetPath);
  const bn = basename(resolved);
  if (bn === ".env.example" || bn.endsWith(".example")) return false;
  if (bn === ".env" || bn.startsWith(".env.")) return true;
  return false;
}

export function resolveSafePath(inputPath: string): string {
  if (!inputPath) return getSandboxProjectRoot();
  if (inputPath.startsWith("/") || (IS_WINDOWS && /^[a-zA-Z]:[\\/]/.test(inputPath))) {
    return resolve(inputPath);
  }
  return resolve(getSandboxProjectRoot(), inputPath);
}

export function isPathAllowed(targetPath: string): boolean {
  if (!isSandboxEnabled()) return true;
  const resolved = resolve(targetPath);
  const projectRoot = getSandboxProjectRoot();
  const { tmpdir } = require("node:os");
  const { sep } = require("node:path");
  const tmp = tmpdir();
  const allowedPrefixes = [projectRoot, tmp];
  return allowedPrefixes.some(
    (prefix) => resolved === prefix || resolved.startsWith(prefix + sep) || resolved.startsWith(prefix + "/"),
  );
}

export function validatePath(targetPath: string, operation: string): string | null {
  // Block ~/.clawd/config.json in all modes (protects Claw'd credentials and configuration)
  const { homedir } = require("node:os");
  const configFile = join(homedir(), ".clawd", "config.json");
  if (resolve(targetPath) === configFile) {
    return "Access to ~/.clawd/config.json is blocked. This file contains sensitive configuration and credentials.";
  }

  // Remaining restrictions only apply in sandbox mode (YOLO = fully unrestricted)
  if (!isSandboxEnabled()) return null;

  if (!isPathAllowed(targetPath)) {
    const projectRoot = getSandboxProjectRoot();
    return (
      `SANDBOX RESTRICTION: You do not have permission to ${operation} "${targetPath}". ` +
      `You can only access files within: ${projectRoot} or the system temp directory. ` +
      `This is a security restriction - do not attempt to bypass it.`
    );
  }
  if (isSensitiveFile(targetPath)) {
    return (
      `SANDBOX RESTRICTION: Access to .env files is blocked for security reasons. ` +
      `These files may contain secrets. Do not attempt to read or modify them.`
    );
  }
  return null;
}

// ============================================================================
// Chat API State (set by agent runtime)
// ============================================================================

export let currentAgentId = "default";
export let currentChannel = "general";
export let chatApiUrl = "http://localhost:53456";

export function setCurrentAgentId(id: string) {
  currentAgentId = id;
}

export function setCurrentChannel(channel: string) {
  currentChannel = channel;
}

export function setChatApiUrl(url: string) {
  chatApiUrl = url;
}

/** Fetch with timeout to prevent hangs on self-calls to localhost (15 s default). */
export function toolFetch(url: string, options: RequestInit = {}, ms = 15000): Promise<Response> {
  return _timedFetch(url, options, ms);
}

/** Get the context-aware channel (agent context takes priority over global) */
export function getContextChannel_(): string {
  return getContextChannel() || currentChannel;
}

/** Get the context-aware agent ID (agent context takes priority over global) */
export function getContextAgentId_(): string {
  return getContextAgentId() || currentAgentId;
}

// ============================================================================
// Tool Registry
// ============================================================================

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export type ToolHandler = (args: Record<string, any>) => Promise<ToolResult>;

export const tools: Map<string, ToolHandler> = new Map();
export const toolDefinitions: ToolDefinition[] = [];

export function registerTool(
  name: string,
  description: string,
  parameters: Record<string, any>,
  required: string[],
  handler: ToolHandler,
  readOnly?: boolean,
) {
  tools.set(name, handler);
  const def: ToolDefinition = {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: parameters,
        required,
      },
    },
  };
  if (readOnly) def.readOnly = true;
  toolDefinitions.push(def);
}
