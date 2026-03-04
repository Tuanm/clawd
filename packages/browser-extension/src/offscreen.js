/**
 * Claw'd Offscreen Document — Persistent WebSocket bridge.
 *
 * Maintains a WebSocket connection to the local Claw'd server
 * and relays commands to/from the service worker.
 *
 * This document persists (unlike the service worker) because MV3
 * offscreen documents stay alive while active.
 */

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_URL = "ws://localhost:3456/browser/ws";
const RECONNECT_DELAY_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 20000;
const KEEPALIVE_INTERVAL_MS = 25000; // Keep service worker alive

// ============================================================================
// State
// ============================================================================

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let extensionId = null;

// ============================================================================
// Keep Service Worker Alive
// ============================================================================

function keepAlive() {
  setInterval(() => {
    try {
      const port = chrome.runtime.connect({ name: "keepalive" });
      setTimeout(() => port.disconnect(), 1000);
    } catch {
      // Service worker might be restarting
    }
  }, KEEPALIVE_INTERVAL_MS);
}

// ============================================================================
// WebSocket Connection
// ============================================================================

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  // Get server URL from storage or use default
  const config = await chrome.storage.local.get(["serverUrl", "extensionId"]);
  const serverUrl = config.serverUrl || DEFAULT_URL;
  extensionId = config.extensionId || crypto.randomUUID().slice(0, 8);

  // Save extensionId for consistency
  await chrome.storage.local.set({ extensionId });

  const url = `${serverUrl}?extId=${extensionId}`;
  console.log(`[clawd-offscreen] Connecting to ${url}`);

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error("[clawd-offscreen] WebSocket creation failed:", err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[clawd-offscreen] Connected to Claw'd server");
    broadcastStatus(true);
    startHeartbeat();
  };

  ws.onclose = (event) => {
    console.log(`[clawd-offscreen] Disconnected (code: ${event.code})`);
    broadcastStatus(false);
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error("[clawd-offscreen] WebSocket error:", err);
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);

      // Server pong
      if (data.type === "pong") return;

      // Command from server — relay to service worker
      if (data.id && data.method) {
        try {
          const response = await chrome.runtime.sendMessage({
            source: "offscreen",
            type: "command",
            id: data.id,
            method: data.method,
            params: data.params || {},
          });
          // Send result back to server
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              id: data.id,
              result: response?.result,
              error: response?.error,
            }));
          }
        } catch (err) {
          // Service worker may have gone idle; send error back
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              id: data.id,
              error: { message: `Service worker error: ${err.message}` },
            }));
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function broadcastStatus(connected) {
  chrome.runtime.sendMessage({
    source: "offscreen",
    type: "connection-status",
    connected,
    extensionId,
  }).catch(() => {});
}

// ============================================================================
// Message Listener — commands from popup or service worker
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "get-status") {
    sendResponse({
      connected: ws && ws.readyState === WebSocket.OPEN,
      extensionId,
    });
    return false;
  }

  if (message.type === "set-server-url") {
    chrome.storage.local.set({ serverUrl: message.url }).then(async () => {
      // Detach old ws handlers before closing to prevent phantom status flickers
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
        ws = null;
      }
      stopHeartbeat();
      try { await connect(); } catch {}
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "reconnect") {
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
      ws = null;
    }
    stopHeartbeat();
    connect().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ============================================================================
// Initialize
// ============================================================================

keepAlive();
connect();
