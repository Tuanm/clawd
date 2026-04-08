/**
 * Microcompaction — lightweight per-turn compaction that prevents context from growing unbounded
 * between full checkpoint compactions. Runs inline in the agent loop (no spawn).
 *
 * Design decisions:
 * - last_message_ts: stored in a lightweight JSON file `microstate.json` in the
 *   session directory. One file per session, atomic writes. Chosen over DB
 *   because we don't want to pollute the message DB with frequent updates,
 *   and the granularity needed is sub-minute (per turn, not per message).
 * - Concurrent tool calls: Bun runs single-threaded. The event loop serializes
 *   tool calls. However, compaction can fire mid-turn. We use a `deferUntil`
 *   flag: if compaction triggers during active tool execution, we skip and
 *   defer to the next safe point (after current tool result is pushed).
 * - Same process: microcompaction is lightweight (O(n) scan, in-memory diff).
 *   Spawning a process adds ~50ms overhead. Inline is better for per-turn triggers.
 *   Heavy summarization still uses SessionSummarizer sidecar (Phase 5).
 * - Dual-array consistency: agent loop holds a local `messages[]` reference.
 *   We return the compacted array from microcompact() and the caller replaces
 *   its reference. DB is updated via SessionManager.updateMessageContent().
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Message } from "../api/client";
import type { ScoredMessage } from "../session/message-scoring";
import { scoreMessages } from "../session/message-scoring";
import { compressMessage } from "../session/message-scoring";

/**
 * Per-session microstate — tracks compaction metadata without touching the DB.
 * Stored at `~/.clawd/sessions/{sessionId}/microstate.json`.
 */
export interface MicroState {
  version: 1;
  lastMessageTs: number; // Date.now() of last processed message
  lastCompactionTs: number; // Date.now() of last microcompaction
  turnCount: number; // total turns since session start
  /** Turn count at last compaction — used for turn-based threshold */
  lastCompactionTurn: number;
  messagesSinceCompaction: number; // messages added since last microcompaction
  /** If set, defer compaction until after this turn (mid-turn skip) */
  deferCompactionUntilTurn: number | null;
}

const MICROSTATE_FILE = "microstate.json";

export interface MicroCompactionConfig {
  /** Compact when this many new messages accumulate (default: 15) */
  messageThreshold?: number;
  /** Compact when turns since last compaction exceed this (default: 10) */
  turnThreshold?: number;
  /** Max messages to keep after compaction (default: 40) */
  keepCount?: number;
  /** How many recent messages to always keep as a tail buffer (default: 10) */
  tailBuffer?: number;
}

export class MicroCompactor {
  private config: Required<MicroCompactionConfig>;
  private state: MicroState;
  private sessionDir: string;

  constructor(sessionDir: string, config: MicroCompactionConfig = {}) {
    this.sessionDir = sessionDir;
    this.config = {
      messageThreshold: config.messageThreshold ?? 15,
      turnThreshold: config.turnThreshold ?? 10,
      keepCount: config.keepCount ?? 40,
      tailBuffer: config.tailBuffer ?? 10,
    };
    this.state = this.loadState();
  }

  /**
   * Record a turn (call after each LLM response).
   * Returns compaction result if compaction was triggered, undefined otherwise.
   */
  onTurn(): MicroCompactionResult | undefined {
    this.state.turnCount++;
    this.state.messagesSinceCompaction = 0;
    this.state.lastCompactionTs = Date.now();

    if (this.state.deferCompactionUntilTurn !== null && this.state.turnCount > this.state.deferCompactionUntilTurn) {
      this.state.deferCompactionUntilTurn = null;
    }

    this.saveState();
    return undefined;
  }

  /**
   * Record that messages were added (call after addMessage to SessionManager).
   * @param count Number of messages added
   */
  onMessagesAdded(count: number): void {
    this.state.messagesSinceCompaction += count;
    this.saveState();
  }

