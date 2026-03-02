# Claw'd — Architecture & Tool Reference

> Last updated: 2026-03-02  
> Branch: `feat/agent-workspace`

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Directory Layout](#3-directory-layout)
4. [Server Entry Point](#4-server-entry-point)
5. [Database Schema](#5-database-schema)
6. [Agent System](#6-agent-system)
7. [MCP Tool Reference](#7-mcp-tool-reference)
   - [Chat & File Tools](#71-chat--file-tools-16-tools)
   - [Plan & Task Tools](#72-plan--task-tools-8-tools)
   - [Scheduler Tools](#73-scheduler-tools-4-tools)
   - [Multimodal Tools](#74-multimodal-tools-4-tools)
   - [Workspace Host Tools](#75-workspace-host-tools-3-tools)
   - [Workspace Desktop Tools](#76-workspace-desktop-tools-14-tools)
8. [Multimodal Tools Architecture](#8-multimodal-tools-architecture)
9. [Agent Workspace System](#9-agent-workspace-system)
10. [LLM Provider System](#10-llm-provider-system)
11. [Chat UI](#11-chat-ui)
12. [Build & Run](#12-build--run)
13. [Configuration Reference](#13-configuration-reference)
14. [Example Agent Interactions](#14-example-agent-interactions)

---

## 1. System Overview

Claw'd is an open-source agentic chat platform where AI agents operate autonomously in isolated desktop environments called **workspaces**. Agents can:

- Communicate with users through a real-time collaborative chat UI
- Execute code, browse the web, and interact with files using MCP tools
- Control a full Ubuntu desktop (Chrome, native apps, clipboard, TOTP) from inside Docker containers
- Analyze and generate images/video using Gemini vision models
- Create and manage multi-phase plans and scheduled tasks
- Delegate work to sub-agents for parallel execution

**Core design principles:**
- **Single binary deployment** — compiles to `dist/server/clawd-app` with embedded UI
- **Workspace isolation** — each agent gets its own Docker container + private Docker network
- **Tool-first agents** — all agent actions go through the Model Context Protocol (MCP)
- **Provider-agnostic** — supports Copilot, OpenAI, Anthropic, Gemini, CPA (CLIProxyAPI)
- **Secure by default** — sandboxed tools, path validation, auth tokens, no host port exposure

---

## 2. High-Level Architecture

```
User Browser
    │
    │  HTTP/WebSocket  (default: localhost:3456)
    ▼
┌──────────────────────────────────────────────────────────────────┐
│ Claw'd Server  (src/index.ts — Bun HTTP + WebSocket)             │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Chat API   │  │ MCP Endpoint │  │ Workspace Proxy       │   │
│  │ /api/*      │  │ /mcp         │  │ /workspace/:id/novnc  │   │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                │                       │               │
│  ┌──────▼────────────────▼───────┐    ┌──────────▼──────────┐   │
│  │  SQLite (WAL mode)            │    │  Caddy Gateway       │   │
│  │  messages, files, agents,     │    │  (clawd-gateway)     │   │
│  │  plans, scheduler, summaries  │    │  127.0.0.1:7777      │   │
│  └───────────────────────────────┘    └──────────┬──────────┘   │
│                                                   │ Docker net   │
│  ┌────────────────────────────────────────────────▼──────────┐   │
│  │  Agent Loop  (src/agent/)                                  │   │
│  │  ├─ LLM provider (Copilot / OpenAI / Anthropic / Gemini)  │   │
│  │  ├─ Tool plugins (workspace, state-persistence, context)   │   │
│  │  ├─ MCP clients (chat server MCP + workspace MCP)          │   │
│  │  ├─ Sub-agent spawner                                      │   │
│  │  └─ Context compactor / token budget manager              │   │
│  └────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
                                    │
          ┌─────────────────────────┘
          │  Docker
          ▼
┌─────────────────────────────────────────┐
│ clawd-workspace:{base|web3} container    │
│  ├─ Xvfb :99 (1280×1024 virtual display)│
│  ├─ Fluxbox (window manager)            │
│  ├─ Chromium (Playwright-controlled)     │
│  ├─ MetaMask + Freighter (web3 image)   │
│  ├─ noVNC :6080 (desktop streaming)     │
│  └─ Workspace MCP Server :3000          │
│      └─ 14 desktop-control tools        │
└─────────────────────────────────────────┘
```

---

## 3. Directory Layout

```
clawd/
├── src/
│   ├── index.ts                  # Bun HTTP + WebSocket server
│   ├── config-file.ts            # ~/.clawd/config.json loader
│   ├── embedded-ui.ts            # Auto-generated: UI assets as base64
│   ├── server/
│   │   ├── mcp.ts                # MCP tool definitions + handlers (36 tools)
│   │   ├── database.ts           # SQLite setup, schema, prepared statements
│   │   ├── multimodal.ts         # Gemini image/video analysis + generation
│   │   └── routes/
│   │       ├── files.ts          # File upload/download routes
│   │       ├── workspace-proxy.ts# noVNC HTTP + WS proxy via Caddy gateway
│   │       └── websocket.ts      # WebSocket dispatch (chat + workspace WS)
│   └── agent/
│       ├── src/
│       │   ├── agent/            # Main Agent class + agentic loop
│       │   ├── api/              # LLM provider abstraction + factory
│       │   ├── workspace/
│       │   │   ├── container.ts  # Docker container lifecycle
│       │   │   ├── pool.ts       # Pre-warmed workspace pool
│       │   │   ├── gateway.ts    # Caddy gateway management
│       │   │   └── worktree.ts   # Git worktree management
│       │   ├── plugins/
│       │   │   ├── workspace-plugin.ts  # spawn/destroy/list workspace tools
│       │   │   ├── state-persistence-plugin.ts
│       │   │   └── context-mode-plugin.ts
│       │   ├── mcp/              # MCP JSON-RPC client
│       │   ├── memory/           # Token tracking + context compaction
│       │   ├── subagent/         # Sub-agent delegation
│       │   └── skills/           # Custom skill plugins
│       ├── plugins/
│       │   ├── clawd-chat/       # Primary chat agent
│       │   └── clawd-agent-bus/  # Inter-agent event bus
│       └── workers/              # Multi-agent worker pools
├── packages/
│   ├── ui/                       # React SPA (Vite + TypeScript)
│   │   └── src/
│   │       ├── App.tsx           # Root component
│   │       ├── MessageList.tsx   # Messages, workspace cards, subspace cards
│   │       ├── MessageComposer.tsx
│   │       ├── PlanModal.tsx
│   │       └── styles.css
│   └── workspace-mcp/            # Workspace container MCP server
│       └── src/server.ts         # 14 desktop tools
├── docs/                         # Architecture docs, research, brainstorms
├── plans/                        # Agent implementation plans
├── scripts/                      # Build utilities (embed-ui.ts)
├── Dockerfile                    # Builds clawd-workspace:base image
├── Dockerfile.web3               # Adds MetaMask + Freighter wallet extensions
└── package.json
```

---

## 4. Server Entry Point

`src/index.ts` runs a single Bun HTTP + WebSocket server (default: `0.0.0.0:3456`).

### HTTP Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness probe |
| POST | `/mcp`, `/api/mcp` | MCP JSON-RPC tool dispatch |
| POST | `/api/chat.postMessage` | Send a message |
| POST | `/api/chat.update` | Edit a message |
| POST | `/api/chat.delete` | Delete a message |
| GET | `/api/conversations.list` | List channels |
| GET | `/api/conversations.history` | Message history (paginated) |
| GET | `/api/conversations.search` | Full-text message search |
| POST | `/api/files.upload` | Upload file attachment |
| GET | `/api/files/:fileId` | Download / serve file |
| GET | `/api/files/:fileId/optimized` | Serve resized image |
| GET | `/api/agent.getLastSeen` | Agent read state |
| POST | `/api/agent.markSeen` | Update agent read cursor |
| POST | `/api/agent.setSleeping` | Hibernate/wake agent |
| GET/POST | `/api/plans.*` | Plan CRUD |
| GET/POST | `/api/tasks.*` | Task CRUD |
| GET/POST | `/api/scheduler.*` | Scheduler management |
| GET | `/workspace/:id/novnc/*` | Proxy to workspace noVNC via Caddy gateway |
| GET | `/*` | Embedded React SPA (SPA fallback) |

### WebSocket Protocol

| Upgrade Path | Purpose |
|-------------|---------|
| `/ws` | Real-time chat (messages, reactions, agent tokens, tool calls) |
| `/workspace/:id/novnc/websockify` | Binary relay to noVNC websockify via Caddy gateway |

**WS message types (server → client):**
- `message_new` / `message_update` / `message_delete`
- `agent_streaming` / `agent_token` / `agent_tool_call`
- `reaction_add` / `reaction_remove`
- `typing_start` / `typing_stop`

---

## 5. Database Schema

SQLite (WAL mode), located at `~/.clawd/clawd.db`.

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `users` | id, name, avatar_url, is_bot | User + agent profiles |
| `channels` | id, name, created_by | Chat spaces/channels |
| `messages` | ts (PK), channel, user, text, html_preview, agent_id, files_json, reactions_json, subspace_json, **workspace_json** | Core message log |
| `files` | id, name, mimetype, size, path, uploaded_by | File attachments |
| `agent_seen` | agent_id, channel, last_seen_ts, last_processed_ts | Agent read state |
| `agent_status` | agent_id, channel, status, hibernate_until | Agent lifecycle |
| `agents` | id, channel, avatar_color, display_name, is_sleeping | Agent registry |
| `summaries` | id, channel, agent_id, summary, from_ts, to_ts | Context summaries |
| `message_seen` | message_ts, channel, agent_id | Per-agent receipts |
| `articles` | id, channel, title, content, tags_json, published | Blog/doc posts |
| `plans` | id, channel, title, description, phases_json, status | Multi-phase plans |
| `tasks` | id, plan_id, phase_id, title, status, assignee | Plan tasks |
| `scheduler_jobs` | id, channel, cron/delay, action, last_run, next_run | Scheduled jobs |

**`workspace_json` column** (in `messages`) stores workspace preview cards:
```json
{
  "workspace_id": "abc123...",
  "title": "Web3 Testing Workspace",
  "description": "Ready for MetaMask interaction",
  "status": "running"
}
```

---

## 6. Agent System

### Agentic Loop

Each agent session runs a continuous loop:

```
poll_chat → get_unprocessed_message
    │
    ▼
inject context (CLAWD.md, recent history, summaries)
    │
    ▼
LLM call (streaming) ← system prompt + tools list
    │
    ├── text response → chat_send_message
    │
    └── tool call(s) → execute via MCP → inject result → continue loop
                │
                └── workspace tools → Docker container → MCP client → result
```

### Context Management

| Threshold | Action |
|-----------|--------|
| > 50K tokens | Begin soft compaction (keep last 30 messages + summaries) |
| > 70K tokens | Hard reset (emergency truncation) |
| Tool results | Capped at 10KB per result (`truncateForAgent`) |

### Sub-Agents

Agents can delegate to sub-agents via `chat_send_message` to a dedicated sub-agent channel. Sub-agents run the same loop with a scoped system prompt and report back results.

### Plugins

| Plugin | Purpose |
|--------|---------|
| `WorkspaceToolPlugin` | Registers `spawn_workspace`, `destroy_workspace`, `list_workspaces` |
| `StatePersistencePlugin` | Save/restore agent memory to disk between sessions |
| `ContextModePlugin` | Toggle between full-action and context-only modes |

---

## 7. MCP Tool Reference

All tools follow the [Model Context Protocol](https://modelcontextprotocol.io) JSON-RPC spec and are available at `/mcp`.

### 7.1 Chat & File Tools (16 tools)

| Tool | Description |
|------|-------------|
| `chat_poll_and_ack` | Poll for new unprocessed messages in a channel and mark them as seen |
| `chat_mark_processed` | Mark a specific message as processed to prevent duplicate handling |
| `chat_send_message` | Post a text message to a channel (supports Markdown, code blocks, workspace cards) |
| `chat_get_history` | Fetch recent conversation history (paginated, with thread support) |
| `chat_get_message` | Fetch a single message by timestamp |
| `chat_get_message_files` | List files attached to a message (returns file ID + metadata, never image base64) |
| `chat_download_file` | Download a file by ID; for images, returns a hint to use `read_image` instead |
| `chat_read_file_range` | Read a byte range of a file (blocked for images in base64 encoding) |
| `chat_upload_file` | Upload a file to the server and attach it to a message |
| `chat_upload_local_file` | Read a local file path and upload it to chat storage |
| `chat_send_message_with_files` | Atomically post a message with one or more file attachments |
| `chat_delete_message` | Delete a message by timestamp |
| `chat_update_message` | Edit the text of an existing message |
| `chat_query_messages` | Full-text search across message history by pattern, user, or date range |
| `chat_get_last_summary` | Retrieve the most recent context summary for a channel |
| `chat_store_summary` | Save a context summary (used for long-term memory compaction) |

> **Image handling**: `chat_download_file`, `chat_get_message_files`, and `chat_read_file_range` all **refuse to return base64 image content**. Instead they return a hint directing the agent to use `read_image` with the file ID. This prevents context overflow.

### 7.2 Plan & Task Tools (8 tools)

| Tool | Description |
|------|-------------|
| `plan_create` | Create a new multi-phase plan with title and description |
| `plan_list` | List all plans in a channel |
| `plan_get` | Get full plan details including phases and tasks |
| `plan_update` | Update plan title, description, or status |
| `plan_add_phase` | Add a new phase to a plan |
| `plan_update_phase` | Update phase name, description, or completion status |
| `plan_link_task` | Associate a task with a plan phase |
| `plan_get_tasks` | List all tasks in a plan phase |

### 7.3 Scheduler Tools (4 tools)

| Tool | Description |
|------|-------------|
| `scheduler_create` | Schedule a recurring (cron) or one-time (delay) job |
| `scheduler_list` | List all scheduled jobs |
| `scheduler_cancel` | Cancel a scheduled job by ID |
| `scheduler_history` | Fetch execution history of a scheduled job |

### 7.4 Multimodal Tools (4 tools)

| Tool | Input | Description |
|------|-------|-------------|
| `read_image` | `file_id`, `prompt?` | Analyze an image with Gemini vision; returns text description |
| `create_image` | `prompt`, `aspect_ratio?`, `image_size?` | Generate an image; auto-saves to files table, returns file ID |
| `edit_image` | `file_id`, `prompt`, `aspect_ratio?` | Edit/inpaint an existing image using Gemini |
| `read_video` | `file_id`, `prompt?`, `max_frames?` | Analyze a video (Gemini native upload, or frame extraction fallback) |

**Provider priority**: CPA (primary, if configured) → Gemini direct API (fallback, with quota tracking).  
**Quota**: Gemini image generation defaults to 50/day. Set `quotas.daily_image_limit: 0` to disable.

### 7.5 Workspace Host Tools (3 tools)

These are registered by `WorkspaceToolPlugin` in the agent process (not the MCP server).

| Tool | Description |
|------|-------------|
| `spawn_workspace` | Start a new Docker workspace container (image: `base` or `web3`); returns workspace ID and noVNC URL |
| `destroy_workspace` | Stop and remove a workspace container, volume, and network |
| `list_workspaces` | List all active workspaces owned by this agent session |

### 7.6 Workspace Desktop Tools (14 tools)

These become available inside the agent's context after `spawn_workspace`. They control the workspace container's desktop via Playwright and xdotool.

| Tool | Description |
|------|-------------|
| `launch_browser` | Open a URL in Chromium (or new tab if already running) |
| `launch_app` | Start a native Linux application (e.g., `code`, `libreoffice`, `gedit`) |
| `snapshot` | Get the accessibility tree of the current browser page (cheapest, fastest) |
| `screenshot` | Capture the entire display; returns file path (use `read_image` to analyze) |
| `observe` | Screenshot + AI vision analysis in one call (for extension popups and native apps) |
| `click` | Click an element by CSS selector, coordinates, or AI description |
| `type_text` | Type text at the current focus (Playwright or xdotool for extension dialogs) |
| `press_key` | Press a keyboard key or combination (e.g., `Enter`, `Ctrl+C`, `Tab`) |
| `select_option` | Select a `<select>` dropdown option by value or label |
| `drag` | Drag from one coordinate to another |
| `handle_dialog` | Accept or dismiss browser dialogs (alert, confirm, prompt) |
| `wait` | Wait for an element to appear, disappear, or for a fixed duration |
| `scroll` | Scroll the page or an element up, down, left, or right |
| `get_context` | Get current browser URL, title, and scroll position |
| `window_manage` | Resize, minimize, maximize, or focus a native window |
| `clipboard` | Read from or write to the system clipboard |
| `file_dialog` | Handle file picker dialogs (upload files into the browser) |
| `totp_code` | Generate a TOTP 2FA code from a stored secret |
| `pause_for_human` | Display a message in the workspace UI to request human interaction |

---

## 8. Multimodal Tools Architecture

### Provider Priority

```
create_image / edit_image / read_image / read_video
    │
    ├─ CPA configured? (providers.cpa in config.json)
    │       └─ YES → POST to CPA base_url (OpenAI-compatible)
    │                    model: models.flash-image (image gen/edit)
    │                    model: models.flash (vision analysis)
    │                 ├─ Success → return result
    │                 └─ Failure → fall through to Gemini
    │
    └─ Gemini API key configured? (env.GEMINI_API_KEY)
            └─ YES → POST to generativelanguage.googleapis.com
                         ├─ Image gen/edit: check daily quota first
                         ├─ Success → record quota, return result
                         └─ Quota exceeded → return error with usage info
```

### Image Tools

| Setting | Value |
|---------|-------|
| Vision model (CPA) | `models.flash` or `gemini-3-flash` |
| Vision model (Gemini) | `gemini-2.5-flash` |
| Image gen model (CPA) | `models.flash-image` or `gemini-3.1-flash-image` |
| Image gen model (Gemini) | `gemini-3.1-flash-image-preview` |
| Max inline size | 20 MB (base64 inline) |
| Max Files API size | 200 MB (resumable upload) |
| Output truncation | 10,000 characters |
| Generated image saved to | `ATTACHMENTS_DIR` + registered in `files` table |

### Video Analysis Flow

```
read_video(file_id)
    │
    ├─ file ≤ 200 MB → Upload via Gemini Files API (polling until ACTIVE)
    │       ├─ Analysis OK → return result
    │       └─ Analysis fails → fallback ↓
    │
    └─ file > 200 MB → Frame extraction
            ├─ ffprobe → get duration
            ├─ ffmpeg → fps = max_frames/duration → extract JPEGs
            ├─ Gemini → analyze extracted frames as inline images
            └─ Cleanup temp frames directory
```

### Quota Tracking

- **Applies to**: Gemini API image generation and editing only
- **Not applied to**: CPA calls (CPA server manages its own limits)
- **Usage file**: `~/.clawd/usage.json` (atomic write on every update)
- **Default limit**: 50 images/day
- **Reset**: Midnight Pacific Time (Google's quota cycle)
- **Config**: `quotas.daily_image_limit` in `~/.clawd/config.json` (`0` = unlimited)

### Security

| Protection | Implementation |
|-----------|----------------|
| No path traversal | Tools accept `file_id` only; path resolved via DB lookup |
| Symlink-safe | `isPathSafe()` uses `realpathSync()` before directory check |
| API key sanitization | `sanitizeError()` strips keys from all error messages |
| Image base64 blocking | Three MCP handlers refuse to return image base64 (always redirect to `read_image`) |
| Input validation | `aspect_ratio` and `image_size` validated against allowlists |
| MIME defense-in-depth | All MIME checks use `.toLowerCase().startsWith()` in both handlers and helpers |

---

## 9. Agent Workspace System

### Architecture

```
Host Process (src/agent/)
├── WorkspaceToolPlugin
│   └── spawn_workspace → container.ts → Docker API
│
├── WorkspacePool (pool.ts)
│   ├── Pre-warmed containers (acquire in ~200ms vs 5-10s cold)
│   └── TCP probe health checks
│
├── MCPManager
│   └── HTTP connection per workspace (Bearer token auth)
│
└── gateway.ts → clawd-gateway (Caddy, port 7777)
        └── /{id}/* → clawd-ws-{id}:6080 (via Docker network DNS)

Workspace Container (clawd-workspace:base or :web3)
├── Ubuntu 24.04
├── Node.js 22 + Playwright 1.58.2
├── Chromium (persistent profile in named volume)
├── Xvfb :99 → x11vnc → noVNC :6080
├── Fluxbox window manager
└── Workspace MCP Server (Express, :3000)
    ├── Auth: WORKSPACE_AUTH_TOKEN (256-bit)
    ├── /health (unauthenticated)
    └── 14 tools (launch_browser, screenshot, click, ...)
```

### Container Lifecycle

```
spawnWorkspace()
  1. Allocate MCP port (pool: 6000–6099)
  2. docker volume create clawd-ws-data-{id}
  3. docker network create clawd-ws-net-{id}
  4. ensureGatewayRunning() — start Caddy if not running
  5. docker run [hardening flags] clawd-workspace:{image}
  6. waitForHealthy(): Docker HEALTHCHECK → TCP probe → HTTP 401
  7. connectWorkspaceToGateway(id):
     a. docker network connect clawd-ws-net-{id} clawd-gateway
     b. POST Caddy admin API: register route /{id}/* → clawd-ws-{id}:6080
  8. Register in MCPManager with auth token

destroyWorkspace()
  1. disconnectWorkspaceFromGateway(id):
     a. DELETE Caddy route /id/ws-{id}
     b. docker network disconnect clawd-ws-net-{id} clawd-gateway
  2. docker stop → docker rm
  3. docker volume rm clawd-ws-data-{id}
  4. docker network rm clawd-ws-net-{id}
  5. Release MCP port
  6. MCPManager.removeServer(workspace-{id})
```

### Caddy Gateway

noVNC ports are **not published to the host**. All desktop traffic routes through the Caddy gateway container:

```
Browser → /workspace/{id}/novnc/*
    → workspace-proxy.ts (src/server/routes/)
    → http://127.0.0.1:7777/{id}/{path}   (Caddy gateway)
    → clawd-ws-{id}:6080                  (via Docker bridge DNS)
```

- Caddy admin API (port 2019) is bound to `127.0.0.1` only
- Routes registered per-workspace on spawn, removed on destroy
- Reconciled from Docker inspect on process restart

### Isolation & Security

| Feature | Implementation |
|---------|----------------|
| Container hardening | `--cap-drop ALL --security-opt no-new-privileges --pids-limit 200 --tmpfs /tmp` |
| Network isolation | Per-workspace bridge network `clawd-ws-net-{id}` — containers cannot reach each other |
| Auth token | `randomBytes(32)` (256-bit entropy), injected as `WORKSPACE_AUTH_TOKEN` |
| Image allowlist | `clawd-workspace:{base,web3,devtools,office}` — LLM cannot pull arbitrary images |
| Port binding | MCP bound to `127.0.0.1:{6000-6099}` only; noVNC/VNC only inside Docker network |
| Credential injection | CPA key passed as env vars only — full `config.json` never mounted |

### Docker Images

| Image | Contents | Use Case |
|-------|----------|----------|
| `clawd-workspace:base` | Ubuntu 24.04, Chromium + Playwright, Xvfb, Fluxbox, noVNC, workspace MCP server | General browsing and automation |
| `clawd-workspace:web3` | base + MetaMask v12.0.0 (SHA256 verified) + Freighter v5.37.3 (SHA256 verified) | DeFi / blockchain / wallet tasks |

### Workspace Preview Card

When an agent calls `spawn_workspace`, it can include a workspace preview card in its message:

```json
{
  "workspace_id": "abc123def456...",
  "title": "Web3 Testing Workspace",
  "description": "MetaMask + Freighter installed",
  "status": "running"
}
```

The card appears in the chat UI with a colored border:
- 🟢 **Green** = `running` (desktop is live, click to open noVNC tab)
- 🟡 **Yellow** = `waiting` (container starting)
- ⚫ **Grey** = `completed` (workspace destroyed)

Clicking the card opens the noVNC desktop in a new browser tab at `/workspace/{id}/novnc/vnc.html`.

### Single-Workspace Constraint

Each agent session is limited to **one active workspace at a time**. This prevents MCP tool name collisions (all workspace MCP servers expose the same 14 tool names). To switch workspaces: call `destroy_workspace` first, then `spawn_workspace`.

---

## 10. LLM Provider System

### Configuration

Set the provider in `~/.clawd/config.json`:

```json
{
  "selected_provider": "copilot",
  "providers": {
    "copilot": {
      "model": "claude-sonnet-4-5",
      "token": "ghp_..."
    },
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-...",
      "model": "gpt-4o"
    },
    "anthropic": {
      "api_key": "sk-ant-...",
      "model": "claude-opus-4-5"
    },
    "cpa": {
      "base_url": "https://your-cpa-endpoint.com/v1",
      "api_key": "...",
      "models": {
        "flash-image": "gemini-3.1-flash-image",
        "flash": "gemini-3-flash"
      }
    }
  },
  "env": {
    "GEMINI_API_KEY": "AIza..."
  },
  "quotas": {
    "daily_image_limit": 50
  }
}
```

### Supported Providers

| Provider | Type | Notes |
|----------|------|-------|
| `copilot` | GitHub Copilot API | Recommended default; uses GitHub token |
| `openai` | OpenAI API | GPT-4o, o1, o3 etc. |
| `anthropic` | Anthropic API | Claude Opus/Sonnet/Haiku |
| `cpa` | CLIProxyAPI (OpenAI-compatible) | Proxies to Antigravity/Gemini; primary for image tools |

CPA is an [OpenAI-compatible proxy](https://github.com/router-for-me/CLIProxyAPI) that routes to multiple backends. It is the **primary provider for image tools** (if configured).

---

## 11. Chat UI

Built with React 18 + Vite, embedded into the server binary via `scripts/embed-ui.ts`.

### Key Components

| Component | Purpose |
|-----------|---------|
| `App.tsx` | Root: channel list, multi-channel subscriptions, real-time WS |
| `MessageList.tsx` | Render messages with reactions, agent metadata, workspace cards, subspace cards, article cards |
| `MessageComposer.tsx` | Input with file upload, mention support, markdown preview |
| `PlanModal.tsx` | Create/view multi-phase plans and tasks |
| `AgentDialog.tsx` | Configure agent (provider, model, system prompt) |
| `SearchModal.tsx` | Full-text search across history |
| `ProjectsDialog.tsx` | Workspace/project selector |
| `ArticleModal.tsx` | Blog post editor |
| `MarkdownContent.tsx` | Code highlighting + LaTeX math rendering |

### Workspace Card (MessageList)

```tsx
<div className="message-workspace-card workspace-card-{running|waiting|completed}"
     onClick={() => window.open(`/workspace/${id}/novnc/vnc.html?autoconnect=1&resize=scale`)}>
  <div className="workspace-card-icon">🖥️</div>
  <div className="workspace-card-content">
    <div className="workspace-card-title">{title}</div>
    <div className="workspace-card-description">{description}</div>
    <div className="workspace-card-action">Open Desktop →</div>
  </div>
  <div className="workspace-status-dot workspace-status-{running|waiting|completed}" />
</div>
```

---

## 12. Build & Run

### Quick Start

```bash
# Install Bun (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Configure
cat > ~/.clawd/config.json <<'EOF'
{
  "selected_provider": "copilot",
  "providers": {
    "copilot": { "model": "claude-sonnet-4-5", "token": "ghp_..." }
  }
}
EOF

# Build workspace Docker image
docker build -t clawd-workspace:base .
docker build -f Dockerfile.web3 -t clawd-workspace:web3 .

# Build and run
bun run build
./dist/server/clawd-app --port 3456
```

### CLI Options

```
clawd-app [options]
  --host <host>   Bind address (default: 0.0.0.0)
  -p, --port <n>  Port number (default: 3456)
  --no-browser    Don't auto-open browser
  --yolo          Disable sandbox restrictions for agents
  --debug         Enable verbose debug logging
  -h, --help      Show help
```

### Build Commands

| Command | Output |
|---------|--------|
| `bun run dev` | Run server directly (no compile) |
| `bun run build` | UI + current-platform binary |
| `bun run build:all` | UI + all 5 platform binaries |
| `bun run build:linux` | Linux x64 + arm64 |
| `bun run install:local` | Copy to `~/.clawd/bin/clawd-app` |

---

## 13. Configuration Reference

`~/.clawd/config.json` — full reference:

```json
{
  "selected_provider": "copilot",

  "providers": {
    "copilot": { "model": "claude-sonnet-4-5", "token": "ghp_..." },
    "openai": { "base_url": "...", "api_key": "...", "model": "gpt-4o" },
    "anthropic": { "api_key": "...", "model": "claude-opus-4-5" },
    "cpa": {
      "base_url": "https://your-cpa.com/v1",
      "api_key": "...",
      "models": {
        "flash": "gemini-3-flash",
        "flash-image": "gemini-3.1-flash-image"
      }
    }
  },

  "env": {
    "GEMINI_API_KEY": "AIza..."
  },

  "quotas": {
    "daily_image_limit": 50
  },

  "server": {
    "port": 3456,
    "host": "0.0.0.0"
  },

  "workspace": {
    "pool_size": 1,
    "memory": "2g",
    "cpus": "1.5",
    "default_image": "clawd-workspace:base"
  },

  "mcp_servers": {
    "filesystem": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-filesystem", "/home/user/projects"]
    }
  }
}
```

---

## 14. Example Agent Interactions

These examples show how agents use Claw'd tools to complete real tasks. Each shows the user's question, the agent's reasoning path, and the expected outcome.

---

### Example 1: "Sign up for a GitHub account"

**User:** Hey, can you sign up for a GitHub account for me?

**Agent behavior:**
1. Calls `spawn_workspace` (image: `base`) → starts a fresh Chromium container
2. Sends a workspace card message: "I've started a workspace. I'll need your help entering personal info — click to open the desktop."
3. Calls `launch_browser` with `https://github.com/signup`
4. Calls `snapshot` to read the form structure
5. Calls `type_text` to fill in the username and email fields
6. Calls `pause_for_human` with message: "Please enter your password in the workspace — I can't handle passwords securely."
7. After user completes, calls `click` to submit, `screenshot` + `read_image` to verify the confirmation page
8. Reports success with account details back to chat
9. Calls `destroy_workspace`

**What the user sees:** A green workspace card in chat. Clicking it opens the noVNC desktop in a new tab. The agent guides them step by step.

---

### Example 2: "Install MetaMask and verify my wallet can connect to our dapp"

**User:** Install MetaMask, import my wallet using this seed phrase: `word1 word2 ... word12`, then go to https://app.our-dapp.com and verify the Connect Wallet button works.

**Agent behavior:**
1. Calls `spawn_workspace` with `image: "web3"` (MetaMask pre-installed)
2. Calls `launch_browser` with `chrome://extensions/` to verify MetaMask is loaded
3. Calls `observe` to visually confirm extension icons
4. Calls `click` on MetaMask extension icon (by description: "MetaMask fox icon in toolbar")
5. Calls `type_text` with `use_xdotool: true` to type seed phrase in the extension popup
6. Calls `press_key` with `Enter`, waits for wallet setup
7. Calls `navigate` to `https://app.our-dapp.com`
8. Calls `click` on "Connect Wallet"
9. Calls `observe` to see the MetaMask approval popup
10. Calls `click` to approve
11. Calls `screenshot` + `read_image` to verify wallet address appears on the page
12. Reports: "Successfully connected wallet 0xABC... to app.our-dapp.com"

---

### Example 3: "Analyze this screenshot I uploaded"

**User:** *(uploads a PNG screenshot)* Can you tell me what's wrong with the UI in this image?

**Agent behavior:**
1. Calls `chat_get_message_files` → receives `{ file_id: "F-abc123", image_hint: "This is an image... use read_image tool" }`
2. Calls `read_image` with `file_id: "F-abc123"`, `prompt: "Identify any UI problems, layout issues, or visual bugs in this interface"`
3. Receives detailed text analysis from Gemini vision
4. Calls `chat_send_message` with a structured response listing the issues

**What prevents problems:** The agent never sees the raw base64 — `chat_download_file` and `chat_get_message_files` both redirect to `read_image`. This prevents context overflow from large images.

---

### Example 4: "Generate a hero banner for our website"

**User:** Create a hero banner image for our fintech startup. Dark theme, cityscape at night, with subtle blue glow. 16:9 ratio.

**Agent behavior:**
1. Calls `create_image` with:
   ```json
   {
     "prompt": "Hero banner for a fintech startup. Dark theme, nighttime city skyline with subtle electric blue neon glow. Professional, modern, cinematic lighting. Ultra-wide panoramic composition.",
     "aspect_ratio": "16:9",
     "image_size": "2K"
   }
   ```
2. If CPA is configured → request goes to `gemini-3.1-flash-image` via CPA proxy
3. Image saved to `ATTACHMENTS_DIR`, registered in `files` table with ID `F-xyz789`
4. Response: `{ ok: true, image: { id: "F-xyz789", name: "generated-1709...", ... }, quota: { used: 1, limit: 50, remaining: 49 } }`
5. Calls `chat_send_message_with_files` to share the image in chat

---

### Example 5: "Schedule a daily standup summary"

**User:** Every weekday morning at 9 AM, summarize what the team worked on yesterday and post it to the #general channel.

**Agent behavior:**
1. Calls `scheduler_create` with:
   ```json
   {
     "cron": "0 9 * * 1-5",
     "channel": "general",
     "action": "summarize_yesterday",
     "description": "Daily standup summary"
   }
   ```
2. On each trigger:
   - Calls `chat_get_history` for the previous day's messages
   - Calls `chat_get_last_summary` for any stored context
   - Constructs standup summary
   - Calls `chat_send_message` to post
3. Confirms: "Scheduled! I'll post standup summaries every weekday at 9 AM."

---

### Example 6: "Create a plan and execute Phase 1"

**User:** Make a plan to migrate our database from PostgreSQL to SQLite. Execute the first phase.

**Agent behavior:**
1. Calls `plan_create` with title "PostgreSQL → SQLite Migration", description, and phases
2. Calls `plan_add_phase` for each phase (Schema Analysis, Data Export, Import & Verify, Cutover)
3. Calls `plan_update_phase` on Phase 1 to mark as in-progress
4. **Executes Phase 1** using other tools: reads schema files, analyzes tables, generates SQLite DDL
5. Posts progress updates to chat via `chat_send_message`
6. Calls `plan_update_phase` to mark Phase 1 complete
7. Asks user: "Phase 1 complete — schema analysis done. Ready to proceed to Phase 2 (Data Export)?"

---

### Example 7: "Watch this recording and tell me what the bug is"

**User:** *(uploads a screen recording .mp4)* There's a weird bug when clicking the dropdown. Can you identify it?

**Agent behavior:**
1. Calls `chat_get_message_files` → gets `file_id: "F-vid001"` with video metadata
2. Calls `read_video` with:
   ```json
   {
     "file_id": "F-vid001",
     "prompt": "Identify any bugs, unexpected behavior, or UI glitches when the user interacts with the dropdown",
     "max_frames": 60
   }
   ```
3. If video ≤ 200MB → uploads to Gemini Files API, analyzes natively
4. If video > 200MB → extracts frames with ffmpeg, analyzes keyframes
5. Reports: "At 0:04, after clicking the dropdown, it flickers and re-renders twice before showing options. This looks like a state update triggering an unnecessary re-render on the parent component."

---

### Example 8: "Monitor a page and alert me when the price drops"

**User:** Watch https://shop.example.com/product/123 and send me a message when the price drops below $50.

**Agent behavior:**
1. Calls `scheduler_create` with a 15-minute interval job
2. On each run:
   - Calls `spawn_workspace`
   - Calls `navigate` to the product URL
   - Calls `snapshot` to extract the price element
   - Parses the price
   - If price < $50: calls `chat_send_message` "⚡ Price alert: $item dropped to $48.99!"
   - Calls `destroy_workspace`
3. Confirms: "I'll check the price every 15 minutes and alert you when it drops below $50."

---

### Tool Availability Summary

| Context | Available Tools |
|---------|----------------|
| Always | 16 chat/file tools + 8 plan tools + 4 scheduler tools + 4 multimodal tools |
| After `spawn_workspace` | + 14 workspace desktop tools |
| With CPA configured | Image tools use CPA as primary |
| With Gemini API key | Image tools use Gemini as fallback (quota-tracked) |
| `--yolo` mode | Sandbox restrictions lifted |

