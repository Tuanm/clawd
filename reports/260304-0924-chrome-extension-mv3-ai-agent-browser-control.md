# Research Report: Chrome Extension (MV3) for AI Agent Browser Control

## Executive Summary

Building a Chrome/Edge extension (Manifest V3) that lets an AI agent control the user's browser is **fully feasible** and is the **optimal approach** for the "agent controls YOUR browser" use case (vs headless Playwright/Selenium which runs a separate browser instance the user can't see).

The recommended architecture: **Extension (MV3) + `chrome.debugger` API (CDP) + WebSocket via Offscreen Document + Local Agent Server**. This gives full browser control (navigation, clicks, forms, screenshots, DOM access, network interception) while running in the user's actual browser session with their cookies, logins, and state.

**Key finding**: `chrome.debugger` is the most powerful API available to extensions — it exposes the full Chrome DevTools Protocol. The main tradeoff is UX: Chrome shows a yellow "debugging" infobar that cannot be suppressed. For agent-browser collaboration (not stealth), this is acceptable and arguably desirable as a consent signal.

**MV3's biggest challenge**: Service worker lifecycle (30s idle timeout kills it). Solved via Offscreen Document for persistent WebSocket connections + keep-alive heartbeats.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Chrome Extension MV3 APIs for Browser Control](#2-chrome-extension-mv3-apis)
3. [Chrome DevTools Protocol via chrome.debugger](#3-cdp-via-chrome-debugger)
4. [Communication: Extension ↔ Local Server](#4-communication-extension-local-server)
5. [Content Scripts & DOM Manipulation](#5-content-scripts-dom-manipulation)
6. [Screenshot & Vision Capabilities](#6-screenshot-vision-capabilities)
7. [Security Model & Permissions](#7-security-model-permissions)
8. [MV3 Limitations & Workarounds](#8-mv3-limitations-workarounds)
9. [Existing Open-Source Projects](#9-existing-open-source-projects)
10. [Performance Considerations](#10-performance-considerations)
11. [Recommended Implementation Approach](#11-recommended-implementation)
12. [Unresolved Questions](#12-unresolved-questions)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    USER'S BROWSER (Chrome/Edge)             │
│                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────┐  │
│  │  Content      │   │  Service      │   │  Offscreen    │  │
│  │  Script       │◄──┤  Worker       │◄──┤  Document     │  │
│  │  (per tab)    │   │  (background) │   │  (WebSocket)  │  │
│  └──────┬───────┘   └──────┬───────┘   └───────┬───────┘  │
│         │                   │                     │          │
│         │ DOM access        │ chrome.debugger     │ WS conn  │
│         │ JS injection      │ chrome.tabs         │          │
│         ▼                   │ chrome.scripting     │          │
│  ┌──────────────┐          │                      │          │
│  │  Web Page     │          │                      │          │
│  │  (user's tab) │◄─────────┘ CDP commands         │          │
│  └──────────────┘                                  │          │
│                                                     │          │
│  ┌──────────────────────┐                          │          │
│  │  Side Panel / Popup  │ (optional UI)            │          │
│  └──────────────────────┘                          │          │
└─────────────────────────────────────────────────────┼─────────┘
                                                      │
                                              WebSocket│
                                                      │
┌─────────────────────────────────────────────────────┼─────────┐
│                    LOCAL AGENT SERVER                │         │
│                                                     ▼         │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────┐    │
│  │  AI Model     │   │  Agent Loop   │   │  WebSocket    │    │
│  │  (LLM API)    │◄──┤  (planner)    │◄──┤  Server       │    │
│  └──────────────┘   └──────────────┘   └───────────────┘    │
│                                                               │
│  localhost:PORT                                               │
└───────────────────────────────────────────────────────────────┘
```

### Why This Architecture

| Approach | Controls user's browser? | Full CDP? | Session/cookies? | UX |
|----------|-------------------------|-----------|-------------------|-----|
| **Extension + chrome.debugger** | ✅ Yes | ✅ Yes | ✅ Yes | Yellow infobar |
| Extension + content scripts only | ✅ Yes | ❌ No | ✅ Yes | Clean |
| Playwright/Puppeteer (headless) | ❌ Separate instance | ✅ Yes | ❌ No (fresh) | None (invisible) |
| Playwright `connectOverCDP` | ⚠️ Requires `--remote-debugging-port` flag | ✅ Yes | ✅ Yes | Must restart browser |
| Native Messaging + external CDP | ⚠️ Must launch Chrome with debug flag | ✅ Yes | ✅ Yes | Must restart browser |

**Extension + chrome.debugger wins** because it's the only approach that:
1. Works in the user's existing browser session (no restart)
2. Has full CDP access
3. Preserves all cookies/logins/state
4. Requires only extension install (no CLI flags, no separate processes)

---

## 2. Chrome Extension MV3 APIs

### 2.1 `chrome.tabs`

Core tab management. No special permissions for basic queries.

```js
// Get active tab
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

// Navigate
await chrome.tabs.update(tab.id, { url: 'https://example.com' });

// Create new tab
const newTab = await chrome.tabs.create({ url: 'https://example.com' });

// Listen for tab events
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    console.log(`Tab ${tabId} finished loading: ${tab.url}`);
  }
});

// Capture visible tab as screenshot (requires <all_urls> or activeTab)
const dataUrl = await chrome.tabs.captureVisibleTab(null, {
  format: 'png',  // or 'jpeg'
  quality: 80      // jpeg only, 0-100
});
```

**Permissions**: `tabs` (for URL/title access), `activeTab` (for current tab actions on user gesture).

### 2.2 `chrome.scripting`

Execute scripts in web page context. Replaces MV2's `chrome.tabs.executeScript`.

```js
// Execute function in tab
const results = await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: () => {
    // This runs in the web page's context
    return document.title;
  }
});
console.log(results[0].result); // page title

// Execute with args
await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: (selector, value) => {
    const el = document.querySelector(selector);
    if (el) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
  },
  args: ['#email', 'user@example.com']
});

// Inject CSS
await chrome.scripting.insertCSS({
  target: { tabId: tab.id },
  css: '.agent-highlight { outline: 3px solid red !important; }'
});

// Execute in specific frames
await chrome.scripting.executeScript({
  target: { tabId: tab.id, frameIds: [0] }, // main frame
  func: () => { /* ... */ }
});

// World isolation: MAIN (page context) vs ISOLATED (content script context)
await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  world: 'MAIN', // access page's JS variables
  func: () => window.myAppState
});
```

**Permissions**: `scripting` + host permissions (`<all_urls>` or specific patterns).

### 2.3 `chrome.debugger`

**The crown jewel for agent control.** Attaches to a tab and sends arbitrary CDP commands.

```js
// Attach debugger to tab
await chrome.debugger.attach({ tabId: tab.id }, '1.3');

// Chrome shows yellow infobar: "[Extension] started debugging this browser"
// User can dismiss, which detaches. Cannot be suppressed.

// Send CDP command
const result = await chrome.debugger.sendCommand(
  { tabId: tab.id },
  'Runtime.evaluate',
  { expression: 'document.title' }
);

// Listen for CDP events
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Network.requestWillBeSent') {
    console.log('Request:', params.request.url);
  }
});

