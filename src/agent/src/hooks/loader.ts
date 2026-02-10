/**
 * Hook Configuration Loader
 *
 * Loads and merges hook configurations from:
 * 1. Global: ~/.clawd/hooks.json
 * 2. Project: .clawd/hooks.json (overrides global)
 *
 * Resolution order:
 * - Load global config first
 * - Merge project config (project wins on conflicts)
 * - Project can disable global hooks with enabled: false
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type HooksConfig,
  type HookDefinition,
  type HookModule,
  type HookInstance,
  type HookInitContext,
  GLOBAL_HOOKS_DIR,
  GLOBAL_HOOKS_CONFIG,
  PROJECT_HOOKS_DIR,
  PROJECT_HOOKS_CONFIG,
} from "./types";

// ============================================================================
// Debug Logging
// ============================================================================

import { isDebugEnabled } from "../utils/debug";

function debugLog(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log("[Hooks]", ...args);
  }
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Load hooks.json from a path, return empty config if not found
 */
function loadConfigFile(configPath: string): HooksConfig {
  try {
    if (!existsSync(configPath)) {
      debugLog(`Config not found: ${configPath}`);
      return { hooks: [] };
    }

    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content) as HooksConfig;

    // Validate structure
    if (!Array.isArray(config.hooks)) {
      console.warn(`[Hooks] Invalid config (hooks must be array): ${configPath}`);
      return { hooks: [] };
    }

    debugLog(`Loaded ${config.hooks.length} hooks from ${configPath}`);
    return config;
  } catch (err) {
    console.warn(`[Hooks] Failed to load config ${configPath}:`, err);
    return { hooks: [] };
  }
}

/**
 * Merge project config into global config
 * Project hooks override global hooks with same name
 * Project can disable global hooks with enabled: false
 */
function mergeConfigs(globalConfig: HooksConfig, projectConfig: HooksConfig): HookDefinition[] {
  // Build map of global hooks by name
  const hookMap = new Map<string, HookDefinition & { order: number }>();
  let order = 0;

  for (const hook of globalConfig.hooks) {
    hookMap.set(hook.name, { ...hook, order: order++ });
  }

  // Merge project hooks (override or add)
  for (const hook of projectConfig.hooks) {
    const existing = hookMap.get(hook.name);
    if (existing) {
      // Merge configs (project overrides)
      hookMap.set(hook.name, {
        ...existing,
        ...hook,
        // Deep merge config objects
        config: { ...existing.config, ...hook.config },
        // Keep original order unless it's a new hook
        order: existing.order,
      });
      debugLog(`Merged project config for hook: ${hook.name}`);
    } else {
      // New hook from project
      hookMap.set(hook.name, { ...hook, order: order++ });
      debugLog(`Added project hook: ${hook.name}`);
    }
  }

  // Sort by order and return
  return Array.from(hookMap.values())
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...hook }) => hook);
}

// ============================================================================
// Hook Module Loading
// ============================================================================

/**
 * Try to load a hook module from directory
 * Returns null if not found or invalid
 */
async function loadHookModule(hookName: string, hookDir: string): Promise<HookModule | null> {
  const indexPath = join(hookDir, hookName, "index.js");

  try {
    if (!existsSync(indexPath)) {
      debugLog(`Hook module not found: ${indexPath}`);
      return null;
    }

    // Dynamic import of the hook module
    const modulePath = resolve(indexPath);
    const module = await import(modulePath);

    // Handle both default export and direct export
    const hookModule: HookModule = module.default || module;

    // Validate required properties
    if (typeof hookModule.handle !== "function") {
      console.warn(`[Hooks] Hook ${hookName} missing required handle() function`);
      return null;
    }

    debugLog(`Loaded hook module: ${hookName} from ${hookDir}`);
    return hookModule;
  } catch (err) {
    console.warn(`[Hooks] Failed to load hook module ${hookName}:`, err);
    return null;
  }
}

// ============================================================================
// Main Loader
// ============================================================================

export interface LoadHooksOptions {
  projectRoot: string;
  agentId?: string;
}

/**
 * Load all enabled hooks from global and project configs
 * Returns array of initialized hook instances, sorted by declaration order
 */
export async function loadHooks(options: LoadHooksOptions): Promise<HookInstance[]> {
  const { projectRoot, agentId } = options;
  const hooks: HookInstance[] = [];

  // Load configurations
  const globalConfig = loadConfigFile(GLOBAL_HOOKS_CONFIG);
  const projectConfigPath = join(projectRoot, PROJECT_HOOKS_CONFIG);
  const projectConfig = loadConfigFile(projectConfigPath);

  // Merge configs (project overrides global)
  const mergedHooks = mergeConfigs(globalConfig, projectConfig);

  debugLog(`Processing ${mergedHooks.length} merged hook definitions`);

  // Load each enabled hook
  for (let i = 0; i < mergedHooks.length; i++) {
    const hookDef = mergedHooks[i];

    // Skip disabled hooks
    if (!hookDef.enabled) {
      debugLog(`Skipping disabled hook: ${hookDef.name}`);
      continue;
    }

    // Try to load module (project first, then global)
    const projectHookDir = join(projectRoot, PROJECT_HOOKS_DIR);
    const globalHookDir = GLOBAL_HOOKS_DIR;

    let module = await loadHookModule(hookDef.name, projectHookDir);
    let source: "global" | "project" = "project";

    if (!module) {
      module = await loadHookModule(hookDef.name, globalHookDir);
      source = "global";
    }

    if (!module) {
      console.warn(`[Hooks] Hook ${hookDef.name} enabled but module not found`);
      continue;
    }

    // Initialize the hook
    const initContext: HookInitContext = {
      config: hookDef.config || {},
      agentId,
      projectRoot,
    };

    try {
      await module.init?.(initContext);
      debugLog(`Initialized hook: ${hookDef.name}`);
    } catch (err) {
      console.warn(`[Hooks] Hook ${hookDef.name} init failed:`, err);
      continue;
    }

    // Add to loaded hooks
    hooks.push({
      name: hookDef.name,
      config: hookDef.config || {},
      events: hookDef.events || [],
      module,
      source,
      order: i,
    });
  }

  debugLog(`Loaded ${hooks.length} hooks`);
  return hooks;
}

/**
 * Unload all hooks (call destroy on each)
 */
export async function unloadHooks(hooks: HookInstance[]): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook.module.destroy?.();
      debugLog(`Destroyed hook: ${hook.name}`);
    } catch (err) {
      console.warn(`[Hooks] Hook ${hook.name} destroy failed:`, err);
    }
  }
}
