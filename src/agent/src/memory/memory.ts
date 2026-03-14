/**
 * Memory System - Search, Filter, and Summarize Past Conversations
 */

import Database from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "../api/client";

// ============================================================================
// Types
// ============================================================================

export interface MemoryQuery {
  sessionId?: string;
  startTime?: number;
  endTime?: number;
  keywords?: string[];
  role?: "user" | "assistant" | "tool";
  limit?: number;
}

export interface MemoryEntry {
  id: number;
  sessionId: string;
  sessionName: string;
  role: string;
  content: string;
  createdAt: number;
  relevanceScore?: number;
}

export interface MemorySummary {
  sessionId: string;
  sessionName: string;
  messageCount: number;
  timeRange: { start: number; end: number };
  summary: string;
  keyTopics: string[];
}

// ============================================================================
// Token Estimation
// ============================================================================

// Base64 detection: data URIs or long base64 strings (includes padding chars)
const BASE64_PATTERN = /(?:data:[a-z]+\/[a-z0-9.+-]+;base64,)?[A-Za-z0-9+/=]{500,}/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Detect base64 content — tokenizes ~1:1 (not 4:1)
  const base64Matches = text.match(BASE64_PATTERN);
  if (base64Matches) {
    let base64Chars = 0;
    for (const match of base64Matches) {
      // Validate: real base64 has high character variety (excluding = padding)
      const stripped = match.replace(/=/g, "");
      const sample = stripped.slice(0, 200);
      const unique = new Set(sample);
      if (unique.size > 15) {
        base64Chars += match.length;
      }
    }
    if (base64Chars > 0) {
      const nonBase64Text = text.replace(BASE64_PATTERN, "");
      const nonBase64Chars = nonBase64Text.length;
      return Math.ceil(base64Chars / 1.0) + estimateNonBase64Tokens(nonBase64Chars, nonBase64Text);
    }
  }

  return estimateNonBase64Tokens(text.length, text);
}

function estimateNonBase64Tokens(charCount: number, text: string): number {
  if (charCount === 0) return 0;

  const sample = text.slice(0, 2000);
  if (sample.length === 0) return Math.ceil(charCount / 3.5);

  const codeChars = (sample.match(/[{}[\];:=<>()]/g) || []).length;
  const codeRatio = codeChars / sample.length;

  let charsPerToken: number;
  if (codeRatio > 0.08) {
    charsPerToken = 2.8; // Code/JSON heavy
  } else if (codeRatio < 0.02) {
    charsPerToken = 4.0; // Prose
  } else {
    charsPerToken = 3.5; // Mixed
  }

  return Math.ceil(charCount / charsPerToken);
}

const messageTokenCache = new WeakMap<Message, { tokens: number; contentLen: number; contentHash: number }>();

// Simple string hash for cache invalidation (FNV-1a)
function hashContent(s: string): number {
  let h = 2166136261;
  for (let i = 0, len = Math.min(s.length, 500); i < len; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) | 0;
  }
  return h;
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = msg.content || "";
    const contentLen = content.length + (msg.tool_calls ? JSON.stringify(msg.tool_calls).length : 0);
    const contentHash = hashContent(content);
    const cached = messageTokenCache.get(msg);
    if (cached !== undefined && cached.contentLen === contentLen && cached.contentHash === contentHash) {
      total += cached.tokens;
      continue;
    }
    let msgTokens = estimateTokens(content);
    if (msg.tool_calls) {
      msgTokens += estimateTokens(JSON.stringify(msg.tool_calls));
    }
    messageTokenCache.set(msg, { tokens: msgTokens, contentLen, contentHash });
    total += msgTokens;
  }
  return total;
}

// ============================================================================
// Memory Manager
// ============================================================================

// Singleton instance
let _defaultMemoryManager: MemoryManager | null = null;

export class MemoryManager {
  private db: Database;

  constructor(dbPath?: string) {
    const defaultPath = join(homedir(), ".clawd", "memory.db");
    this.db = new Database(dbPath || defaultPath);
    this.setupConcurrency();
    this.init();
  }

  private setupConcurrency() {
    // Enable WAL mode for better concurrent read/write
    this.db.exec("PRAGMA journal_mode = WAL");
    // Wait up to 30 seconds for locks (increased from 5s)
    this.db.exec("PRAGMA busy_timeout = 30000");
    // Balanced sync mode
    this.db.exec("PRAGMA synchronous = NORMAL");
    // Increase cache size for better performance
    this.db.exec("PRAGMA cache_size = -64000"); // 64MB cache
    // Enable memory-mapped I/O
    this.db.exec("PRAGMA mmap_size = 268435456"); // 256MB mmap
  }

  private init() {
    // Add FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='id'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      -- Index existing messages
      INSERT OR IGNORE INTO messages_fts(rowid, content) 
      SELECT id, content FROM messages WHERE content IS NOT NULL;
    `);
  }

  // ============================================================================
  // Search
  // ============================================================================

  search(query: MemoryQuery): MemoryEntry[] {
    let sql = `
      SELECT 
        m.id,
        m.session_id as sessionId,
        s.name as sessionName,
        m.role,
        m.content,
        m.created_at as createdAt
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (query.sessionId) {
      sql += " AND m.session_id = ?";
      params.push(query.sessionId);
    }

    if (query.startTime) {
      sql += " AND m.created_at >= ?";
      params.push(query.startTime);
    }

    if (query.endTime) {
      sql += " AND m.created_at <= ?";
      params.push(query.endTime);
    }

    if (query.role) {
      sql += " AND m.role = ?";
      params.push(query.role);
    }

    if (query.keywords && query.keywords.length > 0) {
      // Use FTS for keyword search
      const ftsQuery = query.keywords.map((k) => `"${k}"`).join(" OR ");
      sql += ` AND m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)`;
      params.push(ftsQuery);
    }

    sql += " ORDER BY m.created_at DESC";
    sql += ` LIMIT ?`;
    params.push(query.limit || 50);

    return this.db.query(sql).all(...params) as MemoryEntry[];
  }

