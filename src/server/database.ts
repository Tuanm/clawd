import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../config/config-file";
import { createDatabase } from "../db/factory";
import { runMigrations } from "../db/migrations";
import { chatMigrations } from "../db/migrations/chat-migrations";

const DATA_DIR = getDataDir();
const DB_PATH = join(DATA_DIR, "chat.db");
const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

export { ATTACHMENTS_DIR };

// ============================================================================
// Lazy DB Singleton — prevents side effects at module import time
// ============================================================================

let _db: Database | null = null;

/**
 * Returns the singleton Database instance, creating it on first call.
 * All 6 PRAGMA calls and schema initialisation run exactly once here.
 */
export function getDb(): Database {
  if (!_db) {
    // Ensure directories exist (deferred to first use)
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!existsSync(ATTACHMENTS_DIR)) {
      mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    }

    // Stage in a local variable so _db is never set to a partially-initialised
    // instance.  We commit to _db only after PRAGMAs succeed so that the Proxy
    // resolves correctly when initDatabase() calls back through it, then roll
    // back on any error so the next caller can retry cleanly.
    // createDatabase applies: busy_timeout(5s), WAL, synchronous NORMAL,
    // cache_size, temp_store MEMORY, mmap_size (all container-aware)
    const newDb = createDatabase(DB_PATH, { busyTimeout: 5000, foreignKeys: false, strict: true });

    // Commit before initDatabase() so the Proxy resolves to newDb when
    // initDatabase() calls back through db.exec() / db.prepare().
    _db = newDb;

    try {
      // Initialize tables BEFORE preparing statements (tables must exist for db.prepare)
      initDatabase();
    } catch (err) {
      // Roll back: reset _db so the next call can attempt init again.
      _db = null;
      newDb.close();
      throw err;
    }
  }
  return _db;
}

/**
 * Backward-compatible proxy export.
 * Existing consumers that do `import { db } from "./database"` continue to work
 * unchanged — every property access transparently calls getDb() on first use.
 */
export const db = new Proxy({} as Database, {
  get(_target, prop) {
    // Bind methods to the real instance so native private fields resolve
    // correctly.  Bun's Database is a native class — calling db.exec() with
    // `this = Proxy` would throw a private-field TypeError without this bind.
    const instance = getDb();
    const val = (instance as any)[prop];
    return typeof val === "function" ? val.bind(instance) : val;
  },
  set(_target, prop, value) {
    (getDb() as any)[prop] = value;
    return true;
  },
  has(_target, prop) {
    return prop in (getDb() as any);
  },
  ownKeys(_target) {
    return Reflect.ownKeys(getDb() as any);
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(getDb() as any, prop);
  },
});

// ============================================================================
// Lazy Prepared-Statements Singleton
// ============================================================================

type PreparedStatements = {
  insertMessage: ReturnType<Database["prepare"]>;
  getMessageByTs: ReturnType<Database["prepare"]>;
  getChannelHistory: ReturnType<Database["prepare"]>;
  getChannelHistoryOlder: ReturnType<Database["prepare"]>;
  getThreadReplies: ReturnType<Database["prepare"]>;
  updateMessage: ReturnType<Database["prepare"]>;
  deleteMessage: ReturnType<Database["prepare"]>;
  upsertAgentSeen: ReturnType<Database["prepare"]>;
  getAgent: ReturnType<Database["prepare"]>;
  getAgentSeen: ReturnType<Database["prepare"]>;
  getArtifactAction: ReturnType<Database["prepare"]>;
  getArtifactActions: ReturnType<Database["prepare"]>;
};

let _statements: PreparedStatements | null = null;

/**
 * Returns the singleton prepared-statements object, creating it on first call.
 * Calling getDb() here ensures the schema exists before preparing.
 */
