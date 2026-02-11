/**
 * Autonomous Agent with Agentic Loop
 *
 * Key features:
 * - Streaming LLM responses with real-time token callbacks
 * - Session management for conversation persistence
 * - Tool execution (local + MCP)
 * - Plugin system for extensibility
 * - Context truncation to stay within token limits
 * - Hook system for tool event handling
 */

import { CopilotClient, type Message, type ToolCall, type CompletionRequest } from "../api/client";
import { getSessionManager, SessionManager, type Session } from "../session/manager";
import { CheckpointManager, type Checkpoint } from "../session/checkpoint";
import { toolDefinitions, executeTools, type ToolResult, getSandboxProjectRoot } from "../tools/tools";
import { MCPManager } from "../mcp/client";
import { estimateTokens, estimateMessagesTokens } from "../memory/memory";
import { getSkillManager } from "../skills/manager";
import { PluginManager, type Plugin } from "../plugins/manager";
import { ToolPluginManager, type ToolPlugin } from "../tools/plugin";
import { parseToolArguments, formatToolResult } from "../core/loop";
import { initializeHooks, destroyHooks } from "../hooks/manager";

// ============================================================================
// Colored Logging Helpers
// ============================================================================

const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const _RED = "\x1b[31m";
const RESET = "\x1b[0m";

const logInterrupt = (msg: string) => console.log(`${CYAN}[Interrupt] ${msg}${RESET}`);
const logSilentError = (context: string, err: any) => {
  const errMsg = err?.message || String(err);
  console.warn(`${YELLOW}[Silent Error] ${context}: ${errMsg}${RESET}`);
};

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig {
  model: string;
  systemPrompt?: string;
  additionalContext?: string; // Additional context appended to system prompt (e.g., CLAWD.md)
  maxIterations?: number;
  maxContextTokens?: number; // Auto-truncate context when exceeded
  verbose?: boolean;
  onToken?: (token: string) => void;
  onThinkingToken?: (token: string) => void; // Called for thinking/reasoning tokens
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
  onInterrupt?: (message: string) => void; // Called when interrupted
  // Token limit management
  tokenLimitWarning?: number; // Start compaction at this threshold (default: 50000)
  tokenLimitCritical?: number; // Emergency reset at this threshold (default: 70000)
  compactKeepCount?: number; // Messages to keep after compaction (default: 30)
  onCompaction?: (deleted: number, remaining: number) => void; // Called after compaction
}

export interface AgentResult {
  content: string;
  toolCalls: Array<{ name: string; args: any; result: ToolResult }>;
  iterations: number;
  contextTokens?: number;
  interrupted?: boolean; // Deprecated - agent no longer breaks on interrupt
  interruptCount?: number; // Number of interrupts handled during this run
}

export type InterruptChecker = () => Promise<string | null>; // Returns new message if interrupted

// ============================================================================
// Default System Prompt
// ============================================================================

const DEFAULT_SYSTEM_PROMPT = `You are Claw'd, an autonomous AI assistant that can execute tasks using tools.

## Available Tools
You have access to the following tools:
- **bash**: Execute shell commands (sandboxed)
- **view**: Read files or list directories
- **edit**: Edit files by replacing text
- **create**: Create new files
- **grep**: Search for patterns in files
- **glob**: Find files by pattern
- **git_status**: Show working tree status
- **git_diff**: Show changes between commits or working tree
- **git_log**: Show commit history
- **git_branch**: List, create, or delete branches
- **git_checkout**: Switch branches or restore files
- **git_add**: Stage files for commit
- **git_commit**: Record changes to the repository
- **git_push**: Push commits to remote
- **git_pull**: Fetch and merge from remote
- **git_fetch**: Download objects from remote
- **git_stash**: Stash working directory changes
- **git_reset**: Reset HEAD to specified state
- **git_show**: Show commit details
- **memory_search**: Search past conversations by keywords, time range, or role
- **memory_summary**: Get a summary of a conversation session
- **job_submit**: Run long tasks in the background
- **job_status**: Check status of background jobs
- **job_cancel**: Cancel a running job
- **job_wait**: Wait for a job to complete
- **skill_list**: List available skills
- **skill_search**: Search for relevant skills
- **skill_activate**: Load a skill to guide your work
- **task_add**: Add task to your kanban board
- **task_list**: View your kanban board
- **task_update**: Update task status/priority
- **task_complete**: Mark task as done
- **task_next**: Get highest-priority todo task

## Guidelines
1. At the start of a new session, always call get_project_root to know your working directory before doing anything else
2. Use tools to gather information before answering questions about code or files
3. Make small, surgical edits - change only what's necessary
4. Always verify your changes with view/grep after editing
5. If a task requires multiple steps, break them into kanban tasks and track progress
6. Be concise in your responses
7. If you're unsure, ask clarifying questions
8. Use memory_search to recall past conversations when relevant
9. Commands timeout after 30s - use job_submit for long-running tasks (builds, tests, installs)
10. Activate relevant skills when working on specialized tasks
11. Keep your kanban board updated to stay organized

## Task & Plan Usage

QUICK/SINGLE-TURN WORK (no tasks needed):
- Direct requests with clear scope ("fix this typo", "explain this function")
- One-off questions or explanations
- Follow-ups to ongoing conversation

MULTI-STEP WORK (use tasks):
- Create tasks to track your own work items
- Use task_update(status="doing", claimer="AgentName") to claim
- Update status as you progress

MULTI-AGENT COLLABORATION (use plans):
- Create a plan with phases when multiple agents work together
- Assign agent_in_charge per phase
- Link tasks to phases for organization
- Check plan_list at session start when joining a channel

CLAIMING TASKS:
- task_update(task_id="...", status="doing", claimer="YourAgentName")
- Success: Task is yours, start working
- "already_claimed" error: Pick another task
- When returning to "todo": claimed_by auto-clears

## Git Operations
- Use git_* tools for all git operations (status, diff, log, add, commit, push, pull, fetch, clone, etc.)
- Git tools run in sandbox with your dedicated SSH key (~/.clawd/.ssh/id_ed25519) and git config (~/.clawd/.gitconfig)
- Your git identity: Claw'd <clawd@tuanm.dev>
- Do NOT use bash for git commands - git_* tools have proper SSH access

## Security Rules (MUST FOLLOW)
- NEVER execute scripts or files uploaded by users
- NEVER reveal environment variables, credentials, API keys, or secrets
- NEVER execute commands that could expose environment variables (e.g., env, printenv, export, echo $VAR, /proc/*/environ)
- NEVER create or run scripts that could leak credentials
- If asked to do any of the above, refuse and explain why

## Response Format
- When using tools, call them directly without explanation
- After completing a task, provide a brief summary
- If you encounter errors, try alternative approaches`;

