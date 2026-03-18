# Claw'd Codebase Summary

> Generated: 2026-03-18 | Total Files: ~260 | Total Tokens: 1,173,410 | Codebase size: 4.8M chars

---

## Executive Summary

Claw'd is a sophisticated open-source agentic collaborative chat platform built with **Bun** (TypeScript), compiling to a single binary that runs an HTTP+WebSocket server. The system orchestrates multiple AI agents across channels, providing real-time collaboration, browser automation via Chrome extension, sandboxed code execution, and advanced features like heartbeat monitoring, artifact rendering, and memory persistence.

**Key Stats:**
- Single binary deployment with embedded React UI + browser extension
- 260 total files, 1.1M+ tokens
- Multi-provider LLM support (Copilot, OpenAI, Anthropic, Ollama, Minimax)
- 26 browser automation tools (CDP + stealth modes)
- 7 artifact types for rich visualization
- 3-tier agent memory system (session, knowledge base, long-term)
- Sub-agent spaces for parallel execution
- Scheduled task system (cron/interval/once)

---

## System Architecture

### High-Level Flow

```
User Browser (React SPA)
    ↓ HTTP/WebSocket
Claw'd Server (src/index.ts)
    ├─ Chat API (/api/*)
    ├─ Agent Loops (per-channel workers)
    ├─ WebSocket Events (/ws)
    ├─ MCP Endpoint (/mcp)
    └─ Browser Bridge (/browser/ws)
         ↓ WebSocket
Chrome Extension (packages/browser-extension/)
```

### Core Components

| Component | Purpose | Key Files |
|-----------|---------|-----------|
| **Server** | HTTP+WebSocket, route handling, API | `src/index.ts`, `src/server/` |
| **Agent System** | Multi-agent orchestration, reasoning loop | `src/worker-loop.ts`, `src/agent/src/` |
| **Database** | SQLite (chat.db, memory.db, kanban.db) | `src/server/database.ts` |
| **Browser Automation** | Chrome extension bridge + 26 tools | `packages/browser-extension/`, `src/server/browser-bridge.ts` |
| **Sub-Agents** | Parallel task delegation (Spaces) | `src/spaces/` |
| **Scheduler** | Cron/interval/once jobs | `src/scheduler/` |
| **UI** | React SPA with artifacts, websocket handling | `packages/ui/` |

---

## Directory Structure

