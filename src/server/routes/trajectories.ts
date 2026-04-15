/**
 * Trajectory export endpoint for RL training data.
 * GET /api/trajectories — export turns as JSON or JSONL
 * POST /api/trajectories/:id/reward — label a turn with +1/-1 reward
 */

import { db } from "../database";

interface TrajectoryRow {
  id: number;
  session_id: string;
  channel: string;
  agent_id: string;
  turn_index: number;
  user_message: string | null;
  tool_calls_json: string | null;
  assistant_response: string | null;
  reward: number | null;
  created_at: number;
}

export function handleTrajectoriesRequest(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);

  // POST /api/trajectories/:id/reward
  const rewardMatch = url.pathname.match(/^\/api\/trajectories\/(\d+)\/reward$/);
  if (rewardMatch && req.method === "POST") {
    return handleRewardLabel(req, parseInt(rewardMatch[1], 10), url.searchParams.get("channel"));
  }

  // GET /api/trajectories
  if (url.pathname === "/api/trajectories" && req.method === "GET") {
    return handleExport(url);
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function handleExport(url: URL): Response {
  const channel = url.searchParams.get("channel");
  const agentId = url.searchParams.get("agent_id");
  const from = url.searchParams.get("from"); // unix timestamp
  const to = url.searchParams.get("to");
  // Synchronous in-memory load — cap conservatively until streaming is implemented
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100), 200);
  const format = url.searchParams.get("format") ?? "json"; // "json" | "jsonl"
  const labeledOnly = url.searchParams.get("labeled") === "true";

  if (!channel) {
    return new Response(JSON.stringify({ error: "channel parameter is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const fromTs = from ? parseInt(from, 10) : null;
  const toTs = to ? parseInt(to, 10) : null;
  if (fromTs !== null && isNaN(fromTs)) {
    return new Response(JSON.stringify({ error: "invalid 'from' parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (toTs !== null && isNaN(toTs)) {
    return new Response(JSON.stringify({ error: "invalid 'to' parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const conditions: string[] = [];
  const params: any[] = [];

  conditions.push("channel = ?");
  params.push(channel);
  if (agentId) {
    conditions.push("agent_id = ?");
    params.push(agentId);
  }
  if (fromTs !== null) {
    conditions.push("created_at >= ?");
    params.push(fromTs);
  }
  if (toTs !== null) {
    conditions.push("created_at <= ?");
    params.push(toTs);
  }
  if (labeledOnly) {
    conditions.push("reward IS NOT NULL");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const rows = db
    .query<TrajectoryRow, any[]>(`SELECT * FROM trajectories ${where} ORDER BY created_at ASC LIMIT ?`)
    .all(...params);

  if (format === "jsonl") {
    // OpenAI fine-tuning format
    const lines = rows.map((row) => {
      const msgs: Array<{ role: string; content: string }> = [];
      if (row.user_message) msgs.push({ role: "user", content: row.user_message });
      // Include tool calls as a structured assistant message if present
      if (row.tool_calls_json) {
        try {
          const calls = JSON.parse(row.tool_calls_json) as Array<{ name: string; result: string }>;
          const summary = calls.map((c) => `[${c.name}]: ${(c.result || "").slice(0, 200)}`).join("\n");
          msgs.push({ role: "tool", content: summary });
        } catch {
          // skip malformed
        }
      }
      if (row.assistant_response) msgs.push({ role: "assistant", content: row.assistant_response });
      return JSON.stringify({ messages: msgs, reward: row.reward });
    });
    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": "attachment; filename=trajectories.jsonl",
      },
    });
  }

  return new Response(JSON.stringify({ trajectories: rows, count: rows.length }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleRewardLabel(req: Request, id: number, channel: string | null): Promise<Response> {
  if (!channel) {
    return new Response(JSON.stringify({ error: "channel parameter is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const body = (await req.json()) as { reward: number };
    if (body.reward !== 1 && body.reward !== -1) {
      return new Response(JSON.stringify({ error: "reward must be 1 or -1" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = db.run("UPDATE trajectories SET reward = ? WHERE id = ? AND channel = ?", [
      body.reward,
      id,
      channel,
    ]);
    if (result.changes === 0) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const isJsonError = err instanceof SyntaxError;
    return new Response(JSON.stringify({ error: isJsonError ? "invalid JSON body" : "internal error" }), {
      status: isJsonError ? 400 : 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
