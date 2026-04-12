# Claw'd — Project Overview & Product Development Requirements

> Last updated: 2026-04-01

---

## Executive Summary

**Claw'd** is an open-source, agentic collaborative chat platform where AI agents operate autonomously through a real-time web interface. Multiple agents can communicate with users and each other, execute code in sandboxed environments, control remote browsers, spawn sub-agents for parallel work, and persist memories across sessions.

**Single-binary deployment**: Compiles to one executable with embedded React UI, Chrome extension, and TypeScript agent runtime. Works on Linux, macOS, and Windows (with limitations).

**Key differentiators:**
- Multi-agent orchestration with per-channel isolation
- Browser automation (26 tools via Chrome extension + remote workers)
- Git isolated mode for concurrent multi-agent editing
- Sandboxed execution (bubblewrap/sandbox-exec)
- 3-tier memory system (session, knowledge base, long-term)
- Plugin-based architecture for extensibility
- Provider-agnostic LLM support (Copilot, OpenAI, Anthropic, Ollama, Minimax)
- MCP (Model Context Protocol) support both as server and client

---

## System Architecture

### High-Level Components

```
┌─ User Browser (React SPA) ────────┐
│                                    │
│  App.tsx                           │
│  ├─ MessageList                    │
│  ├─ WorktreeDialog (Git UI)        │
│  ├─ ProjectsDialog (File Browser)  │
│  ├─ AgentDialog (Config)           │
│  └─ Artifact Renderers             │
│                                    │
└──────────────┬─────────────────────┘
               │ HTTP/WebSocket
               ▼
┌─ Claw'd Server (src/index.ts) ────┐
│                                    │
│  Worker Manager                    │
│  ├─ Worker Loop 1 (Agent A)        │
│  ├─ Worker Loop 2 (Agent B)        │
│  └─ Heartbeat Monitor              │
│                                    │
│  SQL Databases (WAL mode)          │
│  ├─ chat.db (messages, agents)     │
│  ├─ memory.db (LLM sessions)       │
│  ├─ kanban.db (tasks, plans)       │
│  └─ scheduler.db (jobs)            │
│                                    │
│  Plugin System                     │
│  ├─ Browser Plugin                 │
│  ├─ Workspace Plugin (Git)         │
│  ├─ MCP Plugin                     │
│  └─ Custom Plugins                 │
│                                    │
└────────────────────────────────────┘
         │              │
         ▼              ▼
    Chrome Ext     Remote Workers
    (CDP/Stealth)   (TS/Py/Java)
```

### Data Flow

1. **User → Server**: HTTP POST to `/api/chat.postMessage` with text + files
2. **Server → Agent**: Message queued in chat.db; worker loop detects and processes
3. **Agent → LLM**: Worker calls provider (Copilot/OpenAI/Anthropic/etc.)
4. **Agent → Tools**: Plugin system executes tool calls (file, bash, browser, etc.)
5. **Tools → Sandbox**: Tool execution runs in isolated namespace (bubblewrap/sandbox-exec)
6. **Results → Agent**: Tool output injected back into LLM context
7. **Agent → UI**: Streaming tokens + tool results broadcast via WebSocket
8. **Sub-agents**: spawn_agent creates isolated channel for parallel work

---

## Core Features

### 1. Multi-Agent Orchestration

**What it does:**
- Multiple agents per channel, each with own configuration
- Per-agent polling loop (200ms interval)
- Agents can see each other's messages, communicate
- Configurable per-agent: provider, model, project path, heartbeat interval

**Files:**
- `src/worker-manager.ts` — Agent startup, heartbeat monitor
- `src/worker-loop.ts` — Per-agent 200ms polling cycle
- `src/agent/agent.ts` — Core reasoning engine

**Configuration:**
```json
{
  "provider": "copilot",
  "model": "default",
  "project": "/path/to/project",
  "heartbeatInterval": 30
}
```

### 2. Git Worktree Isolation

