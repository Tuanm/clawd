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
- Git isolated mode for multi-agent channels (18 API endpoints)

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
| **Agent System** | Multi-agent orchestration, reasoning loop | `src/worker-loop.ts`, `src/agent/` |
| **Database** | SQLite (chat.db, memory.db, kanban.db) | `src/server/database.ts` |
| **Browser Automation** | Chrome extension bridge + 26 tools | `packages/browser-extension/`, `src/server/browser-bridge.ts` |
| **Git Worktree** | Isolated worktrees for multi-agent channels, diff/commit UI | `src/api/worktree.ts`, `src/agent/workspace/worktree.ts`, `packages/ui/WorktreeDialog.tsx` |
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
│   ├── agent/                        # Agent system
│   │   ├── agent.ts                  # Core Agent class, reasoning loop
│   │   ├── api/                      # LLM provider factory, key pool, clients
│   │   ├── tools/                    # Tool definitions, web search, document converter
│   │   ├── plugins/                  # All plugins (chat, browser, workspace, tunnel, etc.)
│   │   ├── session/                  # Session manager, checkpoints, summarizer
│   │   ├── memory/                   # session.ts, knowledge-base.ts, agent-memory.ts
│   │   ├── workspace/                # Git isolated mode for multi-agent channels
│   │   │   ├── worktree.ts           # Worktree lifecycle, diff/commit/merge/hunk operations
│   │   │   ├── index.ts              # Workspace plugin entry
│   │   │   └── pool.ts               # Worktree pool management
│   │   ├── mcp/                      # MCP client connections
│   │   └── utils/                    # sandbox.ts, debug, context helpers
│   ├── spaces/                       # Sub-agent system
│   │   ├── manager.ts                # Space lifecycle
│   │   ├── worker.ts                 # Space worker orchestrator
│   │   └── plugin.ts                 # spawn_agent, complete_task
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
│   │   │   ├── WorktreeDialog.tsx    # Git worktree diff/commit UI
│   │   │   ├── worktree-diff-viewer.tsx # Unified diff renderer with per-hunk controls
│   │   │   ├── worktree-file-list.tsx  # File tree for worktree status
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

### Built-in Agents

Three agents available by default with source: "built-in":

| Agent | Description | Model | Tools |
|-------|-------------|-------|-------|
| `explore` | Fast read-only codebase explorer for discovery and pattern analysis | Haiku | view, grep, glob, bash, today, get_environment, web_search, web_fetch |
| `plan` | Research agent for gathering context before planning | inherit | view, grep, glob, bash, today, get_environment, web_search, web_fetch |
| `general` | Capable general-purpose agent for complex multi-step tasks | inherit | all |

Built-in agents can be overridden by custom agents with the same name via the 4-directory priority system.

### Agent Files (`src/agent/agents/loader.ts`)

Agent identities defined in markdown with YAML frontmatter (Claude Code-compatible). Loaded from 4 directories with priority override:
1. `~/.claude/agents/` (lowest) → 2. `~/.clawd/agents/` → 3. `{project}/.claude/agents/` → 4. `{project}/.clawd/agents/` (highest)

Fields: name, description, provider, model, tools, disallowedTools, skills, memory, language, directives, maxTurns, background. Sub-agents can be spawned with a specific agent file via `spawn_agent(task, agent="code-reviewer")` — the sub-agent inherits the agent file's system prompt, provider, model, tool restrictions, and directives. Tool name aliases (Read→view, Write→create, Bash→bash, etc.) resolve automatically in agent file tool restrictions for Claude Code compatibility.

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

### Agent Class (`src/agent/agent.ts`)

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

### Stream Timeouts (State-Based)

Stream timeouts are state-based (not model-name-based):

| State | Timeout | Meaning |
|-------|---------|---------|
| **CONNECTING** | 30 seconds | Waiting for HTTP response headers (network/connection issues) |
| **PROCESSING** | 300 seconds | Headers received but no data (model thinking, extended reasoning) |
| **STREAMING** | 180 seconds | Active data streaming; timeout if pause between chunks exceeds limit |

Accommodates slow models (Opus, o1, o3) without hardcoding model-specific timeouts.

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

Agents delegate work via `spawn_agent(task, agent="code-reviewer")`:

1. Create isolated channel `{parent}:{uuid}` (simplified format)
2. Load agent file config if `agent` parameter provided (system prompt, model, tools, directives)
3. Sub-agent inherits parent's project, provider, and model (unless overridden by agent file)
4. Sub-agent processes task independently with friendly name + UUID suffix (e.g., "code-reviewer-a1b2c3")
5. Sub-agent reports results via `complete_task(result)` — the only way to deliver work
6. Space auto-cleans after completion or timeout (default 300s, configurable to 600s)

**Features:**
- Colored avatars for sub-agents instead of black
- `list_agents(type="running")` shows spawned sub-agents with status, errors, and agent file used
- `get_agent_report(id)` fetches specific sub-agent's full result or error
- `agent` parameter optional — without it, sub-agent inherits parent's configuration (backward compatible)
- **Sub-agent tools** — Limited to `complete_task`, `chat_mark_processed`, `get_environment`, `today` (no chat_send_message)

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

## Git Worktree Isolation

Multi-agent file isolation via git worktrees. Each agent in a channel gets its own isolated working directory with a dedicated branch (`clawd/{randomId}`), enabling concurrent edits without conflicts.

### Architecture

