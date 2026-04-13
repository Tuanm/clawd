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
// --help and unknown-option errors are handled inside loadConfig() (config.ts).
// That call is the first executable line below, so it exits before any DB init.

import { z } from "zod";
import { keyPool } from "./agent/api/key-pool";
import { clearConfigCache as clearProviderConfigCache, ensureKeyPoolInitialized } from "./agent/api/provider-config";
import { applyTokenLimitOverrides } from "./agent/constants/context-limits";
import { getSessionManager } from "./agent/session/manager";
import { setDebug } from "./agent/utils/debug";
// Now import modules (database will initialize)
import { registerAgentRoutes } from "./server/routes/agents";
import { registerArticleRoutes } from "./server/routes/articles";
import { getPublicOrigin, registerMcpServerRoutes } from "./server/routes/mcp-servers";
import { registerSchedulerRoutes } from "./server/routes/scheduler";
import { registerWorktreeRoutes } from "./server/routes/worktree";
import { loadConfig, validateConfig } from "./config/config";
import {
  getDataDir,
  hasGlobalAuth,
  isAuthEnabled,
  isBrowserEnabled,
  isChannelAuthRequired,
  loadConfigFile,
  reloadConfigFile,
  validateApiToken,
} from "./config/config-file";
import { extensionZipSize, getExtensionZip } from "./embedded/extension";
import { embeddedUIFileCount, embeddedUITotalSize, getEmbeddedAsset, hasEmbeddedUI } from "./embedded/ui";
import { escapeHtml, exchangeOAuthCode, saveOAuthToken, validateOAuthState } from "./server/mcp/oauth";
import { upgradeBrowserWs } from "./server/browser-bridge";
import { upgradeRemoteWorkerWs } from "./server/remote-worker";
import { corsHeaders, json, numParam, parseBody } from "./server/http-helpers";
import { validateBody } from "./server/validate";
import { postToChannel } from "./utils/api-client";
import { createLogger, setLogLevel } from "./utils/logger";
import { timedFetch } from "./utils/timed-fetch";
import { WorkerManager } from "./worker-manager";

// Load configuration from CLI args + config file
const config = loadConfig();

// Enable debug mode if configured
if (config.debug) {
  setDebug(true);
  setLogLevel("debug");
}

const logger = createLogger("clawd");

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

import type { ToolResult } from "./agent/tools/definitions";
import { tools as builtinTools } from "./agent/tools/definitions";
import { SchedulerManager } from "./scheduler/manager";
import { initRunner } from "./scheduler/runner";
// ============================================================================
// Import clawd-chat server modules
// ============================================================================
import {
  clearStaleStreamingStates,
  db,
  getOrRegisterAgent,
  type Message,
  migrateChannelIds,
  renameChannel,
} from "./server/database";
import {
  handleAgentMcpRequest,
  handleMcpRequest,
  handleSpaceMcpRequest,
  setMcpScheduler,
  setMcpWorkerManager,
} from "./server/mcp";
import { handleAgentStatusRoutes } from "./server/routes/agents";
import { handleAnalyticsRoutes } from "./server/routes/analytics";
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
  postMessage,
  removeReaction,
  searchMessages,
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
  broadcastArtifactAction,
  broadcastChannelCleared,
  broadcastMessage,
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

// Run channel ID migration on startup (normalizes legacy C-prefixed IDs to names)
const migrated = migrateChannelIds();
if (migrated.length > 0) {
  logger.info(`Migration: normalized ${migrated.length} channel ID(s):`, migrated);
}

