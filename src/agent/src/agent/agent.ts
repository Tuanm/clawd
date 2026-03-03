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

import type { Message, ToolCall, CompletionRequest } from "../api/client";
import { AllKeysSuspendedError } from "../api/key-pool";
import type { LLMProvider } from "../api/providers";
import { createProvider } from "../api/factory";
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
import { isDebugEnabled } from "../utils/debug";
import { getThresholds, MODEL_TOKEN_LIMITS as CENTRALIZED_MODEL_LIMITS } from "../constants/context-limits";
import { createStatePersistencePlugin } from "../plugins/state-persistence-plugin";
import { createContextModePlugin, type ContextModePluginResult } from "../plugins/context-mode-plugin";
import { WorkspaceToolPlugin } from "../plugins/workspace-plugin";
import { ContextTracker } from "../utils/context-tracker";
import { homedir } from "node:os";

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
  provider?: string; // Provider type: "copilot", "openai", "anthropic"
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
  contextMode?: boolean;
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

const DEFAULT_SYSTEM_PROMPT = `IMPORTANT: You MUST use chat_send_message tool to respond to users. Never respond with plain text.

You are Claw'd, an autonomous AI assistant that can execute tasks using tools.

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
- After completing a task, summarize results via chat_send_message (if in a chat channel)
- If you encounter errors, try alternative approaches

## Context Awareness
- When you see [TRUNCATED] markers in messages or tool output, acknowledge that only partial content is available
- If knowledge_search() is available, use it to retrieve truncated content before answering
- When a file was too large to include fully, explain what portion you can see and suggest alternatives (e.g., bash tools: head, tail, grep on the file path)
- Never assume truncated content is complete — ask the user to re-send specific sections if needed

## Workspace Tools (when spawn_workspace / list_workspaces are available)
- After spawning a workspace, **immediately** send a workspace card using chat_send_message with the workspace_json parameter (use the workspace_id returned by spawn_workspace).
- **NEVER** include URLs, paths, or internal addresses in message text — not even relative ones like /workspace/.... The workspace card handles navigation for the user.
- Use file_id values (from screenshot) with chat_send_message_with_files to share screenshots — never include local paths or base64 in messages.
- Only use workspace_id from the **most recently spawned** workspace (from the current spawn_workspace call, not from list_workspaces).

## Chat Tools (when connected to a chat channel)
You are in a chat channel. The ONLY way to communicate with humans is via chat tools.

- **chat_send_message**: Send a reply - this is the ONLY way humans see your responses
- **chat_mark_processed**: Mark message as handled (if you don't need to respond)

CRITICAL RULES:
- Humans CANNOT see your text output — they can ONLY see messages sent via chat_send_message
- ALWAYS use chat_send_message to send ANY response to users
- ALWAYS use chat_mark_processed after sending a message
- Do NOT output text intended for users — it will never reach them

Pattern for responding to users:
1. Call chat_send_message(channel, text, agent_id, user)
2. Call chat_mark_processed(channel, timestamp, agent_id)

If you don't need to respond (just acking), you can skip chat_send_message and just call chat_mark_processed.`;

// Token limits by model — use centralized module, keep local alias for existing references
const MODEL_TOKEN_LIMITS = CENTRALIZED_MODEL_LIMITS;

// ============================================================================
// Agent
// ============================================================================

// Default token limits for session management (scaled for 128k context window)
// These are the legacy fallback values; dynamic thresholds from context-limits.ts
// are used when contextMode=true.
const DEFAULT_TOKEN_LIMIT_WARNING = 50000;
const DEFAULT_TOKEN_LIMIT_CRITICAL = 70000;
const DEFAULT_TOKEN_LIMIT_CHECKPOINT = 32000;
const DEFAULT_COMPACT_KEEP_COUNT = 30;

export class Agent {
  private client: LLMProvider;
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
  private contextModePlugin: ContextModePluginResult | null = null;
  private contextTracker: ContextTracker | null = null;
  private compacting = false;
  private _workspacePluginRegistered = false;

