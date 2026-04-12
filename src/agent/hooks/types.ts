/**
 * Hook System Types
 *
 * Defines the interfaces for the hook configuration and runtime.
 * Hooks are user-defined extensions that run before/after tool calls.
 */

import { homedir } from "node:os";
import type { ToolResult } from "../tools/definitions";

// ============================================================================
// Configuration Types (from hooks.json)
// ============================================================================

/**
 * Hook configuration file schema (hooks.json)
 */
export interface HooksConfig {
  version?: number;
  hooks: HookDefinition[];
}

/**
 * Individual hook definition in hooks.json
 */
export interface HookDefinition {
  /** Unique name matching the hooks/ subdirectory */
  name: string;
  /** Whether this hook is active */
  enabled: boolean;
  /** Event patterns to trigger on (e.g., "after:edit", "before:*") */
  events: string[];
  /** Hook-specific configuration passed to init() */
  config?: Record<string, unknown>;
}

// ============================================================================
// Hook Module Interface (index.js exports)
// ============================================================================

/**
 * Interface that hook modules must implement
 * Hook modules are JavaScript files in ~/.clawd/hooks/{name}/index.js
 */
export interface HookModule {
  /** Hook name (must match directory name) */
  name: string;
  /** Semantic version */
  version?: string;

  /**
   * Called once when hook is loaded
   * Use this to initialize state, connections, etc.
   */
  init?(context: HookInitContext): Promise<void>;

  /**
   * Main event handler - called for matching events
   * This runs asynchronously and errors are caught silently
   */
  handle(event: HookEvent): Promise<void>;

  /**
   * Called when hook is being unloaded
   * Clean up resources, flush pending data, etc.
   */
  destroy?(): Promise<void>;
}

/**
 * Context passed to hook's init() function
 */
export interface HookInitContext {
  /** Configuration from hooks.json */
  config: Record<string, unknown>;
  /** Agent ID if available */
  agentId?: string;
  /** Project root directory */
  projectRoot: string;
}

// ============================================================================
// Runtime Types
// ============================================================================

/**
 * Event object passed to hook handlers
 */
export interface HookEvent {
  /** Event type (e.g., "before:edit", "after:view") */
  type: string;
  /** Tool name */
  tool: string;
  /** Phase: before or after tool execution */
  phase: "before" | "after";
  /** Tool arguments */
  params: Record<string, unknown>;
  /** Tool result (only present for 'after' events) */
  result?: ToolResult;
  /** Agent identifier */
  agentId: string;
  /** Project root path */
  projectRoot: string;
  /** Event timestamp */
  timestamp: number;
}

/**
 * Internal hook instance (loaded and ready to execute)
 */
export interface HookInstance {
  /** Hook name */
  name: string;
  /** Hook-specific config */
  config: Record<string, unknown>;
  /** Event patterns this hook listens to */
  events: string[];
  /** Loaded module */
  module: HookModule;
  /** Where this hook was loaded from */
  source: "global" | "project";
  /** Order in hooks.json (for execution ordering) */
  order: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Global hooks directory */
export const GLOBAL_HOOKS_DIR = `${homedir()}/.clawd/hooks`;

/** Global hooks config file */
export const GLOBAL_HOOKS_CONFIG = `${homedir()}/.clawd/hooks.json`;

/** Project hooks directory (relative to project root) */
export const PROJECT_HOOKS_DIR = ".clawd/hooks";

/** Project hooks config file (relative to project root) */
export const PROJECT_HOOKS_CONFIG = ".clawd/hooks.json";

/** Default timeout for hook execution (ms) */
export const HOOK_TIMEOUT_MS = 5000;
