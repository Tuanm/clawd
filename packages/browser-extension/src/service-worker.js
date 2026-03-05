/**
 * Claw'd Browser Extension — Service Worker (MV3)
 *
 * Handles commands from the Claw'd server (via offscreen document WebSocket)
 * and dispatches them to browser APIs (tabs, debugger, scripting).
 */

// ============================================================================
// State
// ============================================================================

let offscreenReady = false;
const debuggerAttached = new Set(); // Set of tabIds with debugger attached

// Clean up debugger state on detach (registered once at module scope)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) debuggerAttached.delete(source.tabId);
});

// ============================================================================
// Offscreen Document Management
// ============================================================================

async function ensureOffscreen() {
  if (offscreenReady) return;
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: "src/offscreen.html",
      reasons: ["WORKERS"],
      justification: "WebSocket connection to local Claw'd server",
    });
    // Send saved config to offscreen (it can't access chrome.storage)
    try {
      const config = await chrome.storage.local.get(["serverUrl", "extensionId"]);
      if (config.serverUrl || config.extensionId) {
        // Small delay to let offscreen script initialize its listener
        setTimeout(() => {
          chrome.runtime
            .sendMessage({
              type: "reconnect",
              url: config.serverUrl,
              extensionId: config.extensionId,
            })
            .catch(() => {});
        }, 200);
      }
    } catch {}
  }
  offscreenReady = true;
}

// ============================================================================
// Keep-Alive (MV3 service workers idle-timeout after 30s)
// ============================================================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") {
    // Offscreen doc pings us to prevent idle shutdown
    // Don't clear offscreenReady on planned disconnect cycles
  }
});

// ============================================================================
// Message Router — commands from offscreen (WebSocket) or content scripts
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ensure offscreen exists on every non-offscreen message (handles SW restarts)
  if (!message.source || message.source !== "offscreen") {
    ensureOffscreen().catch(() => {});
  }

  // Commands from offscreen (WebSocket relay)
  if (message.source === "offscreen" && message.type === "command") {
    handleCommand(message.id, message.method, message.params)
      .then((result) => sendResponse({ id: message.id, result }))
      .catch((err) => sendResponse({ id: message.id, error: { message: err.message } }));
    return true; // async response
  }

  // Connection status broadcast from offscreen — let popup hear it
  if (message.source === "offscreen" && message.type === "connection-status") {
    return false;
  }

  // Messages from popup meant for offscreen — don't intercept, let offscreen handle
  if (message.type === "get-status" || message.type === "set-server-url" || message.type === "reconnect") {
    // Don't call sendResponse — offscreen document handles these
    return false;
  }

  if (message.source === "content-script" && message.type === "dom-result") {
    sendResponse({ received: true });
  }

  return false;
});

// ============================================================================
// Command Handlers
// ============================================================================