  constructor(tokenOrProvider: string | LLMProvider, config: AgentConfig) {
    // Accept either token (legacy) or provider instance
    if (typeof tokenOrProvider === "string") {
      // Legacy mode: create provider from token with optional provider type
      const providerType = config.provider as "openai" | "anthropic" | "copilot" | undefined;
      this.client = createProvider(providerType, config.model);
      this.token = tokenOrProvider;
    } else {
      // New mode: use provided provider
      this.client = tokenOrProvider;
      this.token = ""; // No token when provider is passed directly
    }
    this.sessions = getSessionManager(); // Use singleton to avoid db lock contention
    this.config = {
      maxIterations: 10,
      verbose: false,
      ...config,
    };
    this.maxContextTokens = config.maxContextTokens || (MODEL_TOKEN_LIMITS[config.model] || 100000) * 0.8; // 80% of model limit
    this.agentId = `agent-${Date.now()}`;
    this.tokenLimitWarning = config.tokenLimitWarning ?? DEFAULT_TOKEN_LIMIT_WARNING;
    this.tokenLimitCritical = config.tokenLimitCritical ?? DEFAULT_TOKEN_LIMIT_CRITICAL;
    this.tokenLimitCheckpoint = DEFAULT_TOKEN_LIMIT_CHECKPOINT;
    this.compactKeepCount = config.compactKeepCount ?? DEFAULT_COMPACT_KEEP_COUNT;
  }

  // ============================================================================
  // Model Accessor
  // ============================================================================

  /**
   * Get the model to use for LLM requests.
   * Uses provider's model if available, otherwise falls back to config.
   */
  private getModel(): string {
    // Use provider's model if available (from config.json)
    if (this.client && "model" in this.client) {
      return (this.client as any).model;
    }
    // Fall back to config model (from CLI args)
    return this.config.model || "claude-sonnet-4.5";
  }

  // ============================================================================
  // Token Management
  // ============================================================================

  /**
   * Check and manage session token count mid-execution
   * Returns true if session was compacted/reset
   */
  private async checkAndCompactSession(): Promise<boolean> {
    if (!this.session || this.compacting) return false;
    this.compacting = true;
    try {
      return await this._doCompaction();
    } finally {
      this.compacting = false;
    }
  }