**What it does:**
- Each agent gets isolated worktree: `{projectRoot}/.clawd/worktrees/{agentId}/`
- Dedicated branch per agent: `clawd/{randomId}` (6-char hex, e.g., `clawd/a1b2c3`)
- Near-zero disk overhead (git hard-links shared with main project)
- Prevents file conflicts in multi-agent channels
- Worktrees persisted in DB (`channel_agents.worktree_path`, `worktree_branch`), reused on restart
- Only applies to git repositories; non-git projects skip git worktree isolation
- Agent does NOT know it's in a worktree — system prompt identical to normal git mode
- Humans only apply changes via UI (Git dialog) — no direct merge to main

**UI Components:**
- "Git" dialog (`WorktreeDialog.tsx`) — Unified UI for worktree or direct repo access
- `worktree-diff-viewer.tsx` — Per-hunk staging with inline controls
- `worktree-file-list.tsx` — Resizable file tree sidebar
- Both dialogs: resizable sidebar, fullscreen on mobile, refresh button

**API Endpoints (18 total):**
- 4 read: `.enabled`, `.status`, `.diff`, `.log`
- 14 write: `.stage`, `.unstage`, `.discard`, `.commit`, `.merge`, `.resolve`, `.abort`, `.apply`, `.stash`, `.stash_pop`, `.push`, `.stage_hunk`, `.revert_hunk`, `.unstage_hunk`

**Hunk Staging:**
- Identified by SHA1 content-hash (not index-based)
- Enables detection when diff changes since UI render
- Per-hunk stage/unstage/revert/discard actions
- Returns 409 if hash doesn't match (user must refresh diff)

**Author Handling:**
- Git local config (user.name/email) — primary author, `config.author` becomes Co-Authored-By trailer
- No local config — `config.author` becomes main author (via -c flags)
- Used via `git interpret-trailers` for safe trailer injection

**Files:**
- `src/agent/workspace/worktree.ts` — Lifecycle, diff parsing, hunk operations
- `src/server/routes/worktree.ts` — 18 REST endpoints
- `src/config/config-file.ts` — `worktree` bool/string[] and `author` config

### 3. Browser Automation (26 Tools)

**Two operation modes:**

**CDP Mode (Normal):**
- Uses Chrome DevTools Protocol via `chrome.debugger` API
- Full feature set: screenshots, accessibility tree, file upload, drag/drop, touch
- Detectable by anti-bot systems

**Stealth Mode (Anti-Detection):**
- Uses `chrome.scripting.executeScript()` — invisible to anti-bot
- Limited to: navigation, click, type, scroll, hover, JavaScript execution
- No file upload, accessibility tree, or device emulation

**Anti-Detection Shield:**
- `navigator.webdriver` → false
- DevTools detection bypass
- Function.prototype.toString spoofing
- Performance timing normalization

**Files:**
- `packages/browser-extension/src/service-worker.js` (~2800 lines)
- `packages/browser-extension/src/shield.js`
- `src/server/browser-bridge.ts` — WebSocket bridge

### 4. Sandboxed Tool Execution

**Linux:**
- bubblewrap (bwrap) — deny-by-default namespace isolation
- Custom seccomp filters

**macOS:**
- sandbox-exec with Seatbelt profiles
- Allow-default approach with strategic denials

**Windows:**
- Path validation only
- Supports PowerShell, cmd.exe, bash

**Access Policy:**
- **Read/Write**: `{projectRoot}` (excluding `.clawd/`), `/tmp`, `~/.clawd`
- **Read-only**: `/usr`, `/bin`, `/lib`, `/etc`, runtime directories
- **Blocked**: Home directory (except tool dirs), `.clawd/` (config)

**Files:**
- `src/agent/utils/sandbox.ts`

### 5. Memory System (3-Tier)

**Tier 1: Session Memory**
- Full conversation history with LLM
- Stored in `memory.db → messages`
- Subject to compaction at token thresholds
- Smart scoring: messages weighted by type and recency
- Last 20 messages kept in full; older messages compacted

