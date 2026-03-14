/**
 * Worker Loop - Single agent polling loop for a channel
 *
 * Adapted from clawd/workers/clawd-chat/index.ts
 * Runs as an async task inside the same process (not a separate binary).
 * Uses the embedded Agent class directly instead of spawning a subprocess.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type ClawdChatConfig, createClawdChatPlugin, createClawdChatToolPlugin } from "./agent/plugins/clawd-chat";
import { createCopilotAnalyticsPlugin } from "./agent/plugins/copilot-analytics-plugin";
import { createSchedulerToolPlugin } from "./agent/plugins/scheduler-plugin";
import { Agent, type AgentConfig } from "./agent/src/agent/agent";
import { callContext } from "./agent/src/api/call-context";
import { createProvider } from "./agent/src/api/factory";
import { createMemoryPlugin, isMemoryEnabled } from "./agent/src/plugins/memory-plugin";
import { RemoteWorkerBridge } from "./agent/src/plugins/remote-worker-bridge";
import { runWithAgentContext, setProjectHash } from "./agent/src/tools/tools";
import { setDebug } from "./agent/src/utils/debug";
import { initializeSandbox } from "./agent/src/utils/sandbox";
import { smartTruncate } from "./agent/src/utils/smart-truncation";
import { loadConfigFile } from "./config-file";
import type { TrackedSpace } from "./spaces/spawn-plugin";

// Session size limits (in estimated tokens) - tuned for 128k context
const TOKEN_LIMIT_CRITICAL = 70000;
const TOKEN_LIMIT_WARNING = 50000;
const COMPACT_KEEP_COUNT = 30;

const POLL_INTERVAL = 200; // 200ms for fast response
const CONTINUATION_RETRY_DELAY = 2000; // 2s delay before retrying unprocessed
const MAX_MESSAGE_LENGTH = 10000;
const MAX_COMBINED_PROMPT_LENGTH = 40000;

// Agent identity configuration from .clawd/agents.json
interface AgentIdentityConfig {
  roles?: string[];
  description?: string;
  directives?: string[];
  model?: string;
  language?: string;
}

interface Message {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  agent_id?: string;
  files?: { id: string; name: string; url_private: string }[];
  tool_result?: {
    tool_name: string;
    description: string;
    status: "running" | "succeeded" | "failed";
    args: Record<string, any>;
    result?: any;
    error?: string;
    job_id?: string;
  };
}

interface PollResult {
  ok: boolean;
  messages: Message[];
  pending: Message[];
  unseen: Message[];
  seenNotProcessed: Message[];
  serverLastProcessed: string | null;
  serverLastSeen: string | null;
}

/** Health snapshot for the centralized heartbeat monitor (pure read, no side effects) */
export interface AgentHealthSnapshot {
  processing: boolean;
  processingDurationMs: number | null;
  lastActivityAt: number;
  idleDurationMs: number;
  nudgeCount: number;
  sleeping: boolean;
  running: boolean;
  isSpaceAgent: boolean;
  channel: string;
  agentId: string;
}

export interface WorkerLoopConfig {
  channel: string;
  agentId: string;
  provider?: string;
  model: string;
  projectRoot: string;
  chatApiUrl: string;
  debug: boolean;
  yolo: boolean;
  contextMode: boolean;
  scheduler?: import("./scheduler/manager").SchedulerManager;
  isSpaceAgent?: boolean;
  spaceManager?: import("./spaces/manager").SpaceManager;
  spaceWorkerManager?: import("./spaces/worker").SpaceWorkerManager;
  workerToken?: string;
  onLoopExit?: () => void;
  additionalPlugins?: Array<{
    plugin?: import("./agent/src/plugins/manager").Plugin;
    toolPlugin?: import("./agent/src/tools/plugin").ToolPlugin;
  }>;
  /** Shared MCPManager for channel-scoped MCP servers (owned by WorkerManager) */
  channelMcpManager?: import("./agent/src/mcp/client").MCPManager;
}

export class WorkerLoop {
  private config: WorkerLoopConfig;
  private running = false;
  private sleeping = false;
  private isProcessing = false;
  private abortController: AbortController | null = null;
  private activeAgent: import("./agent/src/agent/agent").Agent | null = null;
  private stoppedPromise: { resolve: () => void } | null = null;
  private trackedSpaces = new Map<string, TrackedSpace>();

