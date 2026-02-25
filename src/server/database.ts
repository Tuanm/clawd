import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || join(process.env.HOME || "/tmp", ".clawd", "data");
const DB_PATH = join(DATA_DIR, "chat.db");
const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

// Ensure directories exist
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}
if (!existsSync(ATTACHMENTS_DIR)) {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
}

// High-performance SQLite configuration
export const db = new Database(DB_PATH, { strict: true });

// Set busy_timeout FIRST to avoid SQLITE_BUSY errors
db.exec("PRAGMA busy_timeout = 5000"); // 5 second timeout

// Enable WAL mode for better concurrent read/write performance
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA cache_size = -64000"); // 64MB cache
db.exec("PRAGMA temp_store = MEMORY");
db.exec("PRAGMA mmap_size = 268435456"); // 256MB memory-mapped I/O

export { ATTACHMENTS_DIR };

// Initialize tables BEFORE preparing statements (tables must exist for db.prepare)
initDatabase();

// ============================================================================
// Prepared Statements for Hot Paths (high-throughput optimization)
// ============================================================================

// Message queries - prepared once, reused for all requests
export const preparedStatements = {
  // Insert message
  insertMessage: db.prepare(
    `INSERT INTO messages (ts, channel, thread_ts, user, text, subtype, html_preview, code_preview_json, article_json, agent_id, mentions_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),

  // Get message by ts
  getMessageByTs: db.prepare<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`),

  // Get messages for channel (history)
  getChannelHistory: db.prepare<Message, [string, number]>(
    `SELECT * FROM messages WHERE channel = ? AND thread_ts IS NULL ORDER BY ts DESC LIMIT ?`,
  ),

  // Get messages older than ts (pagination)
  getChannelHistoryOlder: db.prepare<Message, [string, string, number]>(
    `SELECT * FROM messages WHERE channel = ? AND thread_ts IS NULL AND ts < ? ORDER BY ts DESC LIMIT ?`,
  ),

  // Get thread replies
  getThreadReplies: db.prepare<Message, [string, string, number]>(
    `SELECT * FROM messages WHERE channel = ? AND thread_ts = ? ORDER BY ts ASC LIMIT ?`,
  ),

  // Update message
  updateMessage: db.prepare(`UPDATE messages SET text = ?, edited_at = ? WHERE ts = ? AND channel = ?`),

  // Delete message
  deleteMessage: db.prepare(`DELETE FROM messages WHERE ts = ? AND channel = ?`),

  // Agent seen
  upsertAgentSeen: db.prepare(
    `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_poll_ts, updated_at)
     VALUES (?, ?, ?, ?, strftime('%s', 'now'))
     ON CONFLICT(agent_id, channel) DO UPDATE SET
       last_seen_ts = excluded.last_seen_ts,
       last_poll_ts = excluded.last_poll_ts,
       updated_at = strftime('%s', 'now')`,
  ),

  // Get agent
  getAgent: db.prepare<Agent, [string, string]>(`SELECT * FROM agents WHERE id = ? AND channel = ?`),

  // Get agent seen
  getAgentSeen: db.prepare<{ last_seen_ts: string; last_poll_ts: number | null }, [string, string]>(
    `SELECT last_seen_ts, last_poll_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
  ),
};

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
}

// Migration: Remove C- or C prefix from channel IDs
export function migrateChannelIds() {
  const results: string[] = [];

  // Get all distinct channels with C- or starting with C followed by alphanumeric
  const channels = db
    .query<{ channel: string }, []>(
      `SELECT DISTINCT channel FROM messages WHERE channel LIKE 'C-%' OR channel LIKE 'C%'`,
    )
    .all();

  for (const { channel } of channels) {
    // Remove C- prefix or just C prefix
    let newChannel = channel;
    if (channel.startsWith("C-")) {
      newChannel = channel.slice(2);
    } else if (channel.startsWith("C") && channel.length > 1 && /^C[0-9]/.test(channel)) {
      // C001 -> general (special case for default channel)
      newChannel = channel === "C001" ? "general" : channel.slice(1);
    }

    if (newChannel !== channel) {
      // Update messages
      db.run(`UPDATE messages SET channel = ? WHERE channel = ?`, [newChannel, channel]);
      results.push(`messages: ${channel} -> ${newChannel}`);
    }
  }

  // Update channels table
  const channelRows = db.query<{ id: string }, []>(`SELECT id FROM channels WHERE id LIKE 'C-%' OR id LIKE 'C%'`).all();
  for (const { id } of channelRows) {
    let newId = id;
    if (id.startsWith("C-")) {
      newId = id.slice(2);
    } else if (id.startsWith("C") && id.length > 1 && /^C[0-9]/.test(id)) {
      newId = id === "C001" ? "general" : id.slice(1);
    }

    if (newId !== id) {
      // Check if new channel already exists
      const existing = db.query<{ id: string }, [string]>(`SELECT id FROM channels WHERE id = ?`).get(newId);
      if (existing) {
        // Delete old channel (messages already migrated)
        db.run(`DELETE FROM channels WHERE id = ?`, [id]);
        results.push(`channels: deleted ${id} (merged with ${newId})`);
      } else {
        db.run(`UPDATE channels SET id = ? WHERE id = ?`, [newId, id]);
        results.push(`channels: ${id} -> ${newId}`);
      }
    }
  }

  // Update agent_seen table
  const agentSeenRows = db
    .query<{ channel: string }, []>(
      `SELECT DISTINCT channel FROM agent_seen WHERE channel LIKE 'C-%' OR channel LIKE 'C%'`,
    )
    .all();
  for (const { channel } of agentSeenRows) {
    let newChannel = channel;
    if (channel.startsWith("C-")) {
      newChannel = channel.slice(2);
    } else if (channel.startsWith("C") && channel.length > 1 && /^C[0-9]/.test(channel)) {
      newChannel = channel === "C001" ? "general" : channel.slice(1);
    }

    if (newChannel !== channel) {
      db.run(`UPDATE agent_seen SET channel = ? WHERE channel = ?`, [newChannel, channel]);
      results.push(`agent_seen: ${channel} -> ${newChannel}`);
    }
  }

  return results;
}

// Rename a specific channel (migrate all data)
export function renameChannel(oldChannel: string, newChannel: string) {
  const results: string[] = [];

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
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
}

export function toSlackMessage(msg: Message): SlackMessage {
  const files = JSON.parse(msg.files_json || "[]");
  const reactions = JSON.parse(msg.reactions_json || "{}");

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

  if (files.length > 0) {
    result.files = files;
  }

  if (Object.keys(reactions).length > 0) {
    result.reactions = Object.entries(reactions).map(([name, users]) => ({
      name,
      users: users as string[],
      count: (users as string[]).length,
    }));
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

  return result;
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
  // Check if agent already exists
  const existing = db
    .query<Agent, [string, string]>(`SELECT * FROM agents WHERE id = ? AND channel = ?`)
    .get(agentId, channel);

  if (existing) {
    return existing;
  }

  // Assign color
  let avatarColor: string;
  if (isWorker || agentId.startsWith("UWORKER-")) {
    avatarColor = WORKER_COLOR;
  } else {
    // Get existing agents to find next available color
    const existingAgents = db
      .query<{ avatar_color: string }, [string]>(`SELECT avatar_color FROM agents WHERE channel = ? AND is_worker = 0`)
      .all(channel);

    const usedColors = new Set(existingAgents.map((a) => a.avatar_color));
    avatarColor =
      AVATAR_COLORS.find((c) => !usedColors.has(c)) || AVATAR_COLORS[existingAgents.length % AVATAR_COLORS.length];
  }

  // Register agent
  const now = Math.floor(Date.now() / 1000);
  db.run(`INSERT INTO agents (id, channel, avatar_color, is_worker, joined_at) VALUES (?, ?, ?, ?, ?)`, [
    agentId,
    channel,
    avatarColor,
    isWorker || agentId.startsWith("UWORKER-") ? 1 : 0,
    now,
  ]);

  return {
    id: agentId,
    channel,
    avatar_color: avatarColor,
    display_name: null,
    is_worker: isWorker || agentId.startsWith("UWORKER-") ? 1 : 0,
    is_sleeping: 0,
    is_streaming: 0,
    streaming_started_at: null,
    joined_at: now,
  };
}

// List all agents in a channel (with dynamic is_sleeping calculation)
export function listAgents(channel: string): Agent[] {
  const agents = db
    .query<Agent, [string]>(`SELECT * FROM agents WHERE channel = ? ORDER BY joined_at ASC`)
    .all(channel);

  const nowSeconds = Math.floor(Date.now() / 1000);

  return agents.map((agent) => {
    // If agent is actively streaming, it's never sleeping
    if (agent.is_streaming) {
      return { ...agent, is_sleeping: 0 };
    }

    const lastActivity = db
      .query<{ updated_at: number }, [string, string]>(
        `SELECT updated_at FROM agent_seen WHERE agent_id = ? AND channel = ?`,
      )
      .get(agent.id, channel);

    const isSleeping = !lastActivity || nowSeconds - lastActivity.updated_at > SLEEP_THRESHOLD_SECONDS;

    return { ...agent, is_sleeping: isSleeping ? 1 : 0 };
  });
}

// Sleep threshold - 2 minutes of inactivity = sleeping
const SLEEP_THRESHOLD_SECONDS = 2 * 60;

// Get agent by ID and channel (with dynamic is_sleeping calculation)
export function getAgent(agentId: string, channel: string): Agent | null {
  // Get base agent data
  const agent = db
    .query<Agent, [string, string]>(`SELECT * FROM agents WHERE id = ? AND channel = ?`)
    .get(agentId, channel);

  if (!agent) return null;

  // If agent is actively streaming, it's never sleeping
  if (agent.is_streaming) {
    return { ...agent, is_sleeping: 0 };
  }

  // Get last activity time from agent_seen table
  const lastActivity = db
    .query<{ updated_at: number }, [string, string]>(
      `SELECT updated_at FROM agent_seen WHERE agent_id = ? AND channel = ?`,
    )
    .get(agentId, channel);

  // Compute is_sleeping dynamically based on last activity
  const nowSeconds = Math.floor(Date.now() / 1000);
  const isSleeping = !lastActivity || nowSeconds - lastActivity.updated_at > SLEEP_THRESHOLD_SECONDS;

  return { ...agent, is_sleeping: isSleeping ? 1 : 0 };
}

// Set agent's sleeping state
export function setAgentSleeping(agentId: string, channel: string, isSleeping: boolean): boolean {
  const result = db.run(`UPDATE agents SET is_sleeping = ? WHERE id = ? AND channel = ?`, [
    isSleeping ? 1 : 0,
    agentId,
    channel,
  ]);
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
  return result.changes > 0;
}

// Clear stale streaming states - agents that have been "streaming" for longer than the threshold
// This handles cases where agents crash/get killed without calling setAgentStreaming(false)
const STALE_STREAMING_THRESHOLD_SECONDS = 90; // 90 seconds (reduced from 5 minutes)

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
const markSeenStmt = db.prepare(
  `INSERT OR IGNORE INTO message_seen (message_ts, channel, agent_id, seen_at) VALUES (?, ?, ?, ?)`,
);

export function markMessagesSeen(channel: string, agentId: string, messageTsList: string[]): string[] {
  if (messageTsList.length === 0) return [];

  const now = Math.floor(Date.now() / 1000);
  const newlySeen: string[] = [];

  // Use transaction for batch insert (much faster)
  db.transaction(() => {
    for (const ts of messageTsList) {
      markSeenStmt.run(ts, channel, agentId, now);
      // Check if a row was actually inserted (not ignored due to existing)
      if (
        (db.query(`SELECT changes()`).get() as { "changes()": number }) &&
        (db.query(`SELECT changes()`).get() as { "changes()": number })["changes()"] > 0
      ) {
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
