import { db } from "../server/database";
import { getOrRegisterAgent } from "../server/database";

export interface Space {
  id: string;
  channel: string;
  space_channel: string;
  title: string;
  description: string | null;
  agent_id: string;
  agent_color: string;
  status: "active" | "completed" | "failed" | "timed_out";
  source: string;
  source_id: string | null;
  card_message_ts: string | null;
  timeout_seconds: number;
  created_at: number;
  completed_at: number | null;
  result_summary: string | null;
  locked: number;
}

export interface CreateSpaceParams {
  id: string;
  channel: string;
  title: string;
  description?: string;
  agent_id: string;
  agent_color: string;
  source: string;
  source_id?: string;
  timeout_seconds?: number;
}

export function createSpaceRecord(params: CreateSpaceParams): Space {
  const spaceChannel = `${params.channel}:space:${params.id}`;
  const now = Date.now();

  const txn = db.transaction(() => {
    // SP4: Validate parent channel exists
    const parent = db.query<{ id: string }, [string]>(`SELECT id FROM channels WHERE id = ?`).get(params.channel);
    if (!parent) {
      throw new Error(`Parent channel '${params.channel}' does not exist`);
    }

    // Direct INSERT for space channel (NOT using createChannel — it generates its own IDs)
    db.run(`INSERT INTO channels (id, name, created_by) VALUES (?, ?, ?)`, [spaceChannel, spaceChannel, "UBOT"]);

    // Register agent for this space channel (non-worker to get proper avatar color)
    getOrRegisterAgent(params.agent_id, spaceChannel, false);

    // Insert space record
    db.run(
      `INSERT INTO spaces (id, channel, space_channel, title, description, agent_id, agent_color, source, source_id, timeout_seconds, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.id,
        params.channel,
        spaceChannel,
        params.title,
        params.description || null,
        params.agent_id,
        params.agent_color,
        params.source,
        params.source_id || null,
        params.timeout_seconds || 300,
        now,
      ],
    );
  });

  txn();

  return getSpace(params.id)!;
}

export function getSpace(id: string): Space | null {
  return db.query<Space, [string]>(`SELECT * FROM spaces WHERE id = ?`).get(id) || null;
}

export function getSpaceByChannel(spaceChannel: string): Space | null {
  return db.query<Space, [string]>(`SELECT * FROM spaces WHERE space_channel = ?`).get(spaceChannel) || null;
}

export function listSpaces(channel: string, status?: string): Space[] {
  if (status) {
    return db
      .query<Space, [string, string]>(`SELECT * FROM spaces WHERE channel = ? AND status = ? ORDER BY created_at DESC`)
      .all(channel, status);
  }
  return db.query<Space, [string]>(`SELECT * FROM spaces WHERE channel = ? ORDER BY created_at DESC`).all(channel);
}

export function atomicLockSpace(id: string, status: string, resultOrError?: string): boolean {
  const now = Date.now();
  const result = db.run(
    `UPDATE spaces SET locked = 1, status = ?, completed_at = ?, result_summary = ? WHERE id = ? AND locked = 0`,
    [status, now, resultOrError || null, id],
  );
  return result.changes > 0;
}

export function updateCardTs(id: string, ts: string) {
  db.run(`UPDATE spaces SET card_message_ts = ? WHERE id = ?`, [ts, id]);
}

export function getActiveSpaces(): Space[] {
  return db.query<Space, []>(`SELECT * FROM spaces WHERE status = 'active' AND locked = 0`).all();
}

export function deleteSpaceAgents(spaceChannel: string): void {
  db.run(`DELETE FROM agents WHERE channel = ?`, [spaceChannel]);
}