// Rename reserved channel names that conflict with management routes
for (const reserved of ["agents", "skills"]) {
  const exists = db.query("SELECT id FROM channels WHERE id = ?").get(reserved) as { id: string } | null;
  if (exists) {
    renameChannel(reserved, `${reserved}-space`);
    logger.warn(`Migration: renamed reserved channel "${reserved}" to "${reserved}-space"`);
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
      const res = await timedFetch(`${config.chatApiUrl}/api/app.agents.list`);
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
      } catch (err: unknown) {
        return {
          success: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
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
setMcpWorkerManager(workerManager);

// Wire channel MCP lookup so sub-agents inherit parent channel's MCP servers
spaceWorkerManager.setChannelMcpLookup((channel) => workerManager.getChannelMcpManager(channel));

// Register agent management API routes
const handleAgentRoute = registerAgentRoutes(db, workerManager);

// Register MCP server management API routes
const handleMcpServerRoute = registerMcpServerRoutes(workerManager);

// Register article management API routes
const handleArticleRoute = registerArticleRoutes(db);

// Register scheduler management API routes
const handleSchedulerRoute = registerSchedulerRoutes(scheduler);

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

  // clawd specific: check for app-ui adjacent to executable
  const appUi = join(execDir, "app-ui");
  if (existsSync(appUi)) return appUi;

  // Dev mode: local packages/ui dist
  const devPath = join(dirname(Bun.main), "..", "packages", "ui", "dist");
  if (existsSync(devPath)) return devPath;

  // Fallback: dist/ui relative to cwd
  const cwdPath = join(process.cwd(), "dist", "ui");
  if (existsSync(cwdPath)) return cwdPath;

  logger.warn("UI directory not found and no embedded UI available");
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
// HTTP helpers (imported from server/http-helpers.ts)
// ============================================================================

const corsResponse = new Response(null, { headers: corsHeaders });

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
    } catch (err: unknown) {
      logger.error("File upload error:", err);
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
// Auth helpers — delegated to middleware.ts (single source of truth)
// ============================================================================
import { extractToken, extractWsToken, isInternalToken, handleAuthChannel, validateApiKey } from "./server/middleware";

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

    // IMPORTANT: /api/auth.channel is intentionally pre-auth (no token required to probe
    // whether a channel needs auth). Do NOT add this route inside handleRequest.
    if (path === "/api/auth.channel") {
      return handleAuthChannel(req, url);
    }

    // WebSocket upgrade — chat (/ws) or workspace noVNC proxy (/workspace/:id/novnc/websockify)
    if (path === "/ws") {
      if (isAuthEnabled()) {
        const wsToken = extractWsToken(url);
        if (!isInternalToken(wsToken)) {
          // WS has no channel context. Only enforce auth if:
          // - a token was provided but is invalid, OR
          // - a global "*" catch-all auth is configured (applies to all channels/WS)
          // Channel-scoped-only deployments (no "*" key) allow WS without a token.
          if (wsToken ? !validateApiToken(wsToken) : hasGlobalAuth()) {
            return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
      }
      // Always UHUMAN when auth active; honour ?user= in dev
      const userId = isAuthEnabled() ? "UHUMAN" : url.searchParams.get("user") || "UHUMAN";
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
        logger.info("browser-bridge: rejected /browser/ws — browser feature not enabled");
        return new Response("Browser features not enabled", { status: 403 });
      }
      return upgradeBrowserWs(req, server);
    }

    // Remote worker WebSocket bridge
    if (path === "/worker/ws") {
      return upgradeRemoteWorkerWs(req, server);
    }

    // Browser file transfer API (extension uploads/downloads files via chat server)
    if (path.startsWith("/browser/files")) {
      if (!isBrowserEnabled()) {
        return new Response("Browser features not enabled", { status: 403 });
      }
      return handleBrowserFileRequest(req, url, path);
    }

    // API routes
    if (path.startsWith("/api/") || path.startsWith("/mcp") || path === "/health") {
      // NOTE: /api/auth.channel is handled pre-auth above — see handleAuthChannel.
      // Auth check delegated to middleware.ts (single source of truth).
      const authError = validateApiKey(req, url, path, isAuthEnabled);
      if (authError) return authError;
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
    // ---- clawd specific routes ----

    // Agent management routes (handled by registerAgentRoutes)
    const agentResponse = handleAgentRoute(req, url, path, bunServer);
    if (agentResponse) return agentResponse;

    // MCP server management routes
    const mcpResponse = handleMcpServerRoute(req, url, path);
    if (mcpResponse) return mcpResponse;

    // Scheduler management routes
    const schedulerResponse = handleSchedulerRoute(req, url, path);
    if (schedulerResponse) return schedulerResponse;

    // Worktree management routes
    const worktreeResponse = handleWorktreeRoute(req, url, path);
    if (worktreeResponse) return worktreeResponse;

    // CIMD: Serve client metadata document for MCP OAuth (SEP-991)
    if (path === "/.well-known/oauth-client.json") {
      const publicOrigin = getPublicOrigin(req, url);
      return new Response(
        JSON.stringify({
          client_id: `${publicOrigin}/.well-known/oauth-client.json`,
          client_name: "Claw'd",
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
      // SECURITY: Never log auth codes or full query strings — they contain credentials
      logger.debug(
        `OAuth callback: code=${code ? "present" : "null"}, state=${stateParam ? "present" : "null"}, error=${errorParam || "none"}`,
      );

      if (errorParam) {
        const errorDesc = url.searchParams.get("error_description") || errorParam;
        logger.error(`OAuth callback: provider returned error: ${errorParam} — ${errorDesc}`);
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
          logger.warn(`OAuth callback: invalid/expired state (duplicate request?). stateParam=${stateParam}`);
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
        logger.debug(
          `OAuth callback: flow matched channel=${channel}, server=${serverName}, has_token_endpoint=${!!token_endpoint}, has_redirect_uri=${!!flowRedirectUri}, has_secret=${!!client_secret}, has_verifier=${!!code_verifier}`,
        );

        // Look up the OAuth config for this server
        const { getChannelMCPServers } = await import("./agent/api/provider-config");
        const configs = getChannelMCPServers(channel);
        const serverConfig = configs[serverName];
        if (!serverConfig?.oauth) {
          logger.error(`OAuth callback: no OAuth config found for ${channel}:${serverName}`);
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
        logger.debug(
          `OAuth callback: exchanging code has_token_url=${!!tokenUrl}, has_client_id=${!!effectiveClientId}, has_redirect_uri=${!!redirectUri}`,
        );

        const token = await exchangeOAuthCode(
          code,
          tokenUrl,
          effectiveClientId,
          redirectUri,
          code_verifier,
          client_secret,
        );
        logger.info(
          `OAuth callback: token received type=${token.token_type}, scopes=${token.scopes?.join(",")}, expires_at=${token.expires_at}, has_refresh=${!!token.refresh_token}`,
        );
        saveOAuthToken(channel, serverName, token);

        // Try reconnecting the MCP server with the new token
        logger.info(`OAuth callback: connecting MCP server ${serverName} with new token...`);
        const connectConfig: any = {
          transport: "http",
          url: serverConfig.url,
          token: token.access_token,
        };
        const connectResult = await workerManager.addChannelMcpServer(channel, serverName, connectConfig);
        logger.info(
          `OAuth callback: connect result success=${connectResult.success}, tools=${connectResult.tools}, error=${connectResult.error || "none"}`,
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        logger.error(`OAuth callback error: ${msg}`);
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
        server: "clawd",
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
      keyPool.syncAllQuotas().catch((err) => {
        logger.warn("[index] syncAllQuotas failed:", err);
      });
      return json({ ok: true, message: "Quota sync triggered" });
    }

    // Reload config from disk (picks up new API keys, browser tokens, etc.)
    if (path === "/api/config/reload" && req.method === "POST") {
      reloadConfigFile();
      clearProviderConfigCache();
      return json({ ok: true, message: "Config reloaded from disk" });
    }

    // ---- Copilot Analytics ----
    const analyticsResponse = handleAnalyticsRoutes(req, url, path);
    if (analyticsResponse) return analyticsResponse;

    if (path === "/api/conversations.create" && req.method === "POST") {
      const body = await parseBody(req);
      const v = validateBody(
        z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          user: z.string().optional(),
        }),
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
      return json(searchMessages(channel, search, beforeTs, limit));
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
        workerManager.resetChannel(clearedChannel).catch((err) => {
          logger.warn("[index] resetChannel failed:", err);
        });
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
          workerManager.startDeferredAgents(ch).catch((err) => {
            logger.warn("[index] startDeferredAgents failed:", err);
          });
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

    // Agent status routes (polling, seen, streaming, thoughts, user tracking)
    const agentStatusResponse = await handleAgentStatusRoutes(req, url, path);
    if (agentStatusResponse) return agentStatusResponse;

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
      const tv = validateBody(
        z.object({
          task_id: z.string(),
          title: z.string().optional(),
          description: z.string().optional(),
          status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
          priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
          tags: z.string().optional(),
          due_at: z.number().optional(),
          claimer: z.string().optional(),
        }),
        body,
      );
      if (!tv.ok) return tv.error;
      const result = updateTask(tv.data.task_id, tv.data);
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
      if (tv.data.status === "done") {
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
      return json({
        ok: true,
        items,
        completed: items.length === 0 && body.items.length > 0,
      });
    }

    if (path === "/api/todos.update" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.agent_id || !body.channel || !body.item_id || !body.status)
        return json(
          {
            ok: false,
            error: "agent_id, channel, item_id, and status required",
          },
          400,
        );
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
    logger.error("Server error:", error);
    return json({ ok: false, error: "Internal server error" }, 500);
  }
}

// ============================================================================
// Startup
// ============================================================================

// startup banner — intentionally uses console.log (not logger) so it always shows regardless of log level
console.log(`
+---------------------------------------------------------------+
|  Claw'd App                                                   |
+---------------------------------------------------------------+
|  HTTP:      http://${HOST}:${PORT}
|  WebSocket: ws://${HOST}:${PORT}/ws
|  UI:        ${hasEmbeddedUI ? `embedded (${embeddedUIFileCount} files, ${(embeddedUITotalSize / 1024 / 1024).toFixed(1)}MB)` : UI_DIR ? UI_DIR : "(not found)"}
+---------------------------------------------------------------+
`);

// Start worker manager (loads agents from DB, starts polling loops)
setTimeout(async () => {
  try {
    // Clean up orphaned tmux sessions from previous runs
    try {
      const { cleanupStaleTmuxSessions } = await import("./claude-code/tmux");
      cleanupStaleTmuxSessions();
    } catch {}

    await workerManager.start();
    scheduler.start();

    // Space recovery AFTER scheduler.start() — prevents runningJobs.clear() from wiping recovered registrations
    const activeSpaces = spaceManager.getActiveSpaces();
    if (activeSpaces.length > 0) {
      logger.info(`Spaces: recovering ${activeSpaces.length} active space(s)...`);
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
          const res = await timedFetch(`${config.chatApiUrl}/api/app.agents.list`);
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
              ).catch((err) => {
                logger.warn("[index] postToChannel (abort) failed:", err);
              });
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
                  ).catch((err) => {
                    logger.warn("[index] postToChannel (fail) failed:", err);
                  });
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

          logger.info(
            `Spaces: recovered space ${space.id} (${space.title}), ${Math.round(remainingMs / 1000)}s remaining`,
          );
        } catch (err) {
          logger.error(`Spaces: failed to recover space ${space.id}:`, err);
          spaceManager.failSpace(space.id, "Recovery failed");
        }
      }
    }
  } catch (error) {
    logger.error("Failed to start worker manager:", error);
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
    logger.info(`Open http://localhost:${PORT} in your browser`);
  }
}

// Periodic cleanup: clear stale streaming states
setInterval(() => {
  try {
    const { cleared } = clearStaleStreamingStates();
    if (cleared.length > 0) {
      logger.info(`Cleanup: cleared stale streaming states: ${cleared.join(", ")}`);
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
    logger.error("Cleanup: error clearing stale streaming:", err);
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

    logger.info("DB maintenance: checkpoint + cleanup completed");
  } catch (err) {
    logger.error("DB maintenance error:", err);
  }
}

// Run maintenance every 30 minutes
const dbMaintenanceTimer = setInterval(runDbMaintenance, 30 * 60 * 1000);
dbMaintenanceTimer.unref();

// Graceful shutdown (SP25: scheduler → spaces → workers)
// Force-exit after 15s to prevent hang if cleanup gets stuck
let shutdownInProgress = false;
const gracefulShutdown = async (signal: string) => {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  logger.info(`Received ${signal}, shutting down...`);
  const forceTimer = setTimeout(() => {
    logger.error("Shutdown timed out after 15s, forcing exit");
    process.exit(1);
  }, 15000);
  forceTimer.unref();
  try {
    await scheduler.stop();
    await spaceWorkerManager.stopAll();
    await workerManager.stop();
  } catch (err) {
    logger.error("Error during shutdown:", err);
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
  logger.error(`Unhandled rejection: ${reason?.message || reason}`);
  if (reason?.stack) logger.error(`Stack: ${reason.stack.slice(0, 500)}`);
});

process.on("uncaughtException", (err: Error) => {
  logger.error(`Uncaught exception: ${err.message}`);
  if (err.stack) logger.error(`Stack: ${err.stack.slice(0, 500)}`);
  // Don't exit — let the process continue serving other agents
});
