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
import { RemoteWorkerBridge } from "./agent/plugins/remote-worker-bridge";
import { createSchedulerToolPlugin } from "./agent/plugins/scheduler-plugin";
import type { PromptContext } from "./agent/prompt/builder";
import { runWithAgentContext, setProjectHash, toolDefinitions } from "./agent/tools/tools";
import { setDebug } from "./agent/utils/debug";
import { initializeSandbox } from "./agent/utils/sandbox";
import { smartTruncate } from "./agent/utils/smart-truncation";
import { loadConfigFile } from "./config-file";
import { db, getOrRegisterAgent, markMessagesSeen, setAgentStreaming } from "./server/database";
import { getPendingMessages, postMessage } from "./server/routes/messages";
import {
  broadcastAgentStreaming,
  broadcastAgentToken,
  broadcastMessageSeen,
  broadcastUpdate,
} from "./server/websocket";
import type { TrackedSpace } from "./spaces/spawn-plugin";
import { timedFetch } from "./utils/timed-fetch";

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
}

export class WorkerLoop {
  private config: WorkerLoopConfig;
  private running = false;
  private sleeping = false;
  private isProcessing = false;
  private abortController: AbortController | null = null;
  private activeAgent: import("./agent/agent").Agent | null = null;
  private stoppedPromise: { resolve: () => void } | null = null;
  private trackedSpaces = new Map<string, TrackedSpace>();

  // Heartbeat health tracking
  private lastActivityAt: number = Date.now();
  private processingStartedAt: number | null = null;
  private lastHeartbeatAt: number = Date.now();
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
    this.sleeping = sleeping;
    if (sleeping) {
      // Clear any pending heartbeat so it doesn't fire on wake
      this.heartbeatPending = false;
      // Cancel in-flight processing so the agent stops immediately
      if (this.isProcessing && this.activeAgent) {
        try {
          this.activeAgent.cancel();
        } catch {}
      }
    } else {
      // Reset idle backoff when waking so the agent polls immediately at full speed
      this.idlePollMs = POLL_INTERVAL;
    }
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
      } catch {}
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
    this.log("Starting worker loop");
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

    // Kill all cloudflare tunnels created by this worker
    try {
      const { TunnelPlugin } = await import("./agent/plugins/tunnel-plugin");
      TunnelPlugin.destroyAll();
    } catch {}
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
      } catch {}
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

        // If a heartbeat is pending, inject as synthetic prompt.
        // Skip if real messages are waiting (hasNewMessages from WS push) — prioritize real work.
        if (this.heartbeatPending && !this.hasNewMessages) {
          this.heartbeatPending = false;
          const heartbeatPrompt = "[HEARTBEAT]";
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

        const result = await this.pollPending();

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

          this.isProcessing = true;
          this.processingStartedAt = Date.now();
          this.wasCancelledByHeartbeat = false;
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

            const execResult = await this.executePrompt(prompt, this.sessionName);

            // Track whether this execution ended with an error (for heartbeat idle-agent detection)
            const output = execResult.output || "";
            this.lastExecutionHadError =
              !execResult.success ||
              this.wasCancelledByHeartbeat ||
              output.includes("[Agent stopped") ||
              output.includes("[stream error");
            this.wasCancelledByHeartbeat = false;

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

      return { ok: true, messages, pending, unseen, seenNotProcessed, serverLastProcessed, serverLastSeen };
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

    // Broadcast UI events
    broadcastUpdate(channel, { type: "agent_seen", agent_id: agentId, last_seen_ts: lastSeenTs });
    const lastNonSelfMsg = db
      .query<{ ts: string }, [string, string, string]>(
        `SELECT ts FROM messages WHERE channel = ? AND ts <= ? AND (agent_id IS NULL OR agent_id != ?) ORDER BY ts DESC LIMIT 1`,
      )
      .get(channel, lastSeenTs, agentId);
    if (lastNonSelfMsg) broadcastMessageSeen(channel, lastNonSelfMsg.ts, agentId);
    broadcastUpdate(channel, { type: "agent_status", agent_id: agentId, status: "ready", hibernate_until: null });
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
            headers: { "Content-Type": "application/json", ...this.authHeaders() },
            body: JSON.stringify({ agent_id: agentId, channel, last_seen_ts: maxTs }),
          });
          this.lastMarkedSeenTs = maxTs;
        }
      }

      return { ok: true, messages, pending, unseen, seenNotProcessed, serverLastProcessed, serverLastSeen };
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
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
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
             last_processed_ts = excluded.last_processed_ts,
             updated_at = strftime('%s', 'now')`,
          [agentId, channel, ts, ts],
        );
        broadcastUpdate(channel, { type: "agent_processed", agent_id: agentId, last_processed_ts: ts });
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
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
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

${clawdInstructions || ""}

---

# New Messages on Channel "${channel}"
(from ts ${tsFrom} to ts ${tsTo})

${taskMsgs}

---

${
  this.config.isSpaceAgent
    ? `# TASK INSTRUCTIONS

