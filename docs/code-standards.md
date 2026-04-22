# Claw'd Code Standards & Development Guide

> Last updated: 2026-03-28

---

## Table of Contents

1. [Core Technology Stack](#1-core-technology-stack)
2. [Architectural Principles](#2-architectural-principles)
3. [Code Organization](#3-code-organization)
4. [Naming Conventions](#4-naming-conventions)
5. [TypeScript Standards](#5-typescript-standards)
6. [Error Handling](#6-error-handling)
7. [Memory Architecture](#7-memory-architecture)
8. [Plugin System](#8-plugin-system)
9. [Sub-Agent SDK (Claude Agent)](#9-sub-agent-sdk)
10. [Database Patterns](#10-database-patterns)
11. [API Design](#11-api-design)
12. [Testing Standards](#12-testing-standards)
13. [Performance Guidelines](#13-performance-guidelines)
14. [Security Best Practices](#14-security-best-practices)
15. [Git & Worktree Integration](#15-git--worktree-integration)

---

## 1. Core Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| **Runtime** | Bun | v1.3.9+ |
| **Language** | TypeScript | strict mode |
| **Database** | SQLite | WAL mode (in-process via bun:sqlite) |
| **UI Framework** | React | 18.x + Vite |
| **HTTP Server** | Bun HTTP | native |
| **Package Manager** | Bun | no lock file (bun.lock) |
| **Linter** | Biome | TypeScript + JSX |

**Principles:**
- **Minimal dependencies**: Direct SQL (no ORM), Bun HTTP (no Express), simple state management (no Redux)
- **Zero-trust security**: Sandbox all tool execution, validate all paths, hash all tokens
- **Single binary deployment**: Embed UI + extension + code in one executable
- **No frameworks**: Use Bun primitives directly (HTTP, SQLite, file I/O)

---

## 2. Architectural Principles

### 2.1 Plugin-First Design

All agent capabilities extend via two composable interfaces:

**ToolPlugin** — Adds tools:
```typescript
interface ToolPlugin {
  getTools(): ToolDefinition[]
  beforeExecute?(call: ToolCall): void
  afterExecute?(call: ToolCall, result: unknown): void
}
```

**Plugin** — Lifecycle hooks:
```typescript
interface Plugin {
  onUserMessage?(message: Message): void
  onToolCall?(call: ToolCall): void
  getSystemContext?(): string
}
```

### 2.2 Database-Centric State

- **Single source of truth**: SQLite WAL mode for concurrent reads
- **Schema migrations**: Applied at startup, idempotent
- **Prepared statements**: All queries parameterized to prevent injection
- **Transactions**: Explicit for multi-step operations
- **In-process access**: Agents query chat.db + memory.db directly (no HTTP overhead)

### 2.3 Sandboxing by Default

- All tool execution runs in isolated namespace (bubblewrap/sandbox-exec)
- Path validation before sandbox entry
- Explicit whitelist of writable paths
- Environment wiped clean; only safe variables injected

### 2.4 Multi-Agent Isolation

- **Channel scope**: Each channel has independent message history
- **Agent isolation**: Worktrees prevent file conflicts in git repos
- **Session isolation**: Per-agent LLM context in memory.db
- **Tool isolation**: Remote workers scoped by token + channel

---

## 3. Code Organization

### 3.1 Directory Structure

```
src/
├── index.ts                    # Entry point: HTTP/WS server, routes
├── config/
│   ├── config.ts               # CLI argument parser
│   └── config-file.ts          # ~/.clawd/config.json loader
├── worker-loop.ts              # Per-agent polling loop
├── worker-manager.ts           # Multi-agent orchestrator + heartbeat
├── server/
│   ├── database.ts             # chat.db schema & migrations
│   ├── websocket.ts            # WebSocket push events
│   ├── browser-bridge.ts       # Browser extension WS bridge
│   ├── mcp/                    # MCP server (protocol, tool defs, execution)
│   └── routes/                 # API endpoint handlers
├── agent/
│   ├── agent.ts                # Agent class + reasoning loop
│   ├── agents/loader.ts        # Agent file discovery (4-directory priority)
│   ├── api/                    # LLM provider clients, key pool
│   ├── tools/                  # Tool definitions, web search, doc conversion
│   ├── plugins/                # All plugins (chat, browser, tunnel, etc.)
│   ├── session/                # Session manager, checkpoints, summarizer
│   ├── memory/                 # Session memory, knowledge base, agent memory
│   ├── mcp/                    # MCP client connections
│   ├── prompt/                 # System prompt builder
│   └── utils/                  # sandbox.ts, debug, context helpers
├── spaces/                     # Sub-agent system (Spaces)
│   ├── manager.ts              # Space lifecycle
│   ├── worker.ts               # Space worker orchestrator
│   ├── db.ts                   # spaces table schema
│   └── plugin.ts               # spawn_agent tool
├── claude-code/                # Claude Code SDK integration
│   ├── sdk.ts                  # Claude Agent SDK wrapper
│   ├── main-worker.ts          # Claude Code process management
│   └── memory.ts               # Memory bridge for Claude Code sessions
├── embedded/                   # Build-generated embedded assets
│   ├── ui.ts                   # Embedded React UI (base64)
│   └── extension.ts            # Embedded browser extension (base64)
├── db/                         # Database modules
└── scheduler/                  # Job scheduling (cron/interval/once)
    ├── manager.ts              # Tick loop
    ├── runner.ts               # Job executor
    └── parse-schedule.ts       # Natural language parser

packages/
├── ui/                         # React SPA (Vite)
│   └── src/
│       ├── App.tsx             # Main app, WS setup
│       ├── MessageList.tsx     # Messages + mermaid
│       ├── WorktreeDialog.tsx  # Git dialog
│       ├── ProjectsDialog.tsx  # File browser
│       ├── AgentDialog.tsx     # Agent config
│       ├── SkillsDialog.tsx    # Skill management
│       ├── artifact-*.tsx      # Artifact renderers
│       ├── chart-renderer.tsx  # Recharts wrapper
│       └── styles.css          # All styles
├── browser-extension/          # Chrome MV3
│   └── src/
        ├── service-worker.js   # Command dispatcher
        ├── content-script.js   # DOM extraction
        ├── shield.js           # Anti-detection patches
        └── offscreen.js        # WS connection
└── remote-worker/              # Remote worker clients (TypeScript, Python, Java)
```

### 3.2 File Size Limits

- **Target**: Keep files under 200 lines for optimal context management
- **Rationale**: Easier to understand, test, and maintain individual files
- **Strategy**: Split large files into focused modules

**Examples of proper splitting:**
- `agent.ts` (150 lines) → logic module
- `tools.ts` → separate files per tool category
- `plugins/` → one plugin per file
- `agent/api/` → one provider per file

### 3.3 Exports Convention

- **Prefer named exports**: `export function foo() {}` over `export default`
- **Rationale**: Explicit imports, easier refactoring
- **Exception**: React components (default export OK)

---

## 4. Naming Conventions

### 4.1 File Names

Use **kebab-case** with descriptive names:

```
Good:
  agent-context.ts
  worker-loop.ts
  browser-bridge.ts
  system-prompt-builder.ts
  worktree-file-list.tsx

Bad:
  agentContext.ts        (should be kebab-case)
  worker.ts              (too generic)
  tools.ts               (ambiguous, too many uses)
```

### 4.2 Type Names

Use **PascalCase**:

```typescript
// Good
interface WorktreeStatus {}
type ToolCall = { ... }
class Agent {}

// Bad
interface worktreeStatus {}
type toolCall = { ... }
class agent {}
```

### 4.3 Function & Variable Names

Use **camelCase**:

```typescript
// Good
function createWorktree(projectPath: string) {}
const agentId = "claw-1";
let isStreaming = false;

// Bad
function CreateWorktree(projectPath: string) {}
const agent_id = "claw-1";
let is_streaming = false;
```

### 4.4 Constants

Use **UPPER_SNAKE_CASE** for module-level constants:

```typescript
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CONTEXT_TOKENS = 200_000;
const PROTECTED_BRANCHES = ["main", "master", "develop"];
```

### 4.5 Variables with Type Implications

**Suffix conventions:**
- `Map<K, V>` suffix with "Map": `agentLoopsMap`
- `Set<T>` suffix with "Set": `usedToolsSet`
- `Promise<T>` suffix with "Promise" or avoid: `agentPromise` or `agentTask`
- Arrays: plural form: `agents`, `messages`

---

## 5. TypeScript Standards

### 5.1 Strict Mode

All files must compile with:
```json
{
  "compilerOptions": {
    "strict": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noImplicitAny": true,
    "noImplicitThis": true,
    "alwaysStrict": true
  }
}
```

### 5.2 Return Type Annotations

All public functions must have explicit return types:

```typescript
// Good
export function getWorktreeStatus(path: string): WorktreeStatus {
  // ...
}

// Bad
export function getWorktreeStatus(path: string) {
  // Inferred type — reduces clarity
}
```

### 5.3 Type Aliases vs Interfaces

- Use **`type`** for union types and primitives: `type Status = "pending" | "done"`
- Use **`interface`** for object shapes (better for extension): `interface Agent {}`
- Rationale: Type intersection vs interface merging clarity

### 5.4 Generics Constraints

Always add constraints where applicable:

```typescript
// Good
function withWorktreeLock<T>(path: string, fn: () => Promise<T>): Promise<T> {}

// Bad (missing constraint)
function withWorktreeLock(path: string, fn: () => Promise) {}
```

### 5.5 Optional vs Undefined

Prefer **optional properties** in interfaces:

```typescript
// Good
interface Agent {
  name: string;
  sleepUntil?: string;        // Optional, undefined if absent
}

// Avoid
interface Agent {
  name: string;
  sleepUntil: string | undefined;  // Verbose
}
```

---

## 6. Error Handling

### 6.1 Try-Catch Pattern

Always catch specific errors:

```typescript
// Good
try {
  execFileSync("git", ["commit", "-m", msg], { cwd: worktreePath });
} catch (err: any) {
  if (err.code === "ENOENT") {
    throw new Error(`Git not found`);
  }
  throw new Error(`Commit failed: ${err.message}`);
}

// Bad
try {
  // ...
} catch (err) {
  console.error(err);  // Silent failure
}
```

### 6.2 Error Messages

Include context and actionable information:

```typescript
// Good
throw new Error(`Commit failed for worktree ${worktreePath}: ${err.message}`);

// Bad
throw new Error(`Error`);
throw new Error(`Failed`);
```

### 6.3 Validation

Validate inputs at function entry:

```typescript
export function stageFile(worktreePath: string, filePath: string): void {
  // Validate paths before use
  if (!worktreePath || worktreePath.includes("\0")) {
    throw new Error("Invalid worktree path");
  }
  const resolved = resolve(worktreePath, filePath);
  if (!resolved.startsWith(worktreePath + "/") && resolved !== worktreePath) {
    throw new Error("Path traversal attempt detected");
  }
  // Safe to proceed
}
```

### 6.4 HTTP Error Responses

Use consistent JSON error format:

```typescript
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Usage
if (!channel) return json({ ok: false, error: "channel_required" }, 400);
```

---

## 7. Memory Architecture

Agent memory systems include session history, knowledge retrieval, and long-term storage. Recent improvements focus on lost-in-middle mitigation and event-driven consolidation.

### 7.1 Lost-in-Middle Mitigation

**Pattern**: `reorderForAttention()` implements atomic-group-aware U-shaped interleaving to keep relevant context in optimal positions.

- Preserves message relationships (tool calls with results)
- Prioritizes recent and important messages at start/end of context
- Deprioritizes middle sections (where LLM attention is weaker)
- Uses message scoring weights (system: 100, user: 90, tool_error: 80, etc.)

### 7.2 Volume-Triggered Consolidation

Replaces fixed 200-turn interval with event-driven compaction:

- **Trigger**: Message volume threshold (e.g., 50 turns)
- **Cooldown**: 50-turn minimum between consecutive compactions (prevents thrashing)
- **Concurrency guard**: Only one compaction in flight globally (prevents race conditions)
- **Automatic**: Activates on overflow, full reset, smart compaction, or API error

### 7.3 Pre-Compaction Flush

**Enhancement**: `beforeCompaction()` hook now called on ALL 4 compaction paths:
1. Critical overflow (>95% token limit)
2. Full reset (max turns exceeded)
3. Smart compaction (automatic volume-based)
4. API error overflow (fallback when trimming insufficient)

Ensures consistent state before destructive operations.

### 7.4 Interrupt Polling

- **Maximum interrupts**: Increased from 3 → 10 (more resilient)
- **Adaptive backoff**: 500ms → 3s when idle (reduces CPU usage)
- **Heartbeat signal**: `[HEARTBEAT]` injected as wake signal, stripped during compaction

### 7.5 Message Deduplication

Consecutive similar bot messages collapsed in prompts to reduce token usage:
- Detects duplicate or near-duplicate assistant/tool messages
- Collapses into single message with count indicator
- Preserves important response sequences

### 7.6 Token Budget Strategy

| Threshold | Action |
|-----------|--------|
| <50% | Full history retained |
| 50-70% | Soft compaction begins |
| 70-85% | Aggressive pruning + summarization |
| >85% | Full LLM-generated summary, reset |
| >95% | Emergency full reset (critical overflow) |

---

## 8. Plugin System

### 8.1 Implementing a Tool Plugin

```typescript
import type { ToolPlugin, ToolDefinition, ToolCall } from "../agent";

export class CustomPlugin implements ToolPlugin {
  getTools(): ToolDefinition[] {
    return [
      {
        name: "custom_action",
        description: "Performs a custom action",
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string" },
          },
          required: ["input"],
        },
      },
    ];
  }

  async beforeExecute?(call: ToolCall): Promise<void> {
    console.log(`Executing: ${call.name}`);
  }

  async afterExecute?(call: ToolCall, result: unknown): Promise<void> {
    console.log(`Result: ${JSON.stringify(result)}`);
  }
}
```

### 8.2 Plugin Registration

Register in agent's plugin list:

```typescript
const plugins = [
  new ChatPlugin(),
  new BrowserPlugin(),
  new CustomPlugin(),
];
agent.registerPlugins(plugins);
```

---

## 9. Sub-Agent SDK (Claude Agent)

### 9.1 Overview

Sub-agents spawn via `@anthropic-ai/claude-agent-sdk`. The SDK is embedded in the compiled binary (gzip-compressed) and auto-extracted to `~/.clawd/bin/cli.js` on first use.

**Key differences from raw subprocess:**
- No need to install `claude` binary separately — only `bun` required on PATH
- Programmatic hooks replace temp `/tmp` script files
- Session management via SDK (auto-retry on stale sessions)
- AbortController-based interrupts replace `proc.kill()`
- Smart wakeup: skips old messages when agent wakes with >3 accumulated
- Sleep state preserved across agent restarts
- Sub-agents capped at sonnet model (opus not allowed)
- Session auto-reset on provider or model change

### 9.2 Provider Configuration

#### Built-in Providers

| Provider | Type | Config |
|----------|------|--------|
| Copilot | `copilot` | Headers only (no API key) |
| OpenAI | `openai` | `api_key`, `base_url`, `model` |
| Anthropic | `anthropic` | `api_key`, `model` |
| Ollama | `ollama` | `base_url` (default: `http://localhost:11434`), `model` |
| Custom | `openai` | MiniMax configured as OpenAI-compatible |

#### Custom Claude Code Provider

Configure in `~/.clawd/config.json`:

```json
{
  "providers": [
    {
      "name": "claude-code",
      "type": "claude-code",
      "base_url": "https://custom-endpoint.com",
      "api_key": "sk-..."
    },
    {
      "name": "claude-code-2",
      "type": "claude-code",
      "base_url": "https://another-endpoint.com",
      "api_key": "sk-..."
    }
  ]
}
```

### 9.3 Provider-Specific Behaviors

**Copilot:**
- Normalizes tool call IDs to "call_" prefix for cross-provider compatibility
- Auto-resets session on provider or model change

**OpenAI:**
- Sanitizes requests (merges system messages, explicit field list)
- Handles stream errors gracefully

**Ollama:**
- Default model: `minimax-m2.7:cloud`
- Tool arguments sent as object (not string)
- Flushes incomplete tool calls on stream EOF

**MCP Tools (Feature Parity):**
- Job tools: `job_submit`, `job_status`, `job_cancel`, `job_wait`, `job_logs`
- Memo tools: `memo_save`, `memo_recall`, `memo_delete`, `memo_pin`, `memo_unpin`
- Task tools: `task_add`, `task_batch_add`, `task_list`, `task_get`, `task_update`, `task_complete`, `task_delete`, `task_comment`
- Both sub-agent types see unified `spawn_agent` tool

### 9.4 Session Management

Session IDs are normalized on write for cross-provider compatibility:

```typescript
// Tool call IDs always written with "call_" prefix
const toolCallId = response.content.id || `call_${Date.now()}`;
```

**Session auto-reset triggers:**
- Provider changed
- Model changed
- Stream error that would corrupt session

---

## 10. Database Patterns

### 10.1 Schema Definition — Unified Migration Runner

All databases use `runMigrations()` from `src/db/migrations.ts` (PRAGMA user_version):

```typescript
import { runMigrations, type Migration } from "../db/migrations";

const migrations: Migration[] = [
  {
    version: 1,
    description: "initial schema",
    up(db) {
      db.exec(`
        CREATE TABLE worktree_info (
          agent_id TEXT PRIMARY KEY,
          worktree_path TEXT NOT NULL,
          worktree_branch TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    },
  },
];

runMigrations(db, migrations);          // default: "versioned" strategy
// runMigrations(db, migrations, "recreate-on-mismatch");  // for cache DBs
```

**Rules:**
- Each migration must have a unique, monotonically increasing `version` number
- Migrations run atomically inside `db.transaction()` — partial migrations are impossible
- `"versioned"` (default): only runs migrations with version > current; safe for production data
- `"recreate-on-mismatch"`: drops and recreates all tables when version is behind; use only for ephemeral/cache databases (e.g. `skills-cache.db`)

**Lazy singleton pattern** (`src/server/database.ts`): the DB is not opened at import time. A `Proxy` object is returned; the real `Database` instance is created on first access. This allows tests to call `_resetForTesting()` to swap in a fresh in-memory DB without restarting the process.

### 10.2 Prepared Statements

Always use parameterized queries:

```typescript
// Good
const stmt = db.prepare("SELECT * FROM agents WHERE channel = ? AND id = ?");
const agent = stmt.get(channel, agentId);

// Bad
const agent = db.query(`SELECT * FROM agents WHERE channel = '${channel}'`);
```

### 10.3 Transactions

Explicit transactions for multi-step operations:

```typescript
db.transaction(() => {
  db.prepare("INSERT INTO agents (id, channel) VALUES (?, ?)").run(agentId, channel);
  db.prepare("INSERT INTO channel_agents (channel, agent_id) VALUES (?, ?)").run(channel, agentId);
})();
```

### 10.4 WAL Mode

Ensure WAL mode for concurrent access:

```typescript
const db = new Database(":memory:");
db.pragma("journal_mode = wal");  // Enable WAL
```

---

## 11. API Design

### 11.1 REST Endpoint Structure

Organize endpoints by resource:

```
GET  /api/app.worktree.enabled
GET  /api/app.worktree.status
GET  /api/app.worktree.diff
POST /api/app.worktree.stage
POST /api/app.worktree.commit
```

**Pattern**: `/{resource}.{action}` where `resource` is domain (app, chat, agent) and `action` is operation.

### 11.2 Request/Response Format

All responses return JSON:

```typescript
// Success (200)
{ "ok": true, "data": { ... } }

// Error (4xx/5xx)
{ "ok": false, "error": "error_code", "message": "Human-readable message" }
```

### 11.3 Status Codes

- **200**: Success
- **400**: Bad request (missing/invalid parameters)
- **404**: Not found (resource doesn't exist)
- **409**: Conflict (e.g., hunk hash mismatch during staging)
- **500**: Server error

### 11.4 Request Body Validation

Use `validateBody<T>()` from `src/server/validate.ts` to parse and type-check incoming JSON bodies via Zod:

```typescript
import { validateBody } from "../server/validate";
import { z } from "zod";

const Schema = z.object({ channel: z.string(), message: z.string() });

const v = validateBody(Schema, await req.json());
if (!v.ok) return v.error;  // 400 JSON with Zod issues
// v.data is typed as { channel: string; message: string }
```

- Always returns `{ ok: true, data: T }` on success or `{ ok: false, error: Response }` on failure
- The error response is a 400 JSON with `{ error: "validation failed", issues: [...] }`
- Prefer this over ad-hoc `typeof` checks in route handlers

---

## 12. Testing Standards

### 12.1 Unit Tests

Test individual functions in isolation:

```typescript
// Good
test("stageFile stages a single file", () => {
  const result = stageFile(worktreePath, "file.ts");
  expect(result.ok).toBe(true);
});

test("stageFile validates path traversal", () => {
  expect(() => stageFile(worktreePath, "../../etc/passwd")).toThrow();
});
```

### 12.2 Integration Tests

Test across components:

```typescript
test("worktree creation and status flow", () => {
  const { path, branch } = createWorktree(projectPath, agentId);
  const status = getWorktreeStatus(path);
  expect(status.branch).toBe(branch);
  expect(status.clean).toBe(true);
});
```

### 12.3 No Mocking

Avoid mocking for database/file operations when possible:

```typescript
// Good: Use real database
const db = new Database(":memory:");
const result = getWorktreeStatus(worktreePath);

// Acceptable when unavoidable
const mockGit = { commit: () => ({ ok: true }) };
```

### 12.4 Constructor-Injection for Unit Tests

When testing classes that depend on external I/O (DB, LLM client, session manager), accept dependencies via constructor parameters. Tests pass lightweight mocks; production code passes real instances:

```typescript
// Production class
class AgenticLoop {
  constructor(
    private readonly llm: LLMClient,
    private readonly session: SessionManager,
  ) {}
}

// Test (src/agent/core/loop.test.ts)
const mockLLM = { stream: async () => [...tokens] };
const mockSession = { getMessages: () => [], save: () => {} };
const loop = new AgenticLoop(mockLLM, mockSession);
```

This pattern was used for `AgenticLoop` (loop.test.ts, 63 tests) and key-pool (key-pool.test.ts, 63 tests).

### 12.5 Test Database Reset

Use `_resetForTesting()` exported from `src/server/database.ts` to swap in a fresh in-memory SQLite database between test runs:

```typescript
import { _resetForTesting } from "../../server/database";

beforeEach(() => {
  _resetForTesting();  // Resets lazy singleton; next access opens a clean :memory: DB
});
```

---

## 13. Performance Guidelines

### 13.1 Token Management

- **Context compaction**: Aggressive at 75% token limit, critical reset at 95%
- **Tool filtering**: Prune unused tools after 5-iteration warmup
- **Model tiering**: Auto-downgrade to Haiku for tool routing decisions
- **Prompt caching**: Use Anthropic's prompt-caching beta header

### 13.2 Database Query Optimization

- Use indexes on frequently queried columns (channel, agent_id, ts)
- Composite indexes: `(channel, ts DESC)` for message history
- Prepared statements for repeated queries
- Pagination for large result sets
- Cache `getAgent()` results with 2-second TTL
- Batch operations like `getMessageSeenBy()`

**Maintenance tasks:**
- Run `PRAGMA optimize` after bulk insert/update operations (FTS5 indexes)
- Periodic WAL checkpoint to prevent runaway WAL file growth
- Prune `copilot_calls` table for entries >30 days old
- Clean up orphaned sessions with no agent references

### 13.3 WebSocket Efficiency

- Broadcast events to subscribed clients only
- Coalesce token emissions in 50ms batches (reduces frame overhead)
- Merge multiple agent_poll messages into single broadcast
- Use fixed-size buffers for SSE to prevent mid-frame chunking

### 13.4 Streaming Optimizations

- Remove JSON pretty-printing in API responses (MCP)
- Guard JSON.parse with try-catch for robustness
- Use state-based stream timeouts (CONNECTING, PROCESSING, STREAMING)

### 13.5 Agent Loop Optimizations

- Cache `loadClawdInstructions()` with file-change invalidation
- Cache `listAgentFiles()` with 60-second TTL
- Cache built-in tool names at startup
- Use content-based token hashing to avoid redundant tokenization
- Implement adaptive polling backoff (500ms → 3s) for idle agents
- Mark browser bridge heartbeat with `.unref()` for graceful shutdown
- Use async file operations to prevent blocking message loop

### 13.6 Worktree Performance

- Lazy-load worktree diffs (only fetch when user opens dialog)
- Cache worktree status for 5 seconds (avoid repeated git calls)
- Use `git worktree list --porcelain` for efficient listing
- Identify hunks by SHA1 content hash (not index-based)

### 13.7 Memory Optimization

- Cap context tracker maps to prevent unbounded growth
- Use atomic grouping for tool calls + results
- Fix O(n²) algorithms (e.g., `getRecentContext` → O(n))

---

## 14. Security Best Practices

### 14.1 Path Validation

Always validate paths before use:

```typescript
function validateWorktreePath(filePath: string, worktreeRoot: string): string | null {
  if (!filePath || filePath.includes("\0")) return null;
  const resolved = resolve(worktreeRoot, filePath);
  if (!resolved.startsWith(worktreeRoot + "/") && resolved !== worktreeRoot) return null;
  if (resolved.includes("/.git/") || resolved.endsWith("/.git")) return null;
  return resolved;
}
```

### 14.2 Sandboxing

All tool execution runs in isolated namespace:

```typescript
const result = runInSandbox(command, args, {
  cwd: projectRoot,
  env: getSafeEnvVars(),
});
```

### 14.3 Input Sanitization

Sanitize all user inputs before using in commands:

```typescript
// Good
execFileSync("git", ["commit", "-m", message], { cwd: path });

// Bad
execFileSync("bash", ["-c", `git commit -m "${message}"`]);
```

### 14.4 Token Handling

- Hash tokens with SHA256 before storing
- Compare with constant-time functions
- Never log or expose tokens in errors
- Rotate keys periodically via key pool

### 14.5 Database Security

- Use parameterized queries (prevents SQL injection)
- Validate schema changes at startup
- Enable WAL mode for transaction safety
- Backup database regularly

---

## 15. Git & Worktree Integration

### 15.1 Worktree Lifecycle

Always use `execFileSync` with array arguments (prevents shell injection):

```typescript
// Good
execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath], {
  cwd: projectPath,
  stdio: "pipe",
});

// Bad
execFileSync(`git worktree add -b ${branchName} ${worktreePath}`, { shell: true });
```

**Path structure:** `{projectRoot}/.clawd/worktrees/{agentId}/`

**Persistence:**
- Store `worktree_path` and `worktree_branch` in DB (`channel_agents` table)
- Reuse on server restart if path/branch still valid
- Safe-delete checks for uncommitted changes before removal

### 15.2 Branch Naming

Use the `clawd/{randomId}` convention (6-char hex):

```typescript
export function generateBranchName(): string {
  return `clawd/${randomBytes(3).toString("hex")}`;  // e.g., "clawd/a3f7b2"
}
```

### 15.3 Commit Author Handling

Respect git local config first, then fallback to config.author:

```typescript
const author = getAuthorConfig();
const hasLocal = hasGitUserConfig(worktreePath);

if (hasLocal && author) {
  // Use git interpret-trailers to add Co-Authored-By (safe trailer injection)
  const processed = execFileSync("git", ["interpret-trailers", "--trailer", `Co-Authored-By: ${author.name} <${author.email}>`], {
    input: message,
    encoding: "utf-8",
  }).trim();
  return { args: ["commit", "-m", processed], message: processed };
} else if (!hasLocal && author) {
  // Use -c flags for main author
  return { args: ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message], message };
} else if (hasLocal) {
  // Git local config only
  return { args: ["commit", "-m", message], message };
} else {
  // No author configured — throw error
  throw new Error('No author: set git user.name/email or "author" in ~/.clawd/config.json');
}
```

### 15.4 Hunk Staging (SHA1 Content Hash)

Identify hunks by SHA1 content hash (not index-based) for stability:

```typescript
// Compute hunk hash from raw hunk text
const hunkHash = createHash("sha1").update(hunkRawLines.join("\n")).digest("hex");

// Store hash in DiffHunk.hash
interface DiffHunk {
  header: string;
  lines: Array<...>;
  hash: string;  // SHA1 for identification
}

// Find hunk by hash (enables detection when diff changes since UI render)
const hunk = diff.hunks.find((h) => h.hash === hunkHash);
if (!hunk) {
  return { ok: false, error: "hunk_not_found", httpStatus: 409 };  // 409 Conflict
}

// Apply hunk via git apply
execFileSync("git", ["apply", "--cached", "--unidiff-zero"], {
  input: patch,
  stdio: ["pipe", "pipe", "pipe"],
});
```

### 15.5 Sandbox & Worktree Integration

When a worktree is active:
- **sandbox projectRoot** = worktree path (agent sees worktree as root)
- **mount .git read-only** = original project's `.git/` directory
- **agent is unaware** = system prompt identical to normal git mode
- **git tool guards** = No special error messages about worktrees (generic errors)

```typescript
// In sandbox setup (agent-context.ts)
const context: AgentContext = {
  projectRoot: worktreePath,           // Agent sees this as root
  originalProjectRoot: projectRoot,    // But .git/ mounted from here
  worktreeBranch: branch,
};
```

### 15.6 Git Tool Guards

Tools like `git_commit` have guards that apply to worktrees:
- Detect protected branches (main/master/develop) — block commit/push/merge
- Require author configuration (via local config or config.author)
- Validate commit message not empty
- Same guards apply to worktrees and normal repos (no special handling)

---

## 16. Claude Code Agent Integration

Claude Code sub-agents are spawned via `@anthropic-ai/claude-agent-sdk` and receive full identity injection, tool restrictions, and streaming output handling.

### 16.1 Identity Injection (4-Layer Priority)

Sub-agents load identity from 4 directories with priority override:

1. **Global lowest** — `~/.claude/agents/{name}.md` (Claude Code global agents)
2. **Claw'd global** — `~/.clawd/agents/{name}.md` (Claw'd global agents)
3. **Claude Code project** — `{project}/.claude/agents/{name}.md` (Claude Code project agents)
4. **Per-agent highest** — `{project}/.clawd/agents/{name}.md` (Claw'd project agents)

**Auto-refresh**: Modify any agent file; identity refreshes on mtime change.

> **Note**: Agent files use markdown with YAML frontmatter (name, description, model, tools, directives). See `docs/agents.md` for the full format.

**System prompt injection**: PROJECT ROOT path automatically injected into sub-agent context.

### 16.2 Settings Passthrough to SDK

Forward Claw'd config settings to the Claude Agent SDK:

```typescript
const settings = {
  skip_co_author: config.settings?.skip_co_author ?? false,
  attribution: config.settings?.attribution ?? true,
  permissions: config.settings?.permissions ?? {},
};

await sdk.spawn({
  agent: "code-reviewer",
  settings,
  // ... other options
});
```

### 16.3 Custom Provider Support

Support custom claude-code providers without explicit type field:

```typescript
// providers in config.json
"claude-code-2": {
  "type": "claude-code",  // Optional; auto-inferred if omitted
  "model": "claude-3-5-sonnet-20241022",
  "api_key": "sk-..."
}
```

Custom providers without type are auto-inferred and listed in agents dialog.

### 16.4 Human Interrupt Handling

Sub-agents poll the main channel space for user messages during execution:

```typescript
// In sub-agent loop
while (agentRunning) {
  // Poll space channel for new messages
  const humanMessage = await getSpaceMessage(spaceId);
  if (humanMessage && !isAgentMessage(humanMessage)) {
    // Abort current task, inject human message, resume
    abortController.abort();
    await resumeWithMessage(humanMessage);
  }
  // Continue processing...
}
```

### 16.5 Result Message Handling

Sub-agent results no longer truncated at 10K chars:

```typescript
// Full result delivery to parent channel
const result = await completeTask({ content });  // content can be any length
// Result posted as full message, no truncation
```

### 16.6 Error Handling & Retry

Timeout, crash, or exit-without-complete_task errors are posted to main channel:

```typescript
try {
  await runSubAgent(task);
} catch (err: any) {
  if (err.code === "TIMEOUT" || err.code === "CRASH" || err.code === "NO_COMPLETE") {
    // Post error to main channel via space
    await postSpaceError(spaceId, err.message);
  }
}

// Retry on 500/server errors (up to 2 retries with exponential backoff)
const retryConfig = { maxRetries: 2, backoffMs: 1000 };
```

### 16.7 Thinking Block Recovery

Auto-recovery from corrupted thinking block signatures:

```typescript
// Detect signature mismatch
if (thinkingBlock && !isValidSignature(thinkingBlock)) {
  // Auto-repair: regenerate signature or strip block
  thinkingBlock = repairThinkingBlock(thinkingBlock);
}
```

### 16.8 Sub-Agent Tool Restrictions

Sub-agents have limited tool access for safety:

**Allowed:**
- `complete_task` — Report completion
- `chat_mark_processed` — Mark messages seen
- `today` — Get current date/time

> Environment info (OS, shell, project root, arch, user, runtime) is injected into the system prompt — no tool needed.

**Blocked:**
- `chat_send_message` — Cannot post to parent channel directly
- File/git tools — Inherit from parent config
- Browser tools — Inherit from parent config

**Inheritance**: Sub-agents inherit parent's `disallowedTools` and can be further restricted via agent file.

---

## Summary

Claw'd follows these core principles:

1. **Simplicity**: Minimal dependencies, clear intent
2. **Safety**: Validation, sandboxing, no injection
3. **Scalability**: Plugin architecture, multi-agent isolation
4. **Maintainability**: Clear naming, modular files, explicit types
5. **Performance**: Token management, database optimization, lazy loading

When in doubt, refer to existing code patterns in `src/` and follow the established conventions.