// Detach when done
await chrome.debugger.detach({ tabId: tab.id });

// Listen for detach (user dismissed infobar, tab closed, etc.)
chrome.debugger.onDetach.addListener((source, reason) => {
  console.log(`Debugger detached: ${reason}`);
  // reason: 'target_closed', 'canceled_by_user', 'replaced_with_devtools'
});
```

**Permissions**: `debugger` in manifest.

### 2.4 `chrome.sidePanel`

MV3 feature for persistent UI alongside the page. Ideal for agent chat/status.

```json
// manifest.json
{
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "permissions": ["sidePanel"]
}
```

```js
// Open side panel programmatically (requires user gesture)
await chrome.sidePanel.open({ windowId: window.id });
await chrome.sidePanel.setOptions({
  tabId: tab.id,
  path: 'sidepanel.html',
  enabled: true
});
```

### 2.5 `chrome.offscreen`

MV3 workaround for persistent DOM access (WebSocket, audio, clipboard, etc.).

```js
// Create offscreen document (from service worker)
await chrome.offscreen.createDocument({
  url: 'offscreen.html',
  reasons: ['WORKERS'],  // or 'WEB_RTC', 'DOM_PARSER', etc.
  justification: 'Maintain WebSocket connection to local agent server'
});
```

**Key constraint**: Only ONE offscreen document allowed at a time. It has DOM but no UI. Limited API access (no chrome.tabs, no chrome.debugger). Communicates with service worker via `chrome.runtime.sendMessage`.

---

## 3. CDP via chrome.debugger — Deep Dive

### 3.1 Available CDP Domains

Once attached, the extension can use virtually all CDP domains:

| Domain | Key Methods | Agent Use |
|--------|------------|-----------|
| **Page** | `navigate`, `captureScreenshot`, `getLayoutMetrics`, `reload` | Navigation, screenshots |
| **DOM** | `getDocument`, `querySelector`, `getOuterHTML`, `setAttributeValue` | DOM inspection/mutation |
| **Runtime** | `evaluate`, `callFunctionOn`, `getProperties` | JS execution |
| **Input** | `dispatchMouseEvent`, `dispatchKeyEvent`, `dispatchTouchEvent` | Clicks, typing, gestures |
| **Network** | `enable`, `setRequestInterception`, `getResponseBody` | Monitor/intercept requests |
| **Emulation** | `setDeviceMetricsOverride`, `setGeolocationOverride` | Viewport, device emulation |
| **CSS** | `getComputedStyleForNode`, `getMatchedStylesForNode` | Style inspection |
| **Accessibility** | `getFullAXTree`, `getPartialAXTree` | A11y tree for element discovery |
| **Overlay** | `highlightNode`, `highlightRect` | Visual feedback |
| **DOMSnapshot** | `captureSnapshot` | Full DOM + layout + style snapshot |

### 3.2 Core CDP Patterns

#### Screenshot
```js
async function captureScreenshot(tabId) {
  const { data } = await chrome.debugger.sendCommand(
    { tabId },
    'Page.captureScreenshot',
    {
      format: 'jpeg',
      quality: 70,
      fromSurface: true,
      // Optional: capture specific region
      // clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 }
    }
  );
  return data; // base64-encoded image
}