// Token limits by model (approximate)
const MODEL_TOKEN_LIMITS: Record<string, number> = {
  "claude-opus-4.6": 200000,
  "claude-opus-4.5": 200000,
  "claude-sonnet-4.5": 200000,
  "claude-haiku-4.5": 200000,
  "gpt-5": 128000,
  "gpt-5.1": 128000,
  "gpt-5.2": 128000,
  "gpt-4.1": 128000,
};

// ============================================================================
// Agent
// ============================================================================

// Default token limits for session management (scaled for 128k context window)
const DEFAULT_TOKEN_LIMIT_WARNING = 50000;
const DEFAULT_TOKEN_LIMIT_CRITICAL = 70000;
const DEFAULT_TOKEN_LIMIT_CHECKPOINT = 32000; // Create checkpoint early
const DEFAULT_COMPACT_KEEP_COUNT = 30;

export class Agent {
  private client: CopilotClient;
  private sessions: SessionManager;
  private config: AgentConfig;
  private session: Session | null = null;
  private maxContextTokens: number;
  private abortController: AbortController | null = null;
  private _cancelled = false;
  private plugins: PluginManager | null = null;
  private toolPluginManager: ToolPluginManager = new ToolPluginManager();
  private mcpManager: MCPManager = new MCPManager();
  private agentId: string;
  private tokenLimitWarning: number;
  private tokenLimitCritical: number;
  private tokenLimitCheckpoint: number;
  private compactKeepCount: number;
  private checkpointManager: CheckpointManager | null = null;
  private currentCheckpoint: Checkpoint | null = null;
  private token: string; // Store for checkpoint manager

  constructor(token: string, config: AgentConfig) {
    this.client = new CopilotClient(token);
    this.sessions = getSessionManager(); // Use singleton to avoid db lock contention
    this.config = {
      maxIterations: 10,
      verbose: false,
      ...config,
    };
    this.maxContextTokens = config.maxContextTokens || (MODEL_TOKEN_LIMITS[config.model] || 100000) * 0.8; // 80% of model limit
    this.agentId = `agent-${Date.now()}`;
    this.token = token;
    this.tokenLimitWarning = config.tokenLimitWarning ?? DEFAULT_TOKEN_LIMIT_WARNING;
    this.tokenLimitCritical = config.tokenLimitCritical ?? DEFAULT_TOKEN_LIMIT_CRITICAL;
    this.tokenLimitCheckpoint = DEFAULT_TOKEN_LIMIT_CHECKPOINT;
    this.compactKeepCount = config.compactKeepCount ?? DEFAULT_COMPACT_KEEP_COUNT;
  }

  // ============================================================================
  // Token Management
  // ============================================================================

  /**
   * Check and manage session token count mid-execution
   * Returns true if session was compacted/reset
   */
  private async checkAndCompactSession(): Promise<boolean> {
    if (!this.session) return false;

    const stats = this.sessions.getSessionStats(this.session.id);
    if (!stats) return false;

    const tokens = stats.estimatedTokens;

    // Critical: emergency reset (but create checkpoint first)
    if (tokens >= this.tokenLimitCritical) {
      if (this.config.verbose) {
        console.log(`[Agent] ⚠️ CRITICAL: ${tokens} tokens, creating checkpoint and resetting...`);
      }
      await this.createCheckpoint();
      this.sessions.resetSession(this.session.name);
      this.config.onCompaction?.(stats.messageCount, 0);
      // Notify plugins
      if (this.plugins) {
        try {
          await this.plugins.onCompaction(stats.messageCount, 0);
        } catch (err) {
          // Ignore plugin errors
        }
      }
      return true;
    }

    // Warning: create checkpoint and compact session
    if (tokens >= this.tokenLimitWarning) {
      if (this.config.verbose) {
        console.log(`[Agent] ⚠️ WARNING: ${tokens} tokens, creating checkpoint and compacting...`);
      }
      await this.createCheckpoint();

      // Get messages that will be compacted for LLM summarization
      const allMessages = this.sessions.getMessages(this.session.id);
      const messagesToCompact = allMessages.slice(0, Math.max(0, allMessages.length - this.compactKeepCount));

      // Generate LLM summary of compacted messages (like Copilot CLI)
      let summary = `[Checkpoint ${this.checkpointManager?.getCheckpointCount() || 0} created]`;
      if (messagesToCompact.length > 0) {
        if (this.config.verbose) {
          console.log(`[Agent] 📝 Generating summary of ${messagesToCompact.length} messages...`);
        }
        summary = await this.generateCompactionSummary(messagesToCompact);
      }

      const deleted = this.sessions.compactSessionByName(this.session.name, this.compactKeepCount, summary);
      if (deleted > 0) {
        // Get fresh stats AFTER compaction to calculate accurate remaining count
        // (stats.messageCount from before may be stale if messages were added during checkpoint/summary generation)
        const postStats = this.sessions.getSessionStats(this.session.id);
        const remaining = postStats.messageCount;
        this.config.onCompaction?.(deleted, remaining);
        // Notify plugins
        if (this.plugins) {
          try {
            await this.plugins.onCompaction(deleted, remaining);
          } catch (err) {
            // Ignore plugin errors
          }
        }
        if (this.config.verbose) {
          console.log(`[Agent] Compacted: removed ${deleted} messages, kept ${remaining}`);
        }
      }
      return deleted > 0;
    }

    // Proactive: create checkpoint at lower threshold (but don't compact yet)
    if (tokens >= this.tokenLimitCheckpoint && this.checkpointManager) {
      const checkpointCount = this.checkpointManager.getCheckpointCount();
      // Create checkpoint if we haven't made one recently (every ~30K tokens)
      const tokensSinceLastCheckpoint = tokens - checkpointCount * 30000;
      if (tokensSinceLastCheckpoint >= 30000) {
        if (this.config.verbose) {
          console.log(`[Agent] 📸 Creating proactive checkpoint at ${tokens} tokens...`);
        }
        await this.createCheckpoint();
      }
    }

    return false;
  }

