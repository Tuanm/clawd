/**
 * Session Management with SQLite
 */

import type Database from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../../config/config-file";
import { createDatabase } from "../../db/factory";
import { runMigrations } from "../../db/migrations";
import { memoryMigrations } from "../../db/migrations/memory-migrations";
import type { Message } from "../api/client";
import { smartTruncate } from "../utils/smart-truncation";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize tool call IDs to a provider-agnostic format ("call_<unique>").
 * Providers use different prefixes: Anthropic "toolu_", MiniMax "call_function_",
 * Ollama numeric indices. Normalizing ensures sessions are portable across providers.
 */
function normalizeToolCallId(id: string): string {
  if (!id) return `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (id.startsWith("call_")) return id;
  const unique = id.replace(/^(toolu_|tooluse_|tool_use_)/, "");
  return `call_${unique}`;
}

/**
 * Safe JSON parse that returns undefined on failure
 */
function safeJsonParse<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    console.error(`[SessionManager] Failed to parse JSON: ${text?.slice(0, 100)}...`);
    return undefined;
  }
}

// ============================================================================
// Types
// ============================================================================

export interface Session {
  id: string;
  name: string;
  model: string;
  created_at: number;
  updated_at: number;
}

export interface StoredMessage {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: number;
}

// ============================================================================
// Session Manager
// ============================================================================

// Singleton instance for default path
let _defaultSessionManager: SessionManager | null = null;

export class SessionManager {
  private db: Database;
  private _sessionUpdateTimes = new Map<string, number>(); // per-session debounce

  constructor(dbPath?: string) {
    const defaultPath = join(getDataDir(), "memory.db");
    const path = dbPath || defaultPath;

    // Ensure directory exists
    const dir = join(path, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = createDatabase(path, { foreignKeys: false });
    this.init();
  }

  private init() {
    runMigrations(this.db, memoryMigrations);
  }

  // ============================================================================
  // Session Operations
  // ============================================================================

  createSession(name: string, model: string): Session {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db.run("INSERT INTO sessions (id, name, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
      id,
      name,
      model,
      now,
      now,
    ]);

    return { id, name, model, created_at: now, updated_at: now };
  }

  getSession(idOrName: string): Session | null {
    // Try by exact ID first
    const byId = this.db.query("SELECT * FROM sessions WHERE id = ?").get(idOrName) as Session | null;
    if (byId) return byId;

    // Try by ID prefix (partial match for short IDs like from --list)
    const byIdPrefix = this.db
      .query("SELECT * FROM sessions WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 1")
      .get(`${idOrName}%`) as Session | null;
    if (byIdPrefix) return byIdPrefix;

    // Try by name
    const byName = this.db
      .query("SELECT * FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1")
      .get(idOrName) as Session | null;
    return byName;
  }

  listSessions(limit = 20): Session[] {
    return this.db.query("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit) as Session[];
  }

  updateSession(id: string, updates: Partial<Pick<Session, "name" | "model">>) {
    const sets: string[] = ["updated_at = ?"];
    const values: any[] = [Date.now()];

    if (updates.name) {
      sets.push("name = ?");
      values.push(updates.name);
    }
    if (updates.model) {
      sets.push("model = ?");
      values.push(updates.model);
    }

    values.push(id);
    this.db.run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, values);
  }

  deleteSession(id: string) {
    this.db.transaction(() => {
      this.db.run("DELETE FROM messages WHERE session_id = ?", [id]);
      this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
    })();
  }

  // ============================================================================
  // Message Operations
  // ============================================================================

  addMessage(sessionId: string, message: Message): number {
    const now = Date.now();

    // Normalize tool call IDs to standard "call_" prefix for cross-provider compatibility.
    // Different providers use different prefixes (Anthropic: "toolu_", MiniMax: "call_function_",
    // Ollama: numeric), but the session store should be provider-agnostic.
    const normalizedToolCalls = message.tool_calls?.map((tc) => ({
      ...tc,
      id: normalizeToolCallId(tc.id),
    }));
    const normalizedToolCallId = message.tool_call_id ? normalizeToolCallId(message.tool_call_id) : null;

    const result = this.db.run(
      `INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        message.role,
        message.content,
        normalizedToolCalls ? JSON.stringify(normalizedToolCalls) : null,
        normalizedToolCallId,
        now,
      ],
    );

    // Update session timestamp (batched: at most once per 5 seconds per session)
    const nowMs = Date.now();
    const lastUpdate = this._sessionUpdateTimes.get(sessionId) || 0;
    if (nowMs - lastUpdate > 5000) {
      this.db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [nowMs, sessionId]);
      this._sessionUpdateTimes.set(sessionId, nowMs);
    }

    return Number(result.lastInsertRowid);
  }

  getMessages(sessionId: string): Message[] {
    const rows = this.db
      .query("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC")
      .all(sessionId) as StoredMessage[];

    return rows.map((row) => ({
      role: row.role as Message["role"],
      content: row.content,
      tool_calls: safeJsonParse(row.tool_calls),
      tool_call_id: row.tool_call_id || undefined,
    }));
  }

  getRecentMessages(sessionId: string, limit = 50): Message[] {
    const rows = this.db
      .query(
        `SELECT * FROM (
        SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
      ) ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId, limit) as StoredMessage[];

    return rows.map((row) => ({
      role: row.role as Message["role"],
      content: row.content,
      tool_calls: safeJsonParse(row.tool_calls),
      tool_call_id: row.tool_call_id || undefined,
    }));
  }

  /**
   * Update message content in session DB (for inline compression).
   * Only updates content field — tool_calls/role/tool_call_id are immutable.
   */
  updateMessageContent(sessionId: string, messageId: number, content: string): void {
    this.db.run("UPDATE messages SET content = ? WHERE id = ? AND session_id = ?", [content, messageId, sessionId]);
  }

  /**
   * Get messages with their DB IDs (for inline compression updates).
   */
  getMessagesWithIds(sessionId: string): Array<StoredMessage> {
    return this.db
      .query("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC")
      .all(sessionId) as StoredMessage[];
  }

  /**
   * Get recent messages with validation to ensure tool call/result pairs are complete
   */
  getRecentMessagesValidated(sessionId: string, limit = 50): Message[] {
    const messages = this.getRecentMessages(sessionId, limit);
    return this.validateToolCallPairs(messages);
  }

  /**
   * Get recent messages for context, excluding tool calls/results and truncating large content.
   * This is optimized for resuming sessions without blowing up context size.
   */
  getRecentMessagesCompact(sessionId: string, limit = 50, maxContentLength = 8000): Message[] {
    // Fetch more messages since we'll be filtering many out.
    // +1 extra to account for summary row (created_at=0) which is always oldest and
    // would otherwise be dropped by slice(-limit) when session has >= limit regular messages.
    const rows = this.db
      .query(
        `SELECT * FROM (
        SELECT * FROM messages
        WHERE session_id = ?
          AND role IN ('user', 'assistant')
          AND tool_call_id IS NULL
        ORDER BY created_at DESC, id DESC LIMIT ?
      ) ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId, limit * 2 + 1) as StoredMessage[];

    const summaryMessages: Message[] = []; // created_at=0 compaction summaries — always kept
    const regularMessages: Message[] = [];

    for (const row of rows) {
      // Skip assistant messages that only have tool_calls (no content)
      if (row.role === "assistant" && row.tool_calls && !row.content) {
        continue;
      }

      let content = row.content;

      // Truncate large content with smart head/tail preservation
      if (content && content.length > maxContentLength) {
        content = smartTruncate(content, {
          maxLength: maxContentLength,
          marker: "\n\n[...content truncated for context...]",
        });
      }

      const msg: Message = {
        role: row.role as Message["role"],
        content,
        // Intentionally omit tool_calls to keep history clean
      };

      // Compaction summary rows have created_at=0 — pin them to the front
      if (row.created_at === 0) {
        summaryMessages.push(msg);
      } else {
        regularMessages.push(msg);
      }
    }

    // Return summary rows (always) + most recent 'limit' regular messages
    return [...summaryMessages, ...regularMessages.slice(-limit)];
  }

  /**
   * Validate tool call/result pairs - ensure every tool_call has a result and vice versa
   */
  private validateToolCallPairs(messages: Message[]): Message[] {
    // Collect all tool_call IDs from assistant messages
    const toolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallIds.add(tc.id);
        }
      }
    }

    // Collect all tool_result IDs
    const toolResultIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        toolResultIds.add(msg.tool_call_id);
      }
    }

    // Find tool_calls that don't have results
    const orphanToolCallIds = new Set<string>();
    for (const id of toolCallIds) {
      if (!toolResultIds.has(id)) {
        orphanToolCallIds.add(id);
      }
    }

    // Filter messages:
    // 1. Remove tool results without matching tool_calls
    // 2. Remove tool_calls from assistant messages that don't have results
    return messages
      .map((msg) => {
        if (msg.role === "tool" && msg.tool_call_id) {
          // Remove orphan tool results
          if (!toolCallIds.has(msg.tool_call_id)) {
            return null;
          }
        }
        if (msg.role === "assistant" && msg.tool_calls) {
          // Filter out orphan tool_calls
          const validToolCalls = msg.tool_calls.filter((tc) => !orphanToolCallIds.has(tc.id));
          if (validToolCalls.length === 0 && msg.tool_calls.length > 0) {
            // All tool_calls were orphans - return message with just content if any
            if (msg.content) {
              return { ...msg, tool_calls: undefined };
            }
            return null; // Remove entirely if no content
          }
          if (validToolCalls.length < msg.tool_calls.length) {
            return { ...msg, tool_calls: validToolCalls };
          }
        }
        return msg;
      })
      .filter((msg): msg is Message => msg !== null);
  }

  clearMessages(sessionId: string) {
    this.db.run("DELETE FROM messages WHERE session_id = ?", [sessionId]);
  }

  // ============================================================================
  // Session Statistics & Compaction
  // ============================================================================

  /**
   * Get statistics about a session's size
   */
  getSessionStats(sessionId: string): {
    messageCount: number;
    totalBytes: number;
    estimatedTokens: number;
  } {
    const row = this.db
      .query(
        `SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(content)), 0) + COALESCE(SUM(LENGTH(tool_calls)), 0) as bytes 
       FROM messages WHERE session_id = ?`,
      )
      .get(sessionId) as { count: number; bytes: number } | null;

    const messageCount = row?.count || 0;
    const totalBytes = row?.bytes || 0;
    // Conservative estimate: ~3 chars per token (code-heavy agent sessions use ~2.8)
    const estimatedTokens = Math.ceil(totalBytes / 3);

    return { messageCount, totalBytes, estimatedTokens };
  }

  /**
   * Get session stats by name
   */
  getSessionStatsByName(name: string): {
    messageCount: number;
    totalBytes: number;
    estimatedTokens: number;
  } | null {
    const session = this.db
      .query("SELECT id FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1")
      .get(name) as { id: string } | null;

    if (!session) return null;
    return this.getSessionStats(session.id);
  }

  /**
   * Compact a session by keeping only recent messages and creating a summary
   * @param sessionId - Session to compact
   * @param keepCount - Number of recent messages to keep
   * @param summaryPrefix - Optional summary of older messages to prepend
   * @returns Number of messages deleted
   */
  compactSession(sessionId: string, keepCount: number = 50, summaryPrefix?: string): number {
    // Purge heartbeat signals — they are ephemeral and should not survive compaction
    this.db.run(
      `DELETE FROM messages WHERE session_id = ? AND role = 'user' AND content LIKE '%<agent_signal>%[HEARTBEAT]%</agent_signal>%'`,
      [sessionId],
    );

    const stats = this.getSessionStats(sessionId);

    if (stats.messageCount <= keepCount) {
      return 0; // Nothing to compact
    }

    // Get the ID threshold - keep messages with ID >= this threshold
    const threshold = this.db
      .query(`SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?`)
      .get(sessionId, keepCount - 1) as { id: number } | null;

    if (!threshold) return 0;

    // Find tool_call_ids in messages we're keeping that reference older messages
    // We need to also keep the assistant messages that contain those tool_calls
    // AND all other tool_results for those assistant messages
    const keptToolResults = this.db
      .query(
        `SELECT DISTINCT tool_call_id FROM messages 
       WHERE session_id = ? AND id >= ? AND tool_call_id IS NOT NULL`,
      )
      .all(sessionId, threshold.id) as { tool_call_id: string }[];

    // Find the IDs of assistant messages that contain these tool_calls
    // AND collect ALL tool_call_ids from those assistant messages (not just the kept ones)
    const protectedIds: number[] = [];
    const allRequiredToolCallIds: Set<string> = new Set();

    if (keptToolResults.length > 0) {
      const toolCallIds = keptToolResults.map((r) => r.tool_call_id);
      // Find assistant messages with tool_calls that match any of these IDs
      const assistantMessages = this.db
        .query(
          `SELECT id, tool_calls FROM messages 
         WHERE session_id = ? AND id < ? AND tool_calls IS NOT NULL`,
        )
        .all(sessionId, threshold.id) as { id: number; tool_calls: string }[];

      for (const msg of assistantMessages) {
        try {
          const toolCalls = JSON.parse(msg.tool_calls) as { id: string }[];
          if (toolCalls.some((tc) => toolCallIds.includes(tc.id))) {
            protectedIds.push(msg.id);
            // IMPORTANT: Collect ALL tool_call_ids from this assistant message
            // because we must keep ALL corresponding tool_results
            for (const tc of toolCalls) {
              allRequiredToolCallIds.add(tc.id);
            }
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    }

    // Find and protect ALL tool_results for protected assistant messages
    if (allRequiredToolCallIds.size > 0) {
      const toolResultMsgs = this.db
        .query(
          `SELECT id, tool_call_id FROM messages 
         WHERE session_id = ? AND id < ? AND tool_call_id IS NOT NULL`,
        )
        .all(sessionId, threshold.id) as { id: number; tool_call_id: string }[];

      for (const tr of toolResultMsgs) {
        if (allRequiredToolCallIds.has(tr.tool_call_id)) {
          protectedIds.push(tr.id);
        }
      }
    }

    // Delete older messages, but protect those with referenced tool_calls/results
    let deleteResult;
    if (protectedIds.length > 0) {
      const placeholders = protectedIds.map(() => "?").join(",");
      deleteResult = this.db.run(
        `DELETE FROM messages WHERE session_id = ? AND id < ? AND id NOT IN (${placeholders})`,
        [sessionId, threshold.id, ...protectedIds],
      );
    } else {
      deleteResult = this.db.run("DELETE FROM messages WHERE session_id = ? AND id < ?", [sessionId, threshold.id]);
    }

    const deletedCount = deleteResult.changes;

    // If summary provided, insert it as the first message
    if (summaryPrefix && deletedCount > 0) {
      // Insert summary as a system-like user message at the beginning.
      // created_at = 0 (epoch) guarantees it sorts before all real messages
      // when ORDER BY created_at ASC is used in getMessages().
      this.db.run(
        `INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, created_at)
         VALUES (?, 'user', ?, NULL, NULL, 0)`,
        [sessionId, `[CONTEXT SUMMARY - ${deletedCount} older messages compacted]\n\n${summaryPrefix}`],
      );
    }

    console.log(`[SessionManager] Compacted session: deleted ${deletedCount} messages, kept ${keepCount}`);
    return deletedCount;
  }

  /**
   * Compact session by name
   */
  compactSessionByName(name: string, keepCount: number = 50, summaryPrefix?: string): number {
    const session = this.db
      .query("SELECT id FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1")
      .get(name) as { id: string } | null;

    if (!session) return 0;
    return this.compactSession(session.id, keepCount, summaryPrefix);
  }

  /**
   * Check if session needs compaction based on token limit
   * @param name - Session name
   * @param maxTokens - Maximum allowed tokens (default: 100000 for safety margin below 128k)
   * @returns true if session exceeds limit
   */
  needsCompaction(name: string, maxTokens: number = 50000): boolean {
    const stats = this.getSessionStatsByName(name);
    if (!stats) return false;
    return stats.estimatedTokens > maxTokens;
  }

  /**
   * Auto-compact a session if it exceeds token limits
   * @param name - Session name
   * @param maxTokens - Token threshold to trigger compaction
   * @param keepCount - Messages to keep after compaction
   * @returns true if compaction was performed
   */
  autoCompact(name: string, maxTokens: number = 50000, keepCount: number = 30): boolean {
    // Single stats query used for both check and logging (avoids redundant DB scan)
    const stats = this.getSessionStatsByName(name);
    if (!stats || stats.estimatedTokens <= maxTokens) return false;

    console.log(
      `[SessionManager] Session "${name}" exceeds token limit (${stats.estimatedTokens} > ${maxTokens}), compacting...`,
    );

    const summary = `Previous conversation had approximately ${stats.messageCount} messages and ${stats.estimatedTokens} tokens. The older messages have been compacted to stay within context limits.`;

    const deleted = this.compactSessionByName(name, keepCount, summary);
    return deleted > 0;
  }

  /**
   * Purge sessions older than maxAgeDays. Call periodically or on startup.
   */
  purgeOldSessions(maxAgeDays: number = 30): number {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const old = this.db.query<{ id: string }, [number]>("SELECT id FROM sessions WHERE updated_at < ?").all(cutoff);
    if (old.length === 0) return 0;
    this.db.transaction(() => {
      for (const { id } of old) {
        this.db.run("DELETE FROM messages WHERE session_id = ?", [id]);
        this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
      }
    })();
    console.log(`[SessionManager] Purged ${old.length} sessions older than ${maxAgeDays} days`);
    return old.length;
  }

  /**
   * Reset a session completely (delete all messages)
   */
  resetSession(name: string): boolean {
    const session = this.db
      .query("SELECT id FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1")
      .get(name) as { id: string } | null;

    if (!session) return false;

    this.clearMessages(session.id);
    console.log(`[SessionManager] Reset session "${name}"`);
    return true;
  }

  // ============================================================================
  // Summarizer Checkpoint Persistence (for SessionSummarizer recovery)
  // ============================================================================

  /**
   * Save a summarizer checkpoint to the database
   */
  saveSummarizerCheckpoint(
    sessionId: string,
    checkpoint: {
      id: string;
      createdAt: string;
      fromTs: string;
      toTs: string;
      messageCount: number;
      summary: string;
    },
  ): void {
    try {
      this.db.run(
        `INSERT OR REPLACE INTO summarizer_checkpoints 
         (id, session_id, from_ts, to_ts, message_count, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          checkpoint.id,
          sessionId,
          checkpoint.fromTs,
          checkpoint.toTs,
          checkpoint.messageCount,
          checkpoint.summary,
          checkpoint.createdAt,
        ],
      );
    } catch (err) {
      console.error(`[SessionManager] Failed to save summarizer checkpoint: ${err}`);
    }
  }

  /**
   * Get all summarizer checkpoints for a session
   */
  getSummarizerCheckpoints(sessionId: string): {
    id: string;
    createdAt: string;
    fromTs: string;
    toTs: string;
    messageCount: number;
    summary: string;
  }[] {
    try {
      const rows = this.db
        .query("SELECT * FROM summarizer_checkpoints WHERE session_id = ? ORDER BY created_at ASC")
        .all(sessionId) as {
        id: string;
        session_id: string;
        from_ts: string;
        to_ts: string;
        message_count: number;
        summary: string;
        created_at: string;
      }[];

      return rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        fromTs: row.from_ts,
        toTs: row.to_ts,
        messageCount: row.message_count,
        summary: row.summary,
      }));
    } catch (err) {
      console.error(`[SessionManager] Failed to get summarizer checkpoints: ${err}`);
      return [];
    }
  }

  /**
   * Delete summarizer checkpoints for a session
   */
  deleteSummarizerCheckpoints(sessionId: string): void {
    try {
      this.db.run("DELETE FROM summarizer_checkpoints WHERE session_id = ?", [sessionId]);
    } catch (err) {
      console.error(`[SessionManager] Failed to delete summarizer checkpoints: ${err}`);
    }
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  getOrCreateSession(name: string, model: string): Session {
    // Look for existing session with same name
    const existing = this.db
      .query("SELECT * FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1")
      .get(name) as Session | null;

    if (existing) {
      return existing;
    }

    return this.createSession(name, model);
  }

  close() {
    this.db.close();
  }
}

/**
 * Get the singleton SessionManager instance (uses default db path)
 * Use this instead of `new SessionManager()` to avoid database lock contention
 */
export function getSessionManager(): SessionManager {
  if (!_defaultSessionManager) {
    _defaultSessionManager = new SessionManager();
  }
  return _defaultSessionManager;
}
