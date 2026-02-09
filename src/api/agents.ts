/**
 * Agent Management API
 *
 * REST endpoints for managing agents per channel.
 * These are registered on the clawd-chat server alongside existing routes.
 *
 * Endpoints:
 *   GET  /api/app.agents.list?channel=<ch>   - List agents (optionally per channel)
 *   POST /api/app.agents.add                  - Add agent to a channel
 *   POST /api/app.agents.remove               - Remove agent from a channel
 *   POST /api/app.agents.update               - Update agent config (model, active)
 *   GET  /api/app.agents.status               - Get worker loop status for all agents
 *   GET  /api/app.models.list                 - List available AI models
 */

import type { Database } from "bun:sqlite";
import type { WorkerManager } from "../worker-manager";

/** Available AI models */
const AVAILABLE_MODELS = [
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", description: "Fast and capable" },
  { id: "claude-opus-4", name: "Claude Opus 4", description: "Most intelligent" },
  { id: "claude-haiku-4", name: "Claude Haiku 4", description: "Fastest, lightweight" },
];

/** Initialize the channel_agents table in the database */
export function initAgentsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%s', 'now')),
      UNIQUE(channel, agent_id)
    )
  `);
}

/** Register agent management API routes */
export function registerAgentRoutes(
  db: Database,
  workerManager: WorkerManager,
): (req: Request, url: URL, path: string) => Response | null {
  // Initialize table
  initAgentsTable(db);

  return (req: Request, url: URL, path: string): Response | null => {
    // List agents
    if (path === "/api/app.agents.list") {
      const channel = url.searchParams.get("channel");

      let agents: any[];
      if (channel) {
        agents = db
          .query("SELECT * FROM channel_agents WHERE channel = ? ORDER BY created_at ASC")
          .all(channel) as any[];
      } else {
        agents = db.query("SELECT * FROM channel_agents ORDER BY channel, created_at ASC").all() as any[];
      }

      // Enrich with running status
      const enriched = agents.map((a: any) => ({
        ...a,
        active: a.active === 1,
        running: workerManager.isAgentRunning(a.channel, a.agent_id),
      }));

      return json({ ok: true, agents: enriched });
    }

    // Add agent
    if (path === "/api/app.agents.add" && req.method === "POST") {
      return handleAsync(async () => {
        const body = await parseBody(req);
        const { channel, agent_id, model } = body;

        if (!channel || !agent_id) {
          return json({ ok: false, error: "channel and agent_id required" }, 400);
        }

        const agentModel = model || "claude-sonnet-4";

        try {
          db.run(
            `INSERT INTO channel_agents (channel, agent_id, model, active)
             VALUES (?, ?, ?, 1)
             ON CONFLICT(channel, agent_id) DO UPDATE SET
               model = excluded.model,
               active = 1,
               updated_at = strftime('%s', 'now')`,
            [channel, agent_id, agentModel],
          );
        } catch (error) {
          return json({ ok: false, error: String(error) }, 500);
        }

        // Start the worker loop
        workerManager.startAgent({
          channel,
          agentId: agent_id,
          model: agentModel,
          active: true,
        });

        return json({
          ok: true,
          agent: { channel, agent_id, model: agentModel, active: true, running: true },
        });
      });
    }

    // Remove agent
    if (path === "/api/app.agents.remove" && req.method === "POST") {
      return handleAsync(async () => {
        const body = await parseBody(req);
        const { channel, agent_id } = body;

        if (!channel || !agent_id) {
          return json({ ok: false, error: "channel and agent_id required" }, 400);
        }

        // Stop the worker loop
        await workerManager.stopAgent(channel, agent_id);

        // Remove from database
        db.run("DELETE FROM channel_agents WHERE channel = ? AND agent_id = ?", [channel, agent_id]);

        return json({ ok: true, channel, agent_id });
      });
    }

    // Update agent config
    if (path === "/api/app.agents.update" && req.method === "POST") {
      return handleAsync(async () => {
        const body = await parseBody(req);
        const { channel, agent_id, model, active } = body;

        if (!channel || !agent_id) {
          return json({ ok: false, error: "channel and agent_id required" }, 400);
        }

        // Update database
        const updates: string[] = [];
        const params: any[] = [];

        if (model !== undefined) {
          updates.push("model = ?");
          params.push(model);
        }
        if (active !== undefined) {
          updates.push("active = ?");
          params.push(active ? 1 : 0);
        }

        if (updates.length === 0) {
          return json({ ok: false, error: "nothing to update" }, 400);
        }

        updates.push("updated_at = strftime('%s', 'now')");
        params.push(channel, agent_id);

        db.run(`UPDATE channel_agents SET ${updates.join(", ")} WHERE channel = ? AND agent_id = ?`, params);

        // Get updated record
        const agent = db
          .query("SELECT * FROM channel_agents WHERE channel = ? AND agent_id = ?")
          .get(channel, agent_id) as any;

        if (!agent) {
          return json({ ok: false, error: "agent_not_found" }, 404);
        }

        // Restart worker if model changed or active state changed
        if (model !== undefined || active !== undefined) {
          if (agent.active === 1) {
            await workerManager.restartAgent({
              channel,
              agentId: agent_id,
              model: agent.model,
              active: true,
            });
          } else {
            await workerManager.stopAgent(channel, agent_id);
          }
        }

        return json({
          ok: true,
          agent: {
            ...agent,
            active: agent.active === 1,
            running: workerManager.isAgentRunning(channel, agent_id),
          },
        });
      });
    }

    // Get worker status
    if (path === "/api/app.agents.status") {
      const status = workerManager.getStatus();
      return json({ ok: true, workers: status });
    }

    // List available models
    if (path === "/api/app.models.list") {
      return json({ ok: true, models: AVAILABLE_MODELS });
    }

    // Not handled
    return null;
  };
}

// ============================================================================
// Helpers
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function parseBody(req: Request): Promise<Record<string, any>> {
  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return (await req.json()) as Record<string, any>;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    return Object.fromEntries(params);
  }

  return {};
}

/** Handle an async route handler that returns a Response promise */
function handleAsync(fn: () => Promise<Response>): Response {
  // Bun.serve handles promises returned from fetch(), so we can
  // return the promise directly. But for type safety, we wrap.
  return fn() as any;
}
