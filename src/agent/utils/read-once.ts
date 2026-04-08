/**
 * Read-Once Cache — Phase 4.2
 *
 * Caches file content for the duration of a session, busting only on
 * external modification. Eliminates redundant disk reads within a turn.
 *
 * Design decisions:
 * - Data structure: Map<string, ReadOnceEntry> — file path keyed by canonical
 *   absolute path. Not WeakMap (keys must be strings). Not SQLite (adds latency
 *   for in-process access; use knowledge-base for cross-session persistence).
 * - Change detection: contentHash (SHA-256) + mtime. Both must match for cache hit.
 *   Files without mtime (stdin, generated) rely on hash only.
 * - Semantic diff: NOT computed inline — doing full AST diff on every read is
 *   expensive. Instead, on cache bust, we mark the file "modified" in WorkingState
 *   so the agent notices the change via its existing trackFile() mechanism.
 *   The actual diff is only requested on-demand via knowledge_search.
 * - Memory: ~100KB/file × 200 cap ≈ 20MB per session. Well within limits.
 * - Thread safety: Bun runs single-threaded event loop — Map access is safe
 *   as long as we don't interleave reads and writes across await points.
 *   For concurrent tool calls, they serialize naturally through the event loop.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getContextSessionId } from "./agent-context";

// ── Types ──────────────────────────────────────────────────────────

export interface ReadOnceEntry {
  content: string;
  contentHash: string; // SHA-256 hex
  mtime: number | null; // file mtime-ms, null for non-file sources
  sizeBytes: number;
  cachedAt: number; // Date.now()
  readCount: number; // stats for cache tuning
}

// ── Cache ──────────────────────────────────────────────────────────

/**
 * Session-scoped read-once cache.
 *
 * Usage:
 *   const cache = new ReadOnceCache(sessionId);
 *   const content = await cache.read(path);
 */
export class ReadOnceCache {
  /** file path → entry */
  private entries = new Map<string, ReadOnceEntry>();

  /** Max entries before LRU eviction */
  private readonly maxEntries: number;

  /** Stats */
  private hits = 0;
  private misses = 0;
  private busts = 0;

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  /**
   * Read a file, using cache if content unchanged since last read.
   * Returns null if file does not exist.
   *
   * @param filePath  Absolute or project-root-relative path
   * @param projectRoot  Used to resolve relative paths
   */
  read(filePath: string, projectRoot?: string): ReadOnceResult | null {
    const resolved = this.resolvePath(filePath, projectRoot);
    if (!resolved) {
      // File doesn't exist — remove any stale entry
      this.entries.delete(resolved ?? filePath);
      return null;
    }

    // Check cache hit
    const existing = this.entries.get(resolved);
    if (existing) {
      // Fast path: mtime unchanged — avoids full content read
      if (existing.mtime !== null) {
        try {
          const stat = statSync(resolved); // stat syscall is cheap (kernel dentry cache hit)
          if (stat.mtimeMs === existing.mtime) {
            existing.readCount++;
            this.hits++;
            return {
              content: existing.content,
              fromCache: true,
              wasModified: false,
            };
          }
          // mtime changed — bust the cache
          this.busts++;
        } catch {
          // File deleted since last read — bust and fall through
          this.busts++;
        }
      } else {
        // No mtime (stdin/generated) — use hash-only check (requires disk read)
        const currentContent = this.readFileRaw(resolved);
        if (currentContent === null) {
          // File gone — bust
          this.busts++;
        } else {
          const currentHash = this.hashContent(currentContent);
          if (currentHash !== existing.contentHash) {
            // Content changed — bust
            this.busts++;
          } else {
            existing.readCount++;
            this.hits++;
            return {
              content: existing.content,
              fromCache: true,
              wasModified: false,
            };
          }
        }
      }
    }

    // Read from disk (miss or bust)
    const content = this.readFileRaw(resolved);
    if (content === null) {
      // File doesn't exist — remove stale entry if any
      this.entries.delete(resolved);
      return null;
    }

    const stat = statSync(resolved);
    const hash = this.hashContent(content);

    // Evict if at cap (LRU: evict all least-read entries to make room)
    while (this.entries.size >= this.maxEntries && this.entries.size > 0) {
      this.evictLRU();
    }

    this.entries.set(resolved, {
      content,
      contentHash: hash,
      mtime: stat.mtimeMs,
      sizeBytes: stat.size,
      cachedAt: Date.now(),
      readCount: 1,
    });

    this.misses++;
    return { content, fromCache: false, wasModified: existing !== undefined };
  }

