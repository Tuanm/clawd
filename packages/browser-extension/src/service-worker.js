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
const debuggerPending = new Map(); // tabId -> Promise (serializes attachment)
const activeTabCommands = new Map(); // tabId -> active command count (for glow indicator)
const frameContexts = new Map(); // `${tabId}:${frameId}` -> executionContextId
let currentEmulation = null; // Track active emulation state for full-page screenshot restore

// Clean up debugger state on detach (registered once at module scope)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) debuggerAttached.delete(source.tabId);
});

// ============================================================================
// Offscreen Document Management
// ============================================================================

async function ensureOffscreen() {
  // Always verify — offscreen doc can crash under memory pressure
  const existing = await chrome.offscreen.hasDocument();
  if (existing) {
    offscreenReady = true;
    return;
  }
  offscreenReady = false;
  await chrome.offscreen.createDocument({
    url: "src/offscreen.html",
    reasons: ["WORKERS"],
    justification: "WebSocket connection to local Claw'd server",
  });
  // Send saved config to offscreen (it can't access chrome.storage)
  try {
    const config = await chrome.storage.local.get(["serverUrl", "extensionId"]);
    if (config.serverUrl || config.extensionId) {
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
  // Show glow indicator on target tab
  let indicatorTab = params?.tabId || null;
  if (!indicatorTab) {
    try {
      indicatorTab = await getActiveTabId();
    } catch {}
  }
  if (indicatorTab) showAgentIndicator(indicatorTab);
  try {
    return await dispatchCommand(method, params);
  } finally {
    if (indicatorTab) hideAgentIndicator(indicatorTab);
  }
}

async function dispatchCommand(method, params) {
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
    case "wait_for":
      return handleWaitFor(params);
    case "select":
      return handleSelect(params);
    case "dialog":
      return handleDialog(params);
    case "history":
      return handleHistory(params);
    case "file_upload":
      return handleFileUpload(params);
    case "frames":
      return handleFrames(params);
    case "touch":
      return handleTouch(params);
    case "emulate":
      return handleEmulate(params);
    case "download":
      return handleDownload(params);
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

  if (selector || fullPage || tabId) {
    // Use chrome.debugger for element/full-page/tab-specific screenshots
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
        // Restore active emulation if set, otherwise clear
        if (currentEmulation) {
          await sendDebuggerCommand(tid, "Emulation.setDeviceMetricsOverride", currentEmulation).catch(() => {});
        } else {
          await sendDebuggerCommand(tid, "Emulation.clearDeviceMetricsOverride").catch(() => {});
        }
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

    // Tab-specific viewport screenshot via CDP (not captureVisibleTab which ignores tabId)
    const result = await sendDebuggerCommand(tid, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 60,
    });
    return { tabId: tid, dataUrl: `data:image/jpeg;base64,${result.data}`, width: null, height: null };
  }

  // Simple viewport screenshot of active visible tab via tabs API
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 60 });
  return { tabId: tid, dataUrl, width: null, height: null };
}

// --- Click ---

async function handleClick({ selector, x, y, tabId, button, clickCount: count, pierce }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let clickX = x;
  let clickY = y;

  if (selector) {
    const coords = pierce ? await resolveElementCoords(tid, selector) : await getElementCenter(tid, selector);
    clickX = coords.x;
    clickY = coords.y;
  } else if (clickX === undefined || clickY === undefined) {
    throw new Error("Click requires either 'selector' or both 'x' and 'y' coordinates");
  }

  const buttonMap = { left: "left", right: "right", middle: "middle" };
  const btn = buttonMap[button] || "left";
  const clickCount = count || 1;

  for (let i = 0; i < clickCount; i++) {
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: clickX,
      y: clickY,
      button: btn,
      clickCount: i + 1,
    });
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: clickX,
      y: clickY,
      button: btn,
      clickCount: i + 1,
    });
  }

  return { tabId: tid, element: selector || `(${clickX},${clickY})` };
}

// --- Type ---

