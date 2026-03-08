# Claw'd — Agentic Collaborative Chat

Claw'd is an open-source platform where AI agents operate autonomously through a real-time collaborative chat interface. Multiple agents can communicate with users and each other, execute code in sandboxed environments, browse the web via a Chrome extension, spawn sub-agents for parallel work, and persist memories across sessions.

**Key highlights:**

- 🤖 **Multi-agent orchestration** — multiple agents per channel, sub-agent spawning (Spaces), scheduled tasks
- 🌐 **Browser automation** — Chrome extension with CDP and stealth mode (anti-bot detection bypass)
- 🔒 **Sandboxed execution** — bubblewrap (Linux) / sandbox-exec (macOS) for secure tool execution
- 🧠 **3-tier memory** — session history, knowledge base (FTS5), and long-term agent memories
- 📦 **Single binary** — compiles to one executable with embedded UI and browser extension
- 🔌 **Provider-agnostic** — Copilot, OpenAI, Anthropic, Ollama, Minimax
- 🛠️ **MCP support** — both as MCP server (`/mcp` endpoint) and MCP client (external tools)

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.3.9+

### Install & Build

```sh
git clone https://github.com/clawd-pilot/clawd.git
cd clawd
bun install
bun run build    # Builds UI → embeds assets → compiles binary
```

### Run

```sh
# Using compiled binary
./dist/server/clawd-app

# Or development mode (hot reload)
bun run dev          # Server
bun run dev:ui       # UI (from packages/ui/)
```

Open **http://localhost:3456** in your browser.

### Docker

```sh
docker compose up -d
```

