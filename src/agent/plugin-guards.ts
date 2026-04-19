/**
 * Plugin Registration Guards
 *
 * Idempotent registration helpers for optional built-in plugins.
 * Each function attempts to register the plugin and returns true on success,
 * false on failure (errors are caught and logged).
 *
 * The caller is responsible for tracking the registered state and skipping
 * subsequent calls (typically via a `_pluginRegistered` boolean flag).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrowserPlugin } from "./plugins/browser-plugin";
import { CustomToolPlugin } from "./plugins/custom-tool-plugin";
import { TunnelPlugin } from "./plugins/tunnel-plugin";
import type { ToolPlugin, ToolPluginManager } from "./tools/plugin";

/**
 * Register the tunnel plugin (tunnel_create, tunnel_destroy, tunnel_list).
 * Uses cloudflared Quick Tunnels — gracefully skips if cloudflared is unavailable.
 *
 * @returns true if registered successfully, false if failed
 */
export function tryRegisterTunnelPlugin(
  toolPluginManager: ToolPluginManager,
  verbose?: boolean,
  owner?: { channel?: string; agentId?: string },
): boolean {
  try {
    toolPluginManager.register(new TunnelPlugin(owner?.channel, owner?.agentId));
    return true;
  } catch (err: unknown) {
    if (verbose) {
      console.log(`[Agent] Tunnel plugin registration failed:`, err instanceof Error ? err.message : err);
    }
    return false;
  }
}

/**
 * Register the custom script plugin (custom_script management + discovered ct_* tools).
 * Scans {configRoot}/.clawd/tools/ for user-created custom scripts.
 *
 * @returns true if registered successfully, false if failed
 */
export function tryRegisterCustomToolPlugin(
  toolPluginManager: ToolPluginManager,
  configRoot: string | undefined,
  verbose?: boolean,
): boolean {
  try {
    const customPlugin = new CustomToolPlugin();
    toolPluginManager.register(customPlugin);

    // Discover existing custom tools and register as first-class ct_* tools
    // Use original project root for custom tools (not worktree)
    if (configRoot && configRoot !== "/" && existsSync(join(configRoot, ".clawd"))) {
      const discovered = customPlugin.getDiscoveredTools(configRoot);
      for (const tool of discovered) {
        try {
          const toolPlugin: ToolPlugin = {
            name: `custom-script-${tool.name}`,
            getTools: () => [tool],
          };
          toolPluginManager.register(toolPlugin);
        } catch (toolErr: unknown) {
          if (verbose) {
            console.log(
              `[Agent] Failed to register ct tool ${tool.name}:`,
              toolErr instanceof Error ? toolErr.message : toolErr,
            );
          }
        }
      }
    }

    return true;
  } catch (err: unknown) {
    if (verbose) {
      console.log(`[Agent] Custom tool plugin registration failed:`, err instanceof Error ? err.message : err);
    }
    return false;
  }
}

/**
 * Register the browser plugin (browser_navigate, browser_screenshot, browser_click, etc.).
 * Only enabled when config.json has "browser": true, ["channel-1", ...], or { channel: [tokens] }.
 *
 * @param channel  The channel name (used to build a unique browser agent identity).
 * @param agentId  The agent's own ID (used together with channel for uniqueness).
 * @returns true if registered successfully, false if failed
 */
export function tryRegisterBrowserPlugin(
  toolPluginManager: ToolPluginManager,
  channel: string | undefined,
  agentId: string,
  verbose?: boolean,
): boolean {
  try {
    // Use channel:agentName as browser identity — two agents in different channels
    // can share the same name, so both parts are needed for uniqueness.
    const browserAgentId = channel && agentId ? `${channel}:${agentId}` : agentId || `agent_${Date.now().toString(36)}`;
    toolPluginManager.register(new BrowserPlugin(channel, browserAgentId));
    return true;
  } catch (err: unknown) {
    if (verbose) {
      console.log(`[Agent] Browser plugin registration failed:`, err instanceof Error ? err.message : err);
    }
    return false;
  }
}
