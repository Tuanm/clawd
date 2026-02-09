# Claw'd App

Self-contained all-in-one desktop application combining:
- **Chat server** - HTTP/WebSocket API + SQLite database
- **Chat UI** - React SPA served by the embedded server
- **Worker manager** - Manages per-channel agent polling loops
- **Agent management** - Add/remove agents per channel via UI
- **Desktop shell** - Electron wrapper for native window experience

All source code is included in this repository — no cross-repo dependencies.

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Node.js](https://nodejs.org) (for Electron tooling)
- `clawd` binary installed at `~/.clawd/bin/clawd`

## Development

```bash
# Install dependencies
bun install

# Install UI dependencies
cd packages/ui && bun install && cd ../..

# Run as web app (server on port 3456, opens browser)
bun run dev

# Run as desktop app (Electron wrapping the server)
bun run dev:electron

# Run the UI dev server only (port 3457, proxies to 3456)
bun run dev:ui
```

## Build

### Web server build (no Electron)

```bash
bun run build:server
```

Produces `dist/server/clawd-app` binary + `dist/server/ui/` assets.

### Desktop app build

```bash
# Full build (UI + server + Electron)
bun run build

# Package as distributable
bun run dist          # Current platform
bun run dist:mac      # macOS .dmg
bun run dist:linux    # Linux .AppImage
bun run dist:win      # Windows .exe installer
```

### Install server-only locally

```bash
bun run install:local
```

## Project Structure

```
clawd-app/
├── electron/
│   ├── main.ts               # Electron main process (window, tray, server lifecycle)
│   ├── preload.ts            # Secure renderer bridge (contextBridge)
│   └── tsconfig.json         # TypeScript config for Electron code
├── src/
│   ├── index.ts              # Bun server entry point (HTTP/WS + routes + startup)
│   ├── config.ts             # CLI args & env config (port, clawd binary, etc.)
│   ├── worker-loop.ts        # Single agent polling loop
│   ├── worker-manager.ts     # Manages worker loops per channel:agent
│   ├── api/
│   │   └── agents.ts         # Agent management REST API
│   └── server/               # Chat server (copied from clawd-chat)
│       ├── database.ts       # SQLite schema & CRUD
│       ├── websocket.ts      # WebSocket handler
│       ├── mcp.ts            # MCP JSON-RPC endpoint
│       └── routes/
│           ├── channels.ts   # Channel management
│           ├── messages.ts   # Message CRUD & history
│           ├── files.ts      # File upload & serving
│           └── tasks.ts      # Tasks & plans (kanban)
├── packages/
│   └── ui/                   # React SPA (copied from clawd-chat)
│       ├── src/              # App.tsx, HomePage.tsx, MessageList.tsx, etc.
│       ├── package.json
│       ├── vite.config.ts
│       └── tsconfig.json
├── build/                    # Electron-builder resources (icons)
├── package.json
├── electron-builder.yml      # Electron-builder packaging config
├── biome.json
└── tsconfig.json
```

## Architecture

```
Electron (native desktop window)
 └── Bun server (child process)
      ├── chat server (HTTP/WS API + SQLite) on port 3456
      ├── chat UI (embedded React SPA)
      ├── worker manager (manages per-channel worker loops)
      │   ├── worker[channel-1:agent-1] → spawns: ~/.clawd/bin/clawd ...
      │   ├── worker[channel-1:agent-2] → spawns: ~/.clawd/bin/clawd ...
      │   └── worker[channel-N:agent-M] → spawns: ~/.clawd/bin/clawd ...
      └── agent management API (add/remove/list agents per channel)
```

On startup:
1. Electron spawns the Bun server as a child process
2. Waits for the server health check to pass
3. Opens a BrowserWindow pointing at `http://localhost:3456`
4. Server loads agent configurations from SQLite
5. Starts worker loops for each active agent in each channel

On quit:
1. Electron sends SIGTERM to the Bun server
2. Server gracefully stops all workers
3. Application exits