export function getStatements(): PreparedStatements {
  if (!_statements) {
    const instance = getDb();
    _statements = {
      // Insert message
      insertMessage: instance.prepare(
        `INSERT INTO messages (ts, channel, thread_ts, user, text, subtype, html_preview, code_preview_json, article_json, agent_id, mentions_json, subspace_json, workspace_json, tool_result_json, interactive_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),

      // Get message by ts
      getMessageByTs: instance.prepare<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`),

      // Get messages for channel (history)
      getChannelHistory: instance.prepare<Message, [string, number]>(
        `SELECT * FROM messages WHERE channel = ? AND thread_ts IS NULL ORDER BY ts DESC LIMIT ?`,
      ),

      // Get messages older than ts (pagination)
      getChannelHistoryOlder: instance.prepare<Message, [string, string, number]>(
        `SELECT * FROM messages WHERE channel = ? AND thread_ts IS NULL AND ts < ? ORDER BY ts DESC LIMIT ?`,
      ),

      // Get thread replies
      getThreadReplies: instance.prepare<Message, [string, string, number]>(
        `SELECT * FROM messages WHERE channel = ? AND thread_ts = ? ORDER BY ts ASC LIMIT ?`,
      ),

      // Update message
      updateMessage: instance.prepare(`UPDATE messages SET text = ?, edited_at = ? WHERE ts = ? AND channel = ?`),

      // Delete message
      deleteMessage: instance.prepare(`DELETE FROM messages WHERE ts = ? AND channel = ?`),

      // Agent seen
      upsertAgentSeen: instance.prepare(
        `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_poll_ts, updated_at)
         VALUES (?, ?, ?, ?, strftime('%s', 'now'))
         ON CONFLICT(agent_id, channel) DO UPDATE SET
           last_seen_ts = excluded.last_seen_ts,
           last_poll_ts = excluded.last_poll_ts,
           updated_at = strftime('%s', 'now')`,
      ),

      // Get agent
      getAgent: instance.prepare<Agent, [string, string]>(`SELECT * FROM agents WHERE id = ? AND channel = ?`),

      // Get agent seen
      getAgentSeen: instance.prepare<{ last_seen_ts: string; last_poll_ts: number | null }, [string, string]>(
        `SELECT last_seen_ts, last_poll_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
      ),

      // Get the first action taken on an interactive artifact (for reconnect state)
      getArtifactAction: instance.prepare<{ action_id: string; value: string; user: string }, [string]>(
        `SELECT action_id, value, user FROM artifact_actions WHERE message_ts = ? ORDER BY created_at ASC LIMIT 1`,
      ),

      // Get all actions for an artifact (for polls, tallies)
      getArtifactActions: instance.prepare<
        { action_id: string; value: string; user: string; created_at: number },
        [string]
      >(`SELECT action_id, value, user, created_at FROM artifact_actions WHERE message_ts = ? ORDER BY created_at ASC`),
    };
  }
  return _statements;
}

/**
 * Backward-compatible proxy export.
 * Existing consumers that do `import { preparedStatements } from "./database"` continue to work.
 */
export const preparedStatements = new Proxy({} as PreparedStatements, {
  get(_target, prop) {
    return (getStatements() as any)[prop];
  },
});

/**
 * Resets all lazy singletons for testing.
 * Call this in `afterEach`/`afterAll` when tests open their own DB connections
 * to prevent stale prepared statements from a closed DB being reused.
 * @internal — not for production use.
 */
export function _resetForTesting(): void {
  _db?.close();
  _db = null;
  _statements = null;
  _markSeenStmt = null;
}

// ============================================================================
// ID Generation
// ============================================================================

// Generate Slack-style timestamp ID
export function generateTs(): string {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const micros = (now % 1000) * 1000 + Math.floor(Math.random() * 1000);
  return `${seconds}.${micros.toString().padStart(6, "0")}`;
}

// Generate simple ID
export function generateId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Initialize database schema
export function initDatabase() {
  db.exec(`
    -- users
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar_url TEXT,
      is_bot INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- channels (like Slack channels/threads)
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_by TEXT REFERENCES users(id),
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- messages
    CREATE TABLE IF NOT EXISTS messages (
      ts TEXT PRIMARY KEY,
      channel TEXT REFERENCES channels(id),
      thread_ts TEXT,
      user TEXT REFERENCES users(id),
      text TEXT,
      subtype TEXT,
      html_preview TEXT,
      code_preview_json TEXT,
      edited_at INTEGER,
      files_json TEXT DEFAULT '[]',
      reactions_json TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- files
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT,
      mimetype TEXT,
      size INTEGER,
      path TEXT,
      message_ts TEXT REFERENCES messages(ts),
      uploaded_by TEXT REFERENCES users(id),
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
    CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_ts);
    CREATE INDEX IF NOT EXISTS idx_files_message ON files(message_ts);

    -- Track when agents have "seen" messages in a channel
    CREATE TABLE IF NOT EXISTS agent_seen (
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      last_seen_ts TEXT NOT NULL,
      last_processed_ts TEXT,
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (agent_id, channel)
    );

    -- Add last_processed_ts column if it doesn't exist (migration for existing DBs)
    -- SQLite doesn't support IF NOT EXISTS for columns, so we handle this in code

    -- Conversation summaries for context management
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

    -- Track agent status (ready, hibernate, etc.)
    CREATE TABLE IF NOT EXISTS agent_status (
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      hibernate_until TEXT,
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (agent_id, channel)
    );

    -- Agent registry with avatar colors
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT NOT NULL,
      channel TEXT NOT NULL,
      avatar_color TEXT NOT NULL,
      display_name TEXT,
      is_worker INTEGER DEFAULT 0,
      is_sleeping INTEGER DEFAULT 0,
      joined_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (id, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_agents_channel ON agents(channel);

    -- Track which agents have seen each message
    CREATE TABLE IF NOT EXISTS message_seen (
      message_ts TEXT NOT NULL,
      channel TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      seen_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (message_ts, channel, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_seen_ts ON message_seen(message_ts);

    -- Articles (blog posts, documentation, etc.)
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

    -- Create default bot user if not exists (legacy, will be deprecated)
    INSERT OR IGNORE INTO users (id, name, is_bot) VALUES ('UBOT', 'Copilot Agent', 1);

    -- Create default human user
    INSERT OR IGNORE INTO users (id, name, is_bot) VALUES ('UHUMAN', 'User', 0);

    -- Create default channel (no C prefix needed)
    INSERT OR IGNORE INTO channels (id, name, created_by) VALUES ('general', 'general', 'UHUMAN');

    -- Copilot API call analytics
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
  `);

  // Migration: Add columns to existing tables if they don't exist
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN subtype TEXT`);
  } catch {
    /* Column already exists */
  }

  try {
    db.exec(`ALTER TABLE messages ADD COLUMN html_preview TEXT`);
  } catch {
    /* Column already exists */
  }

  try {
    db.exec(`ALTER TABLE messages ADD COLUMN code_preview_json TEXT`);
  } catch {
    /* Column already exists */
  }

  try {
    db.exec(`ALTER TABLE messages ADD COLUMN article_json TEXT`);
  } catch {
    /* Column already exists */
  }

  try {
    db.exec(`ALTER TABLE agent_seen ADD COLUMN last_processed_ts TEXT`);
  } catch {
    /* Column already exists */
  }

  // Add last_poll_ts column to agent_seen if it doesn't exist
  try {
    db.exec(`ALTER TABLE agent_seen ADD COLUMN last_poll_ts INTEGER`);
  } catch {
    /* Column already exists */
  }

  // Add agent_id column to messages for tracking who sent each message
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN agent_id TEXT`);
  } catch {
    /* Column already exists */
  }

  // Add mentions_json column to messages for @mentions
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN mentions_json TEXT DEFAULT '[]'`);
  } catch {
    /* Column already exists */
  }

  // Add subspace_json column to messages for sub-space preview cards
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN subspace_json TEXT`);
  } catch {
    /* Column already exists */
  }

  // Add workspace_json column to messages for agent workspace preview cards
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN workspace_json TEXT`);
  } catch {
    /* Column already exists */
  }

  // Add tool_result_json column to messages for scheduled tool call result cards
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN tool_result_json TEXT`);
  } catch {
    /* Column already exists */
  }

  // Migration: Add interactive_json column to messages
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN interactive_json TEXT`);
  } catch {
    /* Column already exists */
  }

  // Interactive artifact actions table
  db.exec(`
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
  `);
  try {
    db.exec(
      `CREATE UNIQUE INDEX idx_artifact_actions_idempotent ON artifact_actions(message_ts, action_id, user, value_hash)`,
    );
  } catch {
    /* Index already exists */
  }

  // Create spaces table for sub-agent chat sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      space_channel TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      agent_id TEXT NOT NULL,
      agent_color TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed','timed_out')),
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
  `);
  // Partial unique index: only one active space per scheduler job
  try {
    db.exec(
      `CREATE UNIQUE INDEX idx_spaces_active_source ON spaces(source_id) WHERE status='active' AND source='scheduler'`,
    );
  } catch {
    /* Index already exists */
  }

  // Create agents table if not exists (for older DBs)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT NOT NULL,
        channel TEXT NOT NULL,
        avatar_color TEXT NOT NULL,
        display_name TEXT,
        is_worker INTEGER DEFAULT 0,
        is_sleeping INTEGER DEFAULT 0,
        joined_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (id, channel)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_channel ON agents(channel)`);
  } catch {
    /* Table already exists */
  }

  // Add is_sleeping column if not exists (migration)
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN is_sleeping INTEGER DEFAULT 0`);
  } catch {
    /* Column already exists */
  }

  // Add is_streaming column if not exists (migration)
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN is_streaming INTEGER DEFAULT 0`);
  } catch {
    /* Column already exists */
  }

  // Add streaming_started_at column for stale streaming detection
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN streaming_started_at INTEGER DEFAULT NULL`);
  } catch {
    /* Column already exists */
  }

  // Migration: Add latency_ms and token columns to copilot_calls (added after initial table creation)
  for (const col of [
    "latency_ms INTEGER",
    "prompt_tokens INTEGER",
    "completion_tokens INTEGER",
    "agent_id TEXT",
    "channel TEXT",
    "error_msg TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE copilot_calls ADD COLUMN ${col}`);
    } catch {
      /* Column already exists */
    }
  }
  // premium_cost defaults to 0 but older rows may lack it
  try {
    db.exec(`ALTER TABLE copilot_calls ADD COLUMN premium_cost REAL NOT NULL DEFAULT 0`);
  } catch {
    /* Column already exists */
  }

  // Add public visibility flag to files (for external access via /api/public/files/:id)
  try {
    db.exec(`ALTER TABLE files ADD COLUMN public INTEGER NOT NULL DEFAULT 0`);
  } catch {
    /* Column already exists */
  }

  // Create message_seen table if not exists (for older DBs)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_seen (
        message_ts TEXT NOT NULL,
        channel TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seen_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (message_ts, channel, agent_id)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_message_seen_ts ON message_seen(message_ts)`);
  } catch {
    /* Table already exists */
  }

  // Run versioned migrations to track future schema changes
  runMigrations(getDb(), chatMigrations);
}

// Migration: Normalize channel IDs to use channel name as ID
// Previously createChannel generated random C-prefixed IDs (e.g. Cm1abc...),
// but the system uses channel names everywhere. This migration updates all
// tables to use the channel name as the canonical identifier.
export function migrateChannelIds() {
  const results: string[] = [];

  // Build mapping from old ID -> name for channels where id !== name
  const mismatchedChannels = db
    .query<{ id: string; name: string }, []>(`SELECT id, name FROM channels WHERE id != name`)
    .all();

  if (mismatchedChannels.length === 0) {
    return results;
  }

  db.transaction(() => {
    for (const { id: oldId, name } of mismatchedChannels) {
      // Skip space channels (they use composite IDs like "demo:uuid")
      if (oldId.includes(":")) continue;

      const newId = name;

      // Check if a channel with the target name already exists as an ID
      const existing = db.query<{ id: string }, [string]>(`SELECT id FROM channels WHERE id = ?`).get(newId);

      // Update all tables that reference this channel
      const tables: Array<{ table: string; column: string }> = [
        { table: "messages", column: "channel" },
        { table: "agent_seen", column: "channel" },
        { table: "agent_status", column: "channel" },
        { table: "agents", column: "channel" },
        { table: "message_seen", column: "channel" },
        { table: "summaries", column: "channel" },
        { table: "articles", column: "channel" },
        { table: "spaces", column: "channel" },
        { table: "artifact_actions", column: "channel" },
      ];

      // Also migrate channel_agents if it exists
      try {
        db.query(`SELECT 1 FROM channel_agents LIMIT 0`).get();
        tables.push({ table: "channel_agents", column: "channel" });
      } catch {
        // Table doesn't exist yet
      }

      for (const { table, column } of tables) {
        try {
          const stmt = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`);
          const info = stmt.run(newId, oldId);
          if ((info as any).changes > 0) {
            results.push(`${table}: ${oldId} -> ${newId} (${(info as any).changes} rows)`);
          }
        } catch {
          // Table or column may not exist in all schemas
        }
      }

      // Update channels table itself
      if (existing) {
        db.run(`DELETE FROM channels WHERE id = ?`, [oldId]);
        results.push(`channels: deleted ${oldId} (merged with ${newId})`);
      } else {
        db.run(`UPDATE channels SET id = ?, name = ? WHERE id = ?`, [newId, name, oldId]);
        results.push(`channels: ${oldId} -> ${newId}`);
      }
    }
  })();

  return results;
}