  /**
   * Create a checkpoint of the current session state
   */
  private async createCheckpoint(): Promise<Checkpoint | null> {
    if (!this.session || !this.checkpointManager) return null;

    try {
      const messages = this.sessions.getMessages(this.session.id);
      const checkpoint = await this.checkpointManager.createCheckpoint(messages, this.currentCheckpoint || undefined);
      this.currentCheckpoint = checkpoint;

      if (this.config.verbose) {
        console.log(`[Agent] ✅ Created checkpoint ${checkpoint.number}: ${checkpoint.title}`);
      }

      return checkpoint;
    } catch (err) {
      console.error("[Agent] Failed to create checkpoint:", err);
      return null;
    }
  }

  /**
   * Generate an LLM summary of messages being compacted (like Copilot CLI)
   */
  private async generateCompactionSummary(messages: Message[]): Promise<string> {
    try {
      // Format messages for summarization (exclude tool results, focus on content)
      const relevantMessages = messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content);

      if (relevantMessages.length === 0) {
        return `[${messages.length} messages compacted - mostly tool calls]`;
      }

      // Build conversation text for summarization
      const conversationText = relevantMessages
        .slice(0, 30) // Limit to avoid huge prompts
        .map((m) => `${m.role.toUpperCase()}: ${(m.content || "").slice(0, 500)}`)
        .join("\n\n");

      // Use LLM to generate summary
      const summaryPrompt = `Summarize this conversation in 2-3 sentences. Focus on: what was discussed, key decisions made, and any important context for continuing the conversation.

CONVERSATION:
${conversationText}

SUMMARY:`;

      // Quick non-streaming call for summary (use cheaper/faster model)
      const response = await this.client.complete({
        model: "claude-haiku-4.5",
        messages: [{ role: "user", content: summaryPrompt }],
        max_tokens: 200,
      });

      const summary = response.choices[0]?.message?.content?.trim();
      if (summary) {
        return summary;
      }
    } catch (err) {
      if (this.config.verbose) {
        console.error("[Agent] Failed to generate LLM summary:", err);
      }
    }

