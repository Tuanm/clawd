/**
 * Workspace noVNC Proxy
 *
 * Routes:
 *   HTTP  GET  /workspace/:id/novnc/*     → proxy to container's noVNC HTTP server
 *   WS         /workspace/:id/novnc/websockify → proxy WS to container's websockify
 *
 * The workspace ID maps to a running Docker container clawd-ws-{id}.
 * Port is looked up from the in-memory registry (same process) or via docker CLI.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServerWebSocket } from "bun";

const execFileAsync = promisify(execFile);

/** Per-connection map: connId → backend WebSocket (noVNC websockify) */
const wsProxyBackends = new Map<string, WebSocket>();

/** Messages buffered while the backend WS is still in CONNECTING state */
const wsProxyPendingQueues = new Map<string, Array<string | ArrayBuffer>>();

// Workspace ID is always exactly 16 lowercase hex chars (randomBytes(8).toString('hex'))
const WORKSPACE_ID_RE = /^[a-f0-9]{16}$/;

// ─── Port lookup ──────────────────────────────────────────────────────────────

async function getNovncPort(workspaceId: string): Promise<number | null> {
  // Fast path: in-memory registry (same process as worker loop)
  try {
    const { getWorkspace } = await import("../../agent/src/workspace/container.js");
    const ws = getWorkspace(workspaceId);
    if (ws) return ws.novncPort;
  } catch { /* module not available in this context */ }

  // Fallback: query docker daemon directly (6080 = container-internal noVNC port)
  try {
    const { stdout } = await execFileAsync("docker", [
      "port", `clawd-ws-${workspaceId}`, "6080",
    ]);
    const match = stdout.match(/:(\d+)/);
    if (match) return parseInt(match[1], 10);
  } catch { /* container not found */ }

  return null;
}

/** Validate workspace ID format before use */
function isValidWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_RE.test(id);
}

// ─── HTTP proxy ───────────────────────────────────────────────────────────────

/**
 * Proxy a normal HTTP request to the workspace's noVNC server.
 * Called for all /workspace/:id/novnc/* paths.
 */
export async function handleWorkspaceProxy(
  req: Request,
  url: URL,
  workspaceId: string,
): Promise<Response> {
  if (!isValidWorkspaceId(workspaceId)) {
    return new Response(JSON.stringify({ error: "invalid_workspace_id" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const port = await getNovncPort(workspaceId);
  if (!port) {
    return new Response(
      JSON.stringify({ error: "workspace_not_found", workspace_id: workspaceId }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // Strip the /workspace/:id/novnc prefix to get the noVNC-relative path
  const prefix = `/workspace/${workspaceId}/novnc`;
  const novncPath = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length) || "/"
    : "/";

  const targetUrl = `http://127.0.0.1:${port}${novncPath}${url.search}`;

  try {
    const filteredHeaders = filterProxyHeaders(req.headers);
    // Set Host to the upstream target to avoid mismatched-Host rejections
    filteredHeaders["host"] = `127.0.0.1:${port}`;

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
    return new Response(
      JSON.stringify({ error: "proxy_error", message: err.message }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ─── WebSocket proxy ──────────────────────────────────────────────────────────

export interface WorkspaceWsData {
  type: "workspace-novnc";
  workspaceId: string;
  novncPort: number;
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
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const port = await getNovncPort(workspaceId);
  if (!port) {
    return new Response(
      JSON.stringify({ error: "workspace_not_found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const connId = crypto.randomUUID();
  const data: WorkspaceWsData = {
    type: "workspace-novnc",
    workspaceId,
    novncPort: port,
    connId,
  };

  const upgraded = bunServer.upgrade(req, { data });
  return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
}

export function handleWorkspaceWsOpen(ws: ServerWebSocket<WorkspaceWsData>): void {
  const { novncPort, connId } = ws.data;

  // Init pending queue to buffer messages while backend is still CONNECTING
  wsProxyPendingQueues.set(connId, []);

  // Connect to the noVNC websockify endpoint in the container
  // noVNC's protocol negotiation happens over binary WebSocket frames
  const backend = new WebSocket(`ws://127.0.0.1:${novncPort}/websockify`, ["binary", "base64"]);
  backend.binaryType = "arraybuffer";

  // Timeout if backend never connects (e.g., container crashed or wrong port)
  const connectTimeout = setTimeout(() => {
    if (backend.readyState === WebSocket.CONNECTING) {
      wsProxyPendingQueues.delete(connId);
      wsProxyBackends.delete(connId);
      backend.close();
      try { ws.close(1011, "backend connection timeout"); } catch { /* already closed */ }
    }
  }, 10_000);

  backend.onopen = () => {
    clearTimeout(connectTimeout);
    // Flush messages buffered during CONNECTING phase
    const queued = wsProxyPendingQueues.get(connId) ?? [];
    wsProxyPendingQueues.delete(connId);
    for (const msg of queued) backend.send(msg);
  };

  backend.onmessage = (evt) => {
    if (evt.data instanceof ArrayBuffer) {
      ws.send(evt.data, true); // binary
    } else {
      ws.send(evt.data as string);
    }
  };

  backend.onclose = () => {
    clearTimeout(connectTimeout);
    wsProxyPendingQueues.delete(connId);
    wsProxyBackends.delete(connId);
    try { ws.close(); } catch { /* already closed */ }
  };

  backend.onerror = (evt) => {
    console.error(`[ws-proxy] backend error for conn ${connId}:`, (evt as ErrorEvent).message ?? evt);
    clearTimeout(connectTimeout);
    wsProxyPendingQueues.delete(connId);
    wsProxyBackends.delete(connId);
    try { ws.close(); } catch { /* already closed */ }
  };

  wsProxyBackends.set(connId, backend);
}

export function handleWorkspaceWsMessage(
  ws: ServerWebSocket<WorkspaceWsData>,
  message: string | Buffer,
): void {
  // If backend is still CONNECTING, buffer the message
  const pending = wsProxyPendingQueues.get(ws.data.connId);
  if (pending !== undefined) {
    const payload = typeof message === "string"
      ? message
      : message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer;
    pending.push(payload);
    return;
  }

  const backend = wsProxyBackends.get(ws.data.connId);
  if (!backend || backend.readyState !== WebSocket.OPEN) {
    try { ws.close(); } catch { /* already closed */ }
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
    try { backend.close(); } catch { /* already closed */ }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** HTTP hop-by-hop headers that must not be forwarded */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
]);

function filterProxyHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) result[key] = value;
  });
  return result;
}
