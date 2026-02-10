/**
 * Tool Plugin Interface
 *
 * Plugins can register additional tools and hook into tool execution
 * without coupling the core tool system to specific implementations.
 */

import type { ToolDefinition } from "../api/client";
import type { ToolResult, ToolHandler } from "./tools";

// ============================================================================
// Tool Plugin Interface
// ============================================================================

export interface ToolPlugin {
  /** Unique identifier for the plugin */
  readonly name: string;

  /**
   * Return tools provided by this plugin.
   * Called once when plugin is registered.
   */
  getTools(): ToolRegistration[];

  /**
   * Called before a tool is executed.
   * Can modify args or return early result to skip execution.
   */
  beforeExecute?(
    context: ToolContext,
    toolName: string,
    args: Record<string, any>,
  ): Promise<BeforeExecuteResult | undefined>;

  /**
   * Called after a tool is executed.
   * Can modify or replace the result.
   */
  afterExecute?(
    context: ToolContext,
    toolName: string,
    args: Record<string, any>,
    result: ToolResult,
  ): Promise<ToolResult>;

  /**
   * Called when plugin is being destroyed.
   */
  destroy?(): Promise<void>;
}

// ============================================================================
// Types
// ============================================================================

export interface ToolRegistration {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  required: string[];
  handler: ToolHandler;
}

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  items?: { type: string };
  default?: any;
}

export interface ToolContext {
  /** Agent ID if running in agent context */
  agentId?: string;
  /** Agent name if running in agent context */
  agentName?: string;
  /** Current working directory */
  cwd: string;
  /** Any additional metadata */
  metadata?: Record<string, any>;
}

export interface BeforeExecuteResult {
  /** If true, skip the actual tool execution and use this result */
  skipExecution: true;
  result: ToolResult;
}

// ============================================================================
// Tool Plugin Manager
// ============================================================================

export class ToolPluginManager {
  private plugins: Map<string, ToolPlugin> = new Map();
  private pluginTools: Map<string, { plugin: ToolPlugin; handler: ToolHandler }> = new Map();

  /**
   * Register a plugin and its tools
   */
  register(plugin: ToolPlugin): ToolDefinition[] {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin ${plugin.name} already registered`);
    }

    this.plugins.set(plugin.name, plugin);

    const definitions: ToolDefinition[] = [];
    const tools = plugin.getTools();

    for (const tool of tools) {
      this.pluginTools.set(tool.name, { plugin, handler: tool.handler });

      definitions.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: "object",
            properties: tool.parameters,
            required: tool.required,
          },
        },
      });
    }

    return definitions;
  }

  /**
   * Unregister a plugin and remove its tools
   */
  unregister(name: string): void {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    // Remove plugin's tools
    for (const [toolName, info] of this.pluginTools.entries()) {
      if (info.plugin.name === name) {
        this.pluginTools.delete(toolName);
      }
    }

    this.plugins.delete(name);
  }

  /**
   * Check if a tool is provided by a plugin
   */
  hasPluginTool(toolName: string): boolean {
    return this.pluginTools.has(toolName);
  }

  /**
   * Execute a plugin tool with lifecycle hooks
   */
  async executeTool(toolName: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult | null> {
    const toolInfo = this.pluginTools.get(toolName);
    if (!toolInfo) return null;

    // Call beforeExecute hooks on all plugins
    for (const plugin of this.plugins.values()) {
      if (plugin.beforeExecute) {
        const hookResult = await plugin.beforeExecute(context, toolName, args);
        if (hookResult?.skipExecution) {
          return hookResult.result;
        }
      }
    }

    // Execute the tool
    let result = await toolInfo.handler(args);

    // Call afterExecute hooks on all plugins
    for (const plugin of this.plugins.values()) {
      if (plugin.afterExecute) {
        result = await plugin.afterExecute(context, toolName, args, result);
      }
    }

    return result;
  }

  /**
   * Get all tool definitions from plugins
   */
  getToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];

    for (const [toolName, info] of this.pluginTools.entries()) {
      const tools = info.plugin.getTools();
      const tool = tools.find((t) => t.name === toolName);
      if (tool) {
        definitions.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: {
              type: "object",
              properties: tool.parameters,
              required: tool.required,
            },
          },
        });
      }
    }

    return definitions;
  }

  /**
   * Get all registered plugins
   */
  getPlugins(): ToolPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Destroy all plugins
   */
  async destroy(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.destroy?.();
      } catch (err) {
        console.error(`Plugin ${plugin.name} destroy error:`, err);
      }
    }
    this.plugins.clear();
    this.pluginTools.clear();
  }
}

// Note: ToolPluginManager is instantiated per-agent (as an Agent instance property)
// to avoid global state issues when agents are created/destroyed in worker loops.
