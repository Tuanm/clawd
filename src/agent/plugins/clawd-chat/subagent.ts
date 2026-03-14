/**
 * Clawd Chat SubAgent Plugin
 *
 * Sends notifications to clawd-chat when sub-agents start, complete, etc.
 */

import type { ToolCall } from "../../src/api/client";
import type { PluginContext, PluginResult, SubAgentPlugin, ToolResultInfo } from "../../src/subagent/plugin";

export interface ClawdChatSubAgentConfig {
  apiUrl: string;
  channel: string;
  agentId: string;
  /** Whether to send notifications for tool calls (default: false) */
  notifyToolCalls?: boolean;
  /** Whether to send notifications for iterations (default: false) */
  notifyIterations?: boolean;
  /** Whether to send notifications for responses (default: true) */
  notifyResponses?: boolean;
}

export class ClawdChatSubAgentPlugin implements SubAgentPlugin {
  readonly name = "clawd-chat-subagent";
  private config: ClawdChatSubAgentConfig;

  constructor(config: ClawdChatSubAgentConfig) {
    this.config = {
      notifyToolCalls: false,
      notifyIterations: false,
      notifyResponses: true,
      ...config,
    };
  }

  private async sendMessage(text: string): Promise<void> {
    try {
      await fetch(`${this.config.apiUrl}/api/conversations.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: this.config.channel,
          text,
          user: `UWORKER-${this.config.agentId}`,
        }),
      });
    } catch (err) {
      // Silently fail - don't break agent execution for chat errors
      console.error("[clawd-chat-subagent] Failed to send message:", err);
    }
  }

  async onStart(context: PluginContext, task: string): Promise<void> {
    const prefix = context.parentId
      ? `Sub-agent **${context.agentName}** started (depth: ${context.depth})`
      : `Agent **${context.agentName}** started`;
    const truncatedTask = task.length > 200 ? `${task.slice(0, 200)}...` : task;
    await this.sendMessage(`${prefix}\n> ${truncatedTask}`);
  }

  async onIteration(context: PluginContext, iteration: number): Promise<void> {
    if (this.config.notifyIterations) {
      await this.sendMessage(`[${context.agentName}] Iteration ${iteration}`);
    }
  }

  async onToolCalls(context: PluginContext, toolCalls: ToolCall[]): Promise<void> {
    if (this.config.notifyToolCalls) {
      const toolNames = toolCalls.map((tc) => tc.function?.name || "unknown").join(", ");
      await this.sendMessage(`[${context.agentName}] Calling: ${toolNames}`);
    }
  }

  async onToolResults(context: PluginContext, results: ToolResultInfo[]): Promise<void> {
    // Only notify on errors
    const errors = results.filter((r) => !r.success);
    if (errors.length > 0) {
      const errorMsg = errors.map((e) => `${e.toolName}: ${e.error || "unknown error"}`).join("\n");
      await this.sendMessage(`[${context.agentName}] Tool errors:\n\`\`\`\n${errorMsg}\n\`\`\``);
    }
  }

  async onResponse(context: PluginContext, content: string): Promise<void> {
    if (this.config.notifyResponses && content.trim()) {
      const truncated = content.length > 500 ? `${content.slice(0, 500)}...` : content;
      await this.sendMessage(`[${context.agentName}]\n${truncated}`);
    }
  }

  async onComplete(context: PluginContext, result: PluginResult): Promise<void> {
    const status = result.success ? "DONE" : "FAILED";
    const summary = result.success
      ? `Completed in ${result.iterations} iterations with ${result.toolCalls} tool calls`
      : `Failed: ${result.error}`;
    await this.sendMessage(`${status} [${context.agentName}] ${summary}`);
  }

  async onTerminate(context: PluginContext): Promise<void> {
    await this.sendMessage(`[${context.agentName}] Terminated`);
  }

  async onChildSpawned(context: PluginContext, _childId: string, childName: string, task: string): Promise<void> {
    const truncatedTask = task.length > 150 ? `${task.slice(0, 150)}...` : task;
    await this.sendMessage(`[${context.agentName}] Spawned sub-agent **${childName}**\n> ${truncatedTask}`);
  }

  async destroy(): Promise<void> {
    // Nothing to cleanup
  }
}

/**
 * Factory function to create a clawd-chat sub-agent plugin
 */
export function createClawdChatSubAgentPlugin(config: ClawdChatSubAgentConfig): SubAgentPlugin {
  return new ClawdChatSubAgentPlugin(config);
}