async function handleCommand(id, method, params) {
  switch (method) {
    case "navigate":
      return handleNavigate(params);
    case "screenshot":
      return handleScreenshot(params);
    case "click":
      return handleClick(params);
    case "type":
      return handleType(params);
    case "extract":
      return handleExtract(params);
    case "tabs":
      return handleTabs(params);
    case "execute":
      return handleExecute(params);
    case "scroll":
      return handleScroll(params);
    case "hover":
      return handleHover(params);
    case "drag":
      return handleDrag(params);
    case "keypress":
      return handleKeypress(params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// --- Navigate ---

async function handleNavigate({ url, tabId, waitFor }) {
  let tab;
  if (tabId) {
    tab = await chrome.tabs.update(tabId, { url });
  } else {
    tab = await chrome.tabs.create({ url });
  }

  // Wait for page load
  await waitForTab(tab.id, waitFor || "load");
  tab = await chrome.tabs.get(tab.id);

  return { tabId: tab.id, url: tab.url, title: tab.title };
}

// --- Screenshot ---

async function handleScreenshot({ tabId, selector, fullPage }) {
  const tid = tabId || (await getActiveTabId());

  if (selector || fullPage) {
    // Use chrome.debugger for element/full-page screenshots
    await ensureDebugger(tid);

    if (fullPage) {
      // Get full page metrics
      const metrics = await sendDebuggerCommand(tid, "Page.getLayoutMetrics");
      const { width, height } = metrics.contentSize;

      // Set device metrics to full page size
      await sendDebuggerCommand(tid, "Emulation.setDeviceMetricsOverride", {
        width: Math.ceil(width),
        height: Math.ceil(height),
        deviceScaleFactor: 1,
        mobile: false,
      });

      try {
        const result = await sendDebuggerCommand(tid, "Page.captureScreenshot", {
          format: "jpeg",
          quality: 60,
        });

        return {
          tabId: tid,
          dataUrl: `data:image/jpeg;base64,${result.data}`,
          width: Math.ceil(width),
          height: Math.ceil(height),
        };
      } finally {
        await sendDebuggerCommand(tid, "Emulation.clearDeviceMetricsOverride").catch(() => {}); // best-effort restore
      }
    }

    if (selector) {
      // Get element bounding box via CDP
      const doc = await sendDebuggerCommand(tid, "DOM.getDocument");
      const node = await sendDebuggerCommand(tid, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      });
      if (!node.nodeId) throw new Error(`Element not found: ${selector}`);

      const box = await sendDebuggerCommand(tid, "DOM.getBoxModel", { nodeId: node.nodeId });
      const quad = box.model.border;
      const clip = {
        x: quad[0],
        y: quad[1],
        width: quad[2] - quad[0],
        height: quad[5] - quad[1],
        scale: 1,
      };

      const result = await sendDebuggerCommand(tid, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 60,
        clip,
      });

      return {
        tabId: tid,
        dataUrl: `data:image/jpeg;base64,${result.data}`,
        width: Math.ceil(clip.width),
        height: Math.ceil(clip.height),
      };
    }
  }

  // Simple viewport screenshot via tabs API
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 60 });
  return { tabId: tid, dataUrl, width: null, height: null };
}

// --- Click ---

async function handleClick({ selector, x, y, tabId, button }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let clickX = x;
  let clickY = y;

  if (selector) {
    // Resolve selector to coordinates
    const coords = await getElementCenter(tid, selector);
    clickX = coords.x;
    clickY = coords.y;
  } else if (clickX === undefined || clickY === undefined) {
    throw new Error("Click requires either 'selector' or both 'x' and 'y' coordinates");
  }

  const buttonMap = { left: "left", right: "right", middle: "middle" };
  const btn = buttonMap[button] || "left";
  const clickCount = 1;

  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: clickX,
    y: clickY,
    button: btn,
    clickCount,
  });
  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: clickX,
    y: clickY,
    button: btn,
    clickCount,
  });

  return { tabId: tid, element: selector || `(${clickX},${clickY})` };
}

// --- Type ---

async function handleType({ text, selector, tabId, clearFirst, pressEnter }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  if (selector) {
    // Focus the element first
    const coords = await getElementCenter(tid, selector);
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: coords.x,
      y: coords.y,
      button: "left",
      clickCount: 1,
    });
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: coords.x,
      y: coords.y,
      button: "left",
      clickCount: 1,
    });
  }

  if (clearFirst) {
    // Select all + delete
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: 2, // Ctrl
    });
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
    });
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
    });
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
    });
  }

  // Type text using CDP insertText (handles React/SPA events correctly)
  await sendDebuggerCommand(tid, "Input.insertText", { text });

  if (pressEnter) {
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
    });
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
    });
  }

  return { tabId: tid, element: selector || "(focused)" };
}

// --- Extract ---

async function handleExtract({ mode, selector, tabId }) {
  const tid = tabId || (await getActiveTabId());

  if (mode === "accessibility") {
    await ensureDebugger(tid);
    const result = await sendDebuggerCommand(tid, "Accessibility.getFullAXTree");
    // Compact the tree
    const nodes = (result.nodes || [])
      .slice(0, 500)
      .map((n) => ({
        role: n.role?.value,
        name: n.name?.value,
        value: n.value?.value,
      }))
      .filter((n) => n.name || n.value);
    return { data: nodes };
  }

  // Use content script for DOM extraction
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: extractFromPage,
    args: [mode || "text", selector || null],
  });

  return { data: results[0]?.result || "" };
}

