import { db } from "../database";

export interface Channel {
  id: string;
  name: string;
  created_by: string;
  created_at: number;
}

// GET /api/conversations.list
export function listChannels() {
  const channels = db.query<Channel, []>(`SELECT * FROM channels ORDER BY created_at DESC`).all();

  return {
    ok: true,
    channels: channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      is_channel: true,
      created: ch.created_at,
    })),
  };
}

// POST /api/conversations.create
export function createChannel(name: string, userId = "UHUMAN") {
  if (name.includes(":")) {
    return { ok: false, error: "Channel names cannot contain ':' (reserved for sub-spaces)" };
  }

  // Use name as ID — the entire system (worker loops, messages, agent_seen, spaces)
  // references channels by name, not by generated ID.
  const id = name;

  db.run(`INSERT INTO channels (id, name, created_by) VALUES (?, ?, ?)`, [id, name, userId]);

  return {
    ok: true,
    channel: { id, name, is_channel: true },
  };
}

// POST /api/conversations.info
export function getChannelInfo(channelId: string) {
  const channel = db.query<Channel, [string]>(`SELECT * FROM channels WHERE id = ?`).get(channelId);

  if (!channel) {
    return { ok: false, error: "channel_not_found" };
  }

  return {
    ok: true,
    channel: {
      id: channel.id,
      name: channel.name,
      is_channel: true,
      created: channel.created_at,
    },
  };
}
