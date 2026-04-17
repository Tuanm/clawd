/**
 * Claude Code Main Worker
 *
 * Runs a Claude Code agent via the official SDK as a main channel agent.
 * Polls for messages, runs SDK query() per interaction, and lets Claude Code
 * communicate via Claw'd's MCP tools (chat_send_message, chat_mark_processed, etc.).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { type AgentFileConfig, buildAgentSystemPrompt, listAgentFiles, loadAgentFile } from "../agent/agents/loader";
import { loadConfigFile } from "../config/config-file";
import { type AgentMemory, extractKeywords, getAgentMemoryStore } from "../agent/memory/agent-memory";
import {
  buildSkillReviewPrompt,
  containsCorrection,
  parseSkillRecommendations,
  postSystemMessage,
  sanitize,
} from "../agent/plugins/skill-review-plugin";
import { buildDynamicSystemPrompt, type PromptContext } from "../agent/prompt/builder";
import { buildSdkPromptWithHeartbeat } from "./build-sdk-messages";
import { getSessionManager } from "../agent/session/manager";
import { generateConversationSummary } from "../agent/session/summarizer";
import { getSkillSet, improveSkillFromCorrections } from "../agent/skills/improvement";
import { getSkillManager } from "../agent/skills/manager";
import { db, getAgent, markMessagesSeen, setAgentStreaming } from "../server/database";
import { getPendingMessages } from "../server/routes/messages";
import {
  broadcastAgentStreaming,
  broadcastAgentToken,
  broadcastAgentToolCall,
  broadcastMessageSeen,
  broadcastUpdate,
} from "../server/websocket";
import { createLogger } from "../utils/logger";
import type { AgentHealthSnapshot, AgentWorker } from "../worker-loop";
import { initMemorySession, saveToMemory } from "./memory";
import { runSDKQuery } from "./sdk";
import { extractSubject } from "./tool-subject";
import { TrajectoryRecorder } from "./trajectory-recorder";
import { formatToolDescription, truncateToolResult } from "./utils";

const logger = createLogger("claude-code-main");

// ============================================================================
// Constants
// ============================================================================

const SLEEP_BACKOFF_MS = 3000;
const MAX_FORCE_MARK_RETRIES = 3;
const MAX_MESSAGE_LENGTH = 10000;
const MAX_COMBINED_PROMPT_LENGTH = 40000;
const MAX_WAKEUP_MESSAGES = 3; // On wakeup, only process this many recent messages

// Tools that manage conversation flow — excluded from the [CC-Turn] [Action] entries
// since they are implementation mechanics, not agent work visible to the user.
const CONVERSATION_TOOLS = new Set(["chat_send_message", "chat_mark_processed"]);

// ============================================================================
// Types
// ============================================================================

export interface ClaudeCodeMainConfig {
  channel: string;
  agentId: string;
  model: string;
  provider?: string;
  projectRoot: string;
  chatApiUrl: string;
  debug: boolean;
  agentFileConfig?: AgentFileConfig;
  heartbeatInterval?: number;
  /** When false (default), sandbox restrictions apply. When true, bypasses all permission checks. */
  yolo?: boolean;
}

// ============================================================================
// Worker
// ============================================================================

export class ClaudeCodeMainWorker implements AgentWorker {
  private config: ClaudeCodeMainConfig;
  private sessionId: string | null = null;
  private running = false;
  private sleeping = false;
  private userSleeping = false; // Explicitly put to sleep by user — don't auto-wake
  private isFirstPoll = true; // Track first poll for new-agent onboarding
  private processing = false;
  private lastActivityAt = Date.now();
  private processingStartedAt: number | null = null;
  private lastHeartbeatAt = Date.now();
  private stopped = false;
  private stoppedResolve: (() => void) | null = null;
  private stoppedPromise: Promise<void> | null = null;
  private heartbeatPending = false;
  private memorySessionId: string | null = null;
  private pendingTimestamps: string[] = [];
  /** Set of timestamps marked as seen but not yet processed. Tracks messages that
   *  appeared in a poll but weren't successfully processed, so subsequent polls
   *  can differentiate "brand-new" vs "previously seen" messages.
   *  Persisted to agent_seen.pending_seen_ts_json via persistPendingSeenTimestamps()
   *  so a crash mid-turn doesn't cause the agent to treat resumed messages as fresh
   *  and produce duplicate replies. */
  private pendingSeenTimestamps = new Set<string>();
  private forceMarkRetries = new Map<string, number>();
  private trajectoryRecorder: TrajectoryRecorder | null = null;
  private abortController: AbortController | null = null;
  private wasCancelledByHeartbeat = false;
  // Track whether the interrupt poller detected new messages this cycle.
  // Used to skip re-injections when interrupted (mirrors WorkerLoop's !wlInterrupted guard).
  private interruptDetected = false;
  // Re-injection state: track per-turn whether chat_send_message / chat_mark_processed were called
  private turnChatSent = false;
  private turnMarkProcessed = false;
  private turnStreamText = "";
  // Per-turn structured log removed — assistant messages (with text + tool_use blocks)
  // and tool results are persisted as individual session rows by handleAssistantMessage
  // and handleToolResult, and rebuilt into the next turn's SDK message stream by
  // buildSdkMessages(). No separate blob/log needed.
  // Skill improvement state — per-turn tracking for correction-gated improvement
  private turnActivatedSkills = new Set<string>();
  private turnBufferStartIdx = 0;
  private skillsBeingImproved = new Set<string>();
  private pendingCorrections: string[] = [];
  /** Per-turn set of message timestamps already scanned for corrections.
   *  Cleared on new turns, preserved across resume turns — so resume-turn
   *  user messages are scanned once (without double-counting the main-turn scan). */
  private pendingScannedCorrectionTs = new Set<string>();
  // Skill review state — cumulative across turns within a session
  private sessionToolCallCount = 0;
  private skillReviewBuffer: Array<{ role: string; content: string; toolName?: string; ts: number }> = [];
  private skillReviewLastAt = 0;
  private skillReviewLastToolCount = 0;
  private skillReviewInProgress = false;
  // Cached skill review config — built once from runtime values (avoids re-reading env on every tool call)
  private _srConfig:
    | { reviewInterval: number; minToolCalls: number; cooldownMs: number; maxSkills: number; model?: string }
    | null
    | "disabled" = null;