// Content script function injected for extraction
function extractFromPage(mode, selector) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return `Element not found: ${selector}`;

  switch (mode) {
    case "text":
      return root.innerText?.slice(0, 50000) || "";
    case "links":
      return Array.from(root.querySelectorAll("a[href]"))
        .map((a) => ({
          text: a.textContent?.trim().slice(0, 100),
          href: a.href,
        }))
        .slice(0, 200);
    case "forms":
      return Array.from(root.querySelectorAll("input,textarea,select"))
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || "",
          name: el.name || "",
          id: el.id || "",
          value: el.value?.slice(0, 200) || "",
          placeholder: el.placeholder || "",
        }))
        .slice(0, 100);
    case "tables":
      return Array.from(root.querySelectorAll("table"))
        .map((table) => {
          const rows = Array.from(table.querySelectorAll("tr")).slice(0, 50);
          return rows.map((row) =>
            Array.from(row.querySelectorAll("td,th")).map((cell) => cell.textContent?.trim().slice(0, 200)),
          );
        })
        .slice(0, 10);
    case "html":
      return root.outerHTML?.slice(0, 50000) || "";
    default:
      return root.innerText?.slice(0, 50000) || "";
  }
}

// --- Tabs ---

async function handleTabs({ action, tabId }) {
  if (action === "close" && tabId) {
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  }
  if (action === "activate" && tabId) {
    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId);
    return { activated: tabId, title: tab.title, url: tab.url };
  }
  // List
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      windowId: t.windowId,
    })),
  };
}

// --- Execute JS ---

async function handleExecute({ code, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);
  // Use CDP Runtime.evaluate — MV3 blocks new Function()/eval in service workers
  const result = await sendDebuggerCommand(tid, "Runtime.evaluate", {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Script execution failed",
    );
  }
  return { value: result.result?.value };
}

// --- Scroll ---

async function handleScroll({ x, y, selector, direction, amount, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let scrollX = x || 0;
  let scrollY = y || 0;

  if (selector) {
    const coords = await getElementCenter(tid, selector);
    scrollX = coords.x;
    scrollY = coords.y;
  }

  // Calculate delta from direction/amount
  const dist = amount || 300;
  let deltaX = 0;
  let deltaY = 0;
  switch (direction) {
    case "up": deltaY = -dist; break;
    case "down": deltaY = dist; break;
    case "left": deltaX = -dist; break;
    case "right": deltaX = dist; break;
    default: deltaY = dist; // default scroll down
  }

  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: scrollX,
    y: scrollY,
    deltaX,
    deltaY,
  });

  return { tabId: tid, direction: direction || "down", amount: dist };
}

// --- Hover ---

async function handleHover({ selector, x, y, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let hoverX = x;
  let hoverY = y;

  if (selector) {
    const coords = await getElementCenter(tid, selector);
    hoverX = coords.x;
    hoverY = coords.y;
  } else if (hoverX === undefined || hoverY === undefined) {
    throw new Error("Hover requires either 'selector' or both 'x' and 'y' coordinates");
  }

  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: hoverX,
    y: hoverY,
  });

  return { tabId: tid, element: selector || `(${hoverX},${hoverY})` };
}

// --- Drag ---

async function handleDrag({ fromSelector, fromX, fromY, toSelector, toX, toY, tabId, steps }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let startX = fromX;
  let startY = fromY;
  let endX = toX;
  let endY = toY;

  if (fromSelector) {
    const coords = await getElementCenter(tid, fromSelector);
    startX = coords.x;
    startY = coords.y;
  }
  if (toSelector) {
    const coords = await getElementCenter(tid, toSelector);
    endX = coords.x;
    endY = coords.y;
  }

  if (startX === undefined || startY === undefined || endX === undefined || endY === undefined) {
    throw new Error("Drag requires from/to coordinates or selectors");
  }

  const numSteps = steps || 10;

  // Press at start
  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: startX,
    y: startY,
    button: "left",
    clickCount: 1,
  });

  // Move in steps
  for (let i = 1; i <= numSteps; i++) {
    const ratio = i / numSteps;
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: startX + (endX - startX) * ratio,
      y: startY + (endY - startY) * ratio,
      button: "left",
    });
  }

  // Release at end
  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: endX,
    y: endY,
    button: "left",
    clickCount: 1,
  });

  return { tabId: tid, from: fromSelector || `(${startX},${startY})`, to: toSelector || `(${endX},${endY})` };
}

