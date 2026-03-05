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
const tabEmulation = new Map(); // tabId -> {metrics, hasTouch, userAgent} for screenshot restore
const pendingAuth = new Map(); // requestId -> { tabId, url, scheme, realm }
const pendingAuthByTab = new Map(); // tabId -> Set<requestId>  (for status lookup)
const recentDownloads = []; // Recent download events (from CDP Browser.downloadWillBegin), max 20

// Clean up debugger state on detach (registered once at module scope)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    debuggerAttached.delete(source.tabId);
    pendingDialogs.delete(source.tabId);
    pendingFileChoosers.delete(source.tabId);
    tabEmulation.delete(source.tabId);
    // Clean up auth state for detached tab
    const reqIds = pendingAuthByTab.get(source.tabId);
    if (reqIds) {
      for (const rid of reqIds) pendingAuth.delete(rid);
      pendingAuthByTab.delete(source.tabId);
    }
    // Invalidate stale frame contexts
    for (const key of frameContexts.keys()) {
      if (key.startsWith(`${source.tabId}:`)) frameContexts.delete(key);
    }
  }
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
    const config = await chrome.storage.local.get(["serverUrl", "extensionId", "authToken"]);
    if (config.serverUrl || config.extensionId) {
      setTimeout(() => {
        chrome.runtime
          .sendMessage({
            type: "reconnect",
            url: config.serverUrl,
            extensionId: config.extensionId,
            token: config.authToken || undefined,
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
    case "mouse_move":
      return handleMouseMove(params);
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
    case "auth":
      return handleAuth(params);
    case "permissions":
      return handlePermissions(params);
    case "store":
      return handleStore(params);
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
  const preNavTs = Date.now();
  await waitForTab(tab.id, waitFor || "load");
  tab = await chrome.tabs.get(tab.id);

  const result = { tabId: tab.id, url: tab.url, title: tab.title };
  // Check if navigation triggered a file download (use preNavTs to cover the entire wait window)
  const dl = consumeRecentDownload(tab.id, Date.now() - preNavTs + 2000);
  if (dl)
    result.download_triggered = {
      url: dl.url,
      filename: dl.suggestedFilename,
      hint: "A file download was triggered. Use browser_download action=wait to capture it.",
    };
  return result;
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
        // Restore active emulation for this specific tab, otherwise clear
        const emu = tabEmulation.get(tid);
        if (emu?.metrics) {
          await sendDebuggerCommand(tid, "Emulation.setDeviceMetricsOverride", emu.metrics).catch(() => {});
          if (emu.hasTouch !== undefined) {
            await sendDebuggerCommand(tid, "Emulation.setTouchEmulationEnabled", {
              enabled: emu.hasTouch,
            }).catch(() => {});
          }
          if (emu.userAgent) {
            await sendDebuggerCommand(tid, "Emulation.setUserAgentOverride", {
              userAgent: emu.userAgent,
            }).catch(() => {});
          }
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

async function handleClick({ selector, x, y, tabId, button, clickCount: count, pierce, intercept_file_chooser }) {
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

  // Enable file chooser interception on-demand (only when agent expects an upload dialog)
  if (intercept_file_chooser) {
    pendingFileChoosers.delete(tid); // clear any stale entry
    await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
  }

  try {
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

    showActionCursor(tid, clickX, clickY);
    // Brief delay to let download/file-chooser events propagate from CDP
    await new Promise((r) => setTimeout(r, 300));
    const dl = consumeRecentDownload(tid);
    const result = { tabId: tid, element: selector || `(${clickX},${clickY})` };
    if (dl)
      result.download_triggered = {
        url: dl.url,
        filename: dl.suggestedFilename,
        hint: "A file download was triggered. Use browser_download action=wait to capture it.",
      };
    // Check if a file chooser dialog was intercepted (only possible when intercept_file_chooser was set)
    if (intercept_file_chooser && pendingFileChoosers.has(tid)) {
      const fc = pendingFileChoosers.get(tid);
      result.file_chooser_opened = {
        mode: fc.mode,
        hint: "A file chooser dialog was intercepted. Use browser_upload_file with file_id to provide the file. No selector needed.",
      };
    } else if (intercept_file_chooser) {
      // No file chooser was triggered — disable interception to avoid interfering with future dialogs
      await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
    return result;
  } catch (err) {
    // Clean up interception state on error to prevent leaking
    if (intercept_file_chooser) {
      pendingFileChoosers.delete(tid);
      await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
    throw err;
  }
}

// --- Type ---

async function handleType({ text, selector, tabId, clearFirst, pressEnter, pierce }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let actionCoords = null;
  if (selector) {
    // Focus the element first
    const coords = pierce ? await resolveElementCoords(tid, selector) : await getElementCenter(tid, selector);
    actionCoords = coords;
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

  if (actionCoords) showActionCursor(tid, actionCoords.x, actionCoords.y);
  return { tabId: tid, element: selector || "(focused)" };
}

// --- Extract ---

async function handleExtract({ mode, selector, tabId, frameId }) {
  const tid = tabId || (await getActiveTabId());

  if (mode === "accessibility") {
    await ensureDebugger(tid);
    const result = await sendDebuggerCommand(tid, "Accessibility.getFullAXTree");
    // Filter meaningful nodes first, then truncate
    const nodes = [];
    for (const n of result.nodes || []) {
      const name = n.name?.value;
      const value = n.value?.value;
      if (name || value) {
        nodes.push({ role: n.role?.value, name, value });
        if (nodes.length >= 500) break;
      }
    }
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
  if (action === "close") {
    if (!tabId) throw new Error("tabId is required for close action");
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  }
  if (action === "activate") {
    if (!tabId) throw new Error("tabId is required for activate action");
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
    timeout: 30000,
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

  // Default to viewport center if no position specified
  let scrollX = x ?? 0;
  let scrollY = y ?? 0;
  if (!selector && x === undefined && y === undefined) {
    // Get viewport size for centering
    const layout = await sendDebuggerCommand(tid, "Page.getLayoutMetrics").catch(() => null);
    if (layout?.cssVisualViewport) {
      scrollX = Math.round(layout.cssVisualViewport.clientWidth / 2);
      scrollY = Math.round(layout.cssVisualViewport.clientHeight / 2);
    }
  }

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

  showActionCursor(tid, scrollX, scrollY);

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

  showActionCursor(tid, hoverX, hoverY);
  return { tabId: tid, element: selector || `(${hoverX},${hoverY})` };
}

// --- Mouse Move ---

async function handleMouseMove({ x, y, tabId, steps }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  if (x === undefined || y === undefined) {
    throw new Error("mouse_move requires both 'x' and 'y' coordinates");
  }

  const numSteps = Math.max(1, steps || 1);
  // CDP doesn't track cursor position, so multi-step interpolation
  // uses small offsets approaching the target to generate mousemove events
  for (let i = 1; i <= numSteps; i++) {
    const ratio = i / numSteps;
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      // For single step, jump directly to target
      // For multi-step, approach from slight offset to generate events
      x: numSteps === 1 ? x : Math.round(x + (1 - ratio) * -20),
      y: numSteps === 1 ? y : Math.round(y + (1 - ratio) * -10),
    });
    if (numSteps > 1 && i < numSteps) await new Promise((r) => setTimeout(r, 10));
  }

  // Final position is always exact target
  if (numSteps > 1) {
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
  }

  showActionCursor(tid, x, y);
  return { tabId: tid, position: { x, y }, steps: numSteps };
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

  showActionCursor(tid, startX, startY);
  // Release at end
  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: endX,
    y: endY,
    button: "left",
    clickCount: 1,
  });

  showActionCursor(tid, endX, endY);
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

      const rect = el.getBoundingClientRect();
      el.value = option.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        selected: option.value,
        text: option.text,
        index: option.index,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      };
    },
    args: [selector, value ?? null, text ?? null, index ?? null],
  });
  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  if (result?.x != null && result?.y != null) showActionCursor(tid, result.x, result.y);
  const { x: _x, y: _y, ...rest } = result;
  return { tabId: tid, ...rest };
}

// --- Dialog Handling (alert/confirm/prompt) ---

const pendingDialogs = new Map(); // tabId -> { type, message, defaultPrompt }
const pendingFileChoosers = new Map(); // tabId -> { backendNodeId, mode }

// Listen for JavaScript dialogs and frame execution contexts
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Page.javascriptDialogOpening" && source.tabId) {
    pendingDialogs.set(source.tabId, {
      type: params.type,
      message: params.message,
      defaultPrompt: params.defaultPrompt,
    });
  }
  // Track download events (from Browser.setDownloadBehavior eventsEnabled)
  if (method === "Browser.downloadWillBegin" && source.tabId) {
    recentDownloads.push({
      tabId: source.tabId,
      guid: params.guid,
      url: params.url,
      suggestedFilename: params.suggestedFilename,
      timestamp: Date.now(),
    });
    if (recentDownloads.length > 20) recentDownloads.shift();
  }
  // Track download completion via CDP (more reliable than chrome.downloads for blob: URLs)
  if (method === "Browser.downloadProgress" && params.state === "completed") {
    const rd = recentDownloads.find((d) => d.guid === params.guid);
    if (rd) rd.cdpCompleted = true;
  }
  // Track file chooser dialogs (intercepted by Page.setInterceptFileChooserDialog)
  if (method === "Page.fileChooserOpened" && source.tabId) {
    pendingFileChoosers.set(source.tabId, {
      backendNodeId: params.backendNodeId,
      mode: params.mode, // "selectSingle" or "selectMultiple"
      frameId: params.frameId,
      timestamp: Date.now(),
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
    // Clear stale file chooser interception on navigation (interception is per-session, survives nav)
    if (pendingFileChoosers.has(source.tabId)) {
      pendingFileChoosers.delete(source.tabId);
      sendDebuggerCommand(source.tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
  }
  // Track HTTP authentication requests (keyed by requestId to avoid blocking other requests)
  if (method === "Fetch.authRequired" && source.tabId) {
    const rid = params.requestId;
    pendingAuth.set(rid, {
      tabId: source.tabId,
      url: params.request?.url,
      scheme: params.authChallenge?.scheme,
      realm: params.authChallenge?.realm,
    });
    if (!pendingAuthByTab.has(source.tabId)) pendingAuthByTab.set(source.tabId, new Set());
    pendingAuthByTab.get(source.tabId).add(rid);
    // Auto-cancel after 60s to prevent indefinite hangs
    setTimeout(() => {
      if (pendingAuth.has(rid)) {
        sendDebuggerCommand(source.tabId, "Fetch.continueWithAuth", {
          requestId: rid,
          authChallengeResponse: { response: "CancelAuth" },
        }).catch(() => {});
        pendingAuth.delete(rid);
        const tabSet = pendingAuthByTab.get(source.tabId);
        if (tabSet) {
          tabSet.delete(rid);
          if (tabSet.size === 0) pendingAuthByTab.delete(source.tabId);
        }
      }
    }, 60000);
  }
  // Auto-continue non-auth paused requests. Skip auth requests (401/407 — will be handled via Fetch.authRequired).
  if (method === "Fetch.requestPaused" && source.tabId) {
    const code = params.responseStatusCode;
    if (code !== 401 && code !== 407) {
      sendDebuggerCommand(source.tabId, "Fetch.continueRequest", {
        requestId: params.requestId,
      }).catch(() => {});
    } else {
      // If Fetch.authRequired doesn't fire within 2s, this is a non-challenge 401/407 (e.g. API response).
      // Continue the request to avoid hanging forever.
      const rid = params.requestId;
      const tabId = source.tabId;
      setTimeout(() => {
        if (!pendingAuth.has(rid)) {
          sendDebuggerCommand(tabId, "Fetch.continueRequest", {
            requestId: rid,
          }).catch(() => {});
        }
      }, 2000);
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

// Helper: JS function injected into page to set a file on an input element via DataTransfer
const SET_FILE_JS = `function(base64, fileName, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], fileName, { type: mimeType });
  const dt = new DataTransfer();
  dt.items.add(file);
  this.files = dt.files;
  this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  return fileName;
}`;

async function handleFileUpload({ selector, fileId, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  // Track whether a pending file chooser exists at entry — needed for cleanup on early errors
  const hadPendingFC = pendingFileChoosers.has(tid);
  try {
    if (!fileId) throw new Error("fileId is required");

    // Fetch file binary from chat server
    const { baseUrl, authToken } = await getServerBaseUrl();
    const fileUrl = `${baseUrl}/browser/files/${fileId}` + (authToken ? `?token=${encodeURIComponent(authToken)}` : "");
    let resp;
    try {
      resp = await fetch(fileUrl);
    } catch (err) {
      throw new Error(`Failed to reach file server: ${err.message}`);
    }
    if (!resp.ok) throw new Error(`File server returned ${resp.status} for fileId: ${fileId}`);
    let blob;
    try {
      blob = await resp.blob();
    } catch (err) {
      throw new Error(`Failed to download file data: ${err.message}`);
    }
    const contentDisposition = resp.headers.get("Content-Disposition") || "";
    const nameMatch = contentDisposition.match(/filename="([^"]+)"/);
    const fileName = nameMatch ? nameMatch[1] : `upload_${fileId}`;
    const mimeType = blob.type || "application/octet-stream";

    // Guard against large files that would OOM the service worker during base64 encoding
    const MAX_INJECT_SIZE = 25 * 1024 * 1024; // 25 MiB practical limit for base64 injection
    if (blob.size > MAX_INJECT_SIZE) {
      throw new Error(
        `File too large for browser upload (${(blob.size / 1024 / 1024).toFixed(1)} MiB). Max ${MAX_INJECT_SIZE / 1024 / 1024} MiB.`,
      );
    }

    // Convert to base64 for injection into page context (avoids chrome.downloads entirely)
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const parts = [];
    const chunkSize = 32768; // 32KB — safe for String.fromCharCode.apply (V8 limit ~65K args)
    for (let i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    const base64 = btoa(parts.join(""));

    // If a file chooser dialog is pending (from a click with intercept_file_chooser), resolve its element
    const pendingFC = pendingFileChoosers.get(tid);
    if (pendingFC) {
      pendingFileChoosers.delete(tid);
      try {
        // Resolve backendNodeId to a JS object reference
        const resolved = await sendDebuggerCommand(tid, "DOM.resolveNode", {
          backendNodeId: pendingFC.backendNodeId,
        });
        if (!resolved?.object?.objectId) throw new Error("Could not resolve file input element from file chooser");
        const callResult = await sendDebuggerCommand(tid, "Runtime.callFunctionOn", {
          objectId: resolved.object.objectId,
          functionDeclaration: SET_FILE_JS,
          arguments: [{ value: base64 }, { value: fileName }, { value: mimeType }],
          returnByValue: true,
        });
        if (callResult?.exceptionDetails) {
          throw new Error(
            callResult.exceptionDetails.exception?.description ||
              callResult.exceptionDetails.text ||
              "File injection failed in page context",
          );
        }
      } finally {
        // Always disable interception, even on error, to prevent leaking state
        await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      }
    } else if (selector) {
      // Direct selector approach — find the input and set files via JS DataTransfer
      const doc = await sendDebuggerCommand(tid, "DOM.getDocument");
      const node = await sendDebuggerCommand(tid, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      });
      if (!node.nodeId) throw new Error(`File input not found: ${selector}`);
      const resolved = await sendDebuggerCommand(tid, "DOM.resolveNode", { nodeId: node.nodeId });
      if (!resolved?.object?.objectId) throw new Error(`Could not resolve file input: ${selector}`);
      const callResult = await sendDebuggerCommand(tid, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: SET_FILE_JS,
        arguments: [{ value: base64 }, { value: fileName }, { value: mimeType }],
        returnByValue: true,
      });
      if (callResult?.exceptionDetails) {
        throw new Error(
          callResult.exceptionDetails.exception?.description ||
            callResult.exceptionDetails.text ||
            "File injection failed in page context",
        );
      }
    } else {
      throw new Error(
        "No pending file chooser and no selector provided. Click the upload button with intercept_file_chooser=true first, then call browser_upload_file.",
      );
    }

    return { tabId: tid, selector: selector || "(file chooser)", fileId, fileName };
  } catch (err) {
    // Clean up file chooser interception state if an early error occurred before the pendingFC branch handled it
    if (hadPendingFC && pendingFileChoosers.has(tid)) {
      pendingFileChoosers.delete(tid);
      await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
    throw err;
  }
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
    showActionCursor(tid, touchX, touchY);
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
    showActionCursor(tid, touchX, touchY);
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
    showActionCursor(tid, touchX, touchY);
    return { tabId: tid, action: "long-press", x: touchX, y: touchY, duration: holdMs };
  }

  if (action === "pinch") {
    const pinchScale = scale ?? 0.5;
    const halfGap = 50; // initial half-distance between fingers
    const centerX = touchX + halfGap;
    const centerY = touchY;
    const steps = 10;

    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: centerX - halfGap, y: centerY, id: 0 },
        { x: centerX + halfGap, y: centerY, id: 1 },
      ],
    });

    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      const currentHalf = halfGap * (1 + (pinchScale - 1) * ratio);
      await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: centerX - currentHalf, y: centerY, id: 0 },
          { x: centerX + currentHalf, y: centerY, id: 1 },
        ],
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    showActionCursor(tid, centerX, centerY);
    return { tabId: tid, action: "pinch", center: { x: centerX, y: centerY }, scale: pinchScale };
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
    tabEmulation.delete(tid);
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
    tabEmulation.set(tid, { metrics });
  }

  if (hasTouch !== undefined) {
    await sendDebuggerCommand(tid, "Emulation.setTouchEmulationEnabled", {
      enabled: !!hasTouch,
    });
    const emu = tabEmulation.get(tid);
    if (emu) emu.hasTouch = !!hasTouch;
  }

  if (userAgent) {
    await sendDebuggerCommand(tid, "Emulation.setUserAgentOverride", { userAgent });
    const emu = tabEmulation.get(tid);
    if (emu) emu.userAgent = userAgent;
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

const MAX_BROWSER_FILE_BYTES = 500 * 1024 * 1024; // 500 MiB

async function getServerBaseUrl() {
  const config = await chrome.storage.local.get(["serverUrl", "authToken"]);
  const wsUrl = config.serverUrl || "ws://localhost:3456/browser/ws";
  // Convert ws:// to http://, wss:// to https://, strip path
  const httpUrl = wsUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/browser\/ws.*$/, "");
  return { baseUrl: httpUrl, authToken: config.authToken || null };
}

async function uploadFileToChatServer(filePath, mime) {
  const { baseUrl, authToken } = await getServerBaseUrl();
  const uploadUrl = `${baseUrl}/browser/files/upload` + (authToken ? `?token=${encodeURIComponent(authToken)}` : "");

  // Route through offscreen document — MV3 service workers cannot fetch file:// URLs
  await ensureOffscreen();

  // Try primary path first, then .crdownload fallback (for stuck blob: downloads)
  let resp = await chrome.runtime.sendMessage({
    type: "upload-file",
    filePath,
    mime: mime || "application/octet-stream",
    uploadUrl,
  });

  if (!resp || !resp.ok) {
    // Fallback: try the .crdownload path (Chrome's temp download file extension)
    // This handles downloads stuck in "in_progress" where all bytes are received but
    // Chrome hasn't finalized the file (common with blob:null URLs from sites like Gemini)
    const crdownloadPath = filePath + ".crdownload";
    const fallbackResp = await chrome.runtime.sendMessage({
      type: "upload-file",
      filePath: crdownloadPath,
      mime: mime || "application/octet-stream",
      uploadUrl,
    });
    if (fallbackResp?.ok) {
      resp = fallbackResp;
    } else {
      throw new Error(resp?.error || "Upload via offscreen failed");
    }
  }

  const result = resp.result;
  if (!result.ok) throw new Error(result.error || "Upload failed");
  return result.file;
}

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
    const downloadInfo = await new Promise((resolve, reject) => {
      // First check for downloads that already completed recently (within 10s)
      chrome.downloads.search({ limit: 5, orderBy: ["-startTime"] }, (items) => {
        const now = Date.now();
        const recent = items?.find((d) => {
          if (d.state === "complete" && d.endTime) {
            const endTs = new Date(d.endTime).getTime();
            return now - endTs < 10000;
          }
          return false;
        });
        if (recent) {
          resolve(recent);
          return;
        }

        // Check for stuck downloads (all bytes received but state still in_progress, e.g. blob: URLs)
        const stuck = items?.find(
          (d) => d.state === "in_progress" && d.totalBytes > 0 && d.bytesReceived >= d.totalBytes,
        );
        if (stuck) {
          // Brief poll — give Chrome a chance to finalize before resolving with stuck state
          let pollCount = 0;
          const pollTimer = setInterval(() => {
            pollCount++;
            chrome.downloads.search({ id: stuck.id }, (updated) => {
              if (updated?.[0]?.state === "complete") {
                clearInterval(pollTimer);
                resolve(updated[0]);
              } else if (pollCount >= 10) {
                // 5 seconds — download is truly stuck (common for blob:null URLs)
                clearInterval(pollTimer);
                resolve({ ...stuck, _stuck: true });
              }
            });
          }, 500);
          return;
        }

        // No recent completion found — listen for future events
        const timer = setTimeout(() => {
          chrome.downloads.onChanged.removeListener(listener);
          // Last-resort: check for completed or stuck downloads
          chrome.downloads.search({ limit: 5, orderBy: ["-startTime"] }, (final) => {
            const completed = final?.find(
              (d) => d.state === "complete" && d.endTime && Date.now() - new Date(d.endTime).getTime() < maxWait + 5000,
            );
            if (completed) {
              resolve(completed);
              return;
            }
            // Also check for stuck downloads at timeout
            const stuckAtEnd = final?.find(
              (d) => d.state === "in_progress" && d.totalBytes > 0 && d.bytesReceived >= d.totalBytes,
            );
            if (stuckAtEnd) {
              resolve({ ...stuckAtEnd, _stuck: true });
              return;
            }
            reject(new Error(`No download completed within ${maxWait / 1000}s`));
          });
        }, maxWait);

        function listener(delta) {
          if (delta.state && delta.state.current === "complete") {
            clearTimeout(timer);
            chrome.downloads.onChanged.removeListener(listener);
            chrome.downloads.search({ id: delta.id }, (found) => {
              if (found && found.length > 0) {
                resolve(found[0]);
              } else {
                resolve({ id: delta.id });
              }
            });
          }
        }
        chrome.downloads.onChanged.addListener(listener);
      });
    });
    // Auto-upload to chat server
    if (downloadInfo.filename) {
      try {
        const file = await uploadFileToChatServer(downloadInfo.filename, downloadInfo.mime);
        return {
          file_id: file.id,
          filename: file.name,
          mime: downloadInfo.mime,
          size: file.size,
          source_url: downloadInfo.url,
        };
      } catch (uploadErr) {
        return {
          filename: downloadInfo.filename,
          url: downloadInfo.url,
          mime: downloadInfo.mime,
          totalBytes: downloadInfo.totalBytes,
          upload_error: uploadErr.message,
        };
      }
    }
    return downloadInfo;
  }

  if (action === "latest") {
    // Only consider downloads from the last 5 minutes
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    let items = await chrome.downloads.search({
      limit: 1,
      orderBy: ["-startTime"],
      state: "complete",
      startedAfter: fiveMinAgo,
    });
    if (items.length === 0) throw new Error("No recent completed downloads found (within last 5 minutes)");
    const item = items[0];
    // Auto-upload to chat server
    try {
      const file = await uploadFileToChatServer(item.filename, item.mime);
      return { file_id: file.id, filename: file.name, mime: item.mime, size: file.size, source_url: item.url };
    } catch (uploadErr) {
      return {
        filename: item.filename,
        url: item.url,
        mime: item.mime,
        totalBytes: item.totalBytes,
        upload_error: uploadErr.message,
      };
    }
  }

  throw new Error(`Unknown download action: ${action}. Use "list", "wait", or "latest".`);
}

