/**
 * Content Script — injected into every page.
 *
 * Provides:
 * 1. Agent activity indicator (glowing border overlay using Claw'd primary color)
 * 2. Visual feedback for element interactions (highlight)
 * 3. DOM utility helpers callable from service worker
 */

// Avoid re-injection
if (!window.__clawdBrowserBridge) {
  window.__clawdBrowserBridge = true;

  // ==========================================================================
  // Agent Activity Overlay — glowing border when agent is working in this tab
  // ==========================================================================

  let overlayCount = 0;
  let overlayEl = null;
  let styleEl = null;
  let hideTimer = null;
  let fadeTimer = null;

  function showAgentOverlay() {
    overlayCount++;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (fadeTimer) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    if (overlayEl) {
      overlayEl.style.opacity = "1"; // restore if mid-fade
      return;
    }

    styleEl = document.createElement("style");
    styleEl.id = "__clawd-overlay-style";
    styleEl.textContent = `
      @keyframes __clawd-glow {
        0%, 100% { box-shadow: inset 0 0 8px 2px rgba(217, 120, 83, 0.5); }
        50% { box-shadow: inset 0 0 20px 4px rgba(217, 120, 83, 0.85); }
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);

    overlayEl = document.createElement("div");
    overlayEl.id = "__clawd-agent-overlay";
    Object.assign(overlayEl.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      border: "2px solid rgba(217, 120, 83, 0.6)",
      borderRadius: "0",
      animation: "__clawd-glow 2s ease-in-out infinite",
      transition: "opacity 0.3s",
    });
    document.documentElement.appendChild(overlayEl);
  }

  function hideAgentOverlay() {
    overlayCount = Math.max(0, overlayCount - 1);
    if (overlayCount > 0 || !overlayEl) return;

    // Brief delay before fade-out for smoother visual
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (overlayEl) {
        overlayEl.style.opacity = "0";
        fadeTimer = setTimeout(() => {
          overlayEl?.remove();
          overlayEl = null;
          styleEl?.remove();
          styleEl = null;
          fadeTimer = null;
        }, 300);
      }
    }, 500);
  }

  // ==========================================================================
  // Message Handlers
  // ==========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "show-agent-overlay") {
      showAgentOverlay();
      sendResponse({ ok: true });
    } else if (message.type === "hide-agent-overlay") {
      hideAgentOverlay();
      sendResponse({ ok: true });
    } else if (message.type === "highlight-element") {
      highlightElement(message.selector, message.duration || 2000);
      sendResponse({ ok: true });
    }
    return false;
  });

  // ==========================================================================
  // Element Highlighting
  // ==========================================================================

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

      (document.body || document.documentElement).appendChild(overlay);

      setTimeout(() => {
        overlay.style.opacity = "0";
        setTimeout(() => overlay.remove(), 300);
      }, duration);
    } catch {
      // Ignore errors
    }
  }
}
