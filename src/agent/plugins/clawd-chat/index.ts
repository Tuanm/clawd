/**
 * Clawd-Chat Plugin
 *
 * Integration plugin for clawd agents to work with clawd-chat server.
 *
 * This file is built to ~/.clawd/plugins/clawd-chat/index.js
 * and loaded at runtime by clawd when --plugin flag specifies type: "clawd-chat"
 *
 * Plugin config interface:
 * {
 *   type: "clawd-chat",
 *   apiUrl: string,
 *   channel: string,
 *   agentId: string,
 *   pollInterval?: number
 * }
 */

import { type ClawdChatConfig, createClawdChatPlugin, createClawdChatToolPlugin } from "./agent";
import { type ClawdChatSubAgentConfig, ClawdChatSubAgentPlugin, createClawdChatSubAgentPlugin } from "./subagent";

// Re-export for direct imports
export { createClawdChatPlugin, createClawdChatToolPlugin, type ClawdChatConfig };
export { createClawdChatSubAgentPlugin, ClawdChatSubAgentPlugin, type ClawdChatSubAgentConfig };

// Default export for runtime loading
// clawd loads plugins via: const plugin = await import(pluginPath); plugin.default.createPlugin(config)
export default {
  name: "clawd-chat",

  createPlugin(config: ClawdChatConfig) {
    // Return compound object with both Plugin (hooks/MCP) and ToolPlugin (agent-side tools)
    return {
      plugin: createClawdChatPlugin(config),
      toolPlugin: createClawdChatToolPlugin(config),
    };
  },

  createSubAgentPlugin(config: ClawdChatSubAgentConfig) {
    return createClawdChatSubAgentPlugin(config);
  },
};
