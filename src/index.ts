/**
 * Claw'd App
 *
 * Combines:
 * - clawd-chat server (HTTP/WebSocket API + SQLite)
 * - clawd-chat UI (static React SPA)
 * - Worker manager (per-channel agent polling loops)
 * - Agent management API (add/remove/configure agents)
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";

// Check for --help BEFORE importing other modules (to avoid database initialization)
let parsedArgs: ReturnType<typeof parseArgs>;
try {
  parsedArgs = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      host: { type: "string" },
      port: { type: "string", short: "p" },
      "no-browser": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      debug: { type: "boolean" },
      yolo: { type: "boolean" },
    },
    allowPositionals: false,
  });
} catch (error: any) {
  if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const match = error.message?.match(/Unknown option '(.+?)'/);
    const unknownOpt = match ? match[1] : "unknown";
    console.error(`Error: Unknown option '${unknownOpt}'`);
    console.error("");
    console.log(`Claw'd App

Usage: clawd-app [options]

Options:
  --host <host>                Server host (default: 0.0.0.0)
  -p, --port <port>           Server port (default: 3456)
  --no-browser                 Don't open browser on startup
  --yolo                      Disable sandbox restrictions for agents
  --debug                     Enable debug logging
  -h, --help                  Show this help message

  Settings can also be configured in ~/.clawd/config.json.
  CLI flags take precedence over config file values.

Examples:
  clawd-app
  clawd-app --host localhost --port 8080
  clawd-app --no-browser --debug
`);
    process.exit(1);
  }
  throw error;
}

if (parsedArgs.values.help) {
  console.log(`Claw'd App

Usage: clawd-app [options]

Options:
  --host <host>                Server host (default: 0.0.0.0)
  -p, --port <port>           Server port (default: 3456)
  --no-browser                 Don't open browser on startup
  --yolo                      Disable sandbox restrictions for agents
  --debug                     Enable debug logging
  -h, --help                  Show this help message

  Settings can also be configured in ~/.clawd/config.json.
  CLI flags take precedence over config file values.

Examples:
  clawd-app
  clawd-app --host localhost --port 8080
  clawd-app --no-browser --debug
`);
  process.exit(0);
}

// Now import modules (database will initialize)
import { registerAgentRoutes } from "./api/agents";
import { registerArticleRoutes } from "./api/articles";
import { loadConfig, validateConfig } from "./config";
import { loadConfigFile } from "./config-file";
import { getEmbeddedAsset, hasEmbeddedUI, embeddedUIFileCount, embeddedUITotalSize } from "./embedded-ui";
import { WorkerManager } from "./worker-manager";
import { setDebug } from "./agent/src/utils/debug";

// Load configuration from CLI args + config file
const config = loadConfig();

// Enable debug mode if configured
if (config.debug) {
  setDebug(true);
}

// Validate config
if (!validateConfig(config)) {
  process.exit(1);
}

// ============================================================================
// Import clawd-chat server modules
// ============================================================================
import {
  clearStaleStreamingStates,
  db,
  getAgent,
  getOrRegisterAgent,
  listAgents,
  type Message,
  markMessagesSeen,
  migrateChannelIds,
  renameChannel,
  setAgentSleeping,
  setAgentStreaming,
  toSlackMessage,
} from "./server/database";
import { handleMcpRequest, setMcpScheduler } from "./server/mcp";
import { createChannel, getChannelInfo, listChannels } from "./server/routes/channels";
import { attachFilesToMessage, getFile, getFileMetadata, getOptimizedFile, uploadFile } from "./server/routes/files";
import {
  addReaction,
  deleteMessage,
  getConversationAround,
  getConversationHistory,
  getConversationNewer,
  getConversationReplies,
  getPendingMessages,
  postMessage,
  removeReaction,
  updateMessage,
} from "./server/routes/messages";
import {
  addPhase,
  addTaskAttachment,
  addTaskComment,
  createPlan,
  createTask,
  deletePhase,
  deletePlan,
  deleteTask,
  getPhaseWithTasks,
  getPlan,
  getTask,
  getTasksForPlan,
  linkTaskToPhase,
  listPlans,
  listTasks,
  removeTaskAttachment,
  unlinkTaskFromPlan,
  updatePhase,
  updatePlan,
  updateTask,
} from "./server/routes/tasks";
import {
  broadcastAgentStreaming,
  broadcastAgentToken,
  broadcastAgentToolCall,
  broadcastMessage,
  broadcastMessageSeen,
  broadcastReaction,
  broadcastUpdate,
  getClientCount,
  handleWebSocketClose,
  handleWebSocketMessage,
  handleWebSocketOpen,
} from "./server/websocket";
import { SchedulerManager } from "./scheduler/manager";
import { initRunner } from "./scheduler/runner";

// ============================================================================
// Initialize
// ============================================================================

const HOST = config.host;
const PORT = config.port;

// Database is initialized at module load time in database.ts (before prepared statements)

// Run channel ID migration on startup (normalizes legacy C-prefixed IDs to names)
const migrated = migrateChannelIds();
if (migrated.length > 0) {
  console.log(`[Migration] Normalized ${migrated.length} channel ID(s):`, migrated);
}

// Initialize scheduler
const scheduler = new SchedulerManager(config, broadcastUpdate);
setMcpScheduler(scheduler);

// Initialize space management
import { SpaceManager } from "./spaces/manager";
import { SpaceWorkerManager } from "./spaces/worker";

const spaceManager = new SpaceManager();
const spaceWorkerManager = new SpaceWorkerManager(
  { chatApiUrl: config.chatApiUrl, projectRoot: config.projectRoot, debug: config.debug, yolo: config.yolo },
  spaceManager,
);

// Initialize runner (sets job/reminder executors on scheduler)
initRunner({
  appConfig: config,
  scheduler,
  spaceManager,
  spaceWorkerManager,
  getAgentConfig: async (channel: string) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(`${config.chatApiUrl}/api/app.agents.list`, { signal: ctrl.signal }).finally(() =>
        clearTimeout(timer),
      );
      const data = (await res.json()) as any;
      if (data.ok && Array.isArray(data.agents)) {
        const agent = data.agents.find((a: any) => a.channel === channel && a.active !== false);
        if (agent) {
          return {
            provider: agent.provider || "copilot",
            model: agent.model || "default",
            agentId: agent.agent_id,
          };
        }
      }
    } catch {}
    return null;
  },
});

// Initialize worker manager
const workerManager = new WorkerManager(config, scheduler);
workerManager.setSpaceInfra(spaceManager, spaceWorkerManager);

// Register agent management API routes
const handleAgentRoute = registerAgentRoutes(db, workerManager);

// Register article management API routes
const handleArticleRoute = registerArticleRoutes(db);

// ============================================================================
// UI static file serving
// ============================================================================

const getUiDir = (): string | null => {
  // If embedded UI is available, no disk directory needed
  if (hasEmbeddedUI) return null;

  const configFile = loadConfigFile();
  if (configFile.uiDir && existsSync(configFile.uiDir)) {
    return configFile.uiDir;
  }
  const execDir = dirname(process.execPath);
  const execAdjacentUi = join(execDir, "ui");
  if (existsSync(execAdjacentUi)) return execAdjacentUi;

  // clawd-app specific: check for app-ui adjacent to executable
  const appUi = join(execDir, "app-ui");
  if (existsSync(appUi)) return appUi;

  // Dev mode: local packages/ui dist
  const devPath = join(dirname(Bun.main), "..", "packages", "ui", "dist");
  if (existsSync(devPath)) return devPath;

  // Fallback: dist/ui relative to cwd
  const cwdPath = join(process.cwd(), "dist", "ui");
  if (existsSync(cwdPath)) return cwdPath;

  console.warn("[clawd-app] Warning: UI directory not found and no embedded UI available");
  return null;
};

const UI_DIR = getUiDir();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
};

const fileCache = new Map<string, { content: Buffer; mtime: number }>();
const CACHE_MAX_SIZE = 50 * 1024 * 1024;
let cacheSize = 0;

/**
 * Serve a static UI file.
 * Priority: embedded assets (compiled binary) -> filesystem (dev mode)
 */