  private addToSkillReviewBuffer(entry: { role: string; content: string; toolName?: string }): void {
    this.skillReviewBuffer.push({ ...entry, ts: Date.now() });
    if (this.skillReviewBuffer.length > 500) this.skillReviewBuffer.shift();
  }
  // Memory injection: last keywords from user message for relevance scoring
  private lastKeywords: string[] = [];
  private get memorySessionName(): string {
    return `${this.config.channel}-${this.config.agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  }

  constructor(config: ClaudeCodeMainConfig) {
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // AgentWorker interface
  // --------------------------------------------------------------------------

  get isSleeping(): boolean {
    return this.sleeping;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get heartbeatInterval(): number {
    return this.config.heartbeatInterval || 0;
  }

  setSleeping(sleeping: boolean): void {
    this.sleeping = sleeping;
    this.userSleeping = sleeping;
    if (sleeping) {
      // Cancel in-flight processing
      try {
        this.abortController?.abort();
      } catch {
        // Intentionally swallowed — AbortController.abort() during cancel is never critical
      }
      const agent = getAgent(this.config.agentId, this.config.channel);
      if (agent) {
        broadcastUpdate(this.config.channel, {
          ts: "",
          type: "message",
          user: this.config.agentId,
          text: "",
          agent_id: this.config.agentId,
          avatar_color: agent.avatar_color || "#D97706",
          is_sleeping: true,
        } as any);
      }
    }
  }

  getHealthSnapshot(): AgentHealthSnapshot {
    return {
      processing: this.processing,
      processingDurationMs: this.processingStartedAt ? Date.now() - this.processingStartedAt : null,
      lastActivityAt: this.lastActivityAt,
      idleDurationMs: Date.now() - this.lastActivityAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      sleeping: this.userSleeping,
      running: this.running,
      isSpaceAgent: false,
      channel: this.config.channel,
      agentId: this.config.agentId,
      lastExecutionHadError: false,
    };
  }

  cancelProcessing(): void {
    this.wasCancelledByHeartbeat = true;
    try {
      this.abortController?.abort();
    } catch {
      // Intentionally swallowed — AbortController.abort() during heartbeat cancel is never critical
    }
  }

  getProjectRoot(): string {
    return this.config.projectRoot;
  }

  async resetSession(): Promise<void> {
    this.sessionId = null;
    this.persistSessionId(null);
  }

  injectHeartbeat(): void {
    if (this.processing || this.userSleeping) return;
    this.lastHeartbeatAt = Date.now();
    this.heartbeatPending = true;
  }

  // --------------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    this.running = true;
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.stoppedResolve = resolve;
    });
    // Reset sleeping state on fresh start — prevents stale userSleeping from
    // an old loop (e.g. after provider change + restart) blocking message polling.
    this.sleeping = false;
    this.userSleeping = false;
    // Reset skill improvement in-flight state on restart so skills aren't
    // permanently locked if the worker crashed mid-improvement.
    this.turnActivatedSkills = new Set();
    this.turnBufferStartIdx = 0;
    this.skillsBeingImproved = new Set();
    getSkillSet(this.config.projectRoot).clear();
    try {
      this.restoreSessionId();
      this.restorePendingSeenTimestamps();
      this.memorySessionId = initMemorySession(this.memorySessionName, this.config.model);
      // Clear any orphan is_streaming=true flag from a prior process crash.
      // Without this, the UI would show this agent as streaming indefinitely.
      try {
        setAgentStreaming(this.config.agentId, this.config.channel, false);
      } catch {
        // Non-critical — the flag will be re-set correctly on the first turn.
      }
      this.trajectoryRecorder = new TrajectoryRecorder(
        this.config.channel,
        this.config.agentId,
        `${this.config.channel}-${this.config.agentId}-${Date.now()}`,
      );

      logger.info(
        `Started: ${this.config.channel}:${this.config.agentId}` +
          (this.sessionId ? ` (resuming session ${this.sessionId.slice(0, 8)}...)` : " (new session)"),
      );

      while (this.running) {
        try {
          // Skip polling entirely when user has put the agent to sleep
          if (this.userSleeping) {
            await Bun.sleep(5000);
            continue;
          }

          let { pending, unseen, seenNotProcessed } = this.pollForMessagesWithSeen();

          if (pending.length === 0 && this.heartbeatPending) {
            this.heartbeatPending = false;
            this.sleeping = false;
            // Structural kind flag is the source of truth for heartbeat detection —
            // substring match on text is fragile (a real user message could contain [HEARTBEAT]).
            pending = [
              {
                ts: String(Date.now()),
                user: "UHUMAN",
                text: "<agent_signal>[HEARTBEAT]</agent_signal>",
                kind: "heartbeat",
              },
            ];
            // Heartbeat is not a "seen" message — don't add to pendingSeenTimestamps
          }

          if (pending.length === 0) {
            if (!this.sleeping) this.sleeping = true;
            // Keep agent_seen.updated_at fresh so listAgents() doesn't
            // mark us as sleeping while we're still polling for sub-agent results
            this.touchActivity();
            await Bun.sleep(SLEEP_BACKOFF_MS);
            continue;
          }

          // Treat first poll of a new agent OR wakeup from sleep the same way:
          // truncate old messages and provide context summary
          const isWakeup = this.sleeping;
          const isNewAgent = this.isFirstPoll && pending.length > MAX_WAKEUP_MESSAGES;
          this.isFirstPoll = false;

          if (isWakeup) {
            this.sleeping = false;
            const agent = getAgent(this.config.agentId, this.config.channel);
            if (agent) {
              broadcastUpdate(this.config.channel, {
                type: "message",
                ts: "",
                user: this.config.agentId,
                text: "",
                agent_id: this.config.agentId,
                avatar_color: agent.avatar_color || "#D97706",
                is_sleeping: false,
              } as any);
            }
          }

          if ((isWakeup || isNewAgent) && pending.length > MAX_WAKEUP_MESSAGES) {
            const skipped = pending.length - MAX_WAKEUP_MESSAGES;
            const skippedMessages = pending.slice(0, skipped);
            pending = pending.slice(skipped);

            // Mark skipped messages as processed so they don't reappear
            const lastSkippedTs = skippedMessages[skippedMessages.length - 1].ts;
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

            // Build a conversation summary of skipped messages
            const convoLines: string[] = [];
            for (const m of skippedMessages) {
              const user = m.user === "UHUMAN" ? "Human" : m.agent_id || m.user || "unknown";
              const text = (m.text || "").slice(0, 200).replace(/\n/g, " ");
              convoLines.push(`${user}: ${text}`);
            }
            const summary = convoLines.join("\n");

            const contextLabel = isNewAgent
              ? `[ONBOARDING] You've just been added to this channel.`
              : `[WAKEUP] You've just woken up from sleep.`;
            const contextDesc = isNewAgent
              ? `This channel already has ${skipped} message(s) of prior conversation.`
              : `While you were sleeping, ${skipped} message(s) were exchanged on this channel.`;

            pending.unshift({
              ts: "0",
              user: "UHUMAN",
              text: [
                contextLabel,
                ``,
                `${contextDesc}`,
                `Here is a summary of the prior conversation (already processed — do NOT call chat_mark_processed for any of these):`,
                ``,
                `--- Prior conversation ---`,
                summary,
                `--- End of prior conversation ---`,
                ``,
                `Now focus ONLY on the new message(s) below. Use the prior conversation as context to understand what happened, but only respond to the new messages.`,
              ].join("\n"),
            });

            logger.info(
              `${isNewAgent ? "New agent onboarding" : "Wakeup"}: skipped ${skipped} old messages, processing ${pending.length - 1} recent`,
            );
          }
          this.processing = true;
          this.processingStartedAt = Date.now();
          this.lastActivityAt = Date.now();
          this.pendingTimestamps = pending.map((m: any) => m.ts);

          // Track seen-but-not-processed timestamps for prompt differentiation on retry.
          // After successful processing (or force-mark), these are removed.
          const isContinuation = unseen.length === 0 && seenNotProcessed.length > 0;
          if (!isContinuation) {
            // Only add genuinely unseen timestamps to in-memory tracking.
            // seenNotProcessed messages are already tracked from the previous poll.
            for (const m of unseen) this.pendingSeenTimestamps.add(m.ts);
            this.persistPendingSeenTimestamps();
          }

          // Mark messages as seen and broadcast to UI
          try {
            const tsList = pending.map((m: any) => m.ts);
            const newlySeen = markMessagesSeen(this.config.channel, this.config.agentId, tsList);
            if (newlySeen.length > 0) {
              const lastHumanTs = pending.filter((m: any) => m.user === "UHUMAN").slice(-1)[0]?.ts;
              if (lastHumanTs && newlySeen.includes(lastHumanTs)) {
                broadcastMessageSeen(this.config.channel, lastHumanTs, this.config.agentId);
              }
            }
          } catch (err) {
            logger.error("markMessagesSeen/broadcastMessageSeen failed:", err);
          }

          setAgentStreaming(this.config.agentId, this.config.channel, true);
          broadcastAgentStreaming(this.config.channel, this.config.agentId, true);

          // Interrupt poller — aborts SDK query if new messages arrive from any channel member
          // (human or other agents — all are collaborators in the channel)
          let interrupted = false;
          const interruptMessageMap = new Map<string, any>();
          const pendingTimestampSet = new Set(this.pendingTimestamps);
          let interruptPollCount = 0;
          this.interruptDetected = false;
          this.wasCancelledByHeartbeat = false;
          const interruptPoller = setInterval(() => {
            if (!this.processing) return;
            interruptPollCount++;
            try {
              const newPending = this.pollForMessages();
              const newMessages = newPending.filter(
                (m: any) => !pendingTimestampSet.has(m.ts) && !interruptMessageMap.has(m.ts),
              );
              // Debug: log every 5th poll to confirm poller is running (gated to avoid prod noise)
              if (interruptPollCount % 5 === 0) {
                logger.debug(
                  `Interrupt poll #${interruptPollCount}: ${newPending.length} pending, ${newMessages.length} new, ac=${this.abortController ? "set" : "null"}`,
                );
              }
              if (newMessages.length > 0) {
                interrupted = true;
                this.interruptDetected = true;
                for (const m of newMessages) interruptMessageMap.set(m.ts, m);
                logger.info(
                  `Interrupted by ${newMessages.length} new message(s) (poll #${interruptPollCount}, ac.aborted=${this.abortController?.signal.aborted})`,
                );
                try {
                  this.abortController?.abort();
                } catch (abortErr) {
                  logger.error(`AbortController.abort() threw: ${abortErr}`);
                }
              }
            } catch (e) {
              // Polling errors during interrupt detection are non-fatal
              logger.warn(`Interrupt poll error: ${e}`);
            }
          }, 2000);

