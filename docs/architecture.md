# Claw'd — Architecture Reference

> Last updated: 2026-03-16

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Directory Layout](#3-directory-layout)
4. [Server Entry Point](#4-server-entry-point)
5. [Database Schema](#5-database-schema)
   - [chat.db — Chat & Agent State](#51-chatdb--chat--agent-state)
   - [memory.db — Agent Session Memory](#52-memorydb--agent-session-memory)
6. [Agent System](#6-agent-system)
   - [Worker Loop](#61-worker-loop)
   - [Agent Class & Reasoning Loop](#62-agent-class--reasoning-loop)
   - [Token Management & Context Compaction](#63-token-management--context-compaction)
   - [Plugin System](#64-plugin-system)
   - [Memory System](#65-memory-system)
   - [Heartbeat Monitor](#66-heartbeat-monitor)
   - [Model Tiering & Tool Filtering](#67-model-tiering--tool-filtering)
7. [Browser Extension](#7-browser-extension)
   - [Architecture Overview](#71-architecture-overview)
   - [Normal Mode (CDP)](#72-normal-mode-cdp)
   - [Stealth Mode (Anti-Bot)](#73-stealth-mode-anti-bot)
   - [Anti-Detection Shield](#74-anti-detection-shield)
   - [Distribution](#75-distribution)
   - [Artifact Rendering Pipeline](#76-artifact-rendering-pipeline)
8. [Sub-Agent System (Spaces)](#8-sub-agent-system-spaces)
   - [Space Lifecycle](#81-space-lifecycle)
   - [Scheduler Integration](#82-scheduler-integration)
9. [Sandbox Security](#9-sandbox-security)
   - [Linux (bubblewrap)](#91-linux-bubblewrap)
   - [macOS (sandbox-exec)](#92-macos-sandbox-exec)
   - [Access Policy](#93-access-policy)
10. [Remote Worker Bridge](#10-remote-worker-bridge)
11. [WebSocket Events](#11-websocket-events)
12. [API Reference](#12-api-reference)
    - [Chat APIs](#121-chat-apis)
    - [File APIs](#122-file-apis)
    - [Reaction APIs](#123-reaction-apis)
    - [Agent Streaming APIs](#124-agent-streaming-apis)
    - [Agent Management APIs](#125-agent-management-apis)
    - [App Management APIs](#126-app-management-apis)
    - [Project Browser APIs](#127-project-browser-apis)
    - [Analytics APIs](#128-analytics-apis)
    - [Task Management APIs](#129-task-management-apis)
    - [Special Endpoints](#1210-special-endpoints)
13. [LLM Provider System](#13-llm-provider-system)
14. [Chat UI](#14-chat-ui)
15. [Build System](#15-build-system)
16. [Docker Deployment](#16-docker-deployment)
17. [Configuration Reference](#17-configuration-reference)
    - [config.json Schema](#171-configjson-schema)
    - [System Files & Directories](#172-system-files--directories)

---

## 1. System Overview

Claw'd is an open-source agentic chat platform where AI agents operate autonomously,
communicating with users through a real-time collaborative chat UI. Agents can:

- Communicate with users and each other through real-time collaborative chat
- Execute code, browse the web, and interact with files using tool plugins
- Control a Chrome browser remotely via the browser extension (CDP or stealth mode)
- Analyze and generate images using multi-provider vision models
- Create and manage scheduled tasks (cron, interval, one-shot)
- Delegate work to sub-agents via the Spaces system for parallel execution
- Persist long-term memories, knowledge chunks, and session context across restarts

**Core design principles:**

| Principle | Description |
|---|---|
| **Single binary deployment** | Compiles to `dist/server/clawd-app` with embedded UI + browser extension |
| **Provider-agnostic** | Supports Copilot, OpenAI, Anthropic, Ollama, Minimax |
| **Plugin-first agents** | All agent capabilities are expressed through the ToolPlugin/Plugin interfaces |
| **Secure by default** | Sandboxed tool execution (bubblewrap/sandbox-exec), path validation, auth tokens |
| **Real-time collaboration** | WebSocket-driven UI with streaming tokens, tool calls, and read receipts |
| **Multi-agent** | Multiple agents per channel, sub-agent spawning, remote worker bridge |

---

## 2. High-Level Architecture

```
User Browser
    │  HTTP/WebSocket (default: localhost:3456)
    ▼
┌─────────────────────────────────────────────┐
│ Claw'd Server (src/index.ts — Bun HTTP+WS) │
│                                              │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐│
│  │ Chat API │  │MCP Endpoint│  │ Browser  ││
│  │ /api/*   │  │ /mcp       │  │ Bridge   ││
│  └────┬─────┘  └─────┬──────┘  └────┬─────┘│
│       │               │              │       │
│  ┌────▼───────────────▼──────┐       │       │
│  │ SQLite (WAL mode)         │       │       │
│  │ chat.db (messages, agents)│       │       │
│  │ memory.db (LLM sessions)  │       │       │
│  └───────────────────────────┘       │       │
│                                      │       │
│  ┌──────────────────────────────────▼──────┐│
│  │ Agent Loop (src/agent/)                  ││
│  │ ├─ LLM provider (multi-provider)        ││
│  │ ├─ Tool plugins (browser, workspace)    ││
│  │ ├─ MCP clients (chat + external)        ││
│  │ ├─ Sub-agent spawner (spaces)           ││
│  │ └─ Context compactor / token manager    ││
│  └──────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
         │ WebSocket
         ▼
┌──────────────────────────┐
│ Chrome Browser Extension │
│ (packages/browser-extension/) │
│ ├─ CDP tools (normal)    │
│ └─ Stealth mode (anti-bot)│
└──────────────────────────┘
```

### Data Flow Summary

1. **User → Server**: HTTP requests hit `/api/*` routes; WebSocket at `/ws` for real-time events
2. **Server → Database**: Two SQLite databases — `chat.db` for chat state, `memory.db` for LLM sessions
3. **Server → Agent Loop**: Worker manager starts one `WorkerLoop` per agent, polling every 200ms
4. **Agent → LLM**: Streaming calls to configured provider (Copilot, OpenAI, Anthropic, Ollama, Minimax)
5. **Agent → Tools**: Plugin system executes tool calls; results flow back into the LLM loop
6. **Agent → Browser**: WebSocket bridge to Chrome extension for remote browser automation
7. **Agent → Sub-agents**: Spaces system spawns isolated sub-agent channels for parallel work

---

## 3. Directory Layout

```
clawd/
├── src/                        # Main server + agent system
│   ├── index.ts                # Server entry point (HTTP/WS/routes)
│   ├── config.ts               # CLI config parser
│   ├── config-file.ts          # ~/.clawd/config.json loader
│   ├── worker-loop.ts          # Per-agent polling loop
│   ├── worker-manager.ts       # Multi-agent orchestrator
│   ├── server/
│   │   ├── database.ts         # chat.db SQLite schema
│   │   ├── websocket.ts        # WebSocket broadcasting
│   │   ├── routes/             # API route handlers
│   │   └── browser-bridge.ts   # Browser extension WS bridge
│   ├── agent/
│   │   └── src/
│   │       ├── agent/agent.ts  # Main Agent class + reasoning loop
│   │       ├── memory/         # memory.ts, knowledge-base.ts, agent-memory.ts
│   │       ├── session/        # Session manager, checkpoints, summarizer
│   │       ├── plugins/        # browser-plugin.ts, workspace-plugin.ts
│   │       ├── mcp/            # MCP client connections
│   │       ├── tools/          # Tool execution + plugin system
│   │       └── utils/          # sandbox.ts, agent-context.ts
│   ├── spaces/                 # Sub-agent system
│   │   ├── manager.ts          # Space lifecycle management
│   │   ├── worker.ts           # Space worker orchestrator
│   │   ├── spawn-plugin.ts     # spawn_agent tool
│   │   ├── plugin.ts           # respond_to_parent, get_space_info
│   │   └── db.ts               # spaces table schema
│   ├── scheduler/              # Scheduled jobs (cron, interval, once)
│   │   ├── manager.ts          # Scheduler tick loop
│   │   ├── runner.ts           # Job executor (creates sub-spaces)
│   │   └── parse-schedule.ts   # Natural language schedule parser
│   └── api/                    # Agent management, articles, MCP servers
├── packages/
│   ├── ui/                     # React SPA (Vite + TypeScript)
│   │   └── src/
│   │       ├── App.tsx         # Main app, WS handling, state
│   │       ├── MessageList.tsx # Messages + StreamOutputDialog
│   │       └── styles.css      # All styles
│   └── browser-extension/      # Chrome MV3 extension
│       ├── manifest.json       # Extension manifest
│       └── src/
│           ├── service-worker.js # Command dispatcher (~2700 lines)
│           ├── content-script.js # DOM extraction
│           ├── shield.js       # Anti-detection patches
│           └── offscreen.js    # WS connection maintainer
├── scripts/                    # Build utilities
│   ├── embed-ui.ts             # Embeds UI into binary
│   └── zip-extension.ts        # Packs extension into binary
├── docs/                       # Documentation
├── Dockerfile                  # Multi-stage Docker build
└── compose.yaml                # Docker Compose deployment
```

### Key Files Quick Reference

| File | Purpose |
|------|---------|
| `src/index.ts` | HTTP server, WebSocket handler, route registration |
| `src/config.ts` | CLI argument parser (--port, --host, --yolo, --debug) |
| `src/config-file.ts` | Loads and validates `~/.clawd/config.json` |
| `src/worker-loop.ts` | Per-agent polling loop (200ms interval) |
| `src/worker-manager.ts` | Manages lifecycle of all agent WorkerLoop instances |
| `src/server/database.ts` | SQLite schema, migrations, prepared statements for chat.db |
| `src/server/websocket.ts` | WebSocket connection tracking, message broadcasting |
| `src/server/browser-bridge.ts` | WebSocket bridge between agents and browser extension |
| `src/agent/src/agent/agent.ts` | Core Agent class — reasoning loop, tool dispatch |
| `src/spaces/manager.ts` | Sub-agent space creation, lifecycle, cleanup |
| `src/scheduler/manager.ts` | Cron/interval/once job scheduling and execution |

---

## 4. Server Entry Point

`src/index.ts` runs a single Bun HTTP + WebSocket server (default: `0.0.0.0:3456`).

### Request Routing

All API requests are routed through the HTTP handler. The server serves three primary
functions:

1. **REST API** (`/api/*`) — Chat, agent management, files, scheduler, analytics
2. **MCP Endpoint** (`/mcp`) — Model Context Protocol SSE transport for external clients
3. **Static Assets** (`/*`) — Embedded React SPA served as fallback for all non-API routes

### WebSocket Connections

| Upgrade Path | Purpose |
|-------------|---------|
| `/ws` | Real-time chat events (messages, reactions, agent streaming, tool calls) |
| `/browser/ws` | Browser extension bridge (command dispatch + results) |

---

## 5. Database Schema

Claw'd uses two separate SQLite databases, both in WAL mode for concurrent read/write.

### 5.1 chat.db — Chat & Agent State

**Location**: `~/.clawd/data/chat.db`

This is the primary database for all chat, agent, and scheduling state.

#### channels

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Channel identifier |
| `name` | TEXT | Display name |
| `created_by` | TEXT | Creator user/agent ID |

#### messages

| Column | Type | Description |
|--------|------|-------------|
| `ts` | TEXT PK | Timestamp (message ID) |
| `channel` | TEXT | Channel the message belongs to |
| `user` | TEXT | Sender (user or agent ID) |
| `text` | TEXT | Message content (Markdown) |
| `agent_id` | TEXT | Agent that generated this message (nullable) |
| `subspace_json` | TEXT | Sub-agent space metadata (nullable) |
| `tool_result_json` | TEXT | Tool execution result (nullable) |

#### files

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | File identifier |
| `name` | TEXT | Storage filename |
| `mimetype` | TEXT | MIME type |
| `size` | INTEGER | File size in bytes |
| `path` | TEXT | File storage path |
| `message_ts` | TEXT | Associated message timestamp |
| `uploaded_by` | TEXT | User who uploaded the file |
| `created_at` | TEXT | Creation timestamp |
| `public` | INTEGER | Whether the file is publicly accessible |

#### agents

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Agent identifier |
| `channel` | TEXT | Home channel |
| `avatar_color` | TEXT | Display color |
| `display_name` | TEXT | Human-readable name |
| `is_worker` | INTEGER | Whether this is a worker agent |
| `is_sleeping` | INTEGER | Whether the agent is hibernating |

#### channel_agents

| Column | Type | Description |
|--------|------|-------------|
| `channel` | TEXT | Channel ID |
| `agent_id` | TEXT | Agent ID |
| `provider` | TEXT | LLM provider for this assignment |
| `model` | TEXT | LLM model for this assignment |
| `project` | TEXT | Project/workspace path |
| `worker_token` | TEXT | Remote worker auth token (nullable) |

#### agent_seen

| Column | Type | Description |
|--------|------|-------------|
| `agent_id` | TEXT | Agent ID |
| `channel` | TEXT | Channel ID |
| `last_seen_ts` | TEXT | Last message the agent observed |
| `last_processed_ts` | TEXT | Last message the agent acted on |
| `last_poll_ts` | TEXT | Last poll timestamp |

#### agent_status

| Column | Type | Description |
|--------|------|-------------|
| `agent_id` | TEXT | Agent ID |
| `channel` | TEXT | Channel ID |
| `status` | TEXT | Current status |
| `hibernate_until` | TEXT | Wake-up timestamp (nullable) |

#### summaries

| Column | Type | Description |
|--------|------|-------------|
| `channel` | TEXT | Channel ID |
| `agent_id` | TEXT | Agent that created the summary |
| `summary` | TEXT | Compressed context summary |

#### spaces

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Space identifier |
| `channel` | TEXT | Parent channel |
| `space_channel` | TEXT | Isolated sub-channel (format: `{parent}:space:{uuid}`) |
| `title` | TEXT | Space task description |
| `status` | TEXT | Status (active, completed, failed, timed_out) |

#### Other Tables

| Table | Purpose |
|-------|---------|
| `articles` | Knowledge articles |
| `copilot_calls` | API call analytics and tracking |

### 5.1b kanban.db — Task & Plan Management

**Location**: `~/.clawd/data/kanban.db`

| Table | Purpose |
|-------|---------|
| `tasks` | Channel-scoped tasks (status, assignee, priority, due dates) |
| `plans` | Plan documents with phases |
| `phases` | Plan phases/milestones |
| `plan_tasks` | Tasks linked to plan phases |

### 5.1c scheduler.db — Scheduler State

**Location**: `~/.clawd/data/scheduler.db`

#### scheduled_jobs

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Job identifier |
| `channel` | TEXT | Channel the job belongs to |
| `title` | TEXT | Job description |
| `type` | TEXT | Schedule type: `once`, `interval`, `cron`, `reminder`, or `tool_call` |
| `cron_expr` | TEXT | Cron expression (for cron type) |

### 5.2 memory.db — Agent Session Memory

**Location**: `~/.clawd/memory.db`

This database stores all LLM session context, knowledge retrieval data, and long-term
agent memories.

#### sessions

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Session identifier |
| `name` | TEXT | Session name (format: `{channel}-{agentId}`) |
| `model` | TEXT | LLM model used |
| `created_at` | INTEGER | Creation timestamp |
| `updated_at` | INTEGER | Last update timestamp |

#### messages

| Column | Type | Description |
|--------|------|-------------|
| `session_id` | TEXT | Foreign key to sessions |
| `role` | TEXT | Message role (system, user, assistant, tool) |
| `content` | TEXT | Message content |
| `tool_calls` | TEXT | JSON-encoded tool call array (nullable) |
| `tool_call_id` | TEXT | Tool call ID for tool results (nullable) |

#### messages_fts

FTS5 full-text search index on `messages.content` for fast session search.

#### knowledge

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Chunk identifier |
| `session_id` | TEXT | Session the chunk belongs to |
| `source_id` | TEXT | Source identifier |
| `tool_name` | TEXT | Tool that produced this chunk |
| `chunk_index` | INTEGER | Index of this chunk within the source |
| `content` | TEXT | Tool output text chunk for retrieval |
| `created_at` | TEXT | Creation timestamp |

#### knowledge_fts

FTS5 full-text search index on `knowledge.content`.

#### agent_memories

| Column | Type | Description |
|--------|------|-------------|
| `agent_id` | TEXT | Agent that owns this memory |
| `content` | TEXT | Long-term fact, preference, or decision |
| `channel` | TEXT | Channel context for this memory |
| `category` | TEXT | Memory category |
| `source` | TEXT | How this memory was created |
| `access_count` | INTEGER | Number of times this memory was retrieved |
| `last_accessed` | TEXT | Last retrieval timestamp |
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Last update timestamp |

#### agent_memories_fts

FTS5 full-text search index on `agent_memories.content`.

---

## 6. Agent System

### 6.1 Worker Loop

**File**: `src/worker-loop.ts`

Each agent runs its own `WorkerLoop` instance, managed by `WorkerManager`:

```
┌─────────────────────────────────────────────┐
│ WorkerManager (src/worker-manager.ts)       │
│  ├─ WorkerLoop (agent-1) ─── poll 200ms ──┐│
│  ├─ WorkerLoop (agent-2) ─── poll 200ms ──┤│
│  └─ WorkerLoop (agent-N) ─── poll 200ms ──┤│
│                                             ││
│  Each loop:                                 ││
│  1. Check for new messages in channel       ││
│  2. Build prompt (system + context + tools) ││
│  3. Call LLM (streaming)                    ││
│  4. Parse response → execute tool calls     ││
│  5. Post results back to channel            ││
│  6. Repeat until no pending messages        ││
└─────────────────────────────────────────────┘
```

**Key behaviors:**

- **Poll interval**: 200ms between checks for new messages
- **Continuation**: If the LLM returns tool calls, results are injected and the loop continues
- **Interrupts**: New user messages can interrupt an in-progress agent turn
- **Retry**: Transient LLM failures trigger automatic retry with exponential backoff

### 6.2 Agent Class & Reasoning Loop

**File**: `src/agent/src/agent/agent.ts`

The `Agent` class implements the core reasoning loop:

```
LLM Call (streaming)
    │
    ├── Text response → post to channel
    │
    └── Tool calls → parse → execute each tool
            │
            ├── Tool result → inject into context
            │
            └── Continue loop (call LLM again with results)
```

Each iteration:

1. **Build messages array**: system prompt + conversation history + tool definitions
2. **Stream LLM response**: tokens broadcast via WebSocket as `agent_token` events
3. **Parse tool calls**: Extract function name + arguments from the response
4. **Execute tools**: Run through plugin system with `beforeExecute` / `afterExecute` hooks
5. **Inject results**: Tool outputs added as `tool` role messages
6. **Loop or terminate**: If tool calls present, repeat; otherwise, post final text

### 6.3 Token Management & Context Compaction

The agent maintains a token budget with three tiers:

| Threshold | Action |
|-----------|--------|
| **~50K tokens** | ⚠️ Warning — begin soft compaction |
| **~70K tokens** | 🔴 Critical — aggressive compaction with summarization |
| **Checkpoint** | Context recovery from saved checkpoints on overflow |

**Smart compaction** uses importance-weighted message scoring:

- System messages: highest weight (never removed)
- Recent user messages: high weight
- Old assistant messages: lower weight, candidates for summarization
- Tool results: lowest weight, first to be compacted

**Checkpoint system**: Periodically saves a snapshot of the conversation state. On context
overflow, the agent can recover from the last checkpoint rather than losing all context.

### 6.4 Plugin System

Agents are extended through two plugin interfaces:

#### ToolPlugin Interface

```typescript
interface ToolPlugin {
  getTools(): ToolDefinition[]      // Register available tools
  beforeExecute?(call): boolean     // Pre-execution hook (can block)
  afterExecute?(call, result): void // Post-execution hook
}
```

#### Plugin Interface

```typescript
interface Plugin {
  onUserMessage?(message): void       // React to user messages
  onToolCall?(call): void             // React to tool executions
  getSystemContext?(): string          // Inject into system prompt
  // ... additional lifecycle hooks
}
```

#### Active Plugins

| Plugin | File | Purpose |
|--------|------|---------|
| `browser-plugin` | `plugins/browser-plugin.ts` | Browser automation tools via extension bridge |
| `workspace-plugin` | `plugins/workspace-plugin.ts` | File system and project workspace tools |
| `context-mode-plugin` | `plugins/context-mode-plugin.ts` | Toggle between action and context-only modes |
| `state-persistence-plugin` | `plugins/state-persistence-plugin.ts` | Save/restore agent state across restarts |
| `tunnel-plugin` | `plugins/tunnel-plugin.ts` | Expose local services via tunnels |
| `spawn-agent-spaces` | `spaces/spawn-plugin.ts` | Sub-agent spawning via spaces system |

### 6.5 Memory System

The memory system has three tiers, each serving different retrieval needs:

```
┌─────────────────────────────────────────────────┐
│ Tier 1: Session Memory (messages table)         │
│ ├─ Full conversation history with LLM           │
│ ├─ Subject to compaction at token thresholds    │
│ └─ Checkpointed for recovery                    │
├─────────────────────────────────────────────────┤
│ Tier 2: Knowledge Base (knowledge table)        │
│ ├─ FTS5-indexed tool output chunks              │
│ ├─ Retrieved by FTS5 keyword matching on demand │
│ └─ Enables recall of past tool results          │
├─────────────────────────────────────────────────┤
│ Tier 3: Agent Memory (agent_memories table)     │
│ ├─ Long-term facts, preferences, decisions      │
│ ├─ FTS5-indexed for search                      │
│ └─ Persists across sessions indefinitely        │
└─────────────────────────────────────────────────┘
```

**Tier 1 — Session memory**: The raw conversation with the LLM, stored in `memory.db → messages`.
This is the working memory that gets compacted when token limits are reached.

**Tier 2 — Knowledge base**: When tools return large outputs (file contents, command results,
web pages), the output is chunked and stored in `knowledge` with FTS5 indexing. The
agent can later retrieve relevant chunks via FTS5 keyword matching without re-executing the tool.

**Tier 3 — Agent memory**: Explicit long-term storage of facts ("user prefers dark mode"),
preferences ("always use TypeScript"), and decisions ("we chose PostgreSQL for the DB").
These persist indefinitely and are injected into the system prompt when relevant.

### 6.6 Heartbeat Monitor

**File**: `src/worker-manager.ts`

A background health monitor keeps agents responsive and recovers from stuck states:

**Mechanism:**
- Runs on a configurable interval (default: 30s)
- Tracks agent state: idle vs. active processing
- For idle agents: injects `[HEARTBEAT]` system message to wake them up
- For stuck agents: cancels processing if exceeding timeout (default: 5 minutes)
- For sub-agent spaces: auto-fails after 10 consecutive heartbeats with no progress (circuit breaker)

**Configuration** (in `config.json`):
```jsonc
"heartbeat": {
  "enabled": true,              // Enable monitor (default: true)
  "intervalMs": 30000,          // Check interval (default: 30000)
  "processingTimeoutMs": 300000, // Cancel stuck agents after 5 min
  "spaceIdleTimeoutMs": 60000   // Sub-agent idle timeout
}
```

**Heartbeat Signal Protocol:**
- `[HEARTBEAT]` appears as a system message in the LLM context
- Agents read this as a wake signal, not a user message
- Agents check for pending work and continue if found
- No reply needed if idle with no pending work

**WebSocket Events** (all broadcast as `type: "agent_heartbeat"` with `event` sub-field):
- `heartbeat_sent` — Heartbeat injected into idle agent
- `processing_timeout` — Agent cancelled for exceeding processing timeout
- `space_auto_failed` — Sub-agent space failed after max heartbeat attempts

### 6.7 Model Tiering & Tool Filtering

**Files**: `src/agent/src/agent/agent.ts` (`getIterationModel`), `src/agent/src/api/factory.ts`

**Model Tiering** (`getIterationModel` in agent.ts):
- Auto-downgrade to fast model (default `claude-haiku-4.5`) when conditions are met:
  - Past first 2 iterations (warmup always uses full model)
  - No tool results pending delivery
  - Not immediately after compaction
  - User message has no reasoning keywords (explain, analyze, design, etc.)
  - Last 3 iterations were ALL pure tool calls (content < 50 chars)
- Upgrades back to full model when reasoning is needed
- Configurable via `config.fastModel`

**Tool Filtering** (`filterToolsByUsage` in agent.ts):
- After 5-iteration warmup, prune unused built-in tools
- Category-based: if any tool in a category is used, keep all tools in that category
- Always keep: chat tools, system tools, MCP/plugin tools
- Re-expansion trigger: if 2+ consecutive text-only responses, re-expand to full set
- Reduces tool definition tokens by 30-60%

**Prompt Caching:**
- Anthropic `prompt-caching-2024-07-31` beta header enabled
- System prompt marked with `cache_control: { type: "ephemeral" }`
- Reduces input token billing for cached prefix

---

## 7. Browser Extension

The Chrome browser extension is the primary mechanism for agent browser automation. It
connects to the clawd server via WebSocket and executes browser commands on behalf of agents.

### 7.1 Architecture Overview

```
┌─────────────────────────────────────────────┐
│ Chrome Browser Extension (MV3)              │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │ service-worker.js (~2700 lines)      │   │
│  │ ├─ Command dispatcher                │   │
│  │ ├─ CDP mode (chrome.debugger API)    │   │
│  │ └─ Stealth mode (scripting API)      │   │
│  └──────────────┬───────────────────────┘   │
│                  │                            │
│  ┌──────────────▼───────────────────────┐   │
│  │ offscreen.js                         │   │
│  │ └─ WebSocket connection maintainer   │   │
│  │    (WS ping every 20s,              │   │
│  │     SW keepalive every 25s)         │   │
│  └──────────────┬───────────────────────┘   │
│                  │ WebSocket                  │
│  ┌──────────────▼───────────────────────┐   │
│  │ content-script.js                    │   │
│  │ └─ DOM extraction + interaction      │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │ shield.js (MAIN world, document_start│   │
│  │ └─ Anti-detection patches            │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
         │ WebSocket
         ▼
┌─────────────────────────────────────────────┐
│ Claw'd Server (browser-bridge.ts)           │
│ └─ /browser/ws endpoint                     │
└─────────────────────────────────────────────┘
```

**Communication flow:**

1. Extension's `offscreen.js` maintains a persistent WebSocket to the server at `/browser/ws`
2. Server sends commands (navigate, click, screenshot, etc.) through the bridge
3. `service-worker.js` dispatches commands to the appropriate handler (CDP or stealth)
4. Results (screenshots, DOM data, success/error) flow back through the WebSocket

**25+ command types** are supported: navigate, screenshot, click, type, execute, scroll,
hover, select, drag, upload, accessibility tree, tab management, and more.

### 7.2 Normal Mode (CDP)

Normal mode uses the **Chrome DevTools Protocol** via `chrome.debugger` API for precise,
full-featured browser control.

**Capabilities:**

| Feature | Implementation |
|---------|----------------|
| Screenshots | CDP `Page.captureScreenshot` — full page or viewport |
| Accessibility tree | CDP `Accessibility.getFullAXTree` — structured page content |
| Click | CDP `Input.dispatchMouseEvent` — precise coordinate clicks |
| Type | CDP `Input.dispatchKeyEvent` — keystroke simulation |
| File upload | CDP `DOM.setFileInputFiles` — programmatic file picker |
| Drag and drop | CDP `Input.dispatchDragEvent` — native drag simulation |
| Touch events | CDP `Input.dispatchTouchEvent` — mobile simulation |
| Device emulation | CDP `Emulation.setDeviceMetricsOverride` — viewport + UA |
| JavaScript execution | CDP `Runtime.evaluate` — arbitrary JS in page context |

**Trade-off**: CDP attaches a debugger to the tab, which is **detectable by anti-bot
systems** (Cloudflare, DataDome, PerimeterX, etc.).

### 7.3 Stealth Mode (Anti-Bot)

Stealth mode uses `chrome.scripting.executeScript()` instead of CDP, making automation
**invisible to anti-bot detection systems**.

**How it works:**

- No debugger attachment — `navigator.webdriver` stays `false`
- `el.click()` produces `isTrusted=true` events (native browser behavior)
- Synthetic events include proper `buttons`, `pointerType`, `view` properties
- React/Angular compatibility via native value setters + `_valueTracker` reset
- Input events dispatched in correct order: `pointerdown → mousedown → pointerup → mouseup → click`

**Available in stealth mode:**

| Feature | Status |
|---------|--------|
| Navigate | ✅ |
| Screenshot | ✅ |
| Click | ✅ (`isTrusted=true`) |
| Type/input | ✅ (native setter + event dispatch) |
| Scroll | ✅ |
| Hover | ✅ |
| JavaScript execution | ✅ |
| Select dropdown | ✅ |
| Tab management | ✅ |

**NOT available in stealth mode:**

| Feature | Reason |
|---------|--------|
| File upload | Requires CDP `DOM.setFileInputFiles` |
| Accessibility tree | Requires CDP `Accessibility.getFullAXTree` |
| Drag and drop | Requires CDP `Input.dispatchDragEvent` |
| Touch events | Requires CDP `Input.dispatchTouchEvent` |
| Device emulation | Requires CDP `Emulation.setDeviceMetricsOverride` |

### 7.4 Anti-Detection Shield

**File**: `packages/browser-extension/src/shield.js`

The shield runs in the **MAIN world** at `document_start` — before any page JavaScript
executes. It patches browser APIs to prevent detection of automation:

| Patch | What It Does |
|-------|--------------|
| `navigator.webdriver` | Forces `false` via property redefinition |
| DevTools detection | Patches `console.clear` as no-op; spoofs `outerHeight`/`outerWidth` |
| `Function.prototype.toString` | Returns original native function strings for patched APIs |
| `performance.now()` timing | Normalizes to prevent timing-based detection fingerprinting |
| `Date.now()` / `Date` constructor | Patches to prevent timing-based detection |
| `requestAnimationFrame` | Patches to prevent frame-timing detection |
| Debugger trap neutralization | Prevents `debugger` statement traps from detecting automation |
| `chrome.csi` / `chrome.loadTimes` | Spoofs Chrome-specific API fingerprints |

### 7.5 Distribution

The browser extension is **not installed from a store**. Instead:

1. `scripts/zip-extension.ts` packs the extension directory into a zip archive
2. The zip is base64-encoded and embedded into `src/embedded-extension.ts`
3. At runtime, the server serves the zip at `/browser/extension`
4. Users download and load it as an unpacked extension in Chrome

---

## 7.6 Artifact Rendering Pipeline

**Files**: `packages/ui/src/artifact-*.tsx`, `packages/ui/src/chart-renderer.tsx`

Agents output structured content using `<artifact>` tags for rich visualization in the UI:

**7 Artifact Types:**

| Type | Rendering | Security |
|------|-----------|----------|
| `html` | Sandboxed iframe | DOMPurify sanitization |
| `react` | Babel + Tailwind sandbox | No direct DOM access |
| `svg` | Inline with sanitization | DOMPurify + rehype-sanitize |
| `chart` | Recharts (line/bar/pie/area/scatter/composed) | No network access |
| `csv` | Sortable HTML table | Escaped content |
| `markdown` | Full markdown + syntax highlighting | rehype-sanitize |
| `code` | Prism syntax highlighting (32+ languages) | Read-only display |

**Sandbox Model:**
- HTML/React run in `<iframe sandbox="allow-scripts">` (no external network, DOM access, or cookie leakage)
- Direct `<iframe>` access isolated from parent page origin
- DOMPurify strips dangerous attributes/scripts before rendering
- rehype-sanitize filters unsafe HTML in markdown

**Sidebar Rendering:**
- html, react, markdown, code types render full-screen in sidebar panel
- csv tables render in interactive sortable view
- chart/svg available for quick preview

**Chart Format:**
```json
{
  "type": "line",
  "data": [{"month": "Jan", "value": 100}],
  "xKey": "month",
  "series": [{"key": "value", "name": "Series 1"}],
  "title": "Title"
}
```

Max 1000 data points, 10 series per chart.

---

## 8. Sub-Agent System (Spaces)

The Spaces system allows agents to delegate tasks to isolated sub-agents that run in
parallel.

### 8.1 Space Lifecycle

```
Parent Agent                    Spaces System                   Sub-Agent
    │                               │                               │
    │  spawn_agent(task, name)      │                               │
    ├──────────────────────────────►│                               │
    │                               │  Create isolated channel      │
    │                               │  {parent}:space:{uuid}        │
    │                               ├──────────────────────────────►│
    │                               │  Start new WorkerLoop         │
    │                               │  (inherits provider/model)    │
    │                               │                               │
    │                               │           ... working ...     │
    │                               │                               │
    │                               │  respond_to_parent(result)    │
    │                               │◄──────────────────────────────┤
    │  Result posted to parent      │                               │
    │  channel + space locked       │  Space status → completed     │
    │◄──────────────────────────────┤                               │
    │                               │                               │
```

**Key details:**

- **Isolated channel**: Each space gets its own channel (`{parent}:space:{uuid}`) so
  conversations don't interfere
- **Inheritance**: Sub-agents inherit the parent's project path, LLM provider, and model
- **Concurrency limit**: Maximum **3 concurrent spaces** globally (not per-channel)
- **Timeout**: Default **300 seconds** (5 minutes); `spawn_agent` overrides to 600 seconds
- **Result delivery**: Sub-agent calls `respond_to_parent(result)` which posts the result
  to the parent channel and locks the space (preventing further messages)

**Sub-agent tools**: Sub-agents receive only `respond_to_parent` and `get_space_info` tools.

**Space statuses**: `active` → `completed` | `failed` | `timed_out`

### 8.2 Scheduler Integration

**Files**: `src/scheduler/manager.ts`, `src/scheduler/runner.ts`, `src/scheduler/parse-schedule.ts`

The scheduler creates and manages recurring or one-time jobs:

| Job Type | Behavior |
|----------|----------|
| `cron` | Runs on a cron schedule (e.g., `0 9 * * 1-5` for weekday 9 AM) |
| `interval` | Runs every N seconds/minutes/hours |
| `once` | Runs once at a specific time |
| Reminder | Posts a message without creating a sub-space |
| Tool call | Executes a tool directly without agent involvement |

**Execution flow:**

1. Scheduler **tick loop** runs every **10 seconds**
2. Checks for jobs whose next run time has passed
3. For agent tasks: creates a **sub-space** with the job's instructions
4. Maximum **3 concurrent jobs** globally
5. Natural language schedule parsing via `parse-schedule.ts` (e.g., "every weekday at 9am")

---

## 9. Sandbox Security

Tool execution is sandboxed to prevent agents from accessing sensitive host resources.
The sandbox implementation differs by platform.

### 9.1 Linux (bubblewrap)

Uses [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) for
**filesystem isolation via bind mounts and a clean environment**:

- Filesystem is constructed from explicit bind mounts
- Clean environment — not inherited from host
- Agents share the host PID and network namespace (no PID or network namespace isolation)
- No access to anything not explicitly allowed

### 9.2 macOS (sandbox-exec)

Uses `sandbox-exec` with Seatbelt profiles:

- **Allow-default** policy with explicit deny rules for writes
- Less strict than Linux bubblewrap but still prevents unauthorized file access

### 9.3 Access Policy

| Access | Paths |
|--------|-------|
| **Read + Write** | `{projectRoot}`, `/tmp` |
| **Read + Write** (macOS only) | `~/.clawd` |
| **Read only** | `/usr`, `/bin`, `/lib`, `/etc`, `~/.bun`, `~/.cargo`, `~/.deno`, `~/.nvm`, `~/.local` |
| **Read only** (Linux bwrap) | `~/.clawd/bin`, `~/.clawd/.ssh`, `~/.clawd/.gitconfig` |
| **Blocked** | `{projectRoot}/.clawd/` (agent config directory) |
| **Blocked** | Home directory (except explicitly allowed tool directories) |

**Environment handling:**

- Agent environment is **cleaned and rebuilt** — not inherited from the host
- Only safe variables from `~/.clawd/.env` are passed through
- API keys and secrets are injected explicitly, not via host environment

---

## 10. Remote Worker Bridge

External machines can connect to the clawd server as **remote tool providers**, extending
an agent's capabilities across multiple hosts.

```
┌─────────────────────┐        WebSocket         ┌──────────────────────┐
│ Remote Machine      │ ◄─────────────────────── │ Claw'd Server        │
│ (worker)            │                           │                      │
│ ├─ Custom tools     │  worker:registered event  │ RemoteWorkerBridge   │
│ └─ worker_token auth│ ─────────────────────────►│ ├─ SHA256 token hash │
└─────────────────────┘                           │ └─ Channel authz     │
                                                  └──────────────────────┘
```

**How it works:**

1. A `worker_token` is configured in `channel_agents` for a specific agent+channel
2. Remote worker connects via WebSocket with the token
3. `RemoteWorkerBridge` hashes the token (SHA256) and validates it
4. Worker registers its available tools
5. Tools from the remote worker appear **alongside local tools** in the agent's toolset
6. Workers can be limited to **specific channels** for authorization

---

## 11. WebSocket Events

All real-time communication flows through the WebSocket connection at `/ws`.

### Server → Client Events

| Event | Payload | Description |
|-------|---------|-------------|
| `message` | `{ ts, channel, user, text, ... }` | New message posted |
| `message_changed` | `{ ts, channel, text, ... }` | Message edited |
| `message` (with `deleted: true`) | `{ ts, channel, deleted: true }` | Message removed (sent as regular `message` event with `deleted` flag) |
| `channel_cleared` | `{ channel }` | Channel messages cleared |
| `agent_streaming` | `{ agent_id, channel, streaming }` | Agent started/stopped thinking |
| `agent_token` | `{ agent_id, channel, token, type }` | Real-time LLM output (`content` or `thinking` type) |
| `agent_tool_call` | `{ agent_id, tool, status }` | Tool execution event (`started` / `completed` / `error`) |
| `reaction_added` | `{ ts, channel, user, reaction }` | Emoji reaction added |
| `reaction_removed` | `{ ts, channel, user, reaction }` | Emoji reaction removed |
| `message_seen` | `{ ts, channel, user }` | Read receipt |
| `agent_heartbeat` | `{ agent_id, channel, event, timestamp }` | Heartbeat events (event: `heartbeat_sent`, `processing_timeout`, `space_auto_failed`) |

### Client → Server Events

Messages are sent via HTTP POST to `/api/chat.postMessage`. The WebSocket is primarily
a **server-to-client push channel** — clients send messages via the REST API.

---

## 12. API Reference

All API endpoints are available at `/api/{method}` via POST (or GET where noted).

### 12.1 Chat APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `conversations.list` | GET | List all channels |
| `conversations.create` | POST | Create a new channel |
| `conversations.history` | GET | Message history (paginated) |
| `conversations.replies` | GET | Thread replies for a message |
| `conversations.search` | GET | Full-text message search |
| `conversations.around` | GET | Messages around a specific timestamp |
| `conversations.newer` | GET | Messages newer than a timestamp |
| `chat.postMessage` | POST | Send a message to a channel |
| `chat.update` | POST | Edit an existing message |
| `chat.delete` | POST | Delete a message |

### 12.2 File APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `files.upload` | POST | Upload a file attachment |
| `files/{id}` | GET | Download/serve a file by ID |

### 12.3 Reaction APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `reactions.add` | POST | Add an emoji reaction to a message |
| `reactions.remove` | POST | Remove an emoji reaction |

### 12.4 Agent Streaming APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `agent.setStreaming` | POST | Set agent streaming state (thinking/idle) |
| `agent.streamToken` | POST | Push a streaming LLM token |
| `agent.streamToolCall` | POST | Push a tool call event |

### 12.5 Agent Management APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `agent.markSeen` | POST | Update agent's read cursor |
| `agent.setSleeping` | POST | Hibernate or wake an agent |
| `agent.setStatus` | POST | Set agent status for a channel |
| `agent.getThoughts` | GET | Get agent's current thinking/reasoning |
| `agents.list` | GET | List all registered agents |
| `agents.info` | GET | Get info about a specific agent |
| `agents.register` | POST | Register a new agent |

### 12.6 App Management APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `app.agents.list` | GET | List app-level agent configurations |
| `app.agents.add` | POST | Add a new agent configuration |
| `app.agents.remove` | POST | Remove an agent configuration |
| `app.agents.update` | POST | Update an agent configuration |
| `app.models.list` | GET | List available LLM models |
| `app.mcp.list` | GET | List configured MCP servers |
| `app.mcp.add` | POST | Add an MCP server configuration |
| `app.mcp.remove` | POST | Remove an MCP server configuration |

### 12.7 Project Browser APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `app.project.tree` | GET | Get project file tree |
| `app.project.listDir` | GET | List files in a directory |
| `app.project.readFile` | GET | Read a file's contents |

### 12.8 Analytics APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `analytics/copilot/calls` | GET | Raw API call log |
| `analytics/copilot/summary` | GET | Usage summary statistics |
| `analytics/copilot/keys` | GET | API key usage breakdown |
| `analytics/copilot/models` | GET | Per-model usage statistics |
| `analytics/copilot/recent` | GET | Recent API calls |

### 12.9 Task Management APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `tasks.list` | GET | List tasks/projects |
| `tasks.get` | GET | Get a specific task |
| `tasks.create` | POST | Create a new task |
| `tasks.update` | POST | Update an existing task |
| `tasks.delete` | POST | Delete a task |
| `tasks.addAttachment` | POST | Add an attachment to a task |
| `tasks.removeAttachment` | POST | Remove an attachment from a task |
| `tasks.addComment` | POST | Add a comment to a task |

### 12.9b Plan Management APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `plans.*` | Various | Plan management CRUD |

### 12.9c User APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `user.markSeen` | POST | Mark messages as seen |
| `user.getUnreadCounts` | GET | Get unread message counts |
| `user.getLastSeen` | GET | Get last seen timestamps |

### 12.9d Spaces APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `spaces.list` | GET | List spaces |
| `spaces.get` | GET | Get a specific space |

### 12.9e Skills APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `skills.list` | GET | List available skills (from 4 sources) |
| `skills.get` | GET | Get a specific skill |
| `skills.create` | POST | Add custom skill |
| `skills.delete` | POST | Remove a custom skill |

### 12.9f Custom Tools APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `custom_tool` | POST | Create/edit/delete/execute custom tools |

### 12.10 Special Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | GET/POST | MCP SSE endpoint for external clients |
| `/health` | GET | Liveness probe (returns 200) |
| `/browser/ws` | WS | Browser extension WebSocket bridge |
| `/browser/extension` | GET | Download packed browser extension |
| `/browser/files/*` | GET | Serve files for browser extension |
| `/worker/ws` | WS | Remote worker WebSocket bridge |
| `auth.test` | POST | Validate authentication |
| `channel.status` | GET | Get channel status summary |
| `config/reload` | POST | Reload config.json without restart |
| `keys/status` | GET | API key health status |
| `keys/sync` | POST | Sync API keys |
| `admin.migrateChannels` | POST | Migrate channel data |
| `admin.renameChannel` | POST | Rename a channel |
| `articles.*` | Various | Knowledge article CRUD |

---

## 13. LLM Provider System

Claw'd is provider-agnostic — agents can use any supported LLM provider, configured
per-channel or globally.

### Supported Providers

| Provider | API Type | Notes |
|----------|----------|-------|
| `copilot` | GitHub Copilot API | Recommended default; uses GitHub token |
| `openai` | OpenAI API | GPT-4o, o1, o3, etc. |
| `anthropic` | Anthropic API | Claude Opus, Sonnet, Haiku |
| `ollama` | Ollama API | Local models via Ollama |
| `minimax` | Minimax API | Image generation and other capabilities |

### Provider Configuration

Each provider is configured in the `providers` section of `~/.clawd/config.json`:

```json
{
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
    "ollama": {
      "base_url": "http://localhost:11434",
      "model": "llama3"
    },
    "minimax": {
      "api_key": "...",
      "model": "image-01"
    }
  }
}
```

### Per-Channel Override

Agents can be assigned different providers per channel via `channel_agents.provider` and
`channel_agents.model`. This allows mixing providers — e.g., Claude for code tasks and
GPT for creative writing — in the same instance.

### Vision Configuration

Vision operations (image analysis, generation, editing) use a separate provider
configuration. Supported vision providers: `copilot`, `gemini`, `minimax`.

```json
{
  "vision": {
    "provider": "copilot",
    "model": "gpt-4.1",
    "read_image": { "provider": "gemini", "model": "gemini-2.0-flash" },
    "generate_image": { "provider": "minimax", "model": "image-01" },
    "edit_image": { "provider": "minimax", "model": "image-01" }
  }
}
```

Gemini vision requires `GEMINI_API_KEY` in `~/.clawd/.env`. The system uses a
Gemini → Minimax fallback chain for image generation.

---

## 14. Chat UI

Built with React + Vite + TypeScript, the UI is embedded into the server binary at build
time and served as a single-page application.

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `App.tsx` | `packages/ui/src/App.tsx` | Root: WebSocket connection, state management, channel routing |
| `MessageList.tsx` | `packages/ui/src/MessageList.tsx` | Message rendering, streaming output, space cards |
| `StreamOutputDialog` | (in MessageList) | Real-time display of agent tool execution output |
| `styles.css` | `packages/ui/src/styles.css` | All application styles |

### Real-Time Features

The UI connects to the server via WebSocket at `/ws` and handles:

- **Live streaming**: `agent_token` events render LLM output character-by-character
- **Tool call cards**: `agent_tool_call` events show tool execution with started/completed/error states
- **Thinking indicator**: `agent_streaming` events show when agents are processing
- **Read receipts**: `message_seen` events mark messages as read
- **Reactions**: Emoji reactions with real-time add/remove
- **Space cards**: Sub-agent spaces show as expandable cards with status indicators

---

## 15. Build System

The build process compiles everything into a single self-contained binary.

### Build Pipeline

```
bun run build
    │
    ├─ 1. Vite builds UI
    │     packages/ui/ → packages/ui/dist/
    │
    ├─ 2. embed-ui.ts
    │     packages/ui/dist/ → base64 → src/embedded-ui.ts
    │
    ├─ 3. zip-extension.ts
    │     packages/browser-extension/ → zip → base64 → src/embedded-extension.ts
    │
    └─ 4. bun build --compile
          src/index.ts → dist/server/clawd-app (single binary)
```

### Build Commands

| Command | Output |
|---------|--------|
| `bun run dev` | Run server directly from TypeScript (no compile) |
| `bun run build` | Full build → single-platform binary |
| `bun run build:all` | Full build → all platform binaries |
| `bun run build:linux` | Linux x64 binary |
| `bun run install:local` | Copy binary to `~/.clawd/bin/clawd-app` |

### CLI Options

```
clawd-app [options]
  --host <host>     Bind address (default: 0.0.0.0)
  -p, --port <n>    Port number (default: 3456)
  --no-browser      Don't auto-open browser on start
  --yolo            Disable sandbox restrictions for agent tools
  --debug           Enable verbose debug logging
  -h, --help        Show help
```

---

## 16. Docker Deployment

### Multi-Stage Dockerfile

The Dockerfile uses a two-stage build for minimal image size:

**Stage 1 — Builder** (`oven/bun:1`):
1. Install dependencies (`bun install`)
2. Build UI with Vite
3. Embed UI assets into TypeScript source
4. Zip and embed browser extension
5. Compile to native binary (`bun build --compile`)

**Stage 2 — Runtime** (`debian:bookworm-slim`):
1. Install runtime dependencies: git, ripgrep, python3, tmux, build-essential, bun, rust, bubblewrap, curl
2. Copy compiled binary from builder stage
3. Run as non-root `clawd` user
4. Healthcheck on `/health` endpoint

### Docker Compose

```yaml
# compose.yaml
services:
  clawd:
    image: clawd-pilot/clawd:latest
    build: .
    restart: unless-stopped
    ports:
      - "3456:3456"
    volumes:
      - clawd-data:/home/clawd/.clawd
    security_opt:
      - apparmor=unconfined  # Required for bubblewrap sandbox
      - seccomp=unconfined

volumes:
  clawd-data:
```

The `apparmor=unconfined` and `seccomp=unconfined` security options are required because the bubblewrap sandbox
inside the container needs to create namespaces, which AppArmor and seccomp block by default.

**Note**: The healthcheck is defined in the `Dockerfile` (not compose.yaml) using `curl -f http://localhost:3456/health`.

---

## 17. Configuration Reference

### 17.1 config.json Schema

**Location**: `~/.clawd/config.json`

```json
{
  // Server settings
  "host": "0.0.0.0",
  "port": 3456,
  "debug": false,
  "yolo": false,
  "contextMode": true,       // Note: hardcoded to true in code; not actually configurable at runtime
  "dataDir": "~/.clawd/data",
  "uiDir": "/custom/ui/path",

  // Environment variables passed to agent sandbox
  "env": {
    "KEY": "VALUE"
  },

  // LLM provider configurations
  "providers": {
    "copilot": { "model": "claude-sonnet-4-5", "token": "ghp_..." },
    "openai": { "base_url": "...", "api_key": "...", "model": "gpt-4o" },
    "anthropic": { "api_key": "...", "model": "claude-opus-4-5" },
    "ollama": { "base_url": "http://localhost:11434", "model": "llama3" },
    "minimax": { "api_key": "...", "model": "image-01" }
  },

  // Image generation quotas
  "quotas": {
    "daily_image_limit": 50
  },

  // Workspace plugin toggle
  // true = all channels, false = disabled, ["channel1"] = specific channels
  "workspaces": true,

  // Remote worker configuration
  // true = accept workers, { "channel": ["token1"] } = per-channel tokens
  "worker": true,

  // Vision model configuration
  "vision": {
    "provider": "copilot",
    "model": "gpt-4.1",
    "read_image": { "provider": "copilot", "model": "gpt-4.1" },
    "generate_image": { "provider": "minimax", "model": "image-01" },
    "edit_image": { "provider": "minimax", "model": "image-01" }
  },

  // Browser extension toggle
  // true = all channels, false = disabled, ["channel"] = specific channels
  // { "channel": ["auth_token"] } = per-channel with auth
  "browser": true,

  // Memory system configuration
  // true = enabled with defaults
  // { "provider": "...", "model": "...", "autoExtract": true } = custom config
  "memory": true,

  // Heartbeat monitor for stuck-agent recovery
  "heartbeat": {
    "enabled": true,
    "intervalMs": 30000,
    "processingTimeoutMs": 300000,
    "spaceIdleTimeoutMs": 60000
  },

  // API authentication (optional)
  // When set, all API requests require: Authorization: Bearer <token>
  "auth": {
    "token": "your-secret-token"
  }
}
```

### 17.2 System Files & Directories

```
~/.clawd/
├── config.json          # App configuration (see schema above)
├── .env                 # Agent environment variables (KEY=VALUE format)
├── .ssh/                # SSH keys for Git operations (id_ed25519)
├── .gitconfig           # Git config for agent-initiated Git operations
├── bin/                 # Custom binaries added to agent PATH
├── data/
│   ├── chat.db          # Chat messages, agents, channels, spaces
│   ├── kanban.db        # Tasks, plans, phases
│   ├── scheduler.db     # Scheduled jobs
│   └── attachments/     # Uploaded files & generated images
├── memory.db            # Agent session memory, knowledge base, long-term memories
└── mcp-oauth-tokens.json # OAuth tokens for external MCP server connections
```

| File/Directory | Purpose |
|----------------|---------|
| `config.json` | Primary configuration — providers, features, server settings |
| `.env` | Environment variables injected into agent sandbox (e.g., API keys) |
| `.ssh/` | SSH keys used by agents for Git clone/push operations |
| `.gitconfig` | Git user config (name, email) for agent commits |
| `bin/` | Custom executables available in agent's PATH |
| `data/chat.db` | All chat state — messages, agents, channels, spaces |
| `data/scheduler.db` | Scheduled jobs and execution state |
| `data/attachments/` | File storage for uploads and generated images |
| `memory.db` | LLM session history, knowledge base, long-term agent memories |
| `mcp-oauth-tokens.json` | Cached OAuth tokens for authenticated MCP server connections |