function serveStatic(urlPath: string): Response | null {
  // 1. Try embedded assets first (available in compiled binary)
  if (hasEmbeddedUI) {
    const asset = getEmbeddedAsset(urlPath);
    if (asset) {
      const isImmutable = !urlPath.endsWith(".html");
      return new Response(asset.content, {
        headers: {
          "Content-Type": asset.mimeType,
          "Cache-Control": isImmutable ? "public, max-age=31536000, immutable" : "no-cache",
          ...corsHeaders,
        },
      });
    }
    return null;
  }

  // 2. Fallback: serve from filesystem (dev mode or external ui/ dir)
  if (!UI_DIR) return null;
  const filePath = join(UI_DIR, urlPath);
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  if (stat.isDirectory()) return null;

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const isImmutable = ext !== ".html";

  const cached = fileCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs) {
    return new Response(cached.content, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": isImmutable ? "public, max-age=31536000, immutable" : "no-cache",
        ...corsHeaders,
      },
    });
  }

  const content = readFileSync(filePath);
  if (cacheSize + content.length < CACHE_MAX_SIZE) {
    fileCache.set(filePath, { content, mtime: stat.mtimeMs });
    cacheSize += content.length;
  }

  return new Response(content, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": isImmutable ? "public, max-age=31536000, immutable" : "no-cache",
      ...corsHeaders,
    },
  });
}

