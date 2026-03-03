import {
  db,
  generateTs,
  getAgent,
  getLastSeenByAgents,
  getMessageSeenBy,
  getOrRegisterAgent,
  type Message,
  parseMentions,
  preparedStatements,
  toSlackMessage,
} from "../database";

// Copilot CLI internal markers that sometimes leak into agent responses
const COPILOT_MARKERS = [
  /echo ___BEGIN___COMMAND_OUTPUT_MARKER___ ; PS1= ; PS2= ; unset HISTFILE ; EC=0 ; echo ___BEGIN___COMMAND_DONE_MARKER___0 ; \}/g,
  /echo \*+BEGIN___COMMAND_OUTPUT_MARKER\*+ ; PS1= ; PS2= ; unset HISTFILE ; EC=0 ; echo ___BEGIN___COMMAND_DONE_MARKER___0 ; \}/g,
  /___BEGIN___COMMAND_OUTPUT_MARKER___/g,
  /___BEGIN___COMMAND_DONE_MARKER___\d*/g,
];

// Sanitize message text by removing Copilot CLI markers
function sanitizeText(text: string): string {
  let result = text;
  for (const marker of COPILOT_MARKERS) {
    result = result.replace(marker, "");
  }
  // Clean up any resulting double spaces or leading/trailing spaces
  return result.replace(/ {2,}/g, " ").trim();
}

import type { CodePreview } from "../database";

export interface PostMessageRequest {
  channel: string;
  text: string;
  thread_ts?: string;
  user?: string;
  agent_id?: string;
  subtype?: string;
  html_preview?: string;
  code_preview?: CodePreview;
  article_json?: string;
  subspace_json?: string;
  workspace_json?: string;
}

export interface UpdateMessageRequest {
  channel: string;
  ts: string;
  text: string;
}

export interface ReactionsRequest {
  channel: string;
  timestamp: string;
  name: string;
  user?: string;
}

// POST /api/chat.postMessage - uses prepared statement
export function postMessage(req: PostMessageRequest) {
  // Lock check for space channels
  if (req.channel.includes(":space:")) {
    const space = db
      .query<{ locked: number }, [string]>(`SELECT locked FROM spaces WHERE space_channel = ?`)
      .get(req.channel);
    if (space?.locked) {
      return { ok: false, error: "space_is_locked" };
    }
  }

  // "clear" command: only for human messages in clearable channels
  const trimmedText = req.text?.trim() ?? "";
  if (
    CLEARABLE_CHANNELS.has(req.channel) &&
    !req.agent_id &&
    (req.user === "UHUMAN" || !req.user) &&
    (trimmedText === "clear" || trimmedText === "/clear")
  ) {
    const result = clearChannelHistory(req.channel);
    return { ok: result.ok, cleared: true, error: result.error };
  }

  // Auto-create channel if it doesn't exist (ensures FK consistency)
  if (!req.channel.includes(":space:")) {
    db.run(`INSERT OR IGNORE INTO channels (id, name, created_by) VALUES (?, ?, ?)`, [
      req.channel,
      req.channel,
      "UHUMAN",
    ]);
  }

  const ts = generateTs();
  // Default to UBOT if agent_id is provided, UHUMAN otherwise
  const user = req.user || (req.agent_id ? "UBOT" : "UHUMAN");
  const sanitizedText = sanitizeText(req.text);
  const text = sanitizedText;

  const codePreviewJson = req.code_preview ? JSON.stringify(req.code_preview) : null;

  // Parse mentions from text
  const mentions = parseMentions(text);
  const mentionsJson = JSON.stringify(mentions);

  // If agent_id provided and it's an agent message, register the agent and update activity
  const agentId = req.agent_id || null;
  if (agentId && user !== "UHUMAN") {
    getOrRegisterAgent(agentId, req.channel, user.startsWith("UWORKER-"));
    // Update agent_seen to mark agent as active (prevents sleeping status)
    db.run(
      `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_poll_ts, updated_at) 
       VALUES (?, ?, ?, ?, strftime('%s', 'now'))
       ON CONFLICT(agent_id, channel) DO UPDATE SET 
         last_poll_ts = strftime('%s', 'now'),
         updated_at = strftime('%s', 'now')`,
      [agentId, req.channel, ts, Math.floor(Date.now() / 1000)],
    );
  }

  // Use prepared statement for hot path
  preparedStatements.insertMessage.run(
    ts,
    req.channel,
    req.thread_ts || null,
    user,
    text,
    req.subtype || null,
    req.html_preview || null,
    codePreviewJson,
    req.article_json || null,
    agentId,
    mentionsJson,
    req.subspace_json || null,
    req.workspace_json || null,
  );

  const msg = preparedStatements.getMessageByTs.get(ts);

  // Build response message with avatar_color and state for agent messages
  const responseMessage = msg ? toSlackMessage(msg) : null;
  if (responseMessage && agentId) {
    const agent = getAgent(agentId, req.channel);
    responseMessage.avatar_color = agent?.avatar_color || "#D97853";
    responseMessage.is_sleeping = agent?.is_sleeping === 1;
    responseMessage.is_streaming = agent?.is_streaming === 1;
  }

  return {
    ok: true,
    channel: req.channel,
    ts,
    message: responseMessage,
  };
}

