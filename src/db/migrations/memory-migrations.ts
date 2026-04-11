/**
 * Migrations for memory.db
 *
 * v1 — base tables from all 4 source files:
 *       sessions + messages (session/manager.ts)
 *       knowledge + FTS (knowledge-base.ts)
 *       agent_memories + FTS (agent-memory.ts) — without the 3 extra columns
 *
 * v2 — add priority, tags, effectiveness columns to agent_memories
 *       (previously applied via inline try/catch in agent-memory.ts)
 *
 * v3 — add summarizer_checkpoints table for SessionSummarizer recovery
 *
 * v4 — LLM wiki layer: agent_wiki, wiki_memory_refs, agent_wiki_fts, wiki_pending_notes
 *
 * v5 — wiki index fixes:
 *       - uidx_aw_topic: drop + recreate as case-insensitive unique index on lower(topic)
 *       - aw_au trigger: add WHEN guard to prevent spurious FTS mutations on unrelated column updates
 *       - idx_aw_updated: covering index for getTOC ORDER BY updated_at DESC
 */

import type { Migration } from "../migrations";

export const memoryMigrations: Migration[] = [
  {
    version: 1,
    description: "base tables for sessions, knowledge, and agent_memories",
    up: (db) => {
      db.exec(`
        -- session/manager.ts tables
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          model TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          tool_calls TEXT,
          tool_call_id TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

        -- knowledge-base.ts tables
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

        -- agent-memory.ts base table (without the 3 extra columns added in v2)
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
    },
  },
  {
    version: 2,
    description: "add priority, tags, effectiveness columns to agent_memories",
    up: (db) => {
      // Add columns idempotently (try/catch for DBs that already have them)
      for (const sql of [
        "ALTER TABLE agent_memories ADD COLUMN priority INTEGER NOT NULL DEFAULT 50",
        "ALTER TABLE agent_memories ADD COLUMN tags TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE agent_memories ADD COLUMN effectiveness REAL NOT NULL DEFAULT 0.5",
      ]) {
        try {
          db.exec(sql);
        } catch (e: any) {
          if (!String(e?.message).includes("duplicate column")) throw e;
        }
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_am_priority ON agent_memories(agent_id, priority DESC)");
    },
  },
  {
    version: 3,
    description: "add summarizer_checkpoints table for SessionSummarizer recovery",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS summarizer_checkpoints (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          from_ts TEXT NOT NULL,
          to_ts TEXT NOT NULL,
          message_count INTEGER NOT NULL,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sc_session ON summarizer_checkpoints(session_id);
      `);
    },
  },
  {
    version: 4,
    description: "LLM wiki layer: agent_wiki, wiki_memory_refs, agent_wiki_fts, wiki_pending_notes",
    up: (db) => {
      db.exec(`
        -- agent_wiki: compiled wiki articles (always channel-scoped)
        CREATE TABLE IF NOT EXISTS agent_wiki (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id         TEXT    NOT NULL,
          channel          TEXT    NOT NULL,
          topic            TEXT    NOT NULL,
          summary          TEXT    NOT NULL,
          content          TEXT    NOT NULL
                             CHECK(length(content) BETWEEN 100 AND 4000),
          memory_ids       TEXT    NOT NULL DEFAULT '[]',
          source_count     INTEGER NOT NULL DEFAULT 0,
          version          INTEGER NOT NULL DEFAULT 1,
          created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
          last_compiled_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_aw_agent_channel ON agent_wiki(agent_id, channel);
        CREATE INDEX IF NOT EXISTS idx_aw_last_compiled ON agent_wiki(agent_id, channel, last_compiled_at);
        -- uidx_aw_topic replaced by case-insensitive uidx_aw_topic_lower (see migration v5)
        -- CREATE UNIQUE INDEX IF NOT EXISTS uidx_aw_topic ON agent_wiki(agent_id, channel, topic);
        CREATE INDEX IF NOT EXISTS idx_aw_topic_lower ON agent_wiki(agent_id, channel, lower(topic));
        CREATE UNIQUE INDEX IF NOT EXISTS uidx_aw_topic_lower ON agent_wiki(agent_id, channel, lower(topic));

        -- wiki_memory_refs: join table — source of truth for memory→article mapping
        CREATE TABLE IF NOT EXISTS wiki_memory_refs (
          wiki_id   INTEGER NOT NULL REFERENCES agent_wiki(id) ON DELETE CASCADE,
          memory_id INTEGER NOT NULL,
          added_at  INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (wiki_id, memory_id)
        );
        CREATE INDEX IF NOT EXISTS idx_wmr_memory ON wiki_memory_refs(memory_id);

        -- FTS5 virtual table for wiki topic + content search
        CREATE VIRTUAL TABLE IF NOT EXISTS agent_wiki_fts USING fts5(
          topic, content,
          content='agent_wiki',
          content_rowid='id',
          tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS aw_ai AFTER INSERT ON agent_wiki BEGIN
          INSERT INTO agent_wiki_fts(rowid, topic, content)
            VALUES (new.id, new.topic, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS aw_ad AFTER DELETE ON agent_wiki BEGIN
          INSERT INTO agent_wiki_fts(agent_wiki_fts, rowid, topic, content)
            VALUES ('delete', old.id, old.topic, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS aw_au AFTER UPDATE ON agent_wiki BEGIN
          INSERT INTO agent_wiki_fts(agent_wiki_fts, rowid, topic, content)
            VALUES ('delete', old.id, old.topic, old.content);
          INSERT INTO agent_wiki_fts(rowid, topic, content)
            VALUES (new.id, new.topic, new.content);
        END;

        -- wiki_pending_notes: staged write-back from wiki_note tool
        CREATE TABLE IF NOT EXISTS wiki_pending_notes (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id    TEXT    NOT NULL,
          channel     TEXT    NOT NULL,
          topic_hint  TEXT,
          content     TEXT    NOT NULL,
          priority    INTEGER NOT NULL DEFAULT 45,
          created_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_wpn_agent ON wiki_pending_notes(agent_id, channel, created_at);
      `);
    },
  },
  {
    version: 5,
    description: "wiki index fixes: case-insensitive topic index, aw_au WHEN guard, getTOC covering index",
    up: (db) => {
      db.exec(`
        -- Dedup existing rows with case-variant topics before creating unique index
        DELETE FROM agent_wiki WHERE id NOT IN (
          SELECT MIN(id) FROM agent_wiki GROUP BY agent_id, channel, lower(topic)
        );

        -- Fix uidx_aw_topic: make unique index case-insensitive (was case-sensitive)
        DROP INDEX IF EXISTS uidx_aw_topic;
        DROP INDEX IF EXISTS uidx_aw_topic_lower;
        DROP INDEX IF EXISTS idx_aw_topic_lower;
        CREATE UNIQUE INDEX uidx_aw_topic ON agent_wiki(agent_id, channel, lower(topic));

        -- Fix aw_au trigger: add WHEN guard to prevent spurious FTS mutations
        -- when unrelated columns (e.g. memory_ids, source_count) are updated
        DROP TRIGGER IF EXISTS aw_au;
        CREATE TRIGGER aw_au AFTER UPDATE ON agent_wiki
        WHEN old.topic IS NOT new.topic OR old.content IS NOT new.content
        BEGIN
          INSERT INTO agent_wiki_fts(agent_wiki_fts, rowid, topic, content)
            VALUES ('delete', old.id, old.topic, old.content);
          INSERT INTO agent_wiki_fts(rowid, topic, content)
            VALUES (new.id, new.topic, new.content);
        END;

        -- Covering index for getTOC ORDER BY updated_at DESC
        CREATE INDEX IF NOT EXISTS idx_aw_updated ON agent_wiki(agent_id, channel, updated_at DESC);
      `);
    },
  },
];