// Rename a specific channel (migrate all data)
export function renameChannel(oldChannel: string, newChannel: string) {
  const results: string[] = [];

  db.transaction(() => {
    // Count messages
    const msgCount = db
      .query<{ count: number }, [string]>(`SELECT COUNT(*) as count FROM messages WHERE channel = ?`)
      .get(oldChannel);

    // Update messages
    db.run(`UPDATE messages SET channel = ? WHERE channel = ?`, [newChannel, oldChannel]);
    results.push(`messages: ${oldChannel} -> ${newChannel} (${msgCount?.count || 0} messages)`);

    // Update or delete channel entry
    const existing = db.query<{ id: string }, [string]>(`SELECT id FROM channels WHERE id = ?`).get(newChannel);
    if (existing) {
      db.run(`DELETE FROM channels WHERE id = ?`, [oldChannel]);
      results.push(`channels: deleted ${oldChannel} (merged with ${newChannel})`);
    } else {
      db.run(`UPDATE channels SET id = ?, name = ? WHERE id = ?`, [newChannel, newChannel, oldChannel]);
      results.push(`channels: ${oldChannel} -> ${newChannel}`);
    }

    // Update agent_seen
    db.run(`UPDATE agent_seen SET channel = ? WHERE channel = ?`, [newChannel, oldChannel]);
    results.push(`agent_seen: ${oldChannel} -> ${newChannel}`);

    // Update agent_status
    db.run(`UPDATE agent_status SET channel = ? WHERE channel = ?`, [newChannel, oldChannel]);
    results.push(`agent_status: ${oldChannel} -> ${newChannel}`);

    // Update agents
    db.run(`UPDATE agents SET channel = ? WHERE channel = ?`, [newChannel, oldChannel]);
    results.push(`agents: ${oldChannel} -> ${newChannel}`);

    // Update message_seen
    db.run(`UPDATE message_seen SET channel = ? WHERE channel = ?`, [newChannel, oldChannel]);
    results.push(`message_seen: ${oldChannel} -> ${newChannel}`);

    // Update summaries
    db.run(`UPDATE summaries SET channel = ? WHERE channel = ?`, [newChannel, oldChannel]);
    results.push(`summaries: ${oldChannel} -> ${newChannel}`);

    // Update articles
    db.run(`UPDATE articles SET channel = ? WHERE channel = ?`, [newChannel, oldChannel]);
    results.push(`articles: ${oldChannel} -> ${newChannel}`);

    // Update spaces
    db.run(`UPDATE spaces SET channel = ? WHERE channel = ?`, [newChannel, oldChannel]);
    results.push(`spaces: ${oldChannel} -> ${newChannel}`);

    // Update artifact_actions
    db.run(`UPDATE artifact_actions SET channel = ? WHERE channel = ?`, [newChannel, oldChannel]);
    results.push(`artifact_actions: ${oldChannel} -> ${newChannel}`);

    // Update channel_agents (optional — table may not exist in older DBs)
    try {
      db.run(`UPDATE channel_agents SET channel = ? WHERE channel = ?`, [newChannel, oldChannel]);
      results.push(`channel_agents: ${oldChannel} -> ${newChannel}`);
    } catch {
      // Table may not exist in older DBs
    }

    // Update copilot_calls
    db.run(`UPDATE copilot_calls SET channel = ? WHERE channel = ?`, [newChannel, oldChannel]);
    results.push(`copilot_calls: ${oldChannel} -> ${newChannel}`);
  })();

  return results;
}

