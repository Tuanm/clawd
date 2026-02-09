# Claw'd App

All-in-one desktop application combining:
- **clawd-chat server** - HTTP/WebSocket API + SQLite database
- **clawd-chat UI** - React SPA served by the embedded server
- **Worker manager** - Manages per-channel agent polling loops
- **Agent management** - Add/remove agents per channel via UI

## Prerequisites

- [Bun](https://bun.sh) runtime
- `clawd` binary installed at `~/.clawd/bin/clawd`

## Development

```bash
bun install
bun run dev
```

## Build

```bash
bun run build
```

This produces a single `dist/clawd-app` binary with the UI bundled alongside in `dist/ui/`.

## Architecture

```
clawd-app (single process)
 |-- clawd-chat server (HTTP/WS API + SQLite)
 |-- clawd-chat UI (embedded React SPA)
 |-- worker manager (manages per-channel worker loops)
 |   |-- worker[channel-1:agent-1] -> spawns: ~/.clawd/bin/clawd ...
 |   |-- worker[channel-1:agent-2] -> spawns: ~/.clawd/bin/clawd ...
 |   '-- worker[channel-N:agent-M] -> spawns: ~/.clawd/bin/clawd ...
 '-- agent management API (add/remove/list agents per channel)
```

On startup:
1. Starts the clawd-chat server on port 53456 (configurable)
2. Loads agent configurations from SQLite
3. Starts worker loops for each active agent in each channel
4. Opens the default browser to the UI

Each worker loop polls for new messages and spawns `~/.clawd/bin/clawd` processes per message batch.

