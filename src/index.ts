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
import { homedir } from "node:os";
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
      "no-open-browser": { type: "boolean" },
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
  --no-open-browser            Don't open browser on startup
  --yolo                      Disable sandbox restrictions for agents
  --debug                     Enable debug logging
  -h, --help                  Show this help message

  Settings can also be configured in ~/.clawd/config.json.
  CLI flags take precedence over config file values.

Examples:
  clawd-app
  clawd-app --host localhost --port 8080
  clawd-app --no-open-browser --debug
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
  --no-open-browser            Don't open browser on startup
  --yolo                      Disable sandbox restrictions for agents
  --debug                     Enable debug logging
  -h, --help                  Show this help message

  Settings can also be configured in ~/.clawd/config.json.
  CLI flags take precedence over config file values.

Examples:
  clawd-app
  clawd-app --host localhost --port 8080
  clawd-app --no-open-browser --debug
`);
  process.exit(0);
}

import { keyPool } from "./agent/api/key-pool";
import { clearConfigCache as clearProviderConfigCache, ensureKeyPoolInitialized } from "./agent/api/provider-config";
import { applyTokenLimitOverrides } from "./agent/constants/context-limits";
import { getSessionManager } from "./agent/session/manager";
import { setDebug } from "./agent/utils/debug";
import {
  type CallsQueryOptions,
  queryCalls,
  queryCallsCount,
  queryKeyHistory,
  queryKeyStats,
  queryModelStats,
  queryRecentStats,
  querySummary,
} from "./analytics";
// Now import modules (database will initialize)
import { registerAgentRoutes } from "./api/agents";
import { registerArticleRoutes } from "./api/articles";
import { getPublicOrigin, registerMcpServerRoutes } from "./api/mcp-servers";
import { registerWorktreeRoutes } from "./api/worktree";
import { loadConfig, validateConfig } from "./config";
import {
  getAuthToken,
  getDataDir,
  isBrowserEnabled,
  isWorkspacesEnabled,
  loadConfigFile,
  reloadConfigFile,
} from "./config-file";
import { extensionZipSize, getExtensionZip } from "./embedded-extension";
import { embeddedUIFileCount, embeddedUITotalSize, getEmbeddedAsset, hasEmbeddedUI } from "./embedded-ui";
import { escapeHtml, exchangeOAuthCode, saveOAuthToken, validateOAuthState } from "./mcp-oauth";
import { upgradeBrowserWs } from "./server/browser-bridge";
import { validateBody } from "./server/validate";
import { WorkerManager } from "./worker-manager";
import { z } from "zod";

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

// Apply model token limit overrides from config.json
{
  const fileConfig = loadConfigFile();
  if (fileConfig.model_token_limits) {
    applyTokenLimitOverrides(fileConfig.model_token_limits);
  }
}

// @ts-expect-error — Bun text imports; TypeScript cannot resolve non-TS assets
import REMOTE_WORKER_JAVA from "../packages/clawd-worker/java/RemoteWorker.java" with { type: "text" };
// @ts-expect-error — Bun text imports; TypeScript cannot resolve non-TS assets
import REMOTE_WORKER_PY from "../packages/clawd-worker/python/remote_worker.py" with { type: "text" };
// @ts-expect-error — Bun text import; remote-worker.ts has no default export
import REMOTE_WORKER_TS from "../packages/clawd-worker/typescript/remote-worker.ts" with { type: "text" };
import type { ToolResult } from "./agent/tools/tools";
import { tools as builtinTools } from "./agent/tools/tools";
import { SchedulerManager } from "./scheduler/manager";
import { initRunner } from "./scheduler/runner";
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
import { handleAgentMcpRequest, handleMcpRequest, handleSpaceMcpRequest, setMcpScheduler } from "./server/mcp";
// Workspace modules are dynamically imported only when needed (see isWorkspacesEnabled checks)
import { upgradeRemoteWorkerWs } from "./server/remote-worker";
import { getArtifactActions, handleArtifactAction } from "./server/routes/artifact-actions";
import { createChannel, getChannelInfo, listChannels } from "./server/routes/channels";
import {
  attachFilesToMessage,
  getFile,
  getFileMetadata,
  getOptimizedFile,
  /* getPublicFile, setFileVisibility, */ uploadFile,
} from "./server/routes/files";
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
  createTasksBatch,
  deletePhase,
  deletePlan,
  deleteTask,
  getPhaseWithTasks,
  getPlan,
  getTask,
  getTasksForPlan,
  getTodos,
  linkTaskToPhase,
  listChannelTodos,
  listPlans,
  listTasks,
  removeTaskAttachment,
  unlinkTaskFromPlan,
  updatePhase,
  updatePlan,
  updateTask,
  updateTodoItem,
  writeTodos,
} from "./server/routes/tasks";
import {
  broadcastAgentStreaming,
  broadcastAgentToken,
  broadcastAgentToolCall,
  broadcastArtifactAction,
  broadcastChannelCleared,
  broadcastMessage,
  broadcastMessageSeen,
  broadcastReaction,
  broadcastUpdate,
  getClientCount,
  handleWebSocketClose,
  handleWebSocketMessage,
  handleWebSocketOpen,
} from "./server/websocket";

// ============================================================================
// Helpers
// ============================================================================

/** Build Content-Disposition header value safe for non-ASCII filenames (RFC 5987) */
function contentDisposition(type: "inline" | "attachment", name: string): string {
  // ASCII-only fallback: replace non-ASCII and unsafe chars with underscores
  const asciiFallback = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\r\n\\]/g, "_");
  // Check if filename is pure ASCII
  const isPureAscii = /^[\x20-\x7E]+$/.test(name);
  if (isPureAscii) {
    return `${type}; filename="${asciiFallback}"`;
  }
  // RFC 5987: filename* with UTF-8 percent-encoding for non-ASCII
  const encoded = encodeURIComponent(name).replace(/'/g, "%27");
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

// ============================================================================
// Initialize
// ============================================================================

const HOST = config.host;
const PORT = config.port;

// Database is initialized at module load time in database.ts (before prepared statements)

// Lazy-loaded read-only connection to memory.db (for agent thoughts API)
import { Database } from "bun:sqlite";

let _memoryDb: InstanceType<typeof Database> | null = null;
function getMemoryDb(): InstanceType<typeof Database> {
  if (!_memoryDb) {
    const memPath = join(getDataDir(), "memory.db");
    _memoryDb = new Database(memPath, { readonly: true });
    _memoryDb.exec("PRAGMA journal_mode = WAL");
    _memoryDb.exec("PRAGMA busy_timeout = 5000");
  }
  return _memoryDb;
}

// Always clean up orphaned workspace containers on startup (even if workspaces is now disabled,
// containers may exist from when it was enabled). Only reconcile ports if currently enabled.
import("./agent/workspace/container.js")
  .then(({ cleanupOrphanedWorkspaces, reconcilePortsFromDocker }) =>
    cleanupOrphanedWorkspaces()
      .catch((err: unknown) => {
        console.warn("[startup] cleanupOrphanedWorkspaces failed:", err);
      })
      .then(() => {
        if (isWorkspacesEnabled()) {
          return reconcilePortsFromDocker().catch((err: unknown) => {
            console.warn("[startup] reconcilePortsFromDocker failed unexpectedly:", err);
          });
        }
      }),
  )
  .catch((err: unknown) => {
    console.warn("[startup] workspace module import failed:", err);
  });

// Run channel ID migration on startup (normalizes legacy C-prefixed IDs to names)
const migrated = migrateChannelIds();
if (migrated.length > 0) {
  console.log(`[Migration] Normalized ${migrated.length} channel ID(s):`, migrated);
}

// Rename reserved channel names that conflict with management routes
for (const reserved of ["agents", "skills"]) {
  const exists = db.query("SELECT id FROM channels WHERE id = ?").get(reserved) as { id: string } | null;
  if (exists) {
    renameChannel(reserved, `${reserved}-space`);
    console.warn(`[Migration] Renamed reserved channel "${reserved}" to "${reserved}-space"`);
  }
}

// Initialize scheduler
const scheduler = new SchedulerManager(config, broadcastUpdate);
setMcpScheduler(scheduler);

// Initialize space management
import { SpaceManager } from "./spaces/manager";
import { SpaceWorkerManager } from "./spaces/worker";

const spaceManager = new SpaceManager();
const spaceWorkerManager = new SpaceWorkerManager(
  {
    chatApiUrl: config.chatApiUrl,
    projectRoot: config.projectRoot,
    debug: config.debug,
    yolo: config.yolo,
  },
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
      const res = await fetch(`${config.chatApiUrl}/api/app.agents.list`, {
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      const data = (await res.json()) as any;
      if (data.ok && Array.isArray(data.agents)) {
        const agent = data.agents.find((a: any) => a.channel === channel && a.active !== false);
        if (agent) {
          return {
            provider: agent.provider || "copilot",
            model: agent.model || "default",
            agentId: agent.agent_id,
            project: agent.project,
            avatar_color: agent.avatar_color,
          };
        }
      }
    } catch {}
    return null;
  },
  executeToolFn: async (toolName: string, args: Record<string, any>, channel: string): Promise<ToolResult> => {
    // Try built-in tools first
    const handler = builtinTools.get(toolName);
    if (handler) {
      try {
        return await handler(args);
      } catch (err: any) {
        return {
          success: false,
          output: "",
          error: err.message || String(err),
        };
      }
    }
    // Fall back to MCP tools for the channel
    const mcpManager = workerManager.getChannelMcpManager(channel);
    if (mcpManager) {
      const mcpResult = await mcpManager.executeMCPTool(toolName, args);
      if (mcpResult.success) {
        const text = typeof mcpResult.result === "string" ? mcpResult.result : JSON.stringify(mcpResult.result);
        return { success: true, output: text };
      }
      if (mcpResult.error && mcpResult.error !== `Unknown tool: ${toolName}`) {
        return { success: false, output: "", error: mcpResult.error };
      }
    }
    return {
      success: false,
      output: "",
      error: `Tool "${toolName}" not found`,
    };
  },
});

// Initialize worker manager
const workerManager = new WorkerManager(config, scheduler);
workerManager.setSpaceInfra(spaceManager, spaceWorkerManager);

// Wire channel MCP lookup so sub-agents inherit parent channel's MCP servers
spaceWorkerManager.setChannelMcpLookup((channel) => workerManager.getChannelMcpManager(channel));

// Register agent management API routes
const handleAgentRoute = registerAgentRoutes(db, workerManager);

// Register MCP server management API routes
const handleMcpServerRoute = registerMcpServerRoutes(workerManager);

// Register article management API routes
const handleArticleRoute = registerArticleRoutes(db);

// Register worktree management API routes
const handleWorktreeRoute = registerWorktreeRoutes(workerManager);

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

function numParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
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
// Browser File Transfer API
// ============================================================================

const MAX_BROWSER_FILE_SIZE = 500 * 1024 * 1024; // 500 MiB

async function handleBrowserFileRequest(req: Request, url: URL, path: string): Promise<Response> {
  // Auth token validation (query param ?token=...)
  const token = url.searchParams.get("token");
  const { validateBrowserToken } = await import("./server/browser-bridge");
  if (!validateBrowserToken(token)) {
    return json({ ok: false, error: "Invalid or missing auth token" }, 403);
  }

  // POST /browser/files/upload — extension uploads a file (multipart form data)
  if (path === "/browser/files/upload" && req.method === "POST") {
    try {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      if (!file) return json({ ok: false, error: "Missing 'file' in form data" }, 400);
      if (file.size > MAX_BROWSER_FILE_SIZE) {
        return json(
          {
            ok: false,
            error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MiB). Max 500 MiB.`,
          },
          413,
        );
      }
      const result = await uploadFile(file, "browser", undefined, "UBROWSER");
      return json(result, result.ok ? 200 : 413);
    } catch (err: any) {
      console.error("[ERROR] file upload:", err);
      return json({ ok: false, error: "Internal server error" }, 500);
    }
  }

  // GET /browser/files/:fileId — extension downloads a file as raw binary
  const fileMatch = path.match(/^\/browser\/files\/([A-Za-z0-9]+)$/);
  if (fileMatch && req.method === "GET") {
    const fileId = fileMatch[1];
    const file = getFile(fileId);
    if (!file) return new Response("Not found", { status: 404 });
    if (file.data.length > MAX_BROWSER_FILE_SIZE) {
      return json(
        {
          ok: false,
          error: `File too large (${(file.data.length / 1024 / 1024).toFixed(1)} MiB). Max 500 MiB.`,
        },
        413,
      );
    }
    return new Response(file.data, {
      headers: {
        "Content-Type": file.mimetype,
        "Content-Disposition": contentDisposition("attachment", file.name),
        "Content-Length": String(file.data.length),
        "Referrer-Policy": "no-referrer",
        ...corsHeaders,
      },
    });
  }

  return json({ ok: false, error: "Not found" }, 404);
}

