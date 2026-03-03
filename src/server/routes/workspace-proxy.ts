/**
 * Workspace noVNC Proxy
 *
 * Routes:
 *   HTTP  GET  /workspace/:id/novnc/*             → Caddy gateway → container noVNC
 *   WS         /workspace/:id/novnc/websockify     → Caddy gateway → container websockify
 *
 * The gateway (clawd-gateway container, Caddy) handles routing to the correct
 * workspace container via Docker network DNS (clawd-ws-{id}:6080).
 * Workspace containers no longer publish noVNC/VNC ports to the host.
 */

import type { ServerWebSocket } from "bun";
import { GATEWAY_ADMIN_PORT, GATEWAY_PROXY_PORT } from "../../agent/src/workspace/gateway.js";

/** Per-connection map: connId → backend WebSocket (Caddy gateway → noVNC websockify) */
const wsProxyBackends = new Map<string, WebSocket>();

/** Messages buffered while the backend WS is still in CONNECTING state */
const wsProxyPendingQueues = new Map<string, Array<string | ArrayBuffer>>();

// Workspace ID is always exactly 16 lowercase hex chars (randomBytes(8).toString('hex'))
const WORKSPACE_ID_RE = /^[a-f0-9]{16}$/;

/** Validate workspace ID format before use */
function isValidWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_RE.test(id);
}

/**
 * Ensure the Caddy gateway has a route for this workspace.
 * Checks the Caddy admin API first (fast); registers the route only if missing.
 * Handles the case where connectWorkspaceToGateway failed silently at spawn time.
 */
async function ensureGatewayRoute(workspaceId: string): Promise<void> {
  try {
    // Fast check: does Caddy already have this route?
    const check = await fetch(`http://127.0.0.1:${GATEWAY_ADMIN_PORT}/id/ws-${workspaceId}`, {
      signal: AbortSignal.timeout(1000),
    });
    if (check.ok) return; // Route already registered
  } catch {
    // Admin API unreachable — try to reconnect anyway
  }
  // Route missing: register it now (idempotent)
  const { connectWorkspaceToGateway } = await import("../../agent/src/workspace/gateway.js");
  await connectWorkspaceToGateway(workspaceId);
}

// ─── HTTP proxy ───────────────────────────────────────────────────────────────

/**
 * Proxy a normal HTTP request to the workspace's noVNC server via the gateway.
 * Called for all /workspace/:id/novnc/* paths.
 */