// POST /api/chat.update - uses prepared statement
export function updateMessage(req: UpdateMessageRequest) {
  // Lock check for space channels (SP2)
  if (req.channel.includes(":space:")) {
    const space = db
      .query<{ locked: number }, [string]>(`SELECT locked FROM spaces WHERE space_channel = ?`)
      .get(req.channel);
    if (space?.locked) {
      return { ok: false, error: "space_is_locked" };
    }
  }

  const now = Math.floor(Date.now() / 1000);

  const text = req.text;

  preparedStatements.updateMessage.run(text, now, req.ts, req.channel);

  const msg = preparedStatements.getMessageByTs.get(req.ts);

  return {
    ok: true,
    channel: req.channel,
    ts: req.ts,
    message: msg ? toSlackMessage(msg) : null,
  };
}

// POST /api/conversations.history - uses prepared statement
export function getConversationHistory(channel: string, limit = 100, oldest?: string) {
  let messages: Message[];

  if (oldest) {
    // Fetch messages older than the oldest parameter (for pagination)
    messages = preparedStatements.getChannelHistoryOlder.all(channel, oldest, limit + 1);
  } else {
    // Fetch most recent messages
    messages = preparedStatements.getChannelHistory.all(channel, limit + 1);
  }

  // Check if there are more messages
  const hasMore = messages.length > limit;
  if (hasMore) {
    messages.pop(); // Remove the extra message used for checking
  }

  // Get the last acknowledged message for each agent
  const lastSeenByAgents = getLastSeenByAgents(channel);

  // Get reply counts for each message and add seen_by
  const result = messages.map((msg) => {
    const replyCount = db
      .query<{ count: number }, [string]>(`SELECT COUNT(*) as count FROM messages WHERE thread_ts = ?`)
      .get(msg.ts);

    const slackMsg = toSlackMessage(msg);
    if (replyCount && replyCount.count > 0) {
      slackMsg.reply_count = replyCount.count;
    }

    // Add seen_by only for the LAST message each agent has acknowledged
    const agentsWithLastSeen = lastSeenByAgents.get(msg.ts);
    if (agentsWithLastSeen && agentsWithLastSeen.length > 0) {
      slackMsg.seen_by = agentsWithLastSeen.map((agentId) => {
        const agent = getAgent(agentId, channel);
        return {
          agent_id: agentId,
          avatar_color: agent?.avatar_color || "#D97853",
          is_sleeping: agent?.is_sleeping === 1,
        };
      });
    }

    // Add avatar_color and is_sleeping for agent messages
    if (msg.agent_id) {
      const agent = getAgent(msg.agent_id, channel);
      slackMsg.avatar_color = agent?.avatar_color || "#D97853";
      slackMsg.is_sleeping = agent?.is_sleeping === 1;
    }

    return slackMsg;
  });

  return {
    ok: true,
    messages: result.reverse(), // oldest first
    has_more: hasMore,
  };
}

// POST /api/conversations.replies
export function getConversationReplies(channel: string, ts: string, limit = 100) {
  // Get parent message
  const parent = db
    .query<Message, [string, string]>(`SELECT * FROM messages WHERE ts = ? AND channel = ?`)
    .get(ts, channel);

  if (!parent) {
    return { ok: false, error: "thread_not_found" };
  }

  // Get replies
  const replies = db
    .query<Message, [string, string, number]>(
      `SELECT * FROM messages WHERE thread_ts = ? AND channel = ? ORDER BY ts ASC LIMIT ?`,
    )
    .all(ts, channel, limit);

  const messages = [toSlackMessage(parent), ...replies.map(toSlackMessage)];

  return {
    ok: true,
    messages,
  };
}