          try {
            await this.processMessages(pending, unseen, seenNotProcessed);
          } catch (err: unknown) {
            // Always check for session corruption, even on interrupt (aborted session may be invalid)
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("No conversation found") || msg.includes("Invalid `signature` in `thinking` block")) {
              logger.warn(`Corrupted session — resetting for fresh start`);
              this.sessionId = null;
              this.persistSessionId(null);
            }
            // Only log unexpected errors — suppress abort errors from interrupts, heartbeats,
            // and user-triggered sleep (setSleeping(true) aborts the in-flight SDK call).
            if (!interrupted && !this.wasCancelledByHeartbeat && !this.sleeping) {
              logger.error(`Error: ${msg}`);
            }
          } finally {
            clearInterval(interruptPoller);
            setAgentStreaming(this.config.agentId, this.config.channel, false);
            broadcastAgentStreaming(this.config.channel, this.config.agentId, false);
            this.processing = false;
            this.processingStartedAt = null;
            this.lastActivityAt = Date.now();

            // On successful completion, clear seen timestamps for the processed batch.
            // They will be re-added if they appear in the next poll (unprocessed retry).
            if (!interrupted) {
              for (const ts of this.pendingTimestamps) {
                this.pendingSeenTimestamps.delete(ts);
              }
              this.persistPendingSeenTimestamps();
            }
          }

          if (interrupted) {
            // Advance last_processed_ts to last message in the interrupted batch
            // so next poll only returns NEW messages (the corrections)
            const lastBatchTs = this.pendingTimestamps[this.pendingTimestamps.length - 1];
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
            this.pendingTimestamps = [];

            // Infinite interrupt loop — each resume turn can itself be interrupted,
            // allowing the user to redirect the agent as many times as needed.
            let resumeProcessingMsgs: any[] = pending;
            let resumeInterruptMsgs: any[] = Array.from(interruptMessageMap.values());

            while (resumeInterruptMsgs.length > 0 && this.running) {
              this.processing = true;
              this.processingStartedAt = Date.now();
              this.lastActivityAt = Date.now();
              this.pendingTimestamps = resumeInterruptMsgs.map((m: any) => m.ts);

              try {
                markMessagesSeen(this.config.channel, this.config.agentId, this.pendingTimestamps);
              } catch {
                // Intentionally swallowed — best-effort seen-marking on resume; streaming continues regardless
              }

              setAgentStreaming(this.config.agentId, this.config.channel, true);
              broadcastAgentStreaming(this.config.channel, this.config.agentId, true);

              // Interrupt poller for this resume turn — enables infinite chained interrupts
              let resumeInterrupted = false;
              const resumeInterruptMap = new Map<string, any>();
              const resumeSeenTs = new Set(this.pendingTimestamps);
              this.wasCancelledByHeartbeat = false;
              this.interruptDetected = false;
              const resumePoller = setInterval(() => {
                if (!this.processing) return;
                try {
                  const newPending = this.pollForMessages();
                  const newMsgs = newPending.filter(
                    (m: any) => !resumeSeenTs.has(m.ts) && !resumeInterruptMap.has(m.ts),
                  );
                  if (newMsgs.length > 0) {
                    resumeInterrupted = true;
                    this.interruptDetected = true;
                    for (const m of newMsgs) resumeInterruptMap.set(m.ts, m);
                    logger.info(
                      `Resume interrupted by ${newMsgs.length} new message(s) (ac.aborted=${this.abortController?.signal.aborted})`,
                    );
                    try {
                      this.abortController?.abort();
                    } catch (abortErr) {
                      logger.error(`AbortController.abort() threw: ${abortErr}`);
                    }
                  }
                } catch (e) {
                  logger.warn(`Resume interrupt poll error: ${e}`);
                }
              }, 2000);

              try {
                const hadUnsentText = !this.turnChatSent && this.turnStreamText.trim().length > 0;
                const interruptPrompt = this.formatInterruptPrompt(
                  resumeProcessingMsgs,
                  resumeInterruptMsgs,
                  hadUnsentText,
                );
                await this.processMessagesWithPrompt(interruptPrompt, resumeInterruptMsgs);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!this.wasCancelledByHeartbeat && !this.sleeping) {
                  logger.error(`Interrupt processing error: ${msg}`);
                  if (
                    msg.includes("No conversation found") ||
                    msg.includes("Invalid `signature` in `thinking` block")
                  ) {
                    logger.warn(`Corrupted session on interrupt resume — resetting`);
                    this.sessionId = null;
                    this.persistSessionId(null);
                  }
                }
              } finally {
                clearInterval(resumePoller);
                setAgentStreaming(this.config.agentId, this.config.channel, false);
                broadcastAgentStreaming(this.config.channel, this.config.agentId, false);
                this.processing = false;
                this.processingStartedAt = null;
                this.lastActivityAt = Date.now();
              }

              if (resumeInterrupted) {
                // Advance cursor past the resume batch and prepare for next iteration
                const lastResumeTs = this.pendingTimestamps[this.pendingTimestamps.length - 1];
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
                this.pendingTimestamps = [];
                resumeProcessingMsgs = resumeInterruptMsgs;
                resumeInterruptMsgs = Array.from(resumeInterruptMap.values());
              } else {
                break;
              }
            }

            // Let forceMarkRetries accumulate naturally — don't reset counters
            // Add size cap to prevent unbounded growth from repeated interrupts
            if (this.forceMarkRetries.size > 500) {
              // Evict oldest half to prevent unbounded growth while preserving recent retry counts
              const entries = [...this.forceMarkRetries.entries()];
              for (let i = 0; i < Math.floor(entries.length / 2); i++) {
                this.forceMarkRetries.delete(entries[i][0]);
              }
            }
            this.forceMarkUnprocessed();
            continue;
          }
          this.forceMarkUnprocessed();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Poll error: ${message}`);
          await Bun.sleep(200);
        }
      }

      logger.info(`Stopped: ${this.config.channel}:${this.config.agentId}`);
    } finally {
      // Always resolve stoppedPromise — even if init throws before the while loop
      this.stoppedResolve?.();
      this.stoppedResolve = null;
    }
  }

  stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    this.cancelProcessing();
    // Return a promise that resolves when the main loop actually exits.
    // If the loop already exited (or never started), resolve immediately.
    if (!this.stoppedPromise) return Promise.resolve();
    // Timeout guard: don't block forever (e.g. stuck in Bun.sleep(5000) when userSleeping).
    // After timeout, old loop may briefly overlap with new worker (~0-5s). This is safe:
    // the old loop is sleeping (won't process messages) and registerMainWorker overwrites the key.
    return Promise.race([this.stoppedPromise, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
  }

  // --------------------------------------------------------------------------
  // Tool result handler (called by PostToolUse hook in-process)
  // --------------------------------------------------------------------------

  handleToolResult(toolName: string, toolInput: unknown, toolResponse: unknown, toolUseId?: string): void {
    const { channel, agentId } = this.config;
    const input = (toolInput || {}) as Record<string, any>;
    const response = toolResponse as any;
    const result = truncateToolResult(response);
    const status = response?.error || response?.isError || result.startsWith("Error: ") ? "error" : "completed";
    const description = formatToolDescription(toolName, input);
    const shortName = toolName.replace(/^mcp__clawd__/, "");

    // Broadcasts are unconditional — fire first so no exception in tracking can drop them.
    // Thread toolUseId so the UI can pair start/end events by id (correct for
    // concurrent same-named tool calls within a turn).
    broadcastAgentToolCall(channel, agentId, toolName, input, "started", undefined, toolUseId);
    broadcastAgentToolCall(channel, agentId, toolName, input, status, `${description}\n${result}`, toolUseId);
    saveToMemory(
      this.memorySessionId,
      "tool",
      `${description}\n${result}`,
      undefined,
      toolUseId || `tool_${toolName}_${Date.now()}`,
    );

    // All tracking below is best-effort. Each block is independently try-catched
    // so one failure cannot cascade and drop later tracking work.

    // Track chat_send_message: turn flag + trajectory
    // (message content is already captured via handleAssistantMessage → session DB,
    //  no need for a per-turn in-memory log anymore).
    try {
      if (toolName === "mcp__clawd__chat_send_message" && !response?.error) {
        this.turnChatSent = true;
        if (this.trajectoryRecorder) {
          this.trajectoryRecorder.recordAssistantResponse(sanitize(input?.text || ""));
        }
      }
    } catch (err) {
      logger.error(`[handleToolResult] chat_send_message tracking failed:`, err);
    }

    // Track chat_mark_processed flag
    try {
      if (toolName === "mcp__clawd__chat_mark_processed" && !response?.error) {
        this.turnMarkProcessed = true;
      }
    } catch (err) {
      logger.error(`[handleToolResult] mark_processed tracking failed:`, err);
    }

    // Skill improvement at task completion
    try {
      if ((toolName === "chat_mark_processed" || toolName === "mcp__clawd__chat_mark_processed") && !response?.error) {
        const correctionsSnapshot = [...this.pendingCorrections];
        const activatedSnapshot = [...this.turnActivatedSkills];
        this.pendingCorrections = [];
        this.turnActivatedSkills = new Set();
        this.turnBufferStartIdx = this.skillReviewBuffer.length;

        if (correctionsSnapshot.length > 0 && activatedSnapshot.length > 0) {
          const { projectRoot } = this.config;
          const MAX_TURN_SLICE = 8_000;
          const rawSlice = this.skillReviewBuffer
            .slice(this.turnBufferStartIdx)
            .map((e) => `[${e.role}] ${e.content}`)
            .join("\n");
          const turnSlice =
            rawSlice.length > MAX_TURN_SLICE ? rawSlice.slice(0, MAX_TURN_SLICE) + " [truncated]" : rawSlice;
          for (const skillName of activatedSnapshot) {
            if (this.skillsBeingImproved.has(skillName)) continue;
            this.skillsBeingImproved.add(skillName);
            improveSkillFromCorrections(skillName, correctionsSnapshot, turnSlice, projectRoot)
              .finally(() => this.skillsBeingImproved.delete(skillName))
              .catch((err) => console.error("[SkillImprovement] CC path:", err));
          }
        }
      }
    } catch (err) {
      logger.error(`[handleToolResult] skill improvement tracking failed:`, err);
    }

    // skill_activate success tracking with structural check
    try {
      if (toolName === "skill_activate" || toolName === "mcp__clawd__skill_activate") {
        const resultText = truncateToolResult(response);
        let ok = !response?.error && !response?.isError;
        if (ok && resultText) {
          try {
            const parsed = JSON.parse(resultText);
            if (parsed && typeof parsed === "object") {
              if (parsed.ok === false || parsed.error) ok = false;
            }
          } catch {
            const lower = resultText.toLowerCase();
            if (lower.includes("not found") || lower.startsWith("error:") || lower.includes("failed to")) {
              ok = false;
            }
          }
        }
        const skillName = (toolInput as any)?.name;
        if (ok && typeof skillName === "string" && skillName.length > 0) {
          this.turnActivatedSkills.add(skillName);
        }
      }
    } catch (err) {
      logger.error(`[handleToolResult] skill_activate tracking failed:`, err);
    }

    // (turnToolLog removed: assistant rows with tool_use blocks are already
    //  persisted via handleAssistantMessage, and tool_result rows via saveToMemory
    //  above — both are rebuilt into the next turn's SDK message stream by
    //  buildSdkMessages. No separate per-turn log needed.)

    // Skill review buffer + trigger
    try {
      this.sessionToolCallCount++;
      this.addToSkillReviewBuffer({
        role: "tool",
        content: sanitize(truncateToolResult(response).slice(0, 200)),
        toolName: shortName,
      });
      this.maybeRunSkillReview();
    } catch (err) {
      logger.error(`[handleToolResult] skill review tracking failed:`, err);
    }

    // Trajectory recording
    try {
      if (this.trajectoryRecorder && !CONVERSATION_TOOLS.has(shortName)) {
        const trResult = sanitize(truncateToolResult(response).slice(0, 2000));
        const trSuccess = !response?.error && !response?.isError && !trResult.startsWith("Error:");
        this.trajectoryRecorder.recordToolCall(shortName, toolInput, trResult, trSuccess);
      }
    } catch (err) {
      logger.error(`[handleToolResult] trajectory recording failed:`, err);
    }
  }

  // --------------------------------------------------------------------------
  // Session compaction
  // --------------------------------------------------------------------------

  /**
   * If the session is approaching the token limit, compact it using an
   * LLM-generated summary of the real Claw'd channel messages — not the LLM
   * prompt blobs stored in the session DB.
   *
   * Channel messages are clean and fully attributed (human, agent IDs), making
   * them far better source material for a summary than parsed prompt text.
   */
  private async maybeCompactSession(): Promise<void> {
    const manager = getSessionManager();
    if (!manager.needsCompaction(this.memorySessionName, 100_000)) return;

    const { model } = this.config;
    const KEEP_COUNT = 50;

    // Summarize the ROWS being deleted (not channel chat) — otherwise the agent
    // loses its own reasoning history ([CC-Turn] thought/action blocks) while the
    // summary describes user/agent chat that is already fully available via the
    // channel DB and injected into the preamble separately.
    const rowsToDelete = manager.getMessagesToCompactByName(this.memorySessionName, KEEP_COUNT);
    if (rowsToDelete.length === 0) return;

    const lines: string[] = [];
    for (const row of rowsToDelete) {
      const content = (row.content || "").trim();
      if (!content) {
        // Tool-use-only assistant rows have empty content but a tool_calls field.
        // Surface a short marker so the summary reflects that tools were invoked.
        if (row.role === "assistant" && row.tool_calls) {
          lines.push(`[you]: (used tools)`);
        }
        continue;
      }
      if (content.startsWith("[CC-Turn]:")) {
        // Legacy structured turn row — strip the marker, pass inner lines through.
        const inner = content.slice("[CC-Turn]:".length).trim();
        if (inner) lines.push(inner);
      } else if (content.startsWith("[Sent to chat]:") || content.startsWith("[Actions taken]:")) {
        lines.push(`[you]: ${content.slice(0, 600)}`);
      } else if (row.role === "assistant") {
        // New-format: agent's own text message or text+tool_use assistant row.
        lines.push(`[you]: ${content.slice(0, 600)}`);
      } else if (row.role === "tool") {
        // Tool result — materialised as a user tool_result in the rebuilt stream.
        lines.push(`[tool-result]: ${content.replace(/\s+/g, " ").slice(0, 400)}`);
      } else if (row.role === "user") {
        // Channel message row (new format: "[ts] author: text") or legacy prompt blob.
        lines.push(`[user]: ${content.replace(/\s+/g, " ").slice(0, 400)}`);
      }
    }

    if (lines.length === 0) return;

    logger.info(
      `Compacting session — summarising ${rowsToDelete.length} session rows (${lines.length} lines) with LLM...`,
    );

    const conversationText = lines.join("\n");
    const summary = await generateConversationSummary(conversationText, rowsToDelete.length, model);

    manager.compactSessionByName(this.memorySessionName, KEEP_COUNT, summary);
    logger.info(`Session compacted with LLM summary of session rows`);
  }

  // --------------------------------------------------------------------------
  // Skill review
  // --------------------------------------------------------------------------

  /**
   * Run a background skill review if enough tool calls have accumulated.
   * Uses a direct LLM call (same pattern as generateConversationSummary) rather
   * than spawning a full sub-agent — review is a single-turn analysis task.
   */
  private maybeRunSkillReview(): void {
    // CC agents use this inline implementation rather than the plugin-based one
    // (src/agent/plugins/skill-review-plugin.ts) used by non-CC agents via worker-loop.ts.
    // Both share buildSkillReviewPrompt/parseSkillRecommendations/postSystemMessage.
    // The plugin path has richer hooks (compaction, correction detection); this path
    // is simpler because the CC SDK lifecycle doesn't have plugin slots.
    // Lazily initialise — build once from runtime values, not from env-only
    // derivation (CLAWD_API_URL is rarely set; chatApiUrl is always available).
    if (this._srConfig === null) {
      this._srConfig =
        process.env.CLAWD_SKILL_REVIEW_ENABLED === "false"
          ? "disabled"
          : (() => {
              const memCfg = loadConfigFile().memory;
              const memModel = typeof memCfg === "object" && memCfg?.model ? memCfg.model : undefined;
              return {
                reviewInterval: parseInt(process.env.CLAWD_SKILL_REVIEW_INTERVAL ?? "20", 10),
                minToolCalls: parseInt(process.env.CLAWD_SKILL_REVIEW_MIN_TOOLS ?? "10", 10),
                cooldownMs: parseInt(process.env.CLAWD_SKILL_REVIEW_COOLDOWN_MS ?? "300000", 10),
                maxSkills: parseInt(process.env.CLAWD_SKILL_REVIEW_MAX_SKILLS ?? "2", 10),
                model: memModel,
              };
            })();
    }
    if (this._srConfig === "disabled") return;
    const srConfig = this._srConfig;

    const reviewInterval = srConfig.reviewInterval;
    const minToolCalls = srConfig.minToolCalls;
    const cooldownMs = srConfig.cooldownMs;
    const maxSkills = srConfig.maxSkills;

    if (this.skillReviewInProgress) return;
    if (this.sessionToolCallCount < minToolCalls) return;
    if (this.sessionToolCallCount - this.skillReviewLastToolCount < reviewInterval) return;
    if (Date.now() - this.skillReviewLastAt < cooldownMs) return;

    this.skillReviewInProgress = true;
    this.skillReviewLastAt = Date.now();
    this.skillReviewLastToolCount = this.sessionToolCallCount;

    const { channel, chatApiUrl, projectRoot } = this.config;
    const buffer = [...this.skillReviewBuffer];

    // Build transcript from buffer
    const lines: string[] = [
      `# CC Agent Skill Review`,
      `Tool calls: ${this.sessionToolCallCount}`,
      `Buffer entries: ${buffer.length}`,
      "",
      "## Recent Activity",
      "",
    ];
    for (const entry of buffer.slice(-100)) {
      if (entry.role === "tool") {
        lines.push(`[tool: ${entry.toolName}] ${entry.content}`);
      } else if (entry.role === "assistant" && entry.content) {
        lines.push(`[assistant] ${entry.content.slice(0, 200)}`);
      } else if (entry.role === "user" && entry.content) {
        lines.push(`[human] ${entry.content.slice(0, 200)}`);
      }
    }
    const transcript = lines.join("\n");
    const prompt = `${buildSkillReviewPrompt(maxSkills)}\n\n## Transcript to Analyze\n\n${transcript}`;

    // Fire-and-forget — don't block the agent turn
    (async () => {
      try {
        const { CopilotClient } = await import("../agent/api/client");
        const client = new CopilotClient("");
        const timeoutSignal = new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000));
        const llmCall = client.complete({
          model: srConfig.model || "claude-sonnet-4.5", // srConfig.model is seeded from memory.model in config
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 2000,
        });
        const response = await Promise.race([llmCall, timeoutSignal]);
        client.close();

        if (!response) {
          logger.info(`[SkillReview] Timed out`);
          return;
        }

        const resultText = response.choices[0]?.message?.content ?? "";
        const skills = parseSkillRecommendations(resultText, projectRoot);
        if (skills.length === 0) {
          logger.info(`[SkillReview] No skills found`);
          return;
        }

        const skillManager = getSkillManager(projectRoot);
        const created: Array<{ name: string; description: string; path: string }> = [];
        for (const skill of skills.slice(0, maxSkills)) {
          if (skillManager.getSkill(skill.name)) continue; // no overwrite
          const saved = skillManager.saveSkill(
            { name: skill.name, description: skill.description, triggers: skill.triggers, content: skill.skillContent },
            "project",
          );
          if (saved.success) {
            created.push({
              name: skill.name,
              description: skill.description,
              path: `.clawd/skills/${skill.name}/SKILL.md`,
            });
            logger.info(`[SkillReview] Created skill: ${skill.name}`);
          }
        }

        if (created.length > 0) {
          await postSystemMessage(chatApiUrl, channel, created, skills.length - created.length);
        }
      } catch (err) {
        logger.error(`[SkillReview] Error: ${err}`);
      } finally {
        this.skillReviewInProgress = false;
      }
    })();
  }

  // --------------------------------------------------------------------------
  // Message processing
  // --------------------------------------------------------------------------

  private pollForMessages(): any[] {
    const { channel, agentId } = this.config;
    const seen = db
      .query<{ last_processed_ts: string | null }, [string, string]>(
        `SELECT last_processed_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
      )
      .get(agentId, channel);
    const lastTs = seen?.last_processed_ts || undefined;

    const result = getPendingMessages(channel, lastTs, true, 50);
    // Filter: include any message not from this agent, excluding anonymous UBOT messages.
    // This catches: UHUMAN, UWORKER-*, other CC Main agents (UBOT+agent_id), and sub-agents
    // (custom user IDs like "verify-v5-A-8f32cd"). Mirrors WorkerLoop's isRelevant() logic.
    const pending = ((result as any).messages || []).filter(
      (m: any) => m.ts > (lastTs || "0") && m.agent_id !== agentId && !(m.user === "UBOT" && !m.agent_id),
    );
    return pending;
  }

  /** Poll for messages with seen/not-processed distinction for prompt labeling.
   *  Returns all pending messages plus arrays split by seen state.
   *  pendingSeenTimestamps persists to DB (agent_seen.pending_seen_ts_json) via
   *  persistPendingSeenTimestamps() — so crash mid-turn doesn't misclassify resumed
   *  messages as fresh and cause duplicate replies. */
  private pollForMessagesWithSeen(): { pending: any[]; unseen: any[]; seenNotProcessed: any[] } {
    const { channel, agentId } = this.config;
    const seen = db
      .query<{ last_processed_ts: string | null; last_seen_ts: string | null }, [string, string]>(
        `SELECT last_processed_ts, last_seen_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
      )
      .get(agentId, channel);
    const lastProcessedTs = seen?.last_processed_ts || undefined;
    const lastSeenTs = seen?.last_seen_ts || undefined;

    const result = getPendingMessages(channel, lastProcessedTs, true, 50);
    const all = ((result as any).messages || []).filter(
      (m: any) => m.agent_id !== agentId && !(m.user === "UBOT" && !m.agent_id),
    );

    // Classify each message
    const pending: any[] = [];
    const unseen: any[] = [];
    const seenNotProcessed: any[] = [];

    for (const m of all) {
      const afterProcessed = !lastProcessedTs || m.ts > lastProcessedTs;
      if (!afterProcessed) continue;

      // Check in-memory seen tracking (overrides DB last_seen_ts for retries)
      const inMemorySeen = this.pendingSeenTimestamps.has(m.ts);
      const dbSeen = lastSeenTs && m.ts <= lastSeenTs;

      if (inMemorySeen || dbSeen) {
        seenNotProcessed.push(m);
      } else {
        unseen.push(m);
      }
      pending.push(m);
    }

    return { pending, unseen, seenNotProcessed };
  }

  /** Process messages with a pre-built prompt (used by interrupt resume path) */
  private async processMessagesWithPrompt(prompt: string, messages: any[]): Promise<void> {
    // isNewTurn=false: interrupt-resume turn. Persists the new interrupt messages
    // that triggered the abort (so they appear in this turn's rebuilt stream AND
    // in future turns' history). The SDK is NOT resumed via sessionId anymore —
    // the iterable rebuilt by buildSdkMessages carries complete history including
    // the aborted main turn's partial work (assistant/tool rows persisted as
    // they arrive via handleAssistantMessage / handleToolResult).
    return this._runSDKTurn(prompt, messages, false);
  }

  private async processMessages(messages: any[], unseen: any[], seenNotProcessed: any[]): Promise<void> {
    const prompt = this.formatPromptWithSeen(unseen, seenNotProcessed);
    return this._runSDKTurn(prompt, messages);
  }

  /** Defense-in-depth re-entrancy guard — the outer poll loop already serializes
   *  turns, but if a future refactor accidentally interleaves a second call we
   *  want a loud failure rather than silent state corruption.
   *
   *  Note: re-injection paths (unsent-text + mark-processed prompts inside
   *  _runSDKTurnImpl) call runSDKQuery directly, NOT _runSDKTurn — so they
   *  intentionally do not trip this guard. They share turn state by design. */
  private _turnInFlight = false;

  private async _runSDKTurn(prompt: string, messages: any[], isNewTurn = true): Promise<void> {
    if (this._turnInFlight) {
      throw new Error("_runSDKTurn re-entry detected — concurrent turns for the same worker are not supported");
    }
    this._turnInFlight = true;
    try {
      await this._runSDKTurnImpl(prompt, messages, isNewTurn);
    } finally {
      this._turnInFlight = false;
    }
  }

  // _prompt is kept in the signature for API compatibility with _runSDKTurn callers
  // (processMessages / processMessagesWithPrompt pass it). In the role-structured
  // refactor the actual turn input is rebuilt from session rows by buildSdkMessages,
  // so _prompt is unused here — channel messages are persisted below and rebuilt.
  private async _runSDKTurnImpl(_prompt: string, messages: any[], isNewTurn = true): Promise<void> {
    // Always discard the CC session before the main SDK call. The AsyncIterable
    // returned by sdkPrompt() carries the full rebuilt conversation history from
    // our SQLite store, so `resume:` is redundant AND potentially harmful —
    // combining it with a full-history iterable risks duplicating turns if the
    // SDK merges resumed state with the replayed iterable.
    // Re-injection paths below (plain-string prompts) still use this.sessionId,
    // populated by onSessionId when the main SDK call responds.
    this.sessionId = null;

    // Persist each channel message as its own user-role row with an attributed
    // "[timestamp] author: text" prefix. Each becomes a separate SDKUserMessage
    // when buildSdkMessages rebuilds the stream for the SDK. Runs on BOTH new
    // turns and interrupt-resume turns — the resume path receives the NEW
    // messages that triggered the interrupt (distinct from the already-persisted
    // main-turn batch), and those must be recorded here so they appear in this
    // turn's stream and in all future turns' rebuilt history.
    // Heartbeats are never persisted — they're delivered inline below.
    for (const msg of messages) {
      if (msg.kind === "heartbeat") continue;
      const text = (msg.text || "").trim();
      if (!text) continue;
      const author = msg.user === "UHUMAN" ? "human" : msg.agent_id || msg.user || "unknown";
      saveToMemory(this.memorySessionId, "user", `[${msg.ts}] ${author}: ${text}`);
    }

    // Summarise old history AFTER persisting incoming messages so needsCompaction
    // sees the full post-persistence byte count — a batch that tips the session
    // over threshold triggers compaction THIS turn instead of lagging to the
    // next. SessionManager.addMessage invalidates the needsCompaction cache on
    // every insert, so this post-persistence check always reads fresh data.
    // The just-persisted messages are the most recent and are protected by
    // keepCount in compactSession, so they survive the summarisation.
    // Compaction summary rows have created_at=0 and are lifted into the system
    // prompt below (NOT the message stream).
    //
    // Try/catch: compaction is BEST-EFFORT. An LLM failure inside
    // generateConversationSummary must NOT abort the turn — if it did, the
    // incoming messages would already be persisted (above) but the turn would
    // not run, and the next poll would re-persist them (duplicate rows). Log
    // the failure and proceed with whatever uncompacted history exists.
    if (isNewTurn) {
      try {
        await this.maybeCompactSession();
      } catch (err) {
        logger.warn(`maybeCompactSession failed (non-fatal, proceeding uncompacted): ${err}`);
      }
    }

    // Clear the correction-scan dedup set at the start of each NEW turn so
    // fresh turns scan their messages from scratch. Resume turns (isNewTurn=false)
    // keep the set intact so messages already scanned in the aborted main turn
    // aren't re-scanned.
    if (isNewTurn) this.pendingScannedCorrectionTs.clear();

    // Feed channel messages into skill review buffer AND scan for user corrections.
    // Dedup by timestamp so resume-turn messages that were already scanned in the
    // aborted main turn don't get double-counted. Without this dedup, corrections
    // from resume-turn user messages were silently dropped (the old code gated the
    // entire scan loop on isNewTurn).
    for (const msg of messages) {
      const text = (msg.text || "").trim();
      if (!text) continue;
      const sender = msg.user === "UHUMAN" ? "human" : msg.agent_id || msg.user || "unknown";

      // Skill-review buffer on new turns only — it's an agent-work buffer, not a
      // correction-detection buffer.
      if (isNewTurn) {
        this.addToSkillReviewBuffer({ role: "user", content: `[${sender}]: ${sanitize(text.slice(0, 500))}` });
      }

      // Correction capture runs on BOTH new turns AND resume turns, dedup'd by ts.
      // Previously only new turns scanned — resume-turn corrections silently dropped.
      if (msg.user === "UHUMAN" && msg.ts && !this.pendingScannedCorrectionTs.has(msg.ts)) {
        this.pendingScannedCorrectionTs.add(msg.ts);
        if (containsCorrection(text)) {
          this.pendingCorrections.push(text.slice(0, 500));
          if (this.pendingCorrections.length > 100) {
            this.pendingCorrections = this.pendingCorrections.slice(-100);
          }
        }
      }
    }

    if (isNewTurn) {
      if (this.trajectoryRecorder) {
        const userText = messages
          .filter((m: any) => (m.text || "").trim())
          .map((m: any) => {
            const sender = m.user === "UHUMAN" ? "human" : m.agent_id || m.user || "unknown";
            return `[${sender}]: ${(m.text || "").trim()}`;
          })
          .join("\n");
        if (userText) this.trajectoryRecorder.recordUserMessage(sanitize(userText));
      }

      // Reset per-turn improvement state AFTER the user-message buffer loop so this
      // turn's user messages are included in the slice for improvement context.
      this.turnActivatedSkills = new Set();
      this.turnBufferStartIdx = this.skillReviewBuffer.length;
    }

    this.abortController = new AbortController();
    const { channel, agentId, model, agentFileConfig } = this.config;
    const basePrompt = this.loadIdentity();

    // Build the system prompt using the shared dynamic builder (same as clawd-chat path)
    // with MCP prefix so all tool references use the full mcp__clawd__ namespace.
    // Update keywords from user message for memory relevance
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.text) {
        this.lastKeywords = extractKeywords(lastMsg.text).slice(0, 15);
      }
    }

    // Query other agents in the same channel (for the "other agents" section in system prompt)
    const otherAgents: AgentFileConfig[] = [];
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

    const ccCtx: PromptContext = {
      agentId: this.config.agentId,
      channel: this.config.channel,
      projectRoot: this.config.projectRoot,
      isSpaceAgent: false,
      availableTools: [
        "bash",
        "spawn_agent",
        "todo_write",
        "todo_read",
        "chat_search",
        // Memory tools (same as non-CC agents)
        "memo_save",
        "memo_recall",
        "memo_delete",
        "memo_pin",
        "memo_unpin",
        // MCP file tools — project-root-scoped, sandboxed
        "file_view",
        "file_edit",
        "file_multi_edit",
        "file_create",
        "file_glob",
        "file_grep",
        // Custom scripts — project-scoped reusable scripts in .clawd/tools/
        "custom_script",
      ],
      platform: process.platform,
      model: this.config.model || "sonnet",
      gitRepo: false,
      browserEnabled: false,
      contextMode: false,
      agentFileConfig: this.config.agentFileConfig,
      otherAgents: otherAgents.length > 0 ? otherAgents : undefined,
      otherAgentStatuses: Object.keys(otherAgentStatuses).length > 0 ? otherAgentStatuses : undefined,
      mcpPrefix: "mcp__clawd__",
      // CC agents consume channel messages via the role-structured SDK iterable,
      // not via a preamble string. The chat section of the system prompt needs
      // to describe the new format so the agent knows where its input lives.
      roleStructuredInput: true,
    };
    let systemPrompt = buildDynamicSystemPrompt(ccCtx);

    // Inject relevant memories (same system as non-CC agents)
    const memoryContext = this.loadMemoryContext();
    if (memoryContext) {
      systemPrompt += "\n\n" + memoryContext;
    }

    // Inject compaction summary (if prior turns were summarised). Summary rows
    // live in the session DB with created_at=0; we lift them into the system
    // prompt instead of emitting as user messages so the agent sees them as
    // context, not as synthetic user turns.
    const summaries = getSessionManager().getCompactionSummariesByName(this.memorySessionName);
    if (summaries.length > 0) {
      systemPrompt += `\n\n<prior_conversation_summary>\n${summaries.join("\n\n")}\n</prior_conversation_summary>`;
    }

    // Dynamic: inject active sub-agent count as a system reminder (best-effort)
    try {
      const agentRes = await fetch(`${this.config.chatApiUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: "list_agents", arguments: { channel: this.config.channel } },
        }),
      });
      const agentJson = (await agentRes.json()) as any;
      const agentData = JSON.parse(agentJson?.result?.content?.[0]?.text ?? "{}") as any;
      const activeCount = ((agentData?.agents ?? []) as any[]).filter((a: any) => a.status === "active").length;
      if (activeCount > 0) {
        systemPrompt += `\n\n<system-reminder>${activeCount} sub-agent${activeCount > 1 ? "s are" : " is"} currently running in this channel. They will report back when done — do not start work that overlaps their tasks.</system-reminder>`;
      }
    } catch {
      /* best-effort — skip on error */
    }

    // Detect heartbeat-initiated turns via structural kind flag (set at poll time).
    // Fallback to substring match for safety with legacy callers.
    const isHeartbeatTurn =
      messages.length === 1 && (messages[0]?.kind === "heartbeat" || messages[0]?.text?.includes("[HEARTBEAT]"));

    // Reset per-turn re-injection state ONLY for fresh turns. Interrupt-resume turns
    // (isNewTurn=false) must preserve accumulated state from the aborted main turn so
    // tool calls/messages aren't silently lost.
    if (isNewTurn) {
      this.turnChatSent = false;
      this.turnMarkProcessed = false;
      this.turnStreamText = "";
    }

    // Build the SDK input as an AsyncIterable of role-structured messages from
    // the session DB. Channel messages are already persisted above (user rows
    // with "[ts] author: text" format). Heartbeats aren't persisted — the helper
    // appends them inline so the agent sees the wake signal this turn without
    // polluting future turns' history.
    const sessionName = this.memorySessionName;
    const heartbeatText = isHeartbeatTurn ? messages[0]?.text : null;

    // SDK options without the per-call `prompt`/`resume`/`abortController` —
    // these vary per invocation (main call vs. re-injection), so we build them
    // separately and compose. This avoids spreading a consumed async generator
    // into re-injection calls (they override `prompt` to a string, but copying
    // the already-iterated generator through spread is ugly and error-prone).
    const sharedSdkOpts = {
      model: model || "sonnet",
      cwd: this.config.projectRoot,
      providerName: this.config.provider,
      systemPrompt: basePrompt,
      agentName: "clawd-main",
      agentDef: {
        "clawd-main": {
          description: "Main channel agent for Claw'd",
          prompt: `${basePrompt}${systemPrompt}`,
        },
      },
      mcpServers: this.buildMcpServers(),
      yolo: this.config.yolo ?? false,
      // Custom CC providers (not the built-in "claude-code") must use mcp__clawd__web_search /
      // mcp__clawd__web_fetch — disable the CC-native equivalents for them.
      ...(this.config.provider && this.config.provider !== "claude-code"
        ? { disallowedTools: ["WebSearch", "WebFetch"] }
        : {}),
    };

    const sdkOpts = {
      ...sharedSdkOpts,
      prompt: buildSdkPromptWithHeartbeat(sessionName, heartbeatText),
      // resume: always undefined — the iterable above carries full rebuilt history
      // from the session DB. Re-injection calls below (plain-string prompts) still
      // pass resume: this.sessionId, populated via the onSessionId callback.
      resume: undefined,
      abortController: this.abortController,
    };

    try {
      const newSessionId = await runSDKQuery(sdkOpts, {
        onTextDelta: (text) => {
          this.turnStreamText += text;
          broadcastAgentToken(channel, agentId, text);
        },
        onThinkingDelta: (text) => broadcastAgentToken(channel, agentId, text, "thinking"),
        onAssistantMessage: (content) => this.handleAssistantMessage(content),
        onToolResult: (name, input, response, id) => this.handleToolResult(name, input, response, id),
        onActivity: () => {
          // Refresh timestamps to prevent stale streaming cleanup AND heartbeat timeout
          setAgentStreaming(agentId, channel, true);
          this.processingStartedAt = Date.now();
          this.lastActivityAt = Date.now();
        },
        onSessionId: (sid) => {
          if (sid) {
            this.sessionId = sid;
            this.persistSessionId(sid);
          } else {
            // SDK cleared stale session — reset
            this.sessionId = null;
            this.persistSessionId(null);
          }
        },
      });

      if (newSessionId) {
        this.sessionId = newSessionId;
        this.persistSessionId(newSessionId);
      }

      // Re-injection: if agent produced ANY text but never called chat_send_message,
      // send one ephemeral follow-up prompt so it can deliver the response.
      // Skip for: heartbeat turns, cancelled/aborted turns, interrupted turns (resume handles it).
      // REQUIRE this.sessionId: re-injection sends a plain-string prompt with
      // `resume: this.sessionId` to continue context. If sessionId is null (main
      // SDK threw before onSessionId fired), a fresh-session re-injection would
      // have ZERO history — the model would answer the NOTICE blind. Skip instead.
      if (
        !this.turnChatSent &&
        this.turnStreamText.trim().length > 0 &&
        !this.wasCancelledByHeartbeat &&
        !isHeartbeatTurn &&
        !this.abortController?.signal.aborted &&
        !this.interruptDetected &&
        !!this.sessionId
      ) {
        const reinjectionPrompt =
          "[NOTICE: Your previous turn produced output but did not call `mcp__clawd__chat_send_message` to deliver it — the human cannot see what you wrote.\n\n" +
          "If you intended to respond to the human, call `mcp__clawd__chat_send_message` with your response now.\n" +
          "If you intentionally chose not to respond, produce only [SILENT] and do nothing else.]";

        // Use a fresh AbortController for re-injection (the original may have been aborted).
        // Update this.abortController so cancelProcessing()/setSleeping() can still cancel it.
        const reinjAbort = new AbortController();
        this.abortController = reinjAbort;
        let reinjectionText = "";
        try {
          await runSDKQuery(
            {
              ...sharedSdkOpts,
              prompt: reinjectionPrompt,
              resume: this.sessionId || undefined,
              abortController: reinjAbort,
            },
            {
              onTextDelta: (text) => {
                reinjectionText += text;
              },
              onThinkingDelta: () => {},
              onAssistantMessage: () => {},
              onToolResult: (name, input, response, id) => this.handleToolResult(name, input, response, id),
              onActivity: () => {
                this.lastActivityAt = Date.now();
              },
              onSessionId: (sid) => {
                if (sid) {
                  this.sessionId = sid;
                  this.persistSessionId(sid);
                }
              },
            },
          );
        } catch (err) {
          // Re-injection is best-effort — ignore errors
          logger.error(`Re-injection failed: ${err}`);
        }

        // If agent replied [SILENT], produced nothing, or already sent via chat_send_message, discard
        if (reinjectionText.trim() && !reinjectionText.includes("[SILENT]") && !this.turnChatSent) {
          broadcastAgentToken(channel, agentId, reinjectionText);
        }
      }

      // Re-injection: if agent completed without calling chat_mark_processed,
      // send a follow-up prompt so it can mark the messages as processed.
      // Skip for: heartbeat turns, cancelled turns, or if mark_processed was already called.
      // Dual guard: signal.aborted catches cancelProcessing/setSleeping; interruptDetected catches poller-detected interrupts.
      // REQUIRE this.sessionId: same reason as the chat-send re-injection above —
      // a fresh-session reminder with `resume: undefined` sees no history, so
      // mark_processed would run with no context. Skip; next turn retries.
      if (
        !this.turnMarkProcessed &&
        !this.wasCancelledByHeartbeat &&
        !isHeartbeatTurn &&
        !this.abortController?.signal.aborted &&
        !this.interruptDetected &&
        !!this.sessionId
      ) {
        // Prefer the last actual pending timestamp; fall back to the last message
        // in this turn's batch, then to "latest" if both are unavailable.
        const lastTs =
          this.pendingTimestamps[this.pendingTimestamps.length - 1] || messages[messages.length - 1]?.ts || "latest";
        const reminderPrompt =
          `[NOTICE: You completed your turn but did not call \`mcp__clawd__chat_mark_processed\` to mark the message(s) as handled. ` +
          `This is required so the same messages are not polled again.\n\n` +
          `Call \`mcp__clawd__chat_mark_processed(timestamp="${lastTs}")\` now, even if empty. ` +
          `If you intentionally did not need to respond, produce only [SILENT].]`;

        // Use a tracked AbortController so the interrupt poller can abort this re-injection too.
        const markProcessedAbort = new AbortController();
        this.abortController = markProcessedAbort;
        try {
          await runSDKQuery(
            {
              ...sharedSdkOpts,
              prompt: reminderPrompt,
              resume: this.sessionId || undefined,
              abortController: markProcessedAbort,
            },
            {
              onTextDelta: () => {},
              onThinkingDelta: () => {},
              onAssistantMessage: () => {},
              onToolResult: (name, input, response, id) => this.handleToolResult(name, input, response, id),
              onActivity: () => {
                this.lastActivityAt = Date.now();
              },
              onSessionId: (sid) => {
                if (sid) {
                  this.sessionId = sid;
                  this.persistSessionId(sid);
                }
              },
            },
          );
        } catch (err: unknown) {
          // Best-effort — only log non-abort errors
          if (!markProcessedAbort.signal.aborted) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`Mark-processed re-injection failed: ${message}`);
          }
        }
      }

      // Save a tool-activity summary for turns where the agent used tools but
      // never called chat_send_message. Without this, tool-only turns leave no
      // trace in the preamble — the agent's work becomes invisible in context.
      if (this.turnMarkProcessed && this.trajectoryRecorder) {
        this.trajectoryRecorder.commitTurn();
      } else if (!this.turnMarkProcessed && this.trajectoryRecorder) {
        this.trajectoryRecorder.abortTurn();
      }

      // NOTE: improvement cannot trigger from CC path until beforeCompaction hook is
      // wired into the SDK — pendingCorrections is never populated here.
      // This block captures skill activations for future use when corrections are available.
      if (this.turnMarkProcessed && this.turnActivatedSkills.size > 0) {
        // CC path: no corrections available — skip improvement for now
        this.turnActivatedSkills = new Set();
      }
    } catch (err) {
      // Ensure the trajectory recorder does not carry stale pending state across turns
      // when the SDK or post-processing throws unexpectedly.
      if (this.trajectoryRecorder?.hasPendingState()) {
        this.trajectoryRecorder.abortTurn();
      }
      throw err; // re-throw so the caller's error handling still fires
    } finally {
      // Always clear the abortController reference so cancelProcessing/setSleeping
      // during the idle window between turns doesn't act on a stale controller.
      // Must be in finally so it runs even when commitTurn or post-processing throws.
      this.abortController = null;
      // NOTE: no [CC-Turn] flush anymore — assistant messages (with tool_use blocks)
      // and tool results are persisted per-message as they arrive via
      // handleAssistantMessage / handleToolResult, so the session DB already holds
      // complete per-turn history regardless of abort/error/interrupt. buildSdkMessages
      // reconstructs the SDK input stream from those rows on the next turn.
    }
  }

  private handleAssistantMessage(content: any[]): void {
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) textParts.push(block.text);
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      }
    }
    // Persist whenever there's text OR tool_use content. buildSdkMessages rebuilds
    // the next turn's assistant messages from these rows — tool_use-only assistant
    // messages are load-bearing for tool_use↔tool_result pairing on the API side.
    const text = textParts.join("\n");
    if (text.length > 0 || toolCalls.length > 0) {
      saveToMemory(this.memorySessionId, "assistant", text, toolCalls.length > 0 ? toolCalls : undefined);
    }
    // Feed assistant text into skill review buffer
    const trimmedText = text.trim();
    if (trimmedText) this.addToSkillReviewBuffer({ role: "assistant", content: sanitize(trimmedText.slice(0, 500)) });
  }

  /** Format a single message line for prompt building */
  private formatMessageLine(msg: any): string {
    const user = msg.user === "UHUMAN" ? "human" : msg.agent_id || msg.user || "unknown";
    let text = msg.text || "";
    if (text.length > MAX_MESSAGE_LENGTH) {
      text = text.slice(0, MAX_MESSAGE_LENGTH) + "\n[truncated]";
    }
    const hasFiles = msg.files && msg.files.length > 0;
    const fileInfo = hasFiles ? `\n[Attached files: ${msg.files.map((f: any) => f.name || "unnamed").join(", ")}]` : "";
    return `[${msg.ts}] ${user}: ${text}${fileInfo}`;
  }

  /** Format prompt with seen/new differentiation. Replaces formatPrompt(). */
  private formatPromptWithSeen(unseen: any[], seenNotProcessed: any[]): string {
    const parts: string[] = [];

    // 1. Header — reflects message mix
    if (seenNotProcessed.length > 0 && unseen.length === 0) {
      // All messages are retries — agent previously saw but didn't finish processing
      parts.push(`# Messages on Channel "${this.config.channel}" (continuing)\n`);
      parts.push(`CONTINUATION REQUIRED — you did not call chat_mark_processed last turn.\n`);
    } else if (unseen.length > 0) {
      parts.push(`# Messages on Channel "${this.config.channel}" (poll start)\n`);
    }

    const buildChronological = (messages: any[]): string[] => {
      if (messages.length === 0) return [];
      const NEWEST_RESERVE = Math.min(messages.length, 5);
      const newest = messages.slice(-NEWEST_RESERVE);
      const older = messages.slice(0, messages.length - NEWEST_RESERVE);
      let totalLen = 0;
      const newestLines: string[] = [];
      for (const msg of newest) {
        const line = this.formatMessageLine(msg);
        newestLines.push(line);
        totalLen += line.length;
      }
      const olderLines: string[] = [];
      for (let i = older.length - 1; i >= 0; i--) {
        const line = this.formatMessageLine(older[i]);
        if (totalLen + line.length > MAX_COMBINED_PROMPT_LENGTH) break;
        olderLines.unshift(line);
        totalLen += line.length;
      }
      return [...olderLines, ...newestLines];
    };

    // 2. Previously seen section (continuation case or mixed)
    if (seenNotProcessed.length > 0) {
      if (unseen.length > 0) {
        parts.push(`## Previously Seen (not yet processed)\n`);
        parts.push(
          `[NOTE: You already saw these last turn. If the conversation history above shows you responded, do NOT re-answer — just call mcp__clawd__chat_mark_processed with the latest timestamp.]\n`,
        );
      }
      parts.push(...buildChronological(seenNotProcessed));
    }

    // 3. New messages section (mixed case only)
    if (unseen.length > 0 && seenNotProcessed.length > 0) {
      parts.push(`\n## New Messages\n`);
    }

    // 4. Unseen section (new or mixed)
    if (unseen.length > 0) {
      parts.push(...buildChronological(unseen));
    }

    parts.push(
      `\n[REMINDER: Your streaming text output goes to the agentic framework only — the human CANNOT see it. Call mcp__clawd__chat_send_message to send a visible response to the chat UI. Once you have fully addressed all messages, call mcp__clawd__chat_mark_processed with the latest message timestamp.]`,
    );
    return parts.join("\n");
  }

  private formatPrompt(messages: any[]): string {
    const parts: string[] = [];
    parts.push(`# Messages on Channel "${this.config.channel}" (poll start)\n`);

    const NEWEST_RESERVE = Math.min(messages.length, 5);
    const newest = messages.slice(-NEWEST_RESERVE);
    const older = messages.slice(0, messages.length - NEWEST_RESERVE);
    let totalLen = 0;
    const newestLines: string[] = [];
    for (const msg of newest) {
      const line = this.formatMessageLine(msg);
      newestLines.push(line);
      totalLen += line.length;
    }
    const olderLines: string[] = [];
    for (let i = older.length - 1; i >= 0; i--) {
      const line = this.formatMessageLine(older[i]);
      if (totalLen + line.length > MAX_COMBINED_PROMPT_LENGTH) break;
      olderLines.unshift(line);
      totalLen += line.length;
    }
    parts.push(...olderLines, ...newestLines);

    parts.push(
      `\n[REMINDER: Your streaming text output goes to the agentic framework only — the human CANNOT see it. Call mcp__clawd__chat_send_message to send a visible response to the chat UI. Once you have fully addressed all messages, call mcp__clawd__chat_mark_processed with the latest message timestamp.]`,
    );
    return parts.join("\n");
  }

  /** Format interrupt resume prompt with Processing/New split */
  private formatInterruptPrompt(processingMessages: any[], newMessages: any[], hadUnsentText = false): string {
    const parts: string[] = [];
    parts.push(`[INTERRUPT] New messages arrived while you were processing.`);
    parts.push(`Read them carefully — they may override your current task.\n`);
    if (hadUnsentText) {
      parts.push(
        `[WARNING: Your previous turn produced text output but did NOT call \`mcp__clawd__chat_send_message\`. The human cannot see your previous response. If you still need to respond to the earlier task, call \`mcp__clawd__chat_send_message\` FIRST before processing the new messages.]\n`,
      );
    }

    // Budget: reserve space for NEW messages first (they're the reason for interrupt),
    // then fill processing context with remaining budget
    const halfBudget = MAX_COMBINED_PROMPT_LENGTH / 2;

    // 1. New messages get guaranteed half-budget
    let newLen = 0;
    const newMsgLines: string[] = [];
    for (const msg of newMessages) {
      const line = this.formatMessageLine(msg);
      if (newLen + line.length > halfBudget) break;
      newMsgLines.push(line);
      newLen += line.length;
    }

    // 2. Processing messages fill remaining budget (newest 5 reserved, older in reverse)
    const procBudget = MAX_COMBINED_PROMPT_LENGTH - newLen;
    parts.push(`# Processing Messages on Channel "${this.config.channel}"\n`);
    const PROC_NEWEST = Math.min(processingMessages.length, 5);
    const procNewest = processingMessages.slice(-PROC_NEWEST);
    const procOlder = processingMessages.slice(0, processingMessages.length - PROC_NEWEST);
    let procLen = 0;
    const procNewestLines: string[] = [];
    for (const msg of procNewest) {
      const line = this.formatMessageLine(msg);
      if (procLen + line.length > procBudget) break;
      procNewestLines.push(line);
      procLen += line.length;
    }
    const procOlderLines: string[] = [];
    for (let i = procOlder.length - 1; i >= 0; i--) {
      const line = this.formatMessageLine(procOlder[i]);
      if (procLen + line.length > procBudget) break;
      procOlderLines.unshift(line);
      procLen += line.length;
    }
    parts.push(...procOlderLines, ...procNewestLines);

    // 3. New section — the interrupt trigger messages
    parts.push(`\n# New Messages on Channel "${this.config.channel}"\n`);
    parts.push(...newMsgLines);

    parts.push(
      `\n[REMINDER: Your streaming text output goes to the agentic framework only — the human CANNOT see it. Call mcp__clawd__chat_send_message to send a visible response to the chat UI. Once you have fully addressed all messages, call mcp__clawd__chat_mark_processed with the latest message timestamp.]`,
    );
    return parts.join("\n");
  }

  // --------------------------------------------------------------------------
  // Identity (same 4 layers as WorkerLoop.loadClawdInstructions)
  // --------------------------------------------------------------------------

  private identityCache: string | null = null;
  private identityMtimes: Record<string, number> = {};
  private memoryStore = getAgentMemoryStore();

  /** Check if any identity source file has been modified since last cache */
  private identityFilesChanged(): boolean {
    for (const [path, mtime] of Object.entries(this.identityMtimes)) {
      try {
        const current = statSync(path).mtimeMs;
        if (current !== mtime) return true;
      } catch {
        return true; // File removed
      }
    }
    return false;
  }

  private loadIdentity(): string {
    // Return cache if files haven't changed
    if (this.identityCache !== null && !this.identityFilesChanged()) {
      return this.identityCache;
    }

    const { projectRoot, agentId, agentFileConfig } = this.config;
    const contexts: string[] = [];
    const mtimes: Record<string, number> = {};

    // 1. Global CLAWD.md from ~/.clawd/CLAWD.md
    const globalPath = join(homedir(), ".clawd", "CLAWD.md");
    if (existsSync(globalPath)) {
      try {
        contexts.push(readFileSync(globalPath, "utf-8"));
        mtimes[globalPath] = statSync(globalPath).mtimeMs;
      } catch {
        // Intentionally swallowed — global CLAWD.md may not exist; context injection is best-effort
      }
    }

    // 2. Project CLAWD.md from {projectRoot}/CLAWD.md
    const projectPath = join(projectRoot, "CLAWD.md");
    if (existsSync(projectPath) && projectPath !== globalPath) {
      try {
        contexts.push(`## Project-Specific Instructions\n\n${readFileSync(projectPath, "utf-8")}`);
        mtimes[projectPath] = statSync(projectPath).mtimeMs;
      } catch {
        // Intentionally swallowed — project CLAWD.md may not exist; context injection is best-effort
      }
    }

    // 3. Agent type instructions (from agentFileConfig)
    if (agentFileConfig) {
      const typeIdentity = buildAgentSystemPrompt(agentFileConfig, []);
      if (typeIdentity) {
        contexts.push(`# Agent Type Configuration\n\n${typeIdentity}`);
      }
    }

    // 4. Per-agent identity (from .clawd/agents/{agentId}.md)
    const agent = loadAgentFile(agentId, projectRoot);
    if (agent) {
      const allAgents = listAgentFiles(projectRoot);
      const diskIdentity = buildAgentSystemPrompt(agent, allAgents);
      if (diskIdentity) {
        contexts.push(`# Agent Identity & Configuration\n\n${diskIdentity}`);
      }
    }

    this.identityMtimes = mtimes;
    this.identityCache = contexts.length > 0 ? contexts.join("\n\n---\n\n") + "\n\n---\n\n" : "";
    return this.identityCache;
  }

  // --------------------------------------------------------------------------
  // Memory injection (same as WorkerLoop — dynamically loads relevant memories)
  // --------------------------------------------------------------------------

  private formatAge(unixSeconds: number): string {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - unixSeconds;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return `${Math.floor(diff / 604800)}w ago`;
  }

  /** Load relevant memories into the system prompt (same approach as non-CC agents) */
  private loadMemoryContext(): string {
    try {
      const { agentId, channel } = this.config;
      const memories = this.memoryStore.getRelevant(agentId, channel, this.lastKeywords, 5, 10);
      if (memories.length === 0) return "";

      const INJECTION_CAP = 4000;
      let output = "<agent_memory>\n";
      let charCount = 0;

      // Pinned rules — always included (up to 1500 chars)
      const pinned = memories.filter((m: AgentMemory) => m.priority >= 80);
      if (pinned.length > 0) {
        output += "  <pinned_rules>\n";
        for (const mem of pinned) {
          const line = `    - [#${mem.id} ${mem.category}] ${mem.content}\n`;
          if (charCount + line.length > 1500) break;
          output += line;
          charCount += line.length;
        }
        output += "  </pinned_rules>\n";
      }

      // Relevant + recent memories
      const others = memories.filter((m: AgentMemory) => m.priority < 80);
      if (others.length > 0) {
        output += "  <relevant>\n";
        for (const mem of others) {
          const age = this.formatAge(mem.createdAt);
          const line = `    - [#${mem.id} ${mem.category} ${age}] ${mem.content}\n`;
          if (charCount + line.length > INJECTION_CAP) break;
          output += line;
          charCount += line.length;
        }
        output += "  </relevant>\n";
      }

      output += "</agent_memory>";
      return output;
    } catch {
      return "";
    }
  }

  // --------------------------------------------------------------------------
  // MCP config
  // --------------------------------------------------------------------------

  private buildMcpServers(): Record<string, McpServerConfig> {
    let port = "3456";
    try {
      port = new URL(this.config.chatApiUrl).port || "3456";
    } catch {
      // Intentionally swallowed — malformed chatApiUrl falls back to default port 3456
    }
    const { channel, agentId } = this.config;

    // Only the clawd MCP server is passed to the CC SDK.
    // Channel MCP servers are proxied through the clawd MCP endpoint:
    // - tools/list (mcp.ts:4181) appends channel MCPManager tools
    // - tools/call (mcp.ts:~4500) delegates to MCPManager for execution
    // This avoids double-exposure (same tools via CC SDK + clawd proxy) and
    // prevents external server failures from blocking clawd-chat tools.
    return {
      clawd: {
        type: "http",
        url: `http://localhost:${port}/mcp/agent/${encodeURIComponent(channel)}/${encodeURIComponent(agentId)}`,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Activity tracking
  // --------------------------------------------------------------------------

  private lastTouchAt = 0;

  /** Throttled update to agent_seen.updated_at — keeps the agent "alive" in listAgents() */
  private touchActivity(): void {
    const now = Date.now();
    if (now - this.lastTouchAt < 30_000) return; // Throttle: once per 30s
    this.lastTouchAt = now;
    try {
      db.run(
        `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, updated_at)
         VALUES (?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
         ON CONFLICT(agent_id, channel) DO UPDATE SET updated_at = strftime('%s', 'now')`,
        [this.config.agentId, this.config.channel],
      );
    } catch {
      // Intentionally swallowed — CC session tracking is best-effort; agent operates fine without it
    }
  }

  // --------------------------------------------------------------------------
  // Session & failsafe
  // --------------------------------------------------------------------------

  private persistSessionId(sessionId: string | null): void {
    try {
      db.run(`UPDATE channel_agents SET claude_code_session_id = ? WHERE channel = ? AND agent_id = ?`, [
        sessionId,
        this.config.channel,
        this.config.agentId,
      ]);
    } catch {
      // Intentionally swallowed — session ID cleanup is best-effort; DB row will age out naturally
    }
  }

  private restoreSessionId(): void {
    try {
      const row = db
        .query<{ claude_code_session_id: string | null }, [string, string]>(
          `SELECT claude_code_session_id FROM channel_agents WHERE channel = ? AND agent_id = ?`,
        )
        .get(this.config.channel, this.config.agentId);
      if (row?.claude_code_session_id) {
        this.sessionId = row.claude_code_session_id;
      }
    } catch {
      // Intentionally swallowed — session restore failure is non-critical; agent starts a fresh session
    }
  }

  /** Persist pendingSeenTimestamps to the DB so a crash-restart correctly classifies
   *  resumed messages as "seen but not processed" rather than fresh. */
  private persistPendingSeenTimestamps(): void {
    try {
      const json = this.pendingSeenTimestamps.size > 0 ? JSON.stringify([...this.pendingSeenTimestamps]) : null;
      db.run(`UPDATE agent_seen SET pending_seen_ts_json = ? WHERE agent_id = ? AND channel = ?`, [
        json,
        this.config.agentId,
        this.config.channel,
      ]);
    } catch {
      // Best-effort — if the column doesn't exist (migration not run), silently skip.
    }
  }

  /** Restore pendingSeenTimestamps from DB on worker start. Called after restoreSessionId. */
  private restorePendingSeenTimestamps(): void {
    try {
      const row = db
        .query<{ pending_seen_ts_json: string | null }, [string, string]>(
          `SELECT pending_seen_ts_json FROM agent_seen WHERE agent_id = ? AND channel = ?`,
        )
        .get(this.config.agentId, this.config.channel);
      if (row?.pending_seen_ts_json) {
        const parsed = JSON.parse(row.pending_seen_ts_json);
        if (Array.isArray(parsed)) {
          for (const ts of parsed) {
            if (typeof ts === "string") this.pendingSeenTimestamps.add(ts);
          }
          if (this.pendingSeenTimestamps.size > 0) {
            logger.info(`Restored ${this.pendingSeenTimestamps.size} pending-seen timestamps from prior session`);
          }
        }
      }
    } catch {
      // Migration not applied, column missing, or JSON invalid — start with empty Set.
    }
  }

  private forceMarkUnprocessed(): void {
    for (const ts of this.pendingTimestamps) {
      const retries = this.forceMarkRetries.get(ts) || 0;
      if (retries >= MAX_FORCE_MARK_RETRIES) {
        try {
          db.run(
            `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
             VALUES (?, ?, ?, ?, strftime('%s', 'now'))
             ON CONFLICT(agent_id, channel) DO UPDATE SET
               last_processed_ts = MAX(COALESCE(last_processed_ts, '0'), ?),
               updated_at = strftime('%s', 'now')`,
            [this.config.agentId, this.config.channel, ts, ts, ts],
          );
          logger.warn(`Force-marked ts=${ts} after ${MAX_FORCE_MARK_RETRIES} retries`);
        } catch {
          // Intentionally swallowed — force-mark DB write is best-effort; retry will attempt again next cycle
        }
        this.forceMarkRetries.delete(ts);
      } else {
        this.forceMarkRetries.set(ts, retries + 1);
      }
    }
    // Clear seen timestamps for force-marked messages
    for (const ts of this.pendingTimestamps) {
      this.pendingSeenTimestamps.delete(ts);
    }
    this.persistPendingSeenTimestamps();
    this.pendingTimestamps = [];
  }
}

// ============================================================================
// Worker Registry (for hook API lookups)
// ============================================================================

const activeMainWorkers = new Map<string, ClaudeCodeMainWorker>();

export function registerMainWorker(key: string, worker: ClaudeCodeMainWorker): void {
  activeMainWorkers.set(key, worker);
}

export function unregisterMainWorker(key: string): void {
  activeMainWorkers.delete(key);
}

export function getMainWorker(key: string): ClaudeCodeMainWorker | undefined {
  return activeMainWorkers.get(key);
}
