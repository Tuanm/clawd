/**
 * Migrations for chat.db
 *
 * ⚠️  Version numbering: chat-migrations uses versions 1–49 and 51+.
 * agents-migrations.ts (also applied to chat.db) uses versions 50–50.
 * Both share PRAGMA user_version on chat.db — never reuse a version number.
 *
 * v1  — initial schema: users, channels, messages, files, agent_seen, summaries,
 *        agent_status, agents, message_seen, articles, copilot_calls,
 *        artifact_actions, spaces (consolidated from initDatabase() in database.ts)
 * v51 — trajectories table for RL training data (skipped v2 because existing DBs
 *        had user_version=50 from agents-migrations, which would skip v2)
 */

import type { Migration } from "../migrations";

export const chatMigrations: Migration[] = [
  {
    version: 1,
    description: "initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          avatar_url TEXT,
          is_bot INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );

        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          name TEXT,
          created_by TEXT REFERENCES users(id),
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );

        CREATE TABLE IF NOT EXISTS messages (
          ts TEXT PRIMARY KEY,
          channel TEXT REFERENCES channels(id),
          thread_ts TEXT,
          user TEXT REFERENCES users(id),
          text TEXT,
          subtype TEXT,
          html_preview TEXT,
          code_preview_json TEXT,
          article_json TEXT,
          edited_at INTEGER,
          files_json TEXT DEFAULT '[]',
          reactions_json TEXT DEFAULT '{}',
          agent_id TEXT,
          mentions_json TEXT DEFAULT '[]',
          subspace_json TEXT,
          workspace_json TEXT,
          tool_result_json TEXT,
          interactive_json TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );

        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
        CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel, ts DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_ts);

        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          name TEXT,
          mimetype TEXT,
          size INTEGER,
          path TEXT,
          public INTEGER NOT NULL DEFAULT 0,
          message_ts TEXT REFERENCES messages(ts),
          uploaded_by TEXT REFERENCES users(id),
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_files_message ON files(message_ts);

        CREATE TABLE IF NOT EXISTS agent_seen (
          agent_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          last_seen_ts TEXT NOT NULL,
          last_processed_ts TEXT,
          last_poll_ts INTEGER,
          updated_at INTEGER DEFAULT (strftime('%s', 'now')),
          PRIMARY KEY (agent_id, channel)
        );

        CREATE TABLE IF NOT EXISTS summaries (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          from_ts TEXT NOT NULL,
          to_ts TEXT NOT NULL,
          message_count INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_summaries_channel ON summaries(channel);
        CREATE INDEX IF NOT EXISTS idx_summaries_agent ON summaries(agent_id);

        CREATE TABLE IF NOT EXISTS agent_status (
          agent_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ready',
          hibernate_until TEXT,
          updated_at INTEGER DEFAULT (strftime('%s', 'now')),
          PRIMARY KEY (agent_id, channel)
        );

        CREATE TABLE IF NOT EXISTS agents (
          id TEXT NOT NULL,
          channel TEXT NOT NULL,
          avatar_color TEXT NOT NULL,
          display_name TEXT,
          is_worker INTEGER DEFAULT 0,
          is_sleeping INTEGER DEFAULT 0,
          is_streaming INTEGER DEFAULT 0,
          streaming_started_at INTEGER DEFAULT NULL,
          joined_at INTEGER DEFAULT (strftime('%s', 'now')),
          PRIMARY KEY (id, channel)
        );
        CREATE INDEX IF NOT EXISTS idx_agents_channel ON agents(channel);

        CREATE TABLE IF NOT EXISTS message_seen (
          message_ts TEXT NOT NULL,
          channel TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          seen_at INTEGER DEFAULT (strftime('%s', 'now')),
          PRIMARY KEY (message_ts, channel, agent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_message_seen_ts ON message_seen(message_ts);

        CREATE TABLE IF NOT EXISTS articles (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          author TEXT,
          title TEXT NOT NULL,
          description TEXT,
          thumbnail_url TEXT,
          content TEXT NOT NULL,
          tags_json TEXT DEFAULT '[]',
          published INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_articles_channel ON articles(channel);
        CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published);

        CREATE TABLE IF NOT EXISTS copilot_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          key_fingerprint TEXT NOT NULL,
          model TEXT NOT NULL,
          initiator TEXT NOT NULL,
          status TEXT NOT NULL,
          latency_ms INTEGER,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          premium_cost REAL NOT NULL DEFAULT 0,
          agent_id TEXT,
          channel TEXT,
          error_msg TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_copilot_calls_ts ON copilot_calls(ts DESC);
        CREATE INDEX IF NOT EXISTS idx_copilot_calls_channel ON copilot_calls(channel);
        CREATE INDEX IF NOT EXISTS idx_copilot_calls_model ON copilot_calls(model);
        CREATE INDEX IF NOT EXISTS idx_copilot_calls_status ON copilot_calls(status);
        CREATE INDEX IF NOT EXISTS idx_copilot_calls_key ON copilot_calls(key_fingerprint);

        CREATE TABLE IF NOT EXISTS artifact_actions (
          id TEXT PRIMARY KEY,
          message_ts TEXT NOT NULL,
          channel TEXT NOT NULL,
          action_id TEXT NOT NULL,
          value TEXT,
          value_hash TEXT,
          user TEXT NOT NULL,
          handler TEXT NOT NULL,
          handler_config TEXT,
          status TEXT DEFAULT 'completed',
          result TEXT,
          depth INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_actions_message ON artifact_actions(message_ts);
        CREATE INDEX IF NOT EXISTS idx_artifact_actions_channel ON artifact_actions(channel, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_actions_idempotent
          ON artifact_actions(message_ts, action_id, user, value_hash);

        CREATE TABLE IF NOT EXISTS spaces (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          space_channel TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          description TEXT,
          agent_id TEXT NOT NULL,
          agent_color TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active','completed','failed','timed_out')),
          source TEXT NOT NULL,
          source_id TEXT,
          card_message_ts TEXT,
          timeout_seconds INTEGER NOT NULL DEFAULT 300,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          result_summary TEXT,
          locked INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_spaces_channel ON spaces(channel);
        CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_active_source
          ON spaces(source_id) WHERE status='active' AND source='scheduler';

        INSERT OR IGNORE INTO users (id, name, is_bot) VALUES ('UBOT', 'Copilot Agent', 1);
        INSERT OR IGNORE INTO users (id, name, is_bot) VALUES ('UHUMAN', 'User', 0);
        INSERT OR IGNORE INTO channels (id, name, created_by) VALUES ('general', 'general', 'UHUMAN');
      `);
    },
  },
  {
    version: 51,
    description: "trajectories table for RL training data",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS trajectories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          turn_index INTEGER NOT NULL,
          user_message TEXT,
          tool_calls_json TEXT,
          assistant_response TEXT,
          reward INTEGER DEFAULT NULL,
          created_at INTEGER DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_trajectories_channel ON trajectories(channel);
        CREATE INDEX IF NOT EXISTS idx_trajectories_agent ON trajectories(agent_id, channel);
        CREATE INDEX IF NOT EXISTS idx_trajectories_created ON trajectories(created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_trajectories_session_turn ON trajectories(session_id, turn_index);
      `);
    },
  },
];