// Full-page screenshot (not just viewport)
async function captureFullPage(tabId) {
  const metrics = await chrome.debugger.sendCommand(
    { tabId }, 'Page.getLayoutMetrics', {}
  );
  const { contentSize } = metrics;
  
  // Override viewport to full page height
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
    width: Math.ceil(contentSize.width),
    height: Math.ceil(contentSize.height),
    deviceScaleFactor: 1,
    mobile: false,
  });
  
  const { data } = await chrome.debugger.sendCommand(
    { tabId }, 'Page.captureScreenshot', { format: 'png' }
  );
  
  // Reset viewport
  await chrome.debugger.sendCommand(
    { tabId }, 'Emulation.clearDeviceMetricsOverride', {}
  );
  
  return data;
}
```

#### Click Element by Coordinates
```js
async function clickAt(tabId, x, y) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1
  });
}
```

#### Click Element by Selector
```js
async function clickSelector(tabId, selector) {
  // Get DOM node
  const { root } = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {});
  const { nodeId } = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
    nodeId: root.nodeId, selector
  });
  
  // Get element's bounding box
  const { model } = await chrome.debugger.sendCommand({ tabId }, 'DOM.getBoxModel', { nodeId });
  const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
  const cx = (x1 + x3) / 2;
  const cy = (y1 + y3) / 2;
  
  // Scroll into view first
  await chrome.debugger.sendCommand({ tabId }, 'DOM.scrollIntoViewIfNeeded', { nodeId });
  
  await clickAt(tabId, cx, cy);
}
```

#### Type Text
```js
async function typeText(tabId, text) {
  for (const char of text) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown', text: char
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', text: char
    });
  }
}

// Or use insertText for faster bulk input
async function insertText(tabId, text) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
}
```

#### Fill Form Field
```js
async function fillField(tabId, selector, value) {
  // Focus the element
  const { root } = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {});
  const { nodeId } = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
    nodeId: root.nodeId, selector
  });
  await chrome.debugger.sendCommand({ tabId }, 'DOM.focus', { nodeId });
  
  // Select all existing text
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 // Ctrl
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2
  });
  
  // Insert new text
  await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: value });
}
```

#### Get Accessibility Tree (for element discovery)
```js
async function getAXTree(tabId) {
  const { nodes } = await chrome.debugger.sendCommand(
    { tabId }, 'Accessibility.getFullAXTree', {}
  );
  // Returns flat array of AXNodes with roles, names, descriptions
  // Much more useful for AI than raw DOM
  return nodes.filter(n => 
    n.role?.value !== 'none' && 
    n.role?.value !== 'generic' &&
    n.name?.value
  ).map(n => ({
    role: n.role?.value,
    name: n.name?.value,
    nodeId: n.backendDOMNodeId,
    bounds: n.location // {x, y, width, height}
  }));
}
```

#### Network Monitoring
```js
// Enable network monitoring
await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});

// Listen for events via chrome.debugger.onEvent
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== tabId) return;
  
  switch (method) {
    case 'Network.requestWillBeSent':
      console.log('→', params.request.method, params.request.url);
      break;
    case 'Network.responseReceived':
      console.log('←', params.response.status, params.response.url);
      break;
  }
});
```

#### DOM Snapshot (comprehensive page state)
```js
async function getPageSnapshot(tabId) {
  const snapshot = await chrome.debugger.sendCommand(
    { tabId }, 'DOMSnapshot.captureSnapshot', {
      computedStyles: ['display', 'visibility', 'opacity', 'color', 'font-size'],
      includePaintOrder: true,
      includeDOMRects: true,
    }
  );
  return snapshot; // Full DOM tree with computed styles and layout rects
}
```

---

## 4. Communication: Extension ↔ Local Server

### 4.1 Option Comparison

| Method | Persistent? | Bidirectional? | Latency | MV3 Compatible? | Complexity |
|--------|-------------|----------------|---------|-----------------|------------|
| **WebSocket (offscreen doc)** | ✅ | ✅ | ~1ms | ✅ | Medium |
| **Native Messaging** | ✅ | ✅ | ~5ms | ✅ | High (install) |
| HTTP polling (from SW) | ❌ | ❌ | 100ms+ | ⚠️ SW dies | Low |
| HTTP long-poll (offscreen) | ✅ | ⚠️ Half | ~10ms | ✅ | Medium |
| **WebSocket (from SW directly)** | ❌ | ✅ | ~1ms | ⚠️ **SW kills it** | Low |

### 4.2 Recommended: WebSocket via Offscreen Document

The offscreen document acts as a persistent WebSocket bridge, relaying messages between the local server and the service worker.

#### offscreen.html
```html
<!DOCTYPE html>
<script src="offscreen.js"></script>
```

#### offscreen.js
```js
let ws = null;
let reconnectTimer = null;
const WS_URL = 'ws://localhost:9222/agent'; // configurable

function connect() {
  if (ws?.readyState === WebSocket.OPEN) return;
  
  ws = new WebSocket(WS_URL);
  
  ws.onopen = () => {
    console.log('[Offscreen] WebSocket connected');
    clearTimeout(reconnectTimer);
    // Notify service worker
    chrome.runtime.sendMessage({ type: 'ws:connected' });
  };
  
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    // Forward to service worker
    chrome.runtime.sendMessage({ type: 'agent:command', payload: msg });
  };
  
  ws.onclose = () => {
    console.log('[Offscreen] WebSocket closed, reconnecting in 3s...');
    reconnectTimer = setTimeout(connect, 3000);
  };
  
  ws.onerror = (err) => {
    console.error('[Offscreen] WebSocket error:', err);
    ws.close();
  };
}

