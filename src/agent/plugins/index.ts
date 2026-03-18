/**
 * Plugins Index - Export all plugin-related modules
 */

// Clawd-chat plugins are now in plugins/clawd-chat/
export {
  type ClawdChatConfig,
  type ClawdChatSubAgentConfig,
  createClawdChatPlugin,
  createClawdChatSubAgentPlugin,
} from "./clawd-chat";
export { type Plugin, type PluginContext, type PluginHooks, PluginManager } from "./manager";