// Message helpers
export interface Message {
  ts: string;
  channel: string;
  thread_ts: string | null;
  user: string;
  text: string;
  subtype: string | null;
  html_preview: string | null;
  code_preview_json: string | null;
  agent_id: string | null;
  mentions_json: string | null;
  edited_at: number | null;
  files_json: string;
  reactions_json: string;
  article_json: string | null;
  subspace_json: string | null;
  workspace_json: string | null;
  tool_result_json: string | null;
  interactive_json: string | null;
  created_at: number;
}

export interface CodePreview {
  filename: string;
  language: string;
  content: string;
  start_line?: number;
  highlight_lines?: number[];
}

export interface SlackMessage {
  ts: string;
  type: string;
  subtype?: string;
  html_preview?: string;
  code_preview?: CodePreview;
  user: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  files?: SlackFile[];
  reactions?: { name: string; users: string[]; count: number }[];
  agent_id?: string;
  mentions?: string[];
  avatar_color?: string;
  seen_by?: string[] | { agent_id: string; avatar_color: string; is_sleeping?: boolean }[];
  is_sleeping?: boolean;
  is_streaming?: boolean;
  article?: {
    id: string;
    title: string;
    description: string;
    author: string;
    thumbnail_url: string;
  };
  subspace?: SubspacePreview;
  workspace?: WorkspacePreview;
  tool_result?: ToolResultPreview;
  interactive?: string; // Raw JSON string — frontend parses via lenient parser
  interactive_acted?: boolean;
  interactive_action?: { action_id: string; value: string; user: string } | null;
}