async function handleType({ text, selector, tabId, clearFirst, pressEnter, pierce }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  if (selector) {
    // Focus the element first
    const coords = pierce ? await resolveElementCoords(tid, selector) : await getElementCenter(tid, selector);
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

async function handleExtract({ mode, selector, tabId, frameId }) {
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
  const target = { tabId: tid };
  if (frameId) target.frameIds = [frameId];
  const results = await chrome.scripting.executeScript({
    target,
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

async function handleExecute({ code, tabId, frameId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  // Determine execution context for frame targeting
  const evalParams = {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
  };
  if (frameId) {
    const contextId = frameContexts.get(`${tid}:${frameId}`);
    if (!contextId) throw new Error(`No execution context for frame ${frameId}. Call browser_frames first.`);
    evalParams.contextId = contextId;
  }

  // Use CDP Runtime.evaluate — MV3 blocks new Function()/eval in service workers
  const result = await sendDebuggerCommand(tid, "Runtime.evaluate", evalParams);
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
    case "up":
      deltaY = -dist;
      break;
    case "down":
      deltaY = dist;
      break;
    case "left":
      deltaX = -dist;
      break;
    case "right":
      deltaX = dist;
      break;
    default:
      deltaY = dist; // default scroll down
  }

  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: scrollX,
    y: scrollY,
    deltaX,
    deltaY,
  });

  // Wait for scroll to settle (mouseWheel resolves before DOM updates)
  await new Promise((r) => setTimeout(r, 150));

  return { tabId: tid, direction: direction || "down", amount: dist };
}

// --- Hover ---

async function handleHover({ selector, x, y, tabId, pierce }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let hoverX = x;
  let hoverY = y;

  if (selector) {
    const coords = pierce ? await resolveElementCoords(tid, selector) : await getElementCenter(tid, selector);
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
    // Digits
    0: { key: "0", code: "Digit0" },
    1: { key: "1", code: "Digit1" },
    2: { key: "2", code: "Digit2" },
    3: { key: "3", code: "Digit3" },
    4: { key: "4", code: "Digit4" },
    5: { key: "5", code: "Digit5" },
    6: { key: "6", code: "Digit6" },
    7: { key: "7", code: "Digit7" },
    8: { key: "8", code: "Digit8" },
    9: { key: "9", code: "Digit9" },
    // Special characters
    "-": { key: "-", code: "Minus" },
    "=": { key: "=", code: "Equal" },
    "[": { key: "[", code: "BracketLeft" },
    "]": { key: "]", code: "BracketRight" },
    "\\": { key: "\\", code: "Backslash" },
    ";": { key: ";", code: "Semicolon" },
    "'": { key: "'", code: "Quote" },
    "`": { key: "`", code: "Backquote" },
    ",": { key: ",", code: "Comma" },
    ".": { key: ".", code: "Period" },
    "/": { key: "/", code: "Slash" },
    // Function keys
    f1: { key: "F1", code: "F1" },
    f2: { key: "F2", code: "F2" },
    f3: { key: "F3", code: "F3" },
    f4: { key: "F4", code: "F4" },
    f5: { key: "F5", code: "F5" },
    f6: { key: "F6", code: "F6" },
    f7: { key: "F7", code: "F7" },
    f8: { key: "F8", code: "F8" },
    f9: { key: "F9", code: "F9" },
    f10: { key: "F10", code: "F10" },
    f11: { key: "F11", code: "F11" },
    f12: { key: "F12", code: "F12" },
  };

  // For single letters, use KeyA-KeyZ; for unmapped, use key as code
  function resolveKey(k) {
    const lower = k.toLowerCase();
    if (keyMap[lower]) return keyMap[lower];
    if (/^[a-z]$/i.test(k)) return { key: k, code: `Key${k.toUpperCase()}` };
    return { key: k, code: k };
  }

  const mapped = resolveKey(key);

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

// --- Wait For Element ---

async function handleWaitFor({ selector, tabId, timeout, visible, pierce }) {
  const tid = tabId || (await getActiveTabId());
  const maxWait = Math.min(timeout || 5000, 30000);
  const interval = 200;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: (sel, checkVisible, doPierce) => {
          function query(s) {
            let el = document.querySelector(s);
            if (el || !doPierce) return el;
            // Search shadow DOMs
            function searchShadow(root) {
              for (const node of root.querySelectorAll("*")) {
                if (node.shadowRoot) {
                  const found = node.shadowRoot.querySelector(s);
                  if (found) return found;
                  const deep = searchShadow(node.shadowRoot);
                  if (deep) return deep;
                }
              }
              return null;
            }
            el = searchShadow(document);
            if (el) return el;
            // Search same-origin iframes
            for (const iframe of document.querySelectorAll("iframe")) {
              try {
                if (iframe.contentDocument) {
                  const found = iframe.contentDocument.querySelector(s);
                  if (found) return found;
                }
              } catch {}
            }
            return null;
          }
          const el = query(sel);
          if (!el) return null;
          if (checkVisible) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return null;
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return null;
          }
          return { tag: el.tagName.toLowerCase(), text: (el.textContent || "").slice(0, 100) };
        },
        args: [selector, visible !== false, !!pierce],
      });
      if (results[0]?.result) {
        return { found: true, tabId: tid, element: results[0].result, elapsed: Date.now() - start };
      }
    } catch {
      /* page might be navigating */
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`Element "${selector}" not found within ${maxWait}ms`);
}

