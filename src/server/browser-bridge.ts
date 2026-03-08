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
 *
 * Auth: When config.browser is a token map, extensions must provide a
 * valid token via ?token= query param. The token determines which
 * channels can use this browser.
 *
 * Tab isolation: Each agent (identified by agentId) owns specific tabs.
 * When an agent first interacts with a tab, it claims ownership.
 * Other agents cannot send commands to tabs they don't own.
 */

import type { ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import { getAllBrowserTokens, getChannelsForToken, isBrowserAuthRequired } from "../config-file";

// ============================================================================
// Types
// ============================================================================

export interface BrowserWsData {
  type: "browser-extension";
  extensionId: string;
  connectedAt: number;
  /** Auth token provided at connect time (undefined if no auth required) */
  authToken?: string;
  /** Channels this browser is authorized for (derived from token) */
  channels?: string[];
}

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
  extensionId: string;
}

// ============================================================================
// State
// ============================================================================

const connections = new Map<string, ServerWebSocket<BrowserWsData>>();
const pendingRequests = new Map<string, PendingRequest>();
let requestCounter = 0;

/** Tab ownership: tabId → agentId. Cleared when agent releases or disconnects. */
const tabOwnership = new Map<string, string>();

/** Which extension each agent is currently using: agentId → extensionId */
const agentBrowser = new Map<string, string>();

/** Active agent count per extension: extensionId → Set<agentId> */
const extensionAgents = new Map<string, Set<string>>();

/** Last pong timestamp per extension for dead connection detection */
const lastPong = new Map<string, number>();

const HEARTBEAT_CHECK_INTERVAL_MS = 30_000; // check every 30s
const HEARTBEAT_DEAD_THRESHOLD_MS = 45_000; // consider dead if no pong for 45s

// Server-initiated heartbeat: detect dead extensions and reject pending requests
setInterval(() => {
  const now = Date.now();
  for (const [extId, ws] of connections) {
    const lastSeen = lastPong.get(extId) ?? ws.data.connectedAt;
    if (now - lastSeen > HEARTBEAT_DEAD_THRESHOLD_MS) {
      console.warn(
        `[browser-bridge] Extension ${extId} unresponsive (no pong for ${Math.round((now - lastSeen) / 1000)}s), closing`,
      );
      try {
        ws.close(1001, "heartbeat timeout");
      } catch {}
      // handleBrowserWsClose will clean up pending requests
      continue;
    }
    // Send server-initiated ping
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }
}, HEARTBEAT_CHECK_INTERVAL_MS);

const DEFAULT_TIMEOUT_MS = 30_000; // 30s default — agents can override with timeout param

/** Per-command timeout overrides (ms). Commands not listed use DEFAULT_TIMEOUT_MS. */
const COMMAND_TIMEOUTS: Record<string, number> = {
  navigate: 60_000,
  execute: 60_000,
  wait_for: 60_000,
  download: 120_000,
  file_upload: 120_000,
};
const MAX_CONNECTIONS = 10;
const EXT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const AUTH_TOKEN_PATTERN = /^[a-zA-Z0-9_\-.:]{1,256}$/;

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
  lastPong.set(extId, Date.now());
  const authInfo = ws.data.authToken ? ` (token: ${maskToken(ws.data.authToken)})` : " (no auth)";
  console.log(`[browser-bridge] Extension connected: ${extId}${authInfo} (${connections.size} total)`);
}