// --- HTTP Authentication ---

async function handleAuth({ action, username, password, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  if (action === "status") {
    const reqIds = pendingAuthByTab.get(tid);
    if (!reqIds || reqIds.size === 0) return { tabId: tid, pending: false };
    // Return first pending auth request
    const rid = reqIds.values().next().value;
    const auth = pendingAuth.get(rid);
    return { tabId: tid, pending: true, request_id: rid, url: auth?.url, scheme: auth?.scheme, realm: auth?.realm };
  }

  if (action === "provide") {
    const reqIds = pendingAuthByTab.get(tid);
    if (!reqIds || reqIds.size === 0) throw new Error("No pending auth request on this tab");
    const rid = reqIds.values().next().value;
    const auth = pendingAuth.get(rid);
    // Remove BEFORE awaiting to prevent timeout from double-continuing
    pendingAuth.delete(rid);
    reqIds.delete(rid);
    if (reqIds.size === 0) pendingAuthByTab.delete(tid);
    await sendDebuggerCommand(tid, "Fetch.continueWithAuth", {
      requestId: rid,
      authChallengeResponse: {
        response: "ProvideCredentials",
        username: username || "",
        password: password || "",
      },
    });
    return { tabId: tid, authenticated: true, url: auth?.url };
  }

  if (action === "cancel") {
    const reqIds = pendingAuthByTab.get(tid);
    if (!reqIds || reqIds.size === 0) throw new Error("No pending auth request on this tab");
    const rid = reqIds.values().next().value;
    // Remove BEFORE awaiting to prevent timeout from double-continuing
    pendingAuth.delete(rid);
    reqIds.delete(rid);
    if (reqIds.size === 0) pendingAuthByTab.delete(tid);
    await sendDebuggerCommand(tid, "Fetch.continueWithAuth", {
      requestId: rid,
      authChallengeResponse: { response: "CancelAuth" },
    });
    return { tabId: tid, cancelled: true };
  }

  throw new Error(`Unknown auth action: ${action}. Use "status", "provide", or "cancel".`);
}

// --- Browser Permissions ---

async function handlePermissions({ action, permissions, origin, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  if (!permissions || !permissions.length) throw new Error("permissions array is required");

  // Resolve origin, guard against special URLs
  let permOrigin = origin;
  if (!permOrigin) {
    const tab = await chrome.tabs.get(tid);
    permOrigin = new URL(tab.url).origin;
  }
  // Validate origin regardless of source
  if (permOrigin === "null" || !/^https?:\/\//.test(permOrigin)) {
    throw new Error(`Invalid origin "${permOrigin}" — Browser.setPermission requires an http:// or https:// origin.`);
  }

  const setting = action === "grant" ? "granted" : action === "deny" ? "denied" : action === "reset" ? "prompt" : null;
  if (!setting) throw new Error(`Unknown permissions action: ${action}. Use "grant", "deny", or "reset".`);

  for (const perm of permissions) {
    await sendDebuggerCommand(tid, "Browser.setPermission", {
      permission: { name: perm },
      setting,
      origin: permOrigin,
    });
  }

  const resultKey = { grant: "granted", deny: "denied", reset: "reset" }[action];
  return { tabId: tid, [resultKey]: permissions, origin: permOrigin };
}

// --- Agent Script Storage (per-origin via localStorage) ---

async function handleStore({ action, key, value, description, tabId }) {
  const tid = tabId || (await getActiveTabId());
  // Guard against non-injectable pages (localStorage not available)
  const tab = await chrome.tabs.get(tid);
  if (tab.url && /^(chrome|devtools|edge|about):/.test(tab.url)) {
    throw new Error(`Cannot use store on ${tab.url.split(":")[0]}:// pages. Navigate to an http/https page first.`);
  }
  const NS = "__clawd_store__";
  const NS_META = "__clawd_store_meta__";

  if (action === "set") {
    if (!key) throw new Error("key is required for store set");
    if (value === undefined || value === null) throw new Error("value is required for store set");
    const results = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: (ns, nsMeta, k, v, desc) => {
        try {
          const store = JSON.parse(localStorage.getItem(ns) || "{}");
          store[k] = v;
          localStorage.setItem(ns, JSON.stringify(store));
          // Always sync metadata — clear stale description if none provided
          const meta = JSON.parse(localStorage.getItem(nsMeta) || "{}");
          if (desc) {
            meta[k] = desc;
          } else {
            delete meta[k];
          }
          localStorage.setItem(nsMeta, JSON.stringify(meta));
          return { stored: true, key: k };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [NS, NS_META, key, value, description || null],
    });
    const r = results[0]?.result;
    if (r?.error) throw new Error(`Store set failed: ${r.error}`);
    return { tabId: tid, ...r };
  }

  if (action === "get") {
    if (!key) throw new Error("key is required for store get");
    const results = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: (ns, k) => {
        try {
          const store = JSON.parse(localStorage.getItem(ns) || "{}");
          return { key: k, value: store[k] ?? null, found: k in store };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [NS, key],
    });
    const r = results[0]?.result;
    if (r?.error) throw new Error(`Store get failed: ${r.error}`);
    return { tabId: tid, ...r };
  }

  if (action === "list") {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: (ns, nsMeta) => {
        try {
          const store = JSON.parse(localStorage.getItem(ns) || "{}");
          const meta = JSON.parse(localStorage.getItem(nsMeta) || "{}");
          const keys = Object.keys(store);
          const items = keys.map((k) => {
            const val = store[k];
            const isScript = typeof val === "string" && /[;{}()=]|return |function |=>/.test(val);
            return {
              key: k,
              type: isScript ? "script" : typeof val,
              description: meta[k] || null,
              size: typeof val === "string" ? val.length : JSON.stringify(val).length,
            };
          });
          return { items, count: keys.length };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [NS, NS_META],
    });
    const r = results[0]?.result;
    if (r?.error) throw new Error(`Store list failed: ${r.error}`);
    let origin = "unknown";
    try {
      const tab = await chrome.tabs.get(tid);
      origin = new URL(tab.url).origin;
    } catch {
      /* tab closed or special URL — degrade gracefully */
    }
    return { tabId: tid, origin, ...r };
  }

  if (action === "delete") {
    if (!key) throw new Error("key is required for store delete");
    const results = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: (ns, nsMeta, k) => {
        try {
          const store = JSON.parse(localStorage.getItem(ns) || "{}");
          const existed = k in store;
          delete store[k];
          localStorage.setItem(ns, JSON.stringify(store));
          // Also remove metadata
          const meta = JSON.parse(localStorage.getItem(nsMeta) || "{}");
          delete meta[k];
          localStorage.setItem(nsMeta, JSON.stringify(meta));
          return { deleted: existed, key: k };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [NS, NS_META, key],
    });
    const r = results[0]?.result;
    if (r?.error) throw new Error(`Store delete failed: ${r.error}`);
    return { tabId: tid, ...r };
  }

  if (action === "clear") {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: (ns, nsMeta) => {
        try {
          localStorage.removeItem(ns);
          localStorage.removeItem(nsMeta);
          return { cleared: true };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [NS, NS_META],
    });
    const r = results[0]?.result;
    if (r?.error) throw new Error(`Store clear failed: ${r.error}`);
    return { tabId: tid, ...r };
  }

  throw new Error(`Unknown store action: ${action}. Use "set", "get", "list", "delete", or "clear".`);
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
    // Enable Runtime for frame context tracking, Page for dialog events, Fetch for HTTP auth
    await sendDebuggerCommand(tabId, "Runtime.enable").catch(() => {});
    await sendDebuggerCommand(tabId, "Page.enable").catch(() => {});
    await sendDebuggerCommand(tabId, "Fetch.enable", { handleAuthRequests: true }).catch(() => {});
    // Auto-accept downloads (suppresses Chrome's "Keep/Discard" confirmation popup)
    await sendDebuggerCommand(tabId, "Browser.setDownloadBehavior", {
      behavior: "allow",
      eventsEnabled: true,
    }).catch(() => {});
    // Note: File chooser interception is NOT enabled globally.
    // It's enabled on-demand via handleClick({ intercept_file_chooser: true })
    // to avoid intercepting save/download dialogs (e.g., showSaveFilePicker).
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

  // Ensure element is in viewport before reading coordinates
  await sendDebuggerCommand(tabId, "DOM.scrollIntoViewIfNeeded", { nodeId: node.nodeId }).catch(() => {});

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
    // Ensure content script is injected, then show overlay
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ["src/content-script.js"],
      })
      .catch(() => {}) // Already injected or restricted page
      .then(() => {
        chrome.tabs.sendMessage(tabId, { type: "show-agent-overlay" }).catch(() => {});
      });
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

/** Show animated Claw'd cursor at action position (fire-and-forget). */
function showActionCursor(tabId, x, y) {
  if (x === undefined || y === undefined) return;
  chrome.tabs.sendMessage(tabId, { type: "show-action-cursor", x, y }).catch(() => {});
}

/** Check if a download was triggered on this tab within the last N ms. Returns download info or null. */
function consumeRecentDownload(tabId, withinMs = 3000) {
  const cutoff = Date.now() - withinMs;
  const idx = recentDownloads.findIndex((d) => d.tabId === tabId && d.timestamp >= cutoff);
  if (idx === -1) return null;
  return recentDownloads.splice(idx, 1)[0];
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
  debuggerPending.delete(tabId);
  activeTabCommands.delete(tabId);
  pendingDialogs.delete(tabId);
  pendingFileChoosers.delete(tabId);
  tabEmulation.delete(tabId);
  // Clean up per-requestId auth entries for this tab
  const reqIds = pendingAuthByTab.get(tabId);
  if (reqIds) {
    for (const rid of reqIds) pendingAuth.delete(rid);
    pendingAuthByTab.delete(tabId);
  }
  for (const key of frameContexts.keys()) {
    if (key.startsWith(`${tabId}:`)) frameContexts.delete(key);
  }
  // Remove stale download records for closed tab
  for (let i = recentDownloads.length - 1; i >= 0; i--) {
    if (recentDownloads[i].tabId === tabId) recentDownloads.splice(i, 1);
  }
});