// POST /api/reactions.add
export function addReaction(req: ReactionsRequest) {
  const user = req.user || "UHUMAN";
  const msg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(req.timestamp);

  if (!msg) {
    return { ok: false, error: "message_not_found" };
  }

  const reactions = JSON.parse(msg.reactions_json || "{}");
  if (!reactions[req.name]) {
    reactions[req.name] = [];
  }
  if (!reactions[req.name].includes(user)) {
    reactions[req.name].push(user);
  }

  db.run(`UPDATE messages SET reactions_json = ? WHERE ts = ?`, [JSON.stringify(reactions), req.timestamp]);

  return { ok: true };
}

// POST /api/reactions.remove
export function removeReaction(req: ReactionsRequest) {
  const user = req.user || "UHUMAN";
  const msg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(req.timestamp);

  if (!msg) {
    return { ok: false, error: "message_not_found" };
  }

  const reactions = JSON.parse(msg.reactions_json || "{}");
  if (reactions[req.name]) {
    reactions[req.name] = reactions[req.name].filter((u: string) => u !== user);
    if (reactions[req.name].length === 0) {
      delete reactions[req.name];
    }
  }

  db.run(`UPDATE messages SET reactions_json = ? WHERE ts = ?`, [JSON.stringify(reactions), req.timestamp]);

  return { ok: true };
}

// Get pending messages (for agent polling)
// includeBot=true returns ALL messages (UHUMAN + UBOT) for context understanding
export function getPendingMessages(channel: string, lastTs?: string, includeBot: boolean = false, limit: number = 100) {
  let query = includeBot
    ? `SELECT * FROM messages WHERE channel = ?`
    : `SELECT * FROM messages WHERE channel = ? AND user != 'UBOT'`;
  const params: (string | number)[] = [channel];

  if (lastTs) {
    // When lastTs is provided, get messages AFTER that timestamp (ascending order is correct)
    query += ` AND ts > ?`;
    params.push(lastTs);
    query += ` ORDER BY ts ASC LIMIT ?`;
    params.push(limit);
  } else {
    // When no lastTs, get the MOST RECENT messages (need DESC then reverse)
    query += ` ORDER BY ts DESC LIMIT ?`;
    params.push(limit);
  }

  let messages = db.query<Message, (string | number)[]>(query).all(...params);

  // If we fetched in DESC order (no lastTs), reverse to get chronological order
  if (!lastTs) {
    messages = messages.reverse();
  }

  // Enrich messages with seen_by and avatar_color
  const enrichedMessages = messages.map((msg) => {
    const slackMsg = toSlackMessage(msg);

    // Add seen_by for UHUMAN messages
    if (msg.user === "UHUMAN") {
      const seenBy = getMessageSeenBy(channel, msg.ts);
      const seenByWithColors = seenBy.map((agentId) => {
        const agent = getAgent(agentId, channel);
        return {
          agent_id: agentId,
          avatar_color: agent?.avatar_color || "#D97853",
          is_sleeping: agent?.is_sleeping === 1,
        };
      });
      slackMsg.seen_by = seenByWithColors;
    }

    // Add avatar_color and is_sleeping for agent messages
    if (msg.agent_id) {
      const agent = getAgent(msg.agent_id, channel);
      slackMsg.avatar_color = agent?.avatar_color || "#D97853";
      slackMsg.is_sleeping = agent?.is_sleeping === 1;
    }

    return slackMsg;
  });

  return {
    ok: true,
    messages: enrichedMessages,
  };
}