```
clawd/
├── src/                              # Main application
│   ├── index.ts                      # Server entry point (HTTP/WS)
│   ├── config.ts                     # CLI flag parser
│   ├── config-file.ts                # ~/.clawd/config.json loader
│   ├── worker-loop.ts                # Per-agent polling loop (200ms)
│   ├── worker-manager.ts             # Multi-agent orchestrator + heartbeat monitor
│   ├── server/
│   │   ├── database.ts               # chat.db SQLite schema/migrations
│   │   ├── websocket.ts              # WebSocket broadcasting
│   │   ├── browser-bridge.ts         # Browser extension WS bridge
│   │   ├── remote-worker.ts          # Remote worker bridge
│   │   └── routes/                   # API endpoint handlers
│   ├── agent/src/                    # Agent system
│   │   ├── agent/agent.ts            # Core Agent class, reasoning loop
│   │   ├── memory/                   # session.ts, knowledge-base.ts, agent-memory.ts
│   │   ├── session/                  # Session manager, checkpoints, summarizer
│   │   ├── plugins/                  # ToolPlugin/Plugin system
│   │   │   ├── browser-plugin.ts     # 26 browser tools
│   │   │   ├── workspace-plugin.ts   # Workspace/docker integration
│   │   │   ├── clawd-agent-bus/      # Agent-to-agent communication
│   │   │   └── ...                   # Other plugins
│   │   ├── mcp/                      # MCP client connections
│   │   ├── tools/                    # Tool execution system
│   │   ├── api/                      # LLM provider factory, key pool
│   │   └── utils/                    # sandbox.ts, debug, context helpers
│   ├── spaces/                       # Sub-agent system
│   │   ├── manager.ts                # Space lifecycle
│   │   ├── worker.ts                 # Space worker orchestrator
│   │   └── plugin.ts                 # spawn_agent, respond_to_parent
│   ├── scheduler/                    # Job scheduling
│   │   ├── manager.ts                # Tick loop (10s interval)
│   │   ├── runner.ts                 # Job executor
│   │   └── parse-schedule.ts         # Natural language parser
│   ├── analytics/                    # API call tracking (Copilot)
│   └── api/                          # Agent registration, MCP, articles
├── packages/
│   ├── ui/                           # React SPA (Vite)
│   │   ├── src/
│   │   │   ├── App.tsx               # Main app, routing, WS setup
│   │   │   ├── MessageList.tsx       # Message display, mermaid rendering
│   │   │   ├── artifact-*.tsx        # Artifact rendering system
│   │   │   ├── chart-renderer.tsx    # Recharts integration
│   │   │   ├── file-preview.tsx      # File preview cards
│   │   │   ├── SidebarPanel.tsx      # Sidebar for artifacts/files
│   │   │   ├── SkillsDialog.tsx      # Skill management UI
│   │   │   ├── AgentDialog.tsx       # Agent config (heartbeat, model, etc.)
│   │   │   ├── auth-fetch.ts         # Token-based auth wrapper
│   │   │   └── styles.css            # All styles
│   │   └── public/                   # Static assets
│   ├── browser-extension/            # Chrome MV3 extension
│   │   ├── manifest.json             # Extension manifest
│   │   └── src/
│   │       ├── service-worker.js     # ~2800 lines, CDP/stealth dispatcher
│   │       ├── content-script.js     # DOM extraction
│   │       ├── offscreen.js          # Persistent WS connection
│   │       ├── popup.js              # Extension UI
│   │       └── shield.js             # Anti-detection patches
│   └── clawd-worker/                 # Remote worker implementations
│       ├── typescript/remote-worker.ts # Bun/Node.js client
│       ├── python/remote_worker.py    # Zero-dependency Python client
│       └── java/RemoteWorker.java     # Zero-dependency Java client
├── scripts/
│   ├── embed-ui.ts                   # Embeds React build into binary
│   ├── zip-extension.ts              # Packs extension into binary
│   └── ...
├── docs/                             # Documentation
│   ├── architecture.md               # Comprehensive architecture reference
│   ├── artifacts.md                  # Artifact protocol guide
│   └── ...
├── Dockerfile                        # Multi-stage Docker build
├── compose.yaml                      # Docker Compose deployment
└── README.md                         # Main project documentation
```

---

## Agent System Architecture

### Worker Loop (`src/worker-loop.ts`)

Each agent runs an independent polling loop:

1. **Poll** — Check for new messages every 200ms
2. **Build Prompt** — Assemble system context, memory, tools
3. **Call LLM** — Stream response from configured provider
4. **Parse Tools** — Extract and execute tool calls
5. **Post Results** — Inject tool outputs back into conversation
6. **Repeat** — Continue until no more tool calls

Key behaviors:
- Transient LLM failures trigger auto-retry with exponential backoff
- New user messages can interrupt in-progress turns
- Tool execution runs in sandboxed environment (bubblewrap/sandbox-exec)

### Agent Class (`src/agent/src/agent/agent.ts`)

Core reasoning engine with:
- Plugin system for tool extensions
- Token management & context compaction
- Session memory with FTS5 search
- Knowledge base retrieval
- Long-term agent memory

**System Prompt Injection:**
- `<agent_signal>[HEARTBEAT]</agent_signal>` — Wake signal for idle agents (user-role message, stripped during compaction)
- Memory context — Relevant agent memories inserted
- Knowledge chunks — Retrieved via semantic search
- Tool definitions — Updated based on usage patterns (tool filtering)

### Plugin System

All agent capabilities extend via two interfaces:

**ToolPlugin** — Adds tools
```typescript
interface ToolPlugin {
  getTools(): Tool[]
  beforeExecute?(toolCall: ToolCall): void
  afterExecute?(toolCall: ToolCall, result: unknown): void
}
```

**Plugin** — Lifecycle hooks
```typescript
interface Plugin {
  onUserMessage?(message: Message): void
  onToolCall?(toolCall: ToolCall): void
  getSystemContext?(): string
}
```

