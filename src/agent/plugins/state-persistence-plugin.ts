/**
 * State Persistence Plugin — auto-tracks files, decisions, errors
 * via existing plugin hooks. Zero tool call overhead.
 *
 * Factory pattern: returns { plugin, toolPlugin } sharing WorkingState.
 */

import { homedir } from "node:os";
import { createHash } from "crypto";
import {
  createEmptyState,
  formatForContext,
  loadWorkingState,
  saveWorkingState,
  setInception,
  trackError,
  trackFile,
  updateEnvironment,
  type WorkingState,
} from "../session/working-state";
import type { ToolPlugin } from "../tools/plugin";
import { isDebugEnabled } from "../utils/debug";
import type { Plugin, PluginContext, PluginHooks } from "./manager";

interface StatePersistenceConfig {
  contextMode: boolean;
}

export interface StatePersistencePluginResult {
  plugin: Plugin;
  toolPlugin: ToolPlugin;
  getState: () => WorkingState;
}

export function createStatePersistencePlugin(config: StatePersistenceConfig): StatePersistencePluginResult {
  let state: WorkingState = createEmptyState();
  let sessionDir = "";
  let inceptionCaptured = false;
  let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-instance tool args cache (keyed by tool name + timestamp). Module-scope
  // sharing leaked entries across agents — see audit C1.
  const toolArgsCache = new Map<string, { name: string; args: any }>();

  function debouncedSave(): void {
    if (!sessionDir) return;
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => {
      try {
        saveWorkingState(sessionDir, state);
      } catch (err) {
        console.error("[StatePersistence] Save error:", err);
      }
    }, 500);
  }

  function immediateSave(): void {
    if (!sessionDir) return;
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    try {
      saveWorkingState(sessionDir, state);
    } catch (err) {
      console.error("[StatePersistence] Save error:", err);
    }
  }

  // Extract file path from tool arguments
  function extractFilePath(name: string, args: any): string | null {
    if (!args) return null;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        return null;
      }
    }
    // Common tool arg patterns
    return args.path || args.file_path || args.filePath || args.file || null;
  }

  // Compute SHA-256 hash for content
  function hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  const hooks: PluginHooks = {
    async onInit(ctx: PluginContext) {
      if (ctx.sessionId) {
        sessionDir = `${homedir()}/.clawd/sessions/${ctx.sessionId}`;
        state = loadWorkingState(sessionDir);
      }

      // Capture environment. Use the agent's project root from
      // AsyncLocalStorage so the recorded workingDir + git branch reflect
      // the agent's tree, not the server's launch dir (which differs when
      // multiple agents run from one clawd process).
      const { getContextProjectRoot } = await import("../utils/agent-context");
      const workingDir = getContextProjectRoot();
      if (!workingDir) {
        // No agent context — skip environment capture. state-persistence is
        // an observational plugin; better to record nothing than to record
        // bogus values from the server's launch dir.
        return;
      }
      try {
        const { execSync } = require("child_process");
        const branch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
          encoding: "utf-8",
          cwd: workingDir,
        }).trim();
        updateEnvironment(state, { branch, workingDir });
      } catch {
        updateEnvironment(state, { workingDir });
      }
    },

    async onUserMessage(message: string, ctx: PluginContext) {
      // Capture inception from first user message (C22: immutable)
      if (!inceptionCaptured && !state.inception.taskDescription) {
        setInception(state, message.slice(0, 2000)); // Cap inception at 2K chars
        inceptionCaptured = true;
        immediateSave();
      }
    },

    async onToolCall(name: string, args: any, ctx: PluginContext) {
      // Cache args for lookup in onToolResult (which has no args parameter)
      const callId = `${name}-${Date.now()}`;
      toolArgsCache.set(callId, { name, args });

      // Trim old cache entries (keep last 50)
      if (toolArgsCache.size > 50) {
        const keys = [...toolArgsCache.keys()];
        for (let i = 0; i < keys.length - 50; i++) {
          toolArgsCache.delete(keys[i]);
        }
      }
    },

    async onToolResult(name: string, result: any, ctx: PluginContext) {
      if (!config.contextMode) return;

      try {
        const output = typeof result === "string" ? result : result?.output || result?.content || "";
        const isError =
          result?.error || (typeof result === "object" && result?.exitCode !== undefined && result.exitCode !== 0);

        // Track file operations
        const filePath = extractFilePathFromCache(name) || extractFilePath(name, null);

        if (filePath) {
          const status = getFileStatus(name);
          if (status) {
            const summary = deriveSummary(name, filePath);
            const lineCount = typeof output === "string" ? (output.match(/\n/g) || []).length + 1 : 0;
            trackFile(state, filePath, {
              status,
              summary,
              lineCount: status === "read" ? lineCount : undefined,
              contentHash: typeof output === "string" && output.length < 1_000_000 ? hashContent(output) : undefined,
            });
          }
        }

        // Track errors
        if (isError && typeof output === "string") {
          const errorMsg = output.slice(0, 200);
          trackError(state, `${name}: ${errorMsg}`);
        }

        debouncedSave();
      } catch (err) {
        // Graceful degradation — never crash the agent
        if (isDebugEnabled()) {
          console.error("[StatePersistence] onToolResult error:", err);
        }
      }
    },

    async getSystemContext(ctx: PluginContext) {
      if (!config.contextMode) return null;
      const formatted = formatForContext(state);
      return formatted || null;
    },

    async onCompaction(deleted: number, remaining: number, ctx: PluginContext) {
      // Save state immediately before compaction clears messages
      immediateSave();
    },

    async onShutdown() {
      immediateSave();
      toolArgsCache.clear();
    },
  };

  // Helper: extract file path from cached tool args
  function extractFilePathFromCache(name: string): string | null {
    // Find most recent cache entry matching this tool name
    for (const [, entry] of [...toolArgsCache.entries()].reverse()) {
      if (entry.name === name) {
        return extractFilePath(name, entry.args);
      }
    }
    return null;
  }

  // Map tool names to file status
  function getFileStatus(name: string): "read" | "created" | "modified" | "deleted" | null {
    switch (name) {
      case "view":
      case "Read":
      case "read_file":
        return "read";
      case "create":
      case "Create":
      case "create_file":
        return "created";
      case "edit":
      case "Edit":
      case "edit_file":
      case "write":
      case "Write":
        return "modified";
      default:
        return null;
    }
  }

  // Derive a brief summary from tool name and path
  function deriveSummary(name: string, path: string): string {
    const basename = path.split("/").pop() || path;
    switch (name) {
      case "view":
      case "Read":
      case "read_file":
        return `Read ${basename}`;
      case "create":
      case "Create":
        return `Created ${basename}`;
      case "edit":
      case "Edit":
        return `Modified ${basename}`;
      default:
        return `${name} on ${basename}`;
    }
  }

  const plugin: Plugin = {
    name: "state-persistence",
    version: "1.0.0",
    description: "Auto-tracks files, decisions, errors for context continuity",
    hooks,
  };

  const toolPlugin: ToolPlugin = {
    name: "state-persistence",
    getTools: () => [], // No tools — this is a passive observer
  };

  return {
    plugin,
    toolPlugin,
    getState: () => state,
  };
}
