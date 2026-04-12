/**
 * Database Factory
 *
 * Centralised helper for creating SQLite databases with standard PRAGMAs.
 * Extracted from the duplicated inline PRAGMA blocks in:
 *   src/server/database.ts, src/agent/session/manager.ts,
 *   src/agent/memory/agent-memory.ts, src/agent/memory/memory.ts
 *
 * Use ":memory:" for ephemeral in-memory databases (tests, caches).
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getDataDir, isContainerEnv } from "../config/config-file";

export interface CreateDatabaseOptions {
  /** busy_timeout in ms (default: 30000). database.ts uses 5000; agent files use 30000. */
  busyTimeout?: number;
  /** Enable PRAGMA foreign_keys = ON (default: true). Required by agent-memory.ts and skills/manager.ts. */
  foreignKeys?: boolean;
  /** Enable bun:sqlite strict mode — .get() throws on no result (default: false). Only database.ts uses this. */
  strict?: boolean;
}

/**
 * Apply the standard set of PRAGMAs used across all Claw'd SQLite databases.
 *
 * - busy_timeout 30 s     — prevents SQLITE_BUSY errors on concurrent access (agent default)
 * - journal_mode WAL      — better concurrent read/write (no-op on :memory:)
 * - synchronous NORMAL    — safe durability without fsync on every write
 * - foreign_keys ON       — enforce FK constraints (required by agent-memory, skills)
 * - cache_size            — 8 MB in containers, 64 MB on desktop
 * - temp_store MEMORY     — faster temp tables
 * - mmap_size             — 256 MB on desktop, disabled in containers
 */
export function applyPragmas(db: Database, options?: Pick<CreateDatabaseOptions, "busyTimeout" | "foreignKeys">): void {
  const busyTimeout = options?.busyTimeout ?? 30000;
  const foreignKeys = options?.foreignKeys ?? true;

  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(Number(busyTimeout)))}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  if (foreignKeys) {
    db.exec("PRAGMA foreign_keys = ON");
  }
  const container = isContainerEnv();
  db.exec(`PRAGMA cache_size = -${container ? 8000 : 64000}`);
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec(`PRAGMA mmap_size = ${container ? 0 : 268435456}`);
}

/**
 * Create a new SQLite database with standard PRAGMAs applied.
 *
 * @param path     File path or ":memory:" (default: ":memory:")
 * @param options  Override defaults for busyTimeout, foreignKeys, strict mode
 */
export function createDatabase(path = ":memory:", options?: CreateDatabaseOptions): Database {
  const db = new Database(path, { strict: options?.strict ?? false });
  try {
    applyPragmas(db, options);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// ---------------------------------------------------------------------------
// Shared lazy singletons
// ---------------------------------------------------------------------------

let _memoryDb: Database | null = null;

/**
 * Lazy read-only connection to memory.db.
 * Used by routes/agents.ts (agent thoughts API) and index.ts.
 * Opens the file in readonly mode with WAL + 5s busy_timeout.
 */
export function getMemoryDb(): Database {
  if (!_memoryDb) {
    const memPath = join(getDataDir(), "memory.db");
    _memoryDb = new Database(memPath, { readonly: true });
    _memoryDb.exec("PRAGMA journal_mode = WAL");
    _memoryDb.exec("PRAGMA busy_timeout = 5000");
  }
  return _memoryDb;
}