// Receive messages from service worker to send to server
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'agent:response') {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg.payload));
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'WebSocket not connected' });
    }
  }
  if (msg.type === 'ws:connect') {
    connect();
    sendResponse({ ok: true });
  }
  return true; // keep sendResponse alive for async
});

// Auto-connect on load
connect();
```

#### Service Worker (background.js)
```js
// Ensure offscreen document exists
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'WebSocket connection to local agent server'
    });
  }
}

// Handle commands from agent server (forwarded by offscreen doc)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'agent:command') {
    handleAgentCommand(msg.payload).then(result => {
      // Send result back through offscreen → WS → server
      chrome.runtime.sendMessage({
        type: 'agent:response',
        payload: { id: msg.payload.id, result }
      });
    });
  }
  return true;
});

async function handleAgentCommand(cmd) {
  switch (cmd.action) {
    case 'screenshot':
      return await captureScreenshot(cmd.tabId);
    case 'navigate':
      await chrome.tabs.update(cmd.tabId, { url: cmd.url });
      return { ok: true };
    case 'click':
      return await clickAt(cmd.tabId, cmd.x, cmd.y);
    case 'type':
      return await typeText(cmd.tabId, cmd.text);
    case 'evaluate':
      return await cdpEvaluate(cmd.tabId, cmd.expression);
    case 'getAXTree':
      return await getAXTree(cmd.tabId);
    case 'getTabs':
      return await chrome.tabs.query({});
    // ... more commands
  }
}

// Init on install/startup
chrome.runtime.onInstalled.addListener(ensureOffscreen);
chrome.runtime.onStartup.addListener(ensureOffscreen);
```

### 4.3 Alternative: Native Messaging

Higher reliability, harder to install. Requires a native host manifest + executable on the OS.

#### native-host-manifest.json (Chrome)
```json
{
  "name": "com.clawd.agent",
  "description": "Clawd AI Agent Bridge",
  "path": "/usr/local/bin/clawd-native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://EXTENSION_ID/"]
}
```

Installed at:
- **Linux**: `~/.config/google-chrome/NativeMessagingHosts/com.clawd.agent.json`
- **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.clawd.agent.json`
- **Windows**: Registry + file

#### Service Worker
```js
const port = chrome.runtime.connectNative('com.clawd.agent');

port.onMessage.addListener((msg) => {
  handleAgentCommand(msg);
});

port.onDisconnect.addListener(() => {
  console.log('Native host disconnected:', chrome.runtime.lastError?.message);
});

// Send response
port.postMessage({ id: cmd.id, result: data });
```

**Native host** is a process that reads/writes JSON over stdin/stdout (length-prefixed). Can be a Node.js script, Python script, or compiled binary that then communicates with the actual agent server.

**Verdict**: Native Messaging is more robust but requires OS-level installation. WebSocket via offscreen document is simpler for development and doesn't require platform-specific installers.

### 4.4 Service Worker Keep-Alive

The MV3 service worker sleeps after ~30s of inactivity. Critical to keep it alive during agent sessions.

```js
// Pattern 1: Periodic alarm (minimum 1 minute, Chrome 120+ supports 30s)
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // Service worker wakes up. Check offscreen doc exists.
    ensureOffscreen();
  }
});

// Pattern 2: Port-based keep-alive from offscreen document
// offscreen.js:
function keepAlive() {
  const port = chrome.runtime.connect({ name: 'keepalive' });
  port.onDisconnect.addListener(() => {
    // Port disconnects after 5 min. Reconnect.
    setTimeout(keepAlive, 1000);
  });
}
keepAlive();

// service-worker.js:
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    // Port connection keeps SW alive for up to 5 minutes
    // (300s, vs 30s idle timeout without port)
  }
});
```

---

## 5. Content Scripts & DOM Manipulation

### 5.1 Content Script Injection

Content scripts run in an **isolated world** — same DOM, separate JS globals. Cannot access page's `window` variables directly.

```json
// manifest.json
{
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }]
}
```

#### content.js — Agent DOM Helper
```js
// Listen for commands from service worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'getPageInfo':
      sendResponse({
        title: document.title,
        url: location.href,
        text: document.body.innerText.substring(0, 50000),
        links: [...document.querySelectorAll('a[href]')].map(a => ({
          text: a.textContent.trim(),
          href: a.href
        })).slice(0, 200),
        forms: [...document.querySelectorAll('input, textarea, select')].map(el => ({
          tag: el.tagName,
          type: el.type,
          name: el.name,
          id: el.id,
          placeholder: el.placeholder,
          value: el.value,
          selector: generateSelector(el)
        }))
      });
      break;

    case 'clickElement':
      const target = document.querySelector(msg.selector);
      if (target) {
        target.scrollIntoView({ behavior: 'instant', block: 'center' });
        target.click();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'Element not found' });
      }
      break;

    case 'fillField':
      const input = document.querySelector(msg.selector);
      if (input) {
        input.focus();
        input.value = msg.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        sendResponse({ ok: true });
      }
      break;

    case 'extractContent':
      sendResponse({
        html: document.documentElement.outerHTML,
        text: document.body.innerText,
        readableText: extractReadableContent()
      });
      break;
      
    case 'highlightElement':
      highlightElement(msg.selector);
      sendResponse({ ok: true });
      break;
  }
  return true;
});

// Generate unique CSS selector for an element
function generateSelector(el) {
  if (el.id) return `#${el.id}`;
  if (el.name) return `[name="${el.name}"]`;
  // Build path
  const path = [];
  while (el && el !== document.body) {
    let selector = el.tagName.toLowerCase();
    if (el.id) { path.unshift(`#${el.id}`); break; }
    const siblings = [...el.parentElement.children].filter(s => s.tagName === el.tagName);
    if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(el) + 1})`;
    path.unshift(selector);
    el = el.parentElement;
  }
  return path.join(' > ');
}

// Extract readable content (simplified readability)
function extractReadableContent() {
  const clone = document.cloneNode(true);
  ['script', 'style', 'noscript', 'iframe', 'svg'].forEach(tag => {
    clone.querySelectorAll(tag).forEach(el => el.remove());
  });
  return clone.body?.innerText || '';
}

// Visual highlight for agent actions
function highlightElement(selector) {
  document.querySelectorAll('.agent-highlight').forEach(el => el.classList.remove('agent-highlight'));
  const el = document.querySelector(selector);
  if (el) {
    el.classList.add('agent-highlight');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
```

