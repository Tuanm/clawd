/**
 * Content Script — injected into every page.
 *
 * Provides DOM utilities that the service worker can call via
 * chrome.scripting.executeScript. Also acts as a visual feedback
 * layer (e.g., highlighting elements the agent is interacting with).
 */

// Avoid re-injection
if (!window.__clawdBrowserBridge) {
  window.__clawdBrowserBridge = true;

  // Listen for highlight requests from service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "highlight-element") {
      highlightElement(message.selector, message.duration || 2000);
      sendResponse({ ok: true });
    }
    return false;
  });

  /**
   * Highlight a DOM element with a colored border overlay.
   */
  function highlightElement(selector, duration) {
    try {
      const el = document.querySelector(selector);
      if (!el) return;

      const overlay = document.createElement("div");
      const rect = el.getBoundingClientRect();
      Object.assign(overlay.style, {
        position: "fixed",
        left: `${rect.left - 2}px`,
        top: `${rect.top - 2}px`,
        width: `${rect.width + 4}px`,
        height: `${rect.height + 4}px`,
        border: "2px solid #D97853",
        borderRadius: "3px",
        backgroundColor: "rgba(217, 120, 83, 0.1)",
        zIndex: "2147483647",
        pointerEvents: "none",
        transition: "opacity 0.3s",
      });

      document.body.appendChild(overlay);

      setTimeout(() => {
        overlay.style.opacity = "0";
        setTimeout(() => overlay.remove(), 300);
      }, duration);
    } catch {
      // Ignore errors
    }
  }
}