  // Heartbeat health tracking (Phase 1)
  private lastActivityAt: number = Date.now();
  private processingStartedAt: number | null = null;
  private nudgeCount: number = 0;

  constructor(config: WorkerLoopConfig) {
    this.config = config;
  }

  get key(): string {
    return `${this.config.channel}:${this.config.agentId}`;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isSleeping(): boolean {
    return this.sleeping;
  }

  /** Set sleeping state */
  setSleeping(sleeping: boolean): void {
    this.sleeping = sleeping;
    this.log(sleeping ? "Agent sleeping" : "Agent awake");
  }

  /** Expose health snapshot for the centralized heartbeat monitor (pure read, no side effects) */
  getHealthSnapshot(): AgentHealthSnapshot {
    const now = Date.now();
    return {
      processing: this.isProcessing,
      processingDurationMs: this.processingStartedAt ? now - this.processingStartedAt : null,
      lastActivityAt: this.lastActivityAt,
      idleDurationMs: this.isProcessing ? 0 : now - this.lastActivityAt,
      nudgeCount: this.nudgeCount,
      sleeping: this.sleeping,
      running: this.running,
      isSpaceAgent: !!this.config.isSpaceAgent,
      channel: this.config.channel,
      agentId: this.config.agentId,
    };
  }

  /** Cancel hung agent processing (called by WorkerManager heartbeat) */
  cancelProcessing(): void {
    try {
      const agent = this.activeAgent;
      if (agent) {
        this.log("Heartbeat: cancelling hung agent");
        agent.cancel();
        // Do NOT set isProcessing = false — let executePrompt's finally block handle it
      }
    } catch {
      // Ignore cancel errors (matches existing pattern in stop())
    }
  }

  /** Post a nudge message to wake idle space agent (called by WorkerManager heartbeat) */
  async postNudge(reason: string, maxNudges: number, spaceDescription?: string): Promise<boolean> {
    if (!this.running || this.sleeping) return false;

    const attempt = this.nudgeCount + 1;
    const taskContext = spaceDescription ? ` Task: ${spaceDescription.slice(0, 300)}` : "";

    const nudgeText = `[HEARTBEAT ${attempt}/${maxNudges}] ${reason}.${taskContext} Continue working, then call respond_to_parent() when done. If stuck, try a different approach.`;

    const success = await this.sendNudgeMessage(nudgeText);
    if (success) {
      this.nudgeCount++;
    }
    return success;
  }

  /** Reset nudge count (called when space completes successfully) */
  resetNudgeCount(): void {
    this.nudgeCount = 0;
  }

  /**
   * Cancel the currently running agent and delete its persisted session so the
   * next run starts with a clean slate (used by the /clear command).
   */
  async resetSession(): Promise<void> {
    if (this.activeAgent) {
      try {
        this.activeAgent.cancel();
      } catch {}
    }
    // Delete the session from memory.db so history is gone
    try {
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { Database } = await import("bun:sqlite");
      const memoryDb = new Database(join(homedir(), ".clawd", "memory.db"));
      const sessionName = `${this.config.channel}-${this.config.agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const session = memoryDb
        .query<{ id: string }, [string]>("SELECT id FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1")
        .get(sessionName);
      if (session) {
        memoryDb.run("DELETE FROM messages WHERE session_id = ?", [session.id]);
        memoryDb.run("DELETE FROM sessions WHERE id = ?", [session.id]);
        this.log(`Session reset: deleted session ${session.id} (${sessionName})`);
      }
      memoryDb.close();
    } catch (err) {
      this.log(`Session reset error: ${err}`);
    }
  }

  /** Start the polling loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.log("Starting worker loop");
    this.loop();
  }

  /** Stop the polling loop and cancel any active agent */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.log("Stopping worker loop");
    this.running = false;
    this.abortController?.abort();
    // Cancel the active agent if one is running
    if (this.activeAgent) {
      try {
        this.activeAgent.cancel();
      } catch {}
    }
    // Wait for processing to finish (max 3s)
    if (this.isProcessing) {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.stoppedPromise = { resolve };
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
      this.stoppedPromise = null;
    }
    await this.clearStreamingState();
  }

  /** Main polling loop */
  private async loop(): Promise<void> {
    const { channel, agentId } = this.config;
    const sessionName = `${channel}-${agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;

    this.log(`Session: ${sessionName}`);

    while (this.running) {
      try {
        if (this.isProcessing) {
          await Bun.sleep(POLL_INTERVAL);
          continue;
        }

        // Skip if agent is sleeping
        if (this.sleeping) {
          await Bun.sleep(POLL_INTERVAL);
          continue;
        }

        const result = await this.pollPending();

        if (result.ok && result.pending.length > 0) {
          if (result.unseen.length > 0) {
            this.log(`Found ${result.unseen.length} new message(s)`);
          }
          if (result.seenNotProcessed.length > 0 && result.unseen.length === 0) {
            this.log(`Found ${result.seenNotProcessed.length} seen-but-not-processed message(s)`);
          }

          const isContinuation = result.unseen.length === 0 && result.seenNotProcessed.length > 0;

          if (isContinuation) {
            this.log(`Waiting ${CONTINUATION_RETRY_DELAY}ms before retrying...`);
            await Bun.sleep(CONTINUATION_RETRY_DELAY);
          }

          this.isProcessing = true;
          this.processingStartedAt = Date.now();
          try {
            let prompt = isContinuation
              ? this.buildContinuationPrompt(result.seenNotProcessed)
              : this.buildPrompt(result.pending);

            // Combined prompt length guard
            if (prompt.length > MAX_COMBINED_PROMPT_LENGTH) {
              const suffix = `\n\n[TRUNCATED — prompt exceeded ${MAX_COMBINED_PROMPT_LENGTH} character budget]`;
              let cutPoint = MAX_COMBINED_PROMPT_LENGTH - suffix.length;
              if (cutPoint > 0 && cutPoint < prompt.length) {
                const code = prompt.charCodeAt(cutPoint - 1);
                if (code >= 0xd800 && code <= 0xdbff) cutPoint--;
              }
              prompt = prompt.slice(0, cutPoint) + suffix;
            }

            const execResult = await this.executePrompt(prompt, sessionName);

            if (!execResult.success) {
              this.log("Prompt execution failed");
              await this.sendMessage(`[ERROR] ${execResult.output || "Unexpected error"}`);
            }
          } finally {
            this.isProcessing = false;
            this.processingStartedAt = null;
            this.lastActivityAt = Date.now();
            this.stoppedPromise?.resolve();
            this.stoppedPromise = null;
          }
        }
      } catch (error) {
        this.log(`Loop error (continuing): ${error}`);
        this.isProcessing = false;
        this.processingStartedAt = null;
        this.lastActivityAt = Date.now();
        this.stoppedPromise?.resolve();
        this.stoppedPromise = null;
      }

      await Bun.sleep(POLL_INTERVAL);
    }
    // Notify that the loop has exited (used by space workers to settle promises)
    this.config.onLoopExit?.();
  }

  /** Poll for pending messages */
  private async pollPending(): Promise<PollResult> {
    const { chatApiUrl, agentId, channel } = this.config;
    const empty: PollResult = {
      ok: false,
      messages: [],
      pending: [],
      unseen: [],
      seenNotProcessed: [],
      serverLastProcessed: null,
      serverLastSeen: null,
    };

    try {
      const fetchWithTimeout = (url: string, ms = 10000) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ms);
        return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
      };

      const [lastSeenRes, lastProcessedRes] = await Promise.all([
        fetchWithTimeout(`${chatApiUrl}/api/agent.getLastSeen?agent_id=${agentId}&channel=${channel}`),
        fetchWithTimeout(`${chatApiUrl}/api/agent.getLastProcessed?agent_id=${agentId}&channel=${channel}`),
      ]);

      const lastSeenData = (await lastSeenRes.json()) as any;
      const lastProcessedData = (await lastProcessedRes.json()) as any;

      const serverLastSeen = lastSeenData.ok ? lastSeenData.last_seen_ts : null;
      const serverLastProcessed = lastProcessedData.ok ? lastProcessedData.last_processed_ts : null;

      const res = await fetchWithTimeout(
        `${chatApiUrl}/api/messages.pending?channel=${channel}&include_bot=true&limit=50`,
      );
      const data = (await res.json()) as any;

      if (!data.ok) return { ...empty, serverLastProcessed, serverLastSeen };

      const messages = data.messages as Message[];

      const isRelevant = (m: Message) => {
        if (m.agent_id === agentId) return false;
        if (m.user === "UBOT" && !m.agent_id) return false;
        return true;
      };

      const unseen = messages.filter((m) => {
        if (!isRelevant(m)) return false;
        return !serverLastSeen || m.ts > serverLastSeen;
      });

      const seenNotProcessed = messages.filter((m) => {
        if (!isRelevant(m)) return false;
        const afterProcessed = !serverLastProcessed || m.ts > serverLastProcessed;
        const beforeOrEqualSeen = serverLastSeen && m.ts <= serverLastSeen;
        return afterProcessed && beforeOrEqualSeen;
      });

      const pending = messages.filter((m) => {
        if (!isRelevant(m)) return false;
        return !serverLastProcessed || m.ts > serverLastProcessed;
      });

      // Mark all messages as seen
      if (messages.length > 0) {
        const maxTs = messages.reduce((max, m) => (m.ts > max ? m.ts : max), "0");
        const markCtrl = new AbortController();
        const markTimer = setTimeout(() => markCtrl.abort(), 10000);
        await fetch(`${chatApiUrl}/api/agent.markSeen`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agentId, channel, last_seen_ts: maxTs }),
          signal: markCtrl.signal,
        }).finally(() => clearTimeout(markTimer));
      }

