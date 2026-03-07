import { EventEmitter } from "events";
import { loadConfigFile, reloadConfigFile } from "../config-file";
import { createHash, randomBytes } from "crypto";
import type { ServerWebSocket } from "bun";

export interface RemoteWorkerWsData {
  type: "remote-worker";
  name: string;
  connectedAt: number;
  authToken: string;
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

const CALL_TIMEOUT_MS = 120_000;
const BASH_TIMEOUT_MS = 300_000;
const STREAM_IDLE_TIMEOUT_MS = 30_000;
const POST_STREAM_END_MS = 10_000;
const DISCONNECT_GRACE_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 90_000;

const KNOWN_TOOLS = new Set(["view", "edit", "create", "grep", "glob", "bash"]);
const BROWSER_TIMEOUT_MS = 180_000; // 3 minutes for browser operations

function isKnownTool(name: string): boolean {
  if (KNOWN_TOOLS.has(name)) return true;
  if (name.startsWith("browser_")) {
    const suffix = name.slice(8);
    return suffix.length > 0 && /^[a-z0-9_]+$/.test(suffix);
  }
  return false;
}
const TOKEN_FORMAT = /^[a-zA-Z0-9_\-.:]{1,256}$/;

const workers = new Map<string, WorkerState>();
let requestCounter = 0;
let configCacheTime = 0;

export const workerEvents = new EventEmitter();

function isTokenAllowed(token: string, channel?: string): boolean {
  if (!TOKEN_FORMAT.test(token)) return false;

  if (Date.now() - configCacheTime > 5000) {
    reloadConfigFile();
    configCacheTime = Date.now();
  }

  const config = loadConfigFile();
  const workerConfig = config.worker;

  if (workerConfig === true) return true;

  if (workerConfig && typeof workerConfig === "object") {
    if (channel) {
      const tokens = workerConfig[channel];
      return Array.isArray(tokens) && tokens.includes(token);
    }
    for (const tokens of Object.values(workerConfig)) {
      if (Array.isArray(tokens) && tokens.includes(token)) return true;
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
    const channels: string[] = [];
    for (const [ch, tokens] of Object.entries(workerConfig)) {
      if (Array.isArray(tokens) && tokens.includes(token)) {
        channels.push(ch);
      }
    }
    return channels;
  }

  return [];
}

export function getConnectedWorker(tokenHash: string): WorkerState | undefined {
  return workers.get(tokenHash);
}

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
      authToken: token,
      tokenHash,
    },
  });

  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  return undefined;
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
  }
}

export function handleRemoteWorkerWsMessage(ws: ServerWebSocket<RemoteWorkerWsData>, message: string | Buffer) {
  const raw = typeof message === "string" ? message : message.toString();

  if (raw.length > 1_000_000) {
    ws.close(1009, "Message too large");
    return;
  }

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

function handleRegister(ws: ServerWebSocket<RemoteWorkerWsData>, tokenHash: string, parsed: any) {
  const {
    name = "unnamed",
    projectRoot = "",
    platform = "",
    sessionId = "",
    maxConcurrent = 4,
    tools = [],
    version,
  } = parsed;

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

  if (worker && worker.sessionId && worker.sessionId !== sessionId) {
    rejectAllPending(worker, "Stale session — worker reconnected with new context");
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

  const channels = getTokenChannels(ws.data.authToken);

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
    workerEvents.emit("worker:disconnected", { tokenHash, name });
    workers.delete(tokenHash);
  }, DISCONNECT_GRACE_MS);
}

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
  while (worker.serverQueue.length > 0 && worker.activeCount < worker.maxConcurrent) {
    const id = worker.serverQueue.shift()!;
    const pending = worker.pendingCalls.get(id);
    if (!pending) continue;

    if (worker.ws && worker.status === "connected") {
      worker.ws.send(JSON.stringify({ type: "call", id, tool: pending.tool, args: pending.args }));
      pending.sentToWorker = true;
      worker.activeCount++;
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