// GET /api/conversations.around - Fetch messages around a timestamp (for jumping to old messages)
export function getConversationAround(channel: string, ts: string, limit = 50) {
  const halfLimit = Math.floor(limit / 2);

  // Get the last acknowledged message for each agent (for seen_by)
  const lastSeenByAgents = getLastSeenByAgents(channel);

  // Fetch messages before the target timestamp (inclusive of target)
  const beforeMessages = db
    .query<Message, [string, string, number]>(
      `SELECT * FROM messages WHERE channel = ? AND thread_ts IS NULL AND ts <= ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(channel, ts, halfLimit + 1); // +1 to include target

  // Fetch messages after the target timestamp
  const afterMessages = db
    .query<Message, [string, string, number]>(
      `SELECT * FROM messages WHERE channel = ? AND thread_ts IS NULL AND ts > ? ORDER BY ts ASC LIMIT ?`,
    )
    .all(channel, ts, halfLimit + 1); // +1 to check has_more

  // Check if there are more messages in each direction
  const hasMoreOlder = beforeMessages.length > halfLimit;
  const hasMoreNewer = afterMessages.length > halfLimit;

  // Trim to limit
  if (hasMoreOlder) beforeMessages.pop();
  if (hasMoreNewer) afterMessages.pop();

  // Combine and sort
  const allMessages = [...beforeMessages.reverse(), ...afterMessages];

  // Enrich messages with seen_by and avatar_color
  const result = allMessages.map((msg) => {
    const slackMsg = toSlackMessage(msg);

    // Add seen_by for the LAST message each agent has acknowledged
    const agentsWithLastSeen = lastSeenByAgents.get(msg.ts);
    if (agentsWithLastSeen && agentsWithLastSeen.length > 0) {
      slackMsg.seen_by = agentsWithLastSeen.map((agentId) => {
        const agent = getAgent(agentId, channel);
        return {
          agent_id: agentId,
          avatar_color: agent?.avatar_color || "#D97853",
          is_sleeping: agent?.is_sleeping === 1,
        };
      });
    }

    // Add avatar_color and is_sleeping for agent messages
    if (msg.agent_id) {
      const agent = getAgent(msg.agent_id, channel);
      slackMsg.avatar_color = agent?.avatar_color || "#D97853";
      slackMsg.is_sleeping = agent?.is_sleeping === 1;
    }

    return slackMsg;
  });

  return {
    ok: true,
    messages: result,
    has_more_older: hasMoreOlder,
    has_more_newer: hasMoreNewer,
    target_ts: ts,
  };
}

// GET /api/conversations.newer - Fetch messages newer than a timestamp (for scrolling down)
export function getConversationNewer(channel: string, newestTs: string, limit = 50) {
  // Get the last acknowledged message for each agent (for seen_by)
  const lastSeenByAgents = getLastSeenByAgents(channel);

  // Fetch messages after the newest timestamp
  const messages = db
    .query<Message, [string, string, number]>(
      `SELECT * FROM messages WHERE channel = ? AND thread_ts IS NULL AND ts > ? ORDER BY ts ASC LIMIT ?`,
    )
    .all(channel, newestTs, limit + 1); // +1 to check has_more

  // Check if there are more messages
  const hasMoreNewer = messages.length > limit;
  if (hasMoreNewer) messages.pop();

  // Enrich messages with seen_by and avatar_color
  const result = messages.map((msg) => {
    const slackMsg = toSlackMessage(msg);

    // Add seen_by for the LAST message each agent has acknowledged
    const agentsWithLastSeen = lastSeenByAgents.get(msg.ts);
    if (agentsWithLastSeen && agentsWithLastSeen.length > 0) {
      slackMsg.seen_by = agentsWithLastSeen.map((agentId) => {
        const agent = getAgent(agentId, channel);
        return {
          agent_id: agentId,
          avatar_color: agent?.avatar_color || "#D97853",
          is_sleeping: agent?.is_sleeping === 1,
        };
      });
    }

    // Add avatar_color and is_sleeping for agent messages
    if (msg.agent_id) {
      const agent = getAgent(msg.agent_id, channel);
      slackMsg.avatar_color = agent?.avatar_color || "#D97853";
      slackMsg.is_sleeping = agent?.is_sleeping === 1;
    }

    return slackMsg;
  });

  return {
    ok: true,
    messages: result,
    has_more_newer: hasMoreNewer,
  };
}

// Clear all messages in a channel and reset agent history pointers.
// Only allowed for channels in CLEARABLE_CHANNELS.
export const CLEARABLE_CHANNELS = new Set(["demo"]);

export function clearChannelHistory(channel: string): { ok: boolean; error?: string } {
  if (!CLEARABLE_CHANNELS.has(channel)) {
    return { ok: false, error: "channel_not_clearable" };
  }
  // Delete all messages (including threads) for this channel
  db.run(`DELETE FROM messages WHERE channel = ?`, [channel]);
  // Delete conversation summaries so agents start fresh (no compressed history)
  db.run(`DELETE FROM summaries WHERE channel = ?`, [channel]);
  // Reset agent seen/processed pointers so agents re-read from scratch
  db.run(`DELETE FROM agent_seen WHERE channel = ?`, [channel]);
  return { ok: true };
}

// POST /api/chat.delete - Delete a message
export function deleteMessage(channel: string, ts: string) {
  // Lock check for space channels
  if (channel.includes(":space:")) {
    const space = db
      .query<{ locked: number }, [string]>(`SELECT locked FROM spaces WHERE space_channel = ?`)
      .get(channel);
    if (space?.locked) {
      return { ok: false, error: "space_is_locked" };
    }
  }

  const msg = db
    .query<Message, [string, string]>(`SELECT * FROM messages WHERE ts = ? AND channel = ?`)
    .get(ts, channel);

  if (!msg) {
    return { ok: false, error: "message_not_found" };
  }

  db.run(`DELETE FROM messages WHERE ts = ? AND channel = ?`, [ts, channel]);

  return { ok: true, channel, ts };
}
