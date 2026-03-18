/**
 * Hook Manager
 *
 * Manages hook lifecycle and execution:
 * - Loads hooks on startup
 * - Executes hooks for tool events (before/after)
 * - Handles async execution with timeouts
 * - Silent failure - hooks never block or crash agent
 */

import type { ToolResult } from "../tools/tools";
import { loadHooks, unloadHooks } from "./loader";
import { HOOK_TIMEOUT_MS, type HookEvent, type HookInstance } from "./types";

// ============================================================================
// Debug Logging
// ============================================================================

import { isDebugEnabled } from "../utils/debug";

function debugLog(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log("[HookManager]", ...args);
  }
}

// ============================================================================
// Event Pattern Matching
// ============================================================================

/**
 * Check if an event type matches a pattern
 * Patterns support:
 * - Exact match: "after:edit"
 * - Wildcard phase: "*:edit" (before and after)
 * - Wildcard tool: "after:*" (all tools)
 * - Full wildcard: "*:*" or "*" (all events)
 */
function matchesPattern(eventType: string, pattern: string): boolean {
  // Normalize patterns
  const normalizedPattern = pattern.includes(":") ? pattern : `*:${pattern}`;
  const [patternPhase, patternTool] = normalizedPattern.split(":");
  const [eventPhase, eventTool] = eventType.split(":");

  // Match phase
  if (patternPhase !== "*" && patternPhase !== eventPhase) {
    return false;
  }

  // Match tool
  if (patternTool !== "*" && patternTool !== eventTool) {
    return false;
  }

  return true;
}

/**
 * Check if a hook should run for an event
 */
function hookMatchesEvent(hook: HookInstance, eventType: string): boolean {
  return hook.events.some((pattern) => matchesPattern(eventType, pattern));
}

// ============================================================================
// Hook Manager Class
// ============================================================================

export class HookManager {
  private hooks: HookInstance[] = [];
  private projectRoot: string;
  private agentId: string;
  private initialized = false;

  constructor(projectRoot: string, agentId?: string) {
    this.projectRoot = projectRoot;
    this.agentId = agentId || `agent-${Date.now()}`;
  }

  /**
   * Initialize the hook manager - load all hooks
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      this.hooks = await loadHooks({
        projectRoot: this.projectRoot,
        agentId: this.agentId,
      });
      this.initialized = true;
      debugLog(`Initialized with ${this.hooks.length} hooks`);
    } catch (err) {
      console.warn("[HookManager] Failed to initialize:", err);
      this.hooks = [];
      this.initialized = true;
    }
  }

  /**
   * Destroy the hook manager - unload all hooks
   */
  async destroy(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    try {
      await unloadHooks(this.hooks);
      this.hooks = [];
      this.initialized = false;
      debugLog("Destroyed");
    } catch (err) {
      console.warn("[HookManager] Failed to destroy:", err);
    }
  }

  /**
   * Run hooks for an event - ASYNC, NON-BLOCKING, SILENT FAILURE
   *
   * This method fires and forgets - it doesn't await or return results.
   * Hooks run in declaration order (sequential for predictability).
   * Each hook has a timeout to prevent hanging.
   */
  runHooks(event: HookEvent): void {
    if (!this.initialized || this.hooks.length === 0) {
      return;
    }

    // Fire and forget
    this.executeHooksAsync(event).catch((err) => {
      debugLog(`Hook execution failed:`, err?.message || err);
    });
  }

  /**
   * Internal async execution of hooks
   */
  private async executeHooksAsync(event: HookEvent): Promise<void> {
    const matchingHooks = this.hooks.filter((h) => hookMatchesEvent(h, event.type));

    if (matchingHooks.length === 0) {
      return;
    }

    debugLog(`Running ${matchingHooks.length} hooks for ${event.type}`);

    // Execute in order (sequential for predictability, but still async from agent)
    for (const hook of matchingHooks) {
      try {
        // Race between hook execution and timeout
        await Promise.race([
          hook.module.handle(event),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Hook timeout")), HOOK_TIMEOUT_MS)),
        ]);
        debugLog(`Hook ${hook.name} completed for ${event.type}`);
      } catch (err: unknown) {
        // Silent failure - log for debugging only
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`Hook ${hook.name} failed: ${errMsg}`);
      }
    }
  }

  /**
   * Convenience method to run 'before' hooks
   */
  runBeforeHook(toolName: string, params: Record<string, unknown>): void {
    const event: HookEvent = {
      type: `before:${toolName}`,
      tool: toolName,
      phase: "before",
      params,
      agentId: this.agentId,
      projectRoot: this.projectRoot,
      timestamp: Date.now(),
    };
    this.runHooks(event);
  }

  /**
   * Convenience method to run 'after' hooks
   */
  runAfterHook(toolName: string, params: Record<string, unknown>, result: ToolResult): void {
    const event: HookEvent = {
      type: `after:${toolName}`,
      tool: toolName,
      phase: "after",
      params,
      result,
      agentId: this.agentId,
      projectRoot: this.projectRoot,
      timestamp: Date.now(),
    };
    this.runHooks(event);
  }

  /**
   * Get list of loaded hook names
   */
  getLoadedHooks(): string[] {
    return this.hooks.map((h) => h.name);
  }

  /**
   * Check if hooks are initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalHookManager: HookManager | null = null;

/**
 * Get or create the global hook manager
 * Call initialize() before using
 */
export function getHookManager(projectRoot?: string, agentId?: string): HookManager {
  if (!globalHookManager && projectRoot) {
    globalHookManager = new HookManager(projectRoot, agentId);
  }
  if (!globalHookManager) {
    // Fallback - create with cwd
    globalHookManager = new HookManager(process.cwd());
  }
  return globalHookManager;
}

/**
 * Initialize the global hook manager
 * Safe to call multiple times
 */
export async function initializeHooks(projectRoot: string, agentId?: string): Promise<HookManager> {
  if (globalHookManager) {
    // Already exists - check if we need to reinitialize
    if (!globalHookManager.isInitialized()) {
      await globalHookManager.initialize();
    }
    return globalHookManager;
  }

  globalHookManager = new HookManager(projectRoot, agentId);
  await globalHookManager.initialize();
  return globalHookManager;
}

/**
 * Destroy the global hook manager
 */
export async function destroyHooks(): Promise<void> {
  if (globalHookManager) {
    await globalHookManager.destroy();
    globalHookManager = null;
  }
}
