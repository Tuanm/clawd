/**
 * Migrations for scheduler.db
 *
 * v1 — initial schema: scheduled_jobs + job_runs (ports migrateSchedulerSchema()
 *       from scheduler/db.ts; manual BEGIN/COMMIT stripped — wrapped by runMigrations)
 */

import type { Migration } from "../migrations";

export const schedulerMigrations: Migration[] = [
  {
    version: 1,
    description: "initial schema with tool_call job type",
    up: (db) => {
      // Create tables with the current (post-migration) schema that includes
      // tool_name, tool_args_json and the 'tool_call' CHECK value.
      db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_jobs (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          created_by_agent TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('once','interval','cron','reminder','tool_call')),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active','paused','completed','failed','cancelled')),
          cron_expr TEXT,
          interval_ms INTEGER,
          run_at INTEGER,
          next_run INTEGER NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          timeout_seconds INTEGER DEFAULT 300,
          max_runs INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          last_run_at INTEGER,
          run_count INTEGER DEFAULT 0,
          consecutive_errors INTEGER DEFAULT 0,
          last_error TEXT,
          tool_name TEXT,
          tool_args_json TEXT
        );

        CREATE TABLE IF NOT EXISTS job_runs (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          status TEXT NOT NULL CHECK(status IN ('running','success','error','timeout')),
          error_message TEXT,
          output_summary TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_next_run
          ON scheduled_jobs(next_run) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_jobs_channel
          ON scheduled_jobs(channel);
        CREATE INDEX IF NOT EXISTS idx_runs_job
          ON job_runs(job_id, started_at);
      `);
    },
  },
];
