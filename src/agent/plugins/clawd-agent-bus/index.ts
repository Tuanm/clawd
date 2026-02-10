/**
 * Clawd Agent Bus Plugin - Entry Point
 *
 * This file is built to ~/.clawd/plugins/clawd-agent-bus/index.js
 * and loaded at runtime by clawd when --plugin flag specifies type: "clawd-agent-bus"
 *
 * Plugin config interface:
 * {
 *   type: "clawd-agent-bus",
 *   agent: string,
 *   capabilities?: string[],
 *   metadata?: Record<string, any>,
 *   busDir?: string,
 *   pollInterval?: number
 * }
 *
 * Usage:
 *   clawd --plugin '{"type":"clawd-agent-bus","agent":"backend-agent","capabilities":["api","db"]}' -p "..."
 */

import { createAgentBusPlugin, type AgentBusPluginResult } from "./plugin";
import type { AgentBusConfig } from "./types";

// Re-export for direct imports
export { createAgentBusPlugin };
export type { AgentBusConfig, AgentBusPluginResult };

// Default export for runtime loading
// clawd loads plugins via: const plugin = await import(pluginPath); plugin.default.createPlugin(config)
export default {
  name: "clawd-agent-bus",

  createPlugin(config: AgentBusConfig): AgentBusPluginResult {
    if (!config.agent) {
      throw new Error(
        "[clawd-agent-bus] agent is required in plugin config. " +
          'Example: --plugin \'{"type":"clawd-agent-bus","agent":"my-agent"}\'',
      );
    }
    return createAgentBusPlugin(config);
  },
};