Built-in plugins: browser, workspace, context-mode, state-persistence, spawn-agent, scheduler, memory, custom-tool, clawd-agent-bus, mcp-client.

### Heartbeat Monitor (`src/worker-manager.ts`)

Background health system for stuck-agent recovery:

- **Injects `<agent_signal>[HEARTBEAT]</agent_signal>`** into idle agents as a user-role message (configurable interval, default 30s)
- **Cancels stuck agents** exceeding processing timeout (default 5 min)
- **Monitors sub-agents** — fails after 10 consecutive heartbeats with no progress
- **WebSocket events** — `heartbeat_sent`, `agent_wakeup`, `space_failed`

Configuration (config.json):
```jsonc
"heartbeat": {
  "enabled": true,
  "intervalMs": 30000,
  "processingTimeoutMs": 300000,
  "spaceIdleTimeoutMs": 60000
}
```

### Model Tiering & Tool Filtering

- **Auto-downgrade to Haiku** for tool routing decisions (faster, cheaper)
- **Usage-based pruning** — agents auto-drop unused tools after warmup
- **Prompt caching** — Anthropic beta header for cache hits (reduces tokens/latency)

---

## Browser Automation

### Chrome Extension (`packages/browser-extension/`)

MV3 extension with two operation modes:

**CDP Mode (Normal):**
- Uses `chrome.debugger` API for full control
- Visible to anti-bot detection
- Supports all 26 tools + screenshots + accessibility tree
- Supports file uploads, drag/touch, keyboard

**Stealth Mode (Anti-Detection):**
- Uses `chrome.scripting.executeScript()` for hidden operation
- Invisible to bot detection
- Screenshots via `html2canvas`
- Limited to basic actions (click, type, scroll)

### 26 Browser Tools

| Category | Tools | Notes |
|----------|-------|-------|
| **Navigation** | navigate, history, tabs | Tab management, URL handling |
| **Input** | type, click, select, upload_file | Form interaction |
| **Visual** | screenshot, scroll, hover, mouse_move | Page observation, mouse control |
| **Extraction** | extract, frames | DOM querying, iframe handling |
| **Execution** | execute, store | JavaScript execution, script storage |
| **Advanced** | drag, touch, keypress, wait_for | Advanced interactions |
| **Dialogs** | handle_dialog, auth, permissions | Dialog/auth/permission handling |
| **Download** | download, cookies, emulate | File/cookie management, device emulation |

### Document Conversion Tool

`convert_to_markdown` — Converts document files to Markdown and saves to `{projectRoot}/.clawd/files/{name}.md`:

- **Supported formats**: PDF, DOCX, XLSX, PPTX, HTML, EPUB, CSV, TSV, plain text
- **Dependencies**: unpdf (PDF), mammoth (DOCX), exceljs (XLSX), jszip (PPTX/EPUB), turndown (HTML→MD)
- **Limits**: 50MB max file size, 5M char default maxLength, 30s conversion timeout
- **Features**:
  - Magic-byte format detection fallback
  - Binary file guard for text-expected formats
  - Progressive truncation with [TRUNCATED] markers
  - Zip bomb protection (200MB decompressed limit)
  - Pipe escaping in Markdown tables, TSV tab delimiter support
  - XML entity decoding for PPTX/EPUB
- **Security**: Path validation via resolve()+validatePath(), isFile() guard, async file I/O
- **Output**: Saves .md file, returns hint with path; agents use `view()` to read converted content

### Anti-Detection Shield (`shield.js`)

Patches injected at document_start:
- `navigator.webdriver` → false
- DevTools detection bypass
- `Function.prototype.toString` spoofing
- `performance.now()` timing normalization

### Browser Bridge (`src/server/browser-bridge.ts`)

WebSocket bridge between agents and extension:
- Command dispatch to extension
- Result collection
- 30s per-command timeout
- Extension health monitoring (45s heartbeat timeout)
- Per-channel auth token validation

---

## Database Schema

### chat.db — Chat & Agent State