    // Fallback: simple heuristic summary
    const userMsgCount = messages.filter((m) => m.role === "user").length;
    const assistantMsgCount = messages.filter((m) => m.role === "assistant").length;
    const toolMsgCount = messages.filter((m) => m.role === "tool").length;
    return `[Compacted ${messages.length} messages: ${userMsgCount} user, ${assistantMsgCount} assistant, ${toolMsgCount} tool results]`;
  }

  // ============================================================================
  // Plugin Support
  // ============================================================================

  async usePlugin(plugin: Plugin | { plugin: Plugin; toolPlugin: ToolPlugin }): Promise<void> {
    // Handle compound plugin (plugin + toolPlugin)
    let mainPlugin: Plugin;
    let toolPluginInstance: ToolPlugin | null = null;

    if ("plugin" in plugin && "toolPlugin" in plugin) {
      mainPlugin = plugin.plugin;
      toolPluginInstance = plugin.toolPlugin;
    } else {
      mainPlugin = plugin;
    }

    if (!this.plugins) {
      this.plugins = new PluginManager({
        agentId: this.agentId,
        model: this.config.model,
      });
      // Provide LLM client to plugins for API calls (e.g., summarization)
      this.plugins.setLLMClient(this.client);
    }
    await this.plugins.register(mainPlugin);

    // Register tool plugin if provided
    if (toolPluginInstance) {
      this.toolPluginManager.register(toolPluginInstance);
    }

    // Add MCP servers provided by this plugin
    if (mainPlugin.getMcpServers) {
      const servers = mainPlugin.getMcpServers();
      for (const server of servers) {
        try {
          await this.mcpManager.addServer({
            name: server.name,
            url: server.url,
            transport: server.transport || "http",
          });
        } catch (err: any) {
          console.error(`[Plugin] Failed to add MCP server ${server.name}: ${err.message}`);
        }
      }
    }
  }

  async removePlugin(name: string): Promise<void> {
    if (this.plugins) {
      await this.plugins.unregister(name);
    }
  }

  getPluginManager(): PluginManager | null {
    return this.plugins;
  }

  // ============================================================================
  // Abort/Interrupt
  // ============================================================================

  abort(): void {
    this.abortController?.abort();
  }

  /** Cancel the current run entirely (abort + stop the agentic loop) */
  cancel(): void {
    this._cancelled = true;
    this.abortController?.abort();
  }

  isRunning(): boolean {
    return this.abortController !== null && !this.abortController.signal.aborted;
  }

  // ============================================================================
  // Get Tools (including MCP)
  // ============================================================================

  private getTools() {
    const tools = [...toolDefinitions];

    // Add MCP tools
    const mcpTools = this.mcpManager.getToolDefinitions();
    tools.push(...mcpTools);

    // Add plugin tools (from ToolPlugin interface)
    const pluginTools = this.toolPluginManager.getToolDefinitions();
    tools.push(...pluginTools);

    return tools;
  }

  /**
   * Execute a single tool call (used for interruptible execution)
   */
  private async executeSingleToolCall(toolCall: ToolCall): Promise<{ args: Record<string, any>; result: ToolResult }> {
    const { args, error: parseError } = parseToolArguments(toolCall.function.arguments);

    if (parseError) {
      return {
        args: {},
        result: { success: false, output: "", error: parseError },
      };
    }

    // Allow plugins to transform tool arguments before execution
    const transformedArgs = this.plugins ? await this.plugins.transformToolArgs(toolCall.function.name, args) : args;

    let result: ToolResult;

    if (toolCall.function.name.startsWith("mcp_")) {
      // MCP tool
      const mcpResult = await this.mcpManager.executeMCPTool(toolCall.function.name, transformedArgs);
      result = {
        success: mcpResult.success,
        output: mcpResult.success ? JSON.stringify(mcpResult.result) : "",
        error: mcpResult.error,
      };
    } else if (this.toolPluginManager.hasPluginTool(toolCall.function.name)) {
      // Plugin tool (from ToolPlugin interface)
      const pluginResult = await this.toolPluginManager.executeTool(toolCall.function.name, transformedArgs, {
        agentId: this.agentId,
        cwd: getSandboxProjectRoot(),
      });
      result = pluginResult || {
        success: false,
        output: "",
        error: "Plugin tool returned null",
      };
    } else {
      // Local tool - execute single tool
      const transformedToolCall: ToolCall = {
        ...toolCall,
        function: {
          ...toolCall.function,
          arguments: JSON.stringify(transformedArgs),
        },
      };
      const localResults = await executeTools([transformedToolCall]);
      result = localResults.get(toolCall.id) || {
        success: false,
        output: "",
        error: "Tool not found",
      };
    }

    return { args: transformedArgs, result };
  }

  // ============================================================================
  // Skills - Lazy Loading with Metadata Summary
  // ============================================================================

  /**
   * Get skills metadata summary for the system prompt.
   * Only includes skill names and descriptions -- NOT full content.
   * Agents use skill_activate tool to load full content on demand.
   */
  private getSkillsSummaryForPrompt(): string {
    try {
      const manager = getSkillManager();
      const summary = manager.getSkillsSummary();
      if (!summary) return "";
      return `\n\n${summary}`;
    } catch {
      return "";
    }
  }

  // ============================================================================
  // Truncate Context
  // ============================================================================

  private truncateContext(messages: Message[]): Message[] {
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    let totalTokens = systemMessage ? estimateTokens(systemMessage.content || "") : 0;
    const result: Message[] = systemMessage ? [systemMessage] : [];

    // Always keep the last user message
    const lastUserIdx = nonSystemMessages.findLastIndex((m) => m.role === "user");

    // Process from newest to oldest, but respect tool call/result pairs
    const toKeep: Message[] = [];
    let i = nonSystemMessages.length - 1;

    while (i >= 0) {
      const msg = nonSystemMessages[i];

      // If this is a tool result, we need to find and include the corresponding
      // assistant message with tool_calls
      if (msg.role === "tool" && msg.tool_call_id) {
        // Find the assistant message that contains this tool call
        let toolCallMsgIdx = -1;
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = nonSystemMessages[j];
          if (prevMsg.role === "assistant" && prevMsg.tool_calls) {
            const hasToolCall = prevMsg.tool_calls.some((tc) => tc.id === msg.tool_call_id);
            if (hasToolCall) {
              toolCallMsgIdx = j;
              break;
            }
          }
        }

        if (toolCallMsgIdx === -1) {
          // No matching tool_call found - skip this orphan tool result
          i--;
          continue;
        }

        // Collect all messages from toolCallMsgIdx to i (inclusive)
        // This includes the assistant message and all tool results
        const groupMessages = nonSystemMessages.slice(toolCallMsgIdx, i + 1);
        const groupTokens = estimateMessagesTokens(groupMessages);

        if (totalTokens + groupTokens > this.maxContextTokens) {
          // Can't fit this group - stop here unless we must keep last user msg
          if (i >= lastUserIdx) {
            // Force keep even if over limit
            toKeep.unshift(...groupMessages);
            totalTokens += groupTokens;
          }
          break;
        }

        toKeep.unshift(...groupMessages);
        totalTokens += groupTokens;
        i = toolCallMsgIdx - 1; // Move past the group
        continue;
      }

      // Regular message (user or assistant without pending tool results after it)
      const msgTokens = estimateMessagesTokens([msg]);

      if (totalTokens + msgTokens > this.maxContextTokens) {
        // If we haven't kept the last user message yet, force it
        if (i >= lastUserIdx) {
          toKeep.unshift(msg);
          totalTokens += msgTokens;
        }
        break;
      }

      toKeep.unshift(msg);
      totalTokens += msgTokens;
      i--;
    }

    result.push(...toKeep);

    if (this.config.verbose && toKeep.length < nonSystemMessages.length) {
      console.log(
        `[Agent] Context truncated: ${nonSystemMessages.length} -> ${toKeep.length} messages (${totalTokens} tokens)`,
      );
    }

    // Ensure at least one user message exists (API requires it)
    if (!result.some((m) => m.role === "user") && nonSystemMessages.length > 0) {
      // Find the last user message and force include it
      const lastUserMsg = nonSystemMessages.findLast((m) => m.role === "user");
      if (lastUserMsg) {
        result.push(lastUserMsg);
      }
    }

    // Final validation: ensure all tool_calls have matching tool_results
    return this.validateToolCallPairs(result);
  }

  /**
   * Validate that all tool_calls have matching tool_results and vice versa
   */
  private validateToolCallPairs(messages: Message[]): Message[] {
    // API requires:
    // 1. Every assistant message with tool_calls must be IMMEDIATELY followed by tool results for ALL those tool_calls
    // 2. Every tool result must have a matching tool_use in the PREVIOUS assistant message

    const result: Message[] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];

      // Skip orphan tool results at the start or after non-assistant messages
      if (msg.role === "tool") {
        // Check if previous result message is an assistant with this tool_call
        const prevMsg = result.length > 0 ? result[result.length - 1] : null;
        if (!prevMsg || prevMsg.role !== "assistant" || !prevMsg.tool_calls) {
          logSilentError("Orphan tool_result (no preceding assistant)", msg.tool_call_id);
          i++;
          continue;
        }
        // Check if this tool_call_id exists in the previous assistant's tool_calls
        const hasMatchingToolCall = prevMsg.tool_calls.some((tc) => tc.id === msg.tool_call_id);
        if (!hasMatchingToolCall) {
          logSilentError("Orphan tool_result (no matching tool_call)", msg.tool_call_id);
          i++;
          continue;
        }
        // Valid tool result - keep it
        result.push(msg);
        i++;
        continue;
      }

      // If this is an assistant message with tool_calls
      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        const expectedToolCallIds = new Set(msg.tool_calls.map((tc) => tc.id));
        const foundToolCallIds = new Set<string>();

        // Look ahead to find immediately following tool results
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") {
          const toolMsg = messages[j];
          if (toolMsg.tool_call_id && expectedToolCallIds.has(toolMsg.tool_call_id)) {
            foundToolCallIds.add(toolMsg.tool_call_id);
          }
          j++;
        }

        // Check if all tool_calls have results
        const missingResults = [...expectedToolCallIds].filter((id) => !foundToolCallIds.has(id));

        if (missingResults.length > 0) {
          logSilentError(`Found ${missingResults.length} tool_calls without results`, missingResults.join(", "));

          // Keep only tool_calls that have matching results
          const validToolCalls = msg.tool_calls.filter((tc) => foundToolCallIds.has(tc.id));

          if (validToolCalls.length > 0) {
            // Keep assistant message with only valid tool_calls
            result.push({ ...msg, tool_calls: validToolCalls });
            // Keep only matching tool results
            for (let k = i + 1; k < j; k++) {
              const toolMsg = messages[k];
              if (toolMsg.tool_call_id && foundToolCallIds.has(toolMsg.tool_call_id)) {
                result.push(toolMsg);
              }
            }
          } else if (msg.content) {
            // No valid tool_calls - keep just the content
            result.push({ ...msg, tool_calls: undefined });
          }
          // Skip processed messages
          i = j;
          continue;
        }

        // All tool_calls have results - keep assistant and valid tool results
        result.push(msg);
        for (let k = i + 1; k < j; k++) {
          const toolMsg = messages[k];
          // Only keep tool results that match this assistant's tool_calls
          if (toolMsg.tool_call_id && expectedToolCallIds.has(toolMsg.tool_call_id)) {
            result.push(toolMsg);
          } else {
            logSilentError("Skipping extra tool_result", toolMsg.tool_call_id);
          }
        }
        i = j;
        continue;
      }

      // Regular message (user, system, assistant without tool_calls) - keep it
      result.push(msg);
      i++;
    }

    // Ensure at least one user message
    if (!result.some((m) => m.role === "user")) {
      const lastUser = messages.findLast((m) => m.role === "user");
      if (lastUser) {
        result.push(lastUser);
      }
    }

    // Ensure conversation doesn't end with an assistant message (without tool_calls).
    // Some APIs require the conversation to end with a user message.
    // If it ends with an assistant message, append a continuation prompt.
    const lastResult = result[result.length - 1];
    if (lastResult && lastResult.role === "assistant" && !lastResult.tool_calls) {
      result.push({
        role: "user",
        content: "[System: Please continue with the task.]",
      });
    }

    return result;
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  startSession(name: string): Session {
    this.session = this.sessions.getOrCreateSession(name, this.config.model);

    // Initialize checkpoint manager for this session
    const sessionDir = `${process.env.HOME}/.clawd/sessions/${this.session.id}`;
    this.checkpointManager = new CheckpointManager({
      sessionId: this.session.id,
      sessionDir,
      token: this.token,
      model: this.config.model,
    });

    // Load latest checkpoint if exists
    this.currentCheckpoint = this.checkpointManager.loadLatestCheckpoint();
    if (this.currentCheckpoint && this.config.verbose) {
      console.log(`[Agent] Loaded checkpoint ${this.currentCheckpoint.number}: ${this.currentCheckpoint.title}`);
    }

    // Initialize hooks (async, but we don't wait - hooks will be ready soon)
    const projectRoot = getSandboxProjectRoot();
    initializeHooks(projectRoot, this.agentId).catch((err) => {
      if (this.config.verbose) {
        console.log(`[Agent] Hook initialization failed:`, err?.message || err);
      }
    });

    return this.session;
  }

  resumeSession(sessionId: string): Session | null {
    this.session = this.sessions.getSession(sessionId);
    return this.session;
  }

  getSession(): Session | null {
    return this.session;
  }

  // ============================================================================
  // Main Run Loop
  // ============================================================================

  async run(userMessage: string, sessionName?: string, interruptChecker?: InterruptChecker): Promise<AgentResult> {
    // Reset cancelled flag for new run
    this._cancelled = false;

    // Ensure session exists
    if (!this.session && sessionName) {
      this.startSession(sessionName);
    } else if (!this.session) {
      this.startSession(`session-${Date.now()}`);
    }

    const session = this.session!;
    const toolCallHistory: AgentResult["toolCalls"] = [];
    let iterations = 0;
    let finalContent = "";
    let contextTokens = 0;
    let interruptCount = 0; // Track number of interrupts handled

    // Abort controller created fresh at start of each iteration
    let signal: AbortSignal;

    // Update plugin context (ignore errors)
    if (this.plugins) {
      try {
        this.plugins.updateContext({ sessionId: session.id });
        await this.plugins.onUserMessage(userMessage);
      } catch {
        /* ignore */
      }
    }

    // Get conversation history - use compact mode to exclude tool calls/results
    // This keeps context focused on user/assistant dialogue without execution details
    let history: Message[] = [];
    try {
      history = this.sessions.getRecentMessagesCompact(session.id, 30, 4000);
    } catch {
      /* ignore - use empty history */
    }

    // Get skills metadata summary (lazy loading - just names/descriptions)
    const skillsSummary = this.getSkillsSummaryForPrompt();

    // Get additional context from plugins (e.g., chat history)
    let pluginContext = "";
    if (this.plugins) {
      try {
        pluginContext = await this.plugins.getSystemContext();
      } catch {
        /* ignore */
      }
    }

    // Include checkpoint context if available (preserves semantic history)
    let checkpointContext = "";
    if (this.currentCheckpoint && this.checkpointManager) {
      try {
        checkpointContext = `\n\n${this.checkpointManager.formatForContext(this.currentCheckpoint)}`;
      } catch {
        /* ignore */
      }
    }

    const systemPrompt =
      (this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT) +
      (this.config.additionalContext ? `\n\n${this.config.additionalContext}` : "") +
      checkpointContext +
      skillsSummary +
      pluginContext;

    // Build messages array
    let messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userMessage },
    ];

    // Truncate context if needed
    messages = this.truncateContext(messages);
    contextTokens = estimateMessagesTokens(messages);

    // Save user message
    this.sessions.addMessage(session.id, {
      role: "user",
      content: userMessage,
    });

    // Get tools (including MCP)
    const tools = this.getTools();

    // Check for interrupt periodically (from interruptChecker and plugins)
    // Returns true if new message was injected (should continue loop)
    let pendingInterrupt = false; // Flag to track if interrupt happened

    const checkInterrupt = async (): Promise<boolean> => {
      try {
        let newMessage: string | null = null;

        // Check provided interrupt checker
        if (interruptChecker) {
          try {
            newMessage = await interruptChecker();
          } catch {
            // Ignore interrupt checker errors
          }
        }

        // Check plugin interrupt if no message yet
        if (!newMessage && this.plugins) {
          try {
            newMessage = await this.plugins.checkInterrupt();
          } catch (err) {
            logSilentError("plugin.checkInterrupt", err);
          }
        }

        if (newMessage) {
          interruptCount++;
          pendingInterrupt = true; // Set flag before aborting
          logInterrupt(`New message received (interrupt #${interruptCount}), aborting current stream`);

          // Notify callback
          this.config.onInterrupt?.(newMessage);

          // Notify plugins of interrupt
          if (this.plugins) {
            try {
              await this.plugins.onInterrupt(newMessage);
            } catch (err) {
              logSilentError("plugin.onInterrupt", err);
            }
          }

          // Abort current stream gracefully
          this.abortController?.abort();

          // Inject new message into conversation (same format as initial message)
          const userMessage: Message = { role: "user", content: newMessage };
          messages.push(userMessage);

          // Save to session (ignore errors - message is already in messages array)
          try {
            this.sessions.addMessage(session.id, userMessage);
          } catch (err) {
            logSilentError("session.addMessage (interrupt)", err);
          }

          // Notify plugins of new user message (ignore errors)
          if (this.plugins) {
            try {
              await this.plugins.onUserMessage(newMessage);
            } catch (err) {
              logSilentError("plugin.onUserMessage", err);
            }
          }

          return true; // Message injected, continue loop
        }
        return false;
      } catch {
        // Any unexpected error - don't crash, just return false
        return false;
      }
    };

    let _needsValidation = true; // Validate on first iteration and after errors
    let emptyResponseCount = 0; // Track consecutive empty responses
    const maxEmptyResponses = 3; // Limit empty retries
    let consecutiveStreamErrors = 0; // Track consecutive stream errors for backoff
    const maxConsecutiveStreamErrors = 5; // Stop after this many consecutive stream errors

    try {
      // Agentic loop (maxIterations=0 means unlimited)
      const maxIter = this.config.maxIterations === 0 ? Infinity : this.config.maxIterations || 10;
      while (iterations < maxIter) {
        // Check if cancelled (e.g. user pressed Escape)
        if (this._cancelled) {
          break;
        }

        iterations++;

        // Create fresh abort controller for this iteration
        this.abortController = new AbortController();
        signal = this.abortController.signal;

        // Mid-execution token check - compact if approaching limits
        if (iterations > 1 && iterations % 3 === 0) {
          // Check every 3 iterations to avoid overhead
          const wasCompacted = await this.checkAndCompactSession();
          if (wasCompacted) {
            // Reload messages from session after compaction (with validation)
            const sessionMessages = this.sessions.getRecentMessagesValidated(session.id, 1000);

            // Rebuild system prompt with updated checkpoint context
            let updatedCheckpointContext = "";
            if (this.currentCheckpoint && this.checkpointManager) {
              updatedCheckpointContext = `\n\n${this.checkpointManager.formatForContext(this.currentCheckpoint)}`;
            }
            const updatedSystemPrompt =
              (this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT) +
              (this.config.additionalContext ? `\n\n${this.config.additionalContext}` : "") +
              updatedCheckpointContext +
              skillsSummary +
              pluginContext;

            messages = [{ role: "system", content: updatedSystemPrompt }, ...sessionMessages];
            contextTokens = estimateMessagesTokens(messages);
            _needsValidation = true; // Re-validate after compaction
          }
        }

        if (this.config.verbose) {
          console.log(`\n[Agent] Iteration ${iterations} (${contextTokens} tokens)`);
        }

        // Notify plugins of stream start
        if (this.plugins) {
          await this.plugins.onStreamStart();
        }

        // Validate messages array - API requires at least 1 user message
        const hasUserMessage = messages.some((m) => m.role === "user");
        if (!hasUserMessage) {
          console.error("[Agent] No user message in context - adding original message");
          messages.push({ role: "user", content: userMessage });
        }

        // ALWAYS validate tool_call/result pairs before API call
        // This is critical to prevent 400 errors from corrupted state
        messages = this.validateToolCallPairs(messages);

        // Make request
        const request: CompletionRequest = {
          model: this.config.model,
          messages,
          tools,
          tool_choice: "auto",
          stream: true,
        };

        let content = "";
        const toolCalls: ToolCall[] = [];
        let streamError: Error | null = null;

        // Stream response with abort signal
        try {
          for await (const event of this.client.stream(request, signal)) {
            // Check for interrupt every few tokens
            if (content.length % 100 === 0) {
              await checkInterrupt();
            }

            if (signal.aborted) break;

            switch (event.type) {
              case "content":
                content += event.content;
                try {
                  this.config.onToken?.(event.content!);
                  if (this.plugins) {
                    await this.plugins.onStreamToken(event.content!);
                  }
                } catch (err) {
                  logSilentError("onToken callback", err);
                }
                break;

              case "thinking":
                try {
                  this.config.onThinkingToken?.(event.content!);
                  if (this.plugins) {
                    await this.plugins.onThinkingToken(event.content!);
                  }
                } catch (err) {
                  logSilentError("onThinkingToken callback", err);
                }
                break;

              case "tool_call":
                toolCalls.push(event.toolCall!);
                break;

              case "error":
                if (!signal.aborted) {
                  // Store error but don't throw - handle after loop
                  streamError = new Error(event.error);
                }
                break;

              case "done":
                break;
            }
          }
        } catch (err: any) {
          // Ignore abort errors
          if (!signal.aborted && !err.message?.includes("aborted")) {
            streamError = err;
          }
        }

        // Notify plugins of stream end (ignore errors)
        if (this.plugins) {
          try {
            await this.plugins.onStreamEnd(content);
          } catch (err) {
            logSilentError("plugin.onStreamEnd", err);
          }
        }

        // Handle stream error - save partial content and retry with backoff
        if (streamError && !pendingInterrupt) {
          const errorMsg = streamError.message || "";
          console.error(`[Agent] Stream error: ${errorMsg}`);

          // Notify plugins of error
          if (this.plugins) {
            try {
              await this.plugins.onError(errorMsg);
            } catch (err) {
              logSilentError("plugin.onError", err);
            }
          }

          // Check if error is "prompt too long" (context overflow)
          const isPromptTooLong =
            errorMsg.includes("prompt is too long") ||
            errorMsg.includes("context_length_exceeded") ||
            (errorMsg.includes("400") && errorMsg.includes("maximum"));

          if (isPromptTooLong) {
            console.log(`\n[SessionManager] Reset session "${session.name}"\n`);

            // Emergency context reduction - reset session and keep only the latest user message
            this.sessions.resetSession(session.name);
            this.config.onCompaction?.(messages.length - 1, 0);
            // Notify plugins
            if (this.plugins) {
              try {
                await this.plugins.onCompaction(messages.length - 1, 0);
              } catch (err) {
                logSilentError("plugin.onCompaction", err);
              }
            }

            // Rebuild messages with just system prompt + latest user message
            let latestUserContent = userMessage;
            // Find the most recent user message in the array
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === "user" && messages[i].content) {
                latestUserContent = messages[i].content as string;
                break;
              }
            }

            // Update checkpoint context if available
            let updatedCheckpointContext = "";
            if (this.currentCheckpoint && this.checkpointManager) {
              updatedCheckpointContext = `\n\n${this.checkpointManager.formatForContext(this.currentCheckpoint)}`;
            }
            const updatedSystemPrompt =
              (this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT) +
              (this.config.additionalContext ? `\n\n${this.config.additionalContext}` : "") +
              updatedCheckpointContext +
              skillsSummary +
              pluginContext;

            messages = [
              { role: "system", content: updatedSystemPrompt },
              { role: "user", content: latestUserContent },
            ];
            contextTokens = estimateMessagesTokens(messages);

            console.log(
              `[Compaction] Removed ${iterations > 0 ? "old messages" : "context"}, kept latest user message`,
            );
            console.log(`[Agent] Reduced context to ${contextTokens} tokens, retrying...\n`);

            _needsValidation = true;
            continue;
          }

          // If we have partial tool calls, we must add tool_results for them
          if (toolCalls.length > 0) {
            try {
              this.sessions.addMessage(session.id, {
                role: "assistant",
                content: content || null,
                tool_calls: toolCalls,
              });
            } catch {
              /* ignore */
            }
            messages.push({
              role: "assistant",
              content: content || null,
              tool_calls: toolCalls,
            });

            // Add error tool_results for each
            for (const tc of toolCalls) {
              try {
                this.sessions.addMessage(session.id, {
                  role: "tool",
                  content: `[stream error before execution: ${errorMsg}]`,
                  tool_call_id: tc.id,
                });
              } catch {
                /* ignore */
              }
              messages.push({
                role: "tool",
                content: `[stream error before execution: ${errorMsg}]`,
                tool_call_id: tc.id,
              });
            }
          } else if (content) {
            // Save partial content if any (no tool calls)
            try {
              this.sessions.addMessage(session.id, {
                role: "assistant",
                content: `${content}\n\n[stream error: ${errorMsg}]`,
              });
            } catch {
              /* ignore */
            }
            messages.push({
              role: "assistant",
              content: `${content}\n\n[stream error: ${errorMsg}]`,
            });
          } else {
            // No content AND no tool calls - stream error before any data received.
            // We must ensure messages[] doesn't end with an assistant message,
            // otherwise the API will reject with "conversation must end with a user message".
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && lastMsg.role !== "user") {
              const recoveryMsg: Message = {
                role: "user",
                content: `[System: Stream error occurred: ${errorMsg}. Please retry your previous action.]`,
              };
              messages.push(recoveryMsg);
              try {
                this.sessions.addMessage(session.id, recoveryMsg);
              } catch {
                /* ignore */
              }
            }
          }

          // Track consecutive stream errors and apply backoff
          consecutiveStreamErrors++;

          // Check if we've hit max consecutive errors
          if (consecutiveStreamErrors >= maxConsecutiveStreamErrors) {
            console.error(
              `[Agent] ${maxConsecutiveStreamErrors} consecutive stream errors - stopping to prevent infinite loop`,
            );
            finalContent = `[Agent stopped: ${maxConsecutiveStreamErrors} consecutive stream errors. Last error: ${errorMsg}]`;
            break;
          }

          // Backoff for rate limits (30s fixed) or other errors (exponential)
          const isRateLimit = errorMsg.includes("429") || errorMsg.toLowerCase().includes("rate");
          if (isRateLimit) {
            console.log(`[Agent] Rate limited, sleeping 30s before retry...`);
            await new Promise((resolve) => setTimeout(resolve, 30000));
          } else if (consecutiveStreamErrors > 1) {
            // Exponential backoff for non-rate-limit errors: 2s, 4s, 8s, 16s
            const backoffMs = Math.min(2000 * Math.pow(2, consecutiveStreamErrors - 2), 16000);
            console.log(
              `[Agent] Stream error ${consecutiveStreamErrors}/${maxConsecutiveStreamErrors}, backing off ${backoffMs}ms...`,
            );
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }

          // Validate on retry after error
          _needsValidation = true;
          continue;
        }

        // If interrupted, save partial content/tool calls and continue with new message
        if (pendingInterrupt) {
          pendingInterrupt = false; // Reset flag
          _needsValidation = true; // Validate after interrupt

          if (toolCalls.length > 0) {
            logInterrupt(`Handling ${toolCalls.length} pending tool_calls after interrupt`);
            // Had tool calls - must add tool_results for ALL of them (API requires it)
            // Save assistant message with tool_calls
            try {
              this.sessions.addMessage(session.id, {
                role: "assistant",
                content: content || null,
                tool_calls: toolCalls,
              });
            } catch (err) {
              logSilentError("session.addMessage (interrupt toolCalls)", err);
            }
            messages.push({
              role: "assistant",
              content: content || null,
              tool_calls: toolCalls,
            });

            // Add interrupted tool_results for each tool_call
            for (const tc of toolCalls) {
              try {
                this.sessions.addMessage(session.id, {
                  role: "tool",
                  content: "[interrupted by new message]",
                  tool_call_id: tc.id,
                });
              } catch (err) {
                logSilentError("session.addMessage (interrupt toolResult)", err);
              }
              messages.push({
                role: "tool",
                content: "[interrupted by new message]",
                tool_call_id: tc.id,
              });
            }
          } else if (content) {
            logInterrupt(`Saving partial content after interrupt (${content.length} chars)`);
            // Save partial assistant response (no tool calls)
            try {
              this.sessions.addMessage(session.id, {
                role: "assistant",
                content: `${content}\n\n[interrupted by new message]`,
              });
            } catch (err) {
              logSilentError("session.addMessage (interrupt content)", err);
            }
            messages.push({
              role: "assistant",
              content: `${content}\n\n[interrupted by new message]`,
            });
          } else {
            logInterrupt(`No content or tool_calls to save after interrupt`);
          }
          logInterrupt(`Continuing loop with injected message`);
          continue; // Continue loop with injected message
        }

        // If we have content but no tool calls, we're done
        if (content.length > 0 && toolCalls.length === 0) {
          finalContent = content;
          emptyResponseCount = 0; // Reset on successful response
          consecutiveStreamErrors = 0; // Reset on successful response

          // Save assistant response
          try {
            this.sessions.addMessage(session.id, {
              role: "assistant",
              content,
            });
          } catch (err) {
            logSilentError("session.addMessage (final)", err);
          }
          break;
        }

        // If we have tool calls, execute them
        if (toolCalls.length > 0) {
          emptyResponseCount = 0; // Reset on successful response
          consecutiveStreamErrors = 0; // Reset on successful response

          // Save assistant message with tool calls
          try {
            this.sessions.addMessage(session.id, {
              role: "assistant",
              content: content || null,
              tool_calls: toolCalls,
            });
          } catch (err) {
            logSilentError("session.addMessage (toolCalls)", err);
          }

          // Add to messages for next iteration
          messages.push({
            role: "assistant",
            content: content || null,
            tool_calls: toolCalls,
          });

          // Execute tool calls one by one, checking for interrupt between each
          for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
            const toolCall = toolCalls[tcIdx];
            // Check for interrupt before each tool
            await checkInterrupt();
            if (pendingInterrupt) {
              // Interrupted during tool execution
              const remaining = toolCalls.length - tcIdx;
              logInterrupt(
                `Interrupted before tool #${tcIdx + 1}/${toolCalls.length} (${toolCall.function.name}), adding ${remaining} interrupt results`,
              );
              // Add tool_result for ALL remaining tool calls (API requires it)
              for (let j = tcIdx; j < toolCalls.length; j++) {
                const tc = toolCalls[j];
                try {
                  this.sessions.addMessage(session.id, {
                    role: "tool",
                    content: "[tool execution interrupted by new message]",
                    tool_call_id: tc.id,
                  });
                } catch (err) {
                  logSilentError("session.addMessage (tool interrupt)", err);
                }
                messages.push({
                  role: "tool",
                  content: "[tool execution interrupted by new message]",
                  tool_call_id: tc.id,
                });
              }
              break; // Exit tool loop, will handle in pendingInterrupt check
            }

            // Parse args early so we can notify onToolCall BEFORE execution
            const { args: parsedArgs } = parseToolArguments(toolCall.function.arguments);

            // Notify onToolCall BEFORE execution (so UI can show what's about to run)
            try {
              this.config.onToolCall?.(toolCall.function.name, parsedArgs || {});
            } catch (err) {
              logSilentError("onToolCall callback", err);
            }

            // Notify plugins of tool call BEFORE execution (so UI shows tool_start immediately)
            if (this.plugins) {
              try {
                await this.plugins.onToolCall(toolCall.function.name, parsedArgs || {});
              } catch (err) {
                logSilentError("plugin.onToolCall", err);
              }
            }

            // Execute single tool call
            let result: { args: Record<string, any>; result: ToolResult };
            try {
              result = await this.executeSingleToolCall(toolCall);
            } catch (toolError: any) {
              // Tool execution failed - create error result
              result = {
                args: parsedArgs || {},
                result: {
                  success: false,
                  output: "",
                  error: toolError.message || "Tool execution failed",
                },
              };
            }
            toolCallHistory.push({
              name: toolCall.function.name,
              args: result.args,
              result: result.result,
            });

            // Notify onToolResult AFTER execution
            try {
              if (this.config.verbose) {
                console.log(`[Tool] ${toolCall.function.name}(${JSON.stringify(result.args)})`);
                console.log(
                  `[Result] ${result.result.success ? "✓" : "✗"} ${(result.result.output || "").slice(0, 100)}...`,
                );
              }
              this.config.onToolResult?.(toolCall.function.name, result.result);
            } catch (err) {
              logSilentError("tool callbacks", err);
            }

            // Notify plugins of tool result AFTER execution
            if (this.plugins) {
              try {
                await this.plugins.onToolResult(toolCall.function.name, result.result);
              } catch (err) {
                logSilentError("plugin.onToolResult", err);
              }
            }

            // Format result for LLM
            const toolResultContent = formatToolResult(result.result);

            // Save tool result to session (ignore errors)
            try {
              this.sessions.addMessage(session.id, {
                role: "tool",
                content: toolResultContent,
                tool_call_id: toolCall.id,
              });
            } catch {
              /* ignore */
            }

            // Add to messages
            messages.push({
              role: "tool",
              content: toolResultContent,
              tool_call_id: toolCall.id,
            });
          }

          // If interrupted during tool execution, continue to handle it
          if (pendingInterrupt) {
            pendingInterrupt = false;
            continue;
          }

          // Update token count and truncate if needed
          try {
            contextTokens = estimateMessagesTokens(messages);
            if (contextTokens > this.maxContextTokens) {
              messages = this.truncateContext(messages);
              contextTokens = estimateMessagesTokens(messages);
            }
          } catch {
            /* ignore token estimation errors */
          }

          // Check for interrupt before next iteration
          await checkInterrupt();
          emptyResponseCount = 0; // Reset on successful tool execution
          consecutiveStreamErrors = 0; // Reset on successful tool execution

          continue;
        }

        // No content and no tool calls - check if we just completed tools
        // If we executed tools in the previous iteration, an empty response likely means "done"
        if (toolCallHistory.length > 0 && iterations > 1) {
          console.log("[Agent] Empty response after tool execution - task likely complete");
          finalContent = ""; // No final message, but task completed
          break;
        }

        // True empty response - retry with limit
        emptyResponseCount++;
        if (emptyResponseCount >= maxEmptyResponses) {
          console.error(`[Agent] ${maxEmptyResponses} consecutive empty responses - stopping`);
          finalContent = "[Agent stopped: repeated empty responses from API]";
          break;
        }
        logSilentError("Empty response", `attempt ${emptyResponseCount}/${maxEmptyResponses}`);
      }
    } finally {
      this.abortController = null;
    }

    const result: AgentResult = {
      content: finalContent,
      toolCalls: toolCallHistory,
      iterations,
      contextTokens,
      interrupted: false, // No longer breaks on interrupt, always completes
      interruptCount, // Number of interrupts handled during this run
    };

    // Notify plugins of completed response (ignore errors)
    if (this.plugins) {
      try {
        await this.plugins.onAgentResponse(result);
      } catch {
        /* ignore */
      }
    }

    return result;
  }

  // ============================================================================
  // Simple Chat (No Tools)
  // ============================================================================

  async chat(message: string): Promise<string> {
    let content = "";

    const request: CompletionRequest = {
      model: this.config.model,
      messages: [{ role: "user", content: message }],
      stream: true,
    };

    for await (const event of this.client.stream(request)) {
      if (event.type === "content") {
        content += event.content;
        this.config.onToken?.(event.content!);
      }
    }

    return content;
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  async close() {
    // Note: Async sub-agents (wait=false) are fire-and-forget.
    // We don't wait for them - they'll be orphaned when this process exits.
    // If the user wants results, they should use wait=true or check status before exiting.

    // Shutdown plugins
    if (this.plugins) {
      try {
        await this.plugins.shutdown();
      } catch {}
    }

    // Destroy tool plugins (per-agent instance, avoids stale global state)
    try {
      await this.toolPluginManager.destroy();
    } catch {}

    // Disconnect MCP servers (per-agent instance, avoids stale global state)
    try {
      await this.mcpManager.disconnectAll();
    } catch {}

    // Destroy hooks (global, reset for next agent)
    try {
      await destroyHooks();
    } catch {}

    // Close connections
    this.client.close();
    // NOTE: Do NOT close this.sessions -- it's a shared singleton
    // whose DB must stay open for the lifetime of the process
  }
}
