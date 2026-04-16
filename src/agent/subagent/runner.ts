/**
 * Sub-Agent System - Spawn Recursive Agents with Full Capabilities
 *
 * Uses AgenticLoop for core loop logic, adds:
 * - Recursive sub-agent spawning
 * - Depth-limited nesting
 * - Plugin inheritance
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Message, ToolCall, ToolDefinition } from "../api/client";
import { createProvider } from "../api/factory";
import type { LLMProvider } from "../api/providers";
import {
  AgenticLoop,
  type CompletionProvider,
  formatToolResult,
  parseToolArguments,
  type ToolExecutionResult,
  type ToolExecutor,
} from "../core/loop";
import { executeTool, toolDefinitions } from "../tools/definitions";
import { type PluginContext, type SubAgentPlugin, SubAgentPluginManager, type ToolResultInfo } from "./plugin";

// ============================================================================
// Types
// ============================================================================

export type SubAgentStatus = "created" | "running" | "waiting" | "completed" | "failed" | "aborted";

export interface SubAgentConfig {
  name?: string;
  /** Provider type (e.g., "copilot", "openai", "anthropic"). Uses parent's provider if set. */
  provider?: string;
  model?: string;
  systemPrompt?: string;
  maxIterations?: number;
  allowSubAgents?: boolean;
  parentId?: string;
  depth?: number;
  plugins?: SubAgentPlugin[];
  // Tool restriction options
  toolCategory?: "read-only" | "write" | "full";
  allowedTools?: string[];
  deniedTools?: string[];
}

export interface SubAgentResult {
  agentId: string;
  success: boolean;
  result?: string;
  error?: string;
  iterations: number;
  toolCalls: number;
  subAgentsSpawned: number;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_DEPTH = 3;

// Tool category presets for restricting sub-agent capabilities
export const TOOL_CATEGORIES: Record<string, string[] | null> = {
  "read-only": ["view", "grep", "glob", "git_log", "git_diff", "git_status", "git_show", "git_branch", "git_fetch"],
  write: ["view", "grep", "glob", "edit", "create", "git_add", "git_commit", "git_status", "git_diff", "git_log"],
  full: null, // No filtering - all tools available
};

// ============================================================================
// Completion Provider (Non-Streaming)
// ============================================================================

class SubAgentCompletionProvider implements CompletionProvider {
  constructor(private provider: LLMProvider) {}

  async complete(messages: Message[], tools: ToolDefinition[], model: string) {
    const response = await this.provider.complete({
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    });

    const message = response.choices?.[0]?.message;
    if (!message) {
      throw new Error("No message in response");
    }

    return { message, response };
  }
}

// ============================================================================
// Tool Executor with Sub-Agent Support
// ============================================================================

class SubAgentToolExecutor implements ToolExecutor {
  private subAgent: SubAgent;
  private config: SubAgentConfig;

  constructor(subAgent: SubAgent, config: SubAgentConfig = {}) {
    this.subAgent = subAgent;
    this.config = config;
  }