export function handleBrowserWsClose(ws: ServerWebSocket<BrowserWsData>) {
  const extId = ws.data.extensionId;

  // If this ws was already replaced by a newer connection, skip all cleanup
  // to avoid wiping state that the replacement connection now owns.
  if (connections.get(extId) !== ws) return;

  connections.delete(extId);
  lastPong.delete(extId);
  // Safe: Map spec guarantees iteration handles concurrent deletes
  for (const [tabKey] of tabOwnership) {
    if (tabKey.startsWith(`${extId}:`)) {
      tabOwnership.delete(tabKey);
    }
  }

  // Clean up agent→browser mapping
  for (const [aid, mappedExtId] of agentBrowser) {
    if (mappedExtId === extId) agentBrowser.delete(aid);
  }
  extensionAgents.delete(extId);

  // Reject pending requests targeting this extension
  for (const [id, pending] of pendingRequests) {
    if (pending.extensionId === extId) {
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
      lastPong.set(ws.data.extensionId, Date.now());
      return;
    }

    // Pong response to our server-initiated ping
    if (data.type === "pong") {
      lastPong.set(ws.data.extensionId, Date.now());
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
// Auth Helpers
// ============================================================================

/** Mask a token for logging: never reveal more than ~50% of chars */
function maskToken(token: string): string {
  if (token.length <= 5) return "***";
  if (token.length <= 8) return `${token.slice(0, 1)}***${token.slice(-1)}`;
  if (token.length <= 12) return `${token.slice(0, 2)}***${token.slice(-2)}`;
  return `${token.slice(0, 3)}***${token.slice(-3)}`;
}

/**
 * Validate an auth token for browser file endpoints (HTTP).
 * Returns true if the token is valid or no auth is required.
 */
export function validateBrowserToken(token: string | null): boolean {
  if (!isBrowserAuthRequired()) return true; // no auth configured
  if (!token) return false;
  if (!AUTH_TOKEN_PATTERN.test(token)) return false; // invalid format
  const validTokens = getAllBrowserTokens();
  if (!validTokens || validTokens.size === 0) return false; // fail closed
  return validTokens.has(token);
}

// ============================================================================
// Tab Isolation
// ============================================================================

/**
 * Composite key for tab ownership: "extensionId:tabId"
 */
function tabKey(extensionId: string, tabId: number | string): string {
  return `${extensionId}:${tabId}`;
}

/**
 * Check/claim tab ownership for an agent. Returns true if the agent
 * can use this tab. Methods that don't specify a tabId are always allowed.
 */
function checkTabAccess(extensionId: string, agentId: string, params: Record<string, any>): string | null {
  const tabId = params.tabId ?? params.tab_id;
  if (tabId === undefined || tabId === null) return null; // no tab involved

  const key = tabKey(extensionId, tabId);
  const owner = tabOwnership.get(key);

  if (!owner) {
    // First touch — claim it
    tabOwnership.set(key, agentId);
    return null;
  }

  if (owner === agentId) return null; // already owns it

  return `Tab ${tabId} is owned by another agent. Each agent operates in its own tabs to avoid conflicts.`;
}

/**
 * Release all tabs owned by an agent (called when agent disconnects).
 */
export function releaseAgentTabs(agentId: string): void {
  for (const [key, owner] of tabOwnership) {
    if (owner === agentId) tabOwnership.delete(key);
  }
  // Clean agent→browser mapping
  const extId = agentBrowser.get(agentId);
  if (extId) {
    agentBrowser.delete(agentId);
    const agents = extensionAgents.get(extId);
    if (agents) {
      agents.delete(agentId);
      if (agents.size === 0) extensionAgents.delete(extId);
    }
  }
}

// ============================================================================
// Browser Selection (Agent Routing)
// ============================================================================

/**
 * Select the best browser (extensionId) for an agent.
 *
 * Strategy:
 * 1. If agent already has a browser assigned, reuse it (sticky).
 * 2. If auth is required, filter to browsers whose token covers the agent's channel.
 * 3. Among eligible browsers, prefer ones with fewer active agents (least-loaded).
 */
function selectBrowser(agentId: string, channel?: string): ServerWebSocket<BrowserWsData> | null {
  // When auth is required, channel must be provided
  if (isBrowserAuthRequired() && !channel) return null;

  // Sticky: reuse existing assignment if still connected AND authorized
  const existingExtId = agentBrowser.get(agentId);
  if (existingExtId && connections.has(existingExtId)) {
    const existingWs = connections.get(existingExtId)!;
    // Re-validate channel authorization (browser may have reconnected with different token)
    if (isBrowserAuthRequired() && channel) {
      const browserChannels = existingWs.data.channels;
      if (!browserChannels || !browserChannels.includes(channel)) {
        // Stale assignment — clear and fall through to re-selection
        agentBrowser.delete(agentId);
        const agents = extensionAgents.get(existingExtId);
        if (agents) {
          agents.delete(agentId);
          if (agents.size === 0) extensionAgents.delete(existingExtId);
        }
      } else {
        return existingWs;
      }
    } else {
      return existingWs;
    }
  }

  // Build candidate list
  const candidates: Array<{ extId: string; ws: ServerWebSocket<BrowserWsData>; load: number }> = [];

  for (const [extId, ws] of connections) {
    // Auth filter: if auth is required and channel is specified,
    // the browser's token must cover this channel
    if (isBrowserAuthRequired() && channel) {
      const browserChannels = ws.data.channels;
      if (!browserChannels || !browserChannels.includes(channel)) continue;
    }

    const agents = extensionAgents.get(extId);
    const load = agents ? agents.size : 0;
    candidates.push({ extId, ws, load });
  }

  if (candidates.length === 0) return null;

  // Sort by load (ascending), then by connectedAt (oldest first for stability)
  candidates.sort((a, b) => {
    if (a.load !== b.load) return a.load - b.load;
    return a.ws.data.connectedAt - b.ws.data.connectedAt;
  });

  const chosen = candidates[0];

  // Record assignment
  agentBrowser.set(agentId, chosen.extId);
  let agents = extensionAgents.get(chosen.extId);
  if (!agents) {
    agents = new Set();
    extensionAgents.set(chosen.extId, agents);
  }
  agents.add(agentId);

  return chosen.ws;
}

// ============================================================================
// API for Agent Tools
// ============================================================================

/** Check if any browser extension is connected */
export function isExtensionConnected(): boolean {
  return connections.size > 0;
}

/** Check if any browser extension is connected for a specific channel */
export function isExtensionConnectedForChannel(channel?: string): boolean {
  if (!isBrowserAuthRequired() || !channel) return connections.size > 0;
  for (const ws of connections.values()) {
    if (ws.data.channels?.includes(channel)) return true;
  }
  return false;
}

/** Get list of connected extensions */
export function getConnectedExtensions(): string[] {
  return Array.from(connections.keys());
}

/**
 * Get connection info for status display.
 * Optionally filter by channel to prevent cross-channel information leakage.
 */
export function getConnectionInfo(filterChannel?: string): Array<{
  extensionId: string;
  channels: string[];
  agentCount: number;
  connectedAt: number;
}> {
  const info: Array<{
    extensionId: string;
    channels: string[];
    agentCount: number;
    connectedAt: number;
  }> = [];
  for (const [extId, ws] of connections) {
    const channels = ws.data.channels ?? [];
    // If filtering by channel, skip browsers that don't serve this channel
    if (filterChannel) {
      if (channels.length === 0 && isBrowserAuthRequired()) continue; // no-channel = unauthenticated
      if (channels.length > 0 && !channels.includes(filterChannel)) continue;
    }
    info.push({
      extensionId: extId,
      // Only show channels relevant to the caller (or all if no filter)
      channels: filterChannel ? channels.filter((c) => c === filterChannel) : channels,
      agentCount: extensionAgents.get(extId)?.size ?? 0,
      connectedAt: ws.data.connectedAt,
    });
  }
  return info;
}

/**
 * Send a command to the browser extension and await result.
 *
 * When agentId + channel are provided, uses smart browser selection
 * with tab-level isolation. Falls back to first connection if not specified.
 */
export async function sendBrowserCommand(
  method: string,
  params: Record<string, any> = {},
  options?: {
    extensionId?: string;
    agentId?: string;
    channel?: string;
    /** Agent-specified timeout override in ms. Capped at 120s. */
    timeoutMs?: number;
  },
): Promise<any> {
  const agentId = options?.agentId;
  const channel = options?.channel;

  let ws: ServerWebSocket<BrowserWsData> | null | undefined;

  if (options?.extensionId) {
    ws = connections.get(options.extensionId);
  } else if (agentId) {
    ws = selectBrowser(agentId, channel);
  } else {
    ws = connections.values().next().value;
  }

  if (!ws) {
    const channelHint = channel ? ` for channel '${channel}'` : "";
    throw new Error(
      `No browser extension connected${channelHint}. Install the Claw'd Browser Extension and connect it.`,
    );
  }

  // Tab isolation check
  if (agentId) {
    const extId = ws.data.extensionId;
    const err = checkTabAccess(extId, agentId, params);
    if (err) throw new Error(err);
  }

  const id = `req_${++requestCounter}_${randomBytes(4).toString("hex")}`;
  const extId = ws.data.extensionId;
  // Priority: agent-specified timeout > per-command default > global default (30s). Cap at 120s.
  const timeoutMs = Math.min(options?.timeoutMs || COMMAND_TIMEOUTS[method] || DEFAULT_TIMEOUT_MS, 120_000);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Browser command '${method}' timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, method, timer, extensionId: extId });

    try {
      ws!.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(err instanceof Error ? err : new Error("Failed to send browser command"));
    }
  });
}

