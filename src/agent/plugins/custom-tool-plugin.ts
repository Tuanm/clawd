/**
 * Custom Tool Plugin
 *
 * Allows agents to create, manage, and execute project-scoped custom tools.
 * Tools are stored in {projectRoot}/.clawd/tools/{toolId}/ with:
 *   - tool.json: metadata (name, description, parameters, entrypoint, interpreter, timeout)
 *   - entrypoint file: the script to execute
 *
 * Custom tools are executed inside the sandbox for security.
 * Args are passed as JSON via stdin; stdout is the tool output.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { extname, join } from "path";
import type { ToolResult } from "../tools/definitions";
import type { ToolContext, ToolParameter, ToolPlugin, ToolRegistration } from "../tools/plugin";
import { getContextProjectRoot } from "../utils/agent-context";
import { runInSandbox } from "../utils/sandbox";

// ============================================================================
// Types
// ============================================================================

interface CustomToolMeta {
  name: string;
  description: string;
  parameters: Record<string, CustomToolParam>;
  required?: string[];
  entrypoint: string;
  interpreter?: string;
  timeout?: number;
}

interface CustomToolParam {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  default?: any;
}

// ============================================================================
// Constants
// ============================================================================

const TOOL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ALLOWED_INTERPRETERS = ["bash", "sh", "python3", "python", "bun", "node"] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_STDOUT = 64 * 1024; // 64KB
const MAX_STDERR = 16 * 1024; // 16KB

// Extension → interpreter mapping for auto-detection
const EXT_INTERPRETER: Record<string, string> = {
  ".sh": "bash",
  ".bash": "bash",
  ".py": "python3",
  ".ts": "bun",
  ".js": "bun",
};

// ============================================================================
// Built-in tool names (collision prevention)
// ============================================================================

const BUILTIN_TOOLS = new Set([
  "today",
  "bash",
  "view",
  "edit",
  "create",
  "glob",
  "grep",
  "git_status",
  "git_diff",
  "git_add",
  "git_commit",
  "git_push",
  "git_pull",
  "git_log",
  "git_show",
  "git_branch",
  "git_checkout",
  "git_fetch",
  "git_reset",
  "git_stash",
  "web_fetch",
  "web_search",
  "spawn_agent",
  "kill_agent",
  "list_agents",
  "get_agent_report",
  "get_agent_logs",
  "memory_search",
  "memory_summary",
  "skill_list",
  "skill_search",
  "skill_activate",
  "skill_create",
  "skill_delete",
  "todo_write",
  "todo_read",
  "todo_update",
  "job_submit",
  "job_status",
  "job_logs",
  "job_wait",
  "job_cancel",
  "tmux_send_command",
  "tmux_send_input",
  "tmux_capture",
  "tmux_list",
  "tmux_kill",
  "tmux_new_window",
  "tmux_kill_window",
  "article_create",
  "article_get",
  "article_list",
  "article_update",
  "article_delete",
  "send_article",
  // Browser plugin tools
  "browser_status",
  "browser_navigate",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_extract",
  "browser_tabs",
  "browser_execute",
  "browser_scroll",
  "browser_hover",
  "browser_mouse_move",
  "browser_drag",
  "browser_keypress",
  "browser_wait_for",
  "browser_select",
  "browser_handle_dialog",
  "browser_history",
  "browser_upload_file",
  "browser_frames",
  "browser_touch",
  // Management tool itself
  "custom_script",
]);

// ============================================================================
// Helper functions
// ============================================================================

function getToolsDir(projectRoot: string): string {
  return join(projectRoot, ".clawd", "tools");
}

function getToolDir(projectRoot: string, toolId: string): string {
  return join(getToolsDir(projectRoot), toolId);
}

function loadToolMeta(toolDir: string): CustomToolMeta | null {
  const metaPath = join(toolDir, "tool.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

function validateToolMeta(meta: any): { valid: boolean; error?: string } {
  if (!meta || typeof meta !== "object") return { valid: false, error: "tool.json must be a JSON object" };
  if (!meta.name || typeof meta.name !== "string")
    return { valid: false, error: "name is required and must be a string" };
  if (!TOOL_NAME_RE.test(meta.name))
    return { valid: false, error: `name must match ${TOOL_NAME_RE} (lowercase, alphanumeric, hyphens, underscores)` };
  if (BUILTIN_TOOLS.has(meta.name))
    return { valid: false, error: `'${meta.name}' conflicts with a built-in tool name` };
  if (!meta.description || typeof meta.description !== "string")
    return { valid: false, error: "description is required" };
  if (!meta.entrypoint || typeof meta.entrypoint !== "string") return { valid: false, error: "entrypoint is required" };
  if (meta.entrypoint.includes("/") || meta.entrypoint.includes("\\"))
    return { valid: false, error: "entrypoint must be a filename, not a path" };
  if (meta.interpreter && !ALLOWED_INTERPRETERS.includes(meta.interpreter)) {
    return { valid: false, error: `interpreter must be one of: ${ALLOWED_INTERPRETERS.join(", ")}` };
  }
  if (meta.timeout !== undefined) {
    if (typeof meta.timeout !== "number" || meta.timeout < 1 || meta.timeout > MAX_TIMEOUT_MS / 1000) {
      return { valid: false, error: `timeout must be 1-${MAX_TIMEOUT_MS / 1000} seconds` };
    }
  }
  return { valid: true };
}

function detectInterpreter(entrypoint: string, explicit?: string): string {
  if (explicit) return explicit;
  const ext = extname(entrypoint);
  return EXT_INTERPRETER[ext] || "bash";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (truncated at ${max} bytes)`;
}

// ============================================================================
// Tool execution (sandboxed)
// ============================================================================

async function executeCustomTool(projectRoot: string, toolId: string, args: Record<string, any>): Promise<ToolResult> {
  const toolDir = getToolDir(projectRoot, toolId);
  const meta = loadToolMeta(toolDir);
  if (!meta) return { success: false, output: `Custom tool '${toolId}' not found or invalid tool.json` };

  const entrypointPath = join(toolDir, meta.entrypoint);
  if (!existsSync(entrypointPath)) {
    return { success: false, output: `Entrypoint '${meta.entrypoint}' not found in tool directory` };
  }

  const interpreter = detectInterpreter(meta.entrypoint, meta.interpreter);
  const timeoutMs = meta.timeout ? Math.min(meta.timeout * 1000, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

  const result = await runInSandbox(interpreter, [entrypointPath], {
    timeout: timeoutMs,
    cwd: projectRoot,
    stdin: JSON.stringify(args),
  });

  const stdout = truncate(result.stdout, MAX_STDOUT);
  const stderr = truncate(result.stderr, MAX_STDERR);

  if (!result.success) {
    const output = stderr || stdout || `Tool exited with code ${result.code}`;
    return { success: false, output };
  }

  return { success: true, output: stdout || "(no output)" };
}

function validateToolId(tool_id: any): ToolResult | null {
  if (!tool_id) return { success: false, output: "tool_id is required" };
  if (!TOOL_NAME_RE.test(tool_id)) return { success: false, output: `tool_id must match ${TOOL_NAME_RE}` };
  if (BUILTIN_TOOLS.has(tool_id)) return { success: false, output: `'${tool_id}' conflicts with a built-in tool name` };
  return null; // valid
}

// ============================================================================
// Management handlers (add, edit, delete, view, execute)
// ============================================================================

function handleAdd(projectRoot: string, args: Record<string, any>): ToolResult {
  const { tool_id, description, parameters, required, entrypoint_name, entrypoint_content, interpreter, timeout } =
    args;

  const idErr = validateToolId(tool_id);
  if (idErr) return idErr;
  if (!description) return { success: false, output: "description is required" };
  if (!entrypoint_name) return { success: false, output: "entrypoint_name is required" };
  if (!entrypoint_content) return { success: false, output: "entrypoint_content is required" };
  if (
    entrypoint_name.includes("/") ||
    entrypoint_name.includes("\\") ||
    entrypoint_name === ".." ||
    entrypoint_name === "."
  ) {
    return { success: false, output: "entrypoint_name must be a simple filename" };
  }
  if (typeof entrypoint_content === "string" && entrypoint_content.length > 1_048_576) {
    return { success: false, output: "entrypoint_content exceeds 1MB limit" };
  }

  const toolDir = getToolDir(projectRoot, tool_id);
  if (existsSync(toolDir))
    return { success: false, output: `Tool '${tool_id}' already exists. Use mode=edit to update it.` };

  const meta: CustomToolMeta = {
    name: tool_id,
    description,
    parameters: parameters || {},
    required: required || [],
    entrypoint: entrypoint_name,
    interpreter,
    timeout,
  };

  const validation = validateToolMeta(meta);
  if (!validation.valid) return { success: false, output: validation.error! };

  mkdirSync(toolDir, { recursive: true });
  writeFileSync(join(toolDir, "tool.json"), JSON.stringify(meta, null, 2));
  writeFileSync(join(toolDir, entrypoint_name), entrypoint_content);

  return { success: true, output: `Custom script '${tool_id}' created at .clawd/tools/${tool_id}/` };
}

function handleEdit(projectRoot: string, args: Record<string, any>): ToolResult {
  const { tool_id, description, parameters, required, entrypoint_content, interpreter, timeout } = args;

  const idErr = validateToolId(tool_id);
  if (idErr) return idErr;

  const toolDir = getToolDir(projectRoot, tool_id);
  if (!existsSync(toolDir)) return { success: false, output: `Tool '${tool_id}' does not exist` };

  const meta = loadToolMeta(toolDir);
  if (!meta) return { success: false, output: `Invalid tool.json for '${tool_id}'` };

  // Update fields if provided
  if (description !== undefined) meta.description = description;
  if (parameters !== undefined) meta.parameters = parameters;
  if (required !== undefined) meta.required = required;
  if (interpreter !== undefined) meta.interpreter = interpreter;
  if (timeout !== undefined) meta.timeout = timeout;

  const validation = validateToolMeta(meta);
  if (!validation.valid) return { success: false, output: validation.error! };

  writeFileSync(join(toolDir, "tool.json"), JSON.stringify(meta, null, 2));

  if (entrypoint_content !== undefined) {
    writeFileSync(join(toolDir, meta.entrypoint), entrypoint_content);
  }

  return { success: true, output: `Custom script '${tool_id}' updated` };
}

function handleDelete(projectRoot: string, args: Record<string, any>): ToolResult {
  const { tool_id } = args;
  const idErr = validateToolId(tool_id);
  if (idErr) return idErr;

  const toolDir = getToolDir(projectRoot, tool_id);
  if (!existsSync(toolDir)) return { success: false, output: `Tool '${tool_id}' does not exist` };

  rmSync(toolDir, { recursive: true, force: true });
  return { success: true, output: `Custom script '${tool_id}' deleted` };
}

function handleView(projectRoot: string, args: Record<string, any>): ToolResult {
  const { tool_id } = args;
  const idErr = validateToolId(tool_id);
  if (idErr) return idErr;

  const toolDir = getToolDir(projectRoot, tool_id);
  if (!existsSync(toolDir)) return { success: false, output: `Tool '${tool_id}' does not exist` };

  const meta = loadToolMeta(toolDir);
  if (!meta) return { success: false, output: `Invalid tool.json for '${tool_id}'` };

  let output = `# Custom Script: ${meta.name}\n`;
  output += `Description: ${meta.description}\n`;
  output += `Entrypoint: ${meta.entrypoint}\n`;
  output += `Interpreter: ${detectInterpreter(meta.entrypoint, meta.interpreter)}\n`;
  if (meta.timeout) output += `Timeout: ${meta.timeout}s\n`;
  if (meta.required?.length) output += `Required params: ${meta.required.join(", ")}\n`;

  if (Object.keys(meta.parameters).length > 0) {
    output += `\nParameters:\n`;
    for (const [k, v] of Object.entries(meta.parameters)) {
      output += `  ${k} (${v.type}): ${v.description}\n`;
    }
  }

  // Show entrypoint source
  const entrypointPath = join(toolDir, meta.entrypoint);
  if (existsSync(entrypointPath)) {
    const source = readFileSync(entrypointPath, "utf-8");
    output += `\n--- ${meta.entrypoint} ---\n${source}`;
  }

  return { success: true, output };
}

function handleList(projectRoot: string): ToolResult {
  const toolsDir = getToolsDir(projectRoot);
  if (!existsSync(toolsDir)) return { success: true, output: "No custom scripts found." };

  const entries = readdirSync(toolsDir).filter((e) => {
    const p = join(toolsDir, e);
    return statSync(p).isDirectory() && existsSync(join(p, "tool.json"));
  });

  if (entries.length === 0) return { success: true, output: "No custom scripts found." };

  let output = `Custom scripts (${entries.length}):\n`;
  for (const id of entries) {
    const meta = loadToolMeta(join(toolsDir, id));
    if (meta) {
      output += `  • ${meta.name}: ${meta.description}\n`;
    }
  }

  return { success: true, output };
}

// ============================================================================
// CustomToolPlugin — implements ToolPlugin
// ============================================================================

export class CustomToolPlugin implements ToolPlugin {
  readonly name = "custom-tools";

  getTools(): ToolRegistration[] {
    return [
      {
        name: "custom_script",
        description:
          "Manage and execute project-scoped custom scripts. Custom scripts are reusable scripts that persist across sessions. " +
          "All agents in the same project share these scripts. " +
          "Modes: list (show all), add (create new), edit (update existing), delete (remove), view (inspect code), execute (run with args).",
        parameters: {
          mode: {
            type: "string",
            description: "Operation mode",
            enum: ["list", "add", "edit", "delete", "view", "execute"],
          },
          tool_id: {
            type: "string",
            description:
              "Tool identifier (required for add/edit/delete/view/execute). Lowercase alphanumeric with hyphens/underscores.",
          },
          description: {
            type: "string",
            description: "Tool description (required for add, optional for edit)",
          },
          parameters: {
            type: "object",
            description:
              'Tool parameter definitions as JSON object. Each key is a param name, value is {type, description, enum?, default?}. Example: {"query": {"type": "string", "description": "Search query"}}',
          },
          required: {
            type: "array",
            items: { type: "string" },
            description: "List of required parameter names",
          },
          entrypoint_name: {
            type: "string",
            description:
              "Filename of the entrypoint script (required for add). Extension determines interpreter: .sh→bash, .py→python3, .ts/.js→bun",
          },
          entrypoint_content: {
            type: "string",
            description: "Source code of the entrypoint script (required for add, optional for edit)",
          },
          interpreter: {
            type: "string",
            description:
              "Override interpreter (bash, sh, python3, bun, node). Auto-detected from extension if omitted.",
            enum: ["bash", "sh", "python3", "python", "bun", "node"],
          },
          timeout: {
            type: "number",
            description: "Execution timeout in seconds (1-300, default 30)",
          },
          arguments: {
            type: "object",
            description: "Arguments to pass when mode=execute. Passed as JSON via stdin to the entrypoint script.",
          },
        },
        required: ["mode"],
        handler: async (args: Record<string, any>): Promise<ToolResult> => {
          const projectRoot = getContextProjectRoot();
          if (!projectRoot) {
            return { success: false, output: "No project root available. Custom tools require a project context." };
          }

          switch (args.mode) {
            case "list":
              return handleList(projectRoot);
            case "add":
              return handleAdd(projectRoot, args);
            case "edit":
              return handleEdit(projectRoot, args);
            case "delete":
              return handleDelete(projectRoot, args);
            case "view":
              return handleView(projectRoot, args);
            case "execute": {
              const execIdErr = validateToolId(args.tool_id);
              if (execIdErr) return execIdErr;
              return executeCustomTool(projectRoot, args.tool_id, args.arguments || {});
            }
            default:
              return {
                success: false,
                output: `Unknown mode '${args.mode}'. Use: list, add, edit, delete, view, execute`,
              };
          }
        },
      },
    ];
  }

  /**
   * Scan project's .clawd/tools/ and return ToolRegistrations for each discovered custom script.
   * These are registered as first-class tools alongside built-in tools.
   */
  getDiscoveredTools(projectRoot: string): ToolRegistration[] {
    const toolsDir = getToolsDir(projectRoot);
    if (!existsSync(toolsDir)) return [];

    const registrations: ToolRegistration[] = [];
    let entries: string[];
    try {
      entries = readdirSync(toolsDir);
    } catch {
      return [];
    }

    for (const id of entries) {
      const toolDir = join(toolsDir, id);
      try {
        if (!statSync(toolDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const meta = loadToolMeta(toolDir);
      if (!meta) continue;

      const validation = validateToolMeta(meta);
      if (!validation.valid) continue;

      // Register as first-class tool with "ct_" prefix to avoid collisions
      registrations.push({
        name: `ct_${meta.name}`,
        description: `[Custom Script] ${meta.description}`,
        parameters: meta.parameters as Record<string, ToolParameter>,
        required: meta.required || [],
        handler: async (args: Record<string, any>): Promise<ToolResult> => {
          return executeCustomTool(projectRoot, id, args);
        },
      });
    }

    return registrations;
  }
}

// ============================================================================
// Standalone helpers (used by MCP endpoint and prompt builder)
// ============================================================================

/**
 * Count the number of custom scripts in the project's .clawd/tools/ directory.
 */
export function countCustomScripts(projectRoot: string): number {
  const toolsDir = getToolsDir(projectRoot);
  if (!existsSync(toolsDir)) return 0;
  try {
    return readdirSync(toolsDir).filter((e) => {
      const p = join(toolsDir, e);
      return statSync(p).isDirectory() && existsSync(join(p, "tool.json"));
    }).length;
  } catch {
    return 0;
  }
}

/** MCP-format tool definition for custom_script (used in tools/list responses). */
export const CUSTOM_SCRIPT_MCP_TOOL_DEF = {
  name: "custom_script",
  description:
    "Manage and execute project-scoped custom scripts. Custom scripts are reusable scripts that persist across sessions. " +
    "All agents in the same project share these scripts. " +
    "Modes: list (show all), add (create new), edit (update existing), delete (remove), view (inspect code), execute (run with args).",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        description: "Operation mode",
        enum: ["list", "add", "edit", "delete", "view", "execute"],
      },
      tool_id: {
        type: "string",
        description:
          "Script identifier (required for add/edit/delete/view/execute). Lowercase alphanumeric with hyphens/underscores.",
      },
      description: { type: "string", description: "Script description (required for add, optional for edit)" },
      parameters: {
        type: "object",
        description:
          'Parameter definitions as JSON object. Each key is a param name, value is {type, description, enum?, default?}. Example: {"query": {"type": "string", "description": "Search query"}}',
      },
      required: {
        type: "array",
        items: { type: "string" },
        description: "List of required parameter names",
      },
      entrypoint_name: {
        type: "string",
        description:
          "Filename of the entrypoint script (required for add). Extension determines interpreter: .sh→bash, .py→python3, .ts/.js→bun",
      },
      entrypoint_content: {
        type: "string",
        description: "Source code of the entrypoint script (required for add, optional for edit)",
      },
      interpreter: {
        type: "string",
        description: "Override interpreter (bash, sh, python3, bun, node). Auto-detected from extension if omitted.",
        enum: ["bash", "sh", "python3", "python", "bun", "node"],
      },
      timeout: { type: "number", description: "Execution timeout in seconds (1-300, default 30)" },
      arguments: {
        type: "object",
        description: "Arguments to pass when mode=execute. Passed as JSON via stdin to the entrypoint script.",
      },
    },
    required: ["mode"],
  },
};

/**
 * Execute the custom_script tool and return an MCP-formatted result.
 * Used by the MCP server endpoints (agent + space).
 */
export async function executeCustomScriptMcp(
  projectRoot: string,
  args: Record<string, any>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  let result: ToolResult;
  switch (args.mode) {
    case "list":
      result = handleList(projectRoot);
      break;
    case "add":
      result = handleAdd(projectRoot, args);
      break;
    case "edit":
      result = handleEdit(projectRoot, args);
      break;
    case "delete":
      result = handleDelete(projectRoot, args);
      break;
    case "view":
      result = handleView(projectRoot, args);
      break;
    case "execute": {
      const execIdErr = validateToolId(args.tool_id);
      if (execIdErr) {
        result = execIdErr;
      } else {
        result = await executeCustomTool(projectRoot, args.tool_id, args.arguments || {});
      }
      break;
    }
    default:
      result = {
        success: false,
        output: `Unknown mode '${args.mode}'. Use: list, add, edit, delete, view, execute`,
      };
  }
  const text = result.success ? result.output : `Error: ${result.output}`;
  return { content: [{ type: "text", text }] };
}
