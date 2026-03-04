# Claw'd Browser Extension

Chrome/Edge extension that connects your browser to Claw'd AI agents for browser automation and collaboration.

## Features

- **Navigate** — Open URLs, manage tabs
- **Screenshot** — Capture viewport, full page, or specific elements
- **Click/Type** — Interact with page elements via CSS selectors or coordinates
- **Extract** — Pull text, links, forms, tables, or accessibility tree from pages
- **Execute JS** — Run JavaScript in the page context
- **Tab Management** — List, activate, close browser tabs

## Installation

1. Open Chrome/Edge and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** and select this `packages/browser-extension/` directory
4. The Claw'd icon appears in your toolbar

## Configuration

1. Enable browser tools in `~/.clawd/config.json`:
   ```json
   { "browser": true }
   ```
2. Start the Claw'd server (default: `localhost:3456`)
3. Click the extension icon → verify "Connected to Claw'd"

## Architecture

```
┌─────────────────────────────────────────┐
│ Chrome Extension (Manifest V3)          │
│  ├─ Service Worker (command dispatch)   │
│  ├─ Offscreen Doc (WebSocket bridge)    │
│  ├─ Content Script (DOM utilities)      │
│  └─ Popup (connection status UI)        │
└──────────────┬──────────────────────────┘
               │ WebSocket (ws://localhost:3456/browser/ws)
┌──────────────┴──────────────────────────┐
│ Claw'd Server                           │
│  ├─ browser-bridge.ts (WS ↔ commands)   │
│  └─ browser-plugin.ts (agent tools)     │
└─────────────────────────────────────────┘
```

## Protocol

Commands flow as JSON-RPC over WebSocket:

```
Server → Extension:  { "id": "req_1_abc", "method": "screenshot", "params": {} }
Extension → Server:  { "id": "req_1_abc", "result": { "dataUrl": "..." } }
```

## Security Notes

- Extension only connects to **localhost** (configurable)
- `chrome.debugger` shows a yellow infobar as consent signal
- All commands require the extension to be explicitly installed and connected
- The `browser` config gate must be enabled server-side