export interface WorkspacePreview {
  workspace_id: string;
  title: string;
  description?: string;
  status: "running" | "waiting" | "completed";
}

export interface SubspacePreview {
  id: string;
  title: string;
  description?: string;
  agent_id: string;
  agent_color: string;
  status: "active" | "completed" | "failed" | "timed_out";
  channel: string;
}

export interface ToolResultPreview {
  tool_name: string;
  description: string;
  status: "running" | "succeeded" | "failed";
  args: Record<string, any>;
  result?: any;
  error?: string;
  job_id?: string;
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
}

export function toSlackMessage(msg: Message): SlackMessage {
  const result: SlackMessage = {
    ts: msg.ts,
    type: "message",
    user: msg.user,
    text: msg.text,
  };

  if (msg.subtype) {
    result.subtype = msg.subtype;
  }

  if (msg.html_preview) {
    result.html_preview = msg.html_preview;
  }

  if (msg.code_preview_json) {
    try {
      result.code_preview = JSON.parse(msg.code_preview_json);
    } catch {
      /* Invalid JSON */
    }
  }

  if (msg.thread_ts) {
    result.thread_ts = msg.thread_ts;
  }

  if (msg.files_json && msg.files_json !== "[]") {
    try {
      const files = JSON.parse(msg.files_json);
      if (files.length > 0) result.files = files;
    } catch {
      /* Invalid JSON */
    }
  }

  if (msg.reactions_json && msg.reactions_json !== "{}") {
    try {
      const reactions = JSON.parse(msg.reactions_json);
      if (Object.keys(reactions).length > 0) {
        result.reactions = Object.entries(reactions).map(([name, users]) => ({
          name,
          users: users as string[],
          count: (users as string[]).length,
        }));
      }
    } catch {
      /* Invalid JSON */
    }
  }

  // Include agent_id if present
  if (msg.agent_id) {
    result.agent_id = msg.agent_id;
  }

  // Parse and include mentions
  if (msg.mentions_json) {
    try {
      const mentions = JSON.parse(msg.mentions_json);
      if (mentions.length > 0) {
        result.mentions = mentions;
      }
    } catch {
      /* Invalid JSON */
    }
  }

  // Parse and include article attachment
  if (msg.article_json) {
    try {
      const article = JSON.parse(msg.article_json);
      if (article && article.id) {
        result.article = article;
      }
    } catch {
      /* Invalid JSON */
    }
  }

  // Parse and include subspace preview
  if (msg.subspace_json) {
    try {
      const subspace = JSON.parse(msg.subspace_json);
      if (subspace && subspace.id) {
        result.subspace = subspace;
      }
    } catch {
      /* Invalid JSON */
    }
  }

  // Parse and include workspace preview
  if (msg.workspace_json) {
    try {
      const workspace = JSON.parse(msg.workspace_json);
      // Validate workspace_id is a safe hex string before trusting it in client URLs
      if (workspace && typeof workspace.workspace_id === "string" && /^[a-f0-9]{16}$/.test(workspace.workspace_id)) {
        result.workspace = workspace;
      }
    } catch {
      /* Invalid JSON */
    }
  }

  // Parse and include tool result preview
  if (msg.tool_result_json) {
    try {
      const toolResult = JSON.parse(msg.tool_result_json);
      if (toolResult && toolResult.tool_name) {
        result.tool_result = toolResult;
      }
    } catch {
      /* Invalid JSON */
    }
  }

  // Parse interactive artifact spec (Path B: MCP-sent via column)
  if (msg.interactive_json) {
    try {
      const interactive = JSON.parse(msg.interactive_json);
      if (interactive && Array.isArray(interactive.components)) {
        result.interactive = msg.interactive_json;
      }
    } catch {
      /* Invalid JSON */
    }
  }

  // Load action state for ANY message (covers both Path A tag-based and Path B column-based)
  const action = preparedStatements.getArtifactAction.get(msg.ts);
  if (action) {
    result.interactive_acted = true;
    result.interactive_action = action;
  }

  return result;
}