  // ============================================================================
  // Search by Keywords
  // ============================================================================

  searchByKeywords(keywords: string[], limit = 20): MemoryEntry[] {
    return this.search({ keywords, limit });
  }

  // ============================================================================
  // Search by Time Range
  // ============================================================================

  searchByTimeRange(startTime: number, endTime: number, limit = 50): MemoryEntry[] {
    return this.search({ startTime, endTime, limit });
  }

  // ============================================================================
  // Get Recent Context
  // ============================================================================

  getRecentContext(sessionId: string, maxTokens: number): Message[] {
    const messages: Message[] = [];
    let totalTokens = 0;

    // Get messages in reverse chronological order
    const rows = this.db
      .query(`
      SELECT role, content, tool_calls, tool_call_id
      FROM messages
      WHERE session_id = ?
      ORDER BY id DESC
    `)
      .all(sessionId) as any[];

    // Add messages until we hit token limit
    for (const row of rows) {
      const msg: Message = {
        role: row.role,
        content: row.content,
        tool_calls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
        tool_call_id: row.tool_call_id || undefined,
      };

      const msgTokens =
        estimateTokens(msg.content || "") + (msg.tool_calls ? estimateTokens(JSON.stringify(msg.tool_calls)) : 0);

      if (totalTokens + msgTokens > maxTokens) {
        break;
      }

      messages.unshift(msg); // Add to front to maintain order
      totalTokens += msgTokens;
    }

    return messages;
  }

  // ============================================================================
  // Summarize Session
  // ============================================================================

  getSessionSummary(sessionId: string): MemorySummary | null {
    const session = this.db.query("SELECT id, name FROM sessions WHERE id = ?").get(sessionId) as {
      id: string;
      name: string;
    } | null;

    if (!session) return null;

    const stats = this.db
      .query(`
      SELECT 
        COUNT(*) as count,
        MIN(created_at) as minTime,
        MAX(created_at) as maxTime
      FROM messages
      WHERE session_id = ?
    `)
      .get(sessionId) as { count: number; minTime: number; maxTime: number };

    // Get key messages for summary
    const keyMessages = this.db
      .query(`
      SELECT content FROM messages
      WHERE session_id = ? AND role = 'user'
      ORDER BY created_at DESC
      LIMIT 10
    `)
      .all(sessionId) as { content: string }[];

    // Extract key topics (simple word frequency)
    const wordFreq = new Map<string, number>();
    for (const msg of keyMessages) {
      if (!msg.content) continue;
      const words = msg.content
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 4);

      for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }
    }

    const keyTopics = [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);

    // Generate summary from recent user messages
    const summary = keyMessages
      .slice(0, 3)
      .map((m) => m.content?.slice(0, 100))
      .filter(Boolean)
      .join(" | ");

    return {
      sessionId: session.id,
      sessionName: session.name,
      messageCount: stats.count,
      timeRange: { start: stats.minTime, end: stats.maxTime },
      summary: summary || "No messages",
      keyTopics,
    };
  }

  // ============================================================================
  // Compact Messages (Summarize old messages)
  // ============================================================================

  async compactSession(
    sessionId: string,
    maxMessages: number,
    summarizer: (messages: Message[]) => Promise<string>,
  ): Promise<void> {
    const count = this.db.query("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").get(sessionId) as {
      count: number;
    };

    if (count.count <= maxMessages) return;

    // Get oldest messages to compact
    const toCompact = count.count - maxMessages + 1; // +1 for summary message
    const oldMessages = this.db
      .query(`
      SELECT id, role, content FROM messages
      WHERE session_id = ?
      ORDER BY id ASC
      LIMIT ?
    `)
      .all(sessionId, toCompact) as { id: number; role: string; content: string }[];

    if (oldMessages.length < 2) return;

    // Generate summary
    const messagesForSummary: Message[] = oldMessages.map((m) => ({
      role: m.role as Message["role"],
      content: m.content,
    }));

    const summary = await summarizer(messagesForSummary);

    // Delete old messages and insert summary
    const oldIds = oldMessages.map((m) => m.id);
    this.db.run(`DELETE FROM messages WHERE id IN (${oldIds.join(",")})`);

    this.db.run(
      `
      INSERT INTO messages (session_id, role, content, created_at)
      VALUES (?, 'system', ?, ?)
    `,
      [sessionId, `[Summary of earlier conversation]: ${summary}`, oldMessages[0].id],
    );
  }

  close() {
    this.db.close();
  }
}

/**
 * Get the singleton MemoryManager instance (uses default db path)
 * Use this instead of `new MemoryManager()` to avoid database lock contention
 */
export function getMemoryManager(): MemoryManager {
  if (!_defaultMemoryManager) {
    _defaultMemoryManager = new MemoryManager();
  }
  return _defaultMemoryManager;
}
