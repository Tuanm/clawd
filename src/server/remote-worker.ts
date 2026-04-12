/**
 * Remote Worker WebSocket Server
 *
 * Accepts WebSocket connections from remote worker clients (TypeScript, Python, Java).
 * Manages worker sessions, routes tool calls, and handles reconnections.
 *
 * Remote workers run on separate machines and expose their local tools (file ops,
 * bash, browser, git) to Claw'd agents via the WebSocket bridge.
 */

import type { ServerWebSocket } from "bun";
import { createHash, randomBytes } from "crypto";
import { EventEmitter } from "events";
import { loadConfigFile, reloadConfigFile, safeTokenEqual } from "../config/config-file";
import { matchesPattern } from "../utils/pattern";

// ============================================================================
// Types
// ============================================================================

export interface RemoteWorkerWsData {
  type: "remote-worker";
  name: string;
  connectedAt: number;
  /** Token hash for worker identification — raw token NOT stored for security */
  tokenHash: string;
}

interface ToolSchema {
  name: string;
  inputSchema: any;
  description: string;
}

interface WorkerState {
  ws: ServerWebSocket<RemoteWorkerWsData> | null;
  name: string;
  tokenHash: string;
  platform: string;
  projectRoot: string;
  tools: ToolSchema[];
  status: "connected" | "reconnecting" | "disconnected";
  sessionId: string;
  maxConcurrent: number;
  activeCount: number;
  serverQueue: string[];
  pendingCalls: Map<string, PendingToolCall>;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingToolCall {
  id: string;
  tool: string;
  args: Record<string, any>;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  streamStarted: boolean;
  streamEnded: boolean;
  sentToWorker: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const CALL_TIMEOUT_MS = 120_000;
const BASH_TIMEOUT_MS = 300_000;
const STREAM_IDLE_TIMEOUT_MS = 30_000;
const POST_STREAM_END_MS = 10_000;
const DISCONNECT_GRACE_MS = 10_000;

const KNOWN_TOOLS = new Set(["view", "edit", "create", "grep", "glob", "bash"]);
const BROWSER_TIMEOUT_MS = 180_000; // 3 minutes for browser operations

const TOKEN_FORMAT = /^[a-zA-Z0-9_\-.:]{1,256}$/;

// ============================================================================
// State
// ============================================================================

const workers = new Map<string, WorkerState>();
/** Maps tokenHash → raw token for active workers (needed for config channel lookup) */
const tokenHashToRawToken = new Map<string, string>();
let requestCounter = 0;
let configCacheTime = 0;

export const workerEvents = new EventEmitter();
workerEvents.setMaxListeners(100);

// ============================================================================
// Helpers
// ============================================================================

function isKnownTool(name: string): boolean {
  if (KNOWN_TOOLS.has(name)) return true;
  if (name.startsWith("browser_")) {
    const suffix = name.slice(8);
    return suffix.length > 0 && /^[a-z0-9_]+$/.test(suffix);
  }
  return false;
}

function isTokenAllowed(token: string, _channel?: string): boolean {
  if (!TOKEN_FORMAT.test(token)) return false;

  if (Date.now() - configCacheTime > 5000) {
    reloadConfigFile();
    configCacheTime = Date.now();
  }

  const config = loadConfigFile();
  const workerConfig = config.worker;

  if (workerConfig === true) return true;

  if (workerConfig && typeof workerConfig === "object") {
    const cfg = workerConfig as Record<string, unknown>;
    if (_channel) {
      for (const [pattern, tokens] of Object.entries(cfg)) {
        if (!Array.isArray(tokens)) continue;
        if (matchesPattern(_channel, pattern) && (tokens as string[]).some((t) => safeTokenEqual(t, token)))
          return true;
      }
      return false;
    }
    for (const tokens of Object.values(cfg)) {
      if (Array.isArray(tokens) && (tokens as string[]).some((t) => safeTokenEqual(t, token))) return true;
    }
  }

  return false;
}

export function getTokenChannels(token: string): string[] | "all" {
  if (Date.now() - configCacheTime > 5000) {
    reloadConfigFile();
    configCacheTime = Date.now();
  }

  const config = loadConfigFile();
  const workerConfig = config.worker;

  if (workerConfig === true) return "all";

  if (workerConfig && typeof workerConfig === "object") {
    const cfg = workerConfig as Record<string, unknown>;
    return Object.entries(cfg)
      .filter(([, tokens]) => Array.isArray(tokens) && (tokens as string[]).some((t) => safeTokenEqual(t, token)))
      .map(([pattern]) => pattern);
  }

  return [];
}

export function getConnectedWorker(tokenHash: string): WorkerState | undefined {
  return workers.get(tokenHash);
}

/** Get count of connected workers (for monitoring/testing) */
export function getWorkerCount(): number {
  return workers.size;
}

/** Get all worker names and statuses (for monitoring/testing) */
export function getWorkerStatuses(): Array<{ name: string; tokenHash: string; status: string; toolCount: number }> {
  return Array.from(workers.values()).map((w) => ({
    name: w.name,
    tokenHash: w.tokenHash,
    status: w.status,
    toolCount: w.tools.length,
  }));
}

// ============================================================================
// WebSocket Handlers
// ============================================================================

export function upgradeRemoteWorkerWs(req: Request, server: any): Response | undefined {
  const authHeader = req.headers.get("Authorization") || "";
  const url = new URL(req.url);
  // Accept token from Authorization header or query param (WHATWG WebSocket can't send headers)
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : url.searchParams.get("token") || "";
  const name = url.searchParams.get("name") || "unnamed";

  if (!token || !isTokenAllowed(token)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");

  const existing = workers.get(tokenHash);
  if (existing?.ws) {
    try {
      existing.ws.close(1000, "replaced");
    } catch {}
  }

  const upgraded = server.upgrade(req, {
    data: {
      type: "remote-worker" as const,
      name,
      connectedAt: Date.now(),
      tokenHash,
    },
  });

  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  // Store raw token → hash mapping for channel lookups (cleared on disconnect)
  tokenHashToRawToken.set(tokenHash, token);

  return undefined;
}

/** Look up channels for a tokenHash using the stored raw token */
function _getChannelsForTokenHash(tokenHash: string): string[] | "all" {
  const rawToken = tokenHashToRawToken.get(tokenHash);
  if (!rawToken) return [];
  return getTokenChannels(rawToken);
}

export function handleRemoteWorkerWsOpen(ws: ServerWebSocket<RemoteWorkerWsData>) {
  const { tokenHash, name } = ws.data;
  console.log(`[remote-worker] Connection opened: ${name} (${tokenHash.slice(0, 8)}…)`);

  if (!workers.has(tokenHash)) {
    workers.set(tokenHash, {
      ws,
      name,
      tokenHash,
      platform: "",
      projectRoot: "",
      tools: [],
      status: "connected",
      sessionId: "",
      maxConcurrent: 4,
      activeCount: 0,
      serverQueue: [],
      pendingCalls: new Map(),
      disconnectTimer: null,
    });
  } else {
    // Reconnection: update WS reference and clear stale disconnect timer
    const worker = workers.get(tokenHash)!;
    worker.ws = ws;
    worker.status = "connected";
    if (worker.disconnectTimer) {
      clearTimeout(worker.disconnectTimer);
      worker.disconnectTimer = null;
    }
  }
}

export function handleRemoteWorkerWsMessage(ws: ServerWebSocket<RemoteWorkerWsData>, message: string | Buffer) {
  // Check size BEFORE converting Buffer to string to avoid unnecessary heap allocation
  const messageLength = typeof message === "string" ? message.length : message.byteLength;
  if (messageLength > 1_000_000) {
    ws.close(1009, "Message too large");
    return;
  }

  const raw = typeof message === "string" ? message : message.toString();

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const { tokenHash } = ws.data;

  switch (parsed.type) {
    case "register":
      handleRegister(ws, tokenHash, parsed);
      break;

    case "result":
      handleResult(tokenHash, parsed);
      break;

    case "error":
      handleError(tokenHash, parsed);
      break;

    case "stdout":
    case "stderr":
      handleStream(tokenHash, parsed);
      break;

    case "stream_end":
      handleStreamEnd(tokenHash, parsed);
      break;

    case "cancelled":
      handleCancelled(tokenHash, parsed);
      break;

    case "ping":
      ws.send(JSON.stringify({ type: "pong", ts: parsed.ts }));
      break;
  }
}

// ============================================================================
// Message Handlers
// ============================================================================

function handleRegister(ws: ServerWebSocket<RemoteWorkerWsData>, tokenHash: string, parsed: any) {
  const {
    name = "unnamed",
    projectRoot = "",
    platform = "",
    sessionId = "",
    maxConcurrent: rawMaxConcurrent = 4,
    tools = [],
  } = parsed;

  // Validate maxConcurrent: must be a positive integer, clamped to [1, 32]
  const parsedConcurrent = Number(rawMaxConcurrent);
  const maxConcurrent = Math.max(1, Math.min(32, Math.floor(Number.isFinite(parsedConcurrent) ? parsedConcurrent : 4)));

  if (!Array.isArray(tools)) {
    ws.send(JSON.stringify({ type: "registered", ok: false, error: "tools must be an array" }));
    return;
  }

  const validTools: ToolSchema[] = [];
  for (const t of tools) {
    if (!t.name || !isKnownTool(t.name)) continue;
    validTools.push({ name: t.name, inputSchema: t.inputSchema, description: t.description || "" });
  }

  let worker = workers.get(tokenHash);

  if (worker && worker.pendingCalls.size > 0) {
    // Reconnect — reject all pending calls
    rejectAllPending(
      worker,
      worker.sessionId !== sessionId
        ? "Stale session — worker reconnected with new context"
        : "Connection reset — call lost during reconnect",
    );
  }

  if (!worker) {
    worker = {
      ws: null,
      name,
      tokenHash,
      platform,
      projectRoot,
      tools: validTools,
      status: "connected",
      sessionId,
      maxConcurrent,
      activeCount: 0,
      serverQueue: [],
      pendingCalls: new Map(),
      disconnectTimer: null,
    };
    workers.set(tokenHash, worker);
  }

  worker.ws = ws;
  worker.name = name;
  worker.tokenHash = tokenHash;
  worker.platform = platform;
  worker.projectRoot = projectRoot;
  worker.tools = validTools;
  worker.status = "connected";
  worker.sessionId = sessionId;
  worker.maxConcurrent = maxConcurrent;
  worker.activeCount = 0;

  if (worker.disconnectTimer) {
    clearTimeout(worker.disconnectTimer);
    worker.disconnectTimer = null;
  }

  ws.send(JSON.stringify({ type: "registered", ok: true, serverVersion: "0.1.0" }));

  // Look up channels using the original token from the registration context
  // We need the raw token for config lookup — retrieve from the ws auth flow
  // Since we no longer store authToken in WsData, use the tokenHash to find channels
  const channels = _getChannelsForTokenHash(tokenHash);

  workerEvents.emit("worker:registered", {
    tokenHash,
    name,
    projectRoot,
    platform,
    tools: validTools,
    channels,
  });

  if (worker.serverQueue.length > 0) {
    dispatchCalls(worker);
  }
}

function handleResult(tokenHash: string, parsed: any) {
  const worker = workers.get(tokenHash);
  if (!worker) return;

  const pending = worker.pendingCalls.get(parsed.id);
  if (!pending) return;

  cleanupCall(worker, parsed.id);

  if (parsed.result?.success) {
    pending.resolve(parsed.result.output);
  } else {
    pending.reject(new Error(parsed.result?.error || "Tool call failed"));
  }
}

function handleError(tokenHash: string, parsed: any) {
  const worker = workers.get(tokenHash);
  if (!worker) return;

  const pending = worker.pendingCalls.get(parsed.id);
  if (!pending) return;

  cleanupCall(worker, parsed.id);
  pending.reject(new Error(parsed.error || "Remote worker error"));
}

function handleStream(tokenHash: string, parsed: any) {
  const worker = workers.get(tokenHash);
  if (!worker) return;

  const pending = worker.pendingCalls.get(parsed.id);
  if (!pending) return;

  pending.streamStarted = true;

  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    cleanupCall(worker, parsed.id);
    pending.reject(new Error("Stream idle timeout"));
  }, STREAM_IDLE_TIMEOUT_MS);
}

function handleStreamEnd(tokenHash: string, parsed: any) {
  const worker = workers.get(tokenHash);
  if (!worker) return;

  const pending = worker.pendingCalls.get(parsed.id);
  if (!pending) return;

  pending.streamEnded = true;

  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    cleanupCall(worker, parsed.id);
    pending.reject(new Error("Timeout waiting for result after stream_end"));
  }, POST_STREAM_END_MS);
}

