# Claw'd Code Standards & Development Guide

> Last updated: 2026-03-20

---

## Table of Contents

1. [Core Technology Stack](#1-core-technology-stack)
2. [Architectural Principles](#2-architectural-principles)
3. [Code Organization](#3-code-organization)
4. [Naming Conventions](#4-naming-conventions)
5. [TypeScript Standards](#5-typescript-standards)
6. [Error Handling](#6-error-handling)
7. [Plugin System](#7-plugin-system)
8. [Database Patterns](#8-database-patterns)
9. [API Design](#9-api-design)
10. [Testing Standards](#10-testing-standards)
11. [Performance Guidelines](#11-performance-guidelines)
12. [Security Best Practices](#12-security-best-practices)
13. [Git & Worktree Integration](#13-git--worktree-integration)

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
├── config.ts                   # CLI argument parser
├── config-file.ts              # ~/.clawd/config.json loader
├── worker-loop.ts              # Per-agent polling loop
├── worker-manager.ts           # Multi-agent orchestrator + heartbeat
├── server/
│   ├── database.ts             # chat.db schema & migrations
│   ├── websocket.ts            # WebSocket push events
│   ├── browser-bridge.ts       # Browser extension WS bridge
│   ├── remote-worker.ts        # Remote worker WS bridge
│   └── routes/                 # API endpoint handlers
├── agent/
│   ├── agent.ts                # Agent class + reasoning loop
│   ├── agents/loader.ts        # Agent file discovery (4-directory priority)
│   ├── api/                    # LLM provider clients, key pool
│   ├── tools/                  # Tool definitions, web search, doc conversion
│   ├── plugins/                # All plugins (chat, browser, workspace, etc.)
│   ├── session/                # Session manager, checkpoints, summarizer
│   ├── memory/                 # Session memory, knowledge base, agent memory
│   ├── workspace/              # Git isolated mode
│   ├── mcp/                    # MCP client connections
│   ├── prompt/                 # System prompt builder
│   └── utils/                  # sandbox.ts, debug, context helpers
├── spaces/                     # Sub-agent system (Spaces)
│   ├── manager.ts              # Space lifecycle
│   ├── worker.ts               # Space worker orchestrator
│   ├── db.ts                   # spaces table schema
│   └── plugin.ts               # spawn_agent tool
├── scheduler/                  # Job scheduling (cron/interval/once)
│   ├── manager.ts              # Tick loop
│   ├── runner.ts               # Job executor
│   └── parse-schedule.ts       # Natural language parser
└── api/                        # Agent registration, MCP, articles

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
└── browser-extension/          # Chrome MV3
    └── src/
        ├── service-worker.js   # Command dispatcher
        ├── content-script.js   # DOM extraction
        ├── shield.js           # Anti-detection patches
        └── offscreen.js        # WS connection
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

## 7. Plugin System

### 7.1 Implementing a Tool Plugin

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

### 7.2 Plugin Registration

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

## 8. Database Patterns

### 8.1 Schema Definition

Use typed migrations:

```typescript
const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE worktree_info (
        agent_id TEXT PRIMARY KEY,
        worktree_path TEXT NOT NULL,
        worktree_branch TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `,
  },
];

for (const m of migrations) {
  db.exec(m.sql);
}
```

### 8.2 Prepared Statements

Always use parameterized queries:

```typescript
// Good
const stmt = db.prepare("SELECT * FROM agents WHERE channel = ? AND id = ?");
const agent = stmt.get(channel, agentId);

// Bad
const agent = db.query(`SELECT * FROM agents WHERE channel = '${channel}'`);
```

### 8.3 Transactions

Explicit transactions for multi-step operations:

```typescript
db.transaction(() => {
  db.prepare("INSERT INTO agents (id, channel) VALUES (?, ?)").run(agentId, channel);
  db.prepare("INSERT INTO channel_agents (channel, agent_id) VALUES (?, ?)").run(channel, agentId);
})();
```

### 8.4 WAL Mode

Ensure WAL mode for concurrent access:

```typescript
const db = new Database(":memory:");
db.pragma("journal_mode = wal");  // Enable WAL
```

---

## 9. API Design

### 9.1 REST Endpoint Structure

Organize endpoints by resource:

```
GET  /api/app.worktree.enabled
GET  /api/app.worktree.status
GET  /api/app.worktree.diff
POST /api/app.worktree.stage
POST /api/app.worktree.commit
```

**Pattern**: `/{resource}.{action}` where `resource` is domain (app, chat, agent) and `action` is operation.

### 9.2 Request/Response Format

All responses return JSON:

```typescript
// Success (200)
{ "ok": true, "data": { ... } }

// Error (4xx/5xx)
{ "ok": false, "error": "error_code", "message": "Human-readable message" }
```

### 9.3 Status Codes

- **200**: Success
- **400**: Bad request (missing/invalid parameters)
- **404**: Not found (resource doesn't exist)
- **409**: Conflict (e.g., hunk hash mismatch during staging)
- **500**: Server error

---

## 10. Testing Standards

### 10.1 Unit Tests

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

### 10.2 Integration Tests

Test across components:

```typescript
test("worktree creation and status flow", () => {
  const { path, branch } = createWorktree(projectPath, agentId);
  const status = getWorktreeStatus(path);
  expect(status.branch).toBe(branch);
  expect(status.clean).toBe(true);
});
```

### 10.3 No Mocking

Avoid mocking for database/file operations when possible:

```typescript
// Good: Use real database
const db = new Database(":memory:");
const result = getWorktreeStatus(worktreePath);

// Acceptable when unavoidable
const mockGit = { commit: () => ({ ok: true }) };
```

---

## 11. Performance Guidelines

### 11.1 Token Management

- **Context compaction**: Aggressive at 75% token limit, critical reset at 95%
- **Tool filtering**: Prune unused tools after 5-iteration warmup
- **Model tiering**: Auto-downgrade to Haiku for tool routing decisions
- **Prompt caching**: Use Anthropic's prompt-caching beta header

### 11.2 Database Query Optimization

- Use indexes on frequently queried columns (channel, agent_id, ts)
- Prepared statements for repeated queries
- Pagination for large result sets

### 11.3 WebSocket Efficiency

- Broadcast events to subscribed clients only
- Compress large payloads (diffs, large messages)
- Batch updates when possible

### 11.4 Worktree Performance

- Lazy-load worktree diffs (only fetch when user opens dialog)
- Cache worktree status for 5 seconds (avoid repeated git calls)
- Use `git worktree list --porcelain` for efficient listing

---

## 12. Security Best Practices

### 12.1 Path Validation

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

### 12.2 Sandboxing

All tool execution runs in isolated namespace:

```typescript
const result = runInSandbox(command, args, {
  cwd: projectRoot,
  env: getSafeEnvVars(),
});
```

### 12.3 Input Sanitization

Sanitize all user inputs before using in commands:

```typescript
// Good
execFileSync("git", ["commit", "-m", message], { cwd: path });

// Bad
execFileSync("bash", ["-c", `git commit -m "${message}"`]);
```

### 12.4 Token Handling

- Hash tokens with SHA256 before storing
- Compare with constant-time functions
- Never log or expose tokens in errors
- Rotate keys periodically via key pool

### 12.5 Database Security

- Use parameterized queries (prevents SQL injection)
- Validate schema changes at startup
- Enable WAL mode for transaction safety
- Backup database regularly

---

## 13. Git & Worktree Integration

### 13.1 Worktree Lifecycle

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

### 13.2 Branch Naming

Use the `clawd/{randomId}` convention (6-char hex):

```typescript
export function generateBranchName(): string {
  return `clawd/${randomBytes(3).toString("hex")}`;  // e.g., "clawd/a3f7b2"
}
```

### 13.3 Commit Author Handling

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

### 13.4 Hunk Staging (SHA1 Content Hash)

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

### 13.5 Sandbox & Worktree Integration

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

### 13.6 Git Tool Guards

Tools like `git_commit` have guards that apply to worktrees:
- Detect protected branches (main/master/develop) — block commit/push/merge
- Require author configuration (via local config or config.author)
- Validate commit message not empty
- Same guards apply to worktrees and normal repos (no special handling)

---

## Summary

Claw'd follows these core principles:

1. **Simplicity**: Minimal dependencies, clear intent
2. **Safety**: Validation, sandboxing, no injection
3. **Scalability**: Plugin architecture, multi-agent isolation
4. **Maintainability**: Clear naming, modular files, explicit types
5. **Performance**: Token management, database optimization, lazy loading

When in doubt, refer to existing code patterns in `src/` and follow the established conventions.