// ============================================================================
// HTTP helpers
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const corsResponse = new Response(null, { headers: corsHeaders });

async function parseBody(req: Request): Promise<Record<string, any>> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await req.json()) as Record<string, any>;
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    return Object.fromEntries(new URLSearchParams(text));
  }
  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const result: Record<string, any> = {};
    formData.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  return {};
}

// ============================================================================
// Server
// ============================================================================

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  maxRequestBodySize: 100 * 1024 * 1024,
  reusePort: true,

  fetch(req, server) {
    if (req.method === "OPTIONS") return corsResponse;

    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade
    if (path === "/ws") {
      const userId = url.searchParams.get("user") || "UHUMAN";
      if (server.upgrade(req, { data: { userId } })) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API routes
    if (path.startsWith("/api/") || path === "/mcp" || path === "/health") {
      return handleRequest(req, url, path, server);
    }

    // Static UI files
    let response = serveStatic(path);
    if (response) return response;
    response = serveStatic(path + "/index.html");
    if (response) return response;
    response = serveStatic("/index.html");
    if (response) return response;

    return handleRequest(req, url, path, server);
  },

  websocket: {
    open: handleWebSocketOpen,
    close: handleWebSocketClose,
    message: handleWebSocketMessage,
    perMessageDeflate: true,
  },
});

// ============================================================================
// Request handler (all API routes)
// ============================================================================

