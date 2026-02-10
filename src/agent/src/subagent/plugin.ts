/**
 * Plugin Interface for SubAgent
 *
 * Plugins can hook into agent lifecycle events without coupling
 * the core agent code to specific implementations.
 */

import type { ToolCall } from "../api/client";

// ============================================================================
// Plugin Interface
// ============================================================================

export interface SubAgentPlugin {
  /** Unique identifier for the plugin */
  readonly name: string;

  /** Called when the agent starts a task */
  onStart?(context: PluginContext, task: string): Promise<void>;

  /** Called at the start of each iteration */
  onIteration?(context: PluginContext, iteration: number): Promise<void>;

  /** Called before executing tool calls */
  onToolCalls?(context: PluginContext, toolCalls: ToolCall[]): Promise<void>;

  /** Called after tool execution with results */
  onToolResults?(context: PluginContext, results: ToolResultInfo[]): Promise<void>;

  /** Called when agent produces a text response */
  onResponse?(context: PluginContext, content: string): Promise<void>;

  /** Called when agent completes (success or failure) */
  onComplete?(context: PluginContext, result: PluginResult): Promise<void>;

  /** Called when agent is terminated/aborted */
  onTerminate?(context: PluginContext): Promise<void>;

  /** Called when a child sub-agent is spawned */
  onChildSpawned?(context: PluginContext, childId: string, childName: string, task: string): Promise<void>;

  /** Cleanup resources */
  destroy?(): Promise<void>;
}

// ============================================================================
// Plugin Context
// ============================================================================

export interface PluginContext {
  /** Agent's unique ID */
  agentId: string;
  /** Agent's name */
  agentName: string;
  /** Parent agent ID if this is a sub-agent */
  parentId?: string;
  /** Current recursion depth */
  depth: number;
  /** Current iteration number */
  iteration: number;
  /** Total tool calls made */
  toolCalls: number;
  /** Agent status */
  status: string;
}

export interface ToolResultInfo {
  toolName: string;
  toolCallId: string;
  success: boolean;
  output?: string;
  error?: string;
}

export interface PluginResult {
  success: boolean;
  result?: string;
  error?: string;
  iterations: number;
  toolCalls: number;
}

// ============================================================================
// Plugin Manager
// ============================================================================

export class PluginManager {
  private plugins: SubAgentPlugin[] = [];

  constructor(plugins?: SubAgentPlugin[]) {
    if (plugins) {
      this.plugins = plugins;
    }
  }

  add(plugin: SubAgentPlugin): void {
    this.plugins.push(plugin);
  }

  remove(name: string): void {
    this.plugins = this.plugins.filter((p) => p.name !== name);
  }

  get(name: string): SubAgentPlugin | undefined {
    return this.plugins.find((p) => p.name === name);
  }

  getAll(): SubAgentPlugin[] {
    return [...this.plugins];
  }

  // Lifecycle hooks - call all plugins

  async onStart(context: PluginContext, task: string): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.onStart?.(context, task);
      } catch (err) {
        console.error(`Plugin ${plugin.name} onStart error:`, err);
      }
    }
  }

  async onIteration(context: PluginContext, iteration: number): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.onIteration?.(context, iteration);
      } catch (err) {
        console.error(`Plugin ${plugin.name} onIteration error:`, err);
      }
    }
  }

  async onToolCalls(context: PluginContext, toolCalls: ToolCall[]): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.onToolCalls?.(context, toolCalls);
      } catch (err) {
        console.error(`Plugin ${plugin.name} onToolCalls error:`, err);
      }
    }
  }

  async onToolResults(context: PluginContext, results: ToolResultInfo[]): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.onToolResults?.(context, results);
      } catch (err) {
        console.error(`Plugin ${plugin.name} onToolResults error:`, err);
      }
    }
  }

  async onResponse(context: PluginContext, content: string): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.onResponse?.(context, content);
      } catch (err) {
        console.error(`Plugin ${plugin.name} onResponse error:`, err);
      }
    }
  }

  async onComplete(context: PluginContext, result: PluginResult): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.onComplete?.(context, result);
      } catch (err) {
        console.error(`Plugin ${plugin.name} onComplete error:`, err);
      }
    }
  }

  async onTerminate(context: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.onTerminate?.(context);
      } catch (err) {
        console.error(`Plugin ${plugin.name} onTerminate error:`, err);
      }
    }
  }

  async onChildSpawned(context: PluginContext, childId: string, childName: string, task: string): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.onChildSpawned?.(context, childId, childName, task);
      } catch (err) {
        console.error(`Plugin ${plugin.name} onChildSpawned error:`, err);
      }
    }
  }

  async destroy(): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.destroy?.();
      } catch (err) {
        console.error(`Plugin ${plugin.name} destroy error:`, err);
      }
    }
    this.plugins = [];
  }
}