  getTools(): ToolDefinition[] {
    let tools = [...toolDefinitions];

    // Apply tool filtering based on config
    tools = this.filterTools(tools);

    if (this.subAgent.allowSubAgents) {
      tools.push(
        {
          type: "function",
          function: {
            name: "spawn_agent",
            description:
              "Spawn a sub-agent to handle a task asynchronously. The sub-agent works independently — you do NOT need to wait for it. Continue with other work immediately after spawning. The sub-agent will report back via chat when complete. Use list_agents(type='running') to check status, or get_agent_report(agent_id) to read results.",
            parameters: {
              type: "object",
              properties: {
                task: {
                  type: "string",
                  description: "The task for the sub-agent",
                },
                name: {
                  type: "string",
                  description: "Optional name for tracking",
                },
                toolCategory: {
                  type: "string",
                  description:
                    "Tool preset: 'read-only' (view/grep/glob/git_log), 'write' (includes edit/create), 'full' (all tools)",
                  enum: ["read-only", "write", "full"],
                },
                allowedTools: {
                  type: "array",
                  items: { type: "string" },
                  description: "Whitelist of specific tools to allow (overrides toolCategory)",
                },
                deniedTools: {
                  type: "array",
                  items: { type: "string" },
                  description: "Blacklist of tools to deny",
                },
              },
              required: ["task"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "list_agents",
            description: "List all spawned sub-agents and their status. Useful before using kill_agent.",
            parameters: { type: "object", properties: {} },
          },
        },
      );
    }

    return tools;
  }

  private filterTools(tools: ToolDefinition[]): ToolDefinition[] {
    const { toolCategory, allowedTools, deniedTools } = this.config;

    // Priority 1: Explicit allowlist
    if (allowedTools && allowedTools.length > 0) {
      tools = tools.filter((t) => allowedTools.includes(t.function.name));
    }
    // Priority 2: Tool category preset
    else if (toolCategory && TOOL_CATEGORIES[toolCategory]) {
      const categoryTools = TOOL_CATEGORIES[toolCategory];
      if (categoryTools !== null) {
        tools = tools.filter((t) => categoryTools.includes(t.function.name));
      }
    }

    // Priority 3: Denylist (applied after allowlist/category)
    if (deniedTools && deniedTools.length > 0) {
      tools = tools.filter((t) => !deniedTools.includes(t.function.name));
    }

    return tools;
  }

  async execute(toolCall: ToolCall): Promise<ToolExecutionResult> {
    const name = toolCall.function.name;
    const { args, error } = parseToolArguments(toolCall.function.arguments);

    if (error) {
      return {
        tool_call_id: toolCall.id,
        content: `Error: ${error}`,
        success: false,
      };
    }

    let content: string;
    let success = true;

    // Handle sub-agent tools
    if (name === "spawn_agent") {
      content = await this.subAgent.handleSpawnAgent(args as any);
    } else if (name === "list_agents") {
      content = this.subAgent.handleListAgents();
    } else {
      // Execute regular tools
      const result = await executeTool(toolCall);
      content = formatToolResult(result);
      success = result.success;
    }

    return { tool_call_id: toolCall.id, content, success };
  }
}

// ============================================================================
// Sub-Agent
// ============================================================================

export class SubAgent extends EventEmitter {
  readonly id: string;
  readonly parentId?: string;
  readonly name: string;
  readonly depth: number;
  readonly allowSubAgents: boolean;

  private llmProvider: LLMProvider;
  private providerType: string | undefined;
  private model: string;
  private systemPrompt: string;
  private maxIterations: number;
  private pluginManager: SubAgentPluginManager;
  private loop: AgenticLoop | null = null;
  private toolConfig: SubAgentConfig; // Store tool restriction config

  private status: SubAgentStatus = "created";
  private subAgentsSpawned = 0;
  private children: SubAgent[] = [];

  constructor(config: SubAgentConfig = {}) {
    super();
    this.id = randomUUID();
    this.parentId = config.parentId;
    this.name = config.name || `agent-${this.id.slice(0, 8)}`;
    this.providerType = config.provider;
    this.model = config.model || "claude-sonnet-4.5";
    this.maxIterations = config.maxIterations || 20;
    this.depth = config.depth || 0;
    this.pluginManager = new SubAgentPluginManager(config.plugins);
    this.allowSubAgents = config.allowSubAgents !== false && this.depth < MAX_DEPTH;
    this.toolConfig = config; // Store for filtering

    this.systemPrompt =
      config.systemPrompt ||
      `You are a helpful AI assistant capable of completing complex tasks autonomously.
You have access to tools for file operations, code execution, and more.
${this.allowSubAgents ? "You can spawn sub-agents to parallelize work." : ""}
Be concise and efficient.
If chat tools (chat_send_message) are available, you MUST use them for ALL user-facing communication. NEVER output plain text meant for users.`;

    // Use provider-agnostic factory instead of hardcoding CopilotClient.
    // This respects the parent agent's configured provider (OpenAI, Anthropic, etc.).
    this.llmProvider = createProvider(config.provider, this.model);
  }

  // ============================================================================
  // Plugin Context
  // ============================================================================

  private getPluginContext(): PluginContext {
    return {
      agentId: this.id,
      agentName: this.name,
      parentId: this.parentId,
      depth: this.depth,
      iteration: this.loop?.getIterations() || 0,
      toolCalls: this.loop?.getToolCallCount() || 0,
      status: this.status,
    };
  }

  getPlugins(): SubAgentPlugin[] {
    return this.pluginManager.getAll();
  }

  // ============================================================================
  // Run Task
  // ============================================================================

  async run(task: string): Promise<SubAgentResult> {
    this.status = "running";
    this.emit("status", this.status);

    // Create loop with providers
    const completionProvider = new SubAgentCompletionProvider(this.llmProvider);
    const toolExecutor = new SubAgentToolExecutor(this, this.toolConfig);

    this.loop = new AgenticLoop(
      {
        maxIterations: this.maxIterations,
        model: this.model,
        systemPrompt: this.systemPrompt,
      },
      completionProvider,
      toolExecutor,
      {
        onStart: async (t) => {
          await this.pluginManager.onStart(this.getPluginContext(), t);
        },
        onIteration: async (iter) => {
          this.emit("iteration", iter);
          await this.pluginManager.onIteration(this.getPluginContext(), iter);
        },
        onToolCalls: async (calls) => {
          await this.pluginManager.onToolCalls(this.getPluginContext(), calls);
        },
        onToolResult: async (name, result) => {
          const info: ToolResultInfo = {
            toolName: name,
            toolCallId: result.tool_call_id,
            success: result.success,
            output: result.content,
          };
          await this.pluginManager.onToolResults(this.getPluginContext(), [info]);
        },
        onResponse: async (content) => {
          await this.pluginManager.onResponse(this.getPluginContext(), content);
        },
        onComplete: async (loopResult) => {
          await this.pluginManager.onComplete(this.getPluginContext(), {
            success: loopResult.success,
            result: loopResult.content,
            error: loopResult.error,
            iterations: loopResult.iterations,
            toolCalls: loopResult.toolCalls,
          });
        },
        onAbort: async () => {
          await this.pluginManager.onTerminate(this.getPluginContext());
        },
      },
    );

    // Forward status events
    this.loop.on("status", (s) => {
      if (s === "waiting") this.status = "waiting";
      else if (s === "running") this.status = "running";
      this.emit("status", this.status);
    });

    // Run the loop
    const loopResult = await this.loop.run(task);

    // Map loop result to SubAgentResult
    this.status = loopResult.success ? "completed" : "failed";
    if (this.loop.isAborted()) this.status = "aborted";
    this.emit("status", this.status);

    return {
      agentId: this.id,
      success: loopResult.success,
      result: loopResult.content,
      error: loopResult.error,
      iterations: loopResult.iterations,
      toolCalls: loopResult.toolCalls,
      subAgentsSpawned: this.subAgentsSpawned,
    };
  }

  // ============================================================================
  // Sub-Agent Tool Handlers (called by ToolExecutor)
  // ============================================================================

  async handleSpawnAgent(args: {
    task: string;
    name?: string;
    toolCategory?: "read-only" | "write" | "full";
    allowedTools?: string[];
    deniedTools?: string[];
  }): Promise<string> {
    const subAgent = new SubAgent({
      name: args.name,
      provider: this.providerType, // Inherit parent's provider
      model: this.model,
      parentId: this.id,
      allowSubAgents: true,
      depth: this.depth + 1,
      maxIterations: Math.max(10, Math.floor(this.maxIterations * 0.75)),
      plugins: this.getPlugins(),
      // Pass tool restriction config to sub-agent
      toolCategory: args.toolCategory,
      allowedTools: args.allowedTools,
      deniedTools: args.deniedTools,
    });

    this.children.push(subAgent);
    this.subAgentsSpawned++;

    await this.pluginManager.onChildSpawned(this.getPluginContext(), subAgent.id, subAgent.name, args.task);

    subAgent.on("iteration", (iter) => this.emit("subagent:iteration", subAgent.id, iter));
    subAgent.on("status", (status) => this.emit("subagent:status", subAgent.id, status));

    // Always run async - fire and forget
    subAgent.run(args.task).catch(console.error);
    return JSON.stringify({
      agentId: subAgent.id,
      name: subAgent.name,
      status: "spawned",
      toolCategory: args.toolCategory || "full",
      message: "Sub-agent started. It will respond directly to the chat channel when done.",
    });
  }

  handleListAgents(): string {
    return JSON.stringify(
      this.children.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        iterations: c.loop?.getIterations() || 0,
      })),
      null,
      2,
    );
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  async terminate() {
    this.loop?.abort();

    for (const child of this.children) {
      await child.terminate();
    }

    this.status = "aborted";
    this.emit("terminated");
    this.emit("status", this.status);

    await this.pluginManager.onTerminate(this.getPluginContext());
    await this.pluginManager.destroy();

    // Close provider connections (e.g., HTTP/2 sessions).
    // Errors ignored — provider may already be closed during teardown.
    try {
      this.llmProvider.close();
    } catch {
      /* ignore close errors */
    }
  }

  isAborted(): boolean {
    return this.loop?.isAborted() || false;
  }

  getStatus(): SubAgentStatus {
    return this.status;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function spawnAgent(config?: SubAgentConfig): SubAgent {
  return new SubAgent(config);
}