async function handleRequest(req: Request, url?: URL, path?: string, bunServer?: any) {
  url = url || new URL(req.url);
  path = path || url.pathname;

  try {
    // ---- clawd-app specific routes ----

    // Agent management routes (handled by registerAgentRoutes)
    const agentResponse = handleAgentRoute(req, url, path, bunServer);
    if (agentResponse) return agentResponse;

    // Article management routes (handled by registerArticleRoutes)
    const articleResponse = handleArticleRoute(req, url, path, bunServer);
    if (articleResponse) return articleResponse;

    // ---- clawd-chat standard routes ----

    // MCP endpoint
    if (path === "/mcp" || path === "/api/mcp") {
      return handleMcpRequest(req);
    }

    // Health check
    if (path === "/health" || path === "/") {
      return json({
        ok: true,
        server: "clawd-app",
        version: "0.1.0",
        clients: getClientCount(),
        workers: workerManager.getStatus().length,
        mcp: "/mcp",
        ui: hasEmbeddedUI ? "embedded" : UI_DIR && existsSync(UI_DIR) ? "filesystem" : "not-found",
      });
    }

    // Auth test
    if (path === "/api/auth.test") {
      return json({ ok: true, user_id: "UBOT", team_id: "T001", user: "Claw'd App" });
    }

    // Migration
    if (path === "/api/admin.migrateChannels" && req.method === "POST") {
      const migrated = migrateChannelIds();
      return json({ ok: true, migrated, count: migrated.length });
    }

    if (path === "/api/admin.renameChannel" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.old_channel || !body.new_channel)
        return json({ ok: false, error: "old_channel and new_channel required" }, 400);
      const results = renameChannel(body.old_channel, body.new_channel);
      return json({ ok: true, migrated: results, count: results.length });
    }

    // Channels
    if (path === "/api/conversations.list") return json(listChannels());

    if (path === "/api/conversations.create" && req.method === "POST") {
      const body = await parseBody(req);
      return json(createChannel(body.name, body.user));
    }

    if (path === "/api/conversations.info") {
      const body = await parseBody(req);
      const channel = body.channel || url.searchParams.get("channel");
      return json(getChannelInfo(channel));
    }

    // Messages - history
    if (path === "/api/conversations.history") {
      const body = await parseBody(req);
      const channel = body.channel || url.searchParams.get("channel") || "general";
      const limit = parseInt(body.limit || url.searchParams.get("limit") || "100", 10);
      const oldest = body.oldest || url.searchParams.get("oldest") || undefined;
      return json(getConversationHistory(channel, limit, oldest));
    }

    if (path === "/api/conversations.replies") {
      const body = await parseBody(req);
      const channel = body.channel || url.searchParams.get("channel") || "general";
      const ts = body.ts || url.searchParams.get("ts");
      const limit = parseInt(body.limit || url.searchParams.get("limit") || "100", 10);
      return json(getConversationReplies(channel, ts, limit));
    }

    // Search
    if (path === "/api/conversations.search") {
      const channel = url.searchParams.get("channel") || "general";
      const search = url.searchParams.get("search") || "";
      const beforeTs = url.searchParams.get("before_ts") || undefined;
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);

      if (!search.trim()) return json({ ok: true, messages: [], has_more: false });

      const conditions: string[] = ["channel = ?", "text LIKE ?"];
      const params: (string | number)[] = [channel, `%${search}%`];
      if (beforeTs) {
        conditions.push("ts < ?");
        params.push(beforeTs);
      }

      const query = `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY ts DESC LIMIT ?`;
      params.push(limit + 1);

      let messages = db.query<Message, (string | number)[]>(query).all(...params);
      const hasMore = messages.length > limit;
      if (hasMore) messages = messages.slice(0, limit);
      return json({ ok: true, messages, has_more: hasMore });
    }

    // Around / newer
    if (path === "/api/conversations.around") {
      const channel = url.searchParams.get("channel") || "general";
      const ts = url.searchParams.get("ts");
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      if (!ts) return json({ ok: false, error: "ts required" }, 400);
      return json(getConversationAround(channel, ts, limit));
    }

    if (path === "/api/conversations.newer") {
      const channel = url.searchParams.get("channel") || "general";
      const newestTs = url.searchParams.get("newest");
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      if (!newestTs) return json({ ok: false, error: "newest required" }, 400);
      return json(getConversationNewer(channel, newestTs, limit));
    }

    // Post message
    if (path === "/api/chat.postMessage" && req.method === "POST") {
      const body = await parseBody(req);
      const result = postMessage({
        channel: body.channel || "general",
        text: body.text,
        thread_ts: body.thread_ts,
        user: body.user,
        agent_id: body.agent_id,
        subtype: body.subtype,
        html_preview: body.html_preview,
        code_preview: body.code_preview,
        article_json: body.article_json,
        subspace_json: body.subspace_json,
      });
      if (result.ok && body.files && Array.isArray(body.files) && body.files.length > 0) {
        attachFilesToMessage(
          result.ts,
          body.files.map((f: { id: string }) => f.id),
        );
      }
      if (result.ok) {
        const msg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(result.ts);
        if (msg) broadcastMessage(body.channel || "general", msg);
      }
      return json(result);
    }

    // Update message
    if (path === "/api/chat.update" && req.method === "POST") {
      const body = await parseBody(req);
      const result = updateMessage({ channel: body.channel || "general", ts: body.ts, text: body.text });
      if (result.ok) {
        const msg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(body.ts);
        if (msg) broadcastUpdate(body.channel || "general", msg);
      }
      return json(result);
    }

    // Delete message
    if (path === "/api/chat.delete" && req.method === "POST") {
      const body = await parseBody(req);
      const channel = body.channel || "general";
      const result = deleteMessage(channel, body.ts);
      if (result.ok) broadcastMessage(channel, { ts: body.ts, deleted: true } as any);
      return json(result);
    }

    // Reactions
    if (path === "/api/reactions.add" && req.method === "POST") {
      const body = await parseBody(req);
      const result = addReaction({
        channel: body.channel || "general",
        timestamp: body.timestamp,
        name: body.name,
        user: body.user,
      });
      if (result.ok)
        broadcastReaction(body.channel || "general", body.timestamp, body.name, body.user || "UHUMAN", "added");
      return json(result);
    }

    if (path === "/api/reactions.remove" && req.method === "POST") {
      const body = await parseBody(req);
      const result = removeReaction({
        channel: body.channel || "general",
        timestamp: body.timestamp,
        name: body.name,
        user: body.user,
      });
      if (result.ok)
        broadcastReaction(body.channel || "general", body.timestamp, body.name, body.user || "UHUMAN", "removed");
      return json(result);
    }

    // Files
    if (path === "/api/files.upload" && req.method === "POST") {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      const channel = formData.get("channel")?.toString() || "general";
      const threadTs = formData.get("thread_ts")?.toString();
      if (!file) return json({ ok: false, error: "no_file" }, 400);
      const uploadResult = await uploadFile(file, channel, threadTs);
      if (!uploadResult.ok) return json(uploadResult, 413);
      return json(uploadResult);
    }

    if (path.startsWith("/api/files/")) {
      const pathParts = path.replace("/api/files/", "").split("/");
      const fileId = pathParts[0];
      const subPath = pathParts[1];

      if (subPath === "metadata") {
        const metadata = getFileMetadata(fileId);
        if (!metadata) return json({ ok: false, error: "file_not_found" }, 404);
        return json({ ok: true, file: metadata });
      }

      if (subPath === "optimized") {
        const maxWidth = parseInt(url.searchParams.get("maxWidth") || "1280", 10);
        const maxHeight = parseInt(url.searchParams.get("maxHeight") || "720", 10);
        const quality = parseInt(url.searchParams.get("quality") || "70", 10);
        const maxBytes = parseInt(url.searchParams.get("maxBytes") || "102400", 10);
        const optimized = await getOptimizedFile(fileId, { maxWidth, maxHeight, quality, maxBytes });
        if (!optimized) return new Response("Not found", { status: 404 });
        return new Response(optimized.data, {
          headers: {
            "Content-Type": optimized.mimetype,
            "Content-Disposition": `inline; filename="${optimized.name}"`,
            "X-Original-Size": String(optimized.originalSize),
            "X-Optimized-Size": String(optimized.optimizedSize),
            ...corsHeaders,
          },
        });
      }

      const file = getFile(fileId);
      if (!file) return new Response("Not found", { status: 404 });
      return new Response(file.data, {
        headers: {
          "Content-Type": file.mimetype,
          "Content-Disposition": `inline; filename="${file.name}"`,
          ...corsHeaders,
        },
      });
    }

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

      broadcastUpdate(channel, { type: "agent_seen", agent_id: agentId, last_seen_ts: lastSeenTs });
      const lastNonSelfMsg = db
        .query<{ ts: string }, [string, string, string]>(
          `SELECT ts FROM messages WHERE channel = ? AND ts <= ? AND (agent_id IS NULL OR agent_id != ?) ORDER BY ts DESC LIMIT 1`,
        )
        .get(channel, lastSeenTs, agentId);
      if (lastNonSelfMsg) broadcastMessageSeen(channel, lastNonSelfMsg.ts, agentId);
      broadcastUpdate(channel, { type: "agent_status", agent_id: agentId, status: "ready", hibernate_until: null });

      return json({ ok: true, agent_id: agentId, channel, last_seen_ts: lastSeenTs });
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
      return json({ ok: true, agent_id: agentId, channel, last_seen_ts: result?.last_seen_ts || null });
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
      broadcastUpdate(channel, { type: "agent_processed", agent_id: agentId, last_processed_ts: lastProcessedTs });
      return json({ ok: true, agent_id: agentId, channel, last_processed_ts: lastProcessedTs });
    }

    // Set sleeping
    if (path === "/api/agent.setSleeping" && req.method === "POST") {
      const body = await parseBody(req);
      const agentId = body.agent_id;
      const channel = body.channel || "general";
      const isSleeping = body.is_sleeping === true || body.is_sleeping === 1;
      if (!agentId) return json({ ok: false, error: "agent_id required" }, 400);
      const success = setAgentSleeping(agentId, channel, isSleeping);
      if (success) broadcastUpdate(channel, { type: "agent_sleep", agent_id: agentId, is_sleeping: isSleeping });
      return json({ ok: success, agent_id: agentId, channel, is_sleeping: isSleeping });
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
      return json({ ok: success, agent_id: agentId, channel, is_streaming: isStreaming });
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
      return json({ ok: true, agent_id: agentId, channel, last_processed_ts: result?.last_processed_ts || null });
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
      broadcastUpdate(channel, { type: "agent_status", agent_id: agentId, status, hibernate_until: hibernateUntil });
      return json({ ok: true, agent_id: agentId, channel, status, hibernate_until: hibernateUntil });
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
      if (!body.agent_id) return json({ ok: false, error: "agent_id required" }, 400);
      const channel = body.channel || "general";
      const agent = getOrRegisterAgent(body.agent_id, channel, body.is_worker || false);
      broadcastUpdate(channel, { type: "agent_joined", agent });
      return json({ ok: true, agent });
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
      return json({ ok: true, channel, status: anyOnline ? "online" : "offline", agents: agentStatuses });
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
    // Task APIs
    // ========================================================================

    if (path === "/api/tasks.list") {
      const agent_id = url.searchParams.get("agent_id") || undefined;
      const status = url.searchParams.get("status") || undefined;
      const channel = url.searchParams.get("channel") || undefined;
      const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : undefined;
      return json({ ok: true, tasks: listTasks({ agent_id, status, channel, limit }) });
    }

    if (path === "/api/tasks.get") {
      const task_id = url.searchParams.get("task_id");
      if (!task_id) return json({ ok: false, error: "task_id required" }, 400);
      const task = getTask(task_id);
      if (!task) return json({ ok: false, error: "task_not_found" }, 404);
      return json({ ok: true, task });
    }

    if (path === "/api/tasks.create" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.title) return json({ ok: false, error: "title required" }, 400);
      return json({ ok: true, task: createTask(body as Parameters<typeof createTask>[0]) });
    }

    if (path === "/api/tasks.update" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.task_id) return json({ ok: false, error: "task_id required" }, 400);
      const result = updateTask(body.task_id, body);
      if (!result.success) {
        if (result.error === "not_found") return json({ ok: false, error: "task_not_found" }, 404);
        if (result.error === "already_claimed")
          return json({ ok: false, error: "already_claimed", claimed_by: result.claimed_by }, 409);
      }
      return json({ ok: true, task: result.task });
    }

    if (path === "/api/tasks.delete" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.task_id) return json({ ok: false, error: "task_id required" }, 400);
      if (!deleteTask(body.task_id)) return json({ ok: false, error: "task_not_found" }, 404);
      return json({ ok: true });
    }

    if (path === "/api/tasks.addAttachment" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.task_id || !body.name) return json({ ok: false, error: "task_id and name required" }, 400);
      const task = addTaskAttachment(body.task_id, {
        name: body.name,
        url: body.url,
        file_id: body.file_id,
        mimetype: body.mimetype,
        size: body.size,
        added_by: body.added_by || "api",
      });
      if (!task) return json({ ok: false, error: "task_not_found" }, 404);
      return json({ ok: true, task });
    }

    if (path === "/api/tasks.removeAttachment" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.task_id || !body.attachment_id)
        return json({ ok: false, error: "task_id and attachment_id required" }, 400);
      const task = removeTaskAttachment(body.task_id, body.attachment_id);
      if (!task) return json({ ok: false, error: "task_not_found" }, 404);
      return json({ ok: true, task });
    }

    if (path === "/api/tasks.addComment" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.task_id || !body.text) return json({ ok: false, error: "task_id and text required" }, 400);
      const task = addTaskComment(body.task_id, body.author || "api", body.text);
      if (!task) return json({ ok: false, error: "task_not_found" }, 404);
      return json({ ok: true, task });
    }

    // ========================================================================
    // Plan APIs
    // ========================================================================

    if (path === "/api/plans.list") {
      const channel = url.searchParams.get("channel") || undefined;
      return json({ ok: true, plans: listPlans(channel) });
    }

    if (path === "/api/plans.get") {
      const plan_id = url.searchParams.get("plan_id");
      if (!plan_id) return json({ ok: false, error: "plan_id required" }, 400);
      const plan = getPlan(plan_id);
      if (!plan) return json({ ok: false, error: "plan_not_found" }, 404);
      return json({ ok: true, plan });
    }

    if (path === "/api/plans.create" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.channel || !body.title || !body.created_by)
        return json({ ok: false, error: "channel, title, and created_by required" }, 400);
      return json({ ok: true, plan: createPlan(body as Parameters<typeof createPlan>[0]) });
    }

    if (path === "/api/plans.update" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.plan_id) return json({ ok: false, error: "plan_id required" }, 400);
      const plan = updatePlan(body.plan_id, body);
      if (!plan) return json({ ok: false, error: "plan_not_found" }, 404);
      return json({ ok: true, plan });
    }

    if (path === "/api/plans.delete" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.plan_id) return json({ ok: false, error: "plan_id required" }, 400);
      if (!deletePlan(body.plan_id)) return json({ ok: false, error: "plan_not_found" }, 404);
      return json({ ok: true });
    }

    if (path === "/api/plans.getTasks") {
      const plan_id = url.searchParams.get("plan_id");
      if (!plan_id) return json({ ok: false, error: "plan_id required" }, 400);
      return json({ ok: true, phases: getTasksForPlan(plan_id) });
    }

    if ((path === "/api/plans.addPhase" || path === "/api/phases.add") && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.plan_id || !body.name) return json({ ok: false, error: "plan_id and name required" }, 400);
      const phase = addPhase(body.plan_id, body);
      if (!phase) return json({ ok: false, error: "plan_not_found" }, 404);
      return json({ ok: true, phase });
    }

    if ((path === "/api/plans.updatePhase" || path === "/api/phases.update") && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.phase_id) return json({ ok: false, error: "phase_id required" }, 400);
      const phase = updatePhase(body.phase_id, body);
      if (!phase) return json({ ok: false, error: "phase_not_found" }, 404);
      return json({ ok: true, phase });
    }

    if ((path === "/api/plans.deletePhase" || path === "/api/phases.delete") && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.phase_id) return json({ ok: false, error: "phase_id required" }, 400);
      if (!deletePhase(body.phase_id)) return json({ ok: false, error: "phase_not_found" }, 404);
      return json({ ok: true });
    }

    if (path === "/api/plans.getPhase" || path === "/api/phases.getTasks") {
      const phase_id = url.searchParams.get("phase_id");
      if (!phase_id) return json({ ok: false, error: "phase_id required" }, 400);
      const phase = getPhaseWithTasks(phase_id);
      if (!phase) return json({ ok: false, error: "phase_not_found" }, 404);
      return json({ ok: true, phase });
    }

    if ((path === "/api/plans.linkTask" || path === "/api/phases.linkTask") && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.plan_id || !body.phase_id || !body.task_id)
        return json({ ok: false, error: "plan_id, phase_id, and task_id required" }, 400);
      const success = linkTaskToPhase(body.plan_id, body.phase_id, body.task_id);
      if (!success) return json({ ok: false, error: "link_failed" }, 400);
      return json({ ok: true });
    }

    if ((path === "/api/plans.unlinkTask" || path === "/api/phases.unlinkTask") && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.plan_id || !body.task_id) return json({ ok: false, error: "plan_id and task_id required" }, 400);
      const success = unlinkTaskFromPlan(body.plan_id, body.task_id);
      if (!success) return json({ ok: false, error: "unlinking_failed" }, 400);
      return json({ ok: true });
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
      return json({ ok: true, channel, last_seen_ts: result?.last_seen_ts || null });
    }

    // Spaces API
    if (path === "/api/spaces.list") {
      const channel = url.searchParams.get("channel");
      if (!channel) return json({ ok: false, error: "channel required" }, 400);
      const { listSpaces } = await import("./spaces/db");
      const status = url.searchParams.get("status") || undefined;
      return json({ ok: true, spaces: listSpaces(channel, status) });
    }

    if (path === "/api/spaces.get") {
      const id = url.searchParams.get("id");
      if (!id) return json({ ok: false, error: "id required" }, 400);
      const { getSpace } = await import("./spaces/db");
      const space = getSpace(id);
      if (!space) return json({ ok: false, error: "not_found" }, 404);
      return json({ ok: true, space });
    }

    return json({ ok: false, error: "not_found" }, 404);
  } catch (error) {
    console.error("[ERROR]", error);
    return json({ ok: false, error: String(error) }, 500);
  }
}

