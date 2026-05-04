/**
 * SQLite Migration Runner
 *
 * Provides a simple versioned migration system using PRAGMA user_version.
 * Each database maintains its own version counter. Migrations run atomically
 * inside db.transaction() so a partial migration never leaves the DB corrupt.
 */

import type { Database } from "bun:sqlite";

export interface Migration {
  version: number;
  description: string;
  up: (db: Database) => void;
  /** If true, disable PRAGMA foreign_keys around this migration's transaction.
   *  Required for table-recreate migrations (DROP/RENAME on a parent table) when
   *  child rows exist, since SQLite enforces FK on DROP. PRAGMA foreign_keys
   *  cannot be toggled inside a transaction (silent no-op), so the toggle must
   *  wrap the runner's transaction — hence this flag. */
  requiresFkOff?: boolean;
}

export type MigrationStrategy = "versioned" | "recreate-on-mismatch";

/**
 * Run all pending migrations against the given database.
 *
 * Strategy "versioned" (default): only runs migrations whose version is
 * greater than the current PRAGMA user_version, then bumps the version.
 *
 * Strategy "recreate-on-mismatch": if current version < target version,
 * drops all tables first (cache-style DBs where data is ephemeral).
 */
export function runMigrations(db: Database, migrations: Migration[], strategy: MigrationStrategy = "versioned"): void {
  if (migrations.length === 0) return;

  const targetVersion = Math.max(...migrations.map((m) => m.version));

  if (strategy === "recreate-on-mismatch") {
    const currentVersion = (db.query("PRAGMA user_version").get() as any).user_version as number;
    if (currentVersion < targetVersion) {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      for (const { name } of tables) {
        db.exec(`DROP TABLE IF EXISTS "${name}"`);
      }
      db.exec("PRAGMA user_version = 0");
    }
  }

  const currentVersion = (db.query("PRAGMA user_version").get() as any).user_version as number;

  const pending = migrations.filter((m) => m.version > currentVersion).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    if (migration.requiresFkOff) {
      // PRAGMA foreign_keys must toggle outside any transaction (SQLite silently
      // no-ops inside one). Disable, run inside transaction, then re-enable.
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        db.transaction(() => {
          migration.up(db);
          db.exec(`PRAGMA user_version = ${migration.version}`);
        })();
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
    } else {
      db.transaction(() => {
        migration.up(db);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      })();
    }
  }
}