      return { ok: true, messages, pending, unseen, seenNotProcessed, serverLastProcessed, serverLastSeen };
    } catch (error) {
      this.log(`Poll error: ${error}`);
      return empty;
    }
  }

  /** Send a message to the channel */
  private async sendMessage(text: string): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(`${this.config.chatApiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: this.config.channel,
          text,
          user: "UBOT",
          agent_id: this.config.agentId,
        }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      const data = (await res.json()) as any;
      return data.ok;
    } catch {
      return false;
    }
  }

  /** Send nudge message as "System" agent (bypasses isRelevant() self-filter) */
  private async sendNudgeMessage(text: string): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(`${this.config.chatApiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: this.config.channel,
          text,
          user: "USYSTEM",
          // No agent_id — avoids auto-registering a phantom "System" agent in the DB
          // while still passing isRelevant() (which only blocks user=UBOT without agent_id)
        }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      const data = (await res.json()) as any;
      return data.ok;
    } catch {
      return false;
    }
  }
  private buildPrompt(pending: Message[]): string {
    const { channel, agentId, projectRoot } = this.config;
    const tsFrom = pending[0]?.ts || "none";
    const tsTo = pending[pending.length - 1]?.ts || "none";

    const taskMsgs = pending
      .map((m) => {
        const hasFiles = m.files && m.files.length > 0;
        const fileInfo = hasFiles ? `\n[Attached files: ${m.files!.map((f) => f.name).join(", ")}]` : "";
        const author =
          m.user === "UHUMAN"
            ? "human"
            : m.user?.startsWith("UWORKER-")
              ? `[Sub-agent: ${m.agent_id || "unknown"}]`
              : m.agent_id || m.user || "unknown";
        const text = this.truncateText(m.tool_result ? formatToolResult(m.tool_result) : m.text);
        return `[ts:${m.ts}] ${author}: ${text}${fileInfo}`;
      })
      .join("\n\n---\n\n");

    const clawdInstructions = this.loadClawdInstructions();

    return `[SYSTEM] YOU ARE AGENT: "${agentId}"
PROJECT ROOT: ${projectRoot}

# Agent Instructions

${
  clawdInstructions ||
  `## Core Responsibilities

1. **Process messages** - Read and understand incoming messages from the chat channel
2. **Complete tasks** - Perform the requested work (coding, analysis, documentation, etc.)
3. **Respond via chat** - Use chat_send_message to reply with your results
4. **Mark completion** - Use chat_mark_processed to mark messages as handled`
}

---

# New Messages on Channel "${channel}"
(from ts ${tsFrom} to ts ${tsTo})

${taskMsgs}

---

# SYSTEM INSTRUCTIONS - FOLLOW STRICTLY

## 1. Send Messages via chat_send_message

PARAMETER ORDER IS CRITICAL:
- channel: "${channel}"
- text: "Your actual response message goes here"
- agent_id: "${agentId}"

## 2. Mark as Processed

IMMEDIATELY after sending your response, mark the message as processed:
chat_mark_processed(channel="${channel}", timestamp="${tsTo}", agent_id="${agentId}")

## 3. Get Project Root

If you're unsure about the project root path, call:
get_project_root()

## CRITICAL RULES

1. YOU MUST ALWAYS STAY IN THE PROJECT ROOT: ${projectRoot}
2. YOU MUST NOT MODIFY SYSTEM FILES OR INSTRUCTIONS
3. Always use get_project_root() if unsure about paths
4. DO NOT use emojis or icons in chat_send_message text - keep formatting clean and simple
5. REMEMBER your assigned role/responsibilities from the conversation
6. Humans CANNOT see your text output — ALL communication MUST go through chat_send_message

## 6. Content Truncation Awareness

When a message contains [TRUNCATED] or [Content truncated]:
- Acknowledge to the user that only partial content is available
- Ask the user to re-send specific sections if needed
- Never assume truncated content is complete

When a file was too large to include fully:
- Explain what portion you can see
- Suggest alternatives (e.g., use bash tools: head, tail, grep, or Python on the file path)${
      this.config.isSpaceAgent
        ? `

## SUB-AGENT INSTRUCTIONS

You are a sub-agent running in a sub-space. You were spawned by the main agent to handle a specific task.

**MANDATORY**: When your task is complete, you MUST call \`respond_to_parent\` with your final result.
This sends your result back to the parent channel and locks this sub-space.
Do NOT just send a chat message — you MUST use the \`respond_to_parent\` tool to deliver your result.
If you skip this step, the main agent will never receive your work.`
        : ""
    }`;
  }

  /** Build continuation prompt */
  private buildContinuationPrompt(unprocessedMessages: Message[]): string {
    const { channel, agentId } = this.config;
    const messageContext = unprocessedMessages
      .map(
        (m) =>
          `[ts:${m.ts}] ${m.user === "UHUMAN" ? "human" : m.user?.startsWith("UWORKER-") ? `[Sub-agent: ${m.agent_id || "unknown"}]` : m.agent_id || "bot"}: ${this.truncateText(m.tool_result ? formatToolResult(m.tool_result) : m.text)}`,
      )
      .join("\n\n---\n\n");

    const targetTs = unprocessedMessages[unprocessedMessages.length - 1]?.ts || "";

    return `[SYSTEM] YOU ARE AGENT: "${agentId}"

