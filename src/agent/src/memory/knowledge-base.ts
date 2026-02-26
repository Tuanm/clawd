/**
 * Knowledge Base — FTS5-powered session knowledge index
 * Phase 3.1: Indexes large tool outputs for retrieval via knowledge_search
 */

import Database from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────

export interface KBEntry {
  sessionId: string;
  sourceId: string;
  toolName: string;
  chunkIndex: number;
  content: string;
  createdAt: number;
}

export interface KBSearchResult {
  sourceId: string;
  toolName: string;
  chunkIndex: number;
  content: string;
  rank: number;
}

// ── Constants ──────────────────────────────────────────────────────

const SESSION_LIMIT_BYTES = 100 * 1024 * 1024; // 100MB per session
const GLOBAL_LIMIT_BYTES = 2 * 1024 * 1024 * 1024; // 2GB global
const GLOBAL_WARN_RATIO = 0.8;
const BASE64_PATTERN = /[A-Za-z0-9+/=]{500,}/g;
const CHUNK_LINE_COUNT = 20;
const CHUNK_OVERLAP = 5;

// ── Knowledge Base ─────────────────────────────────────────────────

export class KnowledgeBase {
  private db: Database;
  private initialized = false;
  private sessionSizes = new Map<string, number>();

  constructor(dbPath?: string) {
    const defaultPath = join(homedir(), ".clawd", "memory.db");
    this.db = new Database(dbPath || defaultPath);
    // Use existing PRAGMAs — memory.db already has WAL, cache, etc.
  }

