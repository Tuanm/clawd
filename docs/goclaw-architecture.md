# GoClaw Architecture Analysis

> **Source**: [github.com/nextlevelbuilder/goclaw](https://github.com/nextlevelbuilder/goclaw)
> **Purpose**: Comprehensive architecture reference for applying GoClaw patterns to Claw'd

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Core Agent Loop](#3-core-agent-loop)
4. [Tool System](#4-tool-system)
5. [Provider Abstraction](#5-provider-abstraction)
6. [Gateway & WebSocket Protocol](#6-gateway--websocket-protocol)
7. [Storage Layer](#7-storage-layer)
8. [Channel Integrations](#8-channel-integrations)
9. [Memory & Embeddings](#9-memory--embeddings)
10. [Scheduler & Concurrency](#10-scheduler--concurrency)
11. [Bootstrap & Skills](#11-bootstrap--skills)
12. [Cron & Heartbeat](#12-cron--heartbeat)
13. [Sandbox Execution](#13-sandbox-execution)
14. [Configuration System](#14-configuration-system)
15. [Security Architecture](#15-security-architecture)
16. [Tracing & Observability](#16-tracing--observability)
17. [HTTP API](#17-http-api)
18. [CLI Commands](#18-cli-commands)
19. [Deployment Modes](#19-deployment-modes)
20. [Database Schema](#20-database-schema)
21. [Key Architectural Patterns](#21-key-architectural-patterns)

---

## 1. Executive Summary

**GoClaw** is a production-grade AI agent gateway written in Go. It orchestrates LLM-powered agents across multiple messaging channels (Telegram, Discord, WhatsApp, Feishu, Zalo) with a unified WebSocket/HTTP gateway. The system supports multi-tenant deployments with PostgreSQL, standalone single-user mode with file-based storage, and sandboxed code execution via Docker containers.

### Key Capabilities

- **Multi-provider LLM support**: Anthropic, OpenAI, Google Gemini, DashScope (Alibaba)
- **Agentic tool loop**: Think → Act → Observe cycle with loop detection, context pruning, and memory compaction
- **Multi-channel messaging**: Telegram, Discord, WhatsApp, Feishu, Zalo with streaming & reactions
- **MCP integration**: Model Context Protocol bridge for external tool servers
- **Team & delegation**: Multi-agent orchestration with task tracking and quality gates
- **Sandboxed execution**: Docker-based isolation with security hardening
- **Hybrid memory**: Semantic vector search + FTS5 full-text search via SQLite/pgvector
- **Hot-reloadable config**: File-watcher with 300ms debounce
- **OpenTelemetry tracing**: Full span collection with OTLP export

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | Go 1.22+ |
| Database | PostgreSQL (managed) / File-based JSON (standalone) |
| Embeddings | SQLite + FTS5 / pgvector |
| WebSocket | gorilla/websocket |
| HTTP | chi router |
| Container | Docker API |
| Observability | OpenTelemetry (OTLP) |
| Frontend | React + TypeScript + Vite + Tailwind CSS |

---

## 2. System Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         GoClaw Gateway                          │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ Channels │  │ WebSocket│  │ HTTP API │  │  Cron/       │   │
│  │ Manager  │  │ Gateway  │  │ Handlers │  │  Heartbeat   │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘   │
│       │              │              │               │           │
│       └──────────────┴──────┬───────┴───────────────┘           │
│                             │                                   │
│                    ┌────────▼────────┐                          │
│                    │   Event Bus     │                          │
│                    └────────┬────────┘                          │
│                             │                                   │
│                    ┌────────▼────────┐                          │
│                    │   Scheduler     │                          │
│                    │  (Lane-based)   │                          │
│                    └────────┬────────┘                          │
│                             │                                   │
│              ┌──────────────▼──────────────┐                    │
│              │        Agent Router         │                    │
│              └──────────────┬──────────────┘                    │
│                             │                                   │
│              ┌──────────────▼──────────────┐                    │
│              │        Agent Loop           │                    │
│              │  (Think → Act → Observe)    │                    │
│              └──────────────┬──────────────┘                    │
│                             │                                   │
│         ┌───────────┬───────┴──────┬───────────┐               │
│         │           │              │           │               │
│   ┌─────▼─────┐ ┌───▼───┐ ┌───────▼──┐ ┌──────▼──────┐       │
│   │ Providers │ │ Tools │ │ Sessions │ │   Memory    │       │
│   │ Registry  │ │ Reg.  │ │ Manager  │ │   Manager   │       │
│   └───────────┘ └───────┘ └──────────┘ └─────────────┘       │
│                                                                 │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│   │  Store   │  │  Config  │  │ Sandbox  │  │ Tracing  │      │
│   │ (PG/File)│  │ (Hot-RL) │  │ (Docker) │  │ (OTLP)   │      │
│   └──────────┘  └──────────┘  └──────────┘  └──────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
goclaw/
├── main.go                    # Entry point
├── cmd/                       # CLI commands (cobra)
│   ├── root.go                # Root command
│   ├── gateway.go             # Gateway daemon
│   ├── gateway_*.go           # Gateway subsystems
│   ├── onboard*.go            # Interactive setup
│   ├── agent*.go              # Agent CLI
│   └── migrate.go             # DB migrations
├── internal/
│   ├── agent/                 # Core agent loop
│   ├── bootstrap/             # Workspace initialization
│   ├── bus/                   # Event bus
│   ├── channels/              # Messaging integrations
│   │   ├── telegram/
│   │   ├── discord/
│   │   ├── feishu/
│   │   ├── whatsapp/
│   │   └── zalo/
│   ├── config/                # Configuration + hot-reload
│   ├── cron/                  # Scheduled jobs
│   ├── crypto/                # AES encryption
│   ├── gateway/               # WebSocket server + methods
│   │   └── methods/           # RPC method handlers
│   ├── heartbeat/             # Periodic check-ins
│   ├── hooks/                 # Quality gates & evaluators
│   ├── http/                  # REST API handlers
│   ├── mcp/                   # MCP bridge
│   ├── memory/                # Embedding + search
│   ├── pairing/               # Device auth
│   ├── permissions/           # RBAC
│   ├── providers/             # LLM providers
│   ├── sandbox/               # Docker isolation
│   ├── scheduler/             # Lane-based queue
│   ├── sessions/              # Session management
│   ├── skills/                # Skill loader
│   ├── store/                 # Data access layer
│   │   ├── pg/                # PostgreSQL implementation
│   │   └── file/              # File-based implementation
│   ├── tools/                 # Built-in tools
│   ├── tracing/               # OpenTelemetry
│   ├── tts/                   # Text-to-speech
│   └── upgrade/               # Version management
├── pkg/
│   ├── browser/               # Browser automation tool
│   └── protocol/              # WebSocket protocol types
├── migrations/                # SQL migrations
├── ui/web/                    # React frontend
└── docs/                      # Architecture documentation
```

---

## 3. Core Agent Loop

### Agent Interface

```go
type Agent interface {
    ID() string
    Run(ctx context.Context, req RunRequest) (*RunResult, error)
    IsRunning() bool
    Model() string
}
```

The primary implementation is `Loop`, which maintains provider, model, tools, sessions, workspace per agent instance.

### Execution Flow

The agent loop follows a **Think → Act → Observe** cycle:

#### Phase 1: Setup (Pre-iteration)

1. Increment active run counter
2. Create/reuse trace (managed mode)
3. Inject context: agent UUID, user ID, agent type, sandbox config, builtin tool settings
4. Security: scan for injection patterns (`InputGuard`), truncate oversized messages (default 32K chars)
5. Per-user workspace isolation + file seeding

#### Phase 2: Message Building

1. Fetch history + summary from session store
2. Build full system prompt with `BuildSystemPrompt()` (mode=Full or Minimal)
3. Attach vision images to current user message
4. Apply context pruning + history limiting

#### Phase 3: Iteration Loop (max 20 iterations)

Each iteration:
1. Call LLM via provider with filtered tool definitions
2. Emit `llm_call` tracing span
3. If tool calls returned → execute tools (parallel or sequential)
4. Check for infinite loop detection
5. Accumulate token usage
6. **Exit conditions**: no tool calls, critical loop detected, iteration limit reached

#### Phase 4: Finalization

1. Sanitize final content (8-step pipeline)
2. Detect `NO_REPLY` token (suppress delivery)
3. Flush buffered messages to session atomically
4. Update metadata: tokens, model, provider, channel
5. Calibrate token estimation using actual prompt tokens
6. Bootstrap auto-cleanup after 3 user turns
7. Trigger `maybeSummarize()` for compaction (background goroutine)
8. Emit `agent` span with full timing

### Loop Detection

Maintains a circular buffer of the last 30 tool calls per run, recording `toolName`, `argsHash` (SHA256), `resultHash`:
- **Warning threshold**: ≥3 identical tool+args+result combinations
- **Critical threshold**: ≥5 identical combinations → abort

### Tool Execution Modes

**Single tool**: Sequential execution, no goroutine overhead.

**Multiple tools**: Parallel execution via goroutines with deterministic result ordering:
1. Emit ALL `tool.call` events upfront
2. Execute in parallel (immutable context)
3. Collect results, sort by original index
4. Process sequentially for loop detection

### Context Pruning

Two-pass cache-TTL eviction strategy:
1. **Soft trim**: Keep head (1500 chars) + tail (1500 chars), replace middle with `[…trimmed…]`
2. **Hard clear**: Replace entire tool result with `[Old tool result content cleared]`

Protections:
- Never prune last 3 assistant messages
- Never prune before first user message
- Only prune if context > 30% of window
- Only hard-clear if > 50% of window AND ≥50K prunable chars

### System Prompt Assembly

Dynamic builder producing 15+ sections:

| # | Section | Condition |
|---|---------|-----------|
| 1 | Identity + BOOTSTRAP override | Always |
| 2 | Tooling (tool list + sandbox note) | Always |
| 3 | Safety rules | Always |
| 4 | Skills (inline XML or search-mode) | If skills exist; inline if ≤20 skills and ≤3500 tokens |
| 5 | Memory recall instructions | If `hasMemory=true` |
| 6 | Workspace (dir, relative paths) | Always |
| 7 | Sandbox (container workdir, access level) | If `sandboxEnabled=true` |
| 8 | User identity (owner IDs) | Always |
| 9 | Current UTC timestamp | Always |
| 10 | Messaging (channel routing, language) | Full mode only |
| 11 | Extra prompt (subagent context) | If provided |
| 12 | Project context (BOOTSTRAP.md, SOUL.md) | Always |
| 13 | Silent replies (NO_REPLY rules) | Full mode only |
| 14 | Heartbeats (HEARTBEAT_OK) | Full mode only |
| 15 | Sub-agent spawning instructions | If `HasSpawn=true` |
| 16 | Runtime (agent, model, channel) | Always |

**Prompt Modes**:
- `PromptFull`: Main agent (all sections)
- `PromptMinimal`: Subagent/cron (reduced sections, no messaging/heartbeats)

### History Compaction

```
maybeSummarize(ctx, sessionKey) // background goroutine
```

- **Threshold**: `len(history) > minMessages AND tokens > maxHistoryShare × contextWindow`
- Per-session TryLock (non-blocking) prevents concurrent summarization
- Summarize older history → compact summary, keep last N messages (default 4)
- Increment compaction counter

### Memory Flush

Runs **before compaction** when total tokens exceed threshold:
- Threshold: `contextWindow - 20K (reserve) - 4K (soft threshold)`
- Executes isolated LLM turn with system prompt for pre-compaction memory extraction
- Agent writes important information to `memory/*.md` files
- Deduplication: skip if already flushed in this compaction cycle

### Token Calibration

After each LLM call, stores actual `lastPromptTokens + messageCount` to replace the heuristic `chars/3` estimate with real data. More accurate for multilingual content.

### Content Sanitization (8-step pipeline)

1. Strip garbled XML (DeepSeek, GLM artifacts)
2. Strip `[Tool Call: ...]` / `[Tool Result ...]` blocks
3. Strip thinking tags: `<think>`, `<thinking>`, `<antThinking>`
4. Strip `<final>` tags
5. Strip echoed `[System Message]` blocks
6. Collapse duplicate paragraphs
7. Strip `MEDIA:/path` references
8. Strip leading blank lines

---

## 4. Tool System

### Registry Architecture

```go
type Registry struct {
    tools       map[string]Tool      // tool name → Tool
    rateLimiter *ToolRateLimiter     // sliding-window per session
    scrubbing   bool                 // credential sanitization (default: true)
    mu          sync.RWMutex
}
```

Key methods:
- `Register(tool)` — adds tool by `tool.Name()`
- `Get(name)` — retrieves with read lock
- `Execute(ctx, name, args)` — executes with context injection, rate limiting, credential scrubbing, and timing telemetry
- `ProviderDefs()` — converts all tools to `providers.ToolDefinition` for LLM APIs
- `Clone()` — shallow copy preserving rate limiter & scrubbing (for subagent isolation)

### Tool Interface

```go
type Tool interface {
    Name() string
    Description() string
    Parameters() map[string]interface{}  // JSON Schema
    Execute(ctx context.Context, args map[string]interface{}) *Result
}
```

**Capability mixins** (optional interfaces):
- `SandboxAware` — receives sandbox scope key
- `AsyncTool` — supports async callbacks
- `InterceptorAware` — receives context file & memory interceptors
- `MemoryStoreAware` — receives managed-mode memory store
- `ApprovalAware` — receives exec approval manager
- `PathAllowable`/`PathDenyable` — filesystem access restrictions
- `SessionStoreAware` — receives session store
- `BusAware` — receives message bus

### Tool Result

```go
type Result struct {
    ForLLM   string             // sent to LLM
    ForUser  string             // shown to user (optional)
    Silent   bool               // suppress user message
    IsError  bool               // error flag
    Async    bool               // running asynchronously
    Media    []string           // file paths (images, audio)
    Usage    *providers.Usage   // token counts from internal LLM calls
    Provider string             // provider name for tracing
    Model    string             // model used
}
```

### Built-in Tools

| Tool | File | Description |
|------|------|-------------|
| `read_file` | `filesystem.go` | Sandboxed file read with symlink/hardlink attack prevention |
| `write_file` | `filesystem_write.go` | File write with context/memory interceptor support |
| `edit` | `edit.go` | Search-and-replace edits with `replace_all` flag |
| `list_files` | `filesystem_list.go` | Directory listing with filtering |
| `exec` | `shell.go` | Shell execution with 50+ deny patterns, approval workflows, sandbox routing |
| `web_fetch` | `web_fetch.go` | URL fetching with SSRF protection, HTML→markdown conversion |
| `web_search` | `web_search.go` | Web search via Brave or DuckDuckGo with freshness filters |
| `memory_search` | `memory.go` | Hybrid semantic + FTS search across memory files |
| `memory_get` | `memory.go` | Snippet extraction by path and line range |
| `delegate` | `delegate.go` | Inter-agent delegation (sync/async) with quality gates |
| `delegate_search` | `delegate_search_tool.go` | Search available delegation targets (when >15 targets) |
| `spawn` | `subagent_spawn_tool.go` | Subagent spawning with depth/concurrency limits |
| `sessions_list` | `sessions.go` | List agent sessions |
| `sessions_history` | `sessions_history.go` | Retrieve conversation history |
| `sessions_send` | `sessions_send.go` | Send message to session and get response |
| `session_status` | `sessions.go` | Show model, tokens, compaction count, channel info |
| `team_tasks` | `team_tasks_tool.go` | Team task CRUD |
| `team_message` | `team_message_tool.go` | Team channel messaging |
| `message` | `message.go` | Send messages to channels |
| `cron` | `cron.go` | Cron job management (add/update/remove/run) |
| `tts` | `tts.go` | Text-to-speech synthesis |
| `read_image` | `read_image.go` | Image reading with optional OCR |
| `create_image` | `create_image.go` | Image generation |
| `browser` | `pkg/browser/tool.go` | Browser automation with snapshots and actions |
| `skill_search` | `skill_search.go` | Search available skills (when >20 skills) |
| `evaluate_loop` | `evaluate_loop_tool.go` | Evaluate agent loop quality for quality gates |
| `handoff` | `handoff_tool.go` | Hand off conversation to another agent |

### Shell Execution Security

The `exec` tool has **50+ deny regex patterns** covering:
- Destructive ops: `rm -rf`, `dd if=`, `reboot`
- Data exfiltration: `curl | sh`, DNS tunneling
- Reverse shells: `nc -e`, `socat`, Python sockets
- Privilege escalation: `sudo`, `capsh`, `unshare`
- Environment injection: `LD_PRELOAD`, `BASH_ENV`
- Container escape: `/var/run/docker.sock`, `/proc/sys` writes
- Crypto mining: xmrig, stratum URLs

**Approval system**: Configurable modes (deny, allowlist, full) with ask policies (off, on-miss, always) and persistent allow-always decisions.

### Tool Policy System (7-Step Pipeline)

```
1. Global profile (minimal/coding/messaging/full)
2. Provider-level profile override
3. Global allow list (intersection)
4. Provider-level allow (intersection)
5. Per-agent allow (intersection)
6. Per-agent per-provider allow (intersection)
7. Group-level allow (intersection)
→ Apply denies (global, per-agent, subagent immutable)
→ Apply alsoAllow (additive, global + per-agent)
```

**Tool groups**:
- `memory`: memory_search, memory_get
- `web`: web_search, web_fetch
- `fs`: read_file, write_file, list_files, edit, search, glob
- `runtime`: exec, process
- `sessions`: sessions_*, session_status
- `ui`: browser, canvas
- `automation`: cron, gateway
- `messaging`: message
- `nodes`: nodes
- `goclaw`: composite of all native tools

**Tool aliases**: `"bash"` → `"exec"`, `"apply-patch"` → `"apply_patch"`

**Subagent deny lists** (immutable):
- Always denied: gateway, agents_list, whatsapp_login, session_status, cron, memory_search, memory_get, sessions_send
- Leaf agents (max depth): additionally sessions_list, sessions_history, sessions_spawn, spawn

### Dynamic Tools (Custom Tools from Database)

```go
type DynamicToolLoader struct {
    store      CustomToolStore
    globalIDs  []string          // currently registered global tools
}
```

- Global tools (agent_id IS NULL) registered once at startup
- Per-agent tools loaded on-demand via `LoadForAgent()` into cloned registry
- Command template rendering with `{{.paramName}}` placeholders (shell-escaped)
- Same deny pattern matching as `exec` tool
- Per-tool timeout, working directory, env vars

### MCP Bridge

```go
type BridgeTool struct {
    name       string           // prefixed: "{prefix}__{toolName}"
    mcpTool    mcp.Tool
    client     *mcp.Client
    timeout    time.Duration
    connected  atomic.Bool
}
```

**MCP Manager** dual mode:
- **Standalone**: Static `config.MCPServerConfig` map
- **Managed**: Per agent+user from `MCPServerStore` (permission-filtered)

Connection management: health checks every 30s, exponential backoff (2s→60s), max 10 reconnect attempts.

### Credential Scrubbing

Post-execution scrubbing detects and redacts:
- API keys (`sk-*`, `sk-ant-*`, `gh*`, `AKIA*`)
- Key=value patterns (api_key=, token=, secret=, password=, bearer=)
- Connection strings (postgres://, mysql://, mongodb://, redis://)
- Long hex strings (64+ chars, likely encryption keys)

---

## 5. Provider Abstraction

### Provider Interface

```go
type Provider interface {
    Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error)
    ChatStream(ctx context.Context, req ChatRequest, onChunk func(StreamChunk)) (*ChatResponse, error)
    DefaultModel() string
    Name() string
}

// Optional capability interface
type ThinkingCapable interface {
    SupportsThinking() bool
}
```

### Supported Providers

| Provider | File | Features |
|----------|------|----------|
| **Anthropic** | `anthropic.go` | Native API, thinking blocks, cache control, event-based streaming |
| **OpenAI** | `openai.go` | Chat completions API, SSE streaming, tool calls. Also supports OpenAI-compatible providers: Groq, OpenRouter, DeepSeek, VLLM, MiniMax |
| **Gemini** | `openai_gemini.go` | Via OpenAI-compatible endpoint, schema cleaning |
| **DashScope** | `dashscope.go` | Alibaba Cloud Qwen models |

### Request/Response Types

```go
type ChatRequest struct {
    Messages   []Message
    Tools      []ToolDefinition
    Model      string
    Options    ChatOptions       // temperature, max_tokens, thinking_level
}

type ChatResponse struct {
    Content              string
    Thinking             string
    ToolCalls            []ToolCall
    FinishReason         string
    Usage                Usage
    RawAssistantContent  interface{}  // provider-specific (Anthropic content blocks)
}

type Usage struct {
    PromptTokens       int
    CompletionTokens   int
    TotalTokens        int
    CacheReadTokens    int
    CacheCreationTokens int
    ThinkingTokens     int
}
```

### Streaming

**Anthropic**: Event-based (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop). Raw content block reconstruction for thinking passback. 1MB max line buffer.

**OpenAI**: SSE format parsing with delta accumulation for tool calls.

### Schema Cleaning

Provider-specific JSON Schema field removal:
- **Gemini**: removes `$ref`, `$defs`, `additionalProperties`, `examples`, `default`
- **Anthropic**: removes `$ref`, `$defs`
- **OpenAI**: no cleaning needed

### Retry Logic

```go
type RetryConfig struct {
    Attempts int           // max attempts (default 3)
    MinDelay time.Duration // initial delay (default 300ms)
    MaxDelay time.Duration // cap (default 30s)
    Jitter   float64       // ±10% randomization
}
```

Retryable: HTTP 429/500/502/503/504, network errors (timeouts, connection reset, broken pipe, EOF). Supports `Retry-After` header on 429.

---

## 6. Gateway & WebSocket Protocol

### Server Architecture

```
Server
├── MethodRouter          // RPC dispatch by method name
├── Client Manager        // Per-connection state + auth
├── RateLimiter           // RPM/token-based
├── HTTP Handlers         // REST API endpoints
└── WebSocket Upgrader    // gorilla/websocket
```

### Protocol Frames

```json
// Request
{"type": "req", "id": "uuid", "method": "chat.send", "params": {...}}

// Response
{"type": "res", "id": "uuid", "ok": true, "payload": {...}}
{"type": "res", "id": "uuid", "ok": false, "error": {"code": 400, "message": "..."}}

// Event (server-pushed)
{"type": "event", "event": "agent.chunk", "payload": {...}}
```

### Authentication Flow

```
Path 1: Bearer Token          → RoleAdmin
Path 2: Paired sender_id      → RoleOperator (browser pairing reconnection)
Path 3: Browser pairing req   → Unauthenticated with pairingPending=true
                                 (can only call browser.pairing.status)
Path 4: Fallback              → RoleViewer (read-only)
```

> Note: Only 3 roles exist (Admin/Operator/Viewer). Browser pairing uses a `pairingPending` flag, not a separate role.

### Connection State

```go
type Client struct {
    id             string           // UUID
    conn           *websocket.Conn
    authenticated  bool
    role           permissions.Role // Admin/Operator/Viewer
    userID         string
    pairingCode    string
    pairingPending bool
}
```

Read pump: 60s timeout, 512KB message limit. Write pump: 30s ping interval.

### Rate Limiting

Gateway rate limiting via `golang.org/x/time/rate` (token bucket):
- Configurable via `gateway.rate_limit_rpm` (requests per minute, default: disabled)
- Per-key (user/IP) tracking with 10-minute cleanup interval
- 5-token burst capacity
- Logs `security.rate_limited` events on throttle

### Event Broadcasting

```go
Server.BroadcastEvent(event, payload) // sends to all connected clients
```

- Per-client subscription via `eventPub.Subscribe()` with 256-buffer send channels
- Internal cache events (prefixed `cache.`) are filtered and not forwarded to WebSocket clients
- Non-blocking per subscriber (goroutine per handler)

### Gateway Methods

| Category | Methods |
|----------|---------|
| **Core Agent** | agent, agent.wait |
| **Chat** | chat.send, chat.history, chat.abort, chat.inject |
| **Agents** | agents.list, agents.create, agents.update, agents.delete |
| **Agent Identity** | agents.identity.get |
| **Agent Files** | agents.files.list, agents.files.get, agents.files.update |
| **Agent Links** | agents.links.list, agents.links.create, agents.links.delete |
| **Skills** | skills.list, skills.get, skills.update |
| **Channels** | channels.list, channels.status, channels.toggle |
| **Channel Instances** | channels.instances.list, channels.instances.create, channels.instances.delete |
| **Config** | config.get, config.patch, config.apply, config.schema |
| **Cron** | cron.list, cron.create, cron.update, cron.delete, cron.run, cron.toggle, cron.status, cron.runs |
| **Sessions** | sessions.list, sessions.preview, sessions.reset, sessions.delete |
| **Delegations** | delegations.list, delegations.get |
| **Teams** | teams.list, teams.get, teams.create, teams.delete, teams.tasks.list, teams.members.add, teams.members.remove |
| **Usage** | usage.summary, usage.get |
| **Pairing** | device.pair.request, device.pair.approve, device.pair.list, device.pair.revoke, browser.pairing.status |
| **Approval** | exec.approval.list, exec.approval.approve, exec.approval.deny |
| **Send** | send |

---

## 7. Storage Layer

### Dual-Mode Architecture

```
Stores struct
├── Managed Mode (PostgreSQL)
│   ├── AgentStore
│   ├── ProviderStore
│   ├── TeamStore
│   ├── CustomToolStore
│   ├── ChannelInstanceStore
│   ├── AgentLinkStore
│   ├── TracingStore
│   ├── MCPServerStore
│   ├── ConfigSecretsStore
│   └── BuiltinToolStore
└── Shared (All Modes)
    ├── SessionStore        // file-based in standalone
    ├── MemoryStore         // SQLite + embeddings
    ├── CronStore
    ├── SkillStore
    └── PairingStore
```

### Session Key Format

```
DM:           agent:{agentId}:{channel}:direct:{chatId}
Group:        agent:{agentId}:{channel}:group:{chatId}
Forum Topic:  agent:{agentId}:{channel}:group:{chatId}:topic:{topicId}
Subagent:     agent:{agentId}:subagent:{label}
Cron:         agent:{agentId}:cron:{jobId}
```

### PostgreSQL Implementation

- UUID v7 time-ordered primary keys
- JSONB columns for flexible config (`SandboxConfig`, `MemoryConfig`, `CompactionConfig`, `ContextPruning`)
- pgvector extension for embedding storage (1536 dimensions, matching OpenAI text-embedding-3-small)
- Soft deletes (`deleted_at`) for audit trails
- Connection pooling via `pgxpool`

### File-Based Implementation (Standalone)

- JSON serialization to `~/.goclaw/`
- Sessions: `~/.goclaw/sessions/agent_{agentId}_{sessionKey}.json`
- Cron: `~/.goclaw/cron-store.json`
- Pairing: `~/.goclaw/pairing-store.json`

### Pairing System

Device/browser authentication via approval codes:
- 8-character alphanumeric codes using unambiguous alphabet (excludes 0, O, 1, I, L)
- 60-minute expiration (CodeTTL)
- Max 3 pending codes per account
- Automatic expiration pruning
- JSON persistence in standalone mode, PostgreSQL in managed mode

### Validation Rules

- User identifiers (user_id, owner_id, granted_by) limited to 255 characters
- Validated via `store.ValidateUserID()` to match database VARCHAR(255) constraints

### Store Interfaces

Each store is defined as an interface (e.g., `AgentStore`, `SessionStore`) with PostgreSQL and file-based implementations. The `Stores` struct aggregates all stores and is initialized based on deployment mode.

---

## 8. Channel Integrations

### Channel Manager

```go
type Manager struct {
    channels    map[string]Channel
    bus         *bus.MessageBus
    runContexts sync.Map         // runID → RunContext
}
```

- `RegisterChannel(name, channel)` — registers a channel implementation
- `StartAll()` — starts all channels + outbound dispatcher
- `DispatchOutbound()` — routes bus messages to correct channel
- `RegisterRun()` / `HandleAgentEvent()` — streaming & reaction forwarding

### Channel Interface

```go
type Channel interface {
    Name() string
    Start(ctx context.Context) error
    Stop() error
}

type StreamingChannel interface {
    OnStreamStart(ctx, chatID) error
    OnChunkEvent(ctx, chatID, fullText) error
    OnStreamEnd(ctx, chatID, finalText) error
}

type ReactionChannel interface {
    OnReactionEvent(ctx, chatID, messageID, status) error
    // status: "thinking", "tool", "done", "error"
}
```

### Supported Channels

| Channel | Protocol | Key Features |
|---------|----------|-------------|
| **Telegram** | HTTP long-polling / webhooks | Stickers, inline buttons, reactions, per-chat rate limiting, **full streaming + reactions support** |
| **Discord** | Gateway WebSocket | Thread support, reaction indicators, file upload |
| **Feishu** | WebSocket + protobuf | AES-128-CBC encryption, card-based formatting, streaming helper code |
| **WhatsApp** | Cloud API + webhooks | Media handling, interactive buttons, quick replies |
| **Zalo** | REST API | Vietnamese platform, interactive message templates |

> **Note**: Only Telegram fully implements both `StreamingChannel` and `ReactionChannel` interfaces. Other channels use basic message send/receive.

### Message Flow

```
Inbound:
  Channel → InboundMessage → EventBus → Scheduler → Agent Loop

Outbound:
  Agent Loop → OutboundMessage → EventBus → Channel Manager → Channel
```

### Inbound/Outbound Types

```go
type InboundMessage struct {
    Channel      string  // "telegram", "discord", etc.
    SenderID     string  // platform user ID
    ChatID       string  // conversation ID
    Content      string  // user message
    PeerKind     string  // "direct" or "group"
    AgentID      string  // target agent (multi-agent routing)
    UserID       string  // for per-user scoping
    HistoryLimit int     // max turns in context
}

type OutboundMessage struct {
    Channel   string
    ChatID    string
    Content   string
    Media     []MediaAttachment
    Metadata  map[string]string  // channel-specific
}
```

---

## 9. Memory & Embeddings

### Hybrid Search Architecture

```go
type Manager struct {
    store    *SQLiteStore
    provider EmbeddingProvider  // OpenAI, Gemini, OpenRouter
    watcher  *Watcher
}
```

### Storage Schema (SQLite + FTS5)

```sql
chunks (
    id         TEXT PRIMARY KEY,    -- "{path}#{index}"
    path       TEXT,                -- relative to workspace
    source     TEXT,                -- "memory", "bootstrap"
    text       TEXT,                -- chunk content
    embedding  BLOB,               -- float32 vector
    model      TEXT,                -- embedding model used
    hash       TEXT,                -- change detection
    start_line INT,
    end_line   INT
)
```

### Indexing Pipeline

1. Hash-based change detection (skip unchanged files)
2. Chunking: configurable chunk size (default 1000 chars)
3. Batch embedding generation via provider
4. FTS5 full-text search index creation

### Search Algorithm

```
HybridSearch(query, opts):
  1. Vector search (cosine similarity) — if embeddings available
  2. FTS5 keyword search
  3. Hybrid scoring: 0.7 × vecScore + 0.3 × ftsScore (default weights)
  4. Minimum score filter (default 0.35)
  5. Return top K results (default 6)
```

### Memory File Hierarchy

```
workspace/
├── MEMORY.md           # Root memory file
└── memory/
    ├── notes.md
    ├── decisions.md
    └── *.md            # Auto-indexed
```

Watcher monitors for changes with debounced re-indexing.

### Managed Mode (PostgreSQL)

In managed mode, memory uses PostgreSQL with pgvector:
- `memory_documents`: per-agent/per-user document storage
- `memory_chunks`: uses `vector(1536)` for embeddings, `tsvector` for FTS with 'simple' config (multi-language support)
- Supports multi-tenancy with `agent_id` and `user_id` columns

### Additional Storage Tables (SQLite)

```sql
embedding_cache (
    hash       TEXT PRIMARY KEY,
    provider   TEXT,
    model      TEXT,
    embedding  TEXT,
    dims       INTEGER
)

files (
    path       TEXT PRIMARY KEY,
    source     TEXT,
    hash       TEXT,
    mtime      INTEGER,
    size       INTEGER
)
```

- `embedding_cache`: Deduplication cache for embedding vectors
- `files`: Change detection metadata for re-indexing optimization
- SQLite FTS5 uses `'porter unicode61'` tokenizer

---

## 10. Scheduler & Concurrency

### Lane-Based Architecture

```go
type Scheduler struct {
    lanes   map[string]*Lane
    queues  map[string]*SessionQueue  // per-session queuing
}
```

**Default Lanes:**

| Lane | Concurrency | Purpose |
|------|------------|---------|
| `main` | 30 | Regular agent runs |
| `subagent` | 50 | Delegated runs |
| `delegate` | 100 | Multi-agent coordination |
| `cron` | 30 | Scheduled jobs |

> Concurrency values can be overridden via `GOCLAW_LANE_*` environment variables.

### Per-Session Queue

- **Serial by default**: 1 concurrent run per session
- **Queue modes**: `queue` (FIFO), `followup` (append), `interrupt` (cancel + start)
- **Drop policy**: `old` (discard oldest queued) or `new` (reject incoming)
- **Debounce**: 800ms — collapses rapid sequential messages
- **Generation tracking**: Version counter prevents stale completion processing

### Adaptive Throttle

Reduces concurrency to 1 when session approaches token limit (60% of context window).

---

## 11. Bootstrap & Skills

### Bootstrap System

**Template-based initialization** with embedded Go templates:

```
templates/
├── BOOTSTRAP.md               # Brand-new workspaces only
├── BOOTSTRAP_PREDEFINED.md    # Predefined agent type
├── AGENTS.md                  # Agent configuration
├── SOUL.md                    # Agent personality/expertise
├── TOOLS.md                   # Custom tool definitions
├── IDENTITY.md                # Display name, emoji
├── USER.md                    # User profile
└── HEARTBEAT.md               # Periodic check-in message
```

**Seeding strategy**: Non-destructive — only creates missing files. `BOOTSTRAP.md` only seeded if no `AGENTS.md` exists.

### Auto-generated Context Files

- `DELEGATION.md` — Built from agent link targets (filtered: manual links only)
- `TEAM.md` — Built for team members (lead + members list, role-specific workflow)
- `AVAILABILITY.md` — Negative context when no delegation/team available

### Skills System

**Multi-source resolution** (priority order):
1. Workspace skills: `<workspace>/skills/`
2. Project agent skills: `<workspace>/.agents/skills/`
3. Personal agent skills: `~/.agents/skills/`
4. Global/managed skills: `~/.goclaw/skills/`
5. Builtin skills: embedded in binary

**Skill structure**:
```
skills/{skill_name}/
├── SKILL.md            # Content + YAML frontmatter metadata
├── requirements.txt    # Python deps
└── scripts/            # Helper executables
```

**Context injection**: Skills either inlined as XML (`<available_skills>`) if ≤20 skills and ≤3500 tokens, or referenced via `skill_search` tool for larger catalogs.

---

## 12. Cron & Heartbeat

### Cron Service

```go
type Job struct {
    ID             string
    Schedule       Schedule    // interval, daily, weekly, monthly, at
    Payload        Payload     // agent_turn + delivery target
    Enabled        bool
    DeleteAfterRun bool        // for one-time "at" jobs
    Retries        []Retry
}
```

**Schedule types**:
- `at`: One-time timestamp (milliseconds since epoch)
- `every`: Recurring interval in milliseconds (e.g., `600000` for 10 minutes)
- `cron`: Standard 5-field cron expression with optional timezone (e.g., `"30 9 * * MON"`)

For one-time `at` jobs, `DeleteAfterRun` is set to `true` for automatic cleanup.

**Retry strategy**: Exponential backoff with `baseDelay × 2^attempt`, capped at `maxDelay` (default 30s), max 3 retries.

### Heartbeat Service

Periodic agent check-ins for health monitoring. Agents respond with `HEARTBEAT_OK` token to indicate they're responsive. Heartbeat messages are configured via the `HEARTBEAT.md` template.

---

## 13. Sandbox Execution

### Docker-Based Isolation

```go
type Config struct {
    Mode           string   // "off", "non-main", "all"
    Scope          string   // "session", "agent", "shared"
    Image          string   // e.g., "goclaw-sandbox:bookworm-slim"
    ReadOnlyRoot   bool     // --read-only
    CapDrop        []string // cap-drop ALL
    User           string   // non-root (e.g., "1000:1000")
    NetworkEnabled bool     // --network none (default)
    MemoryMB       int
    CPUs           float64
    PidsLimit      int
}
```

### Container Lifecycle

```
Get(ctx, key, workspace)
├── Check cache for existing container
├── Create new: docker run -d --name ... sleep infinity
├── Run setup command (if configured)
└── Return sandbox handle
```

### Execution

```go
Exec(ctx, command, workDir) → ExecResult {
    ExitCode int
    Stdout   string    // limited to MaxOutputBytes (1MB)
    Stderr   string
}
```

### Pruning

Background goroutine every 5 minutes:
- Remove containers idle > 24 hours
- Remove containers older than 7 days

### Security Hardening

- Read-only root filesystem
- All capabilities dropped
- No new privileges (`--security-opt no-new-privileges`)
- Network disabled by default
- Memory/CPU/PID limits
- tmpfs for `/tmp` and `/var/tmp`
- Non-root user

---

## 14. Configuration System

### Config Structure

```go
type Config struct {
    Agents      AgentsConfig      // defaults + per-agent overrides
    Channels    ChannelsConfig    // channel auth, groups, tool policy
    Providers   ProvidersConfig   // LLM models + API keys
    Gateway     GatewayConfig     // host, port, token, CORS, rate limit
    Tools       ToolsConfig       // global tool policy
    Sessions    SessionsConfig    // compaction, memory, pruning
    Database    DatabaseConfig    // "standalone" vs "managed"
    Tts         TtsConfig         // voice synthesis
    Cron        CronConfig        // retry strategy
    Telemetry   TelemetryConfig   // OTLP export
    Tailscale   TailscaleConfig   // optional VPN listener
    Bindings    []AgentBinding    // channel → agent routing
}
```

### Hot-Reload

File watcher using `fsnotify` with 300ms debounce:
- Config file changes trigger reload
- Skill cache invalidation on skill directory changes
- Provider re-registration on provider config changes

### Secrets Management

- AES-256 encryption for sensitive fields (API keys)
- Encryption key from `GOCLAW_ENCRYPTION_KEY` environment variable
- PostgreSQL: encrypted at rest in `config_secrets` table

### Per-Agent Overrides

```json
{
  "agents": {
    "defaults": {
      "model": "gpt-4",
      "sandbox": {"mode": "off"}
    },
    "list": {
      "researcher": {
        "model": "gpt-4-turbo",
        "sandbox": {"mode": "all"},
        "memory": {"enabled": true},
        "compaction": {"max_history_share": 0.5},
        "context_pruning": {"mode": "cache-ttl"}
      }
    }
  }
}
```

---

## 15. Security Architecture

### Defense-in-Depth Layers

| Layer | Mechanism |
|-------|-----------|
| **Input** | InputGuard: 6 injection pattern detectors (role override, null bytes, delimiter escape, etc.) |
| **Message size** | 32K char default limit with graceful truncation |
| **Tool execution** | 50+ deny regex patterns for shell commands |
| **Tool policy** | 7-step layered allow/deny pipeline |
| **Filesystem** | Symlink/hardlink attack prevention, denied path prefixes |
| **Network** | SSRF protection on web_fetch (URL + redirect validation) |
| **Credentials** | Post-execution scrubbing of API keys, tokens, connection strings |
| **Sandbox** | Docker isolation with capability dropping, read-only root, no network |
| **Subagents** | Immutable deny lists preventing privilege escalation |
| **Encryption** | AES-256 for secrets at rest |
| **Auth** | Role-based (Admin/Operator/Viewer) with device pairing |

### Input Guard Patterns

1. Ignore instructions injection
2. Role override attempts
3. System tag injection
4. Instruction injection markers
5. Null byte attacks
6. Delimiter escape sequences

Actions: `"log"` (info), `"warn"` (default), `"block"` (reject), `"off"` (disabled).

---

## 16. Tracing & Observability

### Span Types

| Span | Attributes |
|------|-----------|
| `agent` | Root span, parents all LLM/tool spans |
| `llm_call` | Iteration #, model, tokens, thinking tokens, cache hits |
| `tool_call` | Tool name, input/output preview (500 chars) |

### Features

- Verbose mode: serialize full messages + thinking blocks (strip base64 images)
- Child runs (announce/subagent) reuse parent trace with nested spans
- Token aggregation: only sum `llm_call` spans to avoid double-counting
- Base64 image placeholders to prevent trace bloat
- OTLP export to Jaeger, Tempo, Datadog, etc.

### Trace Context

Injected per-request with trace ID + parent span ID. Propagated to subagents and delegated runs.

---

## 17. HTTP API

### Hooks & Quality Gates

The hooks system (`internal/hooks/`) provides event-driven quality evaluation for delegation and agent workflows:

**Hook Types:**
- `HookTypeCommand`: Evaluates via shell command execution
- `HookTypeAgent`: Evaluates via a separate LLM agent call

**Hook Configuration:**
```go
type HookConfig struct {
    Event          string   // trigger event (e.g., "delegation.complete")
    Type           string   // "command" or "agent"
    Command        string   // shell command (for command type)
    Agent          string   // agent key (for agent type)
    BlockOnFailure bool     // block workflow on evaluation failure
    MaxRetries     int      // retry count with feedback loop
}
```

**Evaluation Engine:**
- Event-based triggering integrated with the delegation tool
- Blocking/non-blocking failure modes
- Retry loops: on failure, feedback is sent back to the agent for correction
- HookContext carries delegation result, agent info, and evaluation criteria

### OpenAI-Compatible Endpoint

```
POST /v1/chat/completions
├── Token validation
├── Rate limiting
├── Agent resolution
├── Session lookup/creation
└── Scheduler.Schedule() → RunOutcome
```

### Managed-Mode REST APIs

```
/v1/agents/*                  # Agent CRUD + share management
/v1/agents/{id}/shares        # Agent sharing (GET/POST/DELETE)
/v1/agents/{id}/regenerate    # Regenerate agent configuration
/v1/agents/{id}/resummon      # Resummon agent with new config
/v1/skills/*                  # Skill CRUD
/v1/skills/{id}/grants        # Skill permission grants
/v1/providers/*               # LLM provider config
/v1/providers/verify          # Verify provider credentials
/v1/providers/{id}/models     # List available models
/v1/custom-tools/*            # Custom tool CRUD
/v1/channel-instances/*       # Channel account management
/v1/builtin-tools/*           # Builtin tool catalog
/v1/tracing/*                 # LLM span queries
/v1/mcp/*                     # MCP server management
/v1/tools/invoke              # Direct tool invocation
/v1/chat/completions          # OpenAI-compatible endpoint
```

> **Note**: Teams, agent identity, agent files, delegations, and config are managed via **WebSocket RPC methods** (see Section 6), not HTTP REST endpoints.

### Summoner API

The Summoner (`internal/http/summoner.go`) handles agent personality/context generation via LLM:

- **Input**: Agent requirements and traits description
- **Process**: LLM generates structured context files using `<file name="...">` tags
- **Output**: Generated files (SOUL.md, IDENTITY.md) with frontmatter
- **Events**: Lifecycle events (summoning.started, summoning.completed, summoning.failed, file_generated)
- Parses identity information (Name, emoji) from LLM output
- Complex regex-based validation of generated content

---

## 18. CLI Commands

| Command | Description |
|---------|-------------|
| `goclaw` | Start the gateway server (default command) |
| `goclaw onboard` | Interactive setup wizard |
| `goclaw doctor` | Health checks (Docker, DB, providers) |
| `goclaw config` | Config validation/application |
| `goclaw migrate` | Database migrations (up/down) |
| `goclaw cron` | Cron job management |
| `goclaw channels` | Channel status/reload |
| `goclaw sessions` | Session CRUD |
| `goclaw skills` | Skill listing/update |
| `goclaw models` | List available models |
| `goclaw pairing` | Device pairing management |
| `goclaw upgrade` | Version upgrade (schema + data hooks) |
| `goclaw agent chat` | Direct agent chat (CLI) |
| `goclaw prompt` | Send single prompt |

---

## 19. Deployment Modes

### Upgrade System

The upgrade system (`internal/upgrade/`) handles schema and data migrations:
- **Schema version checking**: Detects outdated, dirty, or ahead states
- **Auto-upgrade**: Enabled via `GOCLAW_AUTO_UPGRADE` environment variable
- **Data hooks**: Post-migration data transformations beyond SQL schema changes
- **Version tracking**: `RequiredSchemaVersion` constant tracks minimum compatible version
- `goclaw upgrade` applies both SQL migrations and data hooks, unlike `goclaw migrate` which only runs SQL

### Standalone Mode

- **No PostgreSQL**: File-based storage in `~/.goclaw/`
- **Single-user**: One workspace, direct agent interaction
- **Use case**: Local development, single-machine deployments

### Managed Mode

- **PostgreSQL required**: `GOCLAW_POSTGRES_DSN`
- **Multi-tenant**: Multiple agents, teams, users
- **Full REST API**: Agent/skill/provider CRUD
- **Use case**: SaaS, multi-user deployments

### Sandbox Mode

- **Docker required**: Isolated code execution
- **Image**: `goclaw-sandbox:bookworm-slim`
- **Pruning**: Background cleanup of idle containers
- **Scope**: Per-session, per-agent, or shared containers

### Hybrid Deployments

- **Tailscale integration**: VPN-based access via tsnet
- **OpenTelemetry**: Traces to Jaeger, Tempo, Datadog
- **Replicated setup**: Multiple gateways + shared PostgreSQL

---

## 20. Database Schema

### Core Tables

```sql
-- Agents
agents (
    id UUID PK,
    agent_key VARCHAR(100) UNIQUE,
    owner_id VARCHAR(255),
    provider VARCHAR(100),
    model VARCHAR(100),
    context_window INT,
    max_tool_iterations INT,
    workspace TEXT,
    restrict_to_workspace BOOLEAN,
    tools_config JSONB,
    sandbox_config JSONB,
    memory_config JSONB,
    compaction_config JSONB,
    context_pruning JSONB,
    agent_type VARCHAR(20),  -- "open" or "predefined"
    is_default BOOLEAN,
    created_at, updated_at, deleted_at TIMESTAMPTZ
)

-- Sessions
sessions (
    id UUID PK,
    agent_id UUID FK,
    user_id VARCHAR(255),
    channel VARCHAR(50),
    peer_id VARCHAR(255),
    messages JSONB[],
    input_tokens BIGINT,
    output_tokens BIGINT,
    compaction_count INT,
    summary TEXT
)

-- Tracing Spans
spans (
    id UUID PK,
    trace_id UUID,
    parent_span_id UUID,
    name VARCHAR(255),
    kind VARCHAR(20),   -- "internal", "llm", "tool"
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    attributes JSONB,
    events JSONB
)

-- Teams
agent_teams (id, name, lead_agent_id, description, status, settings JSONB, created_by, created_at, updated_at)
agent_team_members (team_id, agent_id, role, joined_at)
team_tasks (id, team_id, subject, description, status, owner_agent_id, blocked_by, priority, result, metadata JSONB, created_at, updated_at)
team_messages (id, team_id, from_agent_id, to_agent_id, task_id, content, message_type, read, metadata JSONB, created_at)

-- Agent Links
agent_links (id, source_agent_id, target_agent_id, direction, team_id, settings JSONB, status, max_concurrent, created_at)

-- Handoff Routes
handoff_routes (id, channel, chat_id, from_agent_key, to_agent_key, reason, metadata JSONB, created_by, created_at)

-- Other
llm_providers (id, name, api_key_encrypted, base_url, models JSONB)
cron_jobs (id, agent_id, schedule JSONB, payload JSONB, enabled, next_run)
custom_tools (id, agent_id, name, description, command_template, parameters JSONB)
channel_instances (id, channel_type, config JSONB, enabled)
config_secrets (key, value_encrypted)
builtin_tools (id, name, enabled, settings JSONB)
skills (id, name, version, content, metadata JSONB)
pairing_requests (id, code, status, sender_id, approved_at)
group_file_writers (agent_id, group_id, user_id, display_name, username, created_at)
```

### Migration Versions

| Version | Description |
|---------|-------------|
| 000001 | Init schema (providers, agents, sessions, cron, custom tools, channels, pairing, spans) |
| 000002 | Agent links table |
| 000003 | Agent teams (teams, members, tasks) |
| 000004 | Teams v2 refinements |
| 000005 | Phase 4 enhancements |
| 000006 | Builtin tools table |
| 000007 | Team metadata columns |

---

## 21. Key Architectural Patterns

| Pattern | Implementation | Purpose |
|---------|---------------|---------|
| **Factory + Interface** | Store layer (pg/ vs file/) | Dual-mode deployment |
| **Context-Based DI** | Tool context keys | Thread-safe tool execution without mutable state |
| **Lane-Based Scheduling** | Scheduler with per-lane semaphores | Prioritized concurrency control |
| **Circular Buffer Loop Detection** | SHA256 hashing of tool args+results | Prevent infinite agent loops |
| **Two-Pass Context Pruning** | Soft trim → Hard clear | Graceful context window management |
| **Hybrid Search** | Vector + FTS5 scoring | Comprehensive memory retrieval |
| **Event Bus** | Channel-based pub/sub | Decoupled message routing |
| **Hot-Reload** | fsnotify + debounce | Zero-downtime config changes |
| **Template Seeding** | Embedded Go templates | Non-destructive workspace initialization |
| **Capability Mixins** | Optional tool interfaces | Composable tool capabilities |
| **Exponential Backoff** | Retry with jitter | Resilient provider communication |
| **Immutable Context** | Go context.Context values | Safe parallel tool execution |
| **Generation Tracking** | Version counter on session queue | Stale result prevention |
| **Credential Scrubbing** | Regex-based post-processing | Prevent secret leakage to LLMs |
| **Defense-in-Depth** | 6+ security layers | Comprehensive attack surface reduction |

---

## Appendix: Event Bus Message Types

### Events Broadcast to WebSocket Clients

- `agent.run.started` — Agent begins processing
- `agent.chunk` — Streaming text chunk
- `agent.thinking` — Thinking block content
- `tool.call` — Tool invocation started
- `tool.result` — Tool execution completed
- `agent.run.completed` — Agent finished processing
- `agent.run.error` — Agent encountered an error
- `session.updated` — Session metadata changed
- `cron.executed` — Cron job completed

---

*Generated for Claw'd architecture planning. See the [original documentation](https://github.com/nextlevelbuilder/goclaw/tree/main/docs) for authoritative details.*