### 5.2 Content Script vs CDP — When to Use Which

| Capability | Content Script | CDP (chrome.debugger) |
|------------|---------------|----------------------|
| Read DOM | ✅ | ✅ |
| Click elements | ✅ (JS click) | ✅ (native input events) |
| Fill forms | ✅ (set value + dispatch events) | ✅ (Input.insertText) |
| Screenshot | ❌ | ✅ |
| Network interception | ❌ | ✅ |
| Keyboard shortcuts | ❌ | ✅ (Input.dispatchKeyEvent) |
| iframes (cross-origin) | ❌ | ✅ |
| Access page JS variables | ⚠️ (needs MAIN world) | ✅ (Runtime.evaluate) |
| Works without debugger infobar | ✅ | ❌ |
| Handles React/SPA state | ⚠️ (fragile) | ✅ (native events trigger frameworks) |

**Recommendation**: Use CDP (chrome.debugger) as primary automation channel. Use content scripts as supplementary for DOM inspection, element enumeration, and visual feedback. CDP's `Input.*` methods fire at the browser level, so they correctly trigger all event listeners including React synthetic events.

---

## 6. Screenshot & Vision Capabilities

### 6.1 Three Screenshot Methods

```js
// Method 1: chrome.tabs.captureVisibleTab (simplest, viewport only)
// Requires: <all_urls> or activeTab permission
const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 70 });

// Method 2: CDP Page.captureScreenshot (most flexible)
// Requires: chrome.debugger attached
const { data } = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
  format: 'jpeg',
  quality: 70,
  clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 } // optional region
});
// data is base64

// Method 3: CDP + full page (scroll capture)
// See captureFullPage() in Section 3.2
```

### 6.2 Screenshot Optimization for AI Vision

```js
async function captureForAgent(tabId, options = {}) {
  const {
    maxWidth = 1280,
    quality = 60,
    format = 'jpeg',
    annotate = true // add element bounding boxes
  } = options;
  
  // Capture screenshot
  const { data } = await chrome.debugger.sendCommand(
    { tabId }, 'Page.captureScreenshot',
    { format, quality, fromSurface: true }
  );
  
  // Optionally: get interactive element positions for grounding
  let elements = [];
  if (annotate) {
    elements = await getInteractiveElements(tabId);
  }
  
  return {
    screenshot: data, // base64
    viewport: { width: 1280, height: 720 },
    elements // [{role, name, bounds: {x,y,w,h}, selector}, ...]
  };
}

async function getInteractiveElements(tabId) {
  const { nodes } = await chrome.debugger.sendCommand(
    { tabId }, 'Accessibility.getFullAXTree', {}
  );
  
  return nodes
    .filter(n => {
      const role = n.role?.value;
      return ['button', 'link', 'textbox', 'combobox', 'checkbox', 
              'radio', 'menuitem', 'tab', 'searchbox'].includes(role);
    })
    .map((n, i) => ({
      ref: `e${i}`,
      role: n.role?.value,
      name: n.name?.value || '',
      backendNodeId: n.backendDOMNodeId,
    }));
}
```

### 6.3 Annotated Screenshots (Set-of-Mark style)

Draw bounding boxes + labels on screenshots so the AI model can reference elements by label.

```js
// In content script: overlay numbered badges on interactive elements
function annotateElements() {
  // Remove old annotations
  document.querySelectorAll('.agent-annotation').forEach(e => e.remove());
  
  const interactive = document.querySelectorAll(
    'a, button, input, textarea, select, [role="button"], [role="link"], [tabindex]'
  );
  
  const annotations = [];
  interactive.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.top > window.innerHeight || rect.bottom < 0) return;
    
    const badge = document.createElement('div');
    badge.className = 'agent-annotation';
    badge.textContent = i;
    badge.style.cssText = `
      position: fixed; left: ${rect.left}px; top: ${rect.top - 16}px;
      background: red; color: white; font-size: 11px; padding: 1px 4px;
      border-radius: 3px; z-index: 999999; pointer-events: none;
    `;
    document.body.appendChild(badge);
    
    annotations.push({
      index: i,
      tag: el.tagName.toLowerCase(),
      type: el.type,
      text: el.textContent?.trim().substring(0, 50),
      selector: generateSelector(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    });
  });
  
  return annotations;
}
```

---

## 7. Security Model & Permissions

### 7.1 Manifest Permissions

