/**
 * Tool Definitions and Execution — barrel file
 *
 * Imports all domain tool modules (side effects register tools into the
 * shared registry), then re-exports the complete public API so that the
 * 17 consumers that import from "./tools/tools" continue to work unchanged.
 */

// ============================================================================
// Domain module imports — each file registers tools as a side effect
// ============================================================================
import "./file-tools";
import "./shell-tools";
import "./memory-tools";
import "./web-tools";
import "./git-tools";
import "./chat-tools";

// ============================================================================
// Re-exports from registry (shared state + utilities)
// ============================================================================
export {
  // Tool registry state
  tools,
  toolDefinitions,
  registerTool,
  // Types
  type ToolResult,
  type ToolHandler,
  // Project directories
  setProjectHash,
  getProjectHash,
  getProjectDir,
  getProjectAgentsDir,
  getProjectJobsDir,
  // Chat API state
  setCurrentAgentId,
  setCurrentChannel,
  setChatApiUrl,
  // Shell helpers
  IS_WINDOWS,
  getShellArgs,
  getSafeWindowsShell,
  stripHtmlTagBlocks,
  // Fetch helper
  toolFetch,
  // Utilities
  normalizeToolArgs,
  // Path helpers
  resolveSafePath,
  validatePath,
  isPathAllowed,
  isSensitiveFile,
  // Context helpers (re-exported from agent-context)
  getAgentContext,
  getContextAgentId,
  getContextChannel,
  getContextConfigRoot,
  // Sandbox helpers (re-exported from sandbox)
  checkSandboxBeforeExec,
  getSandboxProjectRoot,
  isSandboxEnabled,
  isSandboxReady,
  runInSandbox,
  wrapCommandForSandbox,
} from "./registry";

// Re-export additional agent-context utilities not in registry
export { runWithAgentContext } from "../utils/agent-context";

// Re-export sandbox utilities not in registry
export { enableSandbox, setSandboxProjectRoot } from "../utils/sandbox";

// Re-export sub-agent lifecycle helpers from chat-tools
export { waitForSubAgents, terminateAllSubAgents } from "./chat-tools";

// ============================================================================
// Mark read-only tools for parallel execution (post-registration)
// ============================================================================
// These tools only read state and are safe to run concurrently within a turn.
import { toolDefinitions as _td } from "./registry";

const _READ_ONLY_TOOL_NAMES = new Set([
  "today",
  "get_environment",
  "get_project_root",
  "get_system_info",
  "view",
  "grep",
  "glob",
  "chat_history_search",
  "memory_summary",
  "web_fetch",
  "web_search",
  "git_status",
  "git_diff",
  "git_log",
  "todo_read",
  "list_agents",
]);
for (const def of _td) {
  if (_READ_ONLY_TOOL_NAMES.has(def.function.name)) {
    def.readOnly = true;
  }
}

// ============================================================================
// Tool Executor
// ============================================================================

import type { ToolCall } from "../api/client";
import { getHookManager } from "../hooks/manager";
import { checkSandboxBeforeExec, normalizeToolArgs, tools, type ToolResult } from "./registry";

export async function executeTool(toolCall: ToolCall): Promise<ToolResult> {
  const sandboxErr = checkSandboxBeforeExec();
  if (sandboxErr) {
    return { success: false, output: "", error: sandboxErr };
  }

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
