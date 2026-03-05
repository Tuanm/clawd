/**
 * Popup Script — extension popup UI logic.
 *
 * The popup collects a server host (e.g. "localhost:3456") and an optional
 * auth token.  It builds the full WebSocket URL internally:
 *   ws://<host>/browser/ws?extId=...&token=...
 *
 * After a successful connection with a token, the input shows a masked
 * version like "tok***xyz" to prevent accidental leaks.
 */

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const serverHostInput = document.getElementById("serverHost");
const authTokenInput = document.getElementById("authToken");
const connectBtn = document.getElementById("connectBtn");
const extIdEl = document.getElementById("extId");

const DEFAULT_HOST = "localhost:3456";

/** Mask token: never reveal more than ~50% of chars */
function maskToken(token) {
  if (!token) return "";
  if (token.length <= 5) return "***";
  if (token.length <= 8) return `${token.slice(0, 1)}***${token.slice(-1)}`;
  if (token.length <= 12) return `${token.slice(0, 2)}***${token.slice(-2)}`;
  return `${token.slice(0, 3)}***${token.slice(-3)}`;
}

/** Build ws:// URL from host string (strip any user-supplied protocol/path). */
function buildWsUrl(host) {
  // Strip protocol if user accidentally typed it (any scheme)
  let h = (host || DEFAULT_HOST)
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/+$/, "");
  // Strip path if user accidentally added it
  const slashIdx = h.indexOf("/");
  if (slashIdx > 0) h = h.substring(0, slashIdx);
  // Determine protocol — use wss:// only if the host looks like a remote domain
  const isLocal =
    /^(localhost|127\.\d|0\.0\.0\.0|10\.\d|172\.(1[6-9]|2\d|3[01])\.|192\.168\.\d|\[::1\]|\[::ffff:127|\[fe80:)/i.test(
      h,
    );
  const protocol = isLocal ? "ws" : "wss";
  return `${protocol}://${h}/browser/ws`;
}

// Track whether the token input is showing a masked value
let tokenMasked = false;
let realToken = "";

authTokenInput.addEventListener("focus", () => {
  if (tokenMasked) {
    // Let user clear & re-enter — don't reveal the old token
    authTokenInput.value = "";
    authTokenInput.type = "password";
    tokenMasked = false;
    authTokenInput.dataset.wasCleared = "1";
  }
});

authTokenInput.addEventListener("blur", () => {
  // If user focused and left empty without typing, restore the masked value
  if (authTokenInput.dataset.wasCleared === "1" && !authTokenInput.value.trim()) {
    if (realToken) {
      authTokenInput.type = "text";
      authTokenInput.value = maskToken(realToken);
      tokenMasked = true;
    }
  }
  delete authTokenInput.dataset.wasCleared;
});

// Load saved config
chrome.storage.local.get(["serverHost", "serverUrl", "authToken", "extensionId"]).then((config) => {
  // Migration: old configs stored full serverUrl — extract host from it
  if (!config.serverHost && config.serverUrl) {
    try {
      const u = new URL(config.serverUrl.replace(/^ws/, "http"));
      config.serverHost = u.host;
      // Persist migrated host
      chrome.storage.local.set({ serverHost: config.serverHost });
    } catch {}
  }
  serverHostInput.value = config.serverHost || DEFAULT_HOST;
  if (config.authToken) {
    realToken = config.authToken;
    authTokenInput.type = "text"; // show readable mask, not password dots
    authTokenInput.value = maskToken(config.authToken);
    tokenMasked = true;
  }
  if (config.extensionId) {
    extIdEl.textContent = `ID: ${config.extensionId}`;
  }
});

// Check connection status
function checkStatus() {
  chrome.runtime.sendMessage({ type: "get-status" }, (response) => {
    if (chrome.runtime.lastError) {
      console.log("[clawd-popup] get-status error:", chrome.runtime.lastError.message);
      setStatus(false);
      return;
    }
    console.log("[clawd-popup] get-status response:", JSON.stringify(response));
    setStatus(response?.connected || false);
    if (response?.extensionId) {
      extIdEl.textContent = `ID: ${response.extensionId}`;
    }
    if (!response?.connected && response?.lastError) {
      statusText.textContent = `Disconnected: ${response.lastError}`;
    }
  });
}

checkStatus();

// Connect button
connectBtn.addEventListener("click", () => {
  const host = serverHostInput.value.trim() || DEFAULT_HOST;
  const wsUrl = buildWsUrl(host);

  // Resolve token: if still masked, keep the saved one; otherwise take new input
  const token = tokenMasked ? realToken : authTokenInput.value.trim();

  console.log("[clawd-popup] Connect clicked, host:", host, "wsUrl:", wsUrl, "hasToken:", !!token);

  // Immediate visual feedback
  statusText.textContent = "Connecting...";
  dot.className = "dot disconnected";
  connectBtn.disabled = true;

  // Persist to storage (serverHost + legacy serverUrl for service-worker compat)
  const storageData = { serverHost: host, serverUrl: wsUrl };
  if (token) {
    chrome.storage.local
      .set({ ...storageData, authToken: token })
      .then(() => console.log("[clawd-popup] Saved config to storage"));
  } else {
    chrome.storage.local
      .set(storageData)
      .then(() => chrome.storage.local.remove("authToken"))
      .then(() => console.log("[clawd-popup] Saved config to storage (no token)"));
  }

  // Send to offscreen with full WS URL + token
  chrome.runtime.sendMessage({ type: "reconnect", url: wsUrl, token: token || undefined }, (response) => {
    console.log("[clawd-popup] reconnect response:", response, "lastError:", chrome.runtime.lastError?.message);
    connectBtn.disabled = false;
  });

  // After connecting with a token, mask it in the input
  if (token) {
    realToken = token;
    setTimeout(() => {
      authTokenInput.type = "text"; // show masked value as readable text
      authTokenInput.value = maskToken(token);
      tokenMasked = true;
    }, 300);
  }

  // Poll status after a delay
  setTimeout(checkStatus, 2000);
  setTimeout(checkStatus, 5000);
});

// Listen for status updates from offscreen
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "connection-status") {
    console.log("[clawd-popup] connection-status:", message.connected);
    setStatus(message.connected);
    if (message.extensionId) {
      extIdEl.textContent = `ID: ${message.extensionId}`;
    }
  }
});

function setStatus(connected) {
  dot.className = connected ? "dot connected" : "dot disconnected";
  statusText.textContent = connected ? "Connected to Claw'd" : "Disconnected";
  connectBtn.textContent = connected ? "Reconnect" : "Connect";
}