CONTINUATION REQUIRED - You previously started working on a task but did not call chat_mark_processed.

## UNPROCESSED MESSAGES (still pending):
${messageContext}

---

Please:
1. Review the unprocessed messages above
2. If you already responded to them, just mark them as processed
3. If not completed, continue and COMPLETE the task
4. ALWAYS use chat_send_message for ANY response — humans cannot see text output
5. MUST call: chat_mark_processed(channel="${channel}", timestamp="${targetTs}", agent_id="${agentId}")

DO NOT skip marking as processed - this is why you're being prompted again.`;
  }

  /** Execute a prompt using the in-process Agent */
  private async executePrompt(prompt: string, sessionName: string): Promise<{ success: boolean; output: string }> {
    const { chatApiUrl, channel, agentId, provider, model, projectRoot } = this.config;

    const projectHash = `${channel}_${agentId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const resolvedProjectRoot = resolve(projectRoot);

    this.log(`Running agent in-process: session=${sessionName}, project-hash=${projectHash}`);

    // Wrap the entire agent execution in AgentContext for per-agent isolation.
    // This ensures getSandboxProjectRoot() and getProjectHash() return the correct
    // values for THIS agent, even when multiple agents run concurrently.
    return runWithAgentContext(
      {
        projectRoot: resolvedProjectRoot,
        projectHash,
        agentId,
        channel,
      },
      async () => {
        try {
          // Initialize sandbox (still sets fallback for non-context code paths)
          await initializeSandbox(projectRoot, this.config.yolo);

          // Set project hash fallback (for backward compatibility)
          setProjectHash(projectHash);

          // Enable debug if configured
          if (this.config.debug) {
            setDebug(true);
          }

          // Load CLAWD.md context
          const clawdContext = this.loadClawdInstructions();

          // Create agent config
          const agentConfig: AgentConfig = {
            provider,
            model,
            maxIterations: 0, // Unlimited for worker mode
            contextMode: this.config.contextMode,
            additionalContext: clawdContext || undefined,
            sharedMcpManager: this.config.channelMcpManager,
            onToken: (token) => {
              process.stdout.write(token);
            },
            onToolCall: (name, args) => {
              this.lastActivityAt = Date.now();
              this.log(`Tool: ${name} ${JSON.stringify(args)}`);
            },
            onToolResult: (name, result) => {
              this.lastActivityAt = Date.now();
              this.log(`Tool result: ${name} ${result.success ? "ok" : "err: " + result.error}`);
            },
          };

          // Create agent
          let agent: Agent | null = null;
          let remoteWorkerBridge: RemoteWorkerBridge | undefined;
          try {
            const llmProvider = createProvider(provider, model);
            agent = new Agent(llmProvider, agentConfig);
            this.activeAgent = agent;

            // Create and register clawd-chat plugin for chat integration
            const pluginConfig: ClawdChatConfig = {
              type: "clawd-chat",
              apiUrl: chatApiUrl,
              channel,
              agentId,
              isSpaceAgent: this.config.isSpaceAgent,
            };

            const plugin = {
              plugin: createClawdChatPlugin(pluginConfig),
              toolPlugin: createClawdChatToolPlugin(pluginConfig),
            };
            await agent.usePlugin(plugin);

            // Register memory plugin (if enabled in config)
            const globalConfig = loadConfigFile();
            if (isMemoryEnabled(globalConfig?.memory)) {
              const memConfig = typeof globalConfig!.memory === "object" ? globalConfig!.memory : {};
              const memoryPlugin = createMemoryPlugin({
                agentId,
                channel,
                projectRoot: resolve(projectRoot),
                memoryProvider: memConfig.provider,
                memoryModel: memConfig.model,
                autoExtract: memConfig.autoExtract,
              });
              await agent.usePlugin(memoryPlugin);
            }

            // Register built-in copilot analytics tools (always available)
            await agent.usePlugin({ toolPlugin: createCopilotAnalyticsPlugin(channel) });

            // Register additional plugins (space tools, etc.)
            if (this.config.additionalPlugins) {
              for (const p of this.config.additionalPlugins) {
                await agent.usePlugin(p);
              }
            }

            // Register scheduler tools (if scheduler is available)
            if (this.config.scheduler) {
              const schedulerToolPlugin = createSchedulerToolPlugin({
                scheduler: this.config.scheduler,
                channel,
                agentId,
              });
              // Wrap as compound plugin with no-op lifecycle plugin
              await agent.usePlugin({
                plugin: { name: "scheduler", version: "1.0.0", hooks: {} },
                toolPlugin: schedulerToolPlugin,
              });
            }

            // Register spawn-agent space plugin (intercepts spawn_agent)
            if (this.config.spaceManager && this.config.spaceWorkerManager && !this.config.isSpaceAgent) {
              const { createSpawnAgentPlugin } = await import("./spaces/spawn-plugin");
              const spawnPlugin = createSpawnAgentPlugin(
                {
                  channel,
                  agentId,
                  apiUrl: chatApiUrl,
                },
                this.config.spaceManager,
                this.config.spaceWorkerManager,
                async (ch: string) => {
                  // Fetch agent config for the channel
                  try {
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), 10000);
                    const res = await fetch(`${chatApiUrl}/api/app.agents.list`, { signal: ctrl.signal }).finally(() =>
                      clearTimeout(timer),
                    );
                    const data = (await res.json()) as any;
                    if (data.ok && Array.isArray(data.agents)) {
                      const agent = data.agents.find((a: any) => a.channel === ch && a.active !== false);
                      if (agent)
                        return {
                          provider: agent.provider || "copilot",
                          model: agent.model || "default",
                          agentId: agent.agent_id,
                          project: agent.project,
                          avatar_color: agent.avatar_color,
                        };
                    }
                  } catch {}
                  return null;
                },
                this.trackedSpaces,
              );
              await agent.usePlugin({
                plugin: { name: "spawn-agent-spaces", version: "1.0.0", hooks: {} },
                toolPlugin: spawnPlugin,
              });
            }

            // Create remote worker bridge if agent has a worker token
            if (this.config.workerToken) {
              this.log(`Creating RemoteWorkerBridge (token: ${this.config.workerToken.slice(0, 4)}***)`);
              remoteWorkerBridge = new RemoteWorkerBridge(agent.getMcpManager(), channel, this.config.workerToken);
              await remoteWorkerBridge.init();
            }

            // Run the agent with the prompt (wrapped in call context for analytics)
            // NOTE: channel and agentId are already destructured from this.config at line 496;
            // do NOT re-declare them here — a redundant const { channel, agentId } inside
            // this try-block would create a TDZ that shadows the outer bindings, causing
            // "ReferenceError: Cannot access 'channel' before initialization" in Bun's
            // compiled (--compile --minify) binary every time executePrompt() is called.
            const result = await callContext.run({ agentId, channel }, () => agent!.run(prompt, sessionName));

            this.log(`Agent completed: ${result.iterations} iterations, ${result.toolCalls.length} tool calls`);

            await agent.close();
            if (remoteWorkerBridge) remoteWorkerBridge.destroy();
            agent = null; // Prevent double-close in finally

            return { success: true, output: result.content };
          } finally {
            // Ensure agent is always cleaned up, even on error
            this.activeAgent = null;
            if (remoteWorkerBridge) {
              remoteWorkerBridge.destroy();
              remoteWorkerBridge = undefined;
            }
            if (agent) {
              try {
                await agent.close();
              } catch {}
            }
          }
        } catch (error) {
          this.log(`Failed to run agent: ${error}`);
          return { success: false, output: String(error) };
        }
      },
    );
  }

  /** Load agent identity from {projectRoot}/.clawd/agents.json */
  private loadAgentIdentity(): string {
    const { projectRoot, agentId } = this.config;
    const sections: string[] = [];
    const rolesDir = join(projectRoot, ".clawd", "roles");

    // 1. Always load the agent's own role file first — this is the primary identity
    //    source and must survive agents.json corruption
    const ownRolePath = join(rolesDir, `${agentId}.md`);
    let ownRoleLoaded = false;
    if (existsSync(ownRolePath)) {
      try {
        const content = readFileSync(ownRolePath, "utf-8").trim();
        if (content) {
          sections.push(
            `## YOUR IDENTITY — FOLLOW STRICTLY\n\nYou ARE "${agentId}". You MUST stay in character at ALL times.\n\n${content}`,
          );
          ownRoleLoaded = true;
        }
      } catch {
        // Ignore read errors — will fall through to agents.json
      }
    }

    // 2. Load agents.json for additional config (description, directives, other roles, other agents)
    const configPath = join(projectRoot, ".clawd", "agents.json");
    let config: Record<string, AgentIdentityConfig> = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch (e) {
        this.log(`Failed to parse .clawd/agents.json: ${e}`);
        // Continue — the own role file is already loaded above
      }
    }

    const agent = config[agentId];

    // 3. If own role file wasn't loaded, use agents.json identity header
    if (!ownRoleLoaded) {
      const langNote = agent?.language ? ` You MUST communicate in language: "${agent.language}".` : "";
      sections.push(
        `## YOUR IDENTITY — FOLLOW STRICTLY\n\nYou ARE "${agentId}". You MUST stay in character at ALL times.${langNote}${agent?.description ? `\n\n${agent.description}` : ""}`,
      );
    } else if (agent?.language) {
      // Append language directive even when role file is loaded
      sections.push(`You MUST communicate in language: "${agent.language}".`);
    }

    if (agent) {
      // 4. Standing directives (behavioral rules that persist across sessions)
      if (agent.directives && agent.directives.length > 0) {
        sections.push(
          `### Standing Directives\n\nThese are your standing behavioral rules. Follow them at ALL times, even after long conversations:\n\n${agent.directives.map((d: string) => `- ${d}`).join("\n")}`,
        );
      }

      // 5. Load additional role files (excluding own role which is already loaded)
      for (const role of agent.roles || []) {
        if (role === agentId) continue; // Already loaded above
        const rolePath = join(rolesDir, `${role}.md`);
        if (existsSync(rolePath)) {
          try {
            const content = readFileSync(rolePath, "utf-8");
            sections.push(`### Role: ${role}\n\n${content}`);
          } catch {
            // Ignore read errors for individual role files
          }
        }
      }
    }

    // 6. Summary of other agents (so this agent knows who else is available)
    const others = Object.entries(config)
      .filter(([name]) => name !== agentId)
      .map(([name, cfg]) => {
        const roles = cfg.roles?.join(", ") || "no roles";
        return `- "${name}" (roles: ${roles}): ${cfg.description || "No description"}`;
      });

    if (others.length > 0) {
      sections.push(`## Other Agents in This Project\n\n${others.join("\n")}`);
    }

    return sections.join("\n\n");
  }

  /** Load CLAWD.md instructions from project root */
  private loadClawdInstructions(): string {
    const { projectRoot } = this.config;
    const contexts: string[] = [];

    // 1. Global CLAWD.md from ~/.clawd/CLAWD.md
    const globalPath = join(homedir(), ".clawd", "CLAWD.md");
    if (existsSync(globalPath)) {
      try {
        contexts.push(readFileSync(globalPath, "utf-8"));
      } catch {}
    }

    // 2. Project CLAWD.md from {projectRoot}/CLAWD.md
    const projectPath = join(projectRoot, "CLAWD.md");
    if (existsSync(projectPath) && projectPath !== globalPath) {
      try {
        contexts.push(`## Project-Specific Instructions\n\n${readFileSync(projectPath, "utf-8")}`);
      } catch {}
    }

    // 3. Agent identity from {projectRoot}/.clawd/agents.json
    const identity = this.loadAgentIdentity();
    if (identity) {
      contexts.push(`# Agent Identity & Configuration\n\n${identity}`);
    }

    const result = contexts.join("\n\n---\n\n");
    if (result.length > 4000) {
      const suffix = "\n\n[TRUNCATED — CLAWD instructions truncated for context budget]";
      let cutPoint = 4000 - suffix.length;
      if (cutPoint > 0 && cutPoint < result.length) {
        const code = result.charCodeAt(cutPoint - 1);
        if (code >= 0xd800 && code <= 0xdbff) cutPoint--;
      }
      return result.slice(0, cutPoint) + suffix;
    }
    return result;
  }

  /** Clear streaming state on shutdown */
  private async clearStreamingState(): Promise<void> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      await fetch(`${this.config.chatApiUrl}/api/agent.setStreaming`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: this.config.agentId,
          channel: this.config.channel,
          is_streaming: false,
        }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
    } catch {}
  }

  /** Truncate long text with UTF-16 surrogate safety and markdown fence closure */
  private truncateText(text: string, maxLength = MAX_MESSAGE_LENGTH): string {
    return smartTruncate(text, {
      maxLength,
      marker: "\n\n[TRUNCATED — message too long]",
    });
  }

  /** Log with prefix */
  private log(msg: string): void {
    console.log(`[Worker ${this.config.channel}:${this.config.agentId}] ${msg}`);
  }
}

/** Format a tool_result preview into readable text for the agent prompt */
function formatToolResult(tr: NonNullable<Message["tool_result"]>): string {
  const status = tr.status === "succeeded" ? "succeeded" : tr.status === "failed" ? "failed" : "running";
  const lines = [`[Scheduled Tool Call: ${tr.tool_name}] (${status})`, `Description: ${tr.description}`];
  if (tr.args && Object.keys(tr.args).length > 0) {
    lines.push(`Arguments: ${JSON.stringify(tr.args)}`);
  }
  if (tr.error) {
    lines.push(`Error: ${tr.error}`);
  } else if (tr.result != null) {
    const resultStr = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result);
    lines.push(`Result: ${resultStr}`);
  }
  return lines.join("\n");
}