export function updateSubspaceStatus(ts: string, channel: string, newSubspaceJson: string) {
  const now = Math.floor(Date.now() / 1000);
  db.run(`UPDATE messages SET subspace_json = ?, edited_at = ? WHERE ts = ? AND channel = ?`, [
    newSubspaceJson,
    now,
    ts,
    channel,
  ]);
  return db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(ts) || null;
}

// Agent Registry Types & Functions
export interface Agent {
  id: string;
  channel: string;
  avatar_color: string;
  display_name: string | null;
  is_worker: number;
  is_sleeping: number;
  is_streaming: number;
  streaming_started_at: number | null;
  joined_at: number;
}

// Available avatar colors (excluding black for workers)
const AVATAR_COLORS = [
  "#D97853", // Orange (primary - first agent)
  "#4A90D9", // Blue
  "#4AD98C", // Green
  "#9B4AD9", // Purple
  "#4AD9D9", // Teal
  "#D94A90", // Pink
  "#D9D94A", // Yellow
  "#D94A4A", // Red
  "#7A4AD9", // Indigo
  "#4AD9A8", // Mint
];

const WORKER_COLOR = "#333333"; // Black for workers

// Get or register an agent, auto-assigning avatar color
export function getOrRegisterAgent(agentId: string, channel: string, isWorker: boolean = false): Agent {
  // Wrap in a transaction to prevent check-then-insert race under concurrent access.
  // INSERT OR IGNORE handles any remaining duplicate after the SELECT (e.g. two
  // transactions that both saw no existing row before entering here).
  return db.transaction((): Agent => {
    const existing = db
      .query<Agent, [string, string]>(`SELECT * FROM agents WHERE id = ? AND channel = ?`)
      .get(agentId, channel);

    if (existing) {
      return existing;
    }

    // Assign color
    const isWorkerAgent = isWorker || agentId.startsWith("UWORKER-");
    let avatarColor: string;
    if (isWorkerAgent) {
      avatarColor = WORKER_COLOR;
    } else {
      // Get existing agents to find next available color
      const existingAgents = db
        .query<{ avatar_color: string }, [string]>(
          `SELECT avatar_color FROM agents WHERE channel = ? AND is_worker = 0`,
        )
        .all(channel);

      const usedColors = new Set(existingAgents.map((a) => a.avatar_color));
      avatarColor =
        AVATAR_COLORS.find((c) => !usedColors.has(c)) || AVATAR_COLORS[existingAgents.length % AVATAR_COLORS.length];
    }

    const now = Math.floor(Date.now() / 1000);
    const isWorkerFlag = isWorkerAgent ? 1 : 0;

    // INSERT OR IGNORE prevents a unique-constraint error if two concurrent
    // transactions both passed the SELECT above before either committed.
    db.run(`INSERT OR IGNORE INTO agents (id, channel, avatar_color, is_worker, joined_at) VALUES (?, ?, ?, ?, ?)`, [
      agentId,
      channel,
      avatarColor,
      isWorkerFlag,
      now,
    ]);

    // Re-read the row so we return the authoritative DB state (handles IGNORE case)
    const inserted = db
      .query<Agent, [string, string]>(`SELECT * FROM agents WHERE id = ? AND channel = ?`)
      .get(agentId, channel);

    if (inserted) return inserted;

    // Fallback (should not happen in practice)
    return {
      id: agentId,
      channel,
      avatar_color: avatarColor,
      display_name: null,
      is_worker: isWorkerFlag,
      is_sleeping: 0,
      is_streaming: 0,
      streaming_started_at: null,
      joined_at: now,
    };
  })();
}