Main database for all conversation and agent state:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `channels` | Chat channels | id, name, created_by |
| `messages` | Chat messages | ts (PK), channel, user, text, agent_id |
| `files` | File attachments | id, name, mimetype, size, path, message_ts |
| `agents` | Agent registry | id, channel, display_name, avatar_color |
| `channel_agents` | Agent ↔ channel mapping | channel, agent_id, provider, model, project, worker_token, heartbeat_interval |
| `agent_seen` | Read tracking | agent_id, channel, last_seen_ts, last_processed_ts |
| `agent_status` | Agent status per channel | agent_id, channel, status, hibernate_until |
| `summaries` | Context compression | id, channel, agent_id, summary_type, content |
| `spaces` | Sub-agent spaces | id (space_channel), parent_channel, parent_agent, created_at, timeout_at |
| `articles` | Knowledge articles | id, channel, title, body, created_by |
| `copilot_calls` | API analytics | timestamp, method, model, tokens_used |
| `users` | User records | id, name, avatar |
| `message_seen` | User read tracking | ts, channel, user |

### memory.db — LLM Session Memory

Separate database for session context and long-term memories:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `sessions` | LLM conversation sessions | id, name (format: `{channel}-{agentId}`), model |
| `messages` | Session messages | session_id, role, content, tool_calls, tool_call_id |
| `messages_fts` | Full-text search on messages | (FTS5 index) |
| `knowledge` | Indexed tool output chunks | id, session_id, source_id, tool_name, chunk_index, content |
| `knowledge_fts` | Full-text search on knowledge | (FTS5 index) |
| `agent_memories` | Long-term facts/preferences | agent_id, content, channel, category, source, access_count |
| `agent_memories_fts` | Full-text search on memories | (FTS5 index) |

### kanban.db — Tasks & Plans

Task and project management database:

| Table | Purpose |
|-------|---------|
| `tasks` | Kanban tasks (status, assignee, priority, due dates) |
| `plans` | Plan documents with phases |
| `phases` | Plan phases/milestones |
| `plan_tasks` | Task-to-phase linkage |

### scheduler.db — Scheduled Jobs

Job scheduling and execution history:

| Table | Purpose |
|-------|---------|
| `scheduled_jobs` | Cron/interval/once/reminder/tool_call jobs |
| `job_runs` | Execution history with timestamps and results |

---

## Sub-Agent System (Spaces)

### Space Lifecycle

Agents delegate work via `spawn_agent(task, name)`:

1. Create isolated channel `{parent}:space:{uuid}`
2. Sub-agent inherits parent's project, provider, model
3. Sub-agent processes task independently
4. Sub-agent reports results via `respond_to_parent(result)`
5. Space auto-cleans after completion or timeout (default 300s, configurable to 600s)

**Constraints:**
- Max 5 concurrent spaces per channel
- Max 20 concurrent spaces globally
- Circuit breaker: fail after 10 consecutive heartbeats with no progress

### Scheduler Integration

Jobs create sub-spaces for execution:
- **Cron jobs** — Execute on schedule, results posted to channel
- **Interval jobs** — Run repeatedly
- **Once jobs** — One-time execution
- **Reminders** — Post messages without sub-spaces
- **Tool calls** — Execute tools directly

Tick loop: 10s intervals, max 3 concurrent jobs globally.

---

## API & Communication

### HTTP REST API (`/api/*`)

All endpoints use POST by default (GET where noted). Key groups:

| Group | Purpose | Auth Required |
|-------|---------|---------------|
| Chat | Message CRUD, search, history | Yes (if enabled) |
| Agents | Agent registration, config, status | Yes |
| Files | Upload, download, metadata | Yes |
| Streaming | Streaming tokens, tool calls, thoughts | Yes |
| MCP | MCP server management | Yes |
| Browser | Browser extension commands | Yes (per-channel) |
| Spaces | Sub-agent space info | Yes |
| Tasks | Task/kanban management | Yes |
| Skills | Skill management | Yes |
| Analytics | API call tracking (Copilot) | Yes |
| Admin | Config reload, key sync, migrations | Yes |

### WebSocket Events (`/ws`)

Server → Client real-time events:

| Event | Payload | Triggers When |
|-------|---------|---|
| `message` | Chat message object | New message posted |
| `message_changed` | Updated message | Message edited |
| `message` (with `deleted`) | Delete marker | Message removed |
| `agent_streaming` | Agent ID, streaming flag | Agent starts/stops thinking |
| `agent_token` | Token, type (content/thinking) | LLM streaming output |
| `agent_tool_call` | Tool, status | Tool execution event |
| `reaction_added/removed` | Reaction emoji | User reacts to message |
| `message_seen` | User, timestamp | Read receipt |
| `heartbeat_sent` | Agent ID, channel | Heartbeat injected |
| `agent_wakeup` | Agent ID, channel | Agent activated |
| `space_failed` | Space channel, reason | Sub-agent timeout/error |

### Authentication

Optional token-based API auth (config.json):
```jsonc
"auth": {
  "token": "your-secret-token"
}
```

All API requests require header:
```
Authorization: Bearer <token>
```

Per-channel browser auth:
```jsonc
"browser": {
  "channel1": ["auth_token_1", "auth_token_2"]
}
```

---

## Artifact Rendering

### 7 Artifact Types

Agents output `<artifact type="TYPE">CONTENT</artifact>` for rich visualization:

| Type | Rendering | Security |
|------|-----------|----------|
| `html` | Sandboxed iframe | DOMPurify sanitization |
| `react` | Babel + Tailwind sandbox | No DOM/cookie access |
| `svg` | Inline rendering | DOMPurify + rehype-sanitize |
| `chart` | Recharts (6 types) | No network, max 1000 points |
| `csv` | Sortable table | Escaped content |
| `markdown` | Full pipeline | rehype-sanitize filtering |
| `code` | Prism highlighting (32+ languages) | Read-only |

### Chart Types

- **Line** — X/Y scatter with line interpolation
- **Bar** — Grouped/stacked bars
- **Pie** — Circular segments with labels
- **Area** — Stacked area chart
- **Scatter** — Point cloud visualization
- **Composed** — Mixed chart types (line + bar, etc.)

Config format:
```json
{
  "type": "line",
  "data": [{"x": "Jan", "y": 100}],
  "xKey": "x",
  "series": [{"key": "y", "name": "Sales"}],
  "title": "Title"
}
```

### Rendering Locations

- **Inline in message**: chart (Recharts), svg (DOMPurify), code (Prism)
- **Sidebar panel** (click preview card): html, react, csv, markdown

---

## LLM Providers

### Supported Providers

| Provider | Type | Notes |
|----------|------|-------|
| `copilot` | GitHub Copilot API | Recommended; uses GitHub token |
| `openai` | OpenAI API | GPT-4o, o1, o3 |
| `anthropic` | Anthropic API | Claude (Opus, Sonnet, Haiku) |
| `ollama` | Local Ollama | Self-hosted LLMs |
| `minimax` | MiniMax API | Vision + text models |
| Custom | OpenAI-compatible | groq, together.ai, etc. |

### Key Pool & Rotation

- API keys can be rotated via key pool (single key or array)
- Key health monitoring
- Fallback to next key on failure
- Analytics tracking per key

### Model Tiering

- **Main LLM** — Configured model (Opus, Sonnet, GPT-4o)
- **Tool routing** — Auto-downgrade to Haiku (faster, cheaper decisions)
- **Memory extraction** — Configurable provider/model

### Prompt Caching

Anthropic beta header for cache hits:
- Reduces tokens on repeated long context
- Cache key: hash of system prompt + context blocks
- Supported on Opus 4, Sonnet 4, Haiku 4

---

## Build & Deployment

### Build Pipeline

1. **Vite build** — React SPA → `packages/ui/dist/`
2. **embed-ui.ts** — Base64 embeds UI into `src/embedded-ui.ts`
3. **zip-extension.ts** — Packs extension → `src/embedded-extension.ts`
4. **bun build --compile** — Produces single binary `dist/server/clawd-app`

### Single Binary

Compiled executable includes:
- Embedded React SPA
- Embedded Chrome MV3 extension (zipped, base64)
- All TypeScript code (AOT compiled)
- SQLite runtime
- Node.js compatibility layer

### Docker Deployment

Multi-stage Dockerfile:
1. **Build stage** (oven/bun:1) — Install, build, compile
2. **Runtime stage** (debian:bookworm-slim) — Minimal runtime with git, ripgrep, python3, tmux, bubblewrap, curl, openssh, bun, rust