function handleCancelled(tokenHash: string, parsed: any) {
  const worker = workers.get(tokenHash);
  if (!worker) return;

  const pending = worker.pendingCalls.get(parsed.id);
  if (!pending) return;

  cleanupCall(worker, parsed.id);
  pending.reject(new Error("Cancelled"));
}

export function handleRemoteWorkerWsClose(ws: ServerWebSocket<RemoteWorkerWsData>) {
  const { tokenHash, name } = ws.data;
  const worker = workers.get(tokenHash);
  if (!worker) return;

  // Guard: ignore stale close if a newer connection is already active
  if (worker.ws !== ws) return;

  console.log(`[remote-worker] Connection closed: ${name} (${tokenHash.slice(0, 8)}…)`);

  worker.ws = null;
  worker.status = "reconnecting";

  for (const [callId, pending] of worker.pendingCalls) {
    if (pending.streamStarted && !pending.streamEnded) {
      cleanupCall(worker, callId);
      pending.reject(new Error("Connection lost during stream"));
    }
  }

  worker.disconnectTimer = setTimeout(() => {
    rejectAllPending(worker, "Worker disconnected");
    worker.status = "disconnected";
    workerEvents.emit("worker:disconnected", { tokenHash, name: worker.name });
    workers.delete(tokenHash);
    tokenHashToRawToken.delete(tokenHash);
  }, DISCONNECT_GRACE_MS);
}

