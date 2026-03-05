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
        0%, 100% {
          box-shadow: inset 0 0 6px 2px rgba(217, 120, 83, 0.3);
          border-color: rgba(217, 120, 83, 0.4);
        }
        50% {
          box-shadow: inset 0 0 24px 6px rgba(217, 120, 83, 0.7);
          border-color: rgba(217, 120, 83, 0.9);
        }
      }
      @keyframes __clawd-glow-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);

    overlayEl = document.createElement("div");
    overlayEl.id = "__clawd-agent-overlay";
    Object.assign(overlayEl.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      bottom: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      border: "3px solid rgba(217, 120, 83, 0.6)",
      boxSizing: "border-box",
      animation: "__clawd-glow 2s ease-in-out infinite, __clawd-glow-in 0.3s ease-out",
      transition: "opacity 0.3s ease-out",
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