Requires Docker flags for bwrap sandbox:
```yaml
security_opt:
  - apparmor=unconfined
  - seccomp=unconfined
```

---

## Configuration

### CLI Flags

```sh
clawd-app [options]
  --host <host>       Server bind address (default: 0.0.0.0)
  -p, --port <port>   Server port (default: 3456)
  --debug             Enable debug logging
  --yolo              Disable sandbox restrictions for agents
  --no-browser         Don't open browser on startup
  -h, --help          Show help
```

### config.json Schema

Main configuration file at `~/.clawd/config.json`:

```jsonc
{
  // Server settings
  "host": "0.0.0.0",
  "port": 3456,
  "debug": false,
  "yolo": false,
  "dataDir": "~/.clawd/data",

  // Environment variables for agents
  "env": { "KEY": "VALUE" },

  // LLM providers
  "providers": {
    "copilot": { "api_key": "ghp_...", "models": { "default": "claude-opus-4.6" } },
    "openai": { "base_url": "https://api.openai.com/v1", "api_key": "sk-..." }
  },

  // Quotas
  "quotas": { "daily_image_limit": 50 },

  // Features
  "workspaces": true,        // Docker workspace support
  "worker": true,            // Remote worker support
  "memory": true,            // Agent memory system
  "browser": true,           // Browser extension

  // Vision models
  "vision": {
    "read_image": { "provider": "copilot", "model": "gpt-4.1" },
    "generate_image": { "provider": "minimax", "model": "image-01" }
  },

  // Heartbeat monitor
  "heartbeat": {
    "enabled": true,
    "intervalMs": 30000,
    "processingTimeoutMs": 300000
  },

  // API authentication
  "auth": {
    "token": "your-secret-token"
  }
}
```

### System Files

```
~/.clawd/
├── config.json                 # Application config
├── .env                        # Agent environment variables
├── .ssh/id_ed25519             # SSH key for Git operations
├── .gitconfig                  # Git user config
├── bin/                        # Custom executables in agent PATH
├── skills/                     # Global custom skills (4 source directories)
├── data/
│   ├── chat.db                 # Chat state
│   ├── kanban.db               # Tasks/plans
│   ├── scheduler.db            # Scheduled jobs
│   └── attachments/            # File uploads
├── memory.db                   # LLM sessions & memories
└── mcp-oauth-tokens.json       # OAuth token cache
```

---

## Code Standards

### Language & Framework

- **TypeScript** — Strict mode, strict null checks
- **Bun** — Runtime, bundler, package manager (v1.3.9+)
- **SQLite** — WAL mode for concurrent access
- **React 18** — SPA UI with Vite
- **Zero frameworks** — No ORM, no Express, no complex abstractions

### Key Conventions

- **File naming** — kebab-case with descriptive names
- **Function names** — camelCase
- **Type definitions** — Explicit return types on all functions
- **Error handling** — try-catch with specific error messages
- **Plugin system** — All extensions via ToolPlugin/Plugin interfaces
- **Database** — Prepared statements, parameterized queries
- **Environment** — Config files over environment variables (except secrets)

### File Organization

- **Single responsibility** — Each file handles one clear concern
- **Max 200 lines per file** — Split large files into smaller modules
- **Exports** — Named exports preferred over default exports
- **Comments** — JSDoc on public APIs, inline comments for complex logic

---

## Execution Environment

### Sandboxing

All tool execution runs in isolated sandboxes:

**Linux:**
- **bubblewrap (bwrap)** — Namespace isolation, deny-by-default
- Read/write: `{projectRoot}`, `/tmp`, `~/.clawd`
- Read-only: `/usr`, `/bin`, `/lib`, `/etc`, runtime directories
- Blocked: `.clawd/` (config), home directory (except tool dirs)

**macOS:**
- **sandbox-exec** — Seatbelt profiles
- Similar access policy via ACLs
- File system operations isolated

### Tool Execution

- **Timeout** — 30s default (max 300s)
- **Input** — JSON via stdin
- **Output** — Captured stdout/stderr
- **Interrupts** — Handled gracefully
- **Retries** — Automatic with exponential backoff

---

## Testing & Quality

### Compilation

