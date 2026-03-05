/**
 * Popup Script — extension popup UI logic.
 */

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const serverUrlInput = document.getElementById("serverUrl");
const connectBtn = document.getElementById("connectBtn");
const extIdEl = document.getElementById("extId");

// Load saved config
chrome.storage.local.get(["serverUrl", "extensionId"]).then((config) => {
  serverUrlInput.value = config.serverUrl || "ws://localhost:3456/browser/ws";
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
    // Show diagnostic info if not connected
    if (!response?.connected && response?.lastError) {
      statusText.textContent = `Disconnected: ${response.lastError}`;
    }
  });
}

checkStatus();

// Reconnect button
connectBtn.addEventListener("click", () => {
  const url = serverUrlInput.value.trim();
  console.log("[clawd-popup] Reconnect clicked, url:", url);

  // Immediate visual feedback
  statusText.textContent = "Reconnecting...";
  dot.className = "dot disconnected";
  connectBtn.disabled = true;

  // Save URL to storage for persistence across restarts
  if (url) {
    chrome.storage.local.set({ serverUrl: url }).then(() => {
      console.log("[clawd-popup] Saved serverUrl to storage");
    });
  }

  // Send reconnect with URL directly to offscreen (it can't read storage)
  chrome.runtime.sendMessage({ type: "reconnect", url: url || undefined }, (response) => {
    console.log("[clawd-popup] reconnect response:", response, "lastError:", chrome.runtime.lastError?.message);
    connectBtn.disabled = false;
  });

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
}