// List all agents in a channel (with dynamic is_sleeping calculation)
export function listAgents(channel: string): Agent[] {
  // Single query with LEFT JOIN instead of per-agent query
  const rows = db
    .query<any, [string]>(
      `SELECT a.*, as2.updated_at as last_activity
     FROM agents a
     LEFT JOIN agent_seen as2 ON a.id = as2.agent_id AND a.channel = as2.channel
     WHERE a.channel = ? ORDER BY a.joined_at ASC`,
    )
    .all(channel);

  const nowSeconds = Math.floor(Date.now() / 1000);

  return rows.map((row: any) => {
    // If agent is actively streaming, it's never sleeping
    if (row.is_streaming) {
      return { ...row, is_sleeping: 0, last_activity: undefined };
    }

    const isSleeping = !row.last_activity || nowSeconds - row.last_activity > SLEEP_THRESHOLD_SECONDS;

    return { ...row, is_sleeping: isSleeping ? 1 : 0, last_activity: undefined };
  });
}

// Sleep threshold - 2 minutes of inactivity = sleeping
const SLEEP_THRESHOLD_SECONDS = 2 * 60;

// Agent cache — avoids 2 DB queries per getAgent() call in hot paths (broadcasts, polling)
const agentCache = new Map<string, { agent: Agent; ts: number }>();
const AGENT_CACHE_TTL_MS = 2000; // 2s TTL — fresh enough for UI, avoids 100+ queries/sec

// Get agent by ID and channel (with dynamic is_sleeping calculation)
export function getAgent(agentId: string, channel: string): Agent | null {
  const cacheKey = `${agentId}:${channel}`;
  const now = Date.now();
  const cached = agentCache.get(cacheKey);
  if (cached && now - cached.ts < AGENT_CACHE_TTL_MS) {
    return cached.agent;
  }

  // Use prepared statement instead of ad-hoc query
  const agent = preparedStatements.getAgent.get(agentId, channel);
  if (!agent) return null;

  // If agent is actively streaming, it's never sleeping
  if (agent.is_streaming) {
    const result = { ...agent, is_sleeping: 0 };
    agentCache.set(cacheKey, { agent: result, ts: now });
    return result;
  }

  // Get last activity time from agent_seen table
  const lastActivity = db
    .query<{ updated_at: number }, [string, string]>(
      `SELECT updated_at FROM agent_seen WHERE agent_id = ? AND channel = ?`,
    )
    .get(agentId, channel);

  // Compute is_sleeping dynamically based on last activity
  const nowSeconds = Math.floor(now / 1000);
  const isSleeping = !lastActivity || nowSeconds - lastActivity.updated_at > SLEEP_THRESHOLD_SECONDS;

  const result = { ...agent, is_sleeping: isSleeping ? 1 : 0 };
  agentCache.set(cacheKey, { agent: result, ts: now });
  return result;
}

// Invalidate agent cache (call when agent state changes)
export function invalidateAgentCache(agentId?: string, channel?: string): void {
  if (agentId && channel) {
    agentCache.delete(`${agentId}:${channel}`);
  } else {
    agentCache.clear();
  }
}

// Set agent's sleeping state
export function setAgentSleeping(agentId: string, channel: string, isSleeping: boolean): boolean {
  const result = db.run(`UPDATE agents SET is_sleeping = ? WHERE id = ? AND channel = ?`, [
    isSleeping ? 1 : 0,
    agentId,
    channel,
  ]);
  if (result.changes > 0) invalidateAgentCache(agentId, channel);
  return result.changes > 0;
}