export async function handleWorkspaceProxy(req: Request, url: URL, workspaceId: string): Promise<Response> {
  if (!isValidWorkspaceId(workspaceId)) {
    return new Response(JSON.stringify({ error: "invalid_workspace_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Strip the /workspace/:id/novnc prefix to get the noVNC-relative path
  const prefix = `/workspace/${workspaceId}/novnc`;
  const novncPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || "/" : "/";

  // Forward to gateway: /{workspaceId}/{novncPath}
  const targetUrl = `http://127.0.0.1:${GATEWAY_PROXY_PORT}/${workspaceId}${novncPath}${url.search}`;

  try {
    const filteredHeaders = filterProxyHeaders(req.headers);
    filteredHeaders["host"] = `127.0.0.1:${GATEWAY_PROXY_PORT}`;

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: filteredHeaders,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });

    // Pass response through, stripping hop-by-hop headers
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders.set(key, value);
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "proxy_error", message: err.message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ─── WebSocket proxy ──────────────────────────────────────────────────────────

export interface WorkspaceWsData {
  type: "workspace-novnc";
  workspaceId: string;
  connId: string;
}

/**
 * Upgrade a client WebSocket connection for /workspace/:id/novnc/websockify.
 * Returns undefined if upgraded successfully, or an error Response.
 */
export async function upgradeWorkspaceWs(
  req: Request,
  workspaceId: string,
  bunServer: any,
): Promise<Response | undefined> {
  if (!isValidWorkspaceId(workspaceId)) {
    return new Response(JSON.stringify({ error: "invalid_workspace_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Ensure gateway route exists — registers it if missing (e.g., if connectWorkspaceToGateway
  // failed silently at spawn time, or if the Caddy container restarted and lost routes)
  await ensureGatewayRoute(workspaceId).catch((err) =>
    console.warn(`[ws-proxy] gateway route ensure failed for ${workspaceId}:`, err?.message),
  );

  const connId = crypto.randomUUID();
  const data: WorkspaceWsData = {
    type: "workspace-novnc",
    workspaceId,
    connId,
  };

  const upgraded = bunServer.upgrade(req, { data });
  return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
}

export function handleWorkspaceWsOpen(ws: ServerWebSocket<WorkspaceWsData>): void {
  const { workspaceId, connId } = ws.data;

  // Init pending queue to buffer messages while backend is still CONNECTING
  wsProxyPendingQueues.set(connId, []);

  // Connect to the gateway which relays to the workspace's noVNC websockify
  // Gateway resolves clawd-ws-{workspaceId}:6080 via Docker network DNS
  const backend = new WebSocket(`ws://127.0.0.1:${GATEWAY_PROXY_PORT}/${workspaceId}/websockify`, ["binary", "base64"]);
  backend.binaryType = "arraybuffer";

  // Timeout if gateway/container never connects (e.g., container crashed)
  const connectTimeout = setTimeout(() => {
    if (backend.readyState === WebSocket.CONNECTING) {
      wsProxyPendingQueues.delete(connId);
      wsProxyBackends.delete(connId);
      backend.close();
      try {
        ws.close(1011, "backend connection timeout");
      } catch {
        /* already closed */
      }
    }
  }, 10_000);

  backend.onopen = () => {
    clearTimeout(connectTimeout);
    // Flush messages buffered during CONNECTING phase
    const queued = wsProxyPendingQueues.get(connId) ?? [];
    wsProxyPendingQueues.delete(connId);
    for (const msg of queued) backend.send(msg);
  };

  // Keep connection alive through Cloudflare's 100s idle timeout
  const keepalive = setInterval(() => {
    if (ws.readyState === 1 /* OPEN */) {
      try {
        ws.ping();
      } catch {}
    } else {
      clearInterval(keepalive);
    }
  }, 30_000);

  backend.onmessage = (evt) => {
    if (evt.data instanceof ArrayBuffer) {
      ws.send(evt.data, true); // binary
    } else {
      ws.send(evt.data as string);
    }
  };

  backend.onclose = () => {
    clearInterval(keepalive);
    clearTimeout(connectTimeout);
    wsProxyPendingQueues.delete(connId);
    wsProxyBackends.delete(connId);
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  };

  backend.onerror = (evt) => {
    console.error(`[ws-proxy] backend error for conn ${connId}:`, (evt as ErrorEvent).message ?? evt);
    clearTimeout(connectTimeout);
    wsProxyPendingQueues.delete(connId);
    wsProxyBackends.delete(connId);
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  };

  wsProxyBackends.set(connId, backend);
}

export function handleWorkspaceWsMessage(ws: ServerWebSocket<WorkspaceWsData>, message: string | Buffer): void {
  // If backend is still CONNECTING, buffer the message
  const pending = wsProxyPendingQueues.get(ws.data.connId);
  if (pending !== undefined) {
    const payload =
      typeof message === "string"
        ? message
        : (message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer);
    pending.push(payload);
    return;
  }

  const backend = wsProxyBackends.get(ws.data.connId);
  if (!backend || backend.readyState !== WebSocket.OPEN) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    return;
  }
  if (typeof message === "string") {
    backend.send(message);
  } else {
    // Buffer → ArrayBuffer for binary frames
    backend.send(message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength));
  }
}

export function handleWorkspaceWsClose(ws: ServerWebSocket<WorkspaceWsData>): void {
  const { connId } = ws.data;
  wsProxyPendingQueues.delete(connId);
  const backend = wsProxyBackends.get(connId);
  if (backend) {
    wsProxyBackends.delete(connId);
    try {
      backend.close();
    } catch {
      /* already closed */
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** HTTP hop-by-hop headers that must not be forwarded */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

function filterProxyHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) result[key] = value;
  });
  return result;
}