// --- Select Dropdown ---

async function handleSelect({ selector, value, text, index, tabId }) {
  const tid = tabId || (await getActiveTabId());
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (sel, val, txt, idx) => {
      const el = document.querySelector(sel);
      if (!el) return { error: `Element not found: ${sel}` };
      if (el.tagName.toLowerCase() !== "select") return { error: `Element is not a <select>: ${el.tagName}` };

      let option = null;
      if (val !== null && val !== undefined) {
        option = Array.from(el.options).find((o) => o.value === val);
      } else if (txt !== null && txt !== undefined) {
        option = Array.from(el.options).find((o) => o.text.trim() === txt);
      } else if (idx !== null && idx !== undefined) {
        option = el.options[idx];
      }
      if (!option) return { error: `Option not found (value=${val}, text=${txt}, index=${idx})` };

      el.value = option.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { selected: option.value, text: option.text, index: option.index };
    },
    args: [selector, value || null, text || null, index ?? null],
  });
  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  return { tabId: tid, ...result };
}

// --- Dialog Handling (alert/confirm/prompt) ---

const pendingDialogs = new Map(); // tabId -> { type, message, defaultPrompt }

// Listen for JavaScript dialogs and frame execution contexts
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Page.javascriptDialogOpening" && source.tabId) {
    pendingDialogs.set(source.tabId, {
      type: params.type,
      message: params.message,
      defaultPrompt: params.defaultPrompt,
    });
  }
  // Track execution contexts for frame targeting
  if (method === "Runtime.executionContextCreated" && source.tabId) {
    const ctx = params.context;
    if (ctx.auxData?.frameId) {
      frameContexts.set(`${source.tabId}:${ctx.auxData.frameId}`, ctx.id);
    }
  }
  if (method === "Runtime.executionContextDestroyed" && source.tabId) {
    for (const [key, ctxId] of frameContexts) {
      if (ctxId === params.executionContextId) {
        frameContexts.delete(key);
        break;
      }
    }
  }
  // Clear all frame contexts on full navigation (Chrome doesn't fire individual destroy events)
  if (method === "Runtime.executionContextsCleared" && source.tabId) {
    const prefix = `${source.tabId}:`;
    for (const key of frameContexts.keys()) {
      if (key.startsWith(prefix)) frameContexts.delete(key);
    }
  }
});