  /** Lazy init — only create tables on first use */
  private ensureInit(): void {
    if (this.initialized) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          chunk_index INTEGER NOT NULL DEFAULT 0,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_session ON knowledge(session_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(source_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
          content,
          content='knowledge',
          content_rowid='id',
          tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
          INSERT INTO knowledge_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
          INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
          INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES('delete', old.id, old.content);
          INSERT INTO knowledge_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `);
      this.initialized = true;
    } catch (err) {
      console.error("[KnowledgeBase] Init failed:", err);
    }
  }

  /** Index content into knowledge base, chunking as needed */
  index(sessionId: string, sourceId: string, toolName: string, content: string): boolean {
    try {
      this.ensureInit();
      if (!this.initialized) return false;

      // Strip base64 before indexing (C8)
      const cleaned = content.replace(BASE64_PATTERN, "[base64 stripped]");
      if (cleaned.length < 50) return false;

      // Check session size limit
      const currentSize = this.getSessionSize(sessionId);
      if (currentSize + cleaned.length > SESSION_LIMIT_BYTES) {
        this.evictOldest(sessionId, cleaned.length);
      }

      // Check global limit
      this.checkGlobalLimit();

      // Invalidate existing entries for this source (and reset cache to get accurate size)
      this.invalidateSource(sessionId, sourceId);
      this.sessionSizes.delete(sessionId);
      const freshSize = this.getSessionSize(sessionId);

      // Chunk and insert
      const chunks = chunkContent(cleaned, toolName);
      const insert = this.db.prepare(
        "INSERT INTO knowledge (session_id, source_id, tool_name, chunk_index, content) VALUES (?, ?, ?, ?, ?)",
      );
      const runAll = this.db.transaction(() => {
        for (let i = 0; i < chunks.length; i++) {
          insert.run(sessionId, sourceId, toolName, i, chunks[i]);
        }
      });
      runAll();

      // Update cached session size
      this.sessionSizes.set(sessionId, freshSize + cleaned.length);
      return true;
    } catch (err) {
      console.error("[KnowledgeBase] Index failed:", err);
      return false;
    }
  }

  /** BM25 search with substring fallback */
  search(query: string, sessionId?: string, limit = 10): KBSearchResult[] {
    try {
      this.ensureInit();
      if (!this.initialized) return [];

      // BM25 search
      const ftsQuery = query
        .replace(/['"]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 1)
        .map((w) => `"${w}"`)
        .join(" OR ");

      if (!ftsQuery) return [];

      let results = this.searchFTS(ftsQuery, sessionId, limit);

      // Substring fallback if BM25 returns nothing
      if (results.length === 0) {
        results = this.searchSubstring(query, sessionId, limit);
      }

      return results;
    } catch (err) {
      console.error("[KnowledgeBase] Search failed:", err);
      return [];
    }
  }

  private searchFTS(ftsQuery: string, sessionId?: string, limit = 10): KBSearchResult[] {
    const sessionFilter = sessionId ? "AND k.session_id = ?" : "";
    const params: any[] = [ftsQuery];
    if (sessionId) params.push(sessionId);
    params.push(limit);

    const sql = `
      SELECT k.source_id AS sourceId, k.tool_name AS toolName, k.chunk_index AS chunkIndex, k.content,
             rank AS rank
      FROM knowledge_fts f
      JOIN knowledge k ON k.id = f.rowid
      WHERE knowledge_fts MATCH ?
      ${sessionFilter}
      ORDER BY rank
      LIMIT ?
    `;
    return this.db.query(sql).all(...params) as KBSearchResult[];
  }

  private searchSubstring(query: string, sessionId?: string, limit = 10): KBSearchResult[] {
    const sessionFilter = sessionId ? "AND session_id = ?" : "";
    // Escape SQL LIKE wildcards
    const escapedQuery = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
    const params: any[] = [`%${escapedQuery}%`];
    if (sessionId) params.push(sessionId);
    params.push(limit);

    const sql = `
      SELECT source_id AS sourceId, tool_name AS toolName, chunk_index AS chunkIndex, content, 0 as rank
      FROM knowledge
      WHERE content LIKE ? ESCAPE '\\'
      ${sessionFilter}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    return this.db.query(sql).all(...params) as KBSearchResult[];
  }

  /** Invalidate entries for a specific source (file path) */
  invalidateSource(sessionId: string, sourceId: string): void {
    try {
      this.ensureInit();
      if (!this.initialized) return;
      this.db.run("DELETE FROM knowledge WHERE session_id = ? AND source_id = ?", [sessionId, sourceId]);
    } catch {}
  }

  /** Invalidate all entries for a session */
  invalidateSession(sessionId: string): void {
    try {
      this.ensureInit();
      if (!this.initialized) return;
      this.db.run("DELETE FROM knowledge WHERE session_id = ?", [sessionId]);
      this.sessionSizes.delete(sessionId);
    } catch {}
  }

  /** Get stats for a session */
  getStats(sessionId: string): { entries: number; totalChars: number; sources: number } {
    try {
      this.ensureInit();
      if (!this.initialized) return { entries: 0, totalChars: 0, sources: 0 };
      const row = this.db
        .query(
          "SELECT COUNT(*) as entries, COALESCE(SUM(length(content)), 0) as totalChars, COUNT(DISTINCT source_id) as sources FROM knowledge WHERE session_id = ?",
        )
        .get(sessionId) as any;
      return row || { entries: 0, totalChars: 0, sources: 0 };
    } catch {
      return { entries: 0, totalChars: 0, sources: 0 };
    }
  }

  /** Clean up session data */
  cleanup(sessionId: string): void {
    this.invalidateSession(sessionId);
  }

  /** Run FTS5 optimize */
  optimize(): void {
    try {
      this.ensureInit();
      if (!this.initialized) return;
      this.db.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('optimize')");
    } catch {}
  }

  destroy(): void {
    try {
      this.db.close();
    } catch {}
  }

  private getSessionSize(sessionId: string): number {
    if (this.sessionSizes.has(sessionId)) return this.sessionSizes.get(sessionId)!;
    try {
      const row = this.db
        .query("SELECT COALESCE(SUM(length(content)), 0) as total FROM knowledge WHERE session_id = ?")
        .get(sessionId) as any;
      const size = row?.total || 0;
      this.sessionSizes.set(sessionId, size);
      return size;
    } catch {
      return 0;
    }
  }

  private evictOldest(sessionId: string, needed: number): void {
    try {
      // Delete oldest entries for this session until we have space
      const rows = this.db
        .query("SELECT id, length(content) as size FROM knowledge WHERE session_id = ? ORDER BY created_at ASC")
        .all(sessionId) as { id: number; size: number }[];

      let freed = 0;
      const toDelete: number[] = [];
      for (const row of rows) {
        if (freed >= needed) break;
        toDelete.push(row.id);
        freed += row.size;
      }

      if (toDelete.length > 0) {
        this.db.run(`DELETE FROM knowledge WHERE id IN (${toDelete.join(",")})`);
        const current = this.sessionSizes.get(sessionId) || 0;
        this.sessionSizes.set(sessionId, Math.max(0, current - freed));
      }
    } catch {}
  }

  private checkGlobalLimit(): void {
    try {
      let total = this.getGlobalSize();

      if (total > GLOBAL_LIMIT_BYTES) {
        // Loop eviction until under limit
        let attempts = 0;
        while (total > GLOBAL_LIMIT_BYTES && attempts < 20) {
          const sessions = this.db
            .query(
              "SELECT session_id, MIN(created_at) as oldest FROM knowledge GROUP BY session_id ORDER BY oldest ASC LIMIT 5",
            )
            .all() as { session_id: string }[];
          if (sessions.length === 0) break;
          for (const s of sessions) {
            this.invalidateSession(s.session_id);
          }
          total = this.getGlobalSize();
          attempts++;
        }
      } else if (total > GLOBAL_LIMIT_BYTES * GLOBAL_WARN_RATIO) {
        console.warn(`[KnowledgeBase] Global storage at ${Math.round((total / GLOBAL_LIMIT_BYTES) * 100)}% capacity`);
      }
    } catch {}
  }

  private getGlobalSize(): number {
    try {
      const row = this.db.query("SELECT COALESCE(SUM(length(content)), 0) as total FROM knowledge").get() as any;
      return row?.total || 0;
    } catch {
      return 0;
    }
  }
}

// ── Chunking ───────────────────────────────────────────────────────

export function chunkContent(content: string, toolName: string): string[] {
  if (content.length < 500) return [content];

  const lines = content.split("\n");

  // Detect content type
  const hasMarkdownHeadings = /^#{1,6}\s/m.test(content);
  const codeBlockRatio = (content.match(/```/g)?.length || 0) / Math.max(1, lines.length / 20);

  if (hasMarkdownHeadings && codeBlockRatio < 0.5) {
    return chunkByHeadings(lines);
  }
  return chunkByLines(lines);
}

function chunkByHeadings(lines: string[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join("\n"));

  return chunks.filter((c) => c.trim().length > 0);
}

function chunkByLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let inCodeBlock = false;
  let current: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) inCodeBlock = !inCodeBlock;
    current.push(line);

    // Chunk at CHUNK_LINE_COUNT lines, but never inside a code block
    if (current.length >= CHUNK_LINE_COUNT && !inCodeBlock) {
      chunks.push(current.join("\n"));
      // Overlap: keep last CHUNK_OVERLAP lines, but skip if they contain unbalanced fences
      const overlap = current.slice(-CHUNK_OVERLAP);
      const fenceCount = overlap.filter((l) => l.startsWith("```")).length;
      current = fenceCount % 2 === 0 ? overlap : [];
    }
  }

  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks.filter((c) => c.trim().length > 0);
}

// ── Singleton ──────────────────────────────────────────────────────

let _instance: KnowledgeBase | null = null;

export function getKnowledgeBase(dbPath?: string): KnowledgeBase {
  if (!_instance) {
    _instance = new KnowledgeBase(dbPath);
  }
  return _instance;
}
