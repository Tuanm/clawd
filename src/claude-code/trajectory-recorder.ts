/**
 * Trajectory Recorder
 *
 * Captures per-turn (user_message, tool_calls, assistant_response) snapshots
 * for RL training data export. Saves to the `trajectories` table in chat.db
 * at the end of each successfully completed turn (after chat_mark_processed).
 */

import { db } from "../server/database";

export interface ToolCallRecord {
  name: string;
  input: unknown;
  result: string;
  success: boolean;
}

// 2KB cap per tool result, 16KB cap for the full tool_calls_json
const MAX_RESULT_BYTES = 2_000;
const MAX_TOOL_CALLS_BYTES = 16_000;

export class TrajectoryRecorder {
  private channel: string;
  private agentId: string;
  private sessionId: string;
  private turnIndex = 0;
  private pendingToolCalls: ToolCallRecord[] = [];
  private pendingUserMessage: string | null = null;
  private pendingAssistantResponse: string | null = null;

  constructor(channel: string, agentId: string, sessionId: string) {
    this.channel = channel;
    this.agentId = agentId;
    this.sessionId = sessionId;
  }

  recordUserMessage(text: string): void {
    this.pendingUserMessage = text.slice(0, 8_000);
  }

  recordToolCall(name: string, input: unknown, result: string, success: boolean): void {
    const capped = result.slice(0, MAX_RESULT_BYTES);
    this.pendingToolCalls.push({ name, input, result: capped, success });
  }

  // Only the most recent call per turn is preserved — agents that call
  // chat_send_message multiple times per turn have only the last response recorded.
  recordAssistantResponse(text: string): void {
    this.pendingAssistantResponse = text.slice(0, 4_000);
  }

  hasPendingState(): boolean {
    return (
      this.pendingToolCalls.length > 0 || this.pendingUserMessage !== null || this.pendingAssistantResponse !== null
    );
  }

  /** Persist the current turn and advance the turn counter. Call after chat_mark_processed succeeds. */
  commitTurn(): void {
    // Tool-only turns (no user message and no assistant response) are intentionally
    // not recorded — heartbeat turns and pure tool-execution turns without visible
    // output produce no meaningful training signal. Clear pending tool calls so
    // they don't bleed into the next turn's record.
    if (!this.pendingUserMessage && !this.pendingAssistantResponse) {
      this.pendingToolCalls = [];
      return;
    }

    let toolCallsJson: string | null = null;
    if (this.pendingToolCalls.length > 0) {
      const raw = JSON.stringify(this.pendingToolCalls);
      if (raw.length > MAX_TOOL_CALLS_BYTES) {
        // Keep as many tool calls as fit; append a sentinel so consumers know it was truncated
        const kept: ToolCallRecord[] = [];
        let size = 2; // for the outer `[]`
        for (const tc of this.pendingToolCalls) {
          const entry = JSON.stringify(tc);
          if (size + entry.length + 1 > MAX_TOOL_CALLS_BYTES - 50) break; // 50-byte reserve for sentinel
          kept.push(tc);
          size += entry.length + 1;
        }
        kept.push({
          name: "__truncated__",
          input: null,
          result: `${this.pendingToolCalls.length - kept.length} tool calls omitted`,
          success: false,
        });
        toolCallsJson = JSON.stringify(kept);
      } else {
        toolCallsJson = raw;
      }
    }

    try {
      db.run(
        `INSERT INTO trajectories (session_id, channel, agent_id, turn_index, user_message, tool_calls_json, assistant_response)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          this.sessionId,
          this.channel,
          this.agentId,
          this.turnIndex,
          this.pendingUserMessage,
          toolCallsJson,
          this.pendingAssistantResponse,
        ],
      );
    } catch (err) {
      // best-effort — trajectory loss is acceptable; don't break agent turns
      console.error("[TrajectoryRecorder] Failed to commit turn:", err);
    }
    this.turnIndex++; // always advance, even on DB failure, to avoid duplicate turn_index

    this.pendingToolCalls = [];
    this.pendingUserMessage = null;
    this.pendingAssistantResponse = null;
  }

  /** Reset pending state without committing (used when turn is aborted/interrupted). */
  abortTurn(): void {
    this.pendingToolCalls = [];
    this.pendingUserMessage = null;
    this.pendingAssistantResponse = null;
  }
}