async function handleDialog({ action, promptText, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  // Enable Page domain to receive dialog events
  await sendDebuggerCommand(tid, "Page.enable").catch(() => {});

  const dialog = pendingDialogs.get(tid);
  if (!dialog) {
    return { tabId: tid, handled: false, message: "No pending dialog" };
  }

  await sendDebuggerCommand(tid, "Page.handleJavaScriptDialog", {
    accept: action !== "dismiss",
    promptText: promptText || "",
  });

  pendingDialogs.delete(tid);
  return { tabId: tid, handled: true, type: dialog.type, dialogMessage: dialog.message };
}

// --- History (Back/Forward) ---

async function handleHistory({ action, tabId }) {
  const tid = tabId || (await getActiveTabId());
  if (action === "back") {
    await chrome.tabs.goBack(tid);
  } else if (action === "forward") {
    await chrome.tabs.goForward(tid);
  } else {
    throw new Error(`Unknown history action: ${action}. Use "back" or "forward".`);
  }
  // Yield to let Chrome transition tab.status from "complete" to "loading"
  await new Promise((r) => setTimeout(r, 100));
  await waitForTab(tid, "load");
  const tab = await chrome.tabs.get(tid);
  return { tabId: tid, url: tab.url, title: tab.title, action };
}

// --- File Upload (set files on <input type="file">) ---

async function handleFileUpload({ selector, files, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  const doc = await sendDebuggerCommand(tid, "DOM.getDocument");
  const node = await sendDebuggerCommand(tid, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!node.nodeId) throw new Error(`File input not found: ${selector}`);

  await sendDebuggerCommand(tid, "DOM.setFileInputFiles", {
    nodeId: node.nodeId,
    files, // array of local file paths
  });

  return { tabId: tid, selector, fileCount: files.length };
}

// --- Frames (list iframes) ---

async function handleFrames({ tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  // Enable Page + Runtime domains for frame/context tracking
  await sendDebuggerCommand(tid, "Page.enable").catch(() => {});
  await sendDebuggerCommand(tid, "Runtime.enable").catch(() => {});

  const result = await sendDebuggerCommand(tid, "Page.getFrameTree");

  function flattenFrames(frameTree, depth = 0) {
    const frames = [];
    const frame = frameTree.frame;
    frames.push({
      frameId: frame.id,
      parentFrameId: frame.parentId || null,
      url: frame.url,
      name: frame.name || "",
      securityOrigin: frame.securityOrigin,
      depth,
    });
    if (frameTree.childFrames) {
      for (const child of frameTree.childFrames) {
        frames.push(...flattenFrames(child, depth + 1));
      }
    }
    return frames;
  }

  return { tabId: tid, frames: flattenFrames(result.frameTree) };
}

// --- Touch Events ---

async function handleTouch({ action, x, y, selector, endX, endY, scale, tabId, duration }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let touchX = x;
  let touchY = y;
  if (selector) {
    const coords = await getElementCenter(tid, selector);
    touchX = coords.x;
    touchY = coords.y;
  }
  if (touchX === undefined || touchY === undefined) {
    throw new Error("Touch requires selector or x,y coordinates");
  }

  if (action === "tap") {
    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: touchX, y: touchY }],
    });
    await new Promise((r) => setTimeout(r, 50));
    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    return { tabId: tid, action: "tap", x: touchX, y: touchY };
  }

  if (action === "swipe") {
    const eX = endX ?? touchX;
    const eY = endY ?? touchY;
    const steps = 10;

    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: touchX, y: touchY }],
    });

    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: touchX + (eX - touchX) * ratio,
            y: touchY + (eY - touchY) * ratio,
          },
        ],
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    return { tabId: tid, action: "swipe", from: { x: touchX, y: touchY }, to: { x: eX, y: eY } };
  }

  if (action === "long-press") {
    const holdMs = duration || 500;
    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: touchX, y: touchY }],
    });
    await new Promise((r) => setTimeout(r, holdMs));
    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    return { tabId: tid, action: "long-press", x: touchX, y: touchY, duration: holdMs };
  }

  if (action === "pinch") {
    const pinchScale = scale ?? endX ?? 0.5; // prefer dedicated scale param, fallback to endX for backward compat
    const x2 = touchX + 50;
    const y2 = touchY;
    const steps = 10;

    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: touchX, y: touchY, id: 0 },
        { x: x2, y: y2, id: 1 },
      ],
    });

    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      const offset = 50 * (1 + (pinchScale - 1) * ratio);
      await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: touchX - (offset - 50) * ratio, y: touchY, id: 0 },
          { x: touchX + offset, y: y2, id: 1 },
        ],
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    return { tabId: tid, action: "pinch", center: { x: touchX, y: touchY }, scale: pinchScale };
  }

  throw new Error(`Unknown touch action: ${action}. Use "tap", "swipe", "long-press", or "pinch".`);
}

// --- Device Emulation ---

async function handleEmulate({ action, width, height, deviceScaleFactor, isMobile, hasTouch, userAgent, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  if (action === "clear") {
    await sendDebuggerCommand(tid, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    await sendDebuggerCommand(tid, "Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    await sendDebuggerCommand(tid, "Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {});
    currentEmulation = null;
    return { tabId: tid, emulation: "cleared" };
  }

  if (width && height) {
    const metrics = {
      width,
      height,
      deviceScaleFactor: deviceScaleFactor || 1,
      mobile: isMobile || false,
    };
    await sendDebuggerCommand(tid, "Emulation.setDeviceMetricsOverride", metrics);
    currentEmulation = metrics; // Track for screenshot restore
  }

  if (hasTouch !== undefined) {
    await sendDebuggerCommand(tid, "Emulation.setTouchEmulationEnabled", {
      enabled: !!hasTouch,
    });
  }

  if (userAgent) {
    await sendDebuggerCommand(tid, "Emulation.setUserAgentOverride", { userAgent });
  }

  return {
    tabId: tid,
    emulation: {
      width,
      height,
      deviceScaleFactor: deviceScaleFactor || 1,
      mobile: isMobile || false,
      touch: !!hasTouch,
      userAgent: userAgent || null,
    },
  };
}

// --- Download Handling ---

async function handleDownload({ action, timeout }) {
  if (action === "list") {
    const items = await chrome.downloads.search({ limit: 20, orderBy: ["-startTime"] });
    return {
      downloads: items.map((d) => ({
        id: d.id,
        filename: d.filename,
        url: d.url,
        state: d.state,
        totalBytes: d.totalBytes,
        bytesReceived: d.bytesReceived,
        startTime: d.startTime,
        endTime: d.endTime,
        mime: d.mime,
      })),
    };
  }

  if (action === "wait") {
    const maxWait = Math.min(timeout || 30000, 120000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(`No download completed within ${maxWait / 1000}s`));
      }, maxWait);

      function listener(delta) {
        if (delta.state && delta.state.current === "complete") {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(listener);
          chrome.downloads.search({ id: delta.id }, (items) => {
            if (items && items.length > 0) {
              resolve({
                id: items[0].id,
                filename: items[0].filename,
                url: items[0].url,
                totalBytes: items[0].totalBytes,
                mime: items[0].mime,
              });
            } else {
              resolve({ id: delta.id });
            }
          });
        }
      }
      chrome.downloads.onChanged.addListener(listener);
    });
  }

  if (action === "latest") {
    const items = await chrome.downloads.search({ limit: 1, orderBy: ["-startTime"], state: "complete" });
    if (items.length === 0) throw new Error("No completed downloads found");
    return {
      id: items[0].id,
      filename: items[0].filename,
      url: items[0].url,
      totalBytes: items[0].totalBytes,
      mime: items[0].mime,
    };
  }

  throw new Error(`Unknown download action: ${action}. Use "list", "wait", or "latest".`);
}