/**
 * Upgrade HTTP request to browser bridge WebSocket.
 * Validates auth token if config requires it.
 * Called from index.ts fetch handler.
 */
export function upgradeBrowserWs(req: Request, server: any): Response | undefined {
  const url = new URL(req.url);
  const rawExtId = url.searchParams.get("extId");
  const rawToken = url.searchParams.get("token");

  if (rawExtId && !EXT_ID_PATTERN.test(rawExtId)) {
    console.warn(`[browser-bridge] Rejected invalid extId: ${rawExtId}`);
    return new Response("Invalid extension ID", { status: 400 });
  }

  // Auth validation
  if (isBrowserAuthRequired()) {
    if (!rawToken) {
      console.warn("[browser-bridge] Rejected connection: auth token required but not provided");
      return new Response("Auth token required. Provide ?token= parameter.", { status: 401 });
    }
    if (!AUTH_TOKEN_PATTERN.test(rawToken)) {
      console.warn("[browser-bridge] Rejected connection: invalid token format");
      return new Response("Invalid auth token format", { status: 400 });
    }
    const validTokens = getAllBrowserTokens();
    if (!validTokens || !validTokens.has(rawToken)) {
      console.warn(`[browser-bridge] Rejected connection: invalid auth token ${maskToken(rawToken)}`);
      return new Response("Invalid auth token", { status: 403 });
    }
  }

  const extId = rawExtId || `ext_${randomBytes(4).toString("hex")}`;
  const channels = rawToken ? getChannelsForToken(rawToken) : undefined;
  const tokenInfo = rawToken ? ` token=${maskToken(rawToken)} channels=[${channels?.join(",")}]` : "";
  console.log(`[browser-bridge] Upgrading WebSocket for extId=${extId}${tokenInfo}`);

  const success = server.upgrade(req, {
    data: {
      type: "browser-extension" as const,
      extensionId: extId,
      connectedAt: Date.now(),
      authToken: rawToken || undefined,
      channels,
    },
  });

  if (success) return undefined;
  console.error(`[browser-bridge] server.upgrade() failed for extId=${extId}`);
  return new Response("WebSocket upgrade failed", { status: 400 });
}
