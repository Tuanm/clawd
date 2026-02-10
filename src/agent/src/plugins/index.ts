/**
 * Plugins Index - Export all plugin-related modules
 */

export { PluginManager, type Plugin, type PluginHooks, type PluginContext } from "./manager";

// Clawd-chat plugins are now in plugins/clawd-chat/
export { createClawdChatPlugin, type ClawdChatConfig } from "../../plugins/clawd-chat";
export { createClawdChatSubAgentPlugin, type ClawdChatSubAgentConfig } from "../../plugins/clawd-chat";
