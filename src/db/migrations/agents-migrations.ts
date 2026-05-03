/**
 * Migrations for channel_agents table (used by chat.db via api/agents.ts)
 *
 * Extracted from the inline ALTER TABLE calls inside initAgentsTable() in
 * src/api/agents.ts. Tracking via PRAGMA user_version replaces the
 * try/catch-per-column pattern.
 *
 * ⚠️  Version numbering: these migrations share PRAGMA user_version with
 * chat-migrations.ts on the same chat.db. chat-migrations.ts uses versions
 * 1–49. Agents migrations start at 50 to avoid conflicts. Keep this range
 * in sync when adding new migrations to either file.
 *
 * v50 — full channel_agents schema: creates the table with all current columns
 *       and applies backward-compat ADD COLUMN calls for pre-existing DBs.
 * v51 — partial unique index on claude_code_session_id (defensive): two agents
 *       must never share the same CC SDK session UUID. Resume by sessionId
 *       would otherwise let one agent clobber another's session file at
 *       ~/.claude/projects/<cwd>/<sessionId>.jsonl.
 */

import type { Migration } from "../migrations";

export const agentsMigrations: Migration[] = [
  {
    version: 50,
    description: "channel_agents full schema",
    up: (db) => {
      // Create table with all columns for fresh installs
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_agents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'copilot',
          model TEXT NOT NULL DEFAULT 'default',
          project TEXT NOT NULL DEFAULT '',
          active INTEGER NOT NULL DEFAULT 1,
          sleeping INTEGER NOT NULL DEFAULT 0,
          worker_token TEXT DEFAULT NULL,
          heartbeat_interval INTEGER NOT NULL DEFAULT 0,
          worktree_path TEXT DEFAULT NULL,
          worktree_branch TEXT DEFAULT NULL,
          claude_code_session_id TEXT DEFAULT NULL,
          agent_type TEXT DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%s', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%s', 'now')),
          UNIQUE(channel, agent_id)
        )
      `);

      // Backward-compat: add columns for DBs created before this migration
      // system was in place (pre-existing installations).
      const addCol = (sql: string) => {
        try {
          db.exec(sql);
        } catch {
          // Column already exists — safe to ignore
        }
      };

      addCol(`ALTER TABLE channel_agents ADD COLUMN project TEXT NOT NULL DEFAULT ''`);
      addCol(`ALTER TABLE channel_agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'copilot'`);
      addCol(`ALTER TABLE channel_agents ADD COLUMN sleeping INTEGER NOT NULL DEFAULT 0`);
      addCol(`ALTER TABLE channel_agents ADD COLUMN worker_token TEXT DEFAULT NULL`);
      addCol(`ALTER TABLE channel_agents ADD COLUMN heartbeat_interval INTEGER NOT NULL DEFAULT 0`);
      addCol(`ALTER TABLE channel_agents ADD COLUMN worktree_path TEXT DEFAULT NULL`);
      addCol(`ALTER TABLE channel_agents ADD COLUMN worktree_branch TEXT DEFAULT NULL`);
      addCol(`ALTER TABLE channel_agents ADD COLUMN claude_code_session_id TEXT DEFAULT NULL`);
      addCol(`ALTER TABLE channel_agents ADD COLUMN agent_type TEXT DEFAULT NULL`);
    },
  },
  {
    version: 51,
    description: "partial unique index on claude_code_session_id",
    up: (db) => {
      // Pre-flight: NULL out duplicates before the unique index is created.
      // Without this, a legacy DB where two agents historically shared a
      // session_id (possible before persistSessionId got its `stopped` guard)
      // would fail CREATE UNIQUE INDEX, the migration tx rolls back, and the
      // server refuses to start. Keep the row with the largest id (most recent
      // PATCH); NULL the rest. Losing the session_id only forces a fresh CC
      // session on next turn — no data loss, only history-bridging cost.
      const dupCount = (
        db
          .query<{ c: number }, []>(
            `SELECT COUNT(*) AS c FROM (
               SELECT claude_code_session_id FROM channel_agents
               WHERE claude_code_session_id IS NOT NULL
               GROUP BY claude_code_session_id HAVING COUNT(*) > 1
             )`,
          )
          .get() ?? { c: 0 }
      ).c;
      if (dupCount > 0) {
        console.warn(
          `[migration v51] found ${dupCount} duplicate claude_code_session_id group(s); NULLing older rows before creating unique index`,
        );
        db.exec(`
          UPDATE channel_agents SET claude_code_session_id = NULL
          WHERE id NOT IN (
            SELECT MAX(id) FROM channel_agents
            WHERE claude_code_session_id IS NOT NULL
            GROUP BY claude_code_session_id
          ) AND claude_code_session_id IS NOT NULL
        `);
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_agents_cc_session
        ON channel_agents(claude_code_session_id)
        WHERE claude_code_session_id IS NOT NULL
      `);
    },
  },
];