- **Location**: `{projectRoot}/.clawd/worktrees/{agentId}/`
- **Branch naming**: `clawd/{6-char-hex}` — stable, reused across restarts
- **Disk overhead**: Near-zero (git hard-links identical files from main repo)
- **Agent awareness**: Agents are **unaware** of git worktree isolation (system prompt identical to normal git mode)
- **Non-git projects**: Worktree skipped; agent works directly in project root
- **Persistence**: DB tracks path + branch per agent; reused on restart
- **Config toggle**: `"worktree": true|false|["ch1","ch2"]` — disabling clears DB entries on restart
- **Submodule support**: Recursively initialized; failed init triggers rollback
- **Dependency auto-install**: Detects bun/npm/yarn/pnpm; installs asynchronously (non-blocking)

### Database Persistence

`channel_agents` table tracks:
- `worktree_path` — Path to worktree directory (e.g., `.clawd/worktrees/{agentId}`)
- `worktree_branch` — Assigned branch (e.g., `clawd/a1b2c3`)

Reused on server restart, preventing orphaned branches.

### API Endpoints (18 total)

**Worktree Status** (GET):
- `GET /api/app.worktree.enabled?channel=X` — Check if enabled for channel
- `GET /api/app.worktree.status?channel=X` — Worktree info for all agents: branch, clean status, ahead/behind counts, file lists
- `GET /api/app.worktree.log?channel=X&agent_id=Y` — Commit log for agent's branch

**File Operations** (POST):
- `app.worktree.stage` — Stage specific file
- `app.worktree.unstage` — Unstage file
- `app.worktree.discard` — Discard working tree changes
- `app.worktree.diff` — Get unified diff (query params: agent_id, file_path, source="unstaged"|"staged")

**Per-Hunk Granular Control** (POST):
- `app.worktree.stage_hunk` — Stage single hunk (by content hash)
- `app.worktree.unstage_hunk` — Unstage single hunk
- `app.worktree.revert_hunk` — Discard single hunk from working tree

**Commit & Push** (POST):
- `app.worktree.commit` — Create commit with message, auto-author from config
- `app.worktree.push` — Push branch to remote (guards: blocks main/master/develop)

**Conflict Resolution** (POST):
- `app.worktree.merge` — Merge base branch into worktree
- `app.worktree.resolve` — Mark conflict as resolved
- `app.worktree.abort` — Abort in-progress merge

**Stash** (POST):
- `app.worktree.stash` — Stash working tree changes
- `app.worktree.stash_pop` — Restore stashed changes

**Branch Integration** (POST):
- `app.worktree.apply` — Apply (cherry-pick or merge) worktree branch into base

### Hunk Staging Protocol

Per-hunk staging uses SHA1 content hashing for identity:

1. **Fetch diff** — API returns hunks with `hash` field (SHA1 of raw hunk text)
2. **Select hunk** — UI sends `hunk_hash` in POST request
3. **Hash validation** — Server fetches current diff, finds matching hunk by hash
4. **Apply operation** — Stage/unstage/revert single hunk via `git apply`
5. **409 handling** — If hash doesn't match (diff changed), return error; UI refreshes diff

### Configuration

```jsonc
{
  // Enable worktree: true = all channels, false = disabled, ["ch1", "ch2"] = specific channels
  "worktree": true,

  // Author identity for commits
  // Priority: git local config (main author) + this field (Co-Authored-By trailer)
  // OR: if no local config, this becomes main author via -c flags
  "author": {
    "name": "Claw'd Agent",
    "email": "agent@clawd.local"
  }
}
```

### Commit Author Handling

1. **If git local config exists** (user.name/email):
   - Main author: local config
   - Co-Author: `config.author` (via `git interpret-trailers`)

2. **If no local config**:
   - Main author: `config.author` (via `-c user.name=... -c user.email=...` flags)
   - Falls back to error if neither configured

### UI Components

| Component | Purpose |
|-----------|---------|
| `WorktreeDialog.tsx` | "Git" dialog (unified UI for worktree or direct repo); agent selector, file list sidebar, diff viewer, commit interface |
| `worktree-diff-viewer.tsx` | Unified diff renderer with inline hunk controls (stage/unstage/discard buttons); supports both unstaged and staged diffs |
| `worktree-file-list.tsx` | Resizable sidebar with tree view of staged/unstaged/deleted/conflicted files; file icons by type |

**Features:**
- Resizable sidebar (horizontal divider with drag)
- Fullscreen on mobile (stacked vertical layout)
- "Refresh" button to reload status
- Merge conflict UI with resolve/abort actions
- Per-hunk inline controls with SHA1 hash-based identification
- Works for both git worktree isolation and direct git repo access

### Git Tool Guards (Sandbox Integration)

Tools in agent sandbox have guards preventing destructive operations:

| Tool | Guard |
|------|-------|
| `git commit` | Validates author; auto-injects Co-Authored-By if configured |
| `git push` | Blocks main/master/develop branches; only permits clawd/* branches |
| `git checkout` | Blocks branch switching; agents stay on assigned branch |
| `git pull` | Blocks pull (worktrees ephemeral; base syncs via merge conflict resolution) |

### Sandbox Path Isolation

- **Original `.git/` directory**: Mounted read-only in sandbox
  - Agents can read git history but not modify repository state
- **Worktree `.git/` directory**: Fully writable in sandbox
  - Agents commit, stage, stash in worktree only
- **Sibling worktrees**: Blocked by `.clawd/` tmpfs isolation
  - Agents cannot see or interfere with other agents' worktrees

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
- Adaptive request spacing: 600ms (idle) → 800ms (moderate) → 1200ms (loaded) + jitter
- Key selection by earliest available slot (minimizes agent wait time)
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
├── agents/                     # Global agent files (Claude Code-compatible)
│   └── {name}.md               # Agent definition (frontmatter + system prompt)
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