  private async _doCompaction(): Promise<boolean> {
    if (!this.session) return false;

    const stats = this.sessions.getSessionStats(this.session.id);
    if (!stats) return false;

    // Phase 2.8: Inline tool result compression (runs BEFORE threshold checks)
    // Compresses stale tool results in-place to delay compaction by 30-50%
    if (this.config.contextMode) {
      this.compressStaleToolResults();
    }

    // Re-check stats after inline compression
    const freshStats = this.config.contextMode ? this.sessions.getSessionStats(this.session.id) : stats;
    // Add overhead for system prompt + tool definitions (not stored in session DB)
    const SYSTEM_PROMPT_OVERHEAD = 12000;
    const tokens = (freshStats?.estimatedTokens ?? stats.estimatedTokens) + SYSTEM_PROMPT_OVERHEAD;

    // Critical: aggressive compaction (keep minimal context, avoid full wipe)
    if (tokens >= this.tokenLimitCritical) {
      if (this.config.verbose) {
        console.log(`[Agent] ⚠️ CRITICAL: ${tokens} tokens, creating checkpoint and compacting aggressively...`);
      }
      await this.createCheckpoint();

      // Aggressive compaction — keep last 15 messages instead of wiping everything.
      // Full reset causes the agent to lose all context and exit prematurely.
      const aggressiveKeepCount = 15;
      const summary = `[Emergency compaction — context exceeded critical limit (${tokens} tokens)]`;
      this.sessions.compactSessionByName(this.session.name, aggressiveKeepCount, summary);

      // Re-check: if still over critical after aggressive compaction, do full reset as last resort
      const postStats = this.sessions.getSessionStats(this.session.id);
      const postTokens = postStats?.estimatedTokens ?? 0;
      if (postTokens >= this.tokenLimitCritical) {
        console.log(`[Agent] Still at ${postTokens} tokens after compaction, full reset as last resort`);
        this.sessions.resetSession(this.session.name);
        // Inject recovery context
        if (this.config.contextMode && this.session) {
          try {
            const { loadWorkingState, formatForContext } = await import("../session/working-state");
            const sessionDir = `${homedir()}/.clawd/sessions/${this.session.id}`;
            const workingState = loadWorkingState(sessionDir);
            const stateContext = formatForContext(workingState);
            if (stateContext) {
              const recovery = `[Emergency checkpoint — session reset]\n${stateContext}\n[Resume from working state above. Verify file hashes before making changes.]`;
              this.sessions.addMessage(this.session.id, { role: "system", content: recovery });
            }
          } catch (err) {
            if (this.config.verbose) console.log("[Agent] Recovery context injection failed:", err);
          }
        }
      }

      const remaining = postTokens < this.tokenLimitCritical ? (postStats?.messageCount ?? 0) : 0;
      this.config.onCompaction?.(stats.messageCount, remaining);
      // Notify plugins
      if (this.plugins) {
        try {
          await this.plugins.onCompaction(stats.messageCount, remaining);
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

      if (this.config.contextMode) {
        try {
          // Smart compaction: importance-weighted selection (Phase 2)
          const { scoreMessages, fitToBudget, compressMessage, repairRoleAlternation } = await import(
            "../session/message-scoring"
          );
          const { loadWorkingState, formatForContext } = await import("../session/working-state");

          const scored = scoreMessages(allMessages);
          const thresholds = getThresholds(this.getModel(), true);
          // Budget: keep messages up to 60% of effective tokens
          const budget = Math.floor(thresholds.effective * 0.6);
          const fitted = fitToBudget(scored, budget);

          // Apply lifecycle stages
          const keptMessages: Message[] = [];
          for (const s of fitted) {
            if (s.stage === "FULL" || s.isAnchor) {
              keptMessages.push(s.message);
            } else if (s.stage === "COMPRESSED") {
              keptMessages.push(compressMessage(s.message));
            }
            // DROPPED messages are absorbed into WorkingState
          }

          // Repair role alternation
          const repaired = repairRoleAlternation(keptMessages);

          // Generate recovery summary
          const sessionDir = `${homedir()}/.clawd/sessions/${this.session.id}`;
          const workingState = loadWorkingState(sessionDir);
          const stateContext = formatForContext(workingState);

          let summary = `[Checkpoint ${this.checkpointManager?.getCheckpointCount() || 0} — smart compaction]\n`;
          if (stateContext) summary += stateContext + "\n";
          summary += `[Kept ${repaired.length} of ${allMessages.length} messages by importance score]`;

          // Delete all messages and re-insert selected ones
          this.sessions.resetSession(this.session.name);
          // Insert summary as first message
          this.sessions.addMessage(this.session.id, { role: "system", content: summary });
          // Re-insert kept messages
          for (const msg of repaired) {
            this.sessions.addMessage(this.session.id, msg);
          }

          const deleted = allMessages.length - repaired.length;
          if (deleted > 0) {
            const postStats = this.sessions.getSessionStats(this.session.id);
            const remaining = postStats.messageCount;
            this.config.onCompaction?.(deleted, remaining);
            if (this.plugins) {
              try {
                await this.plugins.onCompaction(deleted, remaining);
              } catch {}
            }
            if (this.config.verbose) {
              console.log(
                `[Agent] Smart compacted: removed ${deleted}, kept ${repaired.length} (${keptMessages.length} selected, ${repaired.length - keptMessages.length} synthetic)`,
              );
            }
          }
          return deleted > 0;
        } catch (err) {
          // C26: Graceful degradation — fall through to legacy compaction
          if (this.config.verbose) {
            console.log("[Agent] Smart compaction failed, falling back to legacy:", err);
          }
        }
      }

      // Legacy compaction: keep last N messages
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
   * Compress stale tool results in existing messages (Phase 2.8).
   * Runs before compaction threshold checks to delay compaction by 30-50%.
   * Only modifies session DB — chat.db is never touched (C1).
   */
  private compressStaleToolResults(): void {
    if (!this.session) return;
    try {
      const rows = this.sessions.getMessagesWithIds(this.session.id);
      if (rows.length < 10) return; // Too few messages to bother

      const STALE_THRESHOLD = 5; // Messages older than 5 from end
      const MIN_COMPRESS_SIZE = 4000; // Only compress if > 4KB
      const staleStart = Math.max(0, rows.length - STALE_THRESHOLD);
      let updated = 0;

      for (let i = 0; i < staleStart; i++) {
        const row = rows[i];
        if (row.role !== "tool" || !row.content) continue;
        if (row.content.length < MIN_COMPRESS_SIZE) continue;
        if (row.content.includes("[TRUNCATED")) continue; // Already compressed

        // Strip base64 content first
        let compressed = row.content.replace(/[A-Za-z0-9+/=]{500,}/g, "[base64 content stripped]");

        // If still large, use smart truncation to 20%
        if (compressed.length > MIN_COMPRESS_SIZE) {
          const { smartTruncate } = require("../utils/smart-truncation");
          compressed = smartTruncate(compressed, {
            maxLength: Math.max(200, Math.floor(compressed.length * 0.2)),
          });
        }

        if (compressed.length < row.content.length * 0.9) {
          this.sessions.updateMessageContent(this.session.id, row.id, compressed);
          updated++;
        }
      }

      if (updated > 0 && this.config.verbose) {
        console.log(`[Agent] Compressed ${updated} stale tool results`);
      }
    } catch (err) {
      // Graceful degradation — never crash (C26)
      if (this.config.verbose) {
        console.log("[Agent] Stale tool result compression failed:", err);
      }
    }
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
        model: this.getModel(),
      });
      // Provide LLM client to plugins for API calls (e.g., summarization)
      this.plugins.setLLMClient(this.client);
    }
    await this.plugins.register(mainPlugin);

    // Register tool plugin if provided
    if (toolPluginInstance) {
      this.toolPluginManager.register(toolPluginInstance);
    }

    // Add MCP servers provided by this plugin.
    // HTTP servers are awaited (they connect near-instantly to localhost).
    // stdio servers are fire-and-forget — they may take seconds/minutes to start
    // (e.g. bunx downloading a package) and must not block the agent stream.
    if (mainPlugin.getMcpServers) {
      const servers = mainPlugin.getMcpServers();
      console.log(`[Plugin] Registering ${servers.length} MCP server(s) from ${mainPlugin.name}`);
      for (const server of servers) {
        const transport = server.transport || "http";
        const addPromise = this.mcpManager
          .addServer({
            name: server.name,
            url: server.url,
            transport,
            command: server.command,
            args: server.args,
            env: server.env,
          })
          .then(() => {
            console.log(
              `[MCP] Connected to server "${server.name}"${transport === "stdio" ? ` (command: ${server.command})` : ` at ${server.url}`}`,
            );
          })
          .catch((err: any) => {
            console.error(`[Plugin] Failed to add MCP server ${server.name}: ${err.message}`);
          });

        if (transport !== "stdio") {
          // HTTP/SSE servers: wait up to 10s so their tools are available on the first LLM call
          await Promise.race([addPromise, new Promise((r) => setTimeout(r, 10_000))]);
        }
        // stdio servers run in background — agent starts immediately without waiting
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
    const toolNames = new Set(tools.map((t) => t.function.name));

    // Add MCP tools (dedupe)
    const mcpTools = this.mcpManager.getToolDefinitions();
    for (const tool of mcpTools) {
      if (!toolNames.has(tool.function.name)) {
        tools.push(tool);
        toolNames.add(tool.function.name);
      }
    }

    // Add plugin tools (dedupe)
    const pluginTools = this.toolPluginManager.getToolDefinitions();
    for (const tool of pluginTools) {
      if (!toolNames.has(tool.function.name)) {
        tools.push(tool);
        toolNames.add(tool.function.name);
      }
    }

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

    // Check if it's an MCP tool by checking if MCP manager knows about it
    if (this.mcpManager.hasTool(toolCall.function.name)) {
      // MCP tool (native names - no prefix needed)
      if (isDebugEnabled()) {
        console.log(`[Agent] Executing MCP tool: ${toolCall.function.name}`);
      }
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

    // Phase 3: Compress tool result via context mode plugin (before Layer 8 + formatToolResult)
    // Fires for ALL 3 tool branches (MCP, plugin, local). Gated behind contextMode.
    if (this.contextModePlugin) {
      try {
        const compressed = this.contextModePlugin.compressToolResult(toolCall.function.name, result);
        // Phase 4: Record compression metrics
        if (this.contextTracker) {
          const inputSize = toolCall.function.arguments?.length || 0;
          this.contextTracker.recordToolCall(
            toolCall.function.name,
            inputSize,
            compressed.originalSize,
            compressed.compressedSize,
            compressed.indexed,
          );
          if (toolCall.function.name === "knowledge_search") {
            try {
              const args = JSON.parse(toolCall.function.arguments || "{}");
              if (args.query) this.contextTracker.recordSearch(args.query);
            } catch {}
          }
        }
        result = compressed.result;
      } catch {
        // C26: graceful degradation — keep original result
      }
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
    this.session = this.sessions.getOrCreateSession(name, this.getModel());

    // Initialize checkpoint manager for this session
    const sessionDir = `${homedir()}/.clawd/sessions/${this.session.id}`;
    this.checkpointManager = new CheckpointManager({
      sessionId: this.session.id,
      sessionDir,
      token: this.token,
      model: this.getModel(),
    });

    // Load latest checkpoint if exists
    this.currentCheckpoint = this.checkpointManager.loadLatestCheckpoint();
    if (this.currentCheckpoint && this.config.verbose) {
      console.log(`[Agent] Loaded checkpoint ${this.currentCheckpoint.number}: ${this.currentCheckpoint.title}`);
    }

    // Apply dynamic thresholds when contextMode is enabled
    if (this.config.contextMode) {
      const thresholds = getThresholds(this.getModel(), true);
      this.tokenLimitWarning = thresholds.warning;
      this.tokenLimitCritical = thresholds.critical;
      this.tokenLimitCheckpoint = thresholds.checkpoint;
      if (this.config.verbose) {
        console.log(
          `[Agent] Dynamic thresholds: checkpoint=${thresholds.checkpoint}, warning=${thresholds.warning}, critical=${thresholds.critical}`,
        );
      }
    }

    // Register state persistence plugin when contextMode is enabled
    if (this.config.contextMode) {
      const statePersistence = createStatePersistencePlugin({ contextMode: true });
      this.usePlugin(statePersistence).catch((err) => {
        if (this.config.verbose) {
          console.log(`[Agent] State persistence plugin failed:`, err?.message || err);
        }
      });
    }

    // Register context mode plugin (FTS5 knowledge base + compression) when contextMode is enabled
    if (this.config.contextMode && this.session) {
      try {
        const sessionDir = `${homedir()}/.clawd/sessions/${this.session.id}`;
        this.contextModePlugin = createContextModePlugin({
          sessionId: this.session.id,
          sessionDir,
          onCompactRequest: async () => {
            // Prevent concurrent compaction
            if (this.compacting) {
              return { before: 0, after: 0 };
            }
            const beforeTokens = this.session ? estimateMessagesTokens(this.sessions.getMessages(this.session.id)) : 0;
            await this.checkAndCompactSession();
            const afterTokens = this.session ? estimateMessagesTokens(this.sessions.getMessages(this.session.id)) : 0;
            return { before: beforeTokens, after: afterTokens };
          },
        });
        this.usePlugin({
          plugin: this.contextModePlugin.plugin,
          toolPlugin: this.contextModePlugin.toolPlugin,
        })
          .then(() => {
            if (this.config.verbose) {
              console.log(`[Agent] Context mode plugin registered (FTS5 + compression)`);
            }
          })
          .catch((err) => {
            // C26: graceful degradation — continue without compression
            this.contextModePlugin = null;
            if (this.config.verbose) {
              console.log(`[Agent] Context mode plugin failed:`, err?.message || err);
            }
          });
      } catch (err: any) {
        // C26: graceful degradation — continue without compression
        this.contextModePlugin = null;
        if (this.config.verbose) {
          console.log(`[Agent] Context mode plugin failed:`, err?.message || err);
        }
      }
    }

    // Initialize context tracker when contextMode is enabled
    if (this.config.contextMode) {
      const modelLimit = MODEL_TOKEN_LIMITS[this.config.model] || 100000;
      this.contextTracker = new ContextTracker(modelLimit);
    }

    // Initialize hooks (async, but we don't wait - hooks will be ready soon)
    const projectRoot = getSandboxProjectRoot();
    initializeHooks(projectRoot, this.agentId).catch((err) => {
      if (this.config.verbose) {
        console.log(`[Agent] Hook initialization failed:`, err?.message || err);
      }
    });

    // Register workspace tool plugin (spawn_workspace, destroy_workspace, list_workspaces)
    // Gracefully skips if Docker is unavailable. Guard against duplicate registration.
    if (!this._workspacePluginRegistered) {
      try {
        const wsPlugin = new WorkspaceToolPlugin(this.mcpManager);
        this.toolPluginManager.register(wsPlugin);
        this._workspacePluginRegistered = true;
      } catch (err: any) {
        if (this.config.verbose) {
          console.log(`[Agent] Workspace plugin registration failed:`, err?.message || err);
        }
      }
    }

    return this.session;
  }

  resumeSession(sessionId: string): Session | null {
    this.session = this.sessions.getSession(sessionId);
    return this.session;
  }

  getSession(): Session | null {
    return this.session;
  }

  /** Get context budget metrics (Phase 4) — used by worker-loop for WebSocket stats */
  getContextMetrics(): {
    usagePercent: number;
    turnsRemaining: number;
    totalSaved: number;
    savingsRatio: number;
  } | null {
    if (!this.contextTracker) return null;
    try {
      const metrics = this.contextTracker.getCompressionMetrics();
      return {
        usagePercent: 0, // updated during prompt building
        turnsRemaining: 0,
        totalSaved: metrics.totalSaved,
        savingsRatio: metrics.savingsRatio,
      };
    } catch {
      return null;
    }
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
    let toolCallHistory: AgentResult["toolCalls"] = [];
    let iterations = 0;
    let finalContent = "";
    let contextTokens = 0;
    let interruptCount = 0; // Track number of interrupts per full run (not per iteration)
    const maxInterruptsPerRun = 3;

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

    // Phase 4: Context budget hint injection (only when >50% used)
    let contextHint = "";
    if (this.contextTracker) {
      try {
        const currentTokens = estimateMessagesTokens(history);
        const systemTokens = estimateTokens(this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT);
        const hint = this.contextTracker.getContextHint(currentTokens + systemTokens, systemTokens);
        if (hint) contextHint = `\n\n${hint}`;
      } catch {}
    }

    const systemPrompt =
      (this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT) +
      contextHint +
      (this.config.additionalContext ? `\n\n${this.config.additionalContext}` : "") +
      checkpointContext +
      skillsSummary +
      pluginContext;

    // Layer 6: System prompt budget — cap at 15% of raw model limit
    const modelLimit = MODEL_TOKEN_LIMITS[this.config.model] ?? 128000;
    const maxSystemPromptChars = Math.floor(modelLimit * 0.15 * 4); // 15% of limit in chars (~4 chars/token)
    let finalSystemPrompt = systemPrompt;
    if (finalSystemPrompt.length > maxSystemPromptChars) {
      // Priority-ordered truncation: shed least valuable first
      // 1. Skills summary (auto-generated, least critical)
      // 2. Plugin context (auto-generated)
      // 3. Checkpoint context
      // 4. Additional context (CLAWD.md — user-authored, shed last among optional)
      // 5. contextHint (tiny, always kept — most useful under pressure)
      // 6. Base prompt (never truncated)
      const basePrompt = this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
      const additionalCtx = this.config.additionalContext ? `\n\n${this.config.additionalContext}` : "";

      // Try shedding in priority order
      let assembled = basePrompt + contextHint + additionalCtx + checkpointContext + pluginContext; // dropped skills
      if (assembled.length > maxSystemPromptChars) {
        // Cap plugin context at 4K
        const cappedPlugin =
          pluginContext.length > 4000 ? pluginContext.slice(0, 4000) + "\n[Plugin context truncated]" : pluginContext;
        assembled = basePrompt + contextHint + additionalCtx + checkpointContext + cappedPlugin;
      }
      if (assembled.length > maxSystemPromptChars) {
        // Cap checkpoint at 6K (~6000 chars)
        const cappedCheckpoint =
          checkpointContext.length > 6000
            ? checkpointContext.slice(0, 6000) + "\n[Checkpoint context truncated]"
            : checkpointContext;
        const cappedPlugin =
          pluginContext.length > 4000 ? pluginContext.slice(0, 4000) + "\n[Plugin context truncated]" : pluginContext;
        assembled = basePrompt + contextHint + additionalCtx + cappedCheckpoint + cappedPlugin;
      }
      if (assembled.length > maxSystemPromptChars) {
        // Cap additional context (CLAWD.md) — user-authored, shed reluctantly
        const cappedCheckpoint2 =
          checkpointContext.length > 6000
            ? checkpointContext.slice(0, 6000) + "\n[Checkpoint context truncated]"
            : checkpointContext;
        const cappedPlugin2 =
          pluginContext.length > 4000 ? pluginContext.slice(0, 4000) + "\n[Plugin context truncated]" : pluginContext;
        const reservedForOthers =
          basePrompt.length + contextHint.length + cappedCheckpoint2.length + cappedPlugin2.length;
        const maxAdditional = Math.max(0, maxSystemPromptChars - reservedForOthers);
        const additionalMarker = "\n[CLAWD.md instructions truncated for context budget]";
        const cappedAdditional =
          additionalCtx.length > maxAdditional
            ? maxAdditional >= additionalMarker.length
              ? additionalCtx.slice(0, maxAdditional - additionalMarker.length) + additionalMarker
              : ""
            : additionalCtx;
        assembled = basePrompt + contextHint + cappedAdditional + cappedCheckpoint2 + cappedPlugin2;
      }
      finalSystemPrompt = assembled;
      // Final backstop: hard truncate if still over budget
      if (finalSystemPrompt.length > maxSystemPromptChars) {
        const backstopMsg = "\n[System prompt truncated to fit 15% budget]";
        finalSystemPrompt = finalSystemPrompt.slice(0, maxSystemPromptChars - backstopMsg.length) + backstopMsg;
      }
    }

    // Build messages array
    let messages: Message[] = [
      { role: "system", content: finalSystemPrompt },
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
          if (interruptCount >= maxInterruptsPerRun) {
            // Skip — too many interrupts this turn
            return false;
          }
          // Truncate interrupt message to prevent context overflow
          if (newMessage.length > 10000) {
            const intMarker = "\n\n[TRUNCATED — interrupt message too long]";
            let cp = 10000 - intMarker.length;
            if (
              cp > 0 &&
              cp < newMessage.length &&
              newMessage.charCodeAt(cp - 1) >= 0xd800 &&
              newMessage.charCodeAt(cp - 1) <= 0xdbff
            )
              cp--;
            newMessage = newMessage.slice(0, cp) + intMarker;
          }
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

            // Clear stale tool history — prevents premature exit on empty response
            // after compaction (line 2110 check: toolCallHistory.length > 0 && iterations > 1)
            toolCallHistory = [];
            emptyResponseCount = 0;
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
        const toolNames = tools.map((t) => t.function.name);
        if (isDebugEnabled()) {
          console.log(`[Tools] Total tools for API: ${toolNames.length} - ${toolNames.join(", ")}`);
        }
        const request: CompletionRequest = {
          model: this.getModel(),
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
          for await (const event of this.client.stream(request, signal, "agent")) {
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
          // Handle AllKeysSuspendedError — notify user and cancel
          if (err instanceof AllKeysSuspendedError) {
            const resumeTime = err.earliestResumeAt.toISOString();
            console.error(`[Agent] All Copilot keys suspended. Resume at: ${resumeTime}`);
            // Best-effort user notification (may also fail if all keys suspended — silently swallowed)
            try {
              await this.chat(
                `⛔ All Copilot API keys are suspended. Earliest resume: ${resumeTime}. Please try again later.`,
              );
            } catch {}
            this._cancelled = true;
            return {
              content: "",
              toolCalls: toolCallHistory,
              iterations,
              contextTokens,
              interrupted: false,
              interruptCount,
            };
          }
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
            errorMsg.includes("prompt_tokens_exceeded") ||
            errorMsg.includes("prompt token count") ||
            (errorMsg.includes("400") && errorMsg.includes("maximum")) ||
            (errorMsg.includes("exceeds") && errorMsg.includes("limit"));

          if (isPromptTooLong) {
            // Parse actual token count from API error for calibrated reduction
            // Matches: "128186 exceeds...128000", "count of 128186 exceeds the limit of 128000"
            const tokenMatch =
              errorMsg.match(/(\d{4,})\s*(?:exceeds|>|exceed).*?(\d{4,})/) ||
              errorMsg.match(/(\d{4,}).*?(?:limit|maximum).*?(\d{4,})/);
            const actualTokens = tokenMatch ? parseInt(tokenMatch[1]) : 0;
            const apiLimit = tokenMatch ? parseInt(tokenMatch[2]) : (MODEL_TOKEN_LIMITS[this.getModel()] ?? 128000);

            // Calculate correction factor: how much our estimate underestimates reality
            const correctionFactor = actualTokens > 0 && contextTokens > 0 ? actualTokens / contextTokens : 1.5; // Default: assume 50% underestimate

            // Target 70% of API limit for headroom, then divide by correction factor
            // to get the effective budget our estimator should use
            const targetTokens = Math.floor((apiLimit * 0.7) / correctionFactor);
            const beforeCount = messages.length;

            console.log(
              `[Agent] Prompt too long: actual=${actualTokens}, estimated=${contextTokens}, ` +
                `correction=${correctionFactor.toFixed(2)}x, target=${targetTokens}`,
            );

            // Temporarily lower maxContextTokens to use corrected limit for truncation
            const savedMaxTokens = this.maxContextTokens;
            this.maxContextTokens = targetTokens;
            messages = this.truncateContext(messages);
            this.maxContextTokens = savedMaxTokens;
            contextTokens = estimateMessagesTokens(messages);

            // If truncation didn't remove enough (still >90% of original), fall back to minimal
            if (messages.length > beforeCount * 0.9 || contextTokens > targetTokens * 1.2) {
              // Find latest user message
              let latestUserContent = userMessage;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user" && messages[i].content) {
                  latestUserContent = messages[i].content as string;
                  break;
                }
              }

              // Update system prompt
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
            }

            // Sync session DB: compact to match in-memory messages count
            const nonSystemCount = messages.filter((m) => m.role !== "system").length;
            const summary = `[Context overflow — compacted (actual ${actualTokens} tokens exceeded ${apiLimit} limit)]`;
            this.sessions.compactSessionByName(session.name, Math.max(nonSystemCount, 5), summary);

            const remaining = messages.length - 1;
            this.config.onCompaction?.(beforeCount - 1, remaining);
            if (this.plugins) {
              try {
                await this.plugins.onCompaction(beforeCount - 1, remaining);
              } catch (err) {
                logSilentError("plugin.onCompaction", err);
              }
            }

            // Clear stale tool history to prevent premature exit after compaction
            toolCallHistory = [];
            emptyResponseCount = 0;

            console.log(
              `[Compaction] Reduced from ${beforeCount} to ${messages.length} messages (~${contextTokens} est. tokens), retrying...`,
            );

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
          let turnToolResultChars = 0;
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
                if (isDebugEnabled()) {
                  console.log(`[Tool] ${toolCall.function.name}(${JSON.stringify(result.args)})`);
                }
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

            // Layer 8: Tool result size guard — universal backstop
            // Post-execution check: truncate result BEFORE pushing to messages.
            // Cannot pre-check because tool output size is unknown before execution.
            {
              // Surrogate-safe head slice helper
              const safeHead = (s: string, len: number) => {
                let cp = len;
                if (cp > 0 && cp < s.length && s.charCodeAt(cp - 1) >= 0xd800 && s.charCodeAt(cp - 1) <= 0xdbff) cp--;
                return s.slice(0, cp);
              };
              const modelLimit = MODEL_TOKEN_LIMITS[this.config.model] ?? 128000;
              const effectiveBudget = modelLimit * 0.8;
              const currentResultSize = result.result.output?.length || 0;
              const aggCap = effectiveBudget * 0.3 * 4; // 30% of budget in chars
              const maxToolResultChars =
                turnToolResultChars + currentResultSize > aggCap
                  ? Math.floor(effectiveBudget * 0.05 * 4) // aggressive: 5% when aggregate exceeded
                  : Math.floor(effectiveBudget * 0.15 * 4); // normal: 15% of budget in chars

              if (toolCall.function.name.startsWith("chat_")) {
                // Metadata-aware truncation for chat tools: preserve ts, files_json, user
                if (result.result.output && result.result.output.length > maxToolResultChars) {
                  try {
                    const parsed = JSON.parse(result.result.output);
                    // Truncate text fields in messages while preserving metadata
                    const visited = new WeakSet();
                    const truncateTextFields = (obj: unknown, depth = 0): unknown => {
                      if (depth > 20) return obj;
                      if (Array.isArray(obj)) return obj.map((item) => truncateTextFields(item, depth + 1));
                      if (obj && typeof obj === "object") {
                        if (visited.has(obj as object)) return "[Circular]";
                        visited.add(obj as object);
                        const o = obj as Record<string, unknown>;
                        const out: Record<string, unknown> = {};
                        for (const [k, v] of Object.entries(o)) {
                          if ((k === "text" || k === "summary") && typeof v === "string" && v.length > 2000) {
                            out[k] = v.slice(0, 1500) + `\n[TRUNCATED — ${v.length} chars]` + v.slice(-300);
                          } else if (k === "content" && typeof v === "string" && v.length > 2000) {
                            out[k] = v.slice(0, 1500) + `\n[TRUNCATED — ${v.length} chars]` + v.slice(-300);
                          } else {
                            out[k] = truncateTextFields(v, depth + 1);
                          }
                        }
                        return out;
                      }
                      return obj;
                    };
                    const truncated = truncateTextFields(parsed);
                    result.result.output = JSON.stringify(truncated, null, 2);
                    // Re-check: metadata-aware truncation may still exceed budget
                    if (result.result.output.length > maxToolResultChars) {
                      const marker = `\n\n[TRUNCATED — chat output was ${result.result.output.length} chars]\n\n`;
                      const available = Math.max(0, maxToolResultChars - marker.length);
                      const headSize = Math.max(0, Math.floor(available * 0.6));
                      const tailSize = Math.max(0, Math.floor(available * 0.4));
                      result.result.output =
                        safeHead(result.result.output, headSize) +
                        marker +
                        (tailSize > 0 ? result.result.output.slice(-tailSize) : "");
                    }
                  } catch {
                    // Not JSON — fall through to standard truncation
                    if (result.result.output.length > maxToolResultChars) {
                      const marker = `\n\n[TRUNCATED — tool output was ${result.result.output.length} chars]\n\n`;
                      const available = Math.max(0, maxToolResultChars - marker.length);
                      const headSize = Math.max(0, Math.floor(available * 0.6));
                      const tailSize = Math.max(0, Math.floor(available * 0.4));
                      result.result.output =
                        safeHead(result.result.output, headSize) +
                        marker +
                        (tailSize > 0 ? result.result.output.slice(-tailSize) : "");
                    }
                  }
                }
              } else {
                // Standard truncation for non-chat tools
                if (result.result.output && result.result.output.length > maxToolResultChars) {
                  const originalLength = result.result.output.length;
                  const marker = `\n\n[TRUNCATED — tool output was ${originalLength} chars]\n\n`;
                  const available = Math.max(0, maxToolResultChars - marker.length);
                  const headSize = Math.max(0, Math.floor(available * 0.6));
                  const tailSize = Math.max(0, Math.floor(available * 0.4));
                  result.result.output =
                    safeHead(result.result.output, headSize) +
                    marker +
                    (tailSize > 0 ? result.result.output.slice(-tailSize) : "");
                }
              }
              turnToolResultChars += result.result.output?.length || 0;
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
          if (isDebugEnabled()) {
            console.log("[Agent] Empty response after tool execution - task likely complete");
          }
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
      model: this.getModel(),
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

    // Clean up context mode plugin reference
    this.contextModePlugin = null;
    this.contextTracker = null;

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