// ============================================================================
// Server
// ============================================================================

// Eagerly initialize KeyPool so /api/keys/status is ready immediately
ensureKeyPoolInitialized();

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  maxRequestBodySize: 100 * 1024 * 1024,
  reusePort: true,

  fetch(req, server) {
    if (req.method === "OPTIONS") return corsResponse;

    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade — chat (/ws) or workspace noVNC proxy (/workspace/:id/novnc/websockify)
    if (path === "/ws") {
      const authToken = getAuthToken();
      if (authToken) {
        const wsToken = url.searchParams.get("token");
        if (wsToken !== authToken) {
          return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      // When auth is active, always identify as the human user (ignore ?user= param).
      // Without auth (dev/local mode), honour the ?user= param for flexibility.
      const userId = authToken ? "UHUMAN" : url.searchParams.get("user") || "UHUMAN";
      if (server.upgrade(req, { data: { userId } })) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Browser extension zip download
    if (path === "/browser/extension") {
      const zip = getExtensionZip();
      return new Response(zip, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="clawd-browser-extension.zip"',
          "Content-Length": String(zip.length),
        },
      });
    }

    // Browser extension WebSocket bridge (only when browser enabled)
    if (path === "/browser/ws") {
      if (!isBrowserEnabled()) {
        console.log("[browser-bridge] Rejected /browser/ws — browser feature not enabled");
        return new Response("Browser features not enabled", { status: 403 });
      }
      return upgradeBrowserWs(req, server);
    }

    // Browser file transfer API (extension uploads/downloads files via chat server)
    if (path.startsWith("/browser/files")) {
      if (!isBrowserEnabled()) {
        return new Response("Browser features not enabled", { status: 403 });
      }
      return handleBrowserFileRequest(req, url, path);
    }

    // Remote worker WebSocket upgrade
    if (path === "/worker/ws") {
      return upgradeRemoteWorkerWs(req, server);
    }

    // Remote worker script download
    const scriptMatch = path.match(/^\/worker\/remote-script\/(python|typescript|ts|py|java)$/);
    if (scriptMatch) {
      const lang = scriptMatch[1];
      const scriptMap: Record<string, { content: string; name: string; ct: string }> = {
        python: {
          content: REMOTE_WORKER_PY,
          name: "remote_worker.py",
          ct: "text/x-python",
        },
        py: {
          content: REMOTE_WORKER_PY,
          name: "remote_worker.py",
          ct: "text/x-python",
        },
        typescript: {
          content: REMOTE_WORKER_TS,
          name: "remote-worker.ts",
          ct: "text/typescript",
        },
        ts: {
          content: REMOTE_WORKER_TS,
          name: "remote-worker.ts",
          ct: "text/typescript",
        },
        java: {
          content: REMOTE_WORKER_JAVA,
          name: "RemoteWorker.java",
          ct: "text/x-java-source",
        },
      };
      const info = scriptMap[lang];
      return new Response(info.content, {
        headers: {
          "Content-Type": info.ct,
          "Content-Disposition": `attachment; filename="${info.name}"`,
        },
      });
    }

    // Workspace noVNC WebSocket proxy (only when workspaces enabled)
    const wsProxyMatch = isWorkspacesEnabled() ? path.match(/^\/workspace\/([a-f0-9]{16})\/novnc\/websockify$/) : null;
    if (wsProxyMatch) {
      return import("./server/routes/workspace-proxy").then(({ upgradeWorkspaceWs }) =>
        upgradeWorkspaceWs(req, wsProxyMatch[1], server),
      );
    }

    // Workspace noVNC HTTP proxy (only when workspaces enabled)
    const proxyMatch = isWorkspacesEnabled() ? path.match(/^\/workspace\/([a-f0-9]{16})\/novnc(\/.*)?$/) : null;
    if (proxyMatch) {
      return import("./server/routes/workspace-proxy").then(({ handleWorkspaceProxy }) =>
        handleWorkspaceProxy(req, url, proxyMatch[1]),
      );
    }

    // API routes
    if (path.startsWith("/api/") || path.startsWith("/mcp") || path === "/health") {
      // Auth check for /api/ and /mcp routes (not /health which is a monitoring endpoint)
      if (path.startsWith("/api/") || path.startsWith("/mcp")) {
        const authToken = getAuthToken();
        if (authToken) {
          const authHeader = req.headers.get("authorization");
          const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
          if (bearer !== authToken) {
            return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
      }
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
    perMessageDeflate: false,
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

    // MCP server management routes
    const mcpResponse = handleMcpServerRoute(req, url, path);
    if (mcpResponse) return mcpResponse;

    // Worktree management routes
    const worktreeResponse = handleWorktreeRoute(req, url, path);
    if (worktreeResponse) return worktreeResponse;

    // CIMD: Serve client metadata document for MCP OAuth (SEP-991)
    if (path === "/.well-known/oauth-client.json") {
      const publicOrigin = getPublicOrigin(req, url);
      return new Response(
        JSON.stringify({
          client_id: `${publicOrigin}/.well-known/oauth-client.json`,
          client_name: "Clawd",
          redirect_uris: [`${publicOrigin}/api/mcp/oauth/callback`],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "private, no-store",
            Vary: "Host, X-Forwarded-Host, X-Forwarded-Proto",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET",
          },
        },
      );
    }

    // MCP OAuth callback route
    if (path === "/api/mcp/oauth/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const stateParam = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      console.log(
        `[OAuth callback] code=${code ? code.slice(0, 12) + "..." : "null"}, state=${stateParam ? "present" : "null"}, error=${errorParam || "none"}, full_url=${url.pathname}?${url.search}`,
      );

      if (errorParam) {
        const errorDesc = url.searchParams.get("error_description") || errorParam;
        console.error(`[OAuth callback] Provider returned error: ${errorParam} — ${errorDesc}`);
        return new Response(`<html><body><h2>OAuth Error</h2><p>${escapeHtml(errorDesc)}</p></body></html>`, {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      if (!code || !stateParam) {
        return new Response("Missing code or state parameter", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        });
      }
      try {
        // Validate nonce against pending flows (CSRF protection)
        const flow = validateOAuthState(stateParam);
        if (!flow) {
          console.warn(`[OAuth callback] Invalid/expired state (duplicate request?). stateParam=${stateParam}`);
          return new Response(
            `<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center"><h2>Already processed</h2><p>This OAuth callback was already handled. You can close this tab.</p></div>
            </body></html>`,
            { status: 200, headers: { "Content-Type": "text/html" } },
          );
        }
        const {
          channel,
          server: serverName,
          code_verifier,
          client_id,
          client_secret,
          token_endpoint,
          redirect_uri: flowRedirectUri,
        } = flow;
        console.log(
          `[OAuth callback] Flow matched: channel=${channel}, server=${serverName}, has_token_endpoint=${!!token_endpoint}, has_redirect_uri=${!!flowRedirectUri}, has_secret=${!!client_secret}, has_verifier=${!!code_verifier}`,
        );

        // Look up the OAuth config for this server
        const { getChannelMCPServers } = await import("./agent/api/provider-config");
        const configs = getChannelMCPServers(channel);
        const serverConfig = configs[serverName];
        if (!serverConfig?.oauth) {
          console.error(`[OAuth callback] No OAuth config found for ${channel}:${serverName}`);
          return new Response("Unknown OAuth server", {
            status: 404,
            headers: { "Content-Type": "text/plain" },
          });
        }
        // Use token_endpoint from flow (most reliable), fall back to config
        const tokenUrl = token_endpoint || serverConfig.oauth.token_url || "";
        if (!tokenUrl) {
          return new Response("OAuth token URL not configured", {
            status: 500,
            headers: { "Content-Type": "text/plain" },
          });
        }
        const effectiveClientId = client_id || serverConfig.oauth.client_id;
        const redirectUri = flowRedirectUri;
        console.log(
          `[OAuth callback] Exchanging code: has_token_url=${!!tokenUrl}, has_client_id=${!!effectiveClientId}, has_redirect_uri=${!!redirectUri}`,
        );

        const token = await exchangeOAuthCode(
          code,
          tokenUrl,
          effectiveClientId,
          redirectUri,
          code_verifier,
          client_secret,
        );
        console.log(
          `[OAuth callback] Token received: type=${token.token_type}, scopes=${token.scopes?.join(",")}, expires_at=${token.expires_at}, has_refresh=${!!token.refresh_token}`,
        );
        saveOAuthToken(channel, serverName, token);

        // Try reconnecting the MCP server with the new token
        console.log(`[OAuth callback] Connecting MCP server ${serverName} with new token...`);
        const connectConfig: any = {
          transport: "http",
          url: serverConfig.url,
          token: token.access_token,
        };
        const connectResult = await workerManager.addChannelMcpServer(channel, serverName, connectConfig);
        console.log(
          `[OAuth callback] Connect result: success=${connectResult.success}, tools=${connectResult.tools}, error=${connectResult.error || "none"}`,
        );

        if (!connectResult.success) {
          const safeErr = escapeHtml(connectResult.error || "Connection failed after OAuth");
          return new Response(
            `<html><body style="font-family:system-ui;max-width:600px;margin:60px auto;padding:0 20px">
            <h2>⚠️ OAuth Succeeded, Connection Failed</h2>
            <p>Token was obtained successfully, but MCP server connection failed:</p>
            <pre style="background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto">${safeErr}</pre>
            <p>The token has been saved. Once the issue is resolved, click Connect again in the UI.</p>
            </body></html>`,
            { status: 502, headers: { "Content-Type": "text/html" } },
          );
        }

        const safeName = escapeHtml(serverName);
        return new Response(
          `<html><body><h2>MCP Connected!</h2><p>Server <b>${safeName}</b> authenticated successfully (${connectResult.tools} tools). You can close this tab.</p><script>window.close()</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      } catch (err: any) {
        const msg = err.message || "Unknown error";
        console.error(`[OAuth callback] Error: ${msg}`);
        const safeMsg = escapeHtml(msg);
        let hint = "";
        if (msg.includes("bad_client_secret") || msg.includes("invalid_client")) {
          hint =
            "<p><b>Hint:</b> This provider requires a Client Secret. Check your OAuth credentials in ~/.clawd/config.json.</p>";
        } else if (msg.includes("invalid_code") || msg.includes("code_expired")) {
          hint = "<p><b>Hint:</b> The authorization code expired. Try the OAuth flow again.</p>";
        }
        return new Response(`<html><body><h2>OAuth Error</h2><p>${safeMsg}</p>${hint}</body></html>`, {
          status: 500,
          headers: { "Content-Type": "text/html" },
        });
      }
    }

    // Article management routes (handled by registerArticleRoutes)
    const articleResponse = handleArticleRoute(req, url, path, bunServer);
    if (articleResponse) return articleResponse;

    // Public file access — DISABLED (MiniMax VLM uses base64, not URLs)
    // if (path.startsWith("/api/public/files/")) {
    //   const fileId = path.replace("/api/public/files/", "").split("/")[0];
    //   const file = getPublicFile(fileId);
    //   if (!file) return new Response("Not found", { status: 404 });
    //   return new Response(file.data, {
    //     headers: {
    //       "Content-Type": file.mimetype,
    //       "Content-Disposition": `inline; filename="${file.name}"`,
    //       "Cache-Control": "public, max-age=3600",
    //       ...corsHeaders,
    //     },
    //   });
    // }

    // ---- clawd-chat standard routes ----

    // Space-scoped MCP endpoint (Claude Code sub-agents — only complete_task)
    // Agent-scoped MCP (main Claude Code agents — auto-injects channel/agent_id)
    if (path.startsWith("/mcp/agent/")) {
      const parts = path.slice("/mcp/agent/".length).split("/");
      const [channel, agentId] = parts;
      if (channel && agentId)
        return handleAgentMcpRequest(req, decodeURIComponent(channel), decodeURIComponent(agentId));
    }

    // Space-scoped MCP (Claude Code sub-agents — only complete_task)
    if (path.startsWith("/mcp/space/")) {
      const spaceId = path.slice("/mcp/space/".length);
      if (spaceId) return handleSpaceMcpRequest(req, spaceId);
    }

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
      return json({
        ok: true,
        user_id: "UBOT",
        team_id: "T001",
        user: "Claw'd App",
      });
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

    // Copilot key pool status (fingerprint-only, no raw tokens)
    if (path === "/api/keys/status" && req.method === "GET") {
      return json({ ok: true, keys: keyPool.getStatus() });
    }
    if (path === "/api/keys/sync" && req.method === "POST") {
      keyPool.syncAllQuotas().catch(() => {});
      return json({ ok: true, message: "Quota sync triggered" });
    }

    // Reload config from disk (picks up new API keys, browser tokens, etc.)
    if (path === "/api/config/reload" && req.method === "POST") {
      reloadConfigFile();
      clearProviderConfigCache();
      return json({ ok: true, message: "Config reloaded from disk" });
    }

    // ---- Copilot Analytics ----

    // GET /api/analytics/copilot/calls
    //   ?limit=100&offset=0&from=<ms>&to=<ms>&model=X&status=ok|429|403|error
    //   &channel=X&agentId=X&keyFingerprint=X
    if (path === "/api/analytics/copilot/calls" && req.method === "GET") {
      const opts: CallsQueryOptions = {
        limit: numParam(url, "limit"),
        offset: numParam(url, "offset"),
        from: numParam(url, "from"),
        to: numParam(url, "to"),
        model: url.searchParams.get("model") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        channel: url.searchParams.get("channel") ?? undefined,
        agentId: url.searchParams.get("agentId") ?? undefined,
        keyFingerprint: url.searchParams.get("keyFingerprint") ?? undefined,
      };
      const calls = queryCalls(opts);
      const total = queryCallsCount(opts);
      return json({ ok: true, total, calls });
    }

    // GET /api/analytics/copilot/summary?granularity=day|hour|week&from=<ms>&to=<ms>&...
    if (path === "/api/analytics/copilot/summary" && req.method === "GET") {
      const granularity = (url.searchParams.get("granularity") ?? "day") as "day" | "hour" | "week";
      const opts: CallsQueryOptions & {
        granularity?: "day" | "hour" | "week";
      } = {
        from: numParam(url, "from"),
        to: numParam(url, "to"),
        model: url.searchParams.get("model") ?? undefined,
        channel: url.searchParams.get("channel") ?? undefined,
        agentId: url.searchParams.get("agentId") ?? undefined,
        granularity,
      };
      return json({ ok: true, summary: querySummary(opts) });
    }

    // GET /api/analytics/copilot/keys?from=<ms>&to=<ms>
    if (path === "/api/analytics/copilot/keys" && req.method === "GET") {
      const opts: CallsQueryOptions = {
        from: numParam(url, "from"),
        to: numParam(url, "to"),
      };
      const stats = queryKeyStats(opts);
      // Enrich with live KeyPool data (premium remaining from GitHub API)
      const liveStatus = keyPool.getStatus();
      const enriched = stats.map((s) => {
        const live = liveStatus.find((l) => s.key_fingerprint === l.fingerprint);
        return {
          ...s,
          premium_remaining: live?.premiumRemainingFromApi ?? null,
          premium_used_cycle: live?.premiumUsedCycle ?? null,
          user_initiator_sent_today: live?.userInitiatorSentToday ?? null,
        };
      });
      return json({ ok: true, keys: enriched });
    }

    // GET /api/analytics/copilot/keys/history?granularity=day|hour|week&from=<ms>&to=<ms>&keyFingerprint=X
    if (path === "/api/analytics/copilot/keys/history" && req.method === "GET") {
      const granularity = (url.searchParams.get("granularity") ?? "day") as "day" | "hour" | "week";
      const opts = {
        from: numParam(url, "from"),
        to: numParam(url, "to"),
        keyFingerprint: url.searchParams.get("keyFingerprint") ?? undefined,
        granularity,
      };
      return json({ ok: true, history: queryKeyHistory(opts) });
    }

    // GET /api/analytics/copilot/models?from=<ms>&to=<ms>&channel=X
    if (path === "/api/analytics/copilot/models" && req.method === "GET") {
      const opts: CallsQueryOptions = {
        from: numParam(url, "from"),
        to: numParam(url, "to"),
        channel: url.searchParams.get("channel") ?? undefined,
      };
      return json({ ok: true, models: queryModelStats(opts) });
    }

    // GET /api/analytics/copilot/recent?window=60  (last N minutes rolling window)
    if (path === "/api/analytics/copilot/recent" && req.method === "GET") {
      const window = numParam(url, "window") ?? 60;
      return json({
        ok: true,
        windowMinutes: window,
        ...queryRecentStats(window),
      });
    }

    if (path === "/api/conversations.create" && req.method === "POST") {
      const body = await parseBody(req);
      const v = validateBody(
        z.object({ name: z.string().min(1), description: z.string().optional(), user: z.string().optional() }),
        body,
      );
      if (!v.ok) return v.error;
      return json(createChannel(v.data.name, v.data.user));
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
      const v = validateBody(
        z.object({
          channel: z.string().optional(),
          text: z.string().optional(),
          thread_ts: z.string().optional(),
          user: z.string().optional(),
          agent_id: z.string().optional(),
          subtype: z.string().optional(),
          html_preview: z.string().optional(),
          code_preview: z.unknown().optional(),
          article_json: z.string().optional(),
          subspace_json: z.string().optional(),
          workspace_json: z.string().optional(),
          tool_result_json: z.string().optional(),
          interactive_json: z.string().optional(),
        }),
        body,
      );
      if (!v.ok) return v.error;
      const result = postMessage({
        channel: v.data.channel || "general",
        text: v.data.text,
        thread_ts: v.data.thread_ts,
        user: v.data.user,
        agent_id: v.data.agent_id,
        subtype: v.data.subtype,
        html_preview: v.data.html_preview,
        code_preview: v.data.code_preview,
        article_json: v.data.article_json,
        subspace_json: v.data.subspace_json,
        workspace_json: v.data.workspace_json,
        tool_result_json: v.data.tool_result_json,
        interactive_json: v.data.interactive_json,
      });
      if ((result as any).cleared) {
        const clearedChannel = body.channel || "general";
        broadcastChannelCleared(clearedChannel);
        // Reset all agent sessions for this channel (fire-and-forget)
        workerManager.resetChannel(clearedChannel).catch(() => {});
        return json(result);
      }
      if (result.ok && body.files && Array.isArray(body.files) && body.files.length > 0) {
        attachFilesToMessage(
          result.ts,
          body.files.map((f: { id: string }) => f.id),
        );
      }
      if (result.ok) {
        const msg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(result.ts);
        if (msg) broadcastMessage(body.channel || "general", msg);
        // Wake deferred agents for this channel (inactive >1 day, not started on boot)
        const ch = body.channel || "general";
        if (body.user === "UHUMAN" && workerManager.hasDeferredAgents(ch)) {
          workerManager.startDeferredAgents(ch).catch(() => {});
        }
      }
      return json(result);
    }

    // Interactive artifact action
    if (path === "/api/artifact.action" && req.method === "POST") {
      const body = await parseBody(req);
      // Resolve user from auth context or fallback to body
      const user = body.user || "UHUMAN";
      const result = await handleArtifactAction(
        {
          message_ts: body.message_ts,
          channel: body.channel,
          action_id: body.action_id,
          value: body.value,
          values: body.values || {},
        },
        user,
      );
      // Broadcast if action succeeded
      if (result.ok && (result as any)._broadcast) {
        broadcastArtifactAction(body.channel, (result as any)._broadcast);
      }
      // Remove internal _broadcast from response
      const { _broadcast, ...response } = result as any;
      return json(response);
    }

    // Resolve datasource for interactive artifacts (file → parsed data with filters)
    if (path === "/api/artifact.datasource" && req.method === "POST") {
      const body = await parseBody(req);
      const { handleDatasource } = await import("./server/routes/artifact-datasource");
      const result = handleDatasource(body);
      return json(result, result.ok ? 200 : 400);
    }

    // Get artifact actions (for agents to read user responses)
    if (path === "/api/artifact.actions" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.message_ts || !body.channel) return json({ ok: false, error: "message_ts and channel required" }, 400);
      return json(getArtifactActions(body.message_ts, body.channel));
    }

    // Update message
    if (path === "/api/chat.update" && req.method === "POST") {
      const body = await parseBody(req);
      const result = updateMessage({
        channel: body.channel || "general",
        ts: body.ts,
        text: body.text,
        tool_result_json: body.tool_result_json,
      });
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

      // File visibility — DISABLED (MiniMax VLM uses base64, not public URLs)
      // if (subPath === "visibility" && req.method === "POST") {
      //   const body = (await req.json()) as { visible?: boolean };
      //   if (typeof body.visible !== "boolean") return json({ ok: false, error: "missing_visible_field" }, 400);
      //   const result = setFileVisibility(fileId, body.visible);
      //   if (!result.ok) return json(result, 404);
      //   return json(result);
      // }

      if (subPath === "optimized") {
        const maxWidth = parseInt(url.searchParams.get("maxWidth") || "1280", 10);
        const maxHeight = parseInt(url.searchParams.get("maxHeight") || "720", 10);
        const quality = parseInt(url.searchParams.get("quality") || "70", 10);
        const maxBytes = parseInt(url.searchParams.get("maxBytes") || "102400", 10);
        const optimized = await getOptimizedFile(fileId, {
          maxWidth,
          maxHeight,
          quality,
          maxBytes,
        });
        if (!optimized) return new Response("Not found", { status: 404 });
        return new Response(optimized.data, {
          headers: {
            "Content-Type": optimized.mimetype,
            "Content-Disposition": contentDisposition("inline", optimized.name),
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
          "Content-Disposition": contentDisposition("inline", file.name),
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
    // Task APIs
    // ========================================================================

    if (path === "/api/tasks.list") {
      const agent_id = url.searchParams.get("agent_id") || undefined;
      const status = url.searchParams.get("status") || undefined;
      const channel = url.searchParams.get("channel") || undefined;
      const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : undefined;
      return json({
        ok: true,
        tasks: listTasks({ agent_id, status, channel, limit }),
      });
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
      const v = validateBody(
        z.object({
          title: z.string().min(1),
          description: z.string().optional(),
          status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
          priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
          tags: z.array(z.string()).optional(),
          agent_id: z.string().optional(),
          due_at: z.number().optional(),
          channel: z.string().optional(),
        }),
        body,
      );
      if (!v.ok) return v.error;
      return json({
        ok: true,
        task: createTask(v.data),
      });
    }

    if (path === "/api/tasks.batchCreate" && req.method === "POST") {
      const body = await parseBody(req);
      if (!Array.isArray(body.tasks)) return json({ ok: false, error: "tasks array required" }, 400);
      if (body.tasks.length === 0) return json({ ok: false, error: "tasks array is empty" }, 400);
      if (body.tasks.length > 20) return json({ ok: false, error: "max 20 tasks per batch" }, 400);
      for (const t of body.tasks) {
        if (!t.title) return json({ ok: false, error: "each task must have a title" }, 400);
      }
      const agentId: string = body.agent_id || "default";
      const channel: string | undefined = body.channel || undefined;
      const tasks = createTasksBatch(body.tasks as Parameters<typeof createTasksBatch>[0], agentId, channel);
      return json({ ok: true, tasks });
    }

    if (path === "/api/tasks.update" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.task_id) return json({ ok: false, error: "task_id required" }, 400);
      const result = updateTask(body.task_id, body);
      if (!result.success) {
        const r = result as {
          success: false;
          error: string;
          claimed_by?: string;
        };
        if (r.error === "not_found") return json({ ok: false, error: "task_not_found" }, 404);
        if (r.error === "already_claimed")
          return json({ ok: false, error: "already_claimed", claimed_by: r.claimed_by }, 409);
      }
      const updatedTask = (result as { success: true; task: { channel?: string; title: string } }).task;
      if (body.status === "done" || body.status === "completed") {
        const channel = updatedTask.channel;
        const allTasks = listTasks(channel ? { channel } : {});
        const done = allTasks.filter((t: { status: string }) => t.status === "done").length;
        const total = allTasks.length;
        const remaining = allTasks
          .filter((t: { status: string }) => t.status !== "done")
          .map((t: { title: string }) => t.title)
          .slice(0, 5);
        return json({
          ok: true,
          task: updatedTask,
          progress: { done, total, remaining },
          hint:
            remaining.length > 0
              ? `Consider reporting progress to chat: "Done: ${updatedTask.title}. (${done}/${total})"`
              : "All tasks complete! Send a summary to chat.",
        });
      }
      return json({
        ok: true,
        task: updatedTask,
      });
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
    // Todo APIs (per-agent todo lists)
    // ========================================================================

    if (path === "/api/todos.read") {
      const agent_id = url.searchParams.get("agent_id");
      const channel = url.searchParams.get("channel");
      if (!agent_id || !channel) return json({ ok: false, error: "agent_id and channel required" }, 400);
      return json({ ok: true, items: getTodos(agent_id, channel) });
    }

    if (path === "/api/todos.write" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.agent_id || !body.channel) return json({ ok: false, error: "agent_id and channel required" }, 400);
      if (!Array.isArray(body.items)) return json({ ok: false, error: "items array required" }, 400);
      if (body.items.length > 50) return json({ ok: false, error: "max 50 items per todo list" }, 400);
      const items = writeTodos(body.agent_id, body.channel, body.items);
      return json({ ok: true, items, completed: items.length === 0 && body.items.length > 0 });
    }

    if (path === "/api/todos.update" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.agent_id || !body.channel || !body.item_id || !body.status)
        return json({ ok: false, error: "agent_id, channel, item_id, and status required" }, 400);
      const items = updateTodoItem(body.agent_id, body.channel, body.item_id, body.status);
      return json({ ok: true, items, completed: items.length === 0 });
    }

    if (path === "/api/todos.list") {
      const channel = url.searchParams.get("channel");
      if (!channel) return json({ ok: false, error: "channel required" }, 400);
      return json({ ok: true, agents: listChannelTodos(channel) });
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
      return json({
        ok: true,
        plan: createPlan(body as Parameters<typeof createPlan>[0]),
      });
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
      const phase = addPhase(
        body.plan_id,
        body as {
          name: string;
          description?: string;
          agent_in_charge?: string;
        },
      );
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
      return json({
        ok: true,
        channel,
        last_seen_ts: result?.last_seen_ts || null,
      });
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
    return json({ ok: false, error: "Internal server error" }, 500);
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
    // Clean up orphaned tmux sessions from previous runs
    try {
      const { cleanupStaleTmuxSessions } = await import("./claude-code-tmux");
      cleanupStaleTmuxSessions();
    } catch {}

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
          const res = await fetch(`${config.chatApiUrl}/api/app.agents.list`, {
            signal: recoverCtrl.signal,
          }).finally(() => clearTimeout(recoverTimer));
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
            // Use space.agent_id (sub-agent ID) instead of parent agent ID.
            // The task message was posted with the parent's agent_id — if we poll
            // as the parent, the message is filtered as "own message" and the
            // recovered worker finds nothing to process.
            agentId: space.agent_id,
            project: agentEntry.project,
          };

          // Reset agent_seen for the sub-agent in the space channel so the
          // initial task message is treated as unseen by the recovered worker.
          try {
            db.run(`DELETE FROM agent_seen WHERE agent_id = ? AND channel = ?`, [space.agent_id, space.space_channel]);
          } catch {
            /* best-effort — worker will still poll */
          }

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
              postToChannel(
                config.chatApiUrl,
                space.channel,
                `Space ${isTimeout ? "timed_out" : "failed"}: ${space.title}`,
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
                    `Space failed: ${space.title}`,
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
    Bun.spawn([openCmd, `http://localhost:${PORT}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
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

// ============================================================================
// DB Maintenance — WAL checkpoint, prune old analytics, orphaned seen rows
// ============================================================================

function runDbMaintenance() {
  try {
    // WAL checkpoint — flush WAL to main DB file and truncate
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    // Prune copilot_calls older than 30 days
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
    db.run(`DELETE FROM copilot_calls WHERE ts < ?`, [thirtyDaysAgo]);

    // Clean orphaned message_seen rows (message no longer exists)
    db.run(`DELETE FROM message_seen WHERE message_ts NOT IN (SELECT ts FROM messages)`);

    // Purge old sessions from memory.db (>30 days)
    try {
      const sm = getSessionManager();
      if (sm) sm.purgeOldSessions(30);
    } catch {}

    console.log("[DB Maintenance] Checkpoint + cleanup completed");
  } catch (err) {
    console.error("[DB Maintenance] Error:", err);
  }
}

// Run maintenance every 30 minutes
const dbMaintenanceTimer = setInterval(runDbMaintenance, 30 * 60 * 1000);
dbMaintenanceTimer.unref();

// Graceful shutdown (SP25: scheduler → spaces → workers)
// Force-exit after 8s to prevent hang if cleanup gets stuck
let shutdownInProgress = false;
const gracefulShutdown = async (signal: string) => {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[clawd-app] Received ${signal}, shutting down...`);
  const forceTimer = setTimeout(() => {
    console.error("[clawd-app] Shutdown timed out after 15s, forcing exit");
    process.exit(1);
  }, 15000);
  forceTimer.unref();
  try {
    await scheduler.stop();
    await spaceWorkerManager.stopAll();
    await workerManager.stop();
    // Always destroy workspace containers on shutdown (even if feature was disabled after
    // containers were created, to prevent Docker resource leaks)
    const { listActiveWorkspaces, destroyWorkspace } = await import("./agent/workspace/container.js");
    const workspaces = listActiveWorkspaces();
    if (workspaces.length > 0) {
      console.log(`[clawd-app] Destroying ${workspaces.length} workspace container(s)...`);
      await Promise.allSettled(workspaces.map((w) => destroyWorkspace(w.id)));
    }
  } catch (err) {
    console.error("[clawd-app] Error during shutdown:", err);
  }
  // Final DB maintenance — checkpoint WAL before exit
  try {
    runDbMaintenance();
  } catch {}
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Prevent unhandled rejections from crashing the process
// (Claude Code SDK subprocess errors can surface as unhandled rejections)
process.on("unhandledRejection", (reason: any) => {
  console.error(`[clawd-app] Unhandled rejection: ${reason?.message || reason}`);
  if (reason?.stack) console.error(`[clawd-app] Stack: ${reason.stack.slice(0, 500)}`);
});

process.on("uncaughtException", (err: Error) => {
  console.error(`[clawd-app] Uncaught exception: ${err.message}`);
  if (err.stack) console.error(`[clawd-app] Stack: ${err.stack.slice(0, 500)}`);
  // Don't exit — let the process continue serving other agents
});
