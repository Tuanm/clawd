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
import { Agent, type AgentConfig } from "./agent/agent";
import { buildAgentSystemPrompt, listAgentFiles, loadAgentFile } from "./agent/agents/loader";
import { callContext } from "./agent/api/call-context";
import { createProvider } from "./agent/api/factory";
import { type ClawdChatConfig, createClawdChatPlugin, createClawdChatToolPlugin } from "./agent/plugins/clawd-chat";
import { createCopilotAnalyticsPlugin } from "./agent/plugins/copilot-analytics-plugin";
import { createMemoryPlugin, isMemoryEnabled } from "./agent/plugins/memory-plugin";
import { createSchedulerToolPlugin } from "./agent/plugins/scheduler-plugin";
import type { PromptContext } from "./agent/prompt/builder";
import { runWithAgentContext, setProjectHash, toolDefinitions } from "./agent/tools/definitions";
import { setDebug } from "./agent/utils/debug";
import { initializeSandbox } from "./agent/utils/sandbox";
import { smartTruncate } from "./agent/utils/smart-truncation";
import { loadConfigFile } from "./config/config-file";
import { db, getAgent, getOrRegisterAgent, markMessagesSeen, setAgentStreaming } from "./server/database";
import { getPendingMessages, postMessage } from "./server/routes/messages";
import { broadcastAgentStreaming, broadcastAgentToken, broadcastUpdate } from "./server/websocket";
import type { TrackedSpace } from "./spaces/spawn-plugin";
import { createLogger } from "./utils/logger";
import { timedFetch } from "./utils/timed-fetch";

const logger = createLogger("WorkerLoop");

// Session size limits (in estimated tokens) — tuned for 128k model context windows.
// WARNING threshold triggers compaction; CRITICAL triggers emergency reset.
const TOKEN_LIMIT_CRITICAL = 70000; // ~55% of 128k — headroom for system prompt + tools
const TOKEN_LIMIT_WARNING = 50000; // ~39% of 128k — start compacting before critical
const COMPACT_KEEP_COUNT = 30; // Recent messages preserved after compaction

// Polling and retry constants.
// POLL_INTERVAL: 200ms balances responsiveness vs CPU; agents check for new messages at this cadence.
const POLL_INTERVAL = 200;
// CONTINUATION_RETRY_DELAY: wait before re-processing seen-but-unprocessed messages (agent may still be writing).
const CONTINUATION_RETRY_DELAY = 2000;
// MAX_CONTINUATION_RETRIES: force-mark as processed after this many retries to prevent infinite loops.
const MAX_CONTINUATION_RETRIES = 5;
// MAX_MESSAGE_LENGTH: individual message truncation limit (chars) — keeps per-message context bounded.
const MAX_MESSAGE_LENGTH = 10000;
// MAX_COMBINED_PROMPT_LENGTH: total prompt size cap (chars) — prevents context overflow for batched messages.
// ~40k chars ≈ ~10k tokens, well within model limits even with system prompt overhead.
const MAX_COMBINED_PROMPT_LENGTH = 40000;
// MAX_WAKEUP_MESSAGES: on wakeup from sleep, only process this many recent messages.
const MAX_WAKEUP_MESSAGES = 3;
// MAX_SYSTEM_INSTRUCTIONS_LENGTH: CLAWD.md + agent identity truncation limit (chars).
// Keeps system instructions bounded so they don't consume too much of the context window.
const MAX_SYSTEM_INSTRUCTIONS_LENGTH = 4000;

// Agent identity loaded from .clawd/agents/{name}.md (or .claude/agents/)

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
  lastHeartbeatAt: number;
  sleeping: boolean;
  running: boolean;
  isSpaceAgent: boolean;
  channel: string;
  agentId: string;
  /** True when the last agent execution ended with stream errors or abnormal termination */
  lastExecutionHadError: boolean;
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
    plugin?: import("./agent/plugins/manager").Plugin;
    toolPlugin?: import("./agent/tools/plugin").ToolPlugin;
  }>;
  /** Shared MCPManager for channel-scoped MCP servers (owned by WorkerManager) */
  channelMcpManager?: import("./agent/mcp/client").MCPManager;
  /**
   * WebSocket URL for push notifications (e.g. ws://localhost:3000/ws).
   * Derived from chatApiUrl by replacing http:// with ws://.
   * When provided, the loop subscribes to its channel and skips idle sleep
   * on push events — falling back to poll-only when WS is unavailable.
   */
  wsUrl?: string;
  /**
   * Use direct DB function calls instead of HTTP self-calls for polling and writes.
   * Default true for in-process agents; set false for external/remote workers that
   * must go through the HTTP API (e.g. workerToken-based remote workers).
   */
  directDb?: boolean;
  /** Per-agent heartbeat interval in seconds (0 or undefined = disabled) */
  heartbeatInterval?: number;
  /** Auth token for internal HTTP self-calls (Authorization: Bearer <token>) */
  authToken?: string;
  /** Agent file config for sub-agents spawned with agent= parameter */
  agentFileConfig?: import("./agent/agents/loader").AgentFileConfig;
  /** Git worktree path (undefined = not using worktree isolation) */
  worktreePath?: string;
  /** Git worktree branch name, e.g., "clawd/a3f7b2" */
  worktreeBranch?: string;
  /** Original project root before worktree override */
  originalProjectRoot?: string;
}

/**
 * Shared interface for agent workers in WorkerManager.
 * Implemented by WorkerLoop (normal agents) and ClaudeCodeMainWorker (claude-code agents).
 */
export interface AgentWorker {
  start(): void;
  stop(): void | Promise<void>;
  readonly isSleeping: boolean;
  readonly isRunning: boolean;
  setSleeping(sleeping: boolean): void;
  getHealthSnapshot(): AgentHealthSnapshot;
  cancelProcessing(): void;
  /** Project root for worktree info (optional — not all workers use worktrees) */
  getProjectRoot?(): string;
  /** Reset agent session (e.g., on channel clear). Returns promise for async cleanup. */
  resetSession?(): Promise<void>;
  /** Heartbeat interval in seconds (0 = disabled) */
  readonly heartbeatInterval: number;
  /** Inject a heartbeat signal to wake idle agents */
  injectHeartbeat?(): void;
}

export class WorkerLoop implements AgentWorker {
  private config: WorkerLoopConfig;
  private running = false;
  private sleeping = false;
  private wasSleeping = false;
  private isFirstPoll = true; // Track first poll for new-agent onboarding
  private isProcessing = false;
  private abortController: AbortController | null = null;
  private activeAgent: import("./agent/agent").Agent | null = null;
  private stoppedPromise: { resolve: () => void } | null = null;
  private trackedSpaces = new Map<string, TrackedSpace>();

  // Heartbeat health tracking
  private lastActivityAt: number = Date.now();
  private processingStartedAt: number | null = null;
  private lastHeartbeatAt: number = Date.now();
  private remoteWorkerBridge: import("./agent/plugins/remote-worker-bridge").RemoteWorkerBridge | null = null;
  private remoteWorkerBridgeReady: Promise<void> | null = null;
  private heartbeatPending = false;

  // Continuation retry cap (Layer 5 — stream resilience)
  private continuationRetryCount = 0;
  private lastContinuationBatchHash: string | null = null;

  // Idle backoff: ramp poll interval when no messages pending (200ms → 5s)
  // With WS push, 5s fallback is safe: push events skip the sleep entirely.
  private idlePollMs = POLL_INTERVAL;
  private static readonly MAX_IDLE_POLL = 5000;

  // WebSocket push notification state
  private ws: WebSocket | null = null;
  private wsReconnectTimer: Timer | null = null;
  private wsReconnectDelay = 1000; // ms, doubles on each failure (max 5s)
  private static readonly WS_MAX_RECONNECT = 5000;
  /** Set to true by WS push handler; cleared after each poll. */
  private hasNewMessages = false;

  // Skip redundant markSeen writes
  private lastMarkedSeenTs: string | null = null;

  // Skip first poll delay for freshly spawned agents
  private firstPoll = true;

  // Track whether last execution ended abnormally (for heartbeat idle-agent detection)
  private lastExecutionHadError = false;
  // Set by cancelProcessing() so error detection survives the cancel→return flow
  private wasCancelledByHeartbeat = false;

  constructor(config: WorkerLoopConfig) {
    this.config = config;
  }