```json
{
  "manifest_version": 3,
  "name": "AI Browser Agent",
  "version": "1.0",
  "description": "Let your AI agent control the browser",
  
  "permissions": [
    "debugger",        // chrome.debugger API (CDP access)
    "tabs",            // Tab URLs, titles, management
    "scripting",       // Inject scripts into pages
    "activeTab",       // Act on user-clicked tab (no host perm needed for gestures)
    "sidePanel",       // Side panel UI
    "offscreen",       // Offscreen document for WebSocket
    "alarms",          // Keep-alive alarms
    "storage"          // Settings persistence
  ],
  
  "host_permissions": [
    "<all_urls>"       // Access all sites (needed for scripting + captureVisibleTab)
  ],
  
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  
  "action": {
    "default_popup": "popup.html",
    "default_icon": "icon.png"
  },
  
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src ws://localhost:* http://localhost:*"
  }
}
```

### 7.2 Security Considerations

| Risk | Mitigation |
|------|-----------|
| **Agent has full browser control** | Explicit user activation (button click to enable). Visual indicator (badge/icon). Side panel shows real-time action log. |
| **chrome.debugger yellow bar** | Cannot suppress — this IS the consent mechanism. Good: makes control visible. |
| **<all_urls> is broad** | Required for universal automation. Can't scope down without limiting functionality. Chrome Web Store review will scrutinize. |
| **WebSocket to localhost** | Only connects to localhost. CSP restricts to `ws://localhost:*`. Extension ID verified server-side. |
| **Content script injection** | Runs in isolated world by default. Can't access page's JS context unless explicitly using `world: 'MAIN'`. |
| **Debugger detach on user action** | User can always dismiss the debugging bar. `onDetach` handler should gracefully stop agent. |
| **Tab data exposure** | Agent gets full page content. Log all actions. Allow user to exclude tabs/domains. |

### 7.3 Chrome Web Store Considerations

For **Chrome Web Store** distribution (not required if sideloading):
- `debugger` permission triggers manual review
- `<all_urls>` triggers manual review
- Reviewer expects clear justification and visible user control
- Consider: start with `activeTab` + user-gesture-gated escalation to `debugger`

For **enterprise/self-hosted** (sideloading):
- No store review. Load via `chrome://extensions` in developer mode.
- Or deploy via Chrome Enterprise policy (force-install).
- No restrictions on permissions.

---

## 8. MV3 Limitations & Workarounds

### 8.1 Service Worker Lifecycle (THE biggest MV3 pain point)

| MV2 | MV3 |
|-----|-----|
| Persistent background page (always alive) | Service worker (30s idle → terminated) |
| DOM access in background | No DOM (use offscreen document) |
| `XMLHttpRequest` | `fetch()` only |
| Unlimited background runtime | 5-minute max for event handlers |
| `chrome.webRequest.onBeforeRequest` blocking | `chrome.declarativeNetRequest` (limited) |

**Workarounds for persistent connection:**

1. **Offscreen Document** — persistent DOM context for WebSocket ✅
2. **Alarms** — wake up every 30s to check state
3. **Port keep-alive** — offscreen doc holds a runtime.connect port to SW
4. **Chrome 116+**: `chrome.runtime.getContexts()` to detect offscreen existence

### 8.2 Other MV3 Limitations

| Feature | Workaround |
|---------|------------|
| No `eval()`/`new Function()` in SW | Pre-define handlers, use `chrome.scripting.executeScript` |
| No persistent state in SW memory | Use `chrome.storage.session` (in-memory, survives SW restart) |
| `chrome.webRequest` is read-only | Use `chrome.declarativeNetRequest` OR `Network.enable` via CDP |
| Offscreen doc limited APIs | No `chrome.tabs`, `chrome.debugger` — must relay through SW |
| Only 1 offscreen doc | Multiplex all offscreen needs (WS + DOM parsing + etc.) |

### 8.3 `chrome.storage.session` — SW-restart-safe state

```js
// Survives service worker restarts. In-memory (not persisted to disk).
// 10MB limit (Chrome 112+).
await chrome.storage.session.set({
  agentState: {
    activeTabId: 123,
    debuggerAttached: true,
    pendingCommands: [],
    sessionId: 'abc-123'
  }
});

// Retrieve after SW restart
const { agentState } = await chrome.storage.session.get('agentState');
```

---

## 9. Existing Open-Source Projects

### 9.1 Landscape Overview

| Project | Approach | Extension? | User's browser? | Vision? | Stars |
|---------|----------|-----------|-----------------|---------|-------|
| **browser-use** | Playwright + LLM | ❌ | ❌ (new instance) | ✅ | ~50k |
| **Skyvern** | Cloud browser + CDP | ❌ | ❌ (cloud) | ✅ | ~12k |
| **LaVague** | Selenium/Playwright + LLM | ❌ | ❌ (new instance) | ✅ | ~5k |
| **Agent-E** | Playwright + extension | ⚠️ Partial | ⚠️ Connects to debug port | ✅ | ~1k |
| **anthropic computer-use** | Full desktop screenshot + mouse/keyboard | ❌ | ✅ (whole desktop) | ✅ | N/A |
| **OpenAdapt** | Desktop recording + replay | ❌ | ✅ (whole desktop) | ✅ | ~2k |
| **Playwright MCP** | Playwright server + MCP protocol | ❌ | ❌ (new instance) | ✅ | N/A |
| **WebVoyager** | Research: Selenium + GPT-4V | ❌ | ❌ | ✅ | Research |
| **nanobrowser** | Chrome extension + CDP | ✅ | ✅ | ✅ | ~5k |
| **browser-use webui** | Browser-use + Gradio UI | ❌ | ❌ | ✅ | ~10k |

