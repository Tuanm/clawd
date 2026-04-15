/**
 * Migrations for skills cache (index.db)
 *
 * Uses "recreate-on-mismatch" strategy — the skills cache is ephemeral and
 * is rebuilt by scanning the filesystem, so it's safe to drop and recreate
 * all tables when the schema version changes.
 *
 * v1 — initial schema: skills + triggers
 * v2 — usage tracking: use_count, last_used_at, auto_generated
 * v3 — improvement tracking: improvement_count
 */

import type { Migration } from "../migrations";

export const skillsCacheMigrations: Migration[] = [
  {
    version: 1,
    description: "initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skills (
          name TEXT PRIMARY KEY,
          description TEXT,
          path TEXT,
          source TEXT DEFAULT 'global',
          tokens INTEGER,
          updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS triggers (
          skill_name TEXT,
          trigger TEXT,
          PRIMARY KEY (skill_name, trigger),
          FOREIGN KEY (skill_name) REFERENCES skills(name) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_triggers_trigger ON triggers(trigger);
      `);
    },
  },
  {
    version: 2,
    description: "usage tracking columns",
    up: (db) => {
      db.exec(`
        ALTER TABLE skills ADD COLUMN use_count INTEGER DEFAULT 0;
        ALTER TABLE skills ADD COLUMN last_used_at INTEGER DEFAULT NULL;
        ALTER TABLE skills ADD COLUMN auto_generated INTEGER DEFAULT 0;
      `);
    },
  },
  {
    version: 3,
    description: "add improvement_count for skill self-improvement loop",
    up: (db) => {
      try {
        db.exec("ALTER TABLE skills ADD COLUMN improvement_count INTEGER DEFAULT 0;");
      } catch (e) {
        if (!String(e instanceof Error ? e.message : e).includes("already has a column named")) {
          throw e;
        }
        // Column already exists — safe to continue
      }
    },
  },
];