// ============================================================================
// Startup
// ============================================================================

console.log(`
+---------------------------------------------------------------+
|  Claw'd App                                                   |
+---------------------------------------------------------------+
|  HTTP:      http://${HOST}:${PORT}                             |
|  WebSocket: ws://${HOST}:${PORT}/ws                            |
|  UI:        ${hasEmbeddedUI ? `embedded (${embeddedUIFileCount} files, ${(embeddedUITotalSize / 1024 / 1024).toFixed(1)}MB)` : UI_DIR ? UI_DIR : "(not found)"}
|  Agent:     in-process
+---------------------------------------------------------------+
`);

// Helper for space recovery notifications
async function postToChannel(apiUrl: string, channel: string, text: string, agentId: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  await fetch(`${apiUrl}/api/chat.postMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text, user: "UBOT", agent_id: agentId }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
}

// Start worker manager (loads agents from DB, starts polling loops)
setTimeout(async () => {
  try {
    await workerManager.start();
    scheduler.start();

    // Space recovery AFTER scheduler.start() — prevents runningJobs.clear() from wiping recovered registrations
    const activeSpaces = spaceManager.getActiveSpaces();
    if (activeSpaces.length > 0) {
      console.log(`[Spaces] Recovering ${activeSpaces.length} active space(s)...`);
      for (const space of activeSpaces) {
        try {
          // Validate source job for scheduler spaces
          if (space.source === "scheduler" && space.source_id) {
            const { getJob } = await import("./scheduler/db");
            const job = getJob(space.source_id);
            if (!job || job.status === "cancelled" || job.status === "failed") {
              spaceManager.failSpace(space.id, "Source job no longer active");
              continue;
            }
          }

          // Check remaining timeout
          const remainingMs = Math.max(0, space.created_at + space.timeout_seconds * 1000 - Date.now());
          if (remainingMs <= 0) {
            spaceManager.timeoutSpace(space.id);
            continue;
          }

          // Check MAX limit
          if (spaceWorkerManager.runningCount() >= 5) {
            spaceManager.failSpace(space.id, "Max workers exceeded on recovery");
            continue;
          }

          // Get agent config
          const recoverCtrl = new AbortController();
          const recoverTimer = setTimeout(() => recoverCtrl.abort(), 10000);
          const res = await fetch(`${config.chatApiUrl}/api/app.agents.list`, { signal: recoverCtrl.signal }).finally(
            () => clearTimeout(recoverTimer),
          );
          const data = (await res.json()) as any;
          const agentEntry =
            data.ok && Array.isArray(data.agents)
              ? data.agents.find((a: any) => a.channel === space.channel && a.active !== false)
              : null;
          if (!agentEntry) {
            spaceManager.failSpace(space.id, "Agent not configured");
            continue;
          }
          const agentConfig = {
            provider: agentEntry.provider || "copilot",
            model: agentEntry.model || "default",
            agentId: agentEntry.agent_id,
          };

          // Create abort controller with remaining timeout
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort("timeout"), remainingMs);
          let settled = false;
          const onAbort = () => {
            if (settled) return;
            settled = true;
            const isTimeout = controller.signal.reason === "timeout";
            const won = isTimeout
              ? spaceManager.timeoutSpace(space.id)
              : spaceManager.failSpace(space.id, String(controller.signal.reason));
            if (won) {
              const emoji = isTimeout ? "⏰" : "❌";
              postToChannel(
                config.chatApiUrl,
                space.channel,
                `${emoji} Space ${isTimeout ? "timed_out" : "failed"}: ${space.title}`,
                agentConfig.agentId,
              ).catch(() => {});
            }
            spaceWorkerManager.stopSpaceWorker(space.id);
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });

          const promise = spaceWorkerManager.startSpaceWorker(space, agentConfig);

          // Register to prevent tick re-execution
          if (space.source === "scheduler" && space.source_id) {
            scheduler.registerRecoveredJob(space.source_id, controller);
          }

          promise
            .then(async (summary) => {
              settled = true;
              if (space.source === "scheduler" && space.source_id) {
                const { insertRun, completeRun, incrementRunCount, resetErrors, purgeOldRuns } = await import(
                  "./scheduler/db"
                );
                const runId = crypto.randomUUID();
                insertRun(runId, space.source_id);
                completeRun(runId, "success", undefined, summary?.slice(0, 500));
                incrementRunCount(space.source_id);
                resetErrors(space.source_id);
                scheduler.checkJobCompletion(space.source_id);
                purgeOldRuns(space.source_id);
              }
            })
            .catch((err: Error) => {
              if (!settled) {
                settled = true;
                const won = spaceManager.failSpace(space.id, err.message);
                if (won)
                  postToChannel(
                    config.chatApiUrl,
                    space.channel,
                    `❌ Space failed: ${space.title}`,
                    agentConfig.agentId,
                  ).catch(() => {});
                spaceWorkerManager.stopSpaceWorker(space.id);
              }
            })
            .finally(() => {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", onAbort);
              spaceWorkerManager.stopSpaceWorker(space.id);
              if (space.source === "scheduler" && space.source_id) {
                scheduler.unregisterRecoveredJob(space.source_id);
              }
            });

          console.log(
            `[Spaces] Recovered space ${space.id} (${space.title}), ${Math.round(remainingMs / 1000)}s remaining`,
          );
        } catch (err) {
          console.error(`[Spaces] Failed to recover space ${space.id}:`, err);
          spaceManager.failSpace(space.id, "Recovery failed");
        }
      }
    }
  } catch (error) {
    console.error("[clawd-app] Failed to start worker manager:", error);
  }
}, 1000); // Delay 1s to ensure server is fully ready

// Open browser if configured
if (config.openBrowser) {
  const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([openCmd, `http://localhost:${PORT}`], { stdout: "ignore", stderr: "ignore" });
  } catch {
    console.log(`[clawd-app] Open http://localhost:${PORT} in your browser`);
  }
}