// ============================================================================
// Tool Call Dispatch
// ============================================================================

export function callRemoteWorkerTool(
  tokenHash: string,
  toolName: string,
  args: Record<string, any>,
  options?: { timeout?: number },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const worker = workers.get(tokenHash);
    if (!worker || worker.status === "disconnected") {
      return reject(new Error("Worker not available"));
    }

    const id = `rw_${++requestCounter}_${randomBytes(4).toString("hex")}`;
    const timeout =
      toolName === "bash"
        ? BASH_TIMEOUT_MS
        : toolName.startsWith("browser_")
          ? options?.timeout || BROWSER_TIMEOUT_MS
          : options?.timeout || CALL_TIMEOUT_MS;

    const timer = setTimeout(() => {
      cleanupCall(worker, id);
      reject(new Error(`Tool call ${toolName} timed out after ${timeout}ms`));
    }, timeout);

    const pending: PendingToolCall = {
      id,
      tool: toolName,
      args,
      resolve,
      reject,
      timer,
      streamStarted: false,
      streamEnded: false,
      sentToWorker: false,
    };

    worker.pendingCalls.set(id, pending);
    worker.serverQueue.push(id);
    dispatchCalls(worker);
  });
}

function dispatchCalls(worker: WorkerState) {
  if (!worker.ws || worker.status !== "connected") return;
  while (worker.serverQueue.length > 0 && worker.activeCount < worker.maxConcurrent) {
    const id = worker.serverQueue.shift()!;
    const pending = worker.pendingCalls.get(id);
    if (!pending) continue;

    try {
      worker.ws.send(JSON.stringify({ type: "call", id, tool: pending.tool, args: pending.args }));
      pending.sentToWorker = true;
      worker.activeCount++;
    } catch {
      // Send failed — re-queue at front and stop dispatching
      worker.serverQueue.unshift(id);
      break;
    }
  }
}