- **TypeScript** → JavaScript via Bun
- **Strict mode** — All files compile without errors
- **No unused variables** — Biome linting
- **Type safety** — Strict null checks, strict mode

### Biome Configuration

Located in `biome.json`:
- Linting rules for TypeScript/JSX
- Formatting defaults
- Import sorting
- No console.log in production (selectively allowed)

### Monitoring

- **Debug logging** — Configurable via `--debug` flag
- **Heartbeat monitoring** — Health checks every 30s
- **WebSocket monitoring** — Extension connection health
- **Metrics** — API call analytics and key health

---

## Dependencies

### Production

- `bun:sqlite` — SQLite driver (built-in to Bun)
- `react` — React 18
- `vite` — Build tool
- `prismjs` — Code syntax highlighting
- `recharts` — Chart rendering
- `mermaid` — Diagram rendering
- `dompurify` — HTML sanitization
- `rehype-sanitize` — Markdown sanitization
- `unpdf` — PDF text extraction
- `exceljs` — XLSX spreadsheet parsing
- `mammoth` — DOCX conversion
- `turndown` — HTML → Markdown conversion
- `jszip` — ZIP/PPTX/EPUB handling
- `sharp` — Image processing

### Development

- `biome` — Linting & formatting
- `typescript` — Type checking

### Minimal External Dependencies

- No ORM (direct SQL)
- No Express (Bun HTTP server)
- No Redux (simple state management)
- No build frameworks (Bun native)

---

## Security Considerations

### Code Execution

- **Sandboxing** — All agent tools run in isolated namespaces
- **Path validation** — Strict project root checking
- **Process limits** — Timeout + signal handling
- **I/O restrictions** — Limited filesystem + network access

### Data Protection

- **Secrets** — Stored in ~/.clawd/.env (never exposed to agents)
- **Database** — SQLite with WAL mode, transaction safety
- **Auth tokens** — Hashed, compared with constant-time functions
- **API keys** — Stored in config, rotated per-key health

### Artifact Security

- **HTML sanitization** — DOMPurify removes dangerous scripts
- **Iframe sandboxing** — `sandbox="allow-scripts"` blocks DOM/cookie access
- **Content-Security-Policy** — Blocks external resource loading from artifacts
- **Input validation** — JSON parsing, size limits

### Transport

- **WebSocket** — Same-origin enforcement
- **HTTPS** — Recommended for production deployments
- **CORS** — Limited to server origin
- **Auth headers** — Token validation on every API call

---

## Performance

### Optimizations

- **Tool filtering** — Usage-based pruning after warmup
- **Model tiering** — Haiku for tool routing (cheaper)
- **Prompt caching** — Anthropic beta for long context
- **Direct DB polling** — In-process agents skip HTTP
- **Token compaction** — Automatic context summarization
- **WebSocket push** — Real-time updates without polling
- **Message pagination** — Lazy loading in UI

### Scalability

- **SQLite WAL mode** — Concurrent reads with single writer
- **Prepared statements** — Reusable query plans
- **Connection pooling** — Implicit via Bun HTTP server
- **Sub-agents** — Parallel execution via Spaces system
- **Remote workers** — Distribute tools across machines

---

## Future Enhancements

Documented in docs/brainstorm-* files:
- Desktop automation (keyboard/mouse control)
- Workspace Docker integration (noVNC)
- Pure MCP-based workspace evaluation
- Agent OS platforms (Skyline, Antml)
- Browser extension landscape analysis
- Windows compatibility improvements

---

## Quick Start

### Install & Build

```sh
git clone https://github.com/clawd-pilot/clawd.git
cd clawd
bun install
bun run build
```

### Run

```sh
./dist/server/clawd-app --port 3456 --debug
# or
bun run dev
```

### Docker

```sh
docker compose up -d
```

---

## Documentation Map

- **[README.md](../README.md)** — Project overview, quick start, CLI flags
- **[docs/architecture.md](./architecture.md)** — Deep technical reference
- **[docs/artifacts.md](./artifacts.md)** — Artifact protocol guide
- **~/.clawd/config.json** — Runtime configuration

---

Generated from repomix codebase compaction (repomix-output.xml, 1.1M tokens).
