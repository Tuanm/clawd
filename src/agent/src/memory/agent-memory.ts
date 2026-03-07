/**
 * Agent Memory Store — Per-agent, per-channel long-term memory with FTS5
 *
 * Stores structured memories (facts, preferences, decisions, lessons, corrections)
 * scoped by agent_id + channel. Supports explicit save/recall/delete and
 * auto-extracted memories. Uses same memory.db as MemoryManager/KnowledgeBase.
 */

import Database from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────

export type MemoryCategory = "fact" | "preference" | "decision" | "lesson" | "correction";

export type MemorySource = "explicit" | "auto";

export interface AgentMemory {
  id: number;
  agentId: string;
  channel: string | null;
  category: MemoryCategory;
  content: string;
  source: MemorySource;
  accessCount: number;
  lastAccessed: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySaveInput {
  agentId: string;
  channel: string | null;
  content: string;
  category?: MemoryCategory;
  source?: MemorySource;
}

export interface MemoryRecallOptions {
  agentId: string;
  channel?: string | null;
  query?: string;
  category?: MemoryCategory;
  limit?: number;
  offset?: number;
  /** Include agent-wide memories (channel IS NULL) in results */
  includeGlobal?: boolean;
}

export interface MemorySearchResult extends AgentMemory {
  rank?: number;
}

// ── Constants ──────────────────────────────────────────────────────

const VALID_CATEGORIES: MemoryCategory[] = ["fact", "preference", "decision", "lesson", "correction"];
const MAX_MEMORIES_PER_AGENT = 500;
const DEDUP_SIMILARITY_THRESHOLD = 0.5;

// ── Singleton ──────────────────────────────────────────────────────

let _instance: AgentMemoryStore | null = null;

/**
 * Get the singleton AgentMemoryStore instance (uses default db path).
 * Reuses memory.db to avoid lock contention with MemoryManager.
 */
export function getAgentMemoryStore(): AgentMemoryStore {
  if (!_instance) {
    _instance = new AgentMemoryStore();
  }
  return _instance;
}

// ── Store ──────────────────────────────────────────────────────────

export class AgentMemoryStore {
  private db: Database;
  private initialized = false;

  constructor(dbPath?: string) {
    const defaultPath = join(homedir(), ".clawd", "memory.db");
    this.db = new Database(dbPath || defaultPath);
    this.setupConcurrency();
  }

  private setupConcurrency() {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 30000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA cache_size = -64000");
    this.db.exec("PRAGMA mmap_size = 268435456");
  }