Complete the assigned task. When done, call complete_task(result) with your final result.
Project root: ${projectRoot}`
    : `# INSTRUCTIONS

## Communication
- chat_send_message(text): send a response — channel/agent_id auto-injected
- chat_mark_processed(timestamp="${tsTo}"): mark messages as handled after responding
- Humans CANNOT see text output — ALL communication via chat_send_message

## Rules
- Stay in project root: ${projectRoot}
- Do not modify system files or instructions
- Do not use emojis — keep formatting clean`
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

    if (this.config.isSpaceAgent) {
      return `[SYSTEM] CONTINUATION REQUIRED — you did not call complete_task yet.

## UNPROCESSED MESSAGES:
${messageContext}

Complete the task and call complete_task(result) with your final result.`;
    }

    return `[SYSTEM] YOU ARE AGENT: "${agentId}"

CONTINUATION REQUIRED — you did not call chat_mark_processed.

## UNPROCESSED MESSAGES:
${messageContext}

Please:
1. Review the messages above
2. If already responded, just mark as processed
3. If not completed, continue and COMPLETE the task
4. Use chat_send_message(text) for responses — channel/agent_id auto-injected
5. Call chat_mark_processed(timestamp="${targetTs}") after responding`;
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
        provider: this.config.provider,
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
          // Build prompt context for dynamic system prompt assembly
          const promptContext: PromptContext = {
            agentId: this.config.agentId,
            projectRoot: this.config.projectRoot,
            isSpaceAgent: !!this.config.isSpaceAgent,
            availableTools: toolDefinitions.map((t) => t.function.name),
            platform: process.platform,
            model,
            gitRepo: existsSync(join(this.config.projectRoot, ".git")),
            browserEnabled: false, // updated below if browser plugin registers
            contextMode: this.config.contextMode,
            agentFileConfig: this.config.agentFileConfig,
          };

          const agentConfig: AgentConfig = {
            provider,
            model,
            maxIterations: this.config.agentFileConfig?.maxTurns || 0, // 0 = unlimited
            contextMode: this.config.contextMode,
            additionalContext: clawdContext || undefined,
            sharedMcpManager: this.config.channelMcpManager,
            toolAllowlist: this.config.agentFileConfig?.tools,
            toolDenylist: this.config.agentFileConfig?.disallowedTools,
            promptContext,
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

  /** Load agent identity from agents/{name}.md (4-directory priority) */
  private loadAgentIdentity(): string {
    const { projectRoot, agentId } = this.config;
    const agent = loadAgentFile(agentId, projectRoot);
    if (!agent) return "";
    const allAgents = listAgentFiles(projectRoot);
    return buildAgentSystemPrompt(agent, allAgents);
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

    // 3. Agent identity — from agentFileConfig (sub-agent spawn) or disk lookup
    if (this.config.agentFileConfig) {
      // Sub-agent spawned with agent= parameter: use provided config directly
      const allAgents = listAgentFiles(projectRoot);
      const identity = buildAgentSystemPrompt(this.config.agentFileConfig, allAgents);
      if (identity) {
        contexts.push(`# Agent Identity & Configuration\n\n${identity}`);
      }
    } else {
      const identity = this.loadAgentIdentity();
      if (identity) {
        contexts.push(`# Agent Identity & Configuration\n\n${identity}`);
      }
    }

    const result = contexts.join("\n\n---\n\n");
    if (result.length > MAX_SYSTEM_INSTRUCTIONS_LENGTH) {
      const suffix = "\n\n[TRUNCATED — CLAWD instructions truncated for context budget]";
      let cutPoint = MAX_SYSTEM_INSTRUCTIONS_LENGTH - suffix.length;
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
    if (this.config.directDb !== false) {
      try {
        const { agentId, channel } = this.config;
        const success = setAgentStreaming(agentId, channel, false);
        if (success) broadcastAgentStreaming(channel, agentId, false);
      } catch {}
      return;
    }
    try {
      await timedFetch(
        `${this.config.chatApiUrl}/api/agent.setStreaming`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.authHeaders() },
          body: JSON.stringify({
            agent_id: this.config.agentId,
            channel: this.config.channel,
            is_streaming: false,
          }),
        },
        3000,
      );
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