**Tier 2: Knowledge Base**
- FTS5-indexed tool output chunks
- Fast semantic retrieval without re-executing tools
- Stored in `memory.db → knowledge`

**Tier 3: Agent Memory**
- Long-term facts, preferences, decisions
- FTS5-indexed, persists across sessions
- Injected into system prompt when relevant

**Compaction Strategy:**
- **Threshold**: 75% of token limit (warning), 95% (critical)
- **Aggressive compaction**: Preserve last 15 messages, compact older messages
- **Full reset**: If still over critical, generate LLM summary (4K tokens) + clear history

**Files:**
- `src/agent/memory/` (memory.ts, knowledge-base.ts, agent-memory.ts)
- `src/agent/session/summarizer.ts`

### 6. Sub-Agent System (Spaces)

**What it does:**
- Agents delegate work via `spawn_agent(task, agent="code-reviewer")`
- Creates isolated channel `{parent}:{uuid}`
- Sub-agent inherits parent's provider, model, project
- Returns results via `complete_task(result)`
- Auto-cleanup after completion or timeout (default 300s, configurable to 600s)

**Constraints:**
- Max 9 concurrent spaces per channel
- Max 20 concurrent spaces globally
- Auto-fail after 10 consecutive heartbeats with no progress

**Features:**
- Colored avatars instead of black
- `list_agents(type="running")` shows spawned sub-agents
- `get_agent_logs(agent_id, tail?)` gets output logs of a sub-agent
- Optional `agent` parameter to load specific agent file

**Files:**
- `src/spaces/manager.ts`
- `src/spaces/worker.ts`
- `src/spaces/spawn-plugin.ts`

### 7. Scheduler

**Job Types:**
- **Cron jobs** — Execute on schedule (e.g., "every Monday at 9am")
- **Interval jobs** — Run every N seconds
- **Once jobs** — One-time execution
- **Reminders** — Post messages without sub-spaces
- **Tool calls** — Execute tools directly

**Execution Model:**
- Tick loop runs every 10 seconds
- Max 3 concurrent jobs globally
- Jobs create sub-spaces (same as spawn_agent)
- Natural language schedule parser

**Files:**
- `src/scheduler/manager.ts`
- `src/scheduler/runner.ts`
- `src/scheduler/parse-schedule.ts`

### 8. Artifact Rendering (8 Types)

**Supported artifact types:**

| Type | Rendering | Use Case |
|------|-----------|----------|
| `html` | Sandboxed iframe (DOMPurify) | Web pages, custom HTML |
| `react` | Babel + Tailwind sandbox | Interactive React components |
| `svg` | Inline (DOMPurify + rehype-sanitize) | Diagrams, vector graphics |
| `chart` | Recharts (6 chart types) | Data visualization |
| `csv` | Sortable HTML table | Spreadsheet data |
| `markdown` | Full markdown pipeline | Formatted text |
| `code` | Prism syntax highlighting (32+ languages) | Source code |
| `interactive` | JSON component spec | Rendered inline as interactive UI widgets |

**Inline rendering:** chart, svg, code, interactive
**Sidebar rendering (click preview):** html, react, csv, markdown

**Files:**
- `packages/ui/src/artifact-*.tsx`
- `packages/ui/src/chart-renderer.tsx`

---

## Technical Requirements

### Functional Requirements

#### FR-1: Multi-Agent Messaging
- **Requirement**: Multiple agents per channel, each with independent configuration
- **Acceptance Criteria**:
  - Agents can be added/removed from channels
  - Each agent has per-channel: provider, model, project path, heartbeat interval
  - Messages are routed to correct agent
  - Agents can see all channel messages
- **Files Involved**: `src/worker-manager.ts`, `src/server/database.ts`