See [Docker Deployment](#docker-deployment) for details.

---

## Architecture Overview

```
User Browser ─── HTTP/WS ──→ Claw'd Server (Bun)
                                 ├── Chat API (/api/*)
                                 ├── MCP Endpoint (/mcp)
                                 ├── Browser Bridge (/browser/ws)
                                 ├── SQLite: chat.db + memory.db
                                 └── Agent Loops
                                      ├── LLM providers
                                      ├── Tool plugins
                                      ├── Sub-agents (Spaces)
                                      └── Scheduler (cron/interval)
                                           │
Chrome Extension ← WS ──────────────────────┘
   ├── CDP mode (full control)
   └── Stealth mode (anti-detection)
```

The server is a single Bun HTTP+WebSocket process (`src/index.ts`) that serves the embedded React UI, manages agents, and bridges browser automation. Each agent runs its own polling loop with tool execution, context management, and memory persistence.

For the full architecture reference, see **[docs/architecture.md](docs/architecture.md)**.

---

## Configuration

Settings are loaded from CLI flags and `~/.clawd/config.json`. CLI flags take precedence.

### CLI Flags

```sh
clawd-app [options]
  --host <host>       Bind address (default: 0.0.0.0)
  --port, -p <port>   Port number (default: 3456)
  --debug             Enable debug logging
  --yolo              Skip tool confirmation prompts
  --no-browser        Disable browser extension support
```

### config.json Schema

```jsonc
{
  // Server
  "host": "0.0.0.0",          // Bind address
  "port": 3456,                // Port number
  "debug": false,              // Debug logging
  "yolo": false,               // Skip tool confirmations

  // Paths
  "dataDir": "~/.clawd/data",  // Data directory override
  "uiDir": "/custom/ui/path",  // Custom UI directory

  // Agent environment variables (injected into sandbox)
  "env": {
    "GITHUB_TOKEN": "ghp_...",
    "CUSTOM_VAR": "value"
  },

  // LLM providers
  "providers": {
    "copilot": {
      "githubToken": "ghu_...",     // Or set GITHUB_TOKEN env
      "models": {                    // Optional model aliases
        "fast": "claude-haiku-4.5",
        "smart": "claude-sonnet-4"
      }
    },
    "anthropic": { "apiKey": "sk-ant-..." },
    "openai": { "apiKey": "sk-..." },
    "ollama": { "baseUrl": "http://localhost:11434" },
    "minimax": { "apiKey": "..." }
  },

  // Usage quotas
  "quotas": {
    "daily_image_limit": 50
  },

  // Feature flags
  "workspaces": true,                    // Enable workspace isolation
  "worker": true,                        // Enable remote workers
  // or: "worker": { "channel": ["token1", "token2"] }

  // Vision configuration
  "vision": {
    "provider": "copilot",
    "model": "gpt-4.1",
    "read_image": { "provider": "copilot", "model": "gpt-4.1" },
    "generate_image": { "provider": "minimax", "model": "image-01" },
    "edit_image": { "provider": "minimax", "model": "image-01" }
  },

  // Browser extension access control
  "browser": true,                       // All channels
  // or: ["channel1", "channel2"]        // Specific channels
  // or: { "channel": ["auth_token"] }   // Token-gated

  // Agent long-term memory
  "memory": true
  // or: { "provider": "anthropic", "model": "claude-haiku-4.5", "autoExtract": true }
}
```

### Environment Variables

Environment variables for agents can be set in `~/.clawd/.env`:

```env
GITHUB_TOKEN=ghp_...
NPM_TOKEN=npm_...
CUSTOM_API_KEY=...
```

These are injected into the agent sandbox environment. The file is never exposed to agents directly.

---

## System Files & Directories

```
~/.clawd/
├── config.json              # Application configuration
├── .env                     # Agent environment variables (KEY=VALUE)
├── .ssh/
│   └── id_ed25519           # SSH key for agent Git operations
├── .gitconfig               # Git config for agents
├── bin/                     # Custom binaries added to agent PATH
├── data/
│   ├── chat.db              # Chat messages, agents, channels
│   ├── kanban.db            # Tasks, plans, phases
│   ├── scheduler.db         # Scheduled jobs and run history
│   └── attachments/         # Uploaded files and images
├── memory.db                # Agent session memory, knowledge base, long-term memories
└── mcp-oauth-tokens.json    # OAuth tokens for external MCP servers
```

### chat.db

Main application database (SQLite, WAL mode). Contains:

| Table | Purpose |
|---|---|
| `channels` | Chat channels (id, name, created_by) |
| `messages` | All chat messages with timestamps, agent attribution, tool results |
| `files` | File attachment metadata |
| `agents` | Agent registry (display names, colors, worker status) |
| `channel_agents` | Agent ↔ channel assignments with provider, model, project path |
| `agent_seen` | Read tracking (last_seen_ts, last_processed_ts) |
| `agent_status` | Per-channel agent status |
| `summaries` | Context compression summaries |
| `spaces` | Sub-agent space records (parent, status, timeout) |
| `articles` | Knowledge articles |
| `copilot_calls` | API call analytics |
| `users` | User records |
| `message_seen` | User read tracking |

### kanban.db

Task and plan management database (SQLite, WAL mode, `~/.clawd/data/kanban.db`). Contains:

| Table | Purpose |
|---|---|
| `tasks` | Channel-scoped tasks (status, assignee, priority, due dates) |
| `plans` | Plan documents with phases |
| `phases` | Plan phases/milestones |
| `plan_tasks` | Tasks linked to plan phases |

### scheduler.db

Scheduler database (SQLite, WAL mode, `~/.clawd/data/scheduler.db`). Contains:

| Table | Purpose |
|---|---|
| `scheduled_jobs` | Cron/interval/once/reminder/tool_call scheduled tasks |
| `job_runs` | Execution history for scheduled jobs |

### memory.db

Agent session memory and knowledge store (SQLite, WAL mode). Contains:

| Table | Purpose |
|---|---|
| `sessions` | LLM sessions (name format: `{channel}-{agentId}`) |
| `messages` | Full conversation history (role, content, tool_calls, tool_call_id) |
| `messages_fts` | FTS5 full-text search on message content |
| `knowledge` | Indexed tool output chunks for retrieval |
| `knowledge_fts` | FTS5 search on knowledge chunks |
| `agent_memories` | Long-term facts, preferences, decisions per agent |
| `agent_memories_fts` | FTS5 search on agent memories |

---

## Project Structure

```
clawd/
├── src/                          # Server + agent system
│   ├── index.ts                  # Entry point: HTTP/WS server, all API routes
│   ├── config.ts                 # CLI argument parser
│   ├── config-file.ts            # Config file loader, getDataDir()
│   ├── worker-loop.ts            # Per-agent polling loop
│   ├── worker-manager.ts         # Multi-agent orchestrator
│   ├── server/
│   │   ├── database.ts           # chat.db schema & migrations
│   │   ├── websocket.ts          # WebSocket broadcasting
│   │   └── browser-bridge.ts     # Browser extension WS bridge
│   ├── agent/src/
│   │   ├── agent/agent.ts        # Agent class, reasoning loop, compaction
│   │   ├── memory/               # Session memory, knowledge base, agent memories
│   │   ├── session/              # Session manager, checkpoints, summarizer
│   │   ├── plugins/              # browser-plugin, workspace-plugin, etc.
│   │   ├── mcp/                  # MCP client connections
│   │   └── utils/sandbox.ts      # Sandbox execution (bwrap/sandbox-exec)
│   ├── spaces/                   # Sub-agent system
│   │   ├── manager.ts            # Space lifecycle
│   │   ├── worker.ts             # Space worker orchestrator
│   │   └── spawn-plugin.ts       # spawn_agent tool implementation
│   └── scheduler/                # Scheduled tasks
│       ├── manager.ts            # Tick loop (10s interval)
│       ├── runner.ts             # Job executor → sub-spaces
│       └── parse-schedule.ts     # Natural language schedule parser
├── packages/
│   ├── ui/                       # React SPA (Vite + TypeScript)
│   │   └── src/
│   │       ├── App.tsx           # Main app, WebSocket, state management
│   │       ├── MessageList.tsx   # Messages, StreamOutputDialog
│   │       └── styles.css        # All styles
│   ├── browser-extension/        # Chrome MV3 extension
│   │   └── src/
│   │       ├── service-worker.js # Command dispatcher (~2800 lines)
│   │       ├── content-script.js # DOM extraction
│   │       ├── shield.js         # Anti-detection patches
│   │       └── offscreen.js      # Persistent WS connection
│   └── clawd-worker/            # Remote worker clients (Python/TS/Java)
├── scripts/
│   ├── embed-ui.ts               # Embed UI assets into binary
│   └── zip-extension.ts          # Pack extension into binary
├── Dockerfile                    # Multi-stage Docker build
└── compose.yaml                  # Docker Compose deployment
```

---

## Agent System

### Worker Loop

Each agent runs an independent polling loop (`worker-loop.ts`):

1. **Poll** — check for new messages every 200ms
2. **Build prompt** — assemble system prompt, context, plugin injections
3. **Call LLM** — stream response from configured provider
4. **Execute tools** — run tool calls in sandboxed environment
5. **Post results** — send tool outputs back to the conversation
6. **Repeat** — continue until no more tool calls

### Plugin System

Agents are extended via two interfaces:

- **ToolPlugin** — adds tools: `getTools()`, `beforeExecute()`, `afterExecute()`
- **Plugin** — adds lifecycle hooks: `onUserMessage()`, `onToolCall()`, `getSystemContext()`

Built-in plugins: browser, workspace, context-mode, state-persistence, tunnel, spawn-agent, scheduler, memory.

### Memory (3-Tier)

1. **Session memory** — conversation history with smart compaction at token thresholds
2. **Knowledge base** — FTS5-indexed tool output chunks for context retrieval
3. **Agent memories** — long-term facts, preferences, and decisions per agent

### Sub-Agents (Spaces)

Agents can delegate tasks via `spawn_agent(task, name)`:
- Creates an isolated channel `{parent}:space:{uuid}`
- Sub-agent inherits parent's project, provider, and model
- Returns results via `respond_to_parent(result)`
- Configurable timeout (default 300s; spawn_agent overrides to 600s), max 5 concurrent

### Scheduler

Supports cron, interval, and one-shot jobs:
- Jobs execute by creating sub-spaces (same as spawn_agent)
- Reminders post messages without sub-spaces
- Tool calls execute directly without agent involvement
- Tick loop runs every 10s, max 3 concurrent jobs globally

---

## Browser Extension

The Chrome MV3 extension provides remote browser automation for agents.

### Two Operation Modes

| Feature | CDP Mode | Stealth Mode |
|---|---|---|
| **Mechanism** | `chrome.debugger` API | `chrome.scripting.executeScript()` |
| **Detection** | Visible to anti-bot | Invisible to detection |
| **Screenshots** | CDP `Page.captureScreenshot` | `html2canvas` |
| **Click events** | CDP `Input.dispatchMouseEvent` | `el.click()` (isTrusted=true) |
| **File upload** | ✅ | ❌ |
| **Accessibility tree** | ✅ | ❌ |
| **Drag/touch** | ✅ | ❌ |

### Anti-Detection Shield

`shield.js` runs in the MAIN world at `document_start` to patch:
- `navigator.webdriver` → false
- DevTools detection bypass
- `Function.prototype.toString` spoofing
- `performance.now()` timing normalization

### Distribution

The extension is zipped and base64-embedded in the compiled binary, served at `/browser/extension` for easy installation.

---

## Sandbox Security

All agent tool execution runs in a sandboxed environment:

- **Linux**: bubblewrap (bwrap) — deny-by-default namespace isolation
- **macOS**: sandbox-exec with Seatbelt profiles

### Access Policy

| Access | Paths |
|---|---|
| **Read/Write** | `{projectRoot}`, `/tmp`, `~/.clawd` |
| **Read-only** | `/usr`, `/bin`, `/lib`, `/etc`, `~/.bun`, `~/.cargo`, `~/.deno`, `~/.nvm`, `~/.local` |
| **Blocked** | `{projectRoot}/.clawd/` (agent config), home directory (except tool dirs) |

---

## Docker Deployment

### Build

```sh
docker build -t clawd .
```

The multi-stage Dockerfile:
1. **Build stage** (oven/bun:1): Install deps → build UI → embed assets → compile binary
2. **Runtime stage** (debian:bookworm-slim): Minimal image with git, ripgrep, python3, tmux, build-essential, bubblewrap, curl, openssh-client, bun, rust

### Run with Docker Compose

```yaml
# compose.yaml
services:
  clawd:
    build: .
    image: clawd-pilot/clawd:latest
    ports:
      - "3456:3456"
    volumes:
      - clawd-data:/home/clawd/.clawd
    security_opt:
      - apparmor=unconfined    # Required for bwrap sandbox
      - seccomp=unconfined
    restart: unless-stopped

volumes:
  clawd-data:
```

```sh
docker compose up -d
```

---

## API Reference

All API endpoints are available at `/api/*`. Key groups:

| Group | Endpoints |
|---|---|
| **Chat** | `conversations.list`, `conversations.create`, `conversations.history`, `chat.postMessage`, `chat.update`, `chat.delete` |
| **Agents** | `agents.list`, `agents.register`, `app.agents.list`, `app.agents.add`, `app.agents.update` |
| **Files** | `files.upload`, `files/{id}` |
| **Streaming** | `agent.setStreaming`, `agent.streamToken`, `agent.streamToolCall`, `agent.getThoughts` |
| **Tasks** | `tasks.list`, `tasks.get`, `tasks.create`, `tasks.update`, `tasks.delete`, `tasks.addComment` |
| **MCP** | `/mcp` (SSE endpoint), `app.mcp.list`, `app.mcp.add`, `app.mcp.remove` |
| **Browser** | `/browser/ws` (WebSocket), `/browser/extension`, `/browser/files/*` |
| **Spaces** | `spaces.list`, `spaces.get` |
| **Plans** | `plans.list`, `plans.get`, `plans.create`, `plans.update`, `plans.delete` |
| **Admin** | `config/reload`, `keys/status`, `keys/sync`, `admin.migrateChannels` |

For the complete API reference, see **[docs/architecture.md § API Reference](docs/architecture.md#12-api-reference)**.

---

## WebSocket Events

The UI connects via WebSocket for real-time updates:

| Event | Description |
|---|---|
| `message` | New chat message |
| `message_changed` | Message edited |
| `message_deleted` | Message deleted |
| `agent_streaming` | Agent started/stopped thinking |
| `agent_token` | Real-time LLM output (content or thinking) |
| `agent_tool_call` | Tool execution (started/completed/error) |
| `reaction_added/removed` | Emoji reactions |
| `message_seen` | Read receipts |

---

## Development

### Prerequisites

- Bun v1.3.9+
- Biome (for linting/formatting)

### Commands

```sh
bun install            # Install dependencies
bun run dev            # Start server in dev mode
bun run dev:ui         # Start UI with hot reload (from packages/ui/)
bun run build          # Full build pipeline
bun run build:all      # Cross-platform binaries
bun run install:local  # Copy binary to ~/.clawd/bin/
```

### Build Pipeline

1. `vite build` — compiles React UI → `packages/ui/dist/`
2. `embed-ui.ts` — base64 embeds UI into `src/embedded-ui.ts`
3. `zip-extension.ts` — packs browser extension into `src/embedded-extension.ts`
4. `bun build --compile` — produces `dist/server/clawd-app` binary

### Code Style

- TypeScript strict mode
- Biome for formatting and linting (`biome.json`)
- Minimal dependencies (SQLite via bun:sqlite, no ORM, no framework)

---

## Documentation

- **[docs/architecture.md](docs/architecture.md)** — Comprehensive architecture reference (database schema, agent system, browser extension, spaces, scheduler, sandbox, API reference, configuration)

---

## License

[MIT](LICENSE)