  /**
   * Check if compaction should run. Safe to call at any point.
   */
  shouldCompact(): boolean {
    if (this.state.deferCompactionUntilTurn !== null && this.state.turnCount <= this.state.deferCompactionUntilTurn) {
      return false;
    }

    return (
      this.state.messagesSinceCompaction >= this.config.messageThreshold ||
      this.state.turnCount - this.state.lastCompactionTurn > this.config.turnThreshold
    );
  }

  /**
   * Compact messages in place. Call this at a safe point in the agent loop
   * (after tool result is pushed, before next LLM call).
   *
   * @param messages  The messages array (from agent loop, same as SessionManager)
   * @returns Updated messages array (may be same reference or new array)
   */
  compact(messages: Message[]): MicroCompactionResult {
    if (messages.length <= this.config.keepCount) {
      return {
        didCompact: false,
        deferred: false,
        messages,
        deletedCount: 0,
        keptCount: messages.length,
        newCheckpoint: null,
      };
    }

    const scored = scoreMessages(messages);

    const tailStart = Math.max(0, messages.length - this.config.tailBuffer);
    const keptIndices = new Set<number>();

    for (const s of scored) {
      if (s.stage === "FULL" || s.isAnchor || s.index >= tailStart) {
        keptIndices.add(s.index);
      }
    }

    for (const s of scored) {
      if (s.atomicGroupId && keptIndices.has(s.index)) {
        for (const other of scored) {
          if (other.atomicGroupId === s.atomicGroupId) {
            keptIndices.add(other.index);
          }
        }
      }
    }

    const compacted: Message[] = [];
    const deletedIndices: number[] = [];

    for (let i = 0; i < messages.length; i++) {
      if (keptIndices.has(i)) {
        const s = scored[i];
        if (s && s.stage === "COMPRESSED") {
          compacted.push(compressMessage(messages[i]));
        } else {
          compacted.push(messages[i]);
        }
      } else {
        deletedIndices.push(i);
      }
    }

    const deletedCount = deletedIndices.length;

    if (deletedCount > 0) {
      const summary = this.generateInlineSummary(messages, deletedIndices);
      compacted.unshift({ role: "user", content: summary });
    }

    const repaired = this.repairRoleAlternation(compacted);

    this.state.lastCompactionTs = Date.now();
    this.state.lastCompactionTurn = this.state.turnCount;
    this.state.deferCompactionUntilTurn = null;
    this.saveState();

    return {
      didCompact: true,
      deferred: false,
      messages: repaired,
      deletedCount,
      keptCount: repaired.length,
      newCheckpoint: null,
    };
  }

  /**
   * Get current state for debugging.
   */
  getState(): MicroState {
    return { ...this.state };
  }

  /**
   * Force reset microstate (e.g., on session reset).
   */
  reset(): void {
    this.state = this.createEmptyState();
    this.saveState();
  }

  /**
   * Sync state after a full session compaction (CheckpointManager).
   * Resets message counter so microcompactor doesn't double-count trimmed messages.
   * Preserves turnCount to avoid breaking turn-based thresholds.
   */
  syncAfterCompaction(): void {
    this.state.messagesSinceCompaction = 0;
    this.state.lastCompactionTs = Date.now();
    this.state.deferCompactionUntilTurn = null;
    this.saveState();
  }

