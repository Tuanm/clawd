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
chrome.runtime.sendMessage({ type: "get-status" }, (response) => {
  if (chrome.runtime.lastError) {
    setStatus(false);
    return;
  }
  setStatus(response?.connected || false);
  if (response?.extensionId) {
    extIdEl.textContent = `ID: ${response.extensionId}`;
  }
});

// Reconnect button
connectBtn.addEventListener("click", () => {
  const url = serverUrlInput.value.trim();
  if (url) {
    chrome.runtime.sendMessage({ type: "set-server-url", url }, () => {
      if (chrome.runtime.lastError) {
        setStatus(false);
        return;
      }
      statusText.textContent = "Reconnecting...";
      dot.className = "dot disconnected";
    });
  } else {
    chrome.runtime.sendMessage({ type: "reconnect" }, () => {
      if (chrome.runtime.lastError) setStatus(false);
    });
  }
});

// Listen for status updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "connection-status") {
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