  /** Build Authorization header for internal HTTP self-calls, if auth is configured. */
  private authHeaders(): Record<string, string> {
    const token = this.config.authToken;
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
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

  /** Canonical session name for this agent (shared between loop and resetSession) */
  private get sessionName(): string {
    return `${this.config.channel}-${this.config.agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  }

  /** Set sleeping state */
  setSleeping(sleeping: boolean): void {
    if (sleeping) {
      this.sleeping = true;
      // Clear any pending heartbeat so it doesn't fire on wake
      this.heartbeatPending = false;
      // Cancel in-flight processing so the agent stops immediately
      if (this.isProcessing && this.activeAgent) {
        try {
          this.activeAgent.cancel();
        } catch {
          // Intentionally swallowed — cancel() during stop is best-effort; loop exits regardless
        }
      }
    } else {
      if (this.sleeping) this.wasSleeping = true;
      this.sleeping = false;
      // Reset idle backoff when waking so the agent polls immediately at full speed
      this.idlePollMs = POLL_INTERVAL;
    }
    this.log(sleeping ? "Agent sleeping" : "Agent awake");
  }

  /** Expose health snapshot for the centralized heartbeat monitor (pure read, no side effects) */
  getProjectRoot(): string {
    return this.config.projectRoot;
  }

  getHealthSnapshot(): AgentHealthSnapshot {
    const now = Date.now();
    return {
      processing: this.isProcessing,
      processingDurationMs: this.processingStartedAt ? now - this.processingStartedAt : null,
      lastActivityAt: this.lastActivityAt,
      idleDurationMs: this.isProcessing ? 0 : now - this.lastActivityAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      sleeping: this.sleeping,
      running: this.running,
      isSpaceAgent: !!this.config.isSpaceAgent,
      channel: this.config.channel,
      agentId: this.config.agentId,
      lastExecutionHadError: this.lastExecutionHadError,
    };
  }

  /** Expose the configured heartbeat interval for this agent (seconds, 0 = disabled) */
  get heartbeatInterval(): number {
    return this.config.heartbeatInterval || 0;
  }

  /** Cancel hung agent processing (called by WorkerManager heartbeat) */
  cancelProcessing(): void {
    try {
      const agent = this.activeAgent;
      if (agent) {
        this.log("Heartbeat: cancelling hung agent");
        agent.cancel();
        this.wasCancelledByHeartbeat = true;
        // Do NOT set isProcessing = false — let executePrompt's finally block handle it
      }
    } catch {
      // Ignore cancel errors (matches existing pattern in stop())
    }
  }

  /**
   * Inject a heartbeat signal into the agent's poll loop.
   * The heartbeat is sent as a synthetic user-role message to the LLM (not posted to chat).
   * Only fires when agent is idle (not processing, not sleeping).
   */
  injectHeartbeat(): void {
    if (!this.running || this.sleeping || this.isProcessing) return;
    this.heartbeatPending = true;
    this.lastHeartbeatAt = Date.now();
  }

  /**
   * Cancel the currently running agent and delete its persisted session so the
   * next run starts with a clean slate (used by the /clear command).
   */
  async resetSession(): Promise<void> {
    if (this.activeAgent) {
      try {
        this.activeAgent.cancel();
      } catch {
        // Intentionally swallowed — cancel() during session reset is best-effort
      }
    }
    // Delete the session via the SessionManager singleton to avoid
    // opening a second SQLite connection (which risks SQLITE_BUSY
    // if the singleton is mid-write).
    try {
      const { getSessionManager } = await import("./agent/session/manager");
      const sm = getSessionManager();
      const session = sm.getSession(this.sessionName);
      if (session) {
        sm.deleteSession(session.id);
        this.log(`Session reset: deleted session ${session.id} (${this.sessionName})`);
      }
    } catch (err) {
      this.log(`Session reset error: ${err}`);
    }
  }

  /** Start the polling loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.continuationRetryCount = 0;
    this.lastContinuationBatchHash = null;
    this.lastExecutionHadError = false;
    this.wasCancelledByHeartbeat = false;
    this.heartbeatPending = false;
    this.lastHeartbeatAt = Date.now();
    this.abortController = new AbortController();
    // Reset sleeping state on fresh start — prevents stale sleeping state from
    // an old loop (e.g. after provider change + restart) blocking message polling.
    this.sleeping = false;
    this.log("Starting worker loop");

    // Initialize remote worker bridge if this agent has a workerToken
    // The promise is awaited in loop() before first agent execution
    if (this.config.workerToken && this.config.channelMcpManager) {
      this.remoteWorkerBridgeReady = import("./agent/plugins/remote-worker-bridge")
        .then(async ({ RemoteWorkerBridge }) => {
          if (!this.running) return;
          this.remoteWorkerBridge = new RemoteWorkerBridge(
            this.config.channelMcpManager!,
            this.config.channel,
            this.config.workerToken,
          );
          await this.remoteWorkerBridge.init();
        })
        .catch((err) => this.log(`RemoteWorkerBridge init error: ${err}`));
    }

    this.connectWebSocket();
    this.loop();
  }

  /** Stop the polling loop and cancel any active agent */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.log("Stopping worker loop");
    this.running = false;
    this.disconnectWebSocket();
    this.abortController?.abort();
    // Cancel the active agent if one is running
    if (this.activeAgent) {
      try {
        this.activeAgent.cancel();
      } catch {
        // Intentionally swallowed — cancel() during shutdown is best-effort
      }
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

    // Destroy remote worker bridge
    if (this.remoteWorkerBridge) {
      this.remoteWorkerBridge.destroy();
      this.remoteWorkerBridge = null;
    }

    // Tunnels are intentionally persistent now (tmux-backed, survive worker
    // and process restart). The old destroyAll() SIGTERM'd in-process
    // cloudflared children on shutdown — inverting that behavior. Kept as
    // a noop call for backwards compat; use `tunnel_prune` to sweep when
    // desired, or `tunnelManager.prune({ deadOnly: true })` programmatically.
    try {
      const { TunnelPlugin } = await import("./agent/plugins/tunnel-plugin");
      TunnelPlugin.destroyAll(); // noop — see TunnelPlugin.destroyAll() docstring.
    } catch {
      // Intentionally swallowed — TunnelPlugin lookup is best-effort on shutdown.
    }
  }

  // ===========================================================================
  // WebSocket push notification — reduces idle polling latency
  // ===========================================================================

  /**
   * Open a WebSocket connection to the chat server and subscribe to this
   * agent's channel. On receiving a `message` event for the channel, sets
   * `hasNewMessages = true` so the poll loop skips its idle sleep and picks
   * up the message immediately.
   *
   * Reconnects automatically with exponential backoff (max 5 s).
   * Fails gracefully: if WS is unavailable the loop continues in poll-only mode.
   */
  private connectWebSocket(): void {
    const wsUrl = this.config.wsUrl;
    if (!wsUrl) return;

    const { channel, agentId } = this.config;
    const url = `${wsUrl}?user=UBOT&agent_id=${encodeURIComponent(agentId)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.log(`WS: failed to create connection (poll-only mode): ${err}`);
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      this.wsReconnectDelay = 1000; // Reset backoff on successful connect
      ws.send(JSON.stringify({ type: "subscribe", channel }));
      this.log(`WS: connected and subscribed to channel ${channel}`);
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
        if (data.type === "message" && data.channel === channel) {
          this.hasNewMessages = true;
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onerror = () => {
      // onclose fires right after onerror; reconnect is handled there
    };

    ws.onclose = () => {
      this.ws = null;
      if (!this.running) return; // Stopped intentionally — don't reconnect
      this.scheduleWsReconnect();
    };
  }

  /** Tear down the WebSocket connection and cancel any pending reconnect timer */
  private disconnectWebSocket(): void {
    if (this.wsReconnectTimer !== null) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Intentionally swallowed — WebSocket close during teardown is best-effort
      }
      this.ws = null;
    }
  }

  /** Schedule a reconnect attempt with exponential backoff (max 5 s) */
  private scheduleWsReconnect(): void {
    const delay = this.wsReconnectDelay;
    this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, WorkerLoop.WS_MAX_RECONNECT);
    this.log(`WS: reconnecting in ${delay}ms`);
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      if (this.running) this.connectWebSocket();
    }, delay);
  }

  /** Main polling loop */
  private async loop(): Promise<void> {
    const { channel, agentId } = this.config;

    this.log(`Session: ${this.sessionName}`);

    // Wait for remote worker bridge to initialize before processing messages
    if (this.remoteWorkerBridgeReady) {
      await this.remoteWorkerBridgeReady;
      this.remoteWorkerBridgeReady = null;
    }

    while (this.running) {
      try {
        if (this.isProcessing) {
          await Bun.sleep(POLL_INTERVAL);
          continue;
        }

        // Skip if agent is sleeping — poll much less frequently (5s vs 200ms)
        if (this.sleeping) {
          await Bun.sleep(5000);
          continue;
        }

        // Poll for pending messages (single DB query, reused for both heartbeat check and message processing)
        const result = await this.pollPending();

        // If a heartbeat is pending, only process it if no real messages are waiting.
        // This prevents heartbeat from starving user messages (even when WS push is missed).
        if (this.heartbeatPending) {
          const hasRealMessages = this.hasNewMessages || (result.ok && result.pending.length > 0);
          this.heartbeatPending = false;
          if (!hasRealMessages) {
            const heartbeatPrompt = `[HEARTBEAT]${this.getActiveSubAgentReminder()}`;
            broadcastAgentToken(this.config.channel, this.config.agentId, "[HEARTBEAT]", "event");
            this.isProcessing = true;
            this.processingStartedAt = Date.now();
            this.wasCancelledByHeartbeat = false;
            try {
              const execResult = await this.executePrompt(heartbeatPrompt, this.sessionName);
              const output = execResult.output || "";
              this.lastExecutionHadError =
                !execResult.success ||
                this.wasCancelledByHeartbeat ||
                output.includes("[Agent stopped") ||
                output.includes("[stream error");
              this.wasCancelledByHeartbeat = false;
            } finally {
              this.isProcessing = false;
              this.processingStartedAt = null;
              this.lastActivityAt = Date.now();
              this.stoppedPromise?.resolve();
              this.stoppedPromise = null;
            }
            continue;
          }
          // Real messages exist — skip heartbeat, fall through to process them
        }

        if (result.ok && result.pending.length > 0) {
          // Snap back to fast polling when messages arrive
          this.idlePollMs = POLL_INTERVAL;

          if (result.unseen.length > 0) {
            this.log(`Found ${result.unseen.length} new message(s)`);
          }
          if (result.seenNotProcessed.length > 0 && result.unseen.length === 0) {
            this.log(`Found ${result.seenNotProcessed.length} seen-but-not-processed message(s)`);
          }

          const isContinuation = result.unseen.length === 0 && result.seenNotProcessed.length > 0;

          if (isContinuation) {
            // Track continuation retries per batch to prevent infinite loops (Layer 5)
            const batchHash = result.seenNotProcessed.map((m) => m.ts).join(",");
            if (batchHash === this.lastContinuationBatchHash) {
              this.continuationRetryCount++;
            } else {
              this.continuationRetryCount = 1;
              this.lastContinuationBatchHash = batchHash;
            }

            if (this.continuationRetryCount >= MAX_CONTINUATION_RETRIES) {
              this.log(
                `Max continuation retries (${MAX_CONTINUATION_RETRIES}) reached for batch, force-marking processed`,
              );
              const maxTs = result.seenNotProcessed.reduce((max, m) => (m.ts > max ? m.ts : max), "0");
              const marked = await this.forceMarkProcessed(maxTs);
              if (marked) {
                this.continuationRetryCount = 0;
                this.lastContinuationBatchHash = null;
                try {
                  await this.sendMessage(
                    `[ERROR] Agent failed to process messages after ${MAX_CONTINUATION_RETRIES} retries. Skipping to avoid infinite loop.`,
                  );
                } catch {
                  /* best-effort notification */
                }
              } else {
                // Backoff before retrying force-mark to avoid tight loop
                this.log("Force-mark failed, will retry after backoff");
                await Bun.sleep(CONTINUATION_RETRY_DELAY * 2);
              }
              continue;
            }

            this.log(
              `Waiting ${CONTINUATION_RETRY_DELAY}ms before retrying (attempt ${this.continuationRetryCount}/${MAX_CONTINUATION_RETRIES})...`,
            );
            await Bun.sleep(CONTINUATION_RETRY_DELAY);
          } else if (this.continuationRetryCount > 0) {
            // Reset continuation counter when we exit continuation mode (new messages arrived or success)
            this.continuationRetryCount = 0;
            this.lastContinuationBatchHash = null;
          }

          // Wakeup / new-agent onboarding: if agent just woke from sleep OR is brand new
          // with many pending messages, skip old ones and only process recent with context summary
          const isNewAgent = this.isFirstPoll && !isContinuation && result.pending.length > MAX_WAKEUP_MESSAGES;
          this.isFirstPoll = false;
          const shouldTruncate =
            (this.wasSleeping || isNewAgent) && !isContinuation && result.pending.length > MAX_WAKEUP_MESSAGES;

          if (shouldTruncate) {
            this.wasSleeping = false;
            const skipped = result.pending.length - MAX_WAKEUP_MESSAGES;
            const skippedMessages = result.pending.slice(0, skipped);
            result.pending = result.pending.slice(skipped);

            // Mark skipped messages as processed
            const lastSkippedTs = skippedMessages[skippedMessages.length - 1].ts;
            if (this.config.directDb !== false) {
              try {
                db.run(
                  `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
                   VALUES (?, ?, ?, ?, strftime('%s', 'now'))
                   ON CONFLICT(agent_id, channel) DO UPDATE SET
                     last_processed_ts = MAX(COALESCE(last_processed_ts, '0'), ?),
                     updated_at = strftime('%s', 'now')`,
                  [this.config.agentId, this.config.channel, lastSkippedTs, lastSkippedTs, lastSkippedTs],
                );
              } catch {
                // Intentionally swallowed — best-effort lastSkippedTs persistence; polling continues regardless
              }
            }

            // Build conversation summary
            const convoLines = skippedMessages.map((m: any) => {
              const user = m.user === "UHUMAN" ? "Human" : m.agent_id || m.user || "unknown";
              return `${user}: ${(m.text || "").slice(0, 200).replace(/\n/g, " ")}`;
            });

            const contextLabel = isNewAgent
              ? `[ONBOARDING] You've just been added to this channel.`
              : `[WAKEUP] You've just woken up from sleep.`;
            const contextDesc = isNewAgent
              ? `This channel already has ${skipped} message(s) of prior conversation.`
              : `While you were sleeping, ${skipped} message(s) were exchanged on this channel.`;

            result.pending.unshift({
              ts: "0",
              user: "UHUMAN",
              text: [
                contextLabel,
                ``,
                contextDesc,
                `Here is a summary of the prior conversation (already processed — do NOT call chat_mark_processed for any of these):`,
                ``,
                `--- Prior conversation ---`,
                convoLines.join("\n"),
                `--- End of prior conversation ---`,
                ``,
                `Now focus ONLY on the new message(s) below. Use the prior conversation as context to understand what happened, but only respond to the new messages.`,
              ].join("\n"),
            } as any);

            this.log(
              `${isNewAgent ? "New agent onboarding" : "Wakeup"}: skipped ${skipped} old messages, processing ${result.pending.length - 1} recent`,
            );
          } else {
            this.wasSleeping = false;
          }

          this.isProcessing = true;
          this.processingStartedAt = Date.now();
          this.wasCancelledByHeartbeat = false;
          let lastExecHadUnsentText = false;

          // Track current batch timestamps for interrupt detection
          const currentBatchTs = new Set(result.pending.map((m) => m.ts));

          // Interrupt poller — cancels active agent if new messages arrive from
          // any channel member (human or other agents — all are collaborators)
          let wlInterrupted = false;
          const wlInterruptMessageMap = new Map<string, any>();
          const wlInterruptPoller = setInterval(() => {
            if (!this.isProcessing) return;
            try {
              const pollResult = this.pollPendingDirect();
              if (!pollResult.ok) return;
              const newMsgs = pollResult.pending.filter(
                (m) => !currentBatchTs.has(m.ts) && !wlInterruptMessageMap.has(m.ts),
              );
              if (newMsgs.length > 0) {
                wlInterrupted = true;
                for (const m of newMsgs) wlInterruptMessageMap.set(m.ts, m);
                this.log(`Interrupted by ${newMsgs.length} new message(s)`);
                // Cancel the active agent
                try {
                  this.activeAgent?.cancel();
                } catch {
                  // Intentionally swallowed — cancel() during interrupt detection is best-effort
                }
              }
            } catch (e) {
              // Polling errors during interrupt detection are non-fatal
              this.log(`Interrupt poll error: ${e}`);
            }
          }, 2000);

          try {
            let prompt: string;
            if (isContinuation) {
              prompt = this.buildContinuationPrompt(result.seenNotProcessed);
            } else if (result.unseen.length > 0 && result.seenNotProcessed.length > 0) {
              // Mixed: some messages are brand-new, some were seen but not processed.
              // Differentiate in the prompt so the agent knows which it has already engaged with.
              prompt = this.buildMixedPrompt(result.seenNotProcessed, result.unseen);
            } else {
              prompt = this.buildPrompt(result.seenNotProcessed, result.unseen);
            }

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

            const execResult = await this.executePrompt(prompt, this.sessionName);
            lastExecHadUnsentText = !execResult.chatSent && execResult.hadStreamText;

            // Track whether this execution ended with an error (for heartbeat idle-agent detection)
            const output = execResult.output || "";
            this.lastExecutionHadError =
              !execResult.success ||
              this.wasCancelledByHeartbeat ||
              output.includes("[Agent stopped") ||
              output.includes("[stream error");
            this.wasCancelledByHeartbeat = false;

            if (!execResult.success && !wlInterrupted) {
              this.log("Prompt execution failed");
              await this.sendMessage(`[ERROR] ${execResult.output || "Unexpected error"}`);
            }

            // Re-injection: if agent completed without calling chat_mark_processed,
            // send a follow-up prompt so it can mark the messages as processed.
            // Skip for: heartbeat turns, continuation prompts, cancelled turns, or if already called.
            if (!execResult.markProcessed && !isContinuation && !this.wasCancelledByHeartbeat && !wlInterrupted) {
              const lastTs = result.pending[result.pending.length - 1]?.ts || "";
              const reminderPrompt =
                `[NOTICE: You completed your turn but did not call \`chat_mark_processed\` to mark the message(s) as handled. ` +
                `This is required so the same messages are not polled again.\n\n` +
                `Call \`chat_mark_processed(timestamp="${lastTs}")\` now, even if empty. ` +
                `If you intentionally did not need to respond, produce only [SILENT].]`;

              try {
                await this.executePrompt(reminderPrompt, this.sessionName);
                this.log("Mark-processed re-injection: ok");
              } catch (err) {
                this.log(`Mark-processed re-injection failed: ${err}`);
              }
            }
          } finally {
            clearInterval(wlInterruptPoller);
            this.isProcessing = false;
            this.processingStartedAt = null;
            this.lastActivityAt = Date.now();
            this.stoppedPromise?.resolve();
            this.stoppedPromise = null;
          }

          // Handle interrupt: advance cursor past current batch, then process new messages
          if (wlInterrupted) {
            // Advance cursor past the interrupted batch
            const lastBatchTs = result.pending[result.pending.length - 1]?.ts;
            if (lastBatchTs) {
              try {
                db.run(
                  `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
                   VALUES (?, ?, ?, ?, strftime('%s', 'now'))
                   ON CONFLICT(agent_id, channel) DO UPDATE SET
                     last_processed_ts = MAX(COALESCE(last_processed_ts, '0'), ?),
                     updated_at = strftime('%s', 'now')`,
                  [this.config.agentId, this.config.channel, lastBatchTs, lastBatchTs, lastBatchTs],
                );
              } catch {
                // Intentionally swallowed — best-effort lastBatchTs cursor advance; loop continues regardless
              }
            }

            // Infinite interrupt loop — each resume turn can itself be interrupted,
            // allowing the user to redirect the agent as many times as needed.
            let wlResumeProcessingMsgs: Message[] = isContinuation ? result.seenNotProcessed : result.pending;
            let wlResumeInterruptMsgs: any[] = Array.from(wlInterruptMessageMap.values());
            let wlLastExecHadUnsentText = lastExecHadUnsentText;

            while (wlResumeInterruptMsgs.length > 0 && this.running) {
              this.isProcessing = true;
              this.processingStartedAt = Date.now();
              this.wasCancelledByHeartbeat = false;

              // Interrupt poller for this resume turn — enables infinite chained interrupts
              let wlResumeInterrupted = false;
              const wlResumeInterruptMap = new Map<string, any>();
              const wlResumeSeenTs = new Set(wlResumeInterruptMsgs.map((m: any) => m.ts));
              const wlResumePoller = setInterval(() => {
                if (!this.isProcessing) return;
                try {
                  const pollResult = this.pollPendingDirect();
                  if (!pollResult.ok) return;
                  const newMsgs = pollResult.pending.filter(
                    (m) => !wlResumeSeenTs.has(m.ts) && !wlResumeInterruptMap.has(m.ts),
                  );
                  if (newMsgs.length > 0) {
                    wlResumeInterrupted = true;
                    for (const m of newMsgs) wlResumeInterruptMap.set(m.ts, m);
                    this.log(`Resume interrupted by ${newMsgs.length} new message(s)`);
                    try {
                      this.activeAgent?.cancel();
                    } catch {
                      // Intentionally swallowed — cancel() during resume interrupt is best-effort
                    }
                  }
                } catch (e) {
                  this.log(`Resume interrupt poll error: ${e}`);
                }
              }, 2000);

              try {
                let interruptPrompt = this.buildInterruptPrompt(
                  wlResumeProcessingMsgs,
                  wlResumeInterruptMsgs,
                  wlLastExecHadUnsentText,
                );
                // Hard-truncation guard (same as buildPrompt path)
                if (interruptPrompt.length > MAX_COMBINED_PROMPT_LENGTH) {
                  const suffix = `\n\n[TRUNCATED — interrupt prompt exceeded ${MAX_COMBINED_PROMPT_LENGTH} character budget]`;
                  let cutPoint = MAX_COMBINED_PROMPT_LENGTH - suffix.length;
                  if (cutPoint > 0 && cutPoint < interruptPrompt.length) {
                    const code = interruptPrompt.charCodeAt(cutPoint - 1);
                    if (code >= 0xd800 && code <= 0xdbff) cutPoint--;
                  }
                  interruptPrompt = interruptPrompt.slice(0, cutPoint) + suffix;
                }
                const resumeResult = await this.executePrompt(interruptPrompt, this.sessionName);
                wlLastExecHadUnsentText = !resumeResult.chatSent && resumeResult.hadStreamText;
                const output = resumeResult.output || "";
                this.lastExecutionHadError =
                  !resumeResult.success || output.includes("[Agent stopped") || output.includes("[stream error");
              } catch (err: unknown) {
                if (!this.wasCancelledByHeartbeat) {
                  const msg = err instanceof Error ? err.message : String(err);
                  this.log(`Interrupt processing error: ${msg}`);
                }
              } finally {
                clearInterval(wlResumePoller);
                this.isProcessing = false;
                this.processingStartedAt = null;
                this.lastActivityAt = Date.now();
                this.stoppedPromise?.resolve();
                this.stoppedPromise = null;
              }

              if (wlResumeInterrupted) {
                // Advance cursor past the resume batch and prepare for next iteration
                const lastResumeTs = wlResumeInterruptMsgs[wlResumeInterruptMsgs.length - 1]?.ts;
                if (lastResumeTs) {
                  try {
                    db.run(
                      `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
                       VALUES (?, ?, ?, ?, strftime('%s', 'now'))
                       ON CONFLICT(agent_id, channel) DO UPDATE SET
                         last_processed_ts = MAX(COALESCE(last_processed_ts, '0'), ?),
                         updated_at = strftime('%s', 'now')`,
                      [this.config.agentId, this.config.channel, lastResumeTs, lastResumeTs, lastResumeTs],
                    );
                  } catch {
                    // Intentionally swallowed — best-effort lastResumeTs cursor advance; loop continues regardless
                  }
                }
                wlResumeProcessingMsgs = wlResumeInterruptMsgs as Message[];
                wlResumeInterruptMsgs = Array.from(wlResumeInterruptMap.values());
                wlLastExecHadUnsentText = false;
              } else {
                break;
              }
            }
            continue;
          }
        }
      } catch (error) {
        this.log(`Loop error (continuing): ${error}`);
        this.isProcessing = false;
        this.processingStartedAt = null;
        this.lastActivityAt = Date.now();
        this.lastExecutionHadError = true;
        this.wasCancelledByHeartbeat = false;
        this.stoppedPromise?.resolve();
        this.stoppedPromise = null;
      }

      // Skip first poll delay for freshly spawned agents (task already posted)
      if (this.firstPoll) {
        this.firstPoll = false;
      } else if (this.hasNewMessages) {
        // WS push arrived — skip idle sleep and poll immediately, then reset flag.
        this.hasNewMessages = false;
        this.idlePollMs = POLL_INTERVAL; // Snap back to fast polling
      } else {
        // Idle backoff: sleep using current interval, then ramp up if idle.
        // WS push events make the higher max (5s) safe — push triggers immediate poll.
        // idlePollMs snaps back to POLL_INTERVAL when messages are found (above).
        await Bun.sleep(this.idlePollMs);
        if (!this.isProcessing) {
          this.idlePollMs = Math.min(this.idlePollMs * 2, WorkerLoop.MAX_IDLE_POLL);
        }
      }
    }
    // Notify that the loop has exited (used by space workers to settle promises)
    this.config.onLoopExit?.();
  }

  /** Poll for pending messages — delegates to direct DB or HTTP based on config */
  private async pollPending(): Promise<PollResult> {
    if (this.config.directDb !== false) {
      return this.pollPendingDirect();
    }
    return this.pollPendingHttp();
  }

  /** Direct DB poll — eliminates TCP/HTTP/JSON overhead for in-process agents */
  private pollPendingDirect(): PollResult {
    const { agentId, channel } = this.config;
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
      // Single query replaces two HTTP round-trips (getLastSeen + getLastProcessed)
      const seenRow = db
        .query<{ last_seen_ts: string | null; last_processed_ts: string | null }, [string, string]>(
          `SELECT last_seen_ts, last_processed_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
        )
        .get(agentId, channel);

      const serverLastSeen = seenRow?.last_seen_ts ?? null;
      const serverLastProcessed = seenRow?.last_processed_ts ?? null;

      // Fetch pending messages directly
      const pendingData = getPendingMessages(channel, serverLastProcessed ?? undefined, true, 50);
      if (!pendingData.ok) return { ...empty, serverLastProcessed, serverLastSeen };

      const messages = pendingData.messages as Message[];

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

      // Mark all messages as seen — skip write when maxTs hasn't changed
      if (messages.length > 0) {
        const maxTs = messages.reduce((max, m) => (m.ts > max ? m.ts : max), "0");
        if (maxTs !== this.lastMarkedSeenTs) {
          this.markSeenDirect(agentId, channel, maxTs);
          this.lastMarkedSeenTs = maxTs;
        }
      }

      return {
        ok: true,
        messages,
        pending,
        unseen,
        seenNotProcessed,
        serverLastProcessed,
        serverLastSeen,
      };
    } catch (error) {
      this.log(`Poll error (direct): ${error}`);
      return empty;
    }
  }

  /** Write markSeen directly to DB (mirrors agent.markSeen route logic) */
  private markSeenDirect(agentId: string, channel: string, lastSeenTs: string): void {
    const nowTs = Math.floor(Date.now() / 1000);
    getOrRegisterAgent(agentId, channel);
    db.run(
      `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_poll_ts, updated_at)
       VALUES (?, ?, ?, ?, strftime('%s', 'now'))
       ON CONFLICT(agent_id, channel) DO UPDATE SET
         last_seen_ts = excluded.last_seen_ts,
         last_poll_ts = excluded.last_poll_ts,
         updated_at = strftime('%s', 'now')`,
      [agentId, channel, lastSeenTs, nowTs],
    );

    // Mark individual messages seen in message_seen table
    const messagesToMark = db
      .query<{ ts: string }, [string, string, string, number]>(
        `SELECT ts FROM messages WHERE channel = ? AND ts <= ? AND (agent_id IS NULL OR agent_id != ?) ORDER BY ts DESC LIMIT ?`,
      )
      .all(channel, lastSeenTs, agentId, 200);
    if (messagesToMark.length > 0) {
      markMessagesSeen(
        channel,
        agentId,
        messagesToMark.map((m) => m.ts),
      );
    }

    // Wake agent from hibernate
    db.run(
      `UPDATE agent_status SET status = 'ready', hibernate_until = NULL, updated_at = strftime('%s', 'now')
       WHERE agent_id = ? AND channel = ? AND status = 'hibernate'`,
      [agentId, channel],
    );

    // Single consolidated broadcast instead of 3 separate ones
    const lastNonSelfMsg = db
      .query<{ ts: string }, [string, string, string]>(
        `SELECT ts FROM messages WHERE channel = ? AND ts <= ? AND (agent_id IS NULL OR agent_id != ?) ORDER BY ts DESC LIMIT 1`,
      )
      .get(channel, lastSeenTs, agentId);
    const agentData = getAgent(agentId, channel);
    broadcastUpdate(channel, {
      type: "agent_poll",
      agent_id: agentId,
      last_seen_ts: lastSeenTs,
      message_seen_ts: lastNonSelfMsg?.ts || null,
      status: "ready",
      hibernate_until: null,
      avatar_color: agentData?.avatar_color || "#D97853",
    });
  }

  /** HTTP poll — fallback for external/remote workers that cannot access DB directly */
  private async pollPendingHttp(): Promise<PollResult> {
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
      const [lastSeenRes, lastProcessedRes] = await Promise.all([
        timedFetch(`${chatApiUrl}/api/agent.getLastSeen?agent_id=${agentId}&channel=${channel}`, {
          headers: this.authHeaders(),
        }),
        timedFetch(`${chatApiUrl}/api/agent.getLastProcessed?agent_id=${agentId}&channel=${channel}`, {
          headers: this.authHeaders(),
        }),
      ]);

      const lastSeenData = (await lastSeenRes.json()) as any;
      const lastProcessedData = (await lastProcessedRes.json()) as any;

      const serverLastSeen = lastSeenData.ok ? lastSeenData.last_seen_ts : null;
      const serverLastProcessed = lastProcessedData.ok ? lastProcessedData.last_processed_ts : null;

      // Pass last_processed_ts to avoid fetching already-processed messages (95% payload reduction when idle)
      const pendingUrl = serverLastProcessed
        ? `${chatApiUrl}/api/messages.pending?channel=${channel}&include_bot=true&limit=50&last_ts=${serverLastProcessed}`
        : `${chatApiUrl}/api/messages.pending?channel=${channel}&include_bot=true&limit=50`;
      const res = await timedFetch(pendingUrl, { headers: this.authHeaders() });
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

      // Mark all messages as seen — skip write when maxTs hasn't changed
      if (messages.length > 0) {
        const maxTs = messages.reduce((max, m) => (m.ts > max ? m.ts : max), "0");
        if (maxTs !== this.lastMarkedSeenTs) {
          await timedFetch(`${chatApiUrl}/api/agent.markSeen`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...this.authHeaders(),
            },
            body: JSON.stringify({
              agent_id: agentId,
              channel,
              last_seen_ts: maxTs,
            }),
          });
          this.lastMarkedSeenTs = maxTs;
        }
      }

      return {
        ok: true,
        messages,
        pending,
        unseen,
        seenNotProcessed,
        serverLastProcessed,
        serverLastSeen,
      };
    } catch (error) {
      this.log(`Poll error: ${error}`);
      return empty;
    }
  }

  /** Send a message to the channel */
  private async sendMessage(text: string): Promise<boolean> {
    if (this.config.directDb !== false) {
      try {
        const result = postMessage({
          channel: this.config.channel,
          text,
          user: "UBOT",
          agent_id: this.config.agentId,
        });
        if (result.ok && result.message) {
          broadcastUpdate(this.config.channel, result.message);
        }
        return result.ok;
      } catch {
        return false;
      }
    }
    try {
      const res = await timedFetch(`${this.config.chatApiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          channel: this.config.channel,
          text,
          user: "UBOT",
          agent_id: this.config.agentId,
        }),
      });
      const data = (await res.json()) as any;
      return data.ok;
    } catch {
      return false;
    }
  }

  /** Force-mark messages as processed (Layer 5 — continuation cap) */
  private async forceMarkProcessed(ts: string): Promise<boolean> {
    if (this.config.directDb !== false) {
      try {
        const { agentId, channel } = this.config;
        getOrRegisterAgent(agentId, channel);
        db.run(
          `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
           VALUES (?, ?, ?, ?, strftime('%s', 'now'))
           ON CONFLICT(agent_id, channel) DO UPDATE SET
             last_processed_ts = MAX(COALESCE(last_processed_ts, '0'), excluded.last_processed_ts),
             updated_at = strftime('%s', 'now')`,
          [agentId, channel, ts, ts],
        );
        broadcastUpdate(channel, {
          type: "agent_processed",
          agent_id: agentId,
          last_processed_ts: ts,
        });
        this.log(`Force-marked processed up to ts=${ts}`);
        return true;
      } catch (err) {
        this.log(`Failed to force markProcessed (direct): ${err}`);
        return false;
      }
    }
    try {
      const res = await timedFetch(`${this.config.chatApiUrl}/api/agent.setLastProcessed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          agent_id: this.config.agentId,
          channel: this.config.channel,
          last_processed_ts: ts,
        }),
      });
      const data = (await res.json()) as any;
      if (!data.ok) {
        this.log(`Force-mark API returned not ok`);
        return false;
      }
      this.log(`Force-marked processed up to ts=${ts}`);
      return true;
    } catch (err) {
      this.log(`Failed to force markProcessed: ${err}`);
      return false;
    }
  }

  /**
   * Collapse consecutive bot messages with identical or near-identical text from
   * the same author into a single entry with a repeat count. Human messages are
   * never collapsed — every human message is significant.
   */
  private deduplicateMessages(messages: Message[]): Message[] {
    if (messages.length <= 1) return messages;
    const result: (Message & { _repeatCount?: number })[] = [];
    for (const m of messages) {
      const prev = result[result.length - 1];
      // Never collapse human messages
      if (m.user === "UHUMAN" || !prev || prev.user === "UHUMAN") {
        result.push({ ...m, _repeatCount: 1 });
        continue;
      }
      // Same author?
      const prevAuthor = prev.agent_id || prev.user;
      const curAuthor = m.agent_id || m.user;
      if (prevAuthor !== curAuthor) {
        result.push({ ...m, _repeatCount: 1 });
        continue;
      }
      // Compare text — exact match or >90% overlap (first 500 chars)
      const prevText = (prev.text || "").slice(0, 500);
      const curText = (m.text || "").slice(0, 500);
      if (
        prevText === curText ||
        (prevText.length > 50 && curText.length > 50 && this.textSimilarity(prevText, curText) > 0.9)
      ) {
        prev._repeatCount = (prev._repeatCount || 1) + 1;
        // Keep the latest timestamp
        prev.ts = m.ts;
      } else {
        result.push({ ...m, _repeatCount: 1 });
      }
    }
    return result;
  }

  /** Simple similarity ratio: shared chars / max length (good enough for duplicate detection) */
  private textSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length > b.length ? a : b;
    let matches = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (shorter[i] === longer[i]) matches++;
    }
    return matches / longer.length;
  }

  /**
   * Get active sub-agent status for this channel (survives compaction via DB query).
   * Returns a reminder string if active sub-agents exist, empty string otherwise.
   */
  private getActiveSubAgentReminder(): string {
    if (this.config.isSpaceAgent) return ""; // Sub-agents don't spawn sub-agents
    try {
      const { channel } = this.config;
      const activeSpaces = db
        .query<{ id: string; title: string; agent_id: string }, [string]>(
          `SELECT id, title, agent_id FROM spaces
           WHERE channel = ? AND status = 'active' AND source IN ('spawn_agent','claude_code')
           ORDER BY created_at DESC LIMIT 20`,
        )
        .all(channel);
      if (activeSpaces.length === 0) return "";
      const agentList = activeSpaces
        .map((s) => {
          const safeTitle = (s.title || s.agent_id).replace(/[\r\n]+/g, " ").slice(0, 80);
          return `  - ${safeTitle} [agent_id: ${s.id}]`;
        })
        .join("\n");
      return `\n\n<system-reminder>${activeSpaces.length} sub-agent${activeSpaces.length > 1 ? "s are" : " is"} currently running. They will report back when done — do not start work that overlaps their tasks. Use list_agents to check status, get_agent_report(agent_id) to read results.\n${agentList}</system-reminder>`;
    } catch (err) {
      logger.warn(`getActiveSubAgentReminder error: ${err}`);
      return "";
    }
  }

  /** Build prompt for a mix of previously-seen and brand-new messages */
  private buildMixedPrompt(seenNotProcessed: Message[], unseen: Message[]): string {
    const { channel } = this.config;

    const formatMessages = (msgs: Message[]) => {
      const deduplicated = this.deduplicateMessages(msgs);
      return deduplicated
        .map((m: Message & { _repeatCount?: number }) => {
          const hasFiles = m.files && m.files.length > 0;
          const fileInfo = hasFiles ? `\n[Attached files: ${m.files!.map((f) => f.name).join(", ")}]` : "";
          const author =
            m.user === "UHUMAN"
              ? "human"
              : m.user?.startsWith("UWORKER-")
                ? `[Sub-agent: ${m.agent_id || "unknown"}]`
                : m.agent_id || m.user || "unknown";
          const text = this.truncateText(m.tool_result ? formatToolResult(m.tool_result) : m.text);
          const repeatSuffix = (m._repeatCount || 1) > 1 ? ` [×${m._repeatCount} similar messages]` : "";
          return `[ts:${m.ts}] ${author}: ${text}${fileInfo}${repeatSuffix}`;
        })
        .join("\n\n---\n\n");
    };

    const parts: string[] = [];
    parts.push(`# Messages on Channel "${channel}" (poll start)\n`);

    if (seenNotProcessed.length > 0) {
      parts.push(`## Previously Seen (not yet processed)\n\n${formatMessages(seenNotProcessed)}`);
    }
    if (unseen.length > 0) {
      if (seenNotProcessed.length > 0) parts.push(`\n## New Messages\n`);
      parts.push(formatMessages(unseen));
    }

    const subAgentReminder = this.getActiveSubAgentReminder();
    if (subAgentReminder) parts.push(subAgentReminder);
    parts.push(
      `\n[REMINDER: Your streaming text output goes to the agentic framework only — the human CANNOT see it. Call chat_send_message to send a visible response to the chat UI.]`,
    );
    return parts.join("\n");
  }

  /** Build prompt from a single message list (unseen-only or pending-only) */
  private buildPrompt(seenNotProcessed: Message[], unseen: Message[]): string {
    // Use whichever array is populated; pending === unseen when isContinuation,
    // or pending === seenNotProcessed when !isContinuation && unseen.length === 0.
    const messages = seenNotProcessed.length > 0 ? seenNotProcessed : unseen;
    const { channel } = this.config;
    const isSpaceAgent = this.config.isSpaceAgent;
    const deduplicated = this.deduplicateMessages(messages);

    const taskMsgs = deduplicated
      .map((m: Message & { _repeatCount?: number }) => {
        const hasFiles = m.files && m.files.length > 0;
        const fileInfo = hasFiles ? `\n[Attached files: ${m.files!.map((f) => f.name).join(", ")}]` : "";
        const author =
          m.user === "UHUMAN"
            ? "human"
            : m.user?.startsWith("UWORKER-")
              ? `[Sub-agent: ${m.agent_id || "unknown"}]`
              : m.agent_id || m.user || "unknown";
        const text = this.truncateText(m.tool_result ? formatToolResult(m.tool_result) : m.text);
        const repeatSuffix = (m._repeatCount || 1) > 1 ? ` [×${m._repeatCount} similar messages]` : "";
        return `[ts:${m.ts}] ${author}: ${text}${fileInfo}${repeatSuffix}`;
      })
      .join("\n\n---\n\n");

    // Header reflects message type
    const sectionHeader =
      seenNotProcessed.length > 0 && unseen.length === 0
        ? `# Messages on Channel "${channel}" (continuing)\n\nCONTINUATION REQUIRED — you did not call ${
            isSpaceAgent ? "complete_task" : "chat_mark_processed"
          } last turn.`
        : `# Messages on Channel "${channel}" (poll start)`;

    const parts: string[] = [`${sectionHeader}\n\n${taskMsgs}`];

    if (!isSpaceAgent) {
      const subAgentReminder = this.getActiveSubAgentReminder();
      if (subAgentReminder) parts.push(subAgentReminder);
      parts.push(
        `\n[REMINDER: Your streaming text output goes to the agentic framework only — the human CANNOT see it. Call chat_send_message to send a visible response to the chat UI.]`,
      );
    }

    return parts.join("\n");
  }

  /** Build continuation prompt */
  private buildContinuationPrompt(unprocessedMessages: Message[]): string {
    const { channel } = this.config;
    const deduplicated = this.deduplicateMessages(unprocessedMessages);
    const messageContext = deduplicated
      .map((m: Message & { _repeatCount?: number }) => {
        const author =
          m.user === "UHUMAN"
            ? "human"
            : m.user?.startsWith("UWORKER-")
              ? `[Sub-agent: ${m.agent_id || "unknown"}]`
              : m.agent_id || "bot";
        const text = this.truncateText(m.tool_result ? formatToolResult(m.tool_result) : m.text);
        const repeatSuffix = (m._repeatCount || 1) > 1 ? ` [×${m._repeatCount} similar messages]` : "";
        return `[ts:${m.ts}] ${author}: ${text}${repeatSuffix}`;
      })
      .join("\n\n---\n\n");

    if (this.config.isSpaceAgent) {
      return `CONTINUATION REQUIRED — you did not call complete_task yet.\n\n${messageContext}`;
    }

    const subAgentReminder = this.getActiveSubAgentReminder();
    return `# Messages on Channel "${channel}" (continuing)\n\nCONTINUATION REQUIRED — you did not call chat_mark_processed last turn.\n\n${messageContext}${subAgentReminder}`;
  }

  /** Build interrupt resume prompt with Processing/New split (mirrors CC main worker) */
  private buildInterruptPrompt(processingMessages: Message[], newMessages: any[], hadUnsentText = false): string {
    const { channel } = this.config;

    const formatMsg = (m: any) => {
      const author =
        m.user === "UHUMAN"
          ? "human"
          : m.user?.startsWith("UWORKER-")
            ? `[Sub-agent: ${m.agent_id || "unknown"}]`
            : m.agent_id || m.user || "unknown";
      const text = this.truncateText(m.tool_result ? formatToolResult(m.tool_result) : m.text);
      return `[ts:${m.ts}] ${author}: ${text}`;
    };

    // Budget: reserve space for NEW messages first (they're the reason for interrupt),
    // then fill processing context with remaining budget
    const halfBudget = MAX_COMBINED_PROMPT_LENGTH / 2;

    // 1. New messages get guaranteed half-budget
    let newLen = 0;
    const newMsgLines: string[] = [];
    for (const msg of newMessages) {
      const line = formatMsg(msg);
      if (newLen + line.length > halfBudget) break;
      newMsgLines.push(line);
      newLen += line.length;
    }

    // 2. Processing messages fill remaining budget (newest 5 reserved, older in reverse)
    const procBudget = MAX_COMBINED_PROMPT_LENGTH - newLen;
    const PROC_NEWEST = Math.min(processingMessages.length, 5);
    const procNewest = processingMessages.slice(-PROC_NEWEST);
    const procOlder = processingMessages.slice(0, processingMessages.length - PROC_NEWEST);
    let procLen = 0;
    const procNewestLines: string[] = [];
    for (const msg of procNewest) {
      const line = formatMsg(msg);
      if (procLen + line.length > procBudget) break;
      procNewestLines.push(line);
      procLen += line.length;
    }
    const procOlderLines: string[] = [];
    for (let i = procOlder.length - 1; i >= 0; i--) {
      const line = formatMsg(procOlder[i]);
      if (procLen + line.length > procBudget) break;
      procOlderLines.unshift(line);
      procLen += line.length;
    }

    const parts: string[] = [];
    parts.push(
      `[INTERRUPT] New messages arrived while you were processing.\nRead them carefully — they may override your current task.`,
    );
    if (hadUnsentText) {
      parts.push(
        `\n[WARNING: Your previous turn produced text output but did NOT call \`chat_send_message\`. The human cannot see your previous response. If you still need to respond to the earlier task, call \`chat_send_message\` FIRST before processing the new messages.]`,
      );
    }
    parts.push(
      `\n# Processing Messages on Channel "${channel}"\n\n${[...procOlderLines, ...procNewestLines].join("\n\n---\n\n")}`,
    );
    parts.push(`\n# New Messages on Channel "${channel}"\n\n${newMsgLines.join("\n\n---\n\n")}`);

    const subAgentReminder = this.getActiveSubAgentReminder();
    if (subAgentReminder) parts.push(subAgentReminder);
    parts.push(
      `\n[REMINDER: Your streaming text output goes to the agentic framework only — the human CANNOT see it. Call chat_send_message to send a visible response to the chat UI.]`,
    );
    return parts.join("\n");
  }

  /** Execute a prompt using the in-process Agent */
  private async executePrompt(
    prompt: string,
    sessionName: string,
  ): Promise<{ success: boolean; output: string; markProcessed: boolean; chatSent: boolean; hadStreamText: boolean }> {
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
        provider: this.config.provider || "copilot",
        worktreePath: this.config.worktreePath,
        worktreeBranch: this.config.worktreeBranch,
        originalProjectRoot: this.config.originalProjectRoot,
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

          // Query other agents in the same channel (for the "other agents" section in system prompt)
          const otherAgents: Awaited<ReturnType<typeof listAgentFiles>> = [];
          const otherAgentStatuses: Record<string, { status: string; hibernate_until?: string | null }> = {};
          const HIBERNATE_TIMEOUT = 600;
          const nowSeconds = Math.floor(Date.now() / 1000);

          try {
            const channelAgents = db
              .query("SELECT agent_id, project FROM channel_agents WHERE channel = ? AND agent_id != ?")
              .all(this.config.channel, this.config.agentId) as { agent_id: string; project: string }[];

            for (const ca of channelAgents) {
              // Only include main agents (no project), not sub-agents
              if (ca.project) continue;

              // Add basic entry (no description for main agents without agent files)
              otherAgents.push({
                name: ca.agent_id,
              });

              // Query agent status from agent_status table
              const seenResult = db
                .query<{ last_poll_ts: number | null }, [string, string]>(
                  `SELECT last_poll_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
                )
                .get(ca.agent_id, this.config.channel);
              const statusResult = db
                .query<{ status: string; hibernate_until: string | null }, [string, string]>(
                  `SELECT status, hibernate_until FROM agent_status WHERE agent_id = ? AND channel = ?`,
                )
                .get(ca.agent_id, this.config.channel);

              const lastPollTs = seenResult?.last_poll_ts;
              const isOnline = lastPollTs ? nowSeconds - lastPollTs <= HIBERNATE_TIMEOUT : false;
              const storedStatus = statusResult?.status || "ready";

              // If agent hasn't polled recently, it's hibernating
              let finalStatus = isOnline ? storedStatus : "hibernate";
              // Check if hibernate_until has passed
              if (finalStatus === "hibernate" && statusResult?.hibernate_until) {
                const hibernateUntilTs = parseInt(statusResult.hibernate_until, 10);
                if (hibernateUntilTs && hibernateUntilTs > nowSeconds) {
                  finalStatus = "hibernate"; // Still in hibernate period
                } else {
                  finalStatus = "ready"; // Hibernate period expired
                }
              }

              otherAgentStatuses[ca.agent_id] = {
                status: finalStatus,
                hibernate_until: statusResult?.hibernate_until,
              };
            }
          } catch (err) {
            // Best-effort: don't fail agent startup if we can't query other agents
            logger.debug(`Could not query other agents: ${err}`);
          }

          // Create agent config
          // Build prompt context for dynamic system prompt assembly
          const promptContext: PromptContext = {
            agentId: this.config.agentId,
            channel: this.config.channel,
            projectRoot: this.config.projectRoot,
            isSpaceAgent: !!this.config.isSpaceAgent,
            availableTools: toolDefinitions.map((t) => t.function.name),
            platform: process.platform,
            model,
            gitRepo: existsSync(join(this.config.projectRoot, ".git")),
            browserEnabled: false, // updated below if browser plugin registers
            contextMode: this.config.contextMode,
            agentFileConfig: this.config.agentFileConfig,
            otherAgents: otherAgents.length > 0 ? otherAgents : undefined,
            otherAgentStatuses: Object.keys(otherAgentStatuses).length > 0 ? otherAgentStatuses : undefined,
            worktreeEnabled: !!this.config.worktreePath,
            worktreeBranch: this.config.worktreeBranch,
          };

          // Re-injection tracking: detect if chat_send_message / chat_mark_processed were called this turn.
          // Heartbeat prompts intentionally skip both — suppress re-injection for them.
          const isHeartbeatTurn = prompt.startsWith("[HEARTBEAT]");
          let turnChatSent = false;
          let turnMarkProcessed = false;
          let turnStreamText = "";

          // Build skill review config from runtime values — never from env-only
          // derivation, because CLAWD_API_URL is rarely set but chatApiUrl is
          // always available at runtime. Only CLAWD_SKILL_REVIEW_ENABLED=false
          // acts as an explicit kill switch.
          const _memCfg = loadConfigFile().memory;
          const _memModel = typeof _memCfg === "object" && _memCfg?.model ? _memCfg.model : undefined;
          const skillReviewConfig: AgentConfig["skillReview"] =
            process.env.CLAWD_SKILL_REVIEW_ENABLED !== "false"
              ? {
                  apiUrl: chatApiUrl,
                  channel,
                  projectRoot: resolvedProjectRoot,
                  reviewInterval: parseInt(process.env.CLAWD_SKILL_REVIEW_INTERVAL ?? "20", 10),
                  minToolCallsBeforeFirstReview: parseInt(process.env.CLAWD_SKILL_REVIEW_MIN_TOOLS ?? "10", 10),
                  maxSkillsPerReview: parseInt(process.env.CLAWD_SKILL_REVIEW_MAX_SKILLS ?? "2", 10),
                  reviewCooldownMs: parseInt(process.env.CLAWD_SKILL_REVIEW_COOLDOWN_MS ?? "300000", 10),
                  reviewModel: _memModel,
                }
              : undefined;

          const agentConfig: AgentConfig = {
            provider,
            model,
            maxIterations: this.config.agentFileConfig?.maxTurns || 0, // 0 = unlimited
            contextMode: this.config.contextMode,
            additionalContext: clawdContext || undefined,
            sharedMcpManager: this.config.channelMcpManager,
            toolAllowlist: this.config.agentFileConfig?.tools,
            toolDenylist: this.config.agentFileConfig?.disallowedTools,
            // Note: agentFileConfig.skills is parsed but NOT consumed here (no-op).
            // Agent file edits on disk require agent restart to take effect (clawdInstructionsCache).
            promptContext,
            skillReview: skillReviewConfig,
            onToken: (token) => {
              turnStreamText += token;
              process.stdout.write(token);
            },
            onToolCall: (name, args) => {
              this.lastActivityAt = Date.now();
              this.log(`Tool: ${name} ${JSON.stringify(args)}`);
            },
            onToolResult: (name, result) => {
              this.lastActivityAt = Date.now();
              this.log(`Tool result: ${name} ${result.success ? "ok" : "err: " + result.error}`);
              // Track whether the agent successfully sent a message (non-prefixed name in this path)
              if (name === "chat_send_message" && result.success) {
                turnChatSent = true;
              }
              // Track whether chat_mark_processed was called this turn
              if (name === "chat_mark_processed" && result.success) {
                turnMarkProcessed = true;
              }
            },
          };

          // Create agent
          let agent: Agent | null = null;
          try {
            const llmProvider = createProvider(provider, model);
            agent = new Agent(llmProvider, agentConfig);
            this.activeAgent = agent;

            // Create and register clawd-chat plugin for chat integration
            const pluginConfig: ClawdChatConfig = {
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
            await agent.usePlugin({
              toolPlugin: createCopilotAnalyticsPlugin(channel),
            });

            // Register additional plugins (space tools, etc.)
            if (this.config.additionalPlugins) {
              for (const p of this.config.additionalPlugins) {
                await agent.usePlugin(p as any);
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
                  yolo: this.config.yolo,
                },
                this.config.spaceManager,
                this.config.spaceWorkerManager,
                async (ch: string) => {
                  // Fetch agent config for the channel
                  try {
                    const res = await timedFetch(`${chatApiUrl}/api/app.agents.list`, { headers: this.authHeaders() });
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
                  } catch {
                    // Intentionally swallowed — agent metadata lookup is best-effort for spawn plugin
                  }
                  return null;
                },
                this.trackedSpaces,
              );
              await agent.usePlugin({
                plugin: {
                  name: "spawn-agent-spaces",
                  version: "1.0.0",
                  hooks: {},
                },
                toolPlugin: spawnPlugin,
              });
            }

            // Run the agent with the prompt (wrapped in call context for analytics)
            // NOTE: channel and agentId are already destructured from this.config at line 496;
            // do NOT re-declare them here — a redundant const { channel, agentId } inside
            // this try-block would create a TDZ that shadows the outer bindings, causing
            // "ReferenceError: Cannot access 'channel' before initialization" in Bun's
            // compiled (--compile --minify) binary every time executePrompt() is called.
            const result = await callContext.run({ agentId, channel }, () => agent!.run(prompt, sessionName));

            this.log(`Agent completed: ${result.iterations} iterations, ${result.toolCalls.length} tool calls`);

            // Re-injection: if agent produced ANY text but never called chat_send_message,
            // send one ephemeral follow-up prompt so it can deliver the response.
            // Skip for heartbeat turns and cancelled turns.
            if (
              !turnChatSent &&
              turnStreamText.trim().length > 0 &&
              !isHeartbeatTurn &&
              !this.wasCancelledByHeartbeat
            ) {
              const reinjectionPrompt =
                "[NOTICE: Your previous turn produced output but did not call `chat_send_message` to deliver it — the human cannot see what you wrote.\n\n" +
                "If you intended to respond to the human, call `chat_send_message` with your response now.\n" +
                "If you intentionally chose not to respond, produce only [SILENT] and do nothing else.]";

              try {
                const reinjResult = await callContext.run({ agentId, channel }, () =>
                  agent!.run(reinjectionPrompt, sessionName),
                );
                // If agent replied [SILENT] or produced nothing, discard silently
                const reinjText = reinjResult.content?.trim() ?? "";
                if (reinjText && reinjText.includes("[SILENT]")) {
                  this.log("Re-injection: agent replied [SILENT], discarding");
                } else {
                  this.log(`Re-injection: agent responded (${reinjText.length} chars)`);
                }
              } catch (err) {
                // Re-injection is best-effort — ignore errors
                this.log(`Re-injection failed: ${err}`);
              }
            }

            await agent.close();
            agent = null; // Prevent double-close in finally

            return {
              success: true,
              output: result.content,
              markProcessed: turnMarkProcessed,
              chatSent: turnChatSent,
              hadStreamText: turnStreamText.trim().length > 0,
            };
          } finally {
            // Ensure agent is always cleaned up, even on error
            this.activeAgent = null;
            if (agent) {
              try {
                await agent.close();
              } catch {
                // Intentionally swallowed — agent.close() during teardown is best-effort
              }
            }
          }
        } catch (error) {
          this.log(`Failed to run agent: ${error}`);
          return { success: false, output: String(error), markProcessed: false, chatSent: false, hadStreamText: false };
        }
      },
    );
  }

  /** Load agent identity from agents/{name}.md (4-directory priority) */
  private loadAgentIdentity(): string {
    const { agentId } = this.config;
    // Use original project root for agent files (not worktree path)
    const configRoot = this.config.originalProjectRoot || this.config.projectRoot;
    const agent = loadAgentFile(agentId, configRoot);
    if (!agent) return "";
    const allAgents = listAgentFiles(configRoot);
    return buildAgentSystemPrompt(agent, allAgents);
  }

  // Cache CLAWD.md instructions per worker instance (avoids disk reads per agent init)
  private clawdInstructionsCache: string | null = null;

  /** Load CLAWD.md instructions from project root (cached after first load) */
  private loadClawdInstructions(): string {
    if (this.clawdInstructionsCache !== null) return this.clawdInstructionsCache;

    const { projectRoot } = this.config;
    const contexts: string[] = [];

    // 1. Global CLAWD.md from ~/.clawd/CLAWD.md
    const globalPath = join(homedir(), ".clawd", "CLAWD.md");
    if (existsSync(globalPath)) {
      try {
        contexts.push(readFileSync(globalPath, "utf-8"));
      } catch {
        // Intentionally swallowed — global CLAWD.md may not be readable; context injection is best-effort
      }
    }

    // 2. Project CLAWD.md from {projectRoot}/CLAWD.md
    const projectPath = join(projectRoot, "CLAWD.md");
    if (existsSync(projectPath) && projectPath !== globalPath) {
      try {
        contexts.push(`## Project-Specific Instructions\n\n${readFileSync(projectPath, "utf-8")}`);
      } catch {
        // Intentionally swallowed — project CLAWD.md may not be readable; context injection is best-effort
      }
    }

    // 3. Agent type instructions (from agentFileConfig — set for sub-agents or channel agents with agent_type)
    if (this.config.agentFileConfig) {
      // Pass empty array for allAgents to skip "other agents awareness" section in type prompt
      // (saves ~500-1500 chars; disk identity via loadAgentIdentity includes awareness if needed)
      const typeIdentity = buildAgentSystemPrompt(this.config.agentFileConfig, []);
      if (typeIdentity) {
        contexts.push(`# Agent Type Configuration\n\n${typeIdentity}`);
      }
    }

    // 4. Per-agent identity (from disk lookup — agents/{agentId}.md or identity textarea)
    // For sub-agents (isSpaceAgent), skip disk identity since agentFileConfig is their full identity
    if (!this.config.isSpaceAgent) {
      const diskIdentity = this.loadAgentIdentity();
      if (diskIdentity) {
        contexts.push(`# Agent Identity & Configuration\n\n${diskIdentity}`);
      }
    }

    let result = contexts.join("\n\n---\n\n");
    // Increase budget when agentFileConfig is present (type prompt + identity may be longer)
    const maxInstructionsLen = this.config.agentFileConfig ? 8000 : MAX_SYSTEM_INSTRUCTIONS_LENGTH;
    if (result.length > maxInstructionsLen) {
      const suffix = "\n\n[TRUNCATED — CLAWD instructions truncated for context budget]";
      let cutPoint = maxInstructionsLen - suffix.length;
      if (cutPoint > 0 && cutPoint < result.length) {
        const code = result.charCodeAt(cutPoint - 1);
        if (code >= 0xd800 && code <= 0xdbff) cutPoint--;
      }
      result = result.slice(0, cutPoint) + suffix;
    }
    this.clawdInstructionsCache = result;
    return result;
  }

  /** Clear streaming state on shutdown */
  private async clearStreamingState(): Promise<void> {
    if (this.config.directDb !== false) {
      try {
        const { agentId, channel } = this.config;
        const success = setAgentStreaming(agentId, channel, false);
        if (success) broadcastAgentStreaming(channel, agentId, false);
      } catch {
        // Intentionally swallowed — streaming state clear on shutdown is best-effort
      }
      return;
    }
    try {
      await timedFetch(
        `${this.config.chatApiUrl}/api/agent.setStreaming`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.authHeaders(),
          },
          body: JSON.stringify({
            agent_id: this.config.agentId,
            channel: this.config.channel,
            is_streaming: false,
          }),
        },
        3000,
      );
    } catch {
      // Intentionally swallowed — remote streaming state clear on shutdown is best-effort
    }
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
    logger.info(`[${this.config.channel}:${this.config.agentId}] ${msg}`);
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