  private loadState(): MicroState {
    const path = join(this.sessionDir, MICROSTATE_FILE);

    // Ensure directory exists
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        if (data.version === 1) {
          return {
            ...this.createEmptyState(),
            ...data,
          };
        }
      } catch {
        // ignore
      }
    }

    return this.createEmptyState();
  }

  private saveState(): void {
    const path = join(this.sessionDir, MICROSTATE_FILE);
    const tmpPath = path + ".tmp";
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(tmpPath, JSON.stringify(this.state), "utf-8");
    renameSync(tmpPath, path);
  }

  private createEmptyState(): MicroState {
    return {
      version: 1,
      lastMessageTs: Date.now(),
      lastCompactionTs: 0,
      turnCount: 0,
      lastCompactionTurn: 0,
      messagesSinceCompaction: 0,
      deferCompactionUntilTurn: null,
    };
  }

  /**
   * Merge the injected summary (position 0) with the immediately following message
   * if they share the same role (e.g., summary + user = both user).
   * Only merges summary ONCE — subsequent messages are kept separate.
   * Does NOT merge other consecutive same-role messages.
   */
  private repairRoleAlternation(messages: Message[]): Message[] {
    if (messages.length <= 1) return messages;

    const isSummary = (msg: Message): boolean =>
      typeof msg.content === "string" && (msg.content as string).startsWith("[Compacted");

    const result: Message[] = [];
    let pending: Message | null = null;
    let pendingIsSummary = false;

    for (const msg of messages) {
      if (pending === null) {
        pending = this.cloneMessage(msg);
        pendingIsSummary = isSummary(msg);
        continue;
      }

      if (pendingIsSummary && pending.role === msg.role) {
        const a = pending.content === null ? "" : String(pending.content);
        const b = msg.content === null ? "" : String(msg.content ?? "");
        pending = { ...pending, content: a + "\n" + b };
        pendingIsSummary = false;
      } else {
        result.push(pending);
        pending = this.cloneMessage(msg);
        pendingIsSummary = isSummary(msg);
      }
    }

    if (pending !== null) result.push(pending);
    return result;
  }

  private cloneMessage(msg: Message): Message {
    return { ...msg };
  }

  /**
   * Generate inline summary for compacted messages.
   * Lightweight — no LLM call. Uses heuristic extraction.
   */
  private generateInlineSummary(messages: Message[], deletedIndices: number[]): string {
    const deleted = deletedIndices.map((i) => messages[i]).filter((m) => m.content !== undefined);

    const toolCalls = new Set<string>();
    const errors: string[] = [];
    const filesMentioned: string[] = [];

    for (const msg of deleted) {
      const content = typeof msg.content === "string" ? msg.content : "";

      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCalls.add(tc.function?.name || "unknown");
        }
      }

      const errorMatches = content.match(/(?:error|exception|fail|panic):\s*([^\n]{0,100})/gi);
      if (errorMatches) errors.push(...errorMatches.slice(0, 3));

      const fileMatches = content.match(/[\w/.-]+\.(ts|js|py|go|rs|json|yaml|md)/g);
      if (fileMatches) {
        for (const f of fileMatches.slice(0, 10)) {
          if (!filesMentioned.includes(f)) filesMentioned.push(f);
        }
      }
    }

    const parts: string[] = [];
    parts.push(`[Compacted ${deleted.length} messages — see earlier context for details]`);

    if (toolCalls.size > 0) {
      parts.push(`Tools used: ${[...toolCalls].join(", ")}`);
    }
    if (filesMentioned.length > 0) {
      parts.push(`Files: ${filesMentioned.slice(0, 5).join(", ")}`);
    }
    if (errors.length > 0) {
      parts.push(`Errors: ${errors.join("; ")}`);
    }

    return parts.join("\n");
  }
}

export interface MicroCompactionResult {
  didCompact: boolean;
  deferred: boolean; // true if compaction skipped (mid-turn)
  messages: Message[];
  deletedCount: number;
  keptCount: number;
  newCheckpoint: null; // Full checkpoints still via SessionSummarizer
}

const compactors = new Map<string, MicroCompactor>();

export function getMicroCompactor(sessionDir: string, config?: MicroCompactionConfig): MicroCompactor {
  let compactor = compactors.get(sessionDir);
  if (!compactor) {
    compactor = new MicroCompactor(sessionDir, config);
    compactors.set(sessionDir, compactor);
  }
  return compactor;
}

export function clearMicroCompactor(sessionDir: string): void {
  compactors.delete(sessionDir);
}