// --- Keypress ---

async function handleKeypress({ key, modifiers, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  const modifierFlags =
    (modifiers?.includes("alt") ? 1 : 0) |
    (modifiers?.includes("ctrl") ? 2 : 0) |
    (modifiers?.includes("meta") ? 4 : 0) |
    (modifiers?.includes("shift") ? 8 : 0);

  // Map common key names to CDP key/code
  const keyMap = {
    enter: { key: "Enter", code: "Enter" },
    tab: { key: "Tab", code: "Tab" },
    escape: { key: "Escape", code: "Escape" },
    backspace: { key: "Backspace", code: "Backspace" },
    delete: { key: "Delete", code: "Delete" },
    arrowup: { key: "ArrowUp", code: "ArrowUp" },
    arrowdown: { key: "ArrowDown", code: "ArrowDown" },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft" },
    arrowright: { key: "ArrowRight", code: "ArrowRight" },
    home: { key: "Home", code: "Home" },
    end: { key: "End", code: "End" },
    pageup: { key: "PageUp", code: "PageUp" },
    pagedown: { key: "PageDown", code: "PageDown" },
    space: { key: " ", code: "Space" },
    f1: { key: "F1", code: "F1" }, f2: { key: "F2", code: "F2" },
    f3: { key: "F3", code: "F3" }, f4: { key: "F4", code: "F4" },
    f5: { key: "F5", code: "F5" }, f6: { key: "F6", code: "F6" },
    f7: { key: "F7", code: "F7" }, f8: { key: "F8", code: "F8" },
    f9: { key: "F9", code: "F9" }, f10: { key: "F10", code: "F10" },
    f11: { key: "F11", code: "F11" }, f12: { key: "F12", code: "F12" },
  };

  const mapped = keyMap[key.toLowerCase()] || { key, code: `Key${key.toUpperCase()}` };

  await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: mapped.key,
    code: mapped.code,
    modifiers: modifierFlags,
  });
  await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: mapped.key,
    code: mapped.code,
    modifiers: modifierFlags,
  });

  return {
    tabId: tid,
    key: mapped.key,
    modifiers: modifiers || [],
  };
}

// ============================================================================
// Debugger Helpers
// ============================================================================

async function ensureDebugger(tabId) {
  if (debuggerAttached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  debuggerAttached.add(tabId);
}

function sendDebuggerCommand(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function getElementCenter(tabId, selector) {
  const doc = await sendDebuggerCommand(tabId, "DOM.getDocument");
  const node = await sendDebuggerCommand(tabId, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!node.nodeId) throw new Error(`Element not found: ${selector}`);

  const box = await sendDebuggerCommand(tabId, "DOM.getBoxModel", { nodeId: node.nodeId });
  const quad = box.model.content;
  return {
    x: (quad[0] + quad[2]) / 2,
    y: (quad[1] + quad[5]) / 2,
  };
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab.id;
}

function waitForTab(tabId, event) {
  return new Promise(async (resolve) => {
    const target = "complete"; // Both "load" and "domcontentloaded" wait for full load

    // Check if already in desired state (avoids race condition)
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === target) {
        resolve();
        return;
      }
    } catch {
      resolve();
      return;
    }

    function listener(tid, changeInfo) {
      if (tid === tabId && changeInfo.status === target) {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
}

// ============================================================================
// Initialization
// ============================================================================

// Ensure offscreen doc exists on every SW activation (covers restarts)
ensureOffscreen().catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[clawd] Browser extension installed");
  await ensureOffscreen();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreen();
});

// Clean up debugger on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerAttached.delete(tabId);
});
