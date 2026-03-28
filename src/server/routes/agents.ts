/**
 * Agent status route handlers.
 *
 * Handles agent polling, seen/processed tracking, status, streaming, and
 * human user read-tracking endpoints.
 */

import { Database } from "bun:sqlite";
import { z } from "zod";
import { getDataDir } from "../../config-file";
import { validateBody } from "../validate";
import {
  db,
  getAgent,
  getOrRegisterAgent,
  listAgents,
  markMessagesSeen,
  setAgentSleeping,
  setAgentStreaming,
  toSlackMessage,
  type Message,
} from "../database";
import {
  broadcastAgentStreaming,
  broadcastAgentToken,
  broadcastAgentToolCall,
  broadcastMessageSeen,
  broadcastUpdate,
} from "../websocket";
import { json, numParam, parseBody } from "../http-helpers";
import { getPendingMessages } from "./messages";

// ---------------------------------------------------------------------------
// Lazy-loaded read-only connection to memory.db (for agent thoughts API)
// ---------------------------------------------------------------------------

let _memoryDb: InstanceType<typeof Database> | null = null;
function getMemoryDb(): InstanceType<typeof Database> {
  if (!_memoryDb) {
    const memPath = `${getDataDir()}/memory.db`;
    _memoryDb = new Database(memPath, { readonly: true });
    _memoryDb.exec("PRAGMA journal_mode = WAL");
    _memoryDb.exec("PRAGMA busy_timeout = 5000");
  }
  return _memoryDb;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleAgentStatusRoutes(req: Request, url: URL, path: string): Promise<Response | null> {
  // Agent polling
  if (path === "/api/messages.pending") {
    const channel = url.searchParams.get("channel") || "general";
    const lastTs = url.searchParams.get("last_ts");
    const includeBot = url.searchParams.get("include_bot") === "true";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 200);
    return json(getPendingMessages(channel, lastTs || undefined, includeBot, limit));
  }

  // Agent mark seen
  if (path === "/api/agent.markSeen" && req.method === "POST") {
    const body = await parseBody(req);
    const agentId = body.agent_id || "default";
    const channel = body.channel || "general";
    const lastSeenTs = body.last_seen_ts;
    if (!lastSeenTs) return json({ ok: false, error: "last_seen_ts required" }, 400);

    getOrRegisterAgent(agentId, channel);
    const nowTs = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_poll_ts, updated_at)
       VALUES (?, ?, ?, ?, strftime('%s', 'now'))
       ON CONFLICT(agent_id, channel) DO UPDATE SET
         last_seen_ts = excluded.last_seen_ts,
         last_poll_ts = excluded.last_poll_ts,
         updated_at = strftime('%s', 'now')`,
      [agentId, channel, lastSeenTs, nowTs],
    );

    const messagesToMark = db
      .query<{ ts: string }, [string, string, string, number]>(
        `SELECT ts FROM messages WHERE channel = ? AND ts <= ? AND (agent_id IS NULL OR agent_id != ?) ORDER BY ts DESC LIMIT ?`,
      )
      .all(channel, lastSeenTs, agentId, 200);
    if (messagesToMark.length > 0) {
      markMessagesSeen(
        channel,
        agentId,
        messagesToMark.map((m) => m.ts),
      );
    }

    db.run(
      `UPDATE agent_status SET status = 'ready', hibernate_until = NULL, updated_at = strftime('%s', 'now')
       WHERE agent_id = ? AND channel = ? AND status = 'hibernate'`,
      [agentId, channel],
    );

    broadcastUpdate(channel, {
      type: "agent_seen",
      agent_id: agentId,
      last_seen_ts: lastSeenTs,
    });
    const lastNonSelfMsg = db
      .query<{ ts: string }, [string, string, string]>(
        `SELECT ts FROM messages WHERE channel = ? AND ts <= ? AND (agent_id IS NULL OR agent_id != ?) ORDER BY ts DESC LIMIT 1`,
      )
      .get(channel, lastSeenTs, agentId);
    if (lastNonSelfMsg) broadcastMessageSeen(channel, lastNonSelfMsg.ts, agentId);
    broadcastUpdate(channel, {
      type: "agent_status",
      agent_id: agentId,
      status: "ready",
      hibernate_until: null,
    });

    return json({
      ok: true,
      agent_id: agentId,
      channel,
      last_seen_ts: lastSeenTs,
    });
  }

  // Get last seen
  if (path === "/api/agent.getLastSeen") {
    const agentId = url.searchParams.get("agent_id") || "default";
    const channel = url.searchParams.get("channel") || "general";
    const result = db
      .query<{ last_seen_ts: string }, [string, string]>(
        `SELECT last_seen_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
      )
      .get(agentId, channel);
    return json({
      ok: true,
      agent_id: agentId,
      channel,
      last_seen_ts: result?.last_seen_ts || null,
    });
  }

  // Mark processed
  if (path === "/api/agent.markProcessed" && req.method === "POST") {
    const body = await parseBody(req);
    const agentId = body.agent_id || "default";
    const channel = body.channel || "general";
    const lastProcessedTs = body.last_processed_ts;
    if (!lastProcessedTs) return json({ ok: false, error: "last_processed_ts required" }, 400);

    db.run(
      `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
       VALUES (?, ?, ?, ?, strftime('%s', 'now'))
       ON CONFLICT(agent_id, channel) DO UPDATE SET
       last_processed_ts = excluded.last_processed_ts, updated_at = excluded.updated_at`,
      [agentId, channel, lastProcessedTs, lastProcessedTs],
    );
    broadcastUpdate(channel, {
      type: "agent_processed",
      agent_id: agentId,
      last_processed_ts: lastProcessedTs,
    });
    return json({
      ok: true,
      agent_id: agentId,
      channel,
      last_processed_ts: lastProcessedTs,
    });
  }

  // Set sleeping
  if (path === "/api/agent.setSleeping" && req.method === "POST") {
    const body = await parseBody(req);
    const agentId = body.agent_id;
    const channel = body.channel || "general";
    const isSleeping = body.is_sleeping === true || body.is_sleeping === 1;
    if (!agentId) return json({ ok: false, error: "agent_id required" }, 400);
    const success = setAgentSleeping(agentId, channel, isSleeping);
    if (success)
      broadcastUpdate(channel, {
        type: "agent_sleep",
        agent_id: agentId,
        is_sleeping: isSleeping,
      });
    return json({
      ok: success,
      agent_id: agentId,
      channel,
      is_sleeping: isSleeping,
    });
  }

  // Set streaming
  if (path === "/api/agent.setStreaming" && req.method === "POST") {
    const body = await parseBody(req);
    const agentId = body.agent_id;
    const channel = body.channel || "general";
    const isStreaming = body.is_streaming === true || body.is_streaming === 1;
    if (!agentId) return json({ ok: false, error: "agent_id required" }, 400);
    const success = setAgentStreaming(agentId, channel, isStreaming);
    if (success) broadcastAgentStreaming(channel, agentId, isStreaming);
    return json({
      ok: success,
      agent_id: agentId,
      channel,
      is_streaming: isStreaming,
    });
  }

  // Stream token
  if (path === "/api/agent.streamToken" && req.method === "POST") {
    const body = await parseBody(req);
    const agentId = body.agent_id;
    const channel = body.channel || "general";
    if (!agentId) return json({ ok: false, error: "agent_id required" }, 400);
    broadcastAgentToken(channel, agentId, body.token || "", body.token_type || "content");
    return json({ ok: true, agent_id: agentId, channel });
  }

  // Stream tool call
  if (path === "/api/agent.streamToolCall" && req.method === "POST") {
    const body = await parseBody(req);
    const agentId = body.agent_id;
    const channel = body.channel || "general";
    if (!agentId || !body.tool_name) return json({ ok: false, error: "agent_id and tool_name required" }, 400);
    broadcastAgentToolCall(
      channel,
      agentId,
      body.tool_name,
      body.tool_args || {},
      body.status || "started",
      body.result,
    );
    return json({
      ok: true,
      agent_id: agentId,
      channel,
      tool_name: body.tool_name,
      status: body.status || "started",
    });
  }

  // Get last processed
  if (path === "/api/agent.getLastProcessed") {
    const agentId = url.searchParams.get("agent_id") || "default";
    const channel = url.searchParams.get("channel") || "general";
    const result = db
      .query<{ last_processed_ts: string | null }, [string, string]>(
        `SELECT last_processed_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
      )
      .get(agentId, channel);
    return json({
      ok: true,
      agent_id: agentId,
      channel,
      last_processed_ts: result?.last_processed_ts || null,
    });
  }

  // Set last_processed_ts — used by continuation cap to force-mark messages as processed
  if (path === "/api/agent.setLastProcessed" && req.method === "POST") {
    const body = await parseBody(req);
    const agentId = body.agent_id || "default";
    const channel = body.channel || "general";
    const lastProcessedTs = body.last_processed_ts ?? null;
    if (!lastProcessedTs) return json({ ok: false, error: "last_processed_ts required" }, 400);

    getOrRegisterAgent(agentId, channel);
    db.run(
      `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
       VALUES (?, ?, ?, ?, strftime('%s', 'now'))
       ON CONFLICT(agent_id, channel) DO UPDATE SET
         last_processed_ts = excluded.last_processed_ts,
         updated_at = strftime('%s', 'now')`,
      [agentId, channel, lastProcessedTs, lastProcessedTs],
    );
    broadcastUpdate(channel, {
      type: "agent_processed",
      agent_id: agentId,
      last_processed_ts: lastProcessedTs,
    });
    return json({
      ok: true,
      agent_id: agentId,
      channel,
      last_processed_ts: lastProcessedTs,
    });
  }

  // Agent status
  if (path === "/api/agent.setStatus" && req.method === "POST") {
    const body = await parseBody(req);
    const agentId = body.agent_id || "default";
    const channel = body.channel || "general";
    const status = body.status || "ready";
    const hibernateUntil = body.hibernate_until || null;
    db.run(
      `INSERT INTO agent_status (agent_id, channel, status, hibernate_until, updated_at)
       VALUES (?, ?, ?, ?, strftime('%s', 'now'))
       ON CONFLICT(agent_id, channel) DO UPDATE SET
         status = excluded.status, hibernate_until = excluded.hibernate_until, updated_at = strftime('%s', 'now')`,
      [agentId, channel, status, hibernateUntil],
    );
    broadcastUpdate(channel, {
      type: "agent_status",
      agent_id: agentId,
      status,
      hibernate_until: hibernateUntil,
    });
    return json({
      ok: true,
      agent_id: agentId,
      channel,
      status,
      hibernate_until: hibernateUntil,
    });
  }

  if (path === "/api/agent.getStatus") {
    const agentId = url.searchParams.get("agent_id") || "default";
    const channel = url.searchParams.get("channel") || "general";
    const statusResult = db
      .query<{ status: string; hibernate_until: string | null }, [string, string]>(
        `SELECT status, hibernate_until FROM agent_status WHERE agent_id = ? AND channel = ?`,
      )
      .get(agentId, channel);
    const seenResult = db
      .query<{ last_poll_ts: number | null }, [string, string]>(
        `SELECT last_poll_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
      )
      .get(agentId, channel);

    const HIBERNATE_TIMEOUT = 600;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const lastPollTs = seenResult?.last_poll_ts;
    const isAutoHibernate = lastPollTs ? nowSeconds - lastPollTs > HIBERNATE_TIMEOUT : true;
    let finalStatus = statusResult?.status || "ready";
    if (!lastPollTs || isAutoHibernate) finalStatus = "hibernate";

    return json({
      ok: true,
      agent_id: agentId,
      channel,
      status: finalStatus,
      hibernate_until: statusResult?.hibernate_until || null,
      last_poll_ts: lastPollTs || null,
      auto_hibernate: isAutoHibernate,
    });
  }

  // List agents in channel
  if (path === "/api/agents.list") {
    const channel = url.searchParams.get("channel") || "general";
    return json({ ok: true, channel, agents: listAgents(channel) });
  }

  if (path === "/api/agents.info") {
    const agentId = url.searchParams.get("agent_id");
    const channel = url.searchParams.get("channel") || "general";
    if (!agentId) return json({ ok: false, error: "agent_id required" }, 400);
    const agent = getAgent(agentId, channel);
    if (!agent) return json({ ok: false, error: "agent_not_found" }, 404);
    return json({ ok: true, agent });
  }

  if (path === "/api/agents.register" && req.method === "POST") {
    const body = await parseBody(req);
    const v = validateBody(
      z.object({
        agent_id: z.string().min(1),
        channel: z.string().optional(),
        model: z.string().optional(),
        is_worker: z.boolean().optional(),
      }),
      body,
    );
    if (!v.ok) return v.error;
    const channel = v.data.channel || "general";
    const agent = getOrRegisterAgent(v.data.agent_id, channel, v.data.is_worker || false);
    broadcastUpdate(channel, { type: "agent_joined", agent });
    return json({ ok: true, agent });
  }

  // Agent thoughts — fetch historical stream entries from memory.db
  if (path === "/api/agent.getThoughts") {
    const agentId = url.searchParams.get("agent_id");
    const channel = url.searchParams.get("channel") || "general";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);
    if (!agentId) return json({ ok: false, error: "agent_id required" }, 400);

    try {
      const mdb = getMemoryDb();
      const sessionName = `${channel}-${agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const session = mdb
        .query<{ id: string }, [string]>("SELECT id FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1")
        .get(sessionName);
      if (!session) return json({ ok: true, entries: [] });

      // Fetch latest messages (ordered oldest-first for display)
      const rows = mdb
        .query<
          {
            id: number;
            role: string;
            content: string | null;
            tool_calls: string | null;
            tool_call_id: string | null;
            created_at: number;
          },
          [string, number]
        >(
          `SELECT id, role, content, tool_calls, tool_call_id, created_at
           FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(session.id, limit)
        .reverse();

      // Map to StreamEntry[] format
      type Entry = {
        type: string;
        text: string;
        timestamp: number;
        toolName?: string;
        toolArgs?: any;
      };
      const entries: Entry[] = [];

      // Build tool_call_id → tool_name lookup from assistant messages
      const toolCallNames = new Map<string, string>();
      for (const row of rows) {
        if (row.role === "assistant" && row.tool_calls) {
          try {
            for (const call of JSON.parse(row.tool_calls)) {
              if (call.id && call.function?.name) toolCallNames.set(call.id, call.function.name);
            }
          } catch {}
        }
      }

      for (const row of rows) {
        if (row.role === "assistant") {
          // Content text → thinking/content entry
          if (row.content) {
            entries.push({
              type: "content",
              text: row.content,
              timestamp: row.created_at,
            });
          }
          // Tool calls → tool_start entries
          if (row.tool_calls) {
            try {
              const calls = JSON.parse(row.tool_calls);
              for (const call of calls) {
                const fn = call.function || {};
                let args: any = {};
                try {
                  args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments || {};
                } catch {}
                entries.push({
                  type: "tool_start",
                  text: "",
                  timestamp: row.created_at,
                  toolName: fn.name || "unknown",
                  toolArgs: args,
                });
              }
            } catch {}
          }
        } else if (row.role === "tool") {
          entries.push({
            type: "tool_end",
            text: (row.content || "").slice(0, 2000),
            timestamp: row.created_at,
            toolName: toolCallNames.get(row.tool_call_id || "") || "result",
          });
        }
        // Skip user/system messages — not agent "thoughts"
      }

      return json({ ok: true, entries });
    } catch (err: any) {
      return json({ ok: false, error: err.message || "Failed to read memory.db" }, 500);
    }
  }

  // Channel status
  if (path === "/api/channel.status") {
    const channel = url.searchParams.get("channel") || "general";
    const HIBERNATE_TIMEOUT = 600;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const agents = listAgents(channel);
    const agentStatuses = [];
    let anyOnline = false;

    for (const agent of agents) {
      if ((agent as any).is_worker) continue;
      const seenResult = db
        .query<{ last_poll_ts: number | null }, [string, string]>(
          `SELECT last_poll_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
        )
        .get((agent as any).id, channel);
      const lastPollTs = seenResult?.last_poll_ts;
      const isOnline = lastPollTs ? nowSeconds - lastPollTs <= HIBERNATE_TIMEOUT : false;
      if (isOnline) anyOnline = true;
      agentStatuses.push({
        agent_id: (agent as any).id,
        avatar_color: (agent as any).avatar_color,
        status: isOnline ? "online" : "offline",
        last_poll_ts: lastPollTs,
      });
    }
    return json({
      ok: true,
      channel,
      status: anyOnline ? "online" : "offline",
      agents: agentStatuses,
    });
  }

  // Get message by ts
  if (path === "/api/messages.get") {
    const ts = url.searchParams.get("ts");
    if (!ts) return json({ ok: false, error: "ts required" }, 400);
    const msg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(ts);
    if (!msg) return json({ ok: false, error: "message_not_found" }, 404);
    return json({ ok: true, message: toSlackMessage(msg) });
  }

  // ========================================================================
  // Human User Read Tracking
  // ========================================================================

  if (path === "/api/user.markSeen" && req.method === "POST") {
    const body = await parseBody(req);
    const channel = body.channel || "general";
    const ts = body.ts;
    if (!ts) return json({ ok: false, error: "ts required" }, 400);

    const HUMAN_USER_ID = "UHUMAN";
    const nowTs = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_poll_ts, updated_at)
       VALUES (?, ?, ?, ?, strftime('%s', 'now'))
       ON CONFLICT(agent_id, channel) DO UPDATE SET
         last_seen_ts = excluded.last_seen_ts,
         last_poll_ts = excluded.last_poll_ts,
         updated_at = strftime('%s', 'now')`,
      [HUMAN_USER_ID, channel, ts, nowTs],
    );
    return json({ ok: true, channel, ts });
  }

  if (path === "/api/user.getUnreadCounts") {
    const channelsParam = url.searchParams.get("channels") || "";
    const channels = channelsParam ? channelsParam.split(",") : [];
    if (channels.length === 0) return json({ ok: true, counts: {} });

    const HUMAN_USER_ID = "UHUMAN";
    const counts: Record<string, number> = {};
    for (const channel of channels) {
      const seenResult = db
        .query<{ last_seen_ts: string }, [string, string]>(
          `SELECT last_seen_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
        )
        .get(HUMAN_USER_ID, channel);
      const lastSeenTs = seenResult?.last_seen_ts || "0";
      const countResult = db
        .query<{ count: number }, [string, string]>(
          `SELECT COUNT(*) as count FROM messages WHERE channel = ? AND ts > ?`,
        )
        .get(channel, lastSeenTs);
      counts[channel] = countResult?.count || 0;
    }
    return json({ ok: true, counts });
  }

  if (path === "/api/user.getLastSeen") {
    const channel = url.searchParams.get("channel") || "general";
    const HUMAN_USER_ID = "UHUMAN";
    const result = db
      .query<{ last_seen_ts: string }, [string, string]>(
        `SELECT last_seen_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
      )
      .get(HUMAN_USER_ID, channel);
    return json({
      ok: true,
      channel,
      last_seen_ts: result?.last_seen_ts || null,
    });
  }

  return null;
}