// ============================================================================
// Debugger Helpers
// ============================================================================

async function ensureDebugger(tabId) {
  if (debuggerAttached.has(tabId)) return;
  // Serialize concurrent attachment attempts for same tab
  if (debuggerPending.has(tabId)) return debuggerPending.get(tabId);

  const promise = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (err) {
      // Handle SW restart where debugger is already attached from prior lifecycle
      if (!err.message?.includes("Already attached")) throw err;
    }
    debuggerAttached.add(tabId);
    // Enable Runtime for frame context tracking, Page for dialog events
    await sendDebuggerCommand(tabId, "Runtime.enable").catch(() => {});
    await sendDebuggerCommand(tabId, "Page.enable").catch(() => {});
  })();

  debuggerPending.set(tabId, promise);
  try {
    await promise;
  } finally {
    debuggerPending.delete(tabId);
  }
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
  // Average all 4 corners for correct center even with CSS transforms
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
}

/**
 * Deep element query — pierces shadow DOM and same-origin iframes.
 * Returns viewport-relative coordinates of the element center.
 */
async function resolveElementCoords(tabId, selector) {
  await ensureDebugger(tabId);
  const result = await sendDebuggerCommand(tabId, "Runtime.evaluate", {
    expression: `(function() {
      function deepQuery(sel) {
        let el = document.querySelector(sel);
        if (el) return el;
        function searchShadow(root) {
          for (const node of root.querySelectorAll("*")) {
            if (node.shadowRoot) {
              const found = node.shadowRoot.querySelector(sel);
              if (found) return found;
              const deep = searchShadow(node.shadowRoot);
              if (deep) return deep;
            }
          }
          return null;
        }
        el = searchShadow(document);
        if (el) return el;
        for (const iframe of document.querySelectorAll("iframe")) {
          try {
            if (iframe.contentDocument) {
              const found = iframe.contentDocument.querySelector(sel);
              if (found) return found;
            }
          } catch {}
        }
        return null;
      }
      const el = deepQuery(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      let x = rect.x + rect.width / 2;
      let y = rect.y + rect.height / 2;
      let frame = el.ownerDocument.defaultView?.frameElement;
      while (frame) {
        const fRect = frame.getBoundingClientRect();
        x += fRect.x;
        y += fRect.y;
        frame = frame.ownerDocument.defaultView?.frameElement;
      }
      return { x, y };
    })()`,
    returnByValue: true,
  });
  if (!result.result?.value) throw new Error(`Element not found (deep): ${selector}`);
  return result.result.value;
}

// ============================================================================
// Agent Activity Indicator
// ============================================================================

function showAgentIndicator(tabId) {
  const count = (activeTabCommands.get(tabId) || 0) + 1;
  activeTabCommands.set(tabId, count);
  if (count === 1) {
    chrome.tabs.sendMessage(tabId, { type: "show-agent-overlay" }).catch(() => {});
  }
}

function hideAgentIndicator(tabId) {
  const count = Math.max(0, (activeTabCommands.get(tabId) || 0) - 1);
  activeTabCommands.set(tabId, count);
  if (count === 0) {
    activeTabCommands.delete(tabId);
    chrome.tabs.sendMessage(tabId, { type: "hide-agent-overlay" }).catch(() => {});
  }
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

// Clean up all state on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerAttached.delete(tabId);
  activeTabCommands.delete(tabId);
  pendingDialogs.delete(tabId);
  for (const key of frameContexts.keys()) {
    if (key.startsWith(`${tabId}:`)) frameContexts.delete(key);
  }
});