### 9.2 Key Project Analysis

#### browser-use (Python)
- **Architecture**: Spawns a Playwright-controlled Chromium. Agent loop: screenshot → LLM → action → repeat.
- **How it works**: Playwright's CDP connection to a fresh browser. Gets accessibility tree via CDP `Accessibility.getFullAXTree`. Screenshots via CDP. Actions via Playwright's high-level API.
- **Limitation**: Doesn't control user's existing browser. User's logins/cookies not available (unless connecting to existing CDP port with `--remote-debugging-port`).
- **Relevance**: Excellent reference for the agent loop pattern (screenshot + AX tree → LLM → action). The *control mechanism* is what we'd replace with extension APIs.

#### Anthropic Computer Use
- **Architecture**: Full desktop control via screenshot + mouse/keyboard at OS level.
- **How it works**: Takes screenshot of entire screen, sends to Claude as image, Claude returns coordinates to click or text to type. Uses pyautogui or similar for input injection.
- **Limitation**: Not browser-specific. No DOM access. Coarse-grained. Requires full desktop access.
- **Relevance**: Validates the "vision + action" loop. Extension approach is strictly better for browser-only tasks (DOM access, AX tree, element-level actions).

#### nanobrowser
- **Architecture**: Chrome extension (MV3) + local Python server. Uses `chrome.debugger` for CDP access.
- **How it works**: Extension attaches debugger to tabs, communicates with local Python server via WebSocket. Server runs LLM agent loop.
- **Closest to our target architecture.** Worth studying implementation patterns.
- **Relevance**: Direct precedent. Validates the extension + CDP + WebSocket + local server approach.

#### Agent-E (Convergence Labs)
- **Architecture**: Connects to Chrome started with `--remote-debugging-port`. Uses a helper extension for DOM annotation.
- **Limitation**: Requires Chrome restart with special flag. Extension is supplementary, not the primary control channel.

#### Skyvern
- **Architecture**: Cloud-hosted browsers. CDP-based. Vision-first (screenshot → LLM → action). No extension.
- **Relevance**: Good reference for the "vision + structured action" pattern. Their element detection pipeline is sophisticated.

### 9.3 Key Takeaway from Ecosystem

No dominant open-source project does exactly "MV3 extension + chrome.debugger + local server" at production quality. `nanobrowser` is closest. The market opportunity is clear: most tools launch a separate browser instance (Playwright/Selenium), which means the user can't see or interact alongside the agent. An extension-based approach is the correct architecture for the "agent in YOUR browser" use case.

---

## 10. Performance Considerations

### 10.1 Latency Budget

```
Agent decision cycle:
  Screenshot capture:     50-150ms  (JPEG, viewport only)
  Send to server (WS):   1-5ms     (localhost)
  LLM inference:          500-5000ms (API call)
  Action command (WS):    1-5ms
  CDP action execution:   10-50ms
  ─────────────────────────
  Total cycle:            ~600-5200ms
```