  /**
   * Force cache invalidation for a specific file.
   * Call this when the agent itself writes to the file.
   */
  invalidate(filePath: string, projectRoot?: string): void {
    const resolved = this.resolvePath(filePath, projectRoot);
    if (resolved) this.entries.delete(resolved);
  }

  /**
   * Force cache invalidation for all files.
   * Call this on session reset or significant context switch.
   */
  invalidateAll(): void {
    this.entries.clear();
  }

  /**
   * Get stats for debugging/monitoring.
   */
  getStats(): ReadOnceCacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      busts: this.busts,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
    };
  }

  /**
   * Get all cached file paths (for debugging/invalidation).
   */
  getCachedPaths(): string[] {
    return [...this.entries.keys()];
  }

  // ── Private helpers ──────────────────────────────────────────────

  /** Resolve path to canonical absolute path. */
  private resolvePath(filePath: string, projectRoot?: string): string | null {
    // Absolute path — canonicalize symlinks
    if (filePath.startsWith("/")) {
      try {
        return realpathSync(filePath);
      } catch {
        return null; // doesn't exist
      }
    }

    // Relative path — resolve from projectRoot or cwd
    const base = projectRoot || process.cwd();
    try {
      return realpathSync(join(base, filePath));
    } catch {
      return null;
    }
  }

  /** Read file content, return null if doesn't exist. */
  private readFileRaw(path: string): string | null {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }

  /** SHA-256 hash of content (hex). */
  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /** LRU eviction: remove entry with lowest readCount. */
  private evictLRU(): void {
    let minCount = Infinity;
    let minKey: string | null = null;
    for (const [key, entry] of this.entries) {
      if (entry.readCount < minCount) {
        minCount = entry.readCount;
        minKey = key;
      }
    }
    if (minKey) this.entries.delete(minKey);
  }
}

// ── Result types ───────────────────────────────────────────────────

export interface ReadOnceResult {
  content: string;
  fromCache: boolean;
  wasModified: boolean; // true if entry existed but content changed (cache bust)
}

export interface ReadOnceCacheStats {
  entries: number;
  hits: number;
  misses: number;
  busts: number;
  hitRate: number;
}

// ── Standalone instance factory ────────────────────────────────────

/** Module-level cache map keyed by sessionId.
 *  Sessions are isolated; concurrent access within a session is safe (single-threaded).
 */
const sessionCaches = new Map<string, ReadOnceCache>();

export function getReadOnceCache(sessionId: string, maxEntries = 200): ReadOnceCache {
  let cache = sessionCaches.get(sessionId);
  if (!cache) {
    cache = new ReadOnceCache(maxEntries);
    sessionCaches.set(sessionId, cache);
  }
  return cache;
}

export function clearReadOnceCache(sessionId: string): void {
  sessionCaches.delete(sessionId);
}

/**
 * Bust the read-once cache for a file path.
 * Call this after any write operation to ensure the next view shows fresh content.
 */
export function bustReadOnceCache(filePath: string): void {
  const sessionId = getContextSessionId();
  if (sessionId) {
    try {
      const cache = sessionCaches.get(sessionId);
      if (cache) cache.invalidate(filePath);
    } catch {
      // Silently ignore errors — cache is non-critical
    }
  }
}
