/**
 * Browser Bridge — WebSocket server for Chrome extension communication.
 *
 * The extension connects via WebSocket to /browser/ws and receives
 * JSON-RPC style commands from agent tools. Results flow back over
 * the same connection.
 *
 * Protocol:
 *   Agent → Bridge → Extension:  { id, method, params }
 *   Extension → Bridge → Agent:  { id, result } | { id, error }
 */

import type { ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export interface BrowserWsData {
  type: "browser-extension";
  extensionId: string;
  connectedAt: number;
}

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

// ============================================================================
// State
// ============================================================================

const connections = new Map<string, ServerWebSocket<BrowserWsData>>();
const pendingRequests = new Map<string, PendingRequest>();
let requestCounter = 0;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 10;
const EXT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// ============================================================================
// WebSocket Handlers (called from websocket.ts dispatcher)
// ============================================================================

export function handleBrowserWsOpen(ws: ServerWebSocket<BrowserWsData>) {
  const extId = ws.data.extensionId;
  // Replace any existing connection from same extension
  const existing = connections.get(extId);
  if (existing) {
    try {
      existing.close(1000, "replaced");
    } catch {}
  } else if (connections.size >= MAX_CONNECTIONS) {
    ws.close(1013, "Too many browser extensions connected");
    return;
  }
  connections.set(extId, ws);
  console.log(`[browser-bridge] Extension connected: ${extId} (${connections.size} total)`);
}

export function handleBrowserWsClose(ws: ServerWebSocket<BrowserWsData>) {
  const extId = ws.data.extensionId;
  if (connections.get(extId) === ws) {
    connections.delete(extId);
  }
  // Reject pending requests when no connections remain
  if (connections.size === 0) {
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pendingRequests.delete(id);
      pending.reject(new Error(`Browser extension disconnected during '${pending.method}'`));
    }
  }
  console.log(`[browser-bridge] Extension disconnected: ${extId} (${connections.size} total)`);
}

export function handleBrowserWsMessage(ws: ServerWebSocket<BrowserWsData>, message: string | Buffer) {
  try {
    const data = JSON.parse(message.toString());

    // Heartbeat
    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    // Response to a pending request
    if (data.id && pendingRequests.has(data.id)) {
      const pending = pendingRequests.get(data.id)!;
      pendingRequests.delete(data.id);
      clearTimeout(pending.timer);

      if (data.error) {
        pending.reject(new Error(data.error.message || JSON.stringify(data.error)));
      } else {
        pending.resolve(data.result);
      }
      return;
    }
  } catch {
    // Ignore parse errors
  }
}

// ============================================================================
// API for Agent Tools
// ============================================================================

/** Check if any browser extension is connected */
export function isExtensionConnected(): boolean {
  return connections.size > 0;
}

/** Get list of connected extensions */
export function getConnectedExtensions(): string[] {
  return Array.from(connections.keys());
}

/**
 * Send a command to the browser extension and await result.
 * Uses the first connected extension if extensionId not specified.
 */
export async function sendBrowserCommand(
  method: string,
  params: Record<string, any> = {},
  extensionId?: string,
): Promise<any> {
  const ws = extensionId ? connections.get(extensionId) : connections.values().next().value;

  if (!ws) {
    throw new Error("No browser extension connected. Install the Claw'd Browser Extension and connect it.");
  }

  const id = `req_${++requestCounter}_${randomBytes(4).toString("hex")}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Browser command '${method}' timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, method, timer });

    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(err instanceof Error ? err : new Error("Failed to send browser command"));
    }
  });
}

/**
 * Upgrade HTTP request to browser bridge WebSocket.
 * Called from index.ts fetch handler.
 */
export function upgradeBrowserWs(req: Request, server: any): Response | undefined {
  const url = new URL(req.url);
  const rawExtId = url.searchParams.get("extId");
  const extId = rawExtId && EXT_ID_PATTERN.test(rawExtId) ? rawExtId : `ext_${randomBytes(4).toString("hex")}`;

  if (rawExtId && !EXT_ID_PATTERN.test(rawExtId)) {
    return new Response("Invalid extension ID", { status: 400 });
  }

  const success = server.upgrade(req, {
    data: {
      type: "browser-extension" as const,
      extensionId: extId,
      connectedAt: Date.now(),
    },
  });

  if (success) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}
