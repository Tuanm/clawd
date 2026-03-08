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
  priority: number;
  tags: string;
  effectiveness: number;
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
  priority?: number;
  tags?: string;
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
const MAX_MEMORIES_PER_AGENT = 2000;
const DEDUP_SIMILARITY_THRESHOLD = 0.5;

// ── Static Synonym Map (Phase 3: Query Expansion) ────────────────

const SYNONYM_MAP: Record<string, string[]> = {
  login: ["authentication", "auth", "signin", "sign-in"],
  auth: ["authentication", "login", "signin", "authorization"],
  authentication: ["auth", "login", "signin"],
  bug: ["error", "issue", "defect", "problem"],
  error: ["bug", "exception", "failure", "crash"],
  test: ["testing", "spec", "unit-test", "jest", "vitest"],
  deploy: ["deployment", "release", "ship", "ci-cd"],
  database: ["db", "sqlite", "postgres", "sql"],
  db: ["database", "sqlite", "sql"],
  api: ["endpoint", "route", "rest", "graphql"],
  style: ["css", "styling", "theme", "design"],
  config: ["configuration", "settings", "options"],
  perf: ["performance", "speed", "optimization", "latency"],
  performance: ["perf", "speed", "optimization", "latency"],
  security: ["auth", "vulnerability", "xss", "csrf", "injection"],
  ui: ["interface", "frontend", "component", "view"],
  frontend: ["ui", "client", "browser", "react"],
  backend: ["server", "api", "node", "bun"],
  memory: ["recall", "remember", "memo", "context"],
  refactor: ["restructure", "cleanup", "rewrite", "simplify"],
};

