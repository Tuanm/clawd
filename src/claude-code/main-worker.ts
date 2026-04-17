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
import { type AgentMemory, extractKeywords, getAgentMemoryStore } from "../agent/memory/agent-memory";
import {
  buildSkillReviewPrompt,
  containsCorrection,
  parseSkillRecommendations,
  postSystemMessage,
  sanitize,
} from "../agent/plugins/skill-review-plugin";
import { buildDynamicSystemPrompt, type PromptContext } from "../agent/prompt/builder";
import { buildContextPreamble } from "../agent/session/context-injector";
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
  /** In-memory set of timestamps marked as seen but not yet processed.
   *  Tracks messages that appeared in a poll but weren't successfully processed,
   *  so subsequent polls can differentiate "brand-new" vs "previously seen" messages.
   *  Does not persist across restarts (acceptable — post-restart messages appear as new). */
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
  // Per-turn structured log — thoughts, actions+outputs, messages — serialised to one session row
  private turnToolLog: Array<{ name: string; subject: string; output: string; ts: number }> = [];
  private turnMessageLog: Array<{ text: string; ts: number }> = [];
  // Skill improvement state — per-turn tracking for correction-gated improvement
  private turnActivatedSkills = new Set<string>();
  private turnBufferStartIdx = 0;
  private skillsBeingImproved = new Set<string>();
  private pendingCorrections: string[] = [];
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
      this.memorySessionId = initMemorySession(this.memorySessionName, this.config.model);
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
            pending = [{ ts: String(Date.now()), user: "UHUMAN", text: "<agent_signal>[HEARTBEAT]</agent_signal>" }];
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
            // Only log unexpected errors (suppress abort errors from human interrupts and heartbeats)
            if (!interrupted && !this.wasCancelledByHeartbeat) {
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
                if (!this.wasCancelledByHeartbeat) {
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

    // Track whether the agent successfully sent a message this turn (CC SDK uses mcp__ prefix)
    if (toolName === "mcp__clawd__chat_send_message" && !response?.error) {
      this.turnChatSent = true;
      // Save sent text to memory so context preamble reflects prior responses.
      // Without this, tool-call-only turns (no text output) leave no trace in the preamble,
      // causing the agent to re-answer 'Previously Seen' messages it already responded to.
      const sentText = input?.text;
      if (sentText) {
        this.turnMessageLog.push({ text: String(sentText), ts: Date.now() });
      }
      // Record the visible assistant response for trajectory (only on successful delivery)
      if (this.trajectoryRecorder && !response?.error) {
        this.trajectoryRecorder.recordAssistantResponse(sanitize(input?.text || ""));
      }
    }
    // Track whether chat_mark_processed was called this turn
    if (toolName === "mcp__clawd__chat_mark_processed" && !response?.error) {
      this.turnMarkProcessed = true;
    }

    // Fire skill improvement at task completion when corrections were captured this turn.
    // CC captures corrections from incoming user messages (non-CC uses beforeCompaction hook).
    if (
      (toolName === "chat_mark_processed" || toolName === "mcp__clawd__chat_mark_processed") &&
      !(response as any)?.error
    ) {
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

    if (toolName === "skill_activate" || toolName === "mcp__clawd__skill_activate") {
      const ok = !(response as any)?.error && !truncateToolResult(response).includes("not found");
      const skillName = (toolInput as any)?.name;
      if (ok && typeof skillName === "string" && skillName.length > 0) {
        this.turnActivatedSkills.add(skillName);
      }
    }

    const shortName = toolName.replace(/^mcp__clawd__/, "");
    if (!CONVERSATION_TOOLS.has(shortName)) {
      try {
        const toolOutput = sanitize(truncateToolResult(response).slice(0, 300));
        if (this.turnToolLog.length < 50) {
          this.turnToolLog.push({
            name: shortName,
            subject: extractSubject(shortName, toolInput),
            output: toolOutput,
            ts: Date.now(),
          });
        } else if (this.turnToolLog.length === 50) {
          this.turnToolLog.push({ name: "+more", subject: "", output: "", ts: Date.now() });
        }
      } catch (err) {
        logger.error(`[handleToolResult] turnToolLog push failed for ${shortName}:`, err);
      }
    }

    // Feed skill review buffer — strip mcp__clawd__ prefix for readability
    this.sessionToolCallCount++;
    this.addToSkillReviewBuffer({
      role: "tool",
      content: sanitize(truncateToolResult(response).slice(0, 200)),
      toolName: shortName,
    });
    this.maybeRunSkillReview();
    if (this.trajectoryRecorder && !CONVERSATION_TOOLS.has(shortName)) {
      const trResult = sanitize(truncateToolResult(response).slice(0, 2000));
      const trSuccess = !(response as any)?.error && !(response as any)?.isError && !trResult.startsWith("Error:");
      this.trajectoryRecorder.recordToolCall(shortName, toolInput, trResult, trSuccess);
    }

    broadcastAgentToolCall(channel, agentId, toolName, input, "started");
    broadcastAgentToolCall(channel, agentId, toolName, input, status, `${description}\n${result}`);
    saveToMemory(
      this.memorySessionId,
      "tool",
      `${description}\n${result}`,
      undefined,
      toolUseId || `tool_${toolName}_${Date.now()}`,
    );
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

    const { channel, model } = this.config;

    // Read up to 200 recent channel messages — enough to summarise the whole
    // conversation even for very active channels. Oldest first for the LLM.
    type ChatRow = { ts: string; user: string; agent_id: string | null; text: string | null };
    const rows = db
      .query<ChatRow, [string, number]>(
        `SELECT ts, user, agent_id, text FROM messages
         WHERE channel = ? AND thread_ts IS NULL AND text IS NOT NULL AND text != ''
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(channel, 200)
      .reverse();

    const chatLines = rows
      .filter((r) => r.text?.trim())
      .map((r) => {
        const sender = r.user === "UHUMAN" ? "human" : r.agent_id || r.user || "bot";
        const text = (r.text || "").replace(/\s+/g, " ").trim().slice(0, 500);
        return `[${sender}]: ${text}`;
      });

    if (chatLines.length === 0) return;

    logger.info(`Compacting session — generating LLM summary from ${chatLines.length} channel messages...`);

    const conversationText = chatLines.join("\n\n");
    const summary = await generateConversationSummary(conversationText, chatLines.length, model);

    manager.compactSessionByName(this.memorySessionName, 50, summary);
    logger.info(`Session compacted with LLM summary`);
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
   *  Note: pendingSeenTimestamps is in-memory only — does not persist across restarts. */
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
    // isNewTurn=false: interrupt resume continues the same-turn CC session (keep resume:)
    return this._runSDKTurn(prompt, messages, false);
  }

  private async processMessages(messages: any[], unseen: any[], seenNotProcessed: any[]): Promise<void> {
    const prompt = this.formatPromptWithSeen(unseen, seenNotProcessed);
    return this._runSDKTurn(prompt, messages);
  }

  private async _runSDKTurn(prompt: string, messages: any[], isNewTurn = true): Promise<void> {
    // On a new turn, discard the previous CC session so context comes from our
    // SQLite store rather than the unbounded ~/.claude/projects/ history.
    if (isNewTurn) this.sessionId = null;

    // Build context preamble BEFORE saveToMemory so the current message is not
    // included in the history (getRecentMessagesCompact reads the same DB).
    // Compaction (if needed) is handled here with LLM-generated summaries from
    // real channel messages — buildContextPreamble runs with autoCompact disabled.
    if (isNewTurn) await this.maybeCompactSession();
    const contextPreamble = isNewTurn
      ? buildContextPreamble(this.memorySessionName, { disableAutoCompact: true, agentId: this.config.agentId })
      : "";

    saveToMemory(this.memorySessionId, "user", prompt);

    // Feed channel messages into skill review buffer so the reviewer has user
    // context (what prompted the tool calls), not just tool results in isolation.
    if (isNewTurn) {
      for (const msg of messages) {
        const text = (msg.text || "").trim();
        if (!text) continue;
        const sender = msg.user === "UHUMAN" ? "human" : msg.agent_id || msg.user || "unknown";
        this.addToSkillReviewBuffer({ role: "user", content: `[${sender}]: ${sanitize(text.slice(0, 500))}` });
        // Capture user corrections for skill improvement (mirrors non-CC beforeCompaction path)
        if (msg.user === "UHUMAN" && containsCorrection(text)) {
          this.pendingCorrections.push(text.slice(0, 500));
          if (this.pendingCorrections.length > 100) this.pendingCorrections = this.pendingCorrections.slice(-100);
        }
      }
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
    };
    let systemPrompt = buildDynamicSystemPrompt(ccCtx);

    // Inject relevant memories (same system as non-CC agents)
    const memoryContext = this.loadMemoryContext();
    if (memoryContext) {
      systemPrompt += "\n\n" + memoryContext;
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

    // Detect heartbeat-initiated turns — suppress re-injection for these
    const isHeartbeatTurn = messages.length === 1 && messages[0]?.text?.includes("[HEARTBEAT]");

    // Reset per-turn re-injection state
    this.turnChatSent = false;
    this.turnMarkProcessed = false;
    this.turnStreamText = "";
    this.turnToolLog = [];
    this.turnMessageLog = [];

    // contextPreamble was computed above (before saveToMemory) to exclude the
    // current message from the injected history.
    const promptWithContext = contextPreamble ? `${contextPreamble}\n\n${prompt}` : prompt;

    const sdkOpts = {
      prompt: promptWithContext,
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
      // New turns start fresh (context injected via preamble above).
      // Interrupt resumes and re-injections within the same turn continue via sessionId.
      resume: isNewTurn ? undefined : this.sessionId || undefined,
      abortController: this.abortController,
      yolo: this.config.yolo ?? false,
      // Custom CC providers (not the built-in "claude-code") must use mcp__clawd__web_search /
      // mcp__clawd__web_fetch — disable the CC-native equivalents for them.
      ...(this.config.provider && this.config.provider !== "claude-code"
        ? { disallowedTools: ["WebSearch", "WebFetch"] }
        : {}),
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
      if (
        !this.turnChatSent &&
        this.turnStreamText.trim().length > 0 &&
        !this.wasCancelledByHeartbeat &&
        !isHeartbeatTurn &&
        !this.abortController?.signal.aborted &&
        !this.interruptDetected
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
            { ...sdkOpts, prompt: reinjectionPrompt, resume: this.sessionId || undefined, abortController: reinjAbort },
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
      // Dual guard: signal.aborted catches cancelProcessing/setSleeping; interruptDetected catches poller-detected interrupts
      if (
        !this.turnMarkProcessed &&
        !this.wasCancelledByHeartbeat &&
        !isHeartbeatTurn &&
        !this.abortController?.signal.aborted &&
        !this.interruptDetected
      ) {
        const lastTs = this.pendingTimestamps[this.pendingTimestamps.length - 1] || "";
        const reminderPrompt =
          `[NOTICE: You completed your turn but did not call \`mcp__clawd__chat_mark_processed\` to mark the message(s) as handled. ` +
          `This is required so the same messages are not polled again.\n\n` +
          `Call \`mcp__clawd__chat_mark_processed(timestamp="${lastTs}")\` now, even if empty.` +
          `If you intentionally did not need to respond, produce only [SILENT].]`;

        // Use a tracked AbortController so the interrupt poller can abort this re-injection too.
        const markProcessedAbort = new AbortController();
        this.abortController = markProcessedAbort;
        try {
          await runSDKQuery(
            {
              ...sdkOpts,
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
      // Build a single structured turn row: [Thought] + [Action]+Output + messages.
      // Replaces the separate [Sent to chat] / [Actions taken] rows — one row per turn
      // gives the agent a coherent replay of its reasoning and work in the next turn.
      if (this.memorySessionId) {
        const lines: string[] = [];

        // Thought — the agent's streaming reasoning for this turn (one blob, lightweight version)
        const thought = this.turnStreamText.trim();
        if (thought.length > 50) {
          const turnTs = this.processingStartedAt ?? Date.now();
          const truncated = thought.length > 2000 ? `${thought.slice(0, 2000)} [truncated]` : thought;
          lines.push(`[${turnTs}] you: [Thought]: ${truncated}`);
        }

        // Actions with truncated output
        for (const action of this.turnToolLog) {
          const label = action.subject ? `${action.name}(${action.subject})` : action.name;
          lines.push(`[${action.ts}] you: [Action]: ${label}`);
          if (action.output) lines.push(`    Output: ${action.output}`);
        }

        // Chat messages sent this turn (no prefix — just the text)
        for (const msg of this.turnMessageLog) {
          lines.push(`[${msg.ts}] you: ${msg.text}`);
        }

        if (lines.length > 0) {
          saveToMemory(this.memorySessionId, "assistant", `[CC-Turn]:\n${lines.join("\n")}`);
        }
      }

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
    if (textParts.length > 0 || toolCalls.length > 0) {
      saveToMemory(
        this.memorySessionId,
        "assistant",
        textParts.join("\n") || "",
        toolCalls.length > 0 ? toolCalls : undefined,
      );
    }
    // Feed assistant text into skill review buffer
    const text = textParts.join("\n").trim();
    if (text) this.addToSkillReviewBuffer({ role: "assistant", content: sanitize(text.slice(0, 500)) });
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
