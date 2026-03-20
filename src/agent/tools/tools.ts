/**
 * Tool Definitions and Execution
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ToolCall, ToolDefinition } from "../api/client";
import { getHookManager } from "../hooks/manager";
import {
  enableSandbox,
  getSandboxProjectRoot,
  isSandboxEnabled,
  isSandboxReady,
  runInSandbox,
  setSandboxProjectRoot,
  wrapCommandForSandbox,
} from "../utils/sandbox";

// ============================================================================
// Cross-platform shell helper
// ============================================================================

const IS_WINDOWS = process.platform === "win32";

/** Validate and return a safe Windows shell executable from ComSpec */
function getSafeWindowsShell(): string {
  const comSpec = process.env.ComSpec ?? "";
  const lower = comSpec.toLowerCase();
  // Only accept known Windows shell executables to prevent injection via ComSpec
  if (lower.endsWith("\\powershell.exe") || lower.endsWith("\\pwsh.exe")) return comSpec;
  if (lower.endsWith("\\cmd.exe")) return comSpec;
  // Fall back to cmd.exe if ComSpec is unrecognized or missing
  return "cmd.exe";
}

/** Strip all <tagName>...</tagName> blocks using index-based search (avoids regex flagged by CodeQL) */
function stripHtmlTagBlocks(html: string, tagName: string): string {
  let result = html;
  const openPattern = new RegExp(`<${tagName}\\b`, "i");
  const closeTag = `</${tagName}>`;
  let safety = 100;
  while (safety-- > 0) {
    const openMatch = openPattern.exec(result);
    if (!openMatch) break;
    const closeIdx = result.toLowerCase().indexOf(closeTag.toLowerCase(), openMatch.index);
    if (closeIdx === -1) {
      result = result.slice(0, openMatch.index);
      break;
    }
    result = result.slice(0, openMatch.index) + result.slice(closeIdx + closeTag.length);
  }
  return result;
}

/** Get the shell command and args to execute a command string on the current OS */
function getShellArgs(command: string): [string, string[]] {
  if (IS_WINDOWS) {
    // Use PowerShell if available, otherwise cmd.exe
    const shell = getSafeWindowsShell();
    const lower = shell.toLowerCase();
    if (lower.includes("powershell") || lower.includes("pwsh")) {
      return [shell, ["-NoProfile", "-NonInteractive", "-Command", command]];
    }
    return [shell, ["/C", command]];
  }
  return ["bash", ["-c", command]];
}

// ============================================================================
// API Response Types
// ============================================================================

interface ApiResponse {
  ok?: boolean;
  error?: string;
  [key: string]: any;
}

interface ChatResponse extends ApiResponse {
  ts?: string;
  messages?: any[];
}

interface TaskResponse extends ApiResponse {
  task?: any;
  tasks?: any[];
}

interface PlanResponse extends ApiResponse {
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
function _safeJsonParse<T = any>(text: string | undefined | null, defaultValue: T): T {
  if (!text) return defaultValue;
  try {
    return JSON.parse(text);
  } catch {
    return defaultValue;
  }
}

/**
 * Normalize tool arguments - handles LLM quirks like string-encoded arrays/objects
 * Some models (e.g., Claude) sometimes serialize arrays as strings like '["a","b"]'
 */
function normalizeToolArgs(args: Record<string, any>): Record<string, any> {
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      // Try to parse string values that look like JSON arrays or objects
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
// Path Security - Sandbox Restrictions
// ============================================================================

// Re-export agent context functions for worker-loop.ts
export { getAgentContext, getContextAgentId, getContextChannel, runWithAgentContext } from "../utils/agent-context";
// Re-export sandbox functions used by other modules (index.ts, worker-loop.ts, etc.)
export { enableSandbox, getSandboxProjectRoot, setSandboxProjectRoot } from "../utils/sandbox";

// Import getAgentContext for internal use
import { getAgentContext, getContextAgentId, getContextChannel } from "../utils/agent-context";

// Project hash for data isolation (agents, jobs, etc.)
// NOTE: projectHashFallback is kept for backward compatibility with CLI mode (single agent).
// In clawd-app mode with multiple agents, the hash is read from AgentContext.
let projectHashFallback: string = "";

/**
 * Set the project hash for data isolation (CLI mode / backward compatibility).
 * In clawd-app mode with multiple agents, use runWithAgentContext instead.
 */
export function setProjectHash(hash: string) {
  projectHashFallback = hash;
}

/**
 * Get the project hash.
 * In clawd-app mode: returns value from AgentContext (per-agent isolation).
 * In CLI mode: returns fallback or auto-generates from SHA-256 of project root.
 */
export function getProjectHash(): string {
  // First try to get from AgentContext (concurrent agent support)
  const ctx = getAgentContext();
  if (ctx?.projectHash) {
    return ctx.projectHash;
  }
  // Fallback to global (CLI mode / backward compatibility)
  if (!projectHashFallback) {
    const { createHash } = require("node:crypto");
    const root = getSandboxProjectRoot();
    projectHashFallback = createHash("sha256").update(root).digest("hex").slice(0, 12);
  }
  return projectHashFallback;
}

/**
 * Get the project-scoped data directory.
 * Returns ~/.clawd/projects/{hash}/
 */
export function getProjectDir(): string {
  const { homedir } = require("node:os");
  const { join } = require("node:path");
  const dir = join(homedir(), ".clawd", "projects", getProjectHash());
  return dir;
}

/**
 * Get the project-scoped agents directory.
 * Returns ~/.clawd/projects/{hash}/agents/
 */
export function getProjectAgentsDir(): string {
  const { join } = require("node:path");
  return join(getProjectDir(), "agents");
}

/**
 * Get the project-scoped jobs directory.
 * Returns ~/.clawd/projects/{hash}/jobs/
 */
export function getProjectJobsDir(): string {
  const { join } = require("node:path");
  return join(getProjectDir(), "jobs");
}

/**
 * Check if a file is a sensitive file that should be blocked
 */
function isSensitiveFile(targetPath: string): boolean {
  const resolved = resolve(targetPath);
  const bn = basename(resolved);

  // Allow .env.example (template files)
  if (bn === ".env.example" || bn.endsWith(".example")) {
    return false;
  }

  // Block .env files and variants (.env, .env.local, .env.production, etc.)
  if (bn === ".env" || bn.startsWith(".env.")) {
    return true;
  }

  return false;
}

/**
 * Resolve a path that may be relative (from project root) or absolute.
 * Prevents path traversal attacks — resolved path must stay within allowed dirs.
 */
function resolveSafePath(inputPath: string): string {
  if (!inputPath) return getSandboxProjectRoot();
  // Absolute paths pass through directly
  if (inputPath.startsWith("/") || (IS_WINDOWS && /^[a-zA-Z]:[\\/]/.test(inputPath))) {
    return resolve(inputPath);
  }
  // Relative paths resolve from project root
  return resolve(getSandboxProjectRoot(), inputPath);
}

/**
 * Check if a path is within allowed directories:
 * - Project root and subdirectories
 * - /tmp and subdirectories
 */
function isPathAllowed(targetPath: string): boolean {
  if (!isSandboxEnabled()) return true;

  const resolved = resolve(targetPath);
  const projectRoot = getSandboxProjectRoot();

  // Allowed paths: project root and system temp dir (cross-platform)
  const { tmpdir } = require("node:os");
  const allowedPrefixes = [projectRoot, "/tmp", tmpdir()];

  return allowedPrefixes.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`));
}

/**
 * Validate path and return error if not allowed
 */
function validatePath(targetPath: string, operation: string): string | null {
  if (!isPathAllowed(targetPath)) {
    const projectRoot = getSandboxProjectRoot();
    return (
      `SANDBOX RESTRICTION: You do not have permission to ${operation} "${targetPath}". ` +
      `You can only access files within: ${projectRoot} or /tmp. ` +
      `This is a security restriction - do not attempt to bypass it.`
    );
  }

  // Block sensitive files even within allowed paths
  if (isSensitiveFile(targetPath)) {
    return (
      `SANDBOX RESTRICTION: Access to .env files is blocked for security reasons. ` +
      `These files may contain secrets. Do not attempt to read or modify them.`
    );
  }

  return null;
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

function registerTool(
  name: string,
  description: string,
  parameters: Record<string, any>,
  required: string[],
  handler: ToolHandler,
) {
  tools.set(name, handler);
  toolDefinitions.push({
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
  });
}

// ============================================================================
// Tool: Today
// ============================================================================

registerTool(
  "today",
  "Get today's date and current time. Use this when you need to know what day it is, the current time, or calculate relative dates.",
  {},
  [],
  async () => {
    const now = new Date();
    return {
      success: true,
      output: JSON.stringify(
        {
          iso: now.toISOString(),
          date: now.toLocaleDateString("en-CA"), // YYYY-MM-DD
          time: now.toLocaleTimeString("en-US", { hour12: false }),
          day: now.toLocaleDateString("en-US", { weekday: "long" }),
          unix: Math.floor(now.getTime() / 1000),
        },
        null,
        2,
      ),
    };
  },
);

// ============================================================================
// Tool: Get Environment (combined system info + project root)
// ============================================================================

registerTool(
  "get_environment",
  "Get working environment: OS, shell, project root, and runtime. Call at session start. All file tools accept relative paths (resolved from project root).",
  {},
  [],
  async () => {
    const os = await import("node:os");
    const platform = os.platform();
    const isWindows = platform === "win32";
    const shell = isWindows ? getSafeWindowsShell() : process.env.SHELL || "/bin/bash";
    const projectRoot = getSandboxProjectRoot();
    return {
      success: true,
      output: JSON.stringify(
        {
          project_root: projectRoot,
          os: platform,
          arch: os.arch(),
          shell,
          shell_type: isWindows
            ? shell.toLowerCase().includes("powershell")
              ? "powershell"
              : "cmd"
            : shell.split("/").pop(),
          user: os.userInfo().username,
          runtime: `Bun ${Bun.version}`,
          hint: isWindows
            ? "Windows machine. Use PowerShell/cmd syntax. File paths accept relative (from project_root) or absolute."
            : "Unix machine. Use bash syntax. File paths accept relative (from project_root) or absolute.",
        },
        null,
        2,
      ),
    };
  },
);

// Backward compatibility aliases
registerTool("get_project_root", "Alias for get_environment.", {}, [], async () =>
  tools.get("get_environment")!({} as any),
);
registerTool("get_system_info", "Alias for get_environment.", {}, [], async () =>
  tools.get("get_environment")!({} as any),
);

// ============================================================================
// Tool: Shell (cross-platform)
// ============================================================================

/** Maximum bytes to accumulate from a single bash command's stdout+stderr combined */
const MAX_BASH_OUTPUT = 10 * 1024 * 1024; // 10MB

registerTool(
  "bash",
  "Execute a shell command. On Linux/macOS uses bash, on Windows uses cmd.exe or PowerShell natively. No command conversion needed — use the OS-native syntax.",
  {
    command: {
      type: "string",
      description: "The shell command to execute (use OS-native syntax)",
    },
    timeout: {
      type: "number",
      description: "Timeout in milliseconds (default: 30000)",
    },
    cwd: {
      type: "string",
      description: "Working directory for the command",
    },
  },
  ["command"],
  async ({ command, timeout = 30000, cwd }) => {
    let workDir = cwd ? resolveSafePath(cwd) : undefined;

    // When sandbox enabled, use platform-specific isolation (bwrap on Linux, sandbox-exec on macOS)
    if (isSandboxEnabled()) {
      const projectRoot = getSandboxProjectRoot();
      workDir = workDir || projectRoot;

      // Validate cwd is within allowed paths
      const cwdError = validatePath(workDir, "bash cwd");
      if (cwdError) {
        return { success: false, output: "", error: cwdError };
      }

      // Block commands that try to access .env files (but allow .env.example)
      const envFilePattern = /(?:^|[^a-zA-Z0-9_.])\.env(?!\.[a-zA-Z]*example)(?:\.[a-zA-Z0-9_]*)?(?:[^a-zA-Z0-9_.]|$)/;
      if (envFilePattern.test(command)) {
        return {
          success: false,
          output: "",
          error:
            "SANDBOX RESTRICTION: Access to .env files is blocked for security reasons. " +
            "These files may contain secrets. Use .env.example as a template instead.",
        };
      }

      const sandboxNotice = `[SANDBOX MODE] You can ONLY access: ${projectRoot} and /tmp. All other paths are blocked.\n\n`;

      // Use kernel-level isolation (bwrap on Linux, sandbox-exec on macOS) if initialized
      if (isSandboxReady()) {
        try {
          const wrappedCommand = await wrapCommandForSandbox(command, workDir);
          return new Promise((resolve) => {
            const proc = spawn("bash", ["-c", wrappedCommand], { timeout }); // lgtm[js/shell-command-injection-from-environment]
            let timedOut = false;

            const timeoutId = setTimeout(() => {
              timedOut = true;
              proc.kill("SIGKILL");
            }, timeout);

            let stdout = "";
            let stderr = "";
            let outputBytes = 0;

            proc.stdout?.on("data", (data: Buffer) => {
              if (outputBytes < MAX_BASH_OUTPUT) {
                stdout += data.toString();
                outputBytes += data.length;
              }
            });
            proc.stderr?.on("data", (data: Buffer) => {
              if (outputBytes < MAX_BASH_OUTPUT) {
                stderr += data.toString();
                outputBytes += data.length;
              }
            });

            proc.on("close", (code: number | null) => {
              clearTimeout(timeoutId);
              const truncated = outputBytes >= MAX_BASH_OUTPUT ? "\n[OUTPUT TRUNCATED: exceeded 10MB limit]" : "";
              if (timedOut) {
                resolve({
                  success: false,
                  output: stdout.trim() + truncated,
                  error:
                    `TIMEOUT: Command exceeded ${timeout / 1000}s limit. ` +
                    `For long-running tasks, use job_submit instead.`,
                });
                return;
              }
              const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "") + truncated;
              resolve({
                success: code === 0,
                output: sandboxNotice + (output.trim() || "(no output)"),
                error: code !== 0 ? `Exit code: ${code}` : undefined,
              });
            });

            proc.on("error", (err) => {
              clearTimeout(timeoutId);
              resolve({
                success: false,
                output: "",
                error: `Sandbox error: ${err.message}`,
              });
            });
          });
        } catch (sandboxErr: any) {
          return {
            success: false,
            output: "",
            error: `Sandbox wrapping failed: ${sandboxErr.message}`,
          };
        }
      }
      // Fallback: sandbox enabled but kernel-level sandbox not initialized
      // (e.g., missing dependencies). Still apply path validation above.
    }

    // Non-sandboxed mode - run directly (cross-platform shell)
    return new Promise((resolve) => {
      const [shell, shellArgs] = getShellArgs(command);
      const proc = spawn(shell, shellArgs, {
        timeout,
        cwd: workDir,
        env: {
          ...process.env,
          // Suppress interactive prompts (targeted — don't set CI=true as it breaks tmux/others)
          DEBIAN_FRONTEND: "noninteractive",
          GIT_TERMINAL_PROMPT: "0",
          HOMEBREW_NO_AUTO_UPDATE: "1",
          CONDA_YES: "1",
          PIP_NO_INPUT: "1",
        },
      });
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeout);

      let stdout = "";
      let stderr = "";
      let outputBytes = 0;

      proc.stdout?.on("data", (data: Buffer) => {
        if (outputBytes < MAX_BASH_OUTPUT) {
          stdout += data.toString();
          outputBytes += data.length;
        }
      });
      proc.stderr?.on("data", (data: Buffer) => {
        if (outputBytes < MAX_BASH_OUTPUT) {
          stderr += data.toString();
          outputBytes += data.length;
        }
      });

      proc.on("close", (code: number | null) => {
        clearTimeout(timeoutId);
        const truncated = outputBytes >= MAX_BASH_OUTPUT ? "\n[OUTPUT TRUNCATED: exceeded 10MB limit]" : "";
        if (timedOut) {
          resolve({
            success: false,
            output: stdout.trim() + truncated,
            error:
              `TIMEOUT: Command exceeded ${timeout / 1000}s limit. ` +
              `For long-running tasks, use job_submit instead.`,
          });
          return;
        }
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "") + truncated;
        resolve({
          success: code === 0,
          output: output.trim() || "(no output)",
          error: code !== 0 ? `Exit code: ${code}` : undefined,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          output: "",
          error: err.message,
        });
      });
    });
  },
);

// ============================================================================
// Tool: View
// ============================================================================

registerTool(
  "view",
  `View the contents of a file or list directory contents.

**Large File Warning:** Do NOT read entire large files (>1MB) - this wastes tokens and may exceed context limits.

**For Large Files:**
- Use start_line/end_line to read specific sections
- For images/videos: Use Gemini or describe tool instead of reading raw bytes
- For code: Read only the relevant functions/classes you need
- Use "grep" to find specific patterns first, then view just those lines

**Best Practices:**
- Always check file size first with "ls -lh" before reading
- Use grep to locate relevant sections, then view those specific lines
- For binaries/images: Skip entirely or use specialized vision tools`,
  {
    path: {
      type: "string",
      description: "Absolute path to file or directory",
    },
    start_line: {
      type: "number",
      description: "Start line number (1-indexed, for files)",
    },
    end_line: {
      type: "number",
      description: "End line number (for files)",
    },
  },
  ["path"],
  async ({ path, start_line, end_line }) => {
    try {
      const resolvedPath = resolveSafePath(path);

      // Always validate path first (checks both allowed paths AND sensitive files like .env)
      const pathError = validatePath(resolvedPath, "view");
      if (pathError) {
        return { success: false, output: "", error: pathError };
      }

      // Use sandbox for filesystem isolation
      if (isSandboxReady()) {
        // Check if file/dir exists and get type
        const testResult = await runInSandbox("test", ["-e", resolvedPath]);
        if (!testResult.success) {
          return {
            success: false,
            output: "",
            error: `Path not found: ${path}`,
          };
        }

        const isDirResult = await runInSandbox("test", ["-d", resolvedPath]);
        const isDir = isDirResult.success;

        if (isDir) {
          const result = await runInSandbox("ls", ["-1", resolvedPath]);
          if (!result.success) {
            return {
              success: false,
              output: "",
              error: result.stderr || "Failed to list directory",
            };
          }
          const entries = result.stdout.trim().split("\n").filter(Boolean);
          const output = entries.length > 0 ? entries.map((e) => `📄 ${e}`).join("\n") : "(empty directory)";
          return { success: true, output };
        }

        // Check file size before reading (using statSync - cross-platform, no shell dependency)
        try {
          const fileSize = statSync(resolvedPath).size;
          if (fileSize > 1024 * 1024) {
            return {
              success: false,
              output: "",
              error: `File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Use start_line/end_line to read specific sections, or use grep to find relevant parts first.`,
            };
          }
        } catch {
          // stat failed - proceed and let cat report any error
        }

        // Read file
        const catArgs = [resolvedPath];
        const result = await runInSandbox("cat", catArgs);
        if (!result.success) {
          return {
            success: false,
            output: "",
            error: result.stderr || "Failed to read file",
          };
        }

        let content = result.stdout;
        const lines = content.split("\n");

        if (start_line || end_line) {
          const start = Math.max(1, start_line || 1) - 1;
          const end = Math.min(lines.length, end_line || lines.length);
          const selectedLines = lines.slice(start, end);
          content = selectedLines.map((line, i) => `${start + i + 1}. ${line}`).join("\n");
        } else {
          content = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");
        }

        if (content.length > 50000) {
          content = `${content.slice(0, 50000)}\n\n[Content truncated - file too large. Use view() with start_line/end_line to read specific sections, or use grep to find relevant parts first.]`;
        }

        return { success: true, output: content };
      }

      // Fallback: direct fs access (path already validated above)
      if (!existsSync(resolvedPath)) {
        return { success: false, output: "", error: `Path not found: ${path}` };
      }

      const stat = statSync(resolvedPath);

      // Check file size before reading
      if (stat.size > 1024 * 1024) {
        return {
          success: false,
          output: "",
          error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Use start_line/end_line to read specific sections, or use grep to find relevant parts first.`,
        };
      }

