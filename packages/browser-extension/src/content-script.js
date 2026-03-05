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
        }
        50% {
          box-shadow: inset 0 0 24px 6px rgba(217, 120, 83, 0.7);
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
      border: "none",
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
  // Agent Action Cursor — animated Claw'd icon at action positions
  // ==========================================================================

  const CLAWD_CURSOR_SVG = `<svg width="24" height="24" viewBox="0 0 66 52" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="13" width="6" height="13" fill="#d5826a"/>
    <rect x="60" y="13" width="6" height="13" fill="#d5826a"/>
    <rect class="__clawd-leg-l1" x="6" y="39" width="6" height="13" fill="#d5826a"/>
    <rect class="__clawd-leg-l2" x="18" y="39" width="6" height="13" fill="#d5826a"/>
    <rect class="__clawd-leg-r1" x="42" y="39" width="6" height="13" fill="#d5826a"/>
    <rect class="__clawd-leg-r2" x="54" y="39" width="6" height="13" fill="#d5826a"/>
    <rect x="6" y="0" width="54" height="39" fill="#d5826a"/>
    <rect x="12" y="13" width="6" height="6.5" fill="#222"/>
    <rect x="48" y="13" width="6" height="6.5" fill="#222"/>
  </svg>`;

  let cursorStyleEl = null;

  const MAX_CURSORS = 5;
  let activeCursors = 0;

  function ensureCursorStyles() {
    if (cursorStyleEl && cursorStyleEl.isConnected) return;
    cursorStyleEl = document.createElement("style");
    cursorStyleEl.id = "__clawd-cursor-style";
    cursorStyleEl.textContent = `
      @keyframes __clawd-legs {
        0%, 100% {
          transform: rotate(-12deg);
        }
        50% {
          transform: rotate(12deg);
        }
      }
      @keyframes __clawd-cursor-pop {
        0% { transform: translate(-50%, -50%) scale(0); opacity: 1; }
        15% { transform: translate(-50%, -50%) scale(1.3); opacity: 1; }
        30% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
        85% { transform: translate(-50%, -50%) scale(1); opacity: 0.9; }
        100% { transform: translate(-50%, -50%) scale(0.5); opacity: 0; }
      }
      .__clawd-action-cursor {
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
        animation: __clawd-cursor-pop 0.7s ease-out forwards;
        filter: drop-shadow(0 1px 3px rgba(0,0,0,0.3));
      }
      .__clawd-action-cursor svg {
        display: block;
      }
      .__clawd-action-cursor .__clawd-leg-l1,
      .__clawd-action-cursor .__clawd-leg-r2 {
        transform-origin: center top;
        animation: __clawd-legs 0.15s ease-in-out 4 alternate;
      }
      .__clawd-action-cursor .__clawd-leg-l2,
      .__clawd-action-cursor .__clawd-leg-r1 {
        transform-origin: center top;
        animation: __clawd-legs 0.15s ease-in-out 4 alternate-reverse;
      }
    `;
    (document.head || document.documentElement).appendChild(cursorStyleEl);
  }

  function showActionCursor(x, y) {
    if (activeCursors >= MAX_CURSORS) return;
    try {
      ensureCursorStyles();
      activeCursors++;
      const cursor = document.createElement("div");
      cursor.className = "__clawd-action-cursor";
      cursor.innerHTML = CLAWD_CURSOR_SVG;
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
      (document.body || document.documentElement).appendChild(cursor);
      setTimeout(() => {
        cursor.remove();
        activeCursors--;
      }, 750);
    } catch {
      // Ignore errors on restricted pages
    }
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
    } else if (message.type === "show-action-cursor") {
      showActionCursor(message.x, message.y);
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