// Periodic cleanup: clear stale streaming states
setInterval(() => {
  try {
    const { cleared } = clearStaleStreamingStates();
    if (cleared.length > 0) {
      console.log(`[Cleanup] Cleared stale streaming states: ${cleared.join(", ")}`);
      for (const entry of cleared) {
        const [agentId, channel] = entry.split("@");
        const agent = getOrRegisterAgent(agentId, channel);
        broadcastUpdate(channel, {
          type: "agent_streaming",
          agent_id: agentId,
          is_streaming: false,
          avatar_color: agent?.avatar_color || "#D97853",
        });
      }
    }
  } catch (err) {
    console.error("[Cleanup] Error clearing stale streaming:", err);
  }
}, 60_000);

// Graceful shutdown (SP25: scheduler → spaces → workers)
// Force-exit after 8s to prevent hang if cleanup gets stuck
let shutdownInProgress = false;
const gracefulShutdown = async (signal: string) => {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[clawd-app] Received ${signal}, shutting down...`);
  const forceTimer = setTimeout(() => {
    console.error("[clawd-app] Shutdown timed out after 8s, forcing exit");
    process.exit(1);
  }, 8000);
  forceTimer.unref();
  try {
    await scheduler.stop();
    await spaceWorkerManager.stopAll();
    await workerManager.stop();
  } catch (err) {
    console.error("[clawd-app] Error during shutdown:", err);
  }
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