/** Expand keywords with static synonyms for better FTS5 recall */
function expandWithSynonyms(keywords: string[]): string[] {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    const lower = kw.toLowerCase();
    const synonyms = SYNONYM_MAP[lower];
    if (synonyms) {
      for (const syn of synonyms.slice(0, 3)) {
        expanded.add(syn);
      }
    }
  }
  return [...expanded].slice(0, 15); // Cap total expanded keywords
}

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

      // Idempotent migrations: add priority and tags columns
      try {
        this.db.exec("ALTER TABLE agent_memories ADD COLUMN priority INTEGER NOT NULL DEFAULT 50");
      } catch (e: any) {
        if (!String(e?.message).includes("duplicate column")) throw e;
      }
      try {
        this.db.exec("ALTER TABLE agent_memories ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
      } catch (e: any) {
        if (!String(e?.message).includes("duplicate column")) throw e;
      }
      try {
        this.db.exec("ALTER TABLE agent_memories ADD COLUMN effectiveness REAL NOT NULL DEFAULT 0.5");
      } catch (e: any) {
        if (!String(e?.message).includes("duplicate column")) throw e;
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_am_priority ON agent_memories(agent_id, priority DESC)");

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
    const rawPriority = input.priority ?? (source === "auto" ? 40 : 50);
    const priority = Math.max(0, Math.min(rawPriority, 79)); // Only pin() can set >= 80
    const tags = input.tags ?? extractKeywords(content).slice(0, 5).join(",");

    if (!content) return { id: null, warning: "Empty content" };
    if (content.length > 5000) return { id: null, warning: "Content too long (max 5000 chars)" };

    // Dedup check: find similar existing memories
    const similar = this.findSimilar(input.agentId, input.channel, content, category);
    if (similar) {
      // Exact or near-exact match — skip save for auto, warn for explicit
      if (source === "auto") return { id: null };
      // For explicit source, update the existing memory (include priority and tags)
      this.db.run(
        `UPDATE agent_memories SET content = ?, priority = ?, tags = ?, updated_at = unixepoch(), access_count = access_count + 1 WHERE id = ?`,
        [content, priority, tags, similar.id],
      );
      return { id: similar.id, warning: `Updated existing memory #${similar.id} (similar content found)` };
    }

    // Enforce per-agent cap
    this.enforceAgentCap(input.agentId);

    const stmt = this.db.prepare(`
      INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(input.agentId, input.channel, category, content, source, priority, tags);
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
    const pinned: AgentMemory[] = [];
    const relevant: AgentMemory[] = [];
    const recent: AgentMemory[] = [];

    // Tier 1: PINNED memories (priority >= 80) — ALWAYS loaded
    const pinnedRows = this.db
      .query(
        `SELECT * FROM agent_memories
         WHERE agent_id = ? AND (channel = ? OR channel IS NULL)
           AND priority >= 80
         ORDER BY priority DESC, updated_at DESC
         LIMIT 25`,
      )
      .all(agentId, channel) as any[];

    for (const row of pinnedRows) {
      seen.add(row.id);
      pinned.push(rowToMemory(row));
    }

    // Tier 2: RELEVANT memories via FTS5 + tags with synonym expansion (priority < 80)
    if (keywords.length > 0) {
      // Phase 3: Expand keywords with static synonyms
      const expandedKeywords = expandWithSynonyms(keywords);
      const safeKeywords = expandedKeywords
        .slice(0, 12)
        .map((k) => k.replace(/[^\p{L}\p{N}-]/gu, ""))
        .filter((k) => k.length > 1);

      if (safeKeywords.length > 0) {
        const ftsQuery = safeKeywords.map((k) => `"${k}"`).join(" OR ");
        try {
          // Fetch more candidates for weighted scoring
          const ftsRows = this.db
            .query(
              `SELECT am.*, fts.rank
               FROM agent_memories am
               JOIN agent_memories_fts fts ON am.id = fts.rowid
               WHERE fts.agent_memories_fts MATCH ?
                 AND am.agent_id = ?
                 AND (am.channel = ? OR am.channel IS NULL)
                 AND am.priority < 80
               ORDER BY fts.rank
               LIMIT ?`,
            )
            .all(ftsQuery, agentId, channel, maxRelevant * 2) as any[];

          // Phase 3: Weighted scoring — combine FTS rank + recency + access_count + priority
          const now = Math.floor(Date.now() / 1000);
          const candidates = ftsRows.filter((row: any) => !seen.has(row.id));
          // Normalize FTS rank: more negative = better match. Map to [0, 1].
          const maxRank = Math.max(...candidates.map((r: any) => Math.abs(r.rank || 0)), 1);
          const scored = candidates
            .map((row: any) => {
              const ftsScore = Math.abs(row.rank || 0) / maxRank; // Normalized to [0, 1], higher = better
              const ageHours = Math.max(1, (now - (row.last_accessed || row.created_at)) / 3600);
              const recencyScore = 1 / Math.log2(ageHours + 1); // Decays logarithmically
              const accessScore = Math.min(1, (row.access_count || 0) / 10); // Caps at 10 accesses
              const priorityScore = (row.priority || 50) / 100;
              const effectivenessScore = row.effectiveness ?? 0.5; // Phase 4: effectiveness as tiebreaker

              const totalScore =
                ftsScore * 0.35 +
                recencyScore * 0.15 +
                accessScore * 0.1 +
                priorityScore * 0.25 +
                effectivenessScore * 0.15;
              return { row, score: totalScore };
            })
            .sort((a: any, b: any) => b.score - a.score)
            .slice(0, maxRelevant);

          for (const { row } of scored) {
            seen.add(row.id);
            relevant.push(rowToMemory(row));
          }
        } catch {
          /* FTS failure */
        }

        // Also search by tags (using original + expanded keywords)
        if (relevant.length < maxRelevant) {
          const tagKeywords = safeKeywords.slice(0, 8);
          const tagQuery = tagKeywords.map(() => `tags LIKE '%' || ? || '%'`).join(" OR ");
          try {
            const tagRows = this.db
              .query(
                `SELECT * FROM agent_memories
                 WHERE agent_id = ? AND (channel = ? OR channel IS NULL)
                   AND priority < 80
                   AND (${tagQuery})
                 ORDER BY priority DESC, access_count DESC
                 LIMIT ?`,
              )
              .all(agentId, channel, ...tagKeywords, maxRelevant - relevant.length) as any[];

            for (const row of tagRows) {
              if (!seen.has(row.id)) {
                seen.add(row.id);
                relevant.push(rowToMemory(row));
              }
            }
          } catch {
            /* Tag search failure */
          }
        }
      }
    }

    // Tier 3: RECENT memories (non-pinned, not already included)
    const recentRows = this.db
      .query(
        `SELECT * FROM agent_memories
         WHERE agent_id = ? AND (channel = ? OR channel IS NULL)
           AND priority < 80
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(agentId, channel, maxRecent) as any[];

    for (const row of recentRows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        recent.push(rowToMemory(row));
      }
    }

    const results = [...pinned, ...relevant, ...recent];

    // Bump access_count + priority boost (+2 per access, capped)
    if (results.length > 0) {
      const ids = results.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db.run(
        `UPDATE agent_memories SET
          access_count = access_count + 1,
          last_accessed = unixepoch(),
          priority = MIN(CASE WHEN priority >= 80 THEN 100 ELSE 79 END, priority + 2)
        WHERE id IN (${placeholders})`,
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

    // Delete least-accessed non-pinned memories first (never evict priority >= 80)
    const toDelete = count - MAX_MEMORIES_PER_AGENT + 10; // Free up 10 slots
    this.db.run(
      `DELETE FROM agent_memories WHERE id IN (
        SELECT id FROM agent_memories
        WHERE agent_id = ? AND priority < 80
        ORDER BY
          CASE WHEN source = 'auto' THEN 0 ELSE 1 END,
          priority ASC,
          access_count ASC,
          last_accessed ASC
        LIMIT ?
      )`,
      [agentId, toDelete],
    );
  }

  // ── Pin / Unpin / Decay ─────────────────────────────────────────

  /** Pin a memory (set priority to 90). Returns false if max pinned (25) reached. */
  pin(id: number, agentId: string): { success: boolean; error?: string } {
    this.ensureInit();
    if (!this.initialized) return { success: false, error: "Store not initialized" };

    const pinCount = this.db
      .query("SELECT COUNT(*) as count FROM agent_memories WHERE agent_id = ? AND priority >= 80 AND id != ?")
      .get(agentId, id) as { count: number };

    if (pinCount.count >= 25) {
      return { success: false, error: "Maximum 25 pinned memories. Unpin some first." };
    }

    const result = this.db.run(
      "UPDATE agent_memories SET priority = 90, updated_at = unixepoch() WHERE id = ? AND agent_id = ?",
      [id, agentId],
    );

    return result.changes > 0
      ? { success: true }
      : { success: false, error: `Memory #${id} not found or not owned by you` };
  }

  /** Unpin a memory (reset priority to 60). */
  unpin(id: number, agentId: string): { success: boolean; error?: string } {
    this.ensureInit();
    if (!this.initialized) return { success: false, error: "Store not initialized" };

    const result = this.db.run(
      "UPDATE agent_memories SET priority = 60, updated_at = unixepoch() WHERE id = ? AND agent_id = ? AND priority >= 80",
      [id, agentId],
    );

    return result.changes > 0
      ? { success: true }
      : { success: false, error: `Memory #${id} not found, not owned, or not pinned` };
  }

  /** Run periodic priority decay on old unaccessed memories. */
  decayPriorities(agentId: string): number {
    this.ensureInit();
    if (!this.initialized) return 0;

    const result = this.db.run(
      `UPDATE agent_memories
       SET priority = MAX(0, priority - 5)
       WHERE agent_id = ? AND priority < 80 AND priority > 0
         AND last_accessed < unixepoch() - 604800
         AND access_count < 3`,
      [agentId],
    );

    return result.changes;
  }

  /**
   * Find consolidation candidates — groups of similar memories by category.
   * Returns pairs of (keepId, mergeIds) where mergeIds should be merged into keepId.
   * Phase 3: Used by memory plugin to trigger LLM-based consolidation.
   */
  findConsolidationCandidates(
    agentId: string,
    minCount = 400,
  ): { category: MemoryCategory; memories: AgentMemory[] }[] {
    this.ensureInit();
    if (!this.initialized) return [];

    const count = this.getCount(agentId);
    if (count < minCount) return [];

    const groups: { category: MemoryCategory; memories: AgentMemory[] }[] = [];

    for (const cat of VALID_CATEGORIES) {
      const rows = this.db
        .query(
          `SELECT * FROM agent_memories
           WHERE agent_id = ? AND category = ? AND priority < 80
           ORDER BY created_at ASC
           LIMIT 50`,
        )
        .all(agentId, cat) as any[];

      if (rows.length >= 5) {
        groups.push({ category: cat, memories: rows.map(rowToMemory) });
      }
    }

    return groups;
  }

  /**
   * Merge memories: replace multiple memories with a single consolidated one.
   * Preserves highest priority, max effectiveness, total access count, and most common channel.
   */
  mergeMemories(
    agentId: string,
    mergeIds: number[],
    mergedContent: string,
    category: MemoryCategory,
  ): { id: number | null } {
    this.ensureInit();
    if (!this.initialized || mergeIds.length === 0) return { id: null };

    const placeholders = mergeIds.map(() => "?").join(",");

    // Get aggregated stats from originals (only non-pinned)
    const stats = this.db
      .query(
        `SELECT MAX(priority) as maxPriority, SUM(access_count) as totalAccess,
                MAX(effectiveness) as maxEffectiveness
         FROM agent_memories WHERE id IN (${placeholders}) AND agent_id = ? AND priority < 80`,
      )
      .get(...mergeIds, agentId) as { maxPriority: number; totalAccess: number; maxEffectiveness: number } | null;

    if (!stats) return { id: null };

    // Determine most common channel
    const channelRow = this.db
      .query(
        `SELECT channel, COUNT(*) as cnt FROM agent_memories
         WHERE id IN (${placeholders}) AND agent_id = ? AND priority < 80
         GROUP BY channel ORDER BY cnt DESC LIMIT 1`,
      )
      .get(...mergeIds, agentId) as { channel: string | null } | null;

    // Delete originals (only non-pinned)
    this.db.run(`DELETE FROM agent_memories WHERE id IN (${placeholders}) AND agent_id = ? AND priority < 80`, [
      ...mergeIds,
      agentId,
    ]);

    // Insert consolidated memory preserving aggregated values
    const priority = Math.min(79, stats.maxPriority || 50);
    const effectiveness = stats.maxEffectiveness ?? 0.5;
    const tags = extractKeywords(mergedContent).slice(0, 5).join(",");
    const mergedChannel = channelRow?.channel ?? null;
    const stmt = this.db.prepare(`
      INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags, effectiveness, access_count)
      VALUES (?, ?, ?, ?, 'auto', ?, ?, ?, ?)
    `);
    const result = stmt.run(
      agentId,
      mergedChannel,
      category,
      mergedContent,
      priority,
      tags,
      effectiveness,
      stats.totalAccess || 0,
    );
    return { id: Number(result.lastInsertRowid) };
  }

  /**
   * Get specific memories by IDs without bumping access count.
   * Phase 4: Used for reflection — fetch injected memories without side effects.
   */
  getByIds(ids: number[], agentId: string): AgentMemory[] {
    this.ensureInit();
    if (!this.initialized || ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT * FROM agent_memories WHERE id IN (${placeholders}) AND agent_id = ?`)
      .all(...ids, agentId) as any[];

    return rows.map(rowToMemory);
  }

  /**
   * Update effectiveness scores for memories after reflection.
   * Phase 4: boosts critical memories, decays irrelevant ones.
   */
  updateEffectiveness(updates: { id: number; delta: number; priorityDelta?: number }[], agentId: string): number {
    this.ensureInit();
    if (!this.initialized || updates.length === 0) return 0;

    let changed = 0;
    for (const { id, delta, priorityDelta } of updates) {
      if (!Number.isFinite(delta)) continue;
      const safeDelta = Math.abs(delta);
      const params: (number | string)[] = [safeDelta];

      const effExpr = delta > 0 ? `MIN(1.0, effectiveness + ?)` : `MAX(0.0, effectiveness - ?)`;

      let priClause = "";
      if (priorityDelta && Number.isFinite(priorityDelta)) {
        const safePriDelta = Math.abs(priorityDelta);
        priClause =
          priorityDelta > 0
            ? `, priority = MIN(CASE WHEN priority >= 80 THEN 100 ELSE 79 END, priority + ?)`
            : `, priority = MAX(0, priority - ?)`;
        params.push(safePriDelta);
      }

      params.push(id, agentId);
      const sql = `UPDATE agent_memories SET effectiveness = ${effExpr}${priClause}, updated_at = unixepoch() WHERE id = ? AND agent_id = ? AND priority < 80`;
      const result = this.db.run(sql, params);
      changed += result.changes;
    }

    return changed;
  }

  /**
   * Get memory topic summary — list of categories and their counts/top keywords.
   * Phase 4: Used for memory hints injection (tells agent what it knows without full content).
   */
  getMemoryHints(agentId: string): string {
    this.ensureInit();
    if (!this.initialized) return "";

    const rows = this.db
      .query(
        `SELECT category, COUNT(*) as cnt, GROUP_CONCAT(DISTINCT tags) as allTags
         FROM agent_memories
         WHERE agent_id = ? AND tags != ''
         GROUP BY category
         ORDER BY cnt DESC`,
      )
      .all(agentId) as any[];

    if (rows.length === 0) return "";

    const hints: string[] = [];
    for (const row of rows) {
      // Extract unique top tags across all memories in this category
      const tagSet = new Set<string>();
      if (row.allTags) {
        for (const tag of row.allTags.split(",")) {
          const t = tag.trim();
          if (t && t.length > 1) tagSet.add(t);
        }
      }
      const topTags = [...tagSet].slice(0, 8).join(", ");
      hints.push(`${row.category} (${row.cnt}): ${topTags}`);
    }

    return hints.join("\n");
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
    priority: row.priority ?? 50,
    tags: row.tags ?? "",
    effectiveness: row.effectiveness ?? 0.5,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rank: row.rank,
  };
}