#### FR-2: Git Worktree Isolation
- **Requirement**: Multi-agent channels use git worktrees to prevent file conflicts
- **Acceptance Criteria**:
  - Worktree created at `{projectRoot}/.clawd/worktrees/{agentId}/` (same filesystem, hard-linked files)
  - Branch naming: `clawd/{randomId}` where {randomId} is 6-char hex (e.g., `clawd/a3f7b2`)
  - Worktrees persisted in DB (`channel_agents.worktree_path`, `worktree_branch`), reused on server restart
  - Agent is unaware of worktree — system prompt identical to normal git mode
  - Diff/commit/push/merge/stash operations available via API (18 endpoints)
  - Per-hunk staging uses SHA1 content-hash for stability; returns 409 if hash changes
  - Humans only apply changes via Git dialog UI; agent cannot force-merge to main
  - Non-git projects skip git worktree isolation (but Git dialog still works for direct repos)
  - Author handling: git local config preferred, `config.author` as Co-Authored-By or main author
  - Sandbox mounts original `.git/` read-only; worktree path is projectRoot
- **Files Involved**: `src/agent/workspace/worktree.ts`, `src/server/routes/worktree.ts`, `src/config/config-file.ts`, UI components

#### FR-3: Browser Automation
- **Requirement**: Agents can control Chrome browser remotely
- **Acceptance Criteria**:
  - 26 browser tools available (navigate, click, screenshot, etc.)
  - Two modes: CDP (normal) and Stealth (anti-detection)
  - Screenshots capture full page or viewport
  - File upload, drag/drop, touch events supported in CDP mode
  - Anti-detection shield patches browser APIs
  - Per-channel auth token validation
- **Files Involved**: `packages/browser-extension/`, `src/server/browser-bridge.ts`

#### FR-4: Sandboxed Execution
- **Requirement**: All tool execution runs in isolated sandbox
- **Acceptance Criteria**:
  - Linux: bubblewrap (bwrap) with deny-by-default namespace isolation
  - macOS: sandbox-exec with Seatbelt profiles
  - Windows: path validation only
  - Only safe environment variables injected
  - Timeout: 30s default (max 300s)
  - Git operations have guards (commit author, protected branches, etc.)
- **Files Involved**: `src/agent/utils/sandbox.ts`

#### FR-5: Memory System
- **Requirement**: 3-tier persistent memory (session, knowledge, agent memories)
- **Acceptance Criteria**:
  - Session messages compacted at token thresholds
  - Knowledge base indexed with FTS5 for semantic search
  - Agent memories (facts, preferences) retrieved via FTS5
  - Context compaction at 75%, critical reset at 95% token limit
  - Smart message scoring (type, recency)
  - Full LLM summary on critical reset
- **Files Involved**: `src/agent/memory/`, `src/agent/session/`

#### FR-6: Sub-Agent Spawning
- **Requirement**: Agents can delegate tasks to sub-agents via Spaces
- **Acceptance Criteria**:
  - `spawn_agent(task, agent="name")` creates isolated channel
  - Sub-agent inherits parent's provider, model, project
  - `complete_task(result)` returns work to parent
  - Auto-cleanup after timeout or completion
  - `list_agents(type="running")` shows spawned sub-agents
  - Max 9 concurrent spaces per channel, 20 globally
  - Auto-fail circuit breaker (10 consecutive heartbeats)
- **Files Involved**: `src/spaces/`

#### FR-7: Scheduler
- **Requirement**: Schedule and execute automated jobs
- **Acceptance Criteria**:
  - Cron, interval, once, reminder, and tool-call job types
  - Natural language schedule parser (e.g., "every Monday at 9am")
  - Jobs create sub-spaces for execution
  - 10s tick loop, max 3 concurrent jobs globally
  - Results posted to channel
- **Files Involved**: `src/scheduler/`