  private ensureInit(): void {
    if (this.initialized) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          channel TEXT,
          category TEXT NOT NULL DEFAULT 'fact',
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'explicit',
          access_count INTEGER NOT NULL DEFAULT 0,
          last_accessed INTEGER NOT NULL DEFAULT (unixepoch()),
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_am_agent_channel ON agent_memories(agent_id, channel);
        CREATE INDEX IF NOT EXISTS idx_am_agent_category ON agent_memories(agent_id, category);
        CREATE INDEX IF NOT EXISTS idx_am_access ON agent_memories(agent_id, access_count, last_accessed);

        CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(
          content,
          content='agent_memories',
          content_rowid='id',
          tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS am_ai AFTER INSERT ON agent_memories BEGIN
          INSERT INTO agent_memories_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS am_ad AFTER DELETE ON agent_memories BEGIN
          INSERT INTO agent_memories_fts(agent_memories_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS am_au AFTER UPDATE ON agent_memories BEGIN
          INSERT INTO agent_memories_fts(agent_memories_fts, rowid, content) VALUES('delete', old.id, old.content);
          INSERT INTO agent_memories_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `);
      this.initialized = true;
    } catch (err) {
      console.error("[AgentMemory] Init failed:", err);
    }
  }

  // ── Save ───────────────────────────────────────────────────────

  /**
   * Save a memory. Returns the new memory ID, or null if dedup matched.
   * Also returns a warning string if a near-duplicate was found.
   */
  save(input: MemorySaveInput): { id: number | null; warning?: string } {
    this.ensureInit();
    if (!this.initialized) return { id: null, warning: "Store not initialized" };

    const category = input.category && VALID_CATEGORIES.includes(input.category) ? input.category : "fact";
    const source = input.source === "auto" ? "auto" : "explicit";
    const content = input.content.trim();

    if (!content) return { id: null, warning: "Empty content" };

    // Dedup check: find similar existing memories
    const similar = this.findSimilar(input.agentId, input.channel, content, category);
    if (similar) {
      // Exact or near-exact match — skip save for auto, warn for explicit
      if (source === "auto") return { id: null };
      // For explicit source, update the existing memory
      this.db.run(
        `UPDATE agent_memories SET content = ?, updated_at = unixepoch(), access_count = access_count + 1 WHERE id = ?`,
        [content, similar.id],
      );
      return { id: similar.id, warning: `Updated existing memory #${similar.id} (similar content found)` };
    }

    // Enforce per-agent cap
    this.enforceAgentCap(input.agentId);

    const stmt = this.db.prepare(`
      INSERT INTO agent_memories (agent_id, channel, category, content, source)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(input.agentId, input.channel, category, content, source);
    return { id: Number(result.lastInsertRowid) };
  }

  // ── Recall ─────────────────────────────────────────────────────

  /**
   * Search memories. If query provided, uses FTS5. Otherwise returns recent.
   * Results are scoped to the agent. Optionally includes agent-wide (channel=NULL) memories.
   */
  recall(opts: MemoryRecallOptions): MemorySearchResult[] {
    this.ensureInit();
    if (!this.initialized) return [];

    const limit = Math.min(opts.limit || 20, 50);
    const offset = opts.offset || 0;

    let results: MemorySearchResult[];

    if (opts.query && opts.query.trim()) {
      results = this.searchFTS(opts, limit, offset);
    } else {
      results = this.getRecent(opts, limit, offset);
    }

    // Bump access_count for returned results
    if (results.length > 0) {
      const ids = results.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db.run(
        `UPDATE agent_memories SET access_count = access_count + 1, last_accessed = unixepoch() WHERE id IN (${placeholders})`,
        ids,
      );
    }

    return results;
  }

  private searchFTS(opts: MemoryRecallOptions, limit: number, offset: number): MemorySearchResult[] {
    // Sanitize FTS query: escape special chars, wrap terms in quotes
    const sanitized = sanitizeFTSQuery(opts.query || "");
    if (!sanitized) return this.getRecent(opts, limit, offset);

    const channelClause = this.buildChannelClause(opts);
    const categoryClause = opts.category ? "AND am.category = ?" : "";

    const sql = `
      SELECT am.*, fts.rank
      FROM agent_memories am
      JOIN agent_memories_fts fts ON am.id = fts.rowid
      WHERE fts.agent_memories_fts MATCH ?
        AND am.agent_id = ?
        ${channelClause.sql}
        ${categoryClause}
      ORDER BY fts.rank
      LIMIT ? OFFSET ?
    `;

    const params: any[] = [sanitized, opts.agentId, ...channelClause.params];
    if (opts.category) params.push(opts.category);
    params.push(limit, offset);

    const rows = this.db.query(sql).all(...params) as any[];
    return rows.map(rowToMemory);
  }

  private getRecent(opts: MemoryRecallOptions, limit: number, offset: number): MemorySearchResult[] {
    const channelClause = this.buildChannelClause(opts);
    const categoryClause = opts.category ? "AND category = ?" : "";

    const sql = `
      SELECT * FROM agent_memories
      WHERE agent_id = ?
        ${channelClause.sql}
        ${categoryClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `;

    const params: any[] = [opts.agentId, ...channelClause.params];
    if (opts.category) params.push(opts.category);
    params.push(limit, offset);

    const rows = this.db.query(sql).all(...params) as any[];
    return rows.map(rowToMemory);
  }

  private buildChannelClause(opts: MemoryRecallOptions): { sql: string; params: any[] } {
    if (opts.includeGlobal && opts.channel) {
      return { sql: "AND (channel = ? OR channel IS NULL)", params: [opts.channel] };
    }
    if (opts.channel) {
      return { sql: "AND channel = ?", params: [opts.channel] };
    }
    if (opts.channel === null) {
      return { sql: "AND channel IS NULL", params: [] };
    }
    // No channel filter — return all
    return { sql: "", params: [] };
  }

  // ── Delete ─────────────────────────────────────────────────────

  /**
   * Delete a memory by ID. Returns true if deleted, false if not found or not owned.
   */
  delete(id: number, agentId: string): boolean {
    this.ensureInit();
    if (!this.initialized) return false;

    const result = this.db.run("DELETE FROM agent_memories WHERE id = ? AND agent_id = ?", [id, agentId]);
    return result.changes > 0;
  }

  // ── Find Similar (dedup) ───────────────────────────────────────

  /**
   * Find a similar existing memory using FTS5 candidates + Jaccard word similarity.
   */
  findSimilar(agentId: string, channel: string | null, content: string, category: string): AgentMemory | null {
    this.ensureInit();
    if (!this.initialized) return null;

    // Extract keywords for FTS search
    const keywords = extractKeywords(content);
    if (keywords.length === 0) return null;

    // Sanitize for FTS5 safety
    const safeKeywords = keywords.slice(0, 5).map((k) => k.replace(/"/g, ""));
    const ftsQuery = safeKeywords
      .filter((k) => k.length > 0)
      .map((k) => `"${k}"`)
      .join(" OR ");
    if (!ftsQuery) return null;

    try {
      const channelSql = channel ? "AND am.channel = ?" : "AND am.channel IS NULL";
      const params: any[] = [ftsQuery, agentId];
      if (channel) params.push(channel);
      params.push(category);

      const candidates = this.db
        .query(
          `SELECT am.*
          FROM agent_memories am
          JOIN agent_memories_fts fts ON am.id = fts.rowid
          WHERE fts.agent_memories_fts MATCH ?
            AND am.agent_id = ?
            ${channelSql}
            AND am.category = ?
          ORDER BY fts.rank
          LIMIT 10`,
        )
        .all(...params) as any[];

      // Jaccard word similarity check
      const contentWords = new Set(
        content
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 2),
      );
      for (const row of candidates) {
        const existingWords = new Set(
          (row.content as string)
            .toLowerCase()
            .split(/\s+/)
            .filter((w: string) => w.length > 2),
        );
        const intersection = [...contentWords].filter((w) => existingWords.has(w)).length;
        const union = new Set([...contentWords, ...existingWords]).size;
        const similarity = union > 0 ? intersection / union : 0;

        if (similarity >= DEDUP_SIMILARITY_THRESHOLD) {
          return rowToMemory(row);
        }
      }
    } catch {
      // FTS query failure — no dedup
    }

    return null;
  }

  // ── Relevant Memories (for injection) ──────────────────────────

  /**
   * Get recent + keyword-relevant memories for system prompt injection.
   * Returns deduplicated list of memories sorted by relevance.
   */
  getRelevant(agentId: string, channel: string, keywords: string[], maxRecent = 5, maxRelevant = 10): AgentMemory[] {
    this.ensureInit();
    if (!this.initialized) return [];

    const seen = new Set<number>();
    const results: AgentMemory[] = [];

    // 1. Recent memories (agent-specific channel + agent-wide)
    const recent = this.db
      .query(
        `SELECT * FROM agent_memories
        WHERE agent_id = ? AND (channel = ? OR channel IS NULL)
        ORDER BY updated_at DESC
        LIMIT ?`,
      )
      .all(agentId, channel, maxRecent) as any[];

    for (const row of recent) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        results.push(rowToMemory(row));
      }
    }

    // 2. Keyword-relevant via FTS5
    if (keywords.length > 0) {
      // Sanitize keywords for FTS5 safety
      const safeKeywords = keywords
        .slice(0, 8)
        .map((k) => k.replace(/[^\p{L}\p{N}-]/gu, ""))
        .filter((k) => k.length > 1);
      if (safeKeywords.length > 0) {
        const ftsQuery = safeKeywords.map((k) => `"${k}"`).join(" OR ");
        try {
          const relevant = this.db
            .query(
              `SELECT am.*
              FROM agent_memories am
              JOIN agent_memories_fts fts ON am.id = fts.rowid
              WHERE fts.agent_memories_fts MATCH ?
                AND am.agent_id = ?
                AND (am.channel = ? OR am.channel IS NULL)
              ORDER BY fts.rank
              LIMIT ?`,
            )
            .all(ftsQuery, agentId, channel, maxRelevant) as any[];

          for (const row of relevant) {
            if (!seen.has(row.id)) {
              seen.add(row.id);
              results.push(rowToMemory(row));
            }
          }
        } catch {
          // FTS failure — return only recent
        }
      }
    }

    // Bump access_count
    if (results.length > 0) {
      const ids = results.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db.run(
        `UPDATE agent_memories SET access_count = access_count + 1, last_accessed = unixepoch() WHERE id IN (${placeholders})`,
        ids,
      );
    }

    return results;
  }

  // ── Count ──────────────────────────────────────────────────────

  getCount(agentId: string): number {
    this.ensureInit();
    if (!this.initialized) return 0;
    const row = this.db.query("SELECT COUNT(*) as count FROM agent_memories WHERE agent_id = ?").get(agentId) as {
      count: number;
    };
    return row.count;
  }

  // ── Eviction ───────────────────────────────────────────────────

  /**
   * Enforce per-agent memory cap. Evicts least-accessed memories when over limit.
   */
  private enforceAgentCap(agentId: string): void {
    const count = this.getCount(agentId);
    if (count < MAX_MEMORIES_PER_AGENT) return;

    // Delete least-accessed auto-extracted memories first, then least-accessed explicit
    const toDelete = count - MAX_MEMORIES_PER_AGENT + 10; // Free up 10 slots
    this.db.run(
      `DELETE FROM agent_memories WHERE id IN (
        SELECT id FROM agent_memories
        WHERE agent_id = ?
        ORDER BY
          CASE WHEN source = 'auto' THEN 0 ELSE 1 END,
          access_count ASC,
          last_accessed ASC
        LIMIT ?
      )`,
      [agentId, toDelete],
    );
  }

  // ── Close ──────────────────────────────────────────────────────

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed
    }
    if (_instance === this) _instance = null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "used",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "that",
  "this",
  "what",
  "which",
  "who",
  "whom",
  "these",
  "those",
  "it",
  "its",
  "he",
  "she",
  "they",
  "them",
  "his",
  "her",
  "their",
  "my",
  "your",
  "our",
  "me",
  "him",
  "us",
  "you",
  "i",
  "we",
  "also",
  "about",
  "up",
]);

/**
 * Extract meaningful keywords from text, filtering stop words.
 */
export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
    }
  }
  return unique;
}

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 * Wraps each word in quotes to prevent syntax errors.
 */
function sanitizeFTSQuery(query: string): string {
  const words = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  if (words.length === 0) return "";
  return words.map((w) => `"${w}"`).join(" OR ");
}

function rowToMemory(row: any): AgentMemory & { rank?: number } {
  return {
    id: row.id,
    agentId: row.agent_id,
    channel: row.channel,
    category: row.category,
    content: row.content,
    source: row.source,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rank: row.rank,
  };
}
