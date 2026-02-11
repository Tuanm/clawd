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
 *   GET  /api/app.folders.list                - List directories (for folder picker)
 *
 * Project File Browser (read-only):
 *   GET  /api/app.project.tree?channel=<ch>&agent_id=<id>  - Get project directory tree
 *   GET  /api/app.project.listDir?channel=<ch>&agent_id=<id>&path=<p>  - List directory contents
 *   GET  /api/app.project.readFile?channel=<ch>&agent_id=<id>&path=<p> - Read file content
 */

import type { Database } from "bun:sqlite";
import type { WorkerManager } from "../worker-manager";

/** Available AI models */
const AVAILABLE_MODELS = [
  {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    description: "Fast and capable",
  },
  {
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5",
    description: "Most intelligent",
  },
  {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    description: "Fastest, lightweight",
  },
];

/** Initialize the channel_agents table in the database */
export function initAgentsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4.5',
      project TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%s', 'now')),
      UNIQUE(channel, agent_id)
    )
  `);

  // Add project column if table already exists without it
  try {
    db.exec(`ALTER TABLE channel_agents ADD COLUMN project TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists
  }
}

/** Register agent management API routes */
export function registerAgentRoutes(
  db: Database,
  workerManager: WorkerManager,
): (req: Request, url: URL, path: string, bunServer?: any) => Response | null {
  // Initialize table
  initAgentsTable(db);

  // Helper to check if request comes from localhost
  function isLocalRequest(req: Request, bunServer?: any): boolean {
    if (bunServer && typeof bunServer.requestIP === "function") {
      const ip = bunServer.requestIP(req);
      if (ip) {
        const addr = ip.address;
        return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
      }
    }
    // Fallback: check URL hostname
    try {
      const url = new URL(req.url);
      return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    } catch {
      return false;
    }
  }

  return (req: Request, url: URL, path: string, bunServer?: any): Response | null => {
    // List agents
    if (path === "/api/app.agents.list") {
      const channel = url.searchParams.get("channel");

      let agents: any[];
      if (channel) {
        agents = db
          .query(
            `SELECT ca.*, a.avatar_color FROM channel_agents ca
             LEFT JOIN agents a ON a.id = ca.agent_id AND a.channel = ca.channel
             WHERE ca.channel = ? ORDER BY ca.created_at ASC`,
          )
          .all(channel) as any[];
      } else {
        agents = db
          .query(
            `SELECT ca.*, a.avatar_color FROM channel_agents ca
             LEFT JOIN agents a ON a.id = ca.agent_id AND a.channel = ca.channel
             ORDER BY ca.channel, ca.created_at ASC`,
          )
          .all() as any[];
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
        if (!isLocalRequest(req, bunServer)) {
          return json({ ok: false, error: "forbidden: local access only" }, 403);
        }
        const body = await parseBody(req);
        const { channel, agent_id, model, project } = body;

        if (!channel || !agent_id) {
          return json({ ok: false, error: "channel and agent_id required" }, 400);
        }

        const agentModel = model || "claude-sonnet-4.5";
        const agentProject = project || "";

        try {
          db.run(
            `INSERT INTO channel_agents (channel, agent_id, model, project, active)
             VALUES (?, ?, ?, ?, 1)
             ON CONFLICT(channel, agent_id) DO UPDATE SET
               model = excluded.model,
               project = excluded.project,
               active = 1,
               updated_at = strftime('%s', 'now')`,
            [channel, agent_id, agentModel, agentProject],
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
          project: agentProject,
        });

        return json({
          ok: true,
          agent: {
            channel,
            agent_id,
            model: agentModel,
            project: agentProject,
            active: true,
            running: true,
          },
        });
      });
    }

    // Remove agent
    if (path === "/api/app.agents.remove" && req.method === "POST") {
      return handleAsync(async () => {
        if (!isLocalRequest(req, bunServer)) {
          return json({ ok: false, error: "forbidden: local access only" }, 403);
        }
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
        if (!isLocalRequest(req, bunServer)) {
          return json({ ok: false, error: "forbidden: local access only" }, 403);
        }
        const body = await parseBody(req);
        const { channel, agent_id, model, active, project } = body;

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
        if (project !== undefined) {
          updates.push("project = ?");
          params.push(project);
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

        // Restart worker if model changed, project changed, or active state changed
        if (model !== undefined || active !== undefined || project !== undefined) {
          if (agent.active === 1) {
            await workerManager.restartAgent({
              channel,
              agentId: agent_id,
              model: agent.model,
              active: true,
              project: agent.project || "",
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

    // List directories (for folder picker)
    if (path === "/api/app.folders.list") {
      const dir = url.searchParams.get("path") || process.env.HOME || "/";
      try {
        const { readdirSync } = require("node:fs");
        const { join } = require("node:path");
        const entries = readdirSync(dir, { withFileTypes: true });
        const folders = entries
          .filter((e: any) => e.isDirectory() && !e.name.startsWith("."))
          .map((e: any) => ({
            name: e.name,
            path: join(dir, e.name),
          }))
          .sort((a: any, b: any) => a.name.localeCompare(b.name));
        return json({ ok: true, path: dir, folders });
      } catch (error) {
        return json({ ok: false, error: String(error) }, 500);
      }
    }

    // ========================================================================
    // Project File Browser API (read-only)
    // ========================================================================

    // Get project directory tree for an agent
    if (path === "/api/app.project.tree") {
      const channel = url.searchParams.get("channel");
      const agentId = url.searchParams.get("agent_id");

      if (!channel || !agentId) {
        return json({ ok: false, error: "channel and agent_id required" }, 400);
      }

      // Get agent's project root from database
      const agent = db
        .query("SELECT project FROM channel_agents WHERE channel = ? AND agent_id = ?")
        .get(channel, agentId) as { project: string } | null;

      if (!agent || !agent.project) {
        return json({ ok: false, error: "agent not found or no project configured" }, 404);
      }

      const projectRoot = agent.project;

      try {
        const { readdirSync, statSync } = require("node:fs");
        const { join, relative } = require("node:path");

        // Patterns to ignore
        const IGNORE_PATTERNS = [
          "node_modules",
          ".git",
          "dist",
          "build",
          ".env",
          ".clawd",
          "__pycache__",
          ".venv",
          "vendor",
          ".next",
          ".nuxt",
          "coverage",
          ".cache",
          ".turbo",
        ];

        function shouldIgnore(name: string): boolean {
          return IGNORE_PATTERNS.includes(name) || name.startsWith(".");
        }

        interface TreeNode {
          name: string;
          type: "file" | "dir";
          path: string;
          size?: number;
          children?: TreeNode[];
        }

        function buildTree(dirPath: string, relativePath: string, depth: number): TreeNode[] {
          if (depth <= 0) return [];

          try {
            const entries = readdirSync(dirPath, { withFileTypes: true });
            const result: TreeNode[] = [];

            for (const entry of entries) {
              if (shouldIgnore(entry.name)) continue;

              const fullPath = join(dirPath, entry.name);
              const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

              if (entry.isDirectory()) {
                // If we can recurse (depth > 1), include children
                // Otherwise, set children to undefined for lazy loading
                result.push({
                  name: entry.name,
                  type: "dir",
                  path: relPath,
                  children: depth > 1 ? buildTree(fullPath, relPath, depth - 1) : undefined,
                });
              } else if (entry.isFile()) {
                try {
                  const stats = statSync(fullPath);
                  result.push({
                    name: entry.name,
                    type: "file",
                    path: relPath,
                    size: stats.size,
                  });
                } catch {
                  // Skip files we can't stat
                }
              }
            }

            // Sort: directories first, then files, alphabetically
            return result.sort((a, b) => {
              if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          } catch {
            return [];
          }
        }

        const tree = buildTree(projectRoot, "", 3); // Max depth of 3 initially
        return json({ ok: true, root: projectRoot, tree });
      } catch (error) {
        return json({ ok: false, error: String(error) }, 500);
      }
    }

    // List directory contents (lazy loading)
    if (path === "/api/app.project.listDir") {
      const channel = url.searchParams.get("channel");
      const agentId = url.searchParams.get("agent_id");
      const relativePath = url.searchParams.get("path") || "";

      if (!channel || !agentId) {
        return json({ ok: false, error: "channel and agent_id required" }, 400);
      }

      // Get agent's project root from database
      const agent = db
        .query("SELECT project FROM channel_agents WHERE channel = ? AND agent_id = ?")
        .get(channel, agentId) as { project: string } | null;

      if (!agent || !agent.project) {
        return json({ ok: false, error: "agent not found or no project configured" }, 404);
      }

      const projectRoot = agent.project;

      // Security: validate path
      if (relativePath.includes("..") || require("node:path").isAbsolute(relativePath)) {
        return json({ ok: false, error: "invalid path" }, 400);
      }

      const { join, resolve } = require("node:path");
      const fullPath = resolve(projectRoot, relativePath);

      // Ensure path is within project root
      if (!fullPath.startsWith(projectRoot)) {
        return json({ ok: false, error: "path outside project root" }, 400);
      }

      try {
        const { readdirSync, statSync } = require("node:fs");

        const IGNORE_PATTERNS = [
          "node_modules",
          ".git",
          "dist",
          "build",
          ".env",
          ".clawd",
          "__pycache__",
          ".venv",
          "vendor",
          ".next",
          ".nuxt",
          "coverage",
          ".cache",
          ".turbo",
        ];

        const entries = readdirSync(fullPath, { withFileTypes: true });
        const result: any[] = [];

        for (const entry of entries) {
          if (IGNORE_PATTERNS.includes(entry.name) || entry.name.startsWith(".")) continue;

          const entryFullPath = join(fullPath, entry.name);
          const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            result.push({
              name: entry.name,
              type: "dir",
              path: entryRelPath,
            });
          } else if (entry.isFile()) {
            try {
              const stats = statSync(entryFullPath);
              result.push({
                name: entry.name,
                type: "file",
                path: entryRelPath,
                size: stats.size,
              });
            } catch {
              // Skip files we can't stat
            }
          }
        }

        // Sort: directories first, then files, alphabetically
        result.sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        return json({ ok: true, path: relativePath, entries: result });
      } catch (error) {
        return json({ ok: false, error: String(error) }, 500);
      }
    }

    // Read file content (read-only)
    if (path === "/api/app.project.readFile") {
      const channel = url.searchParams.get("channel");
      const agentId = url.searchParams.get("agent_id");
      const relativePath = url.searchParams.get("path") || "";

      if (!channel || !agentId) {
        return json({ ok: false, error: "channel and agent_id required" }, 400);
      }

      if (!relativePath) {
        return json({ ok: false, error: "path required" }, 400);
      }

      // Get agent's project root from database
      const agent = db
        .query("SELECT project FROM channel_agents WHERE channel = ? AND agent_id = ?")
        .get(channel, agentId) as { project: string } | null;

      if (!agent || !agent.project) {
        return json({ ok: false, error: "agent not found or no project configured" }, 404);
      }

      const projectRoot = agent.project;

      // Security: validate path
      if (relativePath.includes("..") || require("node:path").isAbsolute(relativePath)) {
        return json({ ok: false, error: "invalid path" }, 400);
      }

      const { resolve } = require("node:path");
      const fullPath = resolve(projectRoot, relativePath);

      // Ensure path is within project root
      if (!fullPath.startsWith(projectRoot)) {
        return json({ ok: false, error: "path outside project root" }, 400);
      }

      try {
        const { readFileSync, statSync } = require("node:fs");

        const stats = statSync(fullPath);
        const MAX_FILE_SIZE = 500 * 1024; // 500KB limit

        let content: string;
        let truncated = false;

        if (stats.size > MAX_FILE_SIZE) {
          // Read only first 500KB
          const buffer = Buffer.alloc(MAX_FILE_SIZE);
          const fd = require("node:fs").openSync(fullPath, "r");
          require("node:fs").readSync(fd, buffer, 0, MAX_FILE_SIZE, 0);
          require("node:fs").closeSync(fd);
          content = buffer.toString("utf-8");
          truncated = true;
        } else {
          content = readFileSync(fullPath, "utf-8");
        }

        // Detect language from extension for syntax highlighting
        const ext = relativePath.split(".").pop()?.toLowerCase() || "";
        const languageMap: Record<string, string> = {
          ts: "typescript",
          tsx: "typescript",
          js: "javascript",
          jsx: "javascript",
          json: "json",
          md: "markdown",
          py: "python",
          rs: "rust",
          go: "go",
          rb: "ruby",
          java: "java",
          c: "c",
          cpp: "cpp",
          h: "c",
          hpp: "cpp",
          css: "css",
          scss: "scss",
          html: "html",
          xml: "xml",
          yaml: "yaml",
          yml: "yaml",
          toml: "toml",
          sh: "bash",
          bash: "bash",
          zsh: "bash",
          sql: "sql",
        };

        return json({
          ok: true,
          path: relativePath,
          content,
          size: stats.size,
          truncated,
          language: languageMap[ext] || "plaintext",
        });
      } catch (error) {
        return json({ ok: false, error: String(error) }, 500);
      }
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
