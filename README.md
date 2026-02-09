# Claw'd App

Self-contained all-in-one desktop application combining:
- **Chat server** - HTTP/WebSocket API + SQLite database
- **Chat UI** - React SPA served by the embedded server
- **Worker manager** - Manages per-channel agent polling loops
- **Agent management** - Add/remove agents per channel via UI

All source code is included in this repository — no cross-repo dependencies.

## Prerequisites

- [Bun](https://bun.sh) runtime
- `clawd` binary installed at `~/.clawd/bin/clawd`

## Development

```bash
# Install dependencies
bun install

# Install UI dependencies
cd packages/ui && bun install && cd ../..

# Run the app (server on port 3456)
bun run dev

# Run the UI dev server (port 3457, proxies to 3456)
bun run dev:ui
```

## Build

```bash
bun run build
```

This produces a single `dist/clawd-app` binary with the UI bundled alongside in `dist/ui/`.

## Project Structure

```
clawd-app/
├── src/
│   ├── index.ts              # Main entry point (server + routes + startup)
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
├── package.json
├── biome.json
└── tsconfig.json
```

## Architecture

```
clawd-app (single process)
 ├── chat server (HTTP/WS API + SQLite) on port 3456
 ├── chat UI (embedded React SPA)
 ├── worker manager (manages per-channel worker loops)
 │   ├── worker[channel-1:agent-1] → spawns: ~/.clawd/bin/clawd ...
 │   ├── worker[channel-1:agent-2] → spawns: ~/.clawd/bin/clawd ...
 │   └── worker[channel-N:agent-M] → spawns: ~/.clawd/bin/clawd ...
 └── agent management API (add/remove/list agents per channel)
```

On startup:
1. Starts the chat server on port 3456 (configurable via `--port`)
2. Loads agent configurations from SQLite
3. Starts worker loops for each active agent in each channel
4. Opens the default browser to the UI