**Screenshot is the bottleneck on the extension side.** Optimize:
- Use JPEG at quality 60-70 (not PNG)
- Resize to 1280px wide max (LLMs don't need 4K)
- Only capture when page changes (listen to DOM mutations / network idle)
- Consider sending AX tree + minimal screenshot (not every cycle needs vision)

### 10.2 CDP Command Batching

```js
// Bad: sequential commands
await chrome.debugger.sendCommand(tabId, 'DOM.getDocument', {});
await chrome.debugger.sendCommand(tabId, 'Page.captureScreenshot', {});
await chrome.debugger.sendCommand(tabId, 'Accessibility.getFullAXTree', {});

// Better: parallel where possible
const [doc, screenshot, axTree] = await Promise.all([
  chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {}),
  chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 }),
  chrome.debugger.sendCommand({ tabId }, 'Accessibility.getFullAXTree', {}),
]);
```

### 10.3 AX Tree Optimization

Full AX tree can be 10-50KB for complex pages. Compress for LLM context:

```js
function compressAXTree(nodes) {
  const interactiveRoles = new Set([
    'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio',
    'menuitem', 'tab', 'searchbox', 'slider', 'spinbutton', 'switch'
  ]);
  
  return nodes
    .filter(n => interactiveRoles.has(n.role?.value) && n.name?.value)
    .map((n, i) => `[${i}] ${n.role.value}: "${n.name.value}"`)
    .join('\n');
}
// Output: [0] button: "Sign In"
//         [1] textbox: "Email address"
//         [2] link: "Forgot password?"
// ~50 bytes per element vs full AX node
```

### 10.4 Memory Management

- Offscreen document should not accumulate state. Send and forget.
- Service worker state should use `chrome.storage.session` (survives restarts).
- Base64 screenshots are ~200-500KB. Don't store more than 1-2 in memory.
- AX trees: discard after sending to server.

---

## 11. Recommended Implementation Approach

### 11.1 Phased Implementation

#### Phase 1: Minimum Viable Extension
- Manifest with `debugger`, `tabs`, `scripting`, `offscreen`, `activeTab` permissions
- Service worker: attach debugger, execute basic CDP commands
- Offscreen document: WebSocket to localhost
- Commands: navigate, screenshot, click(x,y), type, getAXTree
- Side panel: simple status display + action log

#### Phase 2: Rich Interaction
- Content script: element annotation, DOM inspection, form enumeration
- CDP: full-page screenshots, network monitoring, cookie access
- Annotated screenshots (Set-of-Mark labeling)
- Element-level actions (click by selector, fill by selector)
- Tab management (create, switch, close)

#### Phase 3: Agent Collaboration UX
- Side panel: chat interface with agent
- Action preview: agent proposes action, user approves/rejects
- Autonomous mode toggle: agent acts without approval
- Domain allowlist/blocklist
- Action history + undo

#### Phase 4: Production Hardening
- Native Messaging as alternative transport (for reliability)
- Error recovery: auto-reattach debugger, reconnect WebSocket
- Rate limiting: prevent runaway agent loops
- Telemetry: action success rate, timing
- Cross-browser: Edge compatibility (same APIs, different manifest locations)

### 11.2 File Structure

```
extension/
├── manifest.json
├── background.js          # Service worker: command router, CDP bridge
├── offscreen.html         # Offscreen document shell
├── offscreen.js           # WebSocket client + keep-alive
├── content.js             # DOM helper, element annotation
├── sidepanel.html         # Agent chat/status UI
├── sidepanel.js           # Side panel logic
├── popup.html             # Quick settings popup
├── popup.js               # Popup logic
├── lib/
│   ├── cdp.js             # CDP command wrappers
│   ├── messaging.js       # Internal message routing
│   ├── screenshot.js      # Screenshot capture + optimization
│   ├── axtree.js          # Accessibility tree helpers
│   └── keepalive.js       # SW keep-alive logic
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── styles/
    └── annotations.css    # Element highlight styles
```

### 11.3 Server-Side Protocol

Simple JSON-RPC over WebSocket:

```typescript
// Agent → Extension (commands)
interface AgentCommand {
  id: string;           // unique request ID
  action: string;       // 'screenshot' | 'navigate' | 'click' | 'type' | 'evaluate' | ...
  tabId?: number;       // target tab (omit for active tab)
  params: Record<string, any>;
}

// Extension → Agent (responses)
interface AgentResponse {
  id: string;
  ok: boolean;
  result?: any;
  error?: string;
}

// Extension → Agent (events)
interface AgentEvent {
  type: 'event';
  event: string;        // 'page:loaded' | 'tab:created' | 'debugger:detached' | ...
  data: Record<string, any>;
}
```

### 11.4 Minimal Server (Bun/Node)

```typescript
// server.ts — minimal WebSocket server for agent
const server = Bun.serve({
  port: 9222,
  fetch(req, server) {
    if (req.url.endsWith('/agent')) {
      server.upgrade(req);
      return;
    }
    return new Response('AI Agent Server');
  },
  websocket: {
    open(ws) { console.log('Extension connected'); },
    message(ws, message) {
      const response = JSON.parse(message);
      // Route to agent loop
      handleExtensionResponse(response);
    },
    close(ws) { console.log('Extension disconnected'); },
  },
});

async function sendCommand(action: string, params: any) {
  const id = crypto.randomUUID();
  const cmd = { id, action, params };
  server.publish('agent', JSON.stringify(cmd));
  // Wait for response with matching id
  return waitForResponse(id);
}

// Agent loop example
async function agentStep() {
  // 1. Get page state
  const { result: screenshot } = await sendCommand('screenshot', { format: 'jpeg', quality: 60 });
  const { result: axTree } = await sendCommand('getAXTree', {});
  
  // 2. Send to LLM
  const action = await llm.complete({
    messages: [{
      role: 'user',
      content: [
        { type: 'image', data: screenshot },
        { type: 'text', text: `Interactive elements:\n${axTree}\n\nTask: ${userTask}\nWhat action should I take?` }
      ]
    }]
  });
  
  // 3. Execute action
  await sendCommand(action.type, action.params);
  
  // 4. Repeat
}
```

---

## 12. Unresolved Questions

1. **Chrome Web Store viability**: Will Google approve an extension with `debugger` + `<all_urls>` permissions for public distribution? Or should this be sideload-only / enterprise-deployed?

2. **Edge compatibility gaps**: Edge supports MV3 and `chrome.debugger`, but are there subtle behavioral differences in CDP domain support or offscreen document handling?

3. **Debugger infobar UX impact**: Users may find the yellow "debugging" bar annoying for long sessions. Is there a way to minimize this friction? (Some extensions use `chrome.debugger` only for screenshot bursts and detach between them — but this adds latency.)

4. **Multiple tab control**: Can `chrome.debugger` attach to multiple tabs simultaneously? (Yes, but each attachment shows its own infobar. Performance cost of multiple CDP sessions?)

5. **iframe handling**: Cross-origin iframes are accessible via CDP (separate targets) but require additional target discovery. How complex is this in practice?

6. **Service Worker reliability**: In stress testing, does the offscreen-document + port keep-alive pattern reliably prevent SW termination? Any Chrome version-specific regressions?

7. **Screenshot frequency**: What's the practical maximum screenshot rate before Chrome throttles or the extension becomes sluggish? (Preliminary: ~5-10 fps for viewport captures seems feasible.)

8. **Chrome Enterprise policies**: Some enterprises block `debugger` permission. Need fallback strategy (content-script-only mode with reduced capabilities).