#### FR-8: Heartbeat Monitor
- **Requirement**: Automatic stuck-agent detection and recovery
- **Acceptance Criteria**:
  - Heartbeat injected into idle agents (default 30s interval)
  - Processing timeout cancels stuck agents (default 5 min)
  - Sub-agent space auto-fails after 10 consecutive heartbeats
  - WebSocket events: `heartbeat_sent`, `processing_timeout`, `space_auto_failed`
  - Configurable: enabled, intervalMs, processingTimeoutMs, spaceIdleTimeoutMs
- **Files Involved**: `src/worker-manager.ts`

### Non-Functional Requirements

#### NFR-1: Single Binary Deployment
- **Requirement**: Compile to single executable with embedded assets
- **Acceptance Criteria**:
  - React UI embedded in binary
  - Chrome extension zipped and base64-encoded
  - TypeScript code AOT-compiled
  - ~60-80MB binary size (varies by platform)
  - No external dependencies at runtime (except system libraries)
- **Files Involved**: `scripts/embed-ui.ts`, `scripts/zip-extension.ts`

#### NFR-2: Multi-Platform Support
- **Requirement**: Run on Linux, macOS, Windows
- **Acceptance Criteria**:
  - Sandbox: bubblewrap (Linux), sandbox-exec (macOS), path validation (Windows)
  - Shell detection: bash (Unix), PowerShell/cmd.exe (Windows)
  - Cross-platform build pipeline
  - Docker support with proper security options
- **Files Involved**: `src/agent/utils/sandbox.ts`, `src/agent/tools/tools.ts`

#### NFR-3: Performance
- **Requirement**: Handle 10+ concurrent agents efficiently
- **Acceptance Criteria**:
  - Worker loop: 200ms polling interval
  - Database: SQLite WAL mode for concurrent access
  - Tool filtering: Prune unused tools after 5-iteration warmup
  - Model tiering: Auto-downgrade to Haiku for routing decisions
  - Message pagination: Lazy loading in UI
  - Worktree: Cache status for 5 seconds
- **Files Involved**: `src/agent/agent.ts`, `src/server/database.ts`

#### NFR-4: Security
- **Requirement**: Protect agent config, prevent code injection, validate inputs
- **Acceptance Criteria**:
  - Path validation before sandbox entry
  - Parameterized SQL queries (prevent injection)
  - Token hashing (SHA256) before storage
  - `.clawd/` directory blocked in sandbox
  - Original `.git/` mounted read-only
  - Artifact sanitization (DOMPurify + rehype-sanitize)
- **Files Involved**: `src/agent/utils/sandbox.ts`, `src/server/routes/worktree.ts`

#### NFR-5: Scalability
- **Requirement**: Support large codebases and long conversations
- **Acceptance Criteria**:
  - Context compaction at token thresholds
  - Knowledge base FTS5 indexing for fast retrieval
  - Prepared statements for query reuse
  - Sub-agents for parallel task execution
  - Remote workers to distribute tools across machines
- **Files Involved**: `src/agent/agent.ts`, `src/agent/memory/`

#### NFR-6: Reliability
- **Requirement**: Graceful degradation, error recovery, persistence
- **Acceptance Criteria**:
  - Automatic retry with exponential backoff for transient failures
  - Checkpoint system for session recovery
  - Database transactions for atomic operations
  - Heartbeat monitor for stuck-agent recovery
  - Worktree persistence across restarts
- **Files Involved**: `src/worker-loop.ts`, `src/agent/session/`

---

## Configuration Schema

### config.json Structure

