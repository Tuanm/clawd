/**
 * Plugin System - Extensible architecture for clawd
 */

import { EventEmitter } from "node:events";
import type { AgentResult } from "../agent/agent";
import type { CopilotClient } from "../api/client";

// ============================================================================
// Plugin Types
// ============================================================================

export interface PluginContext {
  agentId: string;
  sessionId?: string;
  model: string;
  currentMessageTs?: string; // Timestamp of message being processed
  llmClient?: CopilotClient; // LLM client for plugins that need to make API calls
}

export interface PluginHooks {
  // Lifecycle hooks
  onInit?: (ctx: PluginContext) => Promise<void>;
  onShutdown?: () => Promise<void>;

  // Message hooks
  onUserMessage?: (message: string, ctx: PluginContext) => Promise<void>;
  onAgentResponse?: (response: AgentResult, ctx: PluginContext) => Promise<void>;

  // Streaming hooks
  onStreamStart?: (ctx: PluginContext) => Promise<void>;
  onStreamToken?: (token: string, ctx: PluginContext) => Promise<void>;
  onThinkingToken?: (token: string, ctx: PluginContext) => Promise<void>;
  onStreamEnd?: (content: string, ctx: PluginContext) => Promise<void>;

  // Tool hooks
  onToolCall?: (name: string, args: any, ctx: PluginContext) => Promise<void>;
  onToolResult?: (name: string, result: any, ctx: PluginContext) => Promise<void>;
  // Transform tool arguments before execution - return modified args
  transformToolArgs?: (name: string, args: any, ctx: PluginContext) => Promise<any>;

  // Interrupt hook - return new message to process, or null to continue
  checkInterrupt?: (ctx: PluginContext) => Promise<string | null>;

  // Event hooks - for streaming UI events
  onInterrupt?: (message: string, ctx: PluginContext) => Promise<void>;
  onCompaction?: (deleted: number, remaining: number, ctx: PluginContext) => Promise<void>;
  onError?: (error: string, ctx: PluginContext) => Promise<void>;

  // Pre-compaction hook - extract important info from messages about to be dropped
  beforeCompaction?: (droppedMessages: any[], ctx: PluginContext) => Promise<void>;

  // Context hook - return additional context to inject into system prompt
  getSystemContext?: (ctx: PluginContext) => Promise<string | null>;
}

export interface MCPServerSpec {
  name: string;
  url?: string;
  transport?: "http" | "stdio";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Plugin {
  name: string;
  version: string;
  description?: string;
  hooks: PluginHooks;
  // Optional: MCP servers this plugin requires
  getMcpServers?: () => MCPServerSpec[];
}

// ============================================================================
// Plugin Manager
// ============================================================================

export class PluginManager extends EventEmitter {
  private plugins = new Map<string, Plugin>();
  private context: PluginContext;

  constructor(context: PluginContext) {
    super();
    this.context = context;
  }

  // Set LLM client for plugins that need to make API calls
  setLLMClient(client: CopilotClient): void {
    this.context.llmClient = client;
  }

  // ============================================================================
  // Register Plugin
  // ============================================================================

  async register(plugin: Plugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin ${plugin.name} already registered`);
    }

    this.plugins.set(plugin.name, plugin);

    // Call init hook
    if (plugin.hooks.onInit) {
      await plugin.hooks.onInit(this.context);
    }

    this.emit("plugin:registered", plugin.name);
  }

  // ============================================================================
  // Unregister Plugin
  // ============================================================================

  async unregister(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    if (plugin.hooks.onShutdown) {
      await plugin.hooks.onShutdown();
    }

    this.plugins.delete(name);
    this.emit("plugin:unregistered", name);
  }

  // ============================================================================
  // Get MCP Servers from Plugins
  // ============================================================================

  getMcpServers(): MCPServerSpec[] {
    const servers: MCPServerSpec[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.getMcpServers) {
        servers.push(...plugin.getMcpServers());
      }
    }
    return servers;
  }

  // ============================================================================
  // Hook Executors
  // ============================================================================

  async onUserMessage(message: string): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.onUserMessage) {
        await plugin.hooks.onUserMessage(message, this.context);
      }
    }
  }

  async onAgentResponse(response: AgentResult): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.onAgentResponse) {
        await plugin.hooks.onAgentResponse(response, this.context);
      }
    }
  }

  async onStreamStart(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.onStreamStart) {
        await plugin.hooks.onStreamStart(this.context);
      }
    }
  }

  async onStreamToken(token: string): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.onStreamToken) {
        await plugin.hooks.onStreamToken(token, this.context);
      }
    }
  }

  async onThinkingToken(token: string): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.onThinkingToken) {
        await plugin.hooks.onThinkingToken(token, this.context);
      }
    }
  }

  async onStreamEnd(content: string): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.onStreamEnd) {
        await plugin.hooks.onStreamEnd(content, this.context);
      }
    }
  }

  async onToolCall(name: string, args: any): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.onToolCall) {
        await plugin.hooks.onToolCall(name, args, this.context);
      }
    }
  }

  async transformToolArgs(name: string, args: any): Promise<any> {
    let transformedArgs = args;
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.transformToolArgs) {
        transformedArgs = await plugin.hooks.transformToolArgs(name, transformedArgs, this.context);
      }
    }
    return transformedArgs;
  }

  async onToolResult(name: string, result: any): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.onToolResult) {
        await plugin.hooks.onToolResult(name, result, this.context);
      }
    }
  }

  // Check all plugins for interrupt - returns first non-null result
  async checkInterrupt(): Promise<string | null> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.checkInterrupt) {
        const result = await plugin.hooks.checkInterrupt(this.context);
        if (result) return result;
      }
    }
    return null;
  }

  async onInterrupt(message: string): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.onInterrupt) {
        await plugin.hooks.onInterrupt(message, this.context);
      }
    }
  }

  async onCompaction(deleted: number, remaining: number): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.onCompaction) {
        await plugin.hooks.onCompaction(deleted, remaining, this.context);
      }
    }
  }

  async beforeCompaction(droppedMessages: any[]): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.beforeCompaction) {
        try {
          await plugin.hooks.beforeCompaction(droppedMessages, this.context);
        } catch {
          // Ignore plugin errors during pre-compaction harvest
        }
      }
    }
  }

  async onError(error: string): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.onError) {
        await plugin.hooks.onError(error, this.context);
      }
    }
  }

  // Get system context from all plugins - concatenates all results
  async getSystemContext(): Promise<string> {
    const contexts: string[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks.getSystemContext) {
        const result = await plugin.hooks.getSystemContext(this.context);
        if (result) contexts.push(result);
      }
    }
    return contexts.join("\n");
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  getPlugin(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  listPlugins(): string[] {
    return [...this.plugins.keys()];
  }

  updateContext(updates: Partial<PluginContext>): void {
    Object.assign(this.context, updates);
  }

  async shutdown(): Promise<void> {
    for (const name of this.plugins.keys()) {
      await this.unregister(name);
    }
  }
}