function cleanupCall(worker: WorkerState, callId: string) {
  const pending = worker.pendingCalls.get(callId);
  if (!pending) return;

  clearTimeout(pending.timer);
  worker.pendingCalls.delete(callId);

  const idx = worker.serverQueue.indexOf(callId);
  if (idx !== -1) {
    worker.serverQueue.splice(idx, 1);
  }

  if (pending.sentToWorker) {
    worker.activeCount--;
    dispatchCalls(worker);
  }
}

function rejectAllPending(worker: WorkerState, reason: string) {
  for (const [, pending] of worker.pendingCalls) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  worker.pendingCalls.clear();
  worker.serverQueue = [];
  worker.activeCount = 0;
}

// ============================================================================
// Test Helpers (only used in tests)
// ============================================================================

/** Reset all worker state — for testing only */
export function _resetWorkers() {
  for (const worker of workers.values()) {
    // Silently clear pending calls without rejecting (avoids unhandled rejections in tests)
    for (const [, pending] of worker.pendingCalls) {
      clearTimeout(pending.timer);
    }
    worker.pendingCalls.clear();
    worker.serverQueue = [];
    worker.activeCount = 0;
    if (worker.disconnectTimer) clearTimeout(worker.disconnectTimer);
  }
  workers.clear();
  tokenHashToRawToken.clear();
  requestCounter = 0;
  configCacheTime = 0;
}

/** Expose isKnownTool for testing */
export { isKnownTool as _isKnownTool };

/** Expose isTokenAllowed for testing */
export { isTokenAllowed as _isTokenAllowed };