```jsonc
{
  // Server Settings
  "host": "0.0.0.0",
  "port": 3456,
  "debug": false,
  "yolo": false,
  "dataDir": "~/.clawd/data",
  "uiDir": "/custom/ui/path",

  // Environment Variables for Agents
  "env": {
    "GITHUB_TOKEN": "ghp_...",
    "CUSTOM_VAR": "value"
  },

  // LLM Providers
  "providers": {
    "copilot": {
      "api_key": "github_pat_...",
      "models": { "default": "gpt-4.1", "sonnet": "claude-sonnet-4.6" }
    },
    "openai": { "api_key": "sk-..." },
    "anthropic": { "api_key": "sk-ant-..." },
    "ollama": { "base_url": "https://ollama.com" },
    "minimax": { "api_key": "..." }
  },

  // Quotas
  "quotas": { "daily_image_limit": 50 },

  // Feature Flags
  "workspaces": true,
  "worker": true,
  "memory": true,
  "browser": true,

  // Vision Models
  "vision": {
    "read_image": { "provider": "copilot", "model": "gpt-4.1" },
    "generate_image": { "provider": "minimax", "model": "image-01" },
    "edit_image": { "provider": "minimax", "model": "image-01" }
  },

  // MCP Servers (per-channel)
  "mcp_servers": {
    "dev": {
      "github": { "transport": "http", "url": "https://api.githubcopilot.com/mcp" },
      "filesystem": { "command": "npx", "args": ["@modelcontextprotocol/server-filesystem"] }
    }
  },

  // Heartbeat Monitor
  "heartbeat": {
    "enabled": true,
    "intervalMs": 30000,
    "processingTimeoutMs": 300000,
    "spaceIdleTimeoutMs": 60000
  },

  // API Authentication
  "auth": {
    "token": "your-secret-token"
  },

  // Git Worktree
  "worktree": true,  // or ["channel1", "channel2"]
  "author": {
    "name": "Claw'd Agent",
    "email": "agent@clawd.local"
  },

  // Token Limit Overrides
  "model_token_limits": {
    "copilot": { "gpt-4.1": 64000 },
    "anthropic": { "claude-opus-4.6": 200000 }
  }
}
```

---

## Success Metrics

### User Adoption
- **Metric**: Number of users, channels, agents
- **Target**: 100+ users by 6 months
- **Measurement**: Database analytics

### Performance
- **Metric**: Agent response time (LLM latency + tool execution)
- **Target**: Median <5s for simple queries, <30s for complex tasks
- **Measurement**: WebSocket event timestamps

### Reliability
- **Metric**: Uptime, error rate, stuck-agent recovery
- **Target**: 99.5% uptime, <1% error rate, 100% heartbeat recovery
- **Measurement**: Server logs, error tracking

### Feature Usage
- **Metric**: Browser automation, worktree, sub-agents, scheduler
- **Target**: >30% adoption of each major feature
- **Measurement**: API endpoint analytics

---

## Roadmap & Phases

### Phase 1: Core (2024-Q1) ✅
- Multi-agent orchestration
- Browser automation (CDP + Stealth)
- Sandboxed execution
- 3-tier memory system

### Phase 2: Isolation & Persistence (2024-Q2) ✅
- Git isolated mode (18 API endpoints)
- Sub-agent spawning (Spaces)
- Session checkpoints
- Knowledge base indexing

### Phase 3: Automation (2024-Q3) ✅
- Scheduler (cron, interval, once)
- Heartbeat monitor with auto-recovery
- Tool filtering & model tiering
- Prompt caching

### Phase 4: Extensibility (2024-Q4) ✅
- Custom tools
- Skill system
- MCP client & server
- Agent files (Claude Code compatible)

### Phase 5: Enterprise (2025-Q1+)
- Desktop automation (keyboard/mouse)
- Workspace Docker integration (noVNC)
- Multi-user collaboration features
- Advanced analytics & reporting

---

## Development Status

**Current State**: Production-ready for single/multi-agent workflows

**Known Limitations**:
- Windows sandbox support limited (path validation only)
- Desktop automation not yet implemented
- Docker workspace integration in beta

**Active Development**:
- Performance optimizations (token caching, database indexing)
- UX improvements (UI dialogs, error messages)
- Documentation expansion (examples, tutorials)

---

## Support & Community

- **Repository**: https://github.com/clawd-pilot/clawd
- **Documentation**: `docs/` directory
- **Issues**: GitHub Issues for bugs and feature requests
- **Contributing**: PRs welcome; follow `docs/code-standards.md`

---

## License

[MIT](LICENSE)