      if (stat.isDirectory()) {
        const entries = readdirSync(resolvedPath, { withFileTypes: true });
        const output = entries.map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`).join("\n");
        return { success: true, output: output || "(empty directory)" };
      }

      let content = readFileSync(resolvedPath, "utf-8");
      const lines = content.split("\n");

      if (start_line || end_line) {
        const start = Math.max(1, start_line || 1) - 1;
        const end = Math.min(lines.length, end_line || lines.length);
        const selectedLines = lines.slice(start, end);
        content = selectedLines.map((line, i) => `${start + i + 1}. ${line}`).join("\n");
      } else {
        content = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");
      }

      if (content.length > 50000) {
        content = `${content.slice(0, 50000)}\n... (truncated)`;
      }

      return { success: true, output: content };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Edit
// ============================================================================

registerTool(
  "edit",
  "Edit a file by replacing text. The old_str must match exactly.",
  {
    path: {
      type: "string",
      description: "Absolute path to file",
    },
    old_str: {
      type: "string",
      description: "Text to find and replace (must match exactly)",
    },
    new_str: {
      type: "string",
      description: "Replacement text",
    },
  },
  ["path", "old_str", "new_str"],
  async ({ path, old_str, new_str }) => {
    try {
      const resolvedPath = resolveSafePath(path);

      // Always validate path first (checks both allowed paths AND sensitive files like .env)
      const pathError = validatePath(resolvedPath, "edit");
      if (pathError) {
        return { success: false, output: "", error: pathError };
      }

      // Use sandbox for filesystem isolation
      if (isSandboxReady()) {
        // Read file content
        const readResult = await runInSandbox("cat", [resolvedPath]);
        if (!readResult.success) {
          if (readResult.stderr.includes("No such file")) {
            return {
              success: false,
              output: "",
              error: `File not found: ${path}`,
            };
          }
          return {
            success: false,
            output: "",
            error: readResult.stderr || "Failed to read file",
          };
        }

        let content = readResult.stdout;
        const count = content.split(old_str).length - 1;

        if (count === 0) {
          return {
            success: false,
            output: "",
            error: "old_str not found in file",
          };
        }

        if (count > 1) {
          return {
            success: false,
            output: "",
            error: `old_str found ${count} times, must be unique`,
          };
        }

        content = content.replace(old_str, new_str);

        // Write file using heredoc with random delimiter to prevent injection
        const { randomUUID } = await import("node:crypto");
        const heredocDelim = `CLAWD_EOF_${randomUUID().replace(/-/g, "")}`;
        const writeResult = await runInSandbox("bash", [
          "-c",
          `cat > "${resolvedPath}" << '${heredocDelim}'\n${content}\n${heredocDelim}`,
        ]);
        if (!writeResult.success) {
          return {
            success: false,
            output: "",
            error: writeResult.stderr || "Failed to write file",
          };
        }

        return { success: true, output: `File updated: ${path}` };
      }

      // Fallback: direct fs access (path already validated above)
      if (!existsSync(resolvedPath)) {
        return { success: false, output: "", error: `File not found: ${path}` };
      }

      let content = readFileSync(resolvedPath, "utf-8");

      const count = content.split(old_str).length - 1;

      if (count === 0) {
        return {
          success: false,
          output: "",
          error: "old_str not found in file",
        };
      }

      if (count > 1) {
        return {
          success: false,
          output: "",
          error: `old_str found ${count} times, must be unique`,
        };
      }

      content = content.replace(old_str, new_str);
      writeFileSync(resolvedPath, content);

      return { success: true, output: `File updated: ${path}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Create
// ============================================================================

registerTool(
  "create",
  "Create a new file with content. Parent directories must exist.",
  {
    path: {
      type: "string",
      description: "Absolute path for new file",
    },
    content: {
      type: "string",
      description: "File content",
    },
  },
  ["path", "content"],
  async ({ path, content }) => {
    try {
      const resolvedPath = resolveSafePath(path);

      // Always validate path first (checks both allowed paths AND sensitive files like .env)
      const pathError = validatePath(resolvedPath, "create");
      if (pathError) {
        return { success: false, output: "", error: pathError };
      }

      // Use sandbox for filesystem isolation
      if (isSandboxReady()) {
        // Check if file exists
        const existsResult = await runInSandbox("test", ["-e", resolvedPath]);
        if (existsResult.success) {
          return {
            success: false,
            output: "",
            error: `File already exists: ${path}`,
          };
        }

        // Create file using heredoc with random delimiter to prevent injection
        const { randomUUID: randomUUIDCreate } = await import("node:crypto");
        const heredocDelimCreate = `CLAWD_EOF_${randomUUIDCreate().replace(/-/g, "")}`;
        const writeResult = await runInSandbox("bash", [
          "-c",
          `cat > "${resolvedPath}" << '${heredocDelimCreate}'\n${content}\n${heredocDelimCreate}`,
        ]);
        if (!writeResult.success) {
          return {
            success: false,
            output: "",
            error: writeResult.stderr || "Failed to create file",
          };
        }

        return { success: true, output: `Created: ${path}` };
      }

      // Fallback: direct fs access (path already validated above)
      if (existsSync(resolvedPath)) {
        return {
          success: false,
          output: "",
          error: `File already exists: ${path}`,
        };
      }

      writeFileSync(resolvedPath, content);
      return { success: true, output: `Created: ${path}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Grep
// ============================================================================

registerTool(
  "grep",
  "Search for patterns in files using ripgrep.",
  {
    pattern: {
      type: "string",
      description: "Search pattern (regex)",
    },
    path: {
      type: "string",
      description: "Directory or file to search",
    },
    glob: {
      type: "string",
      description: 'File glob pattern (e.g., "*.ts")',
    },
    context: {
      type: "number",
      description: "Lines of context around matches",
    },
  },
  ["pattern"],
  async ({ pattern, path = ".", glob, context }) => {
    const resolvedPath = resolveSafePath(path);

    const args = ["--color=never", "--line-number"];
    if (glob) args.push("-g", glob);
    if (context) args.push("-C", String(context));
    args.push(pattern, resolvedPath);

    // Use sandbox for filesystem isolation
    if (isSandboxReady()) {
      const result = await runInSandbox("rg", args, { timeout: 30000 });

      // Check if rg is not installed (sandbox returns code 1 + "execvp" in stderr)
      if (result.stderr.includes("execvp") || result.stderr.includes("No such file")) {
        // Fallback to grep inside sandbox
        const grepArgs = ["-rn", "--color=never"];
        if (glob) {
          // Convert rg glob to grep --include (e.g., "*.ts" -> "--include=*.ts")
          grepArgs.push(`--include=${glob}`);
        }
        if (context) grepArgs.push("-C", String(context));
        grepArgs.push(pattern, resolvedPath);
        const grepResult = await runInSandbox("grep", grepArgs, { timeout: 30000 });
        return {
          success: grepResult.code === 0 || grepResult.code === 1,
          output: grepResult.stdout.trim() || "(no matches)",
        };
      }

      // rg returns 1 for no matches, which is not an error
      return {
        success: result.code === 0 || result.code === 1,
        output: result.stdout.trim() || "(no matches)",
      };
    }

    // Fallback: path validation + direct execution
    const pathError = validatePath(resolvedPath, "grep");
    if (pathError) {
      return { success: false, output: "", error: pathError };
    }

    return new Promise((resolve) => {
      const proc = spawn("rg", args);
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, 30000);

      let output = "";
      proc.stdout?.on("data", (data) => {
        output += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeoutId);
        if (timedOut) {
          resolve({
            success: false,
            output: output.trim(),
            error: "TIMEOUT: Search exceeded 30s. Try a more specific pattern or smaller directory.",
          });
          return;
        }
        resolve({
          success: code === 0 || code === 1, // 1 = no matches
          output: output.trim() || "(no matches)",
        });
      });

      proc.on("error", () => {
        clearTimeout(timeoutId);
        // Fallback to grep if rg not available
        const grepFallbackArgs = ["-rn", pattern, resolvedPath];
        if (glob) grepFallbackArgs.splice(1, 0, `--include=${glob}`);
        const grepProc = spawn("grep", grepFallbackArgs);
        let grepTimedOut = false;

        const grepTimeoutId = setTimeout(() => {
          grepTimedOut = true;
          grepProc.kill("SIGKILL");
        }, 30000);

        let grepOutput = "";
        grepProc.stdout?.on("data", (data) => {
          grepOutput += data.toString();
        });
        grepProc.on("close", (code) => {
          clearTimeout(grepTimeoutId);
          if (grepTimedOut) {
            resolve({
              success: false,
              output: grepOutput.trim(),
              error: "TIMEOUT: Search exceeded 30s.",
            });
            return;
          }
          resolve({
            success: code === 0 || code === 1,
            output: grepOutput.trim() || "(no matches)",
          });
        });
      });
    });
  },
);

// ============================================================================
// Tool: Glob
// ============================================================================

registerTool(
  "glob",
  "Find files matching a glob pattern.",
  {
    pattern: {
      type: "string",
      description: 'Glob pattern (e.g., "**/*.ts")',
    },
    path: {
      type: "string",
      description: "Base directory (default: current directory)",
    },
  },
  ["pattern"],
  async ({ pattern, path = "." }) => {
    const resolvedPath = resolveSafePath(path);

    // Use sandbox for filesystem isolation
    if (isSandboxReady()) {
      const result = await runInSandbox("find", [resolvedPath, "-name", pattern.replace("**/", "")], {
        timeout: 30000,
      });
      return {
        success: true,
        output: result.stdout.trim() || "(no files found)",
      };
    }

    // Fallback: path validation + direct execution
    const pathError = validatePath(resolvedPath, "glob");
    if (pathError) {
      return { success: false, output: "", error: pathError };
    }

    return new Promise((resolve) => {
      const proc = spawn("find", [resolvedPath, "-name", pattern.replace("**/", "")]);
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, 30000);

      let output = "";
      proc.stdout?.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", () => {
        clearTimeout(timeoutId);
        if (timedOut) {
          resolve({
            success: false,
            output: output.trim(),
            error: "TIMEOUT: Search exceeded 30s. Try a smaller directory.",
          });
          return;
        }
        resolve({
          success: true,
          output: output.trim() || "(no files found)",
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        resolve({ success: false, output: "", error: err.message });
      });
    });
  },
);

// ============================================================================
// Tool: Memory Search
// ============================================================================

registerTool(
  "memory_search",
  "Search past conversation history. Filter by time range, keywords, or role.",
  {
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "Keywords to search for (uses full-text search)",
    },
    start_time: {
      type: "number",
      description: "Search from this Unix timestamp (ms)",
    },
    end_time: {
      type: "number",
      description: "Search until this Unix timestamp (ms)",
    },
    role: {
      type: "string",
      enum: ["user", "assistant", "tool"],
      description: "Filter by message role",
    },
    session_id: {
      type: "string",
      description: "Limit to specific session",
    },
    limit: {
      type: "number",
      description: "Maximum results (default: 20)",
    },
  },
  [],
  async (args) => {
    try {
      // Use singleton to avoid database lock contention
      const { getMemoryManager } = await import("../memory/memory");
      const memory = getMemoryManager();

      const results = memory.search({
        keywords: args.keywords,
        startTime: args.start_time,
        endTime: args.end_time,
        role: args.role,
        sessionId: args.session_id,
        limit: args.limit || 20,
      });

      // Don't close singleton

      if (results.length === 0) {
        return { success: true, output: "No matching messages found." };
      }

      const formatted = results
        .map(
          (r) =>
            `[${new Date(r.createdAt).toISOString()}] (${r.sessionName}) ${r.role}: ${r.content?.slice(0, 200)}${r.content?.length > 200 ? "..." : ""}`,
        )
        .join("\n\n");

      return {
        success: true,
        output: `Found ${results.length} messages:\n\n${formatted}`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Memory Summary
// ============================================================================

registerTool(
  "memory_summary",
  "Get a summary of a conversation session including key topics.",
  {
    session_id: {
      type: "string",
      description: "Session ID to summarize",
    },
  },
  ["session_id"],
  async ({ session_id }) => {
    try {
      const { getMemoryManager } = await import("../memory/memory");
      const memory = getMemoryManager();

      const summary = memory.getSessionSummary(session_id);
      // Don't close singleton

      if (!summary) {
        return { success: false, output: "", error: "Session not found" };
      }

      const output = `Session: ${summary.sessionName}
Messages: ${summary.messageCount}
Time Range: ${new Date(summary.timeRange.start).toISOString()} - ${new Date(summary.timeRange.end).toISOString()}
Key Topics: ${summary.keyTopics.join(", ") || "None detected"}

Summary: ${summary.summary}`;

      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Job Submit (tmux-based, survives agent exit)
// ============================================================================

registerTool(
  "job_submit",
  "Submit a one-off background command (runs in an isolated tmux session). Returns a job ID. For recurring/scheduled tasks, use schedule_job instead.",
  {
    name: {
      type: "string",
      description: "Short name for the job",
    },
    command: {
      type: "string",
      description: "Bash command to execute",
    },
  },
  ["name", "command"],
  async ({ name, command }) => {
    try {
      const { tmuxJobManager } = await import("../jobs/tmux-manager");

      // When sandbox enabled, wrap the command with platform-specific sandboxing
      // (tmux-manager runs commands directly; sandboxing is enforced here at tool level)
      let sandboxedCommand = command;
      if (isSandboxReady()) {
        sandboxedCommand = await wrapCommandForSandbox(command);
      }

      const jobId = tmuxJobManager.submit(name, sandboxedCommand);

      return {
        success: true,
        output: `Job submitted: ${jobId}\nName: ${name}\nUse job_status or job_logs with this ID to check progress.`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Job Status (tmux-based)
// ============================================================================

registerTool(
  "job_status",
  "Get status of one-off background jobs (from job_submit). For recurring scheduled tasks, use schedule_list instead.",
  {
    job_id: {
      type: "string",
      description: "Specific job ID (optional, lists all if not provided)",
    },
    status_filter: {
      type: "string",
      enum: ["pending", "running", "completed", "failed", "cancelled"],
      description: "Filter by status",
    },
  },
  [],
  async ({ job_id, status_filter }) => {
    try {
      const { tmuxJobManager } = await import("../jobs/tmux-manager");

      if (job_id) {
        const job = tmuxJobManager.get(job_id);
        if (!job) {
          return {
            success: false,
            output: "",
            error: `Job ${job_id} not found`,
          };
        }

        // Include logs in detailed view
        const logs = tmuxJobManager.getLogs(job_id, 50);
        const output = [
          JSON.stringify(job, null, 2),
          "",
          "--- Last 50 lines of output ---",
          logs || "(no output yet)",
        ].join("\n");

        return { success: true, output };
      }

      const jobs = tmuxJobManager.list({
        status: status_filter as any,
        limit: 20,
      });

      if (jobs.length === 0) {
        return { success: true, output: "No jobs found." };
      }

      const formatted = jobs
        .map((j) => {
          const elapsed = j.completedAt
            ? `${Math.round((j.completedAt - j.createdAt) / 1000)}s`
            : j.startedAt
              ? `${Math.round((Date.now() - j.startedAt) / 1000)}s (running)`
              : "pending";
          return `[${j.status.toUpperCase()}] ${j.id.slice(0, 8)} - ${j.name} (${elapsed})`;
        })
        .join("\n");

      return { success: true, output: formatted };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Job Cancel (tmux-based)
// ============================================================================

registerTool(
  "job_cancel",
  "Cancel a one-off background job by its job ID (from job_submit). For recurring schedules, use schedule_cancel instead.",
  {
    job_id: {
      type: "string",
      description: "Job ID to cancel",
    },
  },
  ["job_id"],
  async ({ job_id }) => {
    try {
      const { tmuxJobManager } = await import("../jobs/tmux-manager");

      const cancelled = tmuxJobManager.cancel(job_id);

      if (cancelled) {
        return { success: true, output: `Job ${job_id} cancelled.` };
      } else {
        return {
          success: false,
          output: "",
          error: `Could not cancel job ${job_id} (not running or not found)`,
        };
      }
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Job Wait (tmux-based)
// ============================================================================

registerTool(
  "job_wait",
  "Wait for a job to complete and return its result with full logs.",
  {
    job_id: {
      type: "string",
      description: "Job ID to wait for",
    },
    timeout_ms: {
      type: "number",
      description: "Maximum time to wait in milliseconds (default: 60000)",
    },
  },
  ["job_id"],
  async ({ job_id, timeout_ms = 60000 }) => {
    try {
      const { tmuxJobManager } = await import("../jobs/tmux-manager");

      const job = await tmuxJobManager.waitFor(job_id, timeout_ms);
      const logs = tmuxJobManager.getLogs(job_id);

      if (job.status === "completed") {
        return {
          success: true,
          output: `Job completed (exit code: ${job.exitCode}):\n${logs || "(no output)"}`,
        };
      } else if (job.status === "failed") {
        return {
          success: false,
          output: logs,
          error: `Job failed with exit code: ${job.exitCode}`,
        };
      } else if (job.status === "cancelled") {
        return { success: false, output: logs, error: "Job was cancelled" };
      } else {
        return {
          success: false,
          output: "",
          error: `Job status: ${job.status}`,
        };
      }
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Job Logs (tmux-based)
// ============================================================================

registerTool(
  "job_logs",
  "Get the full output logs of a job.",
  {
    job_id: {
      type: "string",
      description: "Job ID to get logs for",
    },
    tail: {
      type: "number",
      description: "Only get last N lines (optional, returns all if not specified)",
    },
  },
  ["job_id"],
  async ({ job_id, tail }) => {
    try {
      const { tmuxJobManager } = await import("../jobs/tmux-manager");

      const job = tmuxJobManager.get(job_id);
      if (!job) {
        return { success: false, output: "", error: `Job ${job_id} not found` };
      }

      const logs = tmuxJobManager.getLogs(job_id, tail);

      return {
        success: true,
        output: `Job: ${job.name} [${job.status.toUpperCase()}]\nCommand: ${job.command}\n\n--- Output ---\n${logs || "(no output yet)"}`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Skill List
// ============================================================================

registerTool(
  "skill_list",
  "List all available skills (project-scoped + global). Use this to discover what skills are available.",
  {},
  [],
  async () => {
    try {
      const { getSkillManager } = await import("../skills/manager");
      const manager = getSkillManager();
      manager.indexSkillsIfStale();

      const skills = manager.listSkills();

      if (skills.length === 0) {
        return {
          success: true,
          output: "No skills installed. Use skill_create to add skills to the project.",
        };
      }

      const formatted = skills
        .map((s) => `• **${s.name}** (${s.source}): ${s.description}\n  Triggers: ${s.triggers.join(", ")}`)
        .join("\n\n");

      return { success: true, output: `Available skills:\n\n${formatted}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Skill Search
// ============================================================================

registerTool(
  "skill_search",
  "Search for relevant skills by keywords. Returns matching skills ranked by relevance.",
  {
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "Keywords to search for",
    },
  },
  ["keywords"],
  async ({ keywords }) => {
    try {
      const { getSkillManager } = await import("../skills/manager");
      const manager = getSkillManager();
      manager.indexSkillsIfStale();

      const matches = manager.searchByKeywords(keywords);

      if (matches.length === 0) {
        return { success: true, output: "No matching skills found." };
      }

      const formatted = matches
        .map(
          (m) =>
            `• **${m.skill.name}** (${m.skill.source}, ${Math.round(m.score * 100)}% match)\n  ${m.skill.description}\n  Matched: ${m.matchedTriggers.join(", ")}`,
        )
        .join("\n\n");

      return { success: true, output: `Matching skills:\n\n${formatted}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Skill Activate
// ============================================================================

registerTool(
  "skill_activate",
  "Load and activate a skill by name. Returns the full skill content to guide your actions.",
  {
    name: {
      type: "string",
      description: "Name of the skill to activate",
    },
  },
  ["name"],
  async ({ name }) => {
    try {
      const { getSkillManager } = await import("../skills/manager");
      const manager = getSkillManager();
      manager.indexSkillsIfStale();

      const skill = manager.getSkill(name);

      if (!skill) {
        return {
          success: false,
          output: "",
          error: `Skill '${name}' not found. Use skill_list to see available skills.`,
        };
      }

      return {
        success: true,
        output: `# Skill: ${skill.name} (${skill.source})\n\n${skill.content}\n\n---\n*Skill activated. Follow the guidelines above.*`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Skill Create
// ============================================================================

registerTool(
  "skill_create",
  "Create or update a skill. Saved as {projectRoot}/.clawd/skills/{name}/SKILL.md (Claude Code-compatible folder format). " +
    "Use scope='global' to save to ~/.clawd/skills/ instead.",
  {
    name: {
      type: "string",
      description: "Skill name (lowercase a-z, 0-9, hyphens, underscores, max 64 chars)",
    },
    description: {
      type: "string",
      description: "Brief description of what the skill does (<200 chars)",
    },
    triggers: {
      type: "array",
      items: { type: "string" },
      description: "Keywords that should trigger this skill",
    },
    content: {
      type: "string",
      description: "Full skill content in markdown format (instructions for the agent)",
    },
    scope: {
      type: "string",
      enum: ["project", "global"],
      description: 'Where to save: "project" (default, in .clawd/skills/) or "global" (~/.clawd/skills/)',
    },
  },
  ["name", "description", "triggers", "content"],
  async ({ name, description, triggers, content, scope }) => {
    try {
      const { getSkillManager } = await import("../skills/manager");
      const manager = getSkillManager();

      const result = manager.saveSkill({ name, description, triggers, content }, scope || "project");

      if (!result.success) {
        return { success: false, output: "", error: result.error };
      }

      return { success: true, output: `Skill '${name}' saved to ${scope || "project"} scope.` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Skill Delete
// ============================================================================

registerTool(
  "skill_delete",
  "Delete a skill by name. Removes the skill folder and its index entry.",
  {
    name: {
      type: "string",
      description: "Name of the skill to delete",
    },
  },
  ["name"],
  async ({ name }) => {
    try {
      const { getSkillManager } = await import("../skills/manager");
      const manager = getSkillManager();

      const deleted = manager.deleteSkill(name);

      if (!deleted) {
        return { success: false, output: "", error: `Skill '${name}' not found.` };
      }

      return { success: true, output: `Skill '${name}' deleted.` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Task Add
// ============================================================================

// Current agent ID for kanban (set by agent runtime)
let currentAgentId = "default";
let currentChannel = "general";
let chatApiUrl = "http://localhost:53456";

export function setCurrentAgentId(id: string) {
  currentAgentId = id;
}

export function setCurrentChannel(channel: string) {
  currentChannel = channel;
}

export function setChatApiUrl(url: string) {
  chatApiUrl = url;
}

// Helper: fetch with timeout to prevent hangs on self-calls to localhost
function toolFetch(url: string, options: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ============================================================================
// Task Tools - Call server API
// ============================================================================

registerTool(
  "task_add",
  "Add a new task to the channel kanban board.",
  {
    title: { type: "string", description: "Task title (brief, actionable)" },
    description: {
      type: "string",
      description: "Detailed description (optional)",
    },
    priority: {
      type: "string",
      description: "P0 (critical), P1 (high), P2 (medium), P3 (low). Default: P2",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Tags for categorization",
    },
    due_at: {
      type: "number",
      description: "Due date as Unix timestamp (optional)",
    },
  },
  ["title"],
  async ({ title, description, priority, tags, due_at }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/tasks.create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          priority,
          tags,
          due_at,
          agent_id: currentAgentId,
        }),
      });
      const data = (await res.json()) as any;
      if (!data.ok) return { success: false, output: "", error: data.error };

      const task = data.task;
      return {
        success: true,
        output: `✅ Created: [${task.priority}] ${task.title} (${task.id})`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

registerTool(
  "task_list",
  "View the kanban board. Shows all tasks organized by status.",
  {
    status: {
      type: "string",
      description: "Filter by status: todo, doing, done, blocked",
    },
    limit: { type: "number", description: "Max tasks to return" },
  },
  [],
  async ({ status, limit }) => {
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (limit) params.set("limit", String(limit));

      const res = await toolFetch(`${chatApiUrl}/api/tasks.list?${params}`);
      const data = (await res.json()) as any;
      if (!data.ok) return { success: false, output: "", error: data.error };

      const tasks = data.tasks;
      if (!tasks.length)
        return {
          success: true,
          output: "Kanban board is empty. Add tasks with task_add.",
        };

      const byStatus: Record<string, any[]> = {
        todo: [],
        doing: [],
        blocked: [],
        done: [],
      };
      for (const t of tasks) {
        (byStatus[t.status] || []).push(t);
      }

      let output = `📋 KANBAN BOARD\n${"═".repeat(50)}\n`;
      for (const [s, list] of Object.entries(byStatus)) {
        if (list.length === 0) continue;
        output += `\n## ${s.toUpperCase()} (${list.length})\n`;
        for (const t of list) {
          output += `- [${t.priority}] ${t.title} (${t.id.slice(-8)})\n`;
        }
      }
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

registerTool(
  "task_get",
  "Get detailed view of a task including attachments and comments.",
  { task_id: { type: "string", description: "Task ID (or partial ID)" } },
  ["task_id"],
  async ({ task_id }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/tasks.get?task_id=${encodeURIComponent(task_id)}`);
      const data = (await res.json()) as any;
      if (!data.ok) return { success: false, output: "", error: data.error };

      const t = data.task;
      let output = `📋 ${t.title}\n${"═".repeat(50)}\n`;
      output += `ID: ${t.id} | Status: ${t.status} | Priority: ${t.priority}\n`;
      if (t.tags?.length) output += `Tags: #${t.tags.join(" #")}\n`;
      if (t.description) output += `\nDescription:\n${t.description}\n`;
      if (t.attachments?.length) {
        output += `\nAttachments (${t.attachments.length}):\n`;
        for (const a of t.attachments) output += `  📎 ${a.name}${a.url ? ` - ${a.url}` : ""}\n`;
      }
      if (t.comments?.length) {
        output += `\nComments (${t.comments.length}):\n`;
        for (const c of t.comments) output += `  💬 [${c.author}] ${c.text}\n`;
      }
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

registerTool(
  "task_update",
  "Update a task (status, priority, title). Use claimer when setting status to 'doing' for atomic claim protection.",
  {
    task_id: { type: "string", description: "Task ID" },
    status: {
      type: "string",
      description: "New status: todo, doing, done, blocked",
    },
    priority: { type: "string", description: "New priority: P0, P1, P2, P3" },
    title: { type: "string", description: "New title" },
    claimer: {
      type: "string",
      description: "Agent ID claiming the task (required when setting status to 'doing' for atomic claim protection)",
    },
  },
  ["task_id"],
  async ({ task_id, status, priority, title, claimer }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/tasks.update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id, status, priority, title, claimer }),
      });
      const data = (await res.json()) as any;
      if (!data.ok) {
        if (data.error === "already_claimed") {
          return {
            success: false,
            output: "",
            error: `Task already claimed by ${data.claimed_by}. Pick another task.`,
          };
        }
        return { success: false, output: "", error: data.error };
      }

      const t = data.task;
      let output = `Updated: [${t.status}] [${t.priority}] ${t.title}`;
      if (t.claimed_by) output += ` (claimed by: ${t.claimed_by})`;
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

registerTool(
  "task_complete",
  "Mark a task as done.",
  { task_id: { type: "string", description: "Task ID" } },
  ["task_id"],
  async ({ task_id }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/tasks.update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id, status: "done" }),
      });
      const data = (await res.json()) as any;
      if (!data.ok) return { success: false, output: "", error: data.error };

      return { success: true, output: `✅ Completed: ${data.task.title}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

registerTool(
  "task_delete",
  "Delete a task from the board.",
  { task_id: { type: "string", description: "Task ID" } },
  ["task_id"],
  async ({ task_id }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/tasks.delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id }),
      });
      const data = (await res.json()) as any;
      if (!data.ok) return { success: false, output: "", error: data.error };

      return { success: true, output: `🗑️ Task deleted` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

registerTool(
  "task_attach",
  "Add an attachment to a task.",
  {
    task_id: { type: "string", description: "Task ID" },
    name: { type: "string", description: "Attachment name" },
    url: { type: "string", description: "URL or file path (optional)" },
    file_id: { type: "string", description: "Chat file ID (optional)" },
  },
  ["task_id", "name"],
  async ({ task_id, name, url, file_id }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/tasks.addAttachment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id,
          name,
          url,
          file_id,
          added_by: currentAgentId,
        }),
      });
      const data = (await res.json()) as any;
      if (!data.ok) return { success: false, output: "", error: data.error };

      return { success: true, output: `📎 Attachment added: ${name}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

registerTool(
  "task_comment",
  "Add a comment to a task.",
  {
    task_id: { type: "string", description: "Task ID" },
    text: { type: "string", description: "Comment text" },
  },
  ["task_id", "text"],
  async ({ task_id, text }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/tasks.addComment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id, text, author: currentAgentId }),
      });
      const data = (await res.json()) as any;
      if (!data.ok) return { success: false, output: "", error: data.error };

      return { success: true, output: `💬 Comment added` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Web Fetch
// ============================================================================
// ============================================================================
// Tool: Web Fetch
// ============================================================================

registerTool(
  "web_fetch",
  "Fetch a URL from the internet and return the content. Supports HTML pages (converted to markdown), JSON APIs, and text content.",
  {
    url: {
      type: "string",
      description: "The URL to fetch",
    },
    raw: {
      type: "boolean",
      description: "If true, returns raw HTML instead of converting to markdown (default: false)",
    },
    max_length: {
      type: "number",
      description: "Maximum number of characters to return (default: 10000)",
    },
  },
  ["url"],
  async (args) => {
    const { url, raw = false, max_length = 10000 } = args;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ClawdAgent/1.0)",
          Accept: "text/html,application/json,text/plain,*/*",
        },
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        return {
          success: false,
          output: "",
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      let content = await response.text();

      // For HTML, do basic conversion to markdown unless raw=true
      if (!raw && contentType.includes("text/html")) {
        // Basic HTML to text conversion — strip unsafe tags via index-based search (CodeQL-safe)
        content = stripHtmlTagBlocks(content, "script");
        content = stripHtmlTagBlocks(content, "style");
        content = content // lgtm[js/incomplete-multi-character-sanitization]
          // Convert paragraphs and breaks
          .replace(/<p[^>]*>/gi, "\n")
          .replace(/<\/p>/gi, "\n")
          .replace(/<br\s*\/?>/gi, "\n")
          // Convert lists
          .replace(/<li[^>]*>/gi, "- ")
          .replace(/<\/li>/gi, "\n")
          // Remove all remaining tags (strip only tag markup, not content)
          .replace(/<[^>]+>/g, "")
          // Decode HTML entities (single-pass ordering: &amp; last to avoid double-decode)
          .replace(/&nbsp;/g, " ")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&")
          // Clean up whitespace
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }

      // Truncate if needed
      if (content.length > max_length) {
        content = `${content.substring(0, max_length)}\n\n[Content truncated - file too large. Use view() with start_line/end_line parameters to read specific sections, or use grep to find relevant parts first.]`;
      }

      return { success: true, output: content };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Web Search (DuckDuckGo)
// ============================================================================

registerTool(
  "web_search",
  "Search the web. Returns search results with titles, URLs, and snippets. Automatically uses the best search backend for the current provider.",
  {
    query: {
      type: "string",
      description: "The search query",
    },
    max_results: {
      type: "number",
      description: "Maximum number of results to return (default: 5)",
    },
  },
  ["query"],
  async (args) => {
    const { query, max_results = 5 } = args;
    try {
      const { webSearch } = await import("./web-search");
      const result = await webSearch(query, max_results);

      if (result.error && result.results.length === 0) {
        return { success: false, output: "", error: result.error };
      }

      if (result.results.length === 0) {
        return { success: true, output: `No results found for: ${query}` };
      }

      const output = result.results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");

      return { success: true, output: `Search results for "${query}":\n\n${output}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Sub-Agent System
// ============================================================================

// Store for managing sub-agents at the main agent level
const subAgents = new Map<
  string,
  {
    id: string;
    name: string;
    task: string;
    status: "running" | "completed" | "failed" | "aborted";
    result?: any;
    error?: string;
    startedAt: number;
    completedAt?: number;
    tmuxSession?: string; // Tmux session name for detached agents
    resultFile?: string; // Path to result JSON file for tmux agents
  }
>();

// Spawn a sub-agent in a detached tmux session (survives main agent exit)
async function spawnTmuxSubAgent(task: string, name: string): Promise<ToolResult> {
  const { execSync, spawn } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  // Check if tmux is available
  try {
    execSync("which tmux", { stdio: "ignore" });
  } catch {
    return {
      success: false,
      output: "",
      error: "tmux is not installed. Install it with: apt install tmux (or brew install tmux on macOS)",
    };
  }

  const { randomUUID } = await import("node:crypto");
  const randomSuffix = randomUUID().replace(/-/g, "").substring(0, 12);

  const sessionName = `clawd-${name}-${randomSuffix}`;
  const agentId = `tmux-${sessionName}`;

  // Use project-scoped agents directory
  const agentsDir = getProjectAgentsDir();
  const agentDir = join(agentsDir, sessionName);
  try {
    mkdirSync(agentDir, { recursive: true });
  } catch {}
  const logFile = join(agentDir, "output.log");
  const resultFile = join(agentDir, "result.json");
  const scriptFile = join(agentDir, "run.sh");
  const metaFile = join(agentDir, "meta.json");

  // Write agent metadata
  const { writeFileSync, chmodSync } = await import("node:fs");
  writeFileSync(
    metaFile,
    JSON.stringify({
      id: agentId,
      name,
      task: task.slice(0, 500),
      status: "running",
      createdAt: Date.now(),
      projectHash: getProjectHash(),
    }),
  );

  // Append instruction to use report_agent_result tool
  const taskWithInstruction = `${task}\n\nIMPORTANT: When you complete this task, use the report_agent_result tool to write your final result/report. The parent agent will read this.`;
  // Use single-quote shell escaping: wrap in single quotes and escape embedded single quotes as '\''
  // This is safe against all shell metacharacters ($, `, \, !, etc.)
  const shellSafeTask = taskWithInstruction.replace(/'/g, "'\\''");

  // Build clawd command - pass project-hash so sub-agent uses same project dir
  const currentProjectHash = getProjectHash();
  const baseClawdCmd = `clawd -p '${shellSafeTask}' --result-file "${resultFile}" --project-hash "${currentProjectHash}"`;

  // Get sandbox root (detect git root or use cwd)
  const sandboxRoot = getSandboxProjectRoot();

  // Run clawd directly in tmux (no sandbox wrapping)
  const clawdCmd = `${baseClawdCmd} 2>&1 | tee -a "${logFile}"`;

  // Dedicated tmux socket for sub-agents (project-scoped)
  const socketPath = join(agentsDir, "tmux.sock");

  // Create tmux session - write script to temp file to avoid quoting hell
  const scriptContent = `#!/bin/bash
# Sub-agent runs in sandbox root directory
cd "${sandboxRoot}"
echo "Starting sub-agent: ${name}" >> "${logFile}"
echo "Sandbox root: ${sandboxRoot}" >> "${logFile}"
echo "Project hash: ${currentProjectHash}" >> "${logFile}"
echo "---" >> "${logFile}"
${clawdCmd}
echo "---" >> "${logFile}"
echo "Exit code: $?" >> "${logFile}"
`;
  writeFileSync(scriptFile, scriptContent);
  chmodSync(scriptFile, 0o755);

  const tmuxCmd = `tmux -S "${socketPath}" new-session -d -s "${sessionName}" "${scriptFile}"`;

  try {
    execSync(tmuxCmd, { stdio: "ignore" });

    // Store agent info
    subAgents.set(agentId, {
      id: agentId,
      name,
      task,
      status: "running",
      startedAt: Date.now(),
      tmuxSession: sessionName,
      resultFile,
    });

    return {
      success: true,
      output: JSON.stringify(
        {
          agent_id: agentId,
          name,
          status: "running",
          project_hash: currentProjectHash,
          message: `Sub-agent spawned. Use list_agents to check status, agent_logs to view output, or kill_agent to stop it.`,
        },
        null,
        2,
      ),
    };
  } catch (err: any) {
    return {
      success: false,
      output: "",
      error: `Failed to spawn tmux session: ${err.message}`,
    };
  }
}

registerTool(
  "spawn_agent",
  `Spawn a sub-agent to work on a task. The sub-agent is a fully autonomous agent with the same capabilities (file ops, bash, web tools, etc.).

Use this for:
- Parallelizing independent tasks
- Delegating complex subtasks
- Running long operations

The sub-agent runs asynchronously and will respond directly to the chat channel when done — no need to wait or poll for results.

Sub-agents can spawn their own sub-agents (up to 3 levels deep). The sub-agent will run until it completes the task or hits max iterations.`,
  {
    task: {
      type: "string",
      description: "The task for the sub-agent to complete. Be specific and include all necessary context.",
    },
    name: {
      type: "string",
      description: "Optional friendly name for the sub-agent (for tracking)",
    },
  },
  ["task"],
  async ({ task, name }) => {
    try {
      const agentName = name || `subagent-${Date.now()}`;
      return await spawnTmuxSubAgent(task, agentName);
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// Helper: Get subagent tmux socket path (project-scoped)
function getSubAgentSocketPath(): string {
  const { join } = require("node:path");
  return join(getProjectAgentsDir(), "tmux.sock");
}

registerTool(
  "list_agents",
  "List all spawned sub-agents and their current status. Useful to check which agents are running before using kill_agent.",
  {},
  [],
  async () => {
    const agents = Array.from(subAgents.values()).map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      task: a.task.slice(0, 100) + (a.task.length > 100 ? "..." : ""),
      started_at: new Date(a.startedAt).toISOString(),
      completed_at: a.completedAt ? new Date(a.completedAt).toISOString() : null,
      duration_ms: a.completedAt ? a.completedAt - a.startedAt : Date.now() - a.startedAt,
    }));

    return {
      success: true,
      output: JSON.stringify({ count: agents.length, agents }, null, 2),
    };
  },
);

registerTool(
  "kill_agent",
  "Kill/terminate a running sub-agent and all its children (sub-sub-agents). The agent will stop at the next iteration.",
  {
    agent_id: {
      type: "string",
      description: "The ID of the sub-agent to kill",
    },
  },
  ["agent_id"],
  async ({ agent_id }) => {
    const agentInfo = subAgents.get(agent_id);
    if (!agentInfo) {
      return {
        success: false,
        output: "",
        error: `Agent ${agent_id} not found`,
      };
    }

    if (agentInfo.status !== "running") {
      return {
        success: false,
        output: "",
        error: `Agent ${agent_id} is not running (status: ${agentInfo.status})`,
      };
    }

    if (agentInfo.tmuxSession) {
      // Kill tmux session for detached agents
      const { execSync } = require("node:child_process");
      const socketPath = getSubAgentSocketPath();
      try {
        execSync(`tmux -S "${socketPath}" kill-session -t "${agentInfo.tmuxSession}" 2>/dev/null`, { stdio: "ignore" });
      } catch {
        // Session might already be gone
      }
    }

    agentInfo.status = "aborted";
    agentInfo.completedAt = Date.now();

    return {
      success: true,
      output: JSON.stringify(
        {
          message: `Agent ${agent_id} and its children have been terminated`,
          id: agent_id,
          name: agentInfo.name,
          status: "aborted",
          duration_ms: agentInfo.completedAt - agentInfo.startedAt,
        },
        null,
        2,
      ),
    };
  },
);

// ============================================================================
// Tool: Agent Logs
// ============================================================================

registerTool(
  "agent_logs",
  "Get the output logs of a sub-agent by its ID. Use this to check what a sub-agent is doing or has done.",
  {
    agent_id: {
      type: "string",
      description: "The ID of the sub-agent",
    },
    tail: {
      type: "number",
      description: "Only get last N lines (optional, returns last 100 by default)",
    },
  },
  ["agent_id"],
  async ({ agent_id, tail = 100 }) => {
    const agentInfo = subAgents.get(agent_id);
    if (!agentInfo) {
      return {
        success: false,
        output: "",
        error: `Agent ${agent_id} not found. Use list_agents to see available agents.`,
      };
    }

    const { join } = require("node:path");
    const agentsDir = getProjectAgentsDir();
    const sessionName = agentInfo.tmuxSession || agent_id.replace(/^tmux-/, "");
    const logFile = join(agentsDir, sessionName, "output.log");

    try {
      const { readFileSync } = require("node:fs");
      const content = readFileSync(logFile, "utf-8");
      const lines = content.split("\n");
      const output = tail ? lines.slice(-tail).join("\n") : content;

      return {
        success: true,
        output: `Agent: ${agentInfo.name} [${agentInfo.status.toUpperCase()}]\nTask: ${agentInfo.task.slice(0, 200)}${agentInfo.task.length > 200 ? "..." : ""}\n\n--- Output (last ${Math.min(tail, lines.length)} lines) ---\n${output || "(no output yet)"}`,
      };
    } catch {
      return {
        success: true,
        output: `Agent: ${agentInfo.name} [${agentInfo.status.toUpperCase()}]\n(no output yet — agent may still be starting)`,
      };
    }
  },
);

// ============================================================================
// Git Tools (sandboxed with agent SSH/git config)
// ============================================================================

/**
 * Execute a git command. Cross-platform, non-interactive.
 * Disables GPG signing, SSH host verification prompts, terminal prompts.
 * Uses sandbox on Linux/macOS, direct spawn on Windows.
 */
function execGitCommand(args: string[], cwd?: string): Promise<{ success: boolean; output: string; error?: string }> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const sshKey = `${home}/.clawd/.ssh/id_ed25519`;
  const gitConfigPath = `${home}/.clawd/.gitconfig`;

  // Non-interactive env vars (all platforms)
  const gitEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: gitConfigPath,
  };

  // SSH config (skip on Windows if no ssh key — git may use credential manager)
  if (!IS_WINDOWS || existsSync(sshKey)) {
    gitEnv.GIT_SSH_COMMAND = `ssh -F /dev/null -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o BatchMode=yes -i ${sshKey}`;
  }

  const fullArgs = ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "--no-pager", ...args];

  // On Linux/macOS with sandbox: run via sandbox for isolation
  if (isSandboxReady()) {
    const escaped = fullArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const gitCmd = `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL='${gitConfigPath}' GIT_SSH_COMMAND='${gitEnv.GIT_SSH_COMMAND || ""}' git ${escaped}`;
    return runInSandbox("bash", ["-c", gitCmd], { cwd, timeout: 30000 }).then((result) => {
      if (result.success) {
        return { success: true, output: result.stdout.trim() };
      }
      const error = result.stderr.includes("TIMEOUT")
        ? "TIMEOUT: Git command exceeded 30s."
        : result.stderr.trim() || `Exit code: ${result.code}`;
      return { success: false, output: result.stdout.trim(), error };
    });
  }

  // Direct spawn (Windows, or Linux/macOS without sandbox)
  return new Promise((res) => {
    const proc = spawn("git", fullArgs, { cwd, timeout: 30000, env: gitEnv });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        res({ success: true, output: stdout.trim() });
      } else {
        res({ success: false, output: stdout.trim(), error: stderr.trim() || `Exit code: ${code}` });
      }
    });
    proc.on("error", (err) => {
      res({ success: false, output: "", error: err.message });
    });
  });
}

registerTool(
  "git_status",
  "Show the working tree status (staged, unstaged, untracked files).",
  {
    path: { type: "string", description: "Repository path (default: current directory)" },
  },
  [],
  async ({ path }) => {
    return execGitCommand(["status", "--short"], path);
  },
);

registerTool(
  "git_diff",
  "Show changes between commits, commit and working tree, etc.",
  {
    path: { type: "string", description: "Repository path" },
    staged: { type: "boolean", description: "Show staged changes (--cached)" },
    file: { type: "string", description: "Specific file to diff" },
  },
  [],
  async ({ path, staged, file }) => {
    const args = ["diff"];
    if (staged) args.push("--cached");
    if (file) args.push("--", file);
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_log",
  "Show commit logs.",
  {
    path: { type: "string", description: "Repository path" },
    count: { type: "number", description: "Number of commits to show (default: 10)" },
    oneline: { type: "boolean", description: "Show one line per commit (default: true)" },
    file: { type: "string", description: "Show commits for specific file" },
  },
  [],
  async ({ path, count = 10, oneline = true, file }) => {
    const args = ["log", `-${count}`];
    if (oneline) args.push("--oneline");
    if (file) args.push("--", file);
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_branch",
  "List, create, or delete branches.",
  {
    path: { type: "string", description: "Repository path" },
    name: { type: "string", description: "Branch name to create" },
    delete: { type: "boolean", description: "Delete the branch" },
    all: { type: "boolean", description: "List all branches including remotes" },
  },
  [],
  async ({ path, name, delete: del, all }) => {
    const ctx = getAgentContext();
    if (ctx?.worktreePath && del && name?.startsWith("clawd/")) {
      return {
        success: false,
        output: "",
        error: "Cannot delete clawd/* branches. These are managed by the system.",
      };
    }
    const args = ["branch"];
    if (all) args.push("-a");
    if (name && del) {
      args.push("-d", name);
    } else if (name) {
      args.push(name);
    }
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_checkout",
  "Switch branches or restore working tree files.",
  {
    path: { type: "string", description: "Repository path" },
    target: { type: "string", description: "Branch name, commit, or file to checkout" },
    create: { type: "boolean", description: "Create new branch (-b)" },
  },
  ["target"],
  async ({ path, target, create }) => {
    const ctx = getAgentContext();
    const isWorktree = !!ctx?.worktreePath;

    if (isWorktree) {
      if (create) {
        // Task switch: only allow creating clawd/* branches
        if (!target?.startsWith("clawd/")) {
          return { success: false, output: "", error: "New branches must use the 'clawd/' prefix." };
        }
        // Server generates the random ID — override whatever agent passes
        if (!/^clawd\/[a-f0-9]{1,20}$/.test(target)) {
          const { randomBytes } = await import("node:crypto");
          target = `clawd/${randomBytes(3).toString("hex")}`;
        }
        // Allow: git checkout -b clawd/xxx main
      } else if (target && !target.startsWith("--")) {
        // Block branch switching (not file restore)
        // Use show-ref (precise: only matches branches, not tags/commits)
        try {
          const { execFileSync } = await import("node:child_process");
          const cwd = path || ctx.projectRoot;
          execFileSync("git", ["show-ref", "--verify", `refs/heads/${target}`], { cwd, stdio: "pipe" });
          // It's a branch — block
          return {
            success: false,
            output: "",
            error: "Branch switching is not allowed. Use 'git checkout -- <file>' to restore files.",
          };
        } catch {
          // Not a branch — allow (file restore or commit ref)
        }
      }
    }

    const args = ["checkout"];
    if (create) args.push("-b");
    args.push(target);
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_add",
  "Add file contents to the staging area.",
  {
    path: { type: "string", description: "Repository path" },
    files: { type: "string", description: 'Files to add (space-separated, or "." for all)' },
  },
  ["files"],
  async ({ path, files }) => {
    const args = ["add", ...files.split(/\s+/)];
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_commit",
  "Record changes to the repository.",
  {
    path: { type: "string", description: "Repository path" },
    message: { type: "string", description: "Commit message" },
    all: { type: "boolean", description: "Commit all changed files (-a)" },
  },
  ["message"],
  async ({ path, message, all }) => {
    const ctx = getAgentContext();
    const isWorktree = !!ctx?.worktreePath;

    if (isWorktree && message) {
      // Isolated branch mode: handle author/co-author
      const { getAuthorConfig } = await import("../../config-file");
      const { hasGitUserConfig } = await import("../workspace/worktree");
      const cwd = path || ctx.projectRoot;
      const author = getAuthorConfig();
      const hasLocal = hasGitUserConfig(cwd);

      if (hasLocal && author) {
        // Use git interpret-trailers for safe Co-Authored-By injection
        try {
          const { execFileSync } = await import("node:child_process");
          message = execFileSync(
            "git",
            ["interpret-trailers", "--trailer", `Co-Authored-By: ${author.name} <${author.email}>`],
            {
              cwd,
              input: message,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            },
          ).trim();
        } catch {
          // Fallback: simple append
          message = `${message}\n\nCo-Authored-By: ${author.name} <${author.email}>`;
        }
      } else if (!hasLocal && author) {
        // No git config — use config.author as main author
        const args = ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message];
        if (all) args.push("-a");
        return execGitCommand(args, path);
      }
    }

    const args = ["commit", "-m", message];
    if (all) args.push("-a");
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_push",
  "Update remote refs along with associated objects.",
  {
    path: { type: "string", description: "Repository path" },
    remote: { type: "string", description: "Remote name (default: origin)" },
    branch: { type: "string", description: "Branch to push" },
    force: { type: "boolean", description: "Force push (-f)" },
    setUpstream: { type: "boolean", description: "Set upstream (-u)" },
  },
  [],
  async ({ path, remote = "origin", branch, force, setUpstream }) => {
    const ctx = getAgentContext();
    if (ctx?.worktreePath) {
      // Block pushing to protected branches
      // If branch not specified, resolve current branch to prevent bypass
      const protectedBranches = ["main", "master", "develop", "release"];
      const effectiveBranch = branch || ctx.worktreeBranch || "";
      if (protectedBranches.some((p) => effectiveBranch === p || effectiveBranch.startsWith(`${p}/`))) {
        return {
          success: false,
          output: "",
          error:
            "Cannot push to protected branches (main, master, develop, release). Push your clawd/* branch instead.",
        };
      }
    }
    const args = ["push"];
    if (force) args.push("-f");
    if (setUpstream) args.push("-u");
    args.push(remote);
    if (branch) args.push(branch);
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_pull",
  "Fetch from and integrate with another repository or a local branch.",
  {
    path: { type: "string", description: "Repository path" },
    remote: { type: "string", description: "Remote name (default: origin)" },
    branch: { type: "string", description: "Branch to pull" },
    rebase: { type: "boolean", description: "Rebase instead of merge" },
  },
  [],
  async ({ path, remote, branch, rebase }) => {
    const ctx = getAgentContext();
    if (ctx?.worktreePath) {
      return {
        success: false,
        output: "",
        error: "git_pull is not available. Use git_fetch to download remote updates.",
      };
    }
    const args = ["pull", "--no-edit"];
    if (rebase) args.push("--rebase");
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_fetch",
  "Download objects and refs from another repository.",
  {
    path: { type: "string", description: "Repository path" },
    remote: { type: "string", description: "Remote name (default: all)" },
    prune: { type: "boolean", description: "Prune deleted remote branches" },
  },
  [],
  async ({ path, remote, prune }) => {
    const args = ["fetch"];
    if (prune) args.push("--prune");
    if (remote) {
      args.push(remote);
    } else {
      args.push("--all");
    }
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_stash",
  "Stash the changes in a dirty working directory.",
  {
    path: { type: "string", description: "Repository path" },
    action: { type: "string", description: "Action: push, pop, list, drop, apply (default: push)" },
    message: { type: "string", description: "Stash message (for push)" },
  },
  [],
  async ({ path, action = "push", message }) => {
    const args = ["stash", action];
    if (action === "push" && message) args.push("-m", message);
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_reset",
  "Reset current HEAD to the specified state.",
  {
    path: { type: "string", description: "Repository path" },
    target: { type: "string", description: "Commit to reset to (default: HEAD)" },
    mode: { type: "string", description: "Reset mode: soft, mixed, hard (default: mixed)" },
    file: { type: "string", description: "File to unstage" },
  },
  [],
  async ({ path, target, mode, file }) => {
    const args = ["reset"];
    if (mode) args.push(`--${mode}`);
    if (target) args.push(target);
    if (file) args.push("--", file);
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_show",
  "Show various types of objects (commits, tags, etc.).",
  {
    path: { type: "string", description: "Repository path" },
    object: { type: "string", description: "Object to show (commit, tag, etc.)" },
    stat: { type: "boolean", description: "Show diffstat only" },
  },
  [],
  async ({ path, object = "HEAD", stat }) => {
    const args = ["show", object];
    if (stat) args.push("--stat");
    return execGitCommand(args, path);
  },
);

// ============================================================================
// Tmux Tools
// ============================================================================

/**
 * Execute a tmux command with proper environment
 */
async function execTmux(args: string[]): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("tmux", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
      timeout: 10000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout.trim() });
      } else {
        resolve({ success: false, output: stdout.trim(), error: stderr.trim() || `tmux exited with code ${code}` });
      }
    });

    proc.on("error", (err) => {
      resolve({ success: false, output: "", error: err.message });
    });
  });
}

/**
 * Get the agent-specific tmux socket name
 * Uses project hash + agent ID for full isolation between agents
 */
function getTmuxSocket(): string {
  const projectRoot = getSandboxProjectRoot();
  const agentId = getContextAgentId() || "default";
  // Create a safe socket name from project path hash and agent ID
  const hash = projectRoot.replace(/[^a-zA-Z0-9]/g, "_").slice(-20);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9]/g, "_").slice(-20);
  return `clawd_${hash}_${safeAgent}`;
}

/**
 * Run command in tmux session (new or existing)
 */
registerTool(
  "tmux_send_command",
  "Send a command to a tmux session. Creates session if it doesn't exist. Use this to run long-running processes, servers, or interactive programs in a persistent tmux session.",
  {
    session: { type: "string", description: "Session name (alphanumeric, no spaces)" },
    command: { type: "string", description: "Command to run" },
    cwd: { type: "string", description: "Working directory (defaults to project root)" },
  },
  ["session", "command"],
  async ({ session, command, cwd }) => {
    // Validate session name
    if (!/^[a-zA-Z0-9_-]+$/.test(session)) {
      return { success: false, error: "Session name must be alphanumeric (a-z, A-Z, 0-9, _, -)", output: "" };
    }

    const projectRoot = getSandboxProjectRoot();
    const workDir = cwd || projectRoot;
    const socket = getTmuxSocket();

    // Check if session exists
    const listResult = await execTmux(["-L", socket, "list-sessions", "-F", "#{session_name}"]);
    const sessions = listResult.success ? listResult.output.split("\n").filter(Boolean) : [];
    const sessionExists = sessions.includes(session);

    // Build the command - cd to workdir first
    const cdCmd = `cd "${workDir}" && ${command}`;

    if (!sessionExists) {
      // Create new session and send command
      const createResult = await execTmux(["-L", socket, "new-session", "-d", "-s", session, cdCmd]);
      if (!createResult.success) {
        return { success: false, error: createResult.error || "Failed to create session", output: "" };
      }
      return {
        success: true,
        output: JSON.stringify({
          session,
          status: "created",
          command: command.slice(0, 100) + (command.length > 100 ? "..." : ""),
          cwd: workDir,
        }),
      };
    } else {
      // Send command to existing session (run in the default pane)
      const sendResult = await execTmux(["-L", socket, "send-keys", "-t", session, cdCmd, "C-m"]);
      if (!sendResult.success) {
        return { success: false, error: sendResult.error || "Failed to send command", output: "" };
      }
      return {
        success: true,
        output: JSON.stringify({
          session,
          status: "command_sent",
          command: command.slice(0, 100) + (command.length > 100 ? "..." : ""),
        }),
      };
    }
  },
);

/**
 * List tmux sessions for this project
 */
registerTool(
  "tmux_list",
  "List all tmux sessions for this project. Shows session names and their current state.",
  {},
  [],
  async () => {
    const socket = getTmuxSocket();

    // List sessions with details
    const result = await execTmux([
      "-L",
      socket,
      "list-sessions",
      "-F",
      "#{session_name}|#{session_created}|#{session_windows}",
    ]);

    if (!result.success || !result.output) {
      return {
        success: true,
        output: JSON.stringify({ sessions: [], message: "No tmux sessions for this project" }),
      };
    }

    const sessions = result.output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, created, windows] = line.split("|");
        return { name, created, windows };
      });

    return {
      success: true,
      output: JSON.stringify({ sessions }),
    };
  },
);

/**
 * Kill a tmux session
 */
registerTool(
  "tmux_kill",
  "Kill a tmux session. This terminates the session and all processes running in it.",
  {
    session: { type: "string", description: "Session name to kill" },
  },
  ["session"],
  async ({ session }) => {
    const socket = getTmuxSocket();

    const result = await execTmux(["-L", socket, "kill-session", "-t", session]);

    if (!result.success) {
      return { success: false, error: result.error || "Failed to kill session", output: "" };
    }

    return {
      success: true,
      output: JSON.stringify({ session, status: "killed" }),
    };
  },
);

/**
 * Capture tmux pane output
 */
registerTool(
  "tmux_capture",
  "Capture the visible output from a tmux session pane. Useful for seeing the output of long-running programs or interactive sessions.",
  {
    session: { type: "string", description: "Session name" },
    clear: { type: "boolean", description: "Clear the pane history after capturing" },
  },
  ["session"],
  async ({ session, clear = false }) => {
    const socket = getTmuxSocket();

    // Capture pane content
    const captureArgs = ["-L", socket, "capture-pane", "-t", session, "-p"];
    if (clear) {
      captureArgs.push("-C"); // Clear history after capture
    }

    const result = await execTmux(captureArgs);

    if (!result.success) {
      return { success: false, error: result.error || "Failed to capture pane", output: "" };
    }

    return {
      success: true,
      output: JSON.stringify({
        session,
        output: result.output,
        truncated: result.output.length > 50000,
      }),
    };
  },
);

/**
 * Send raw input to tmux session
 */
registerTool(
  "tmux_send_input",
  "Send raw keystrokes to a tmux session. Use this to interact with interactive programs (vim, nano, less, etc.). Send special keys using: Enter= C-m, Tab= C-i, Esc= C-[, Arrow keys= A-up, A-down, etc.",
  {
    session: { type: "string", description: "Session name" },
    keys: {
      type: "string",
      description: "Keys to send (supports special keys: C-m=Enter, C-i=Tab, C-[=Esc, A-up=Up arrow, etc.)",
    },
  },
  ["session", "keys"],
  async ({ session, keys }) => {
    const socket = getTmuxSocket();

    // Convert special key notation
    const parsedKeys = keys
      .replace(/C-m/gi, "Enter")
      .replace(/C-i/gi, "Tab")
      .replace(/C-\[/gi, "Escape")
      .replace(/C-c/gi, "C-c")
      .replace(/C-d/gi, "C-d")
      .replace(/A-/gi, "A-");

    const result = await execTmux(["-L", socket, "send-keys", "-t", session, parsedKeys, "Enter"]);

    if (!result.success) {
      return { success: false, error: result.error || "Failed to send keys", output: "" };
    }

    return {
      success: true,
      output: JSON.stringify({
        session,
        keys_sent: keys,
        status: "sent",
      }),
    };
  },
);

/**
 * Create a new window in a tmux session
 */
registerTool(
  "tmux_new_window",
  "Create a new window in an existing tmux session.",
  {
    session: { type: "string", description: "Session name" },
    window: { type: "string", description: "Window name (optional)" },
    command: { type: "string", description: "Command to run in window (optional)" },
  },
  ["session"],
  async ({ session, window, command }) => {
    const socket = getTmuxSocket();

    const args = ["-L", socket, "new-window", "-t", session];
    if (window) args.push("-n", window);
    if (command) args.push(command);

    const result = await execTmux(args);

    if (!result.success) {
      return { success: false, error: result.error || "Failed to create window", output: "" };
    }

    return {
      success: true,
      output: JSON.stringify({
        session,
        window: window || result.output.trim(),
        status: "created",
      }),
    };
  },
);

/**
 * Kill a window in a tmux session
 */
registerTool(
  "tmux_kill_window",
  "Kill a specific window in a tmux session.",
  {
    session: { type: "string", description: "Session name" },
    window: { type: "string", description: "Window name or index (e.g., 0, 1, or window name)" },
  },
  ["session", "window"],
  async ({ session, window }) => {
    const socket = getTmuxSocket();

    const result = await execTmux(["-L", socket, "kill-window", "-t", `${session}:${window}`]);

    if (!result.success) {
      return { success: false, error: result.error || "Failed to kill window", output: "" };
    }

    return {
      success: true,
      output: JSON.stringify({
        session,
        window,
        status: "killed",
      }),
    };
  },
);

// ============================================================================
// Article Tools
// ============================================================================

registerTool(
  "article_create",
  "Create a new article (blog post, documentation, etc.). The article is stored and can be published to the channel. Use markdown for content.",
  {
    title: { type: "string", description: "Article title" },
    content: { type: "string", description: "Article content in markdown format" },
    description: { type: "string", description: "Short description/summary (optional)" },
    thumbnail_url: { type: "string", description: "URL for thumbnail image (optional)" },
    tags: { type: "array", description: "Array of tags for the article (optional)", items: { type: "string" } },
    published: { type: "boolean", description: "Whether to publish immediately (default: false)" },
  },
  ["title", "content"],
  async ({ title, content, description, thumbnail_url, tags, published }) => {
    const channel = getContextChannel();
    const agentId = getContextAgentId() || "agent";

    try {
      const res = await toolFetch(`${chatApiUrl}/api/articles.create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: channel,
          author: agentId,
          title,
          content,
          description: description || "",
          thumbnail_url: thumbnail_url || "",
          tags: tags || [],
          published: published || false,
        }),
      });
      const data = (await res.json()) as any;
      if (data.ok) {
        return {
          success: true,
          output: JSON.stringify({
            id: data.article.id,
            title: data.article.title,
            url: `/articles/${data.article.id}`,
            published: data.article.published === 1,
          }),
        };
      }
      return { success: false, error: data.error || "Failed to create article", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

registerTool(
  "article_list",
  "List articles in a channel. Shows recent articles with metadata.",
  {
    channel: { type: "string", description: "Channel ID (optional, defaults to current)" },
    limit: { type: "number", description: "Max articles to return (default: 10)" },
    offset: { type: "number", description: "Pagination offset (default: 0)" },
    published_only: { type: "boolean", description: "Only show published articles (default: true)" },
  },
  [],
  async ({ channel, limit = 10, offset = 0, published_only = true }) => {
    const currentChannel = channel || getContextChannel();

    try {
      const url = new URL(`${chatApiUrl}/api/articles.list`);
      url.searchParams.set("channel", currentChannel);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("published", String(published_only));

      const res = await toolFetch(url.toString());
      const data = (await res.json()) as any;
      if (data.ok) {
        return {
          success: true,
          output: JSON.stringify({
            articles: data.articles.map((a: any) => ({
              id: a.id,
              title: a.title,
              description: a.description,
              author: a.author,
              published: a.published === 1,
              created_at: a.created_at,
            })),
          }),
        };
      }
      return { success: false, error: data.error || "Failed to list articles", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

registerTool(
  "article_get",
  "Get a specific article by ID. Returns full content and metadata.",
  {
    id: { type: "string", description: "Article ID" },
  },
  ["id"],
  async ({ id }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/articles.get?id=${encodeURIComponent(id)}`);
      const data = (await res.json()) as any;
      if (data.ok) {
        return {
          success: true,
          output: JSON.stringify({
            id: data.article.id,
            title: data.article.title,
            description: data.article.description,
            author: data.article.author,
            content: data.article.content,
            thumbnail_url: data.article.thumbnail_url,
            tags: JSON.parse(data.article.tags_json || "[]"),
            published: data.article.published === 1,
            created_at: data.article.created_at,
            updated_at: data.article.updated_at,
          }),
        };
      }
      return { success: false, error: data.error || "Article not found", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

registerTool(
  "article_update",
  "Update an existing article.",
  {
    id: { type: "string", description: "Article ID" },
    title: { type: "string", description: "New title (optional)" },
    content: { type: "string", description: "New content (optional)" },
    description: { type: "string", description: "New description (optional)" },
    thumbnail_url: { type: "string", description: "New thumbnail URL (optional)" },
    tags: { type: "array", description: "New tags (optional)", items: { type: "string" } },
    published: { type: "boolean", description: "Publish/unpublish (optional)" },
  },
  ["id"],
  async ({ id, title, content, description, thumbnail_url, tags, published }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/articles.update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          ...(title !== undefined && { title }),
          ...(content !== undefined && { content }),
          ...(description !== undefined && { description }),
          ...(thumbnail_url !== undefined && { thumbnail_url }),
          ...(tags !== undefined && { tags }),
          ...(published !== undefined && { published }),
        }),
      });
      const data = (await res.json()) as any;
      if (data.ok) {
        return {
          success: true,
          output: JSON.stringify({
            id: data.article.id,
            title: data.article.title,
            updated_at: data.article.updated_at,
          }),
        };
      }
      return { success: false, error: data.error || "Failed to update article", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

registerTool(
  "article_delete",
  "Delete an article.",
  {
    id: { type: "string", description: "Article ID to delete" },
  },
  ["id"],
  async ({ id }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/articles.delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = (await res.json()) as any;
      if (data.ok) {
        return { success: true, output: JSON.stringify({ id, deleted: true }) };
      }
      return { success: false, error: data.error || "Failed to delete article", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

registerTool(
  "chat_send_article",
  "Send an article as a message to the chat. This posts an article card to the channel that links to the full article page.",
  {
    article_id: { type: "string", description: "Article ID to send to chat" },
    channel: { type: "string", description: "Channel ID (optional, defaults to current channel)" },
  },
  ["article_id"],
  async ({ article_id, channel }) => {
    const currentChannel = channel || getContextChannel();
    const agentId = getContextAgentId() || "agent";

    if (!currentChannel) {
      return { success: false, error: "Channel not specified", output: "" };
    }

    try {
      // First get the article details
      const articleRes = await toolFetch(`${chatApiUrl}/api/articles.get?id=${encodeURIComponent(article_id)}`);
      const articleData = (await articleRes.json()) as any;

      if (!articleData.ok || !articleData.article) {
        return { success: false, error: "Article not found", output: "" };
      }

      const article = articleData.article;

      // Send message with article attachment
      const msgRes = await toolFetch(`${chatApiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: currentChannel,
          user: "UBOT",
          agent_id: agentId,
          text: `Article: ${article.title}`,
          subtype: "article",
          article_json: JSON.stringify({
            id: article.id,
            title: article.title,
            description: article.description,
            author: article.author,
            thumbnail_url: article.thumbnail_url,
          }),
        }),
      });
      const msgData = (await msgRes.json()) as any;

      if (msgData.ok) {
        return {
          success: true,
          output: JSON.stringify({
            message_ts: msgData.ts,
            article_id: article.id,
            article_url: `/articles/${article.id}`,
          }),
        };
      }
      return { success: false, error: msgData.error || "Failed to send article message", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

// ============================================================================
// Tool: Convert to Markdown
// ============================================================================

registerTool(
  "convert_to_markdown",
  "Convert a document file to markdown and save as .md file in {projectRoot}/.clawd/files/. Returns the saved path and content size. Use view() to read the converted content. Supports: PDF, DOCX, XLSX, PPTX, HTML, EPUB, CSV. For images use read_image. For JSON/XML/YAML/text use view.",
  {
    path: {
      type: "string",
      description: "Absolute path to the file to convert",
    },
  },
  ["path"],
  async ({ path: filePath }: Record<string, any>) => {
    if (!filePath) {
      return { success: false, output: "", error: "path is required" };
    }

    const resolvedPath = resolveSafePath(filePath);
    const pathError = validatePath(resolvedPath, "convert_to_markdown");
    if (pathError) return { success: false, output: "", error: pathError };

    const { convertToMarkdown } = await import("./document-converter");
    const result = await convertToMarkdown(resolvedPath);

    if (!result.success) {
      return { success: false, output: "", error: result.error };
    }

    // Save to {originalProjectRoot}/.clawd/files/ (not worktree)
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { basename, extname, join } = await import("node:path");
    const { getContextConfigRoot } = await import("../utils/agent-context");

    const configRoot = getContextConfigRoot();
    const filesDir = join(configRoot, ".clawd", "files");
    await mkdir(filesDir, { recursive: true });

    const base = basename(resolvedPath, extname(resolvedPath)).replace(/[^a-zA-Z0-9._-]/g, "_") || "converted";
    const mdPath = join(filesDir, `${base}.md`);
    await writeFile(mdPath, result.markdown, "utf-8");

    return {
      success: true,
      output: `Converted ${result.format.toUpperCase()} to Markdown (${result.markdown.length} chars). Saved to: ${mdPath}\nUse view("${mdPath}") to read the full content.`,
    };
  },
);

// ============================================================================
// Sub-Agent Cleanup
// ============================================================================

/**
 * Wait for all running sub-agents to complete.
 * Call this before exiting to ensure all async sub-agents finish.
 */
export async function waitForSubAgents(timeout: number = 60000): Promise<void> {
  // All agents are now tmux-based (detached) - they survive process exit
  const tmuxRunning = Array.from(subAgents.values()).filter((a) => a.status === "running" && a.tmuxSession);
  if (tmuxRunning.length > 0) {
    console.log(`[SubAgents] ${tmuxRunning.length} tmux sub-agent(s) still running (they will continue independently)`);
  }
}

/**
 * Terminate all running sub-agents immediately.
 */
export async function terminateAllSubAgents(): Promise<void> {
  const running = Array.from(subAgents.values()).filter((a) => a.status === "running");
  for (const agent of running) {
    try {
      if (agent.tmuxSession) {
        // Kill tmux session for detached agents
        const { execSync } = require("node:child_process");
        const socketPath = getSubAgentSocketPath();
        try {
          execSync(`tmux -S "${socketPath}" kill-session -t "${agent.tmuxSession}" 2>/dev/null`, { stdio: "ignore" });
        } catch {}
      }
      agent.status = "aborted";
      agent.completedAt = Date.now();
    } catch {}
  }
}

// ============================================================================
// Tool Executor
// ============================================================================

export async function executeTool(toolCall: ToolCall): Promise<ToolResult> {
  const toolName = toolCall.function.name;
  const handler = tools.get(toolName);

  if (!handler) {
    return {
      success: false,
      output: "",
      error: `Unknown tool: ${toolName}`,
    };
  }

  try {
    // Handle empty arguments (LLM sometimes sends "" instead of "{}")
    const argsString = toolCall.function.arguments?.trim() || "{}";
    const rawArgs = JSON.parse(argsString || "{}");
    const args = normalizeToolArgs(rawArgs);

    // Run before hooks (async, non-blocking)
    try {
      const hookManager = getHookManager();
      if (hookManager.isInitialized()) {
        hookManager.runBeforeHook(toolName, args);
      }
    } catch {
      // Silent failure - hooks should never block tool execution
    }

    // Execute the actual tool
    const result = await handler(args);

    // Run after hooks (async, non-blocking)
    try {
      const hookManager = getHookManager();
      if (hookManager.isInitialized()) {
        hookManager.runAfterHook(toolName, args, result);
      }
    } catch {
      // Silent failure - hooks should never block tool execution
    }

    return result;
  } catch (err: any) {
    return {
      success: false,
      output: "",
      error: `Failed to execute tool: ${err.message}`,
    };
  }
}

export async function executeTools(toolCalls: ToolCall[]): Promise<Map<string, ToolResult>> {
  const results = new Map<string, ToolResult>();

  // Execute tools in parallel
  await Promise.all(
    toolCalls.map(async (tc) => {
      const result = await executeTool(tc);
      results.set(tc.id, result);
    }),
  );

  return results;
}

// For sub-agent compatibility (returns array format)
export async function executeToolsArray(
  toolCalls: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>,
): Promise<Array<{ tool_call_id: string; content: string }>> {
  const results: Array<{ tool_call_id: string; content: string }> = [];

  for (const tc of toolCalls) {
    const result = await executeTool(tc as ToolCall);
    const content = result.success ? result.output : `Error: ${result.error || "Unknown error"}`;
    results.push({ tool_call_id: tc.id, content });
  }

  return results;
}