// Set agent's streaming state (actively generating response)
export function setAgentStreaming(agentId: string, channel: string, isStreaming: boolean): boolean {
  const result = db.run(`UPDATE agents SET is_streaming = ?, streaming_started_at = ? WHERE id = ? AND channel = ?`, [
    isStreaming ? 1 : 0,
    isStreaming ? Math.floor(Date.now() / 1000) : null,
    agentId,
    channel,
  ]);
  if (result.changes > 0) invalidateAgentCache(agentId, channel);
  return result.changes > 0;
}

// Clear stale streaming states - agents that have been "streaming" for longer than the threshold
// This handles cases where agents crash/get killed without calling setAgentStreaming(false)
const STALE_STREAMING_THRESHOLD_SECONDS = 300; // 5 minutes — tool chains can take minutes

export function clearStaleStreamingStates(): { cleared: string[] } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const threshold = nowSeconds - STALE_STREAMING_THRESHOLD_SECONDS;

  // Find agents with stale streaming states
  const staleAgents = db
    .query<{ id: string; channel: string }, [number]>(
      `SELECT id, channel FROM agents WHERE is_streaming = 1 AND streaming_started_at IS NOT NULL AND streaming_started_at < ?`,
    )
    .all(threshold);

  if (staleAgents.length > 0) {
    // Clear all stale streaming states
    db.run(
      `UPDATE agents SET is_streaming = 0, streaming_started_at = NULL WHERE is_streaming = 1 AND streaming_started_at IS NOT NULL AND streaming_started_at < ?`,
      [threshold],
    );
  }

  return { cleared: staleAgents.map((a) => `${a.id}@${a.channel}`) };
}

// Check if a user is an agent (not human)
export function isAgentUser(userId: string, channel: string): boolean {
  // Worker pattern
  if (userId.startsWith("UWORKER-")) return true;

  // Check agent registry
  const agent = getAgent(userId, channel);
  if (agent) return true;

  // Check if registered as agent in any channel (for backward compat)
  const anyAgent = db.query<{ id: string }, [string]>(`SELECT id FROM agents WHERE id = ? LIMIT 1`).get(userId);

  return !!anyAgent;
}

// Mark messages as seen by an agent - batched for performance
// Returns list of message timestamps that were NEWLY marked (not already seen)
// Lazily prepared on first use (avoids module-level DB side effect)
let _markSeenStmt: ReturnType<Database["prepare"]> | null = null;
function getMarkSeenStmt() {
  if (!_markSeenStmt) {
    _markSeenStmt = getDb().prepare(
      `INSERT OR IGNORE INTO message_seen (message_ts, channel, agent_id, seen_at) VALUES (?, ?, ?, ?)`,
    );
  }
  return _markSeenStmt;
}

export function markMessagesSeen(channel: string, agentId: string, messageTsList: string[]): string[] {
  if (messageTsList.length === 0) return [];

  const now = Math.floor(Date.now() / 1000);
  const newlySeen: string[] = [];

  // Use transaction for batch insert (much faster)
  db.transaction(() => {
    for (const ts of messageTsList) {
      const runResult = getMarkSeenStmt().run(ts, channel, agentId, now);
      if (runResult.changes > 0) {
        newlySeen.push(ts);
      }
    }
  })();

  return newlySeen;
}

// Get agents who have seen a message
export function getMessageSeenBy(channel: string, messageTs: string): string[] {
  const rows = db
    .query<{ agent_id: string }, [string, string]>(
      `SELECT agent_id FROM message_seen WHERE channel = ? AND message_ts = ?`,
    )
    .all(channel, messageTs);
  return rows.map((r) => r.agent_id);
}

// Get the last acknowledged message for each agent in a channel
// Returns map of message_ts -> list of agents whose last seen message is this one
// For each agent, finds the latest message NOT sent by that agent
export function getLastSeenByAgents(channel: string): Map<string, string[]> {
  // For each agent, find the MAX message_ts they've seen where the message was NOT sent by them
  // This handles both UHUMAN messages AND messages from OTHER agents
  const rows = db
    .query<{ agent_id: string; last_ts: string }, [string]>(
      `SELECT ms.agent_id, MAX(ms.message_ts) as last_ts
     FROM message_seen ms
     JOIN messages m ON ms.message_ts = m.ts AND ms.channel = m.channel
     WHERE ms.channel = ?
       AND (m.agent_id IS NULL OR m.agent_id != ms.agent_id)
     GROUP BY ms.agent_id`,
    )
    .all(channel);

  const result = new Map<string, string[]>();
  for (const row of rows) {
    const existing = result.get(row.last_ts) || [];
    existing.push(row.agent_id);
    result.set(row.last_ts, existing);
  }
  return result;
}

// Parse @mentions from message text
export function parseMentions(text: string): string[] {
  const mentionPattern = /@clawd(?::([a-zA-Z0-9]+))?/gi;
  const mentions: string[] = [];
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    mentions.push(match[0]);
  }
  return mentions;
}
