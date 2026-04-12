# Contributing to Claw'd

> Thanks for your interest in contributing! This guide covers dev setup, standards, and the PR process.

---

## Table of Contents

1. [Dev Setup](#1-dev-setup)
2. [Coding Standards](#2-coding-standards)
3. [Project Structure](#3-project-structure)
4. [Testing](#4-testing)
5. [PR Process](#5-pr-process)

---

## 1. Dev Setup

### Prerequisites

- [Bun](https://bun.sh) v1.3.9+ (`curl -fsSL https://bun.sh/install | bash`)
- Node.js 20+ (for type checking compatibility)
- Git

### Install & Run

```bash
# Clone
git clone https://github.com/clawd-pilot/clawd.git
cd clawd

# Install dependencies
bun install

# Start dev server (hot-reload)
bun run dev

# Build UI (required before build:server)
bun run build:ui

# Build full server binary
bun run build:server
```

### Environment

Copy `.env.example` to `~/.clawd/.env` and configure your LLM provider credentials. Claw'd reads config from `~/.clawd/config.json` at runtime.

```bash
cp .env.example ~/.clawd/.env
# Edit ~/.clawd/.env with your API keys
```

### UI Development

```bash
# Dev UI with hot-reload (runs on :5173, proxies API to :3456)
bun run dev:ui
```

---

## 2. Coding Standards

### TypeScript

- Strict mode always — no `any`, no `ts-ignore` without comment
- Prefer `type` over `interface` for plain shapes; use `interface` for plugin contracts
- Explicit return types on all exported functions
- Zod for runtime validation at API boundaries

### Linting & Formatting

We use [Biome](https://biomejs.dev/) for both linting and formatting.

```bash
# Format
bun run format

# Lint
bun run lint

# Lint + format + fix
bun run check
```

CI enforces clean lint. Run `bun run check` before pushing.

### Key Principles

- **YAGNI / KISS**: Don't add abstractions until needed twice
- **No ORMs**: Direct SQL via `bun:sqlite`
- **No Express**: Bun native HTTP
- **No Redux**: Simple state management
- **Minimal deps**: Prefer Bun builtins over npm packages

### Error Handling

- Use typed errors from `src/errors.ts`
- Never swallow errors silently — log or rethrow
- Use `Result<T>` patterns for expected failure paths
- All async tool handlers must catch and return structured errors

---

## 3. Project Structure

```
clawd/
├── src/
│   ├── index.ts              # Server entry point — HTTP + WebSocket
│   ├── errors.ts             # Typed error classes
│   ├── worker-loop.ts        # Agent worker dispatch
│   ├── worker-manager.ts     # Worker lifecycle management
│   ├── internal-token.ts     # Internal auth token
│   │
│   ├── agent/                # Agent reasoning loop, plugins, memory
│   │   ├── agent.ts          # Core Agent class
│   │   ├── plugins/          # Tool plugins (browser, files, code, etc.)
│   │   └── memory/           # Session + long-term memory
│   │
│   ├── server/               # HTTP routes, WebSocket, MCP endpoint
│   │   ├── routes/           # Route handlers (chat, files, spaces, etc.)
│   │   ├── mcp/              # MCP protocol, tool defs, handlers
│   │   ├── websocket.ts      # WebSocket event handling
│   │   ├── middleware.ts      # Auth, CORS, rate limiting
│   │   └── multimodal.ts     # Image/file processing
│   │
│   ├── claude-code/          # Claude Code / Agent SDK integration
│   │   ├── sdk.ts            # Agent SDK wrapper
│   │   ├── main-worker.ts    # Claude Code process management
│   │   ├── memory.ts         # Claude Code memory bridge
│   │   └── tmux.ts           # tmux session management
│   │
│   ├── embedded/             # Embedded binary assets
│   │   ├── ui.ts             # Embedded React UI loader
│   │   ├── cli.ts            # Embedded CLI binary
│   │   └── extension.ts      # Embedded browser extension
│   │
│   ├── config/               # Configuration loading & schema
│   │   ├── config.ts         # Runtime config singleton
│   │   ├── config-file.ts    # File I/O for config.json
│   │   └── index.ts          # Public config exports
│   │
│   ├── db/                   # Database schema, migrations, queries
│   ├── scheduler/            # Cron/interval/once job scheduler
│   ├── spaces/               # Sub-agent space management
│   ├── shared/               # Shared types & utilities
│   └── utils/                # General utilities
│
├── packages/
│   ├── ui/                   # React SPA (Vite + TypeScript)
│   ├── browser-extension/    # Chrome extension (CDP + stealth)
│   └── remote-worker/        # Standalone remote worker clients (TS, Python, Java)
│
├── scripts/                  # Build scripts (embed-ui, zip-extension, etc.)
├── docs/                     # Architecture docs, standards, guides
└── plans/                    # Refactor plans (implementation phases)
```

### Key Conventions

| Area | Convention |
|------|-----------|
| Route files | `src/server/routes/{resource}.ts` |
| Tool plugins | `src/agent/plugins/{name}.ts` |
| DB queries | Inline SQL in relevant module (no ORM) |
| Tests | `src/__tests__/` or colocated `*.test.ts` |
| Config types | Always defined in `src/config/` |

---

## 4. Testing

We use `bun:test` (built-in Jest-compatible runner).

```bash
# Run all tests (isolated — recommended, avoids bun mock.module() cross-contamination)
bun run test:isolated

# Run specific file
bun test src/__tests__/agent.test.ts

# Run for CI
bun run test:ci
```

> **Note:** `bun test` (all files at once) shows false failures due to a bun v1.3.5 `mock.module()` bug where mocks bleed between test files. Always use `bun run test:isolated` which runs each file separately.

### Test Standards

- Unit tests for pure functions and utility modules
- Integration tests for database queries and API routes
- Mock external LLM calls — never hit real APIs in tests
- Use `describe` + `it` blocks; colocate tests near source when possible
- Test error paths, not just happy paths

---

## 5. PR Process

### Before Opening a PR

1. `bun run check` — lint + format must pass
2. `bun run test:isolated` — all tests must pass
3. `bun run build:server` — build must succeed
4. Update relevant docs in `docs/` if architecture changes

### PR Guidelines

- **One concern per PR** — avoid mixing refactors with features
- **Descriptive title** — `feat: add X`, `fix: Y`, `refactor: Z`, `docs: update W`
- **Link issues** — reference any related issues in the description
- **Small diffs preferred** — large PRs should be discussed first via issue

### Commit Style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add vision model support to agent plugins
fix: prevent memory leak in worker-manager teardown
refactor: extract MCP tools to src/server/mcp/
docs: update architecture for Phase 10 refactor
```

### Review Process

- All PRs require at least one review
- Address review comments or provide rationale for disagreement
- Squash commits before merge (maintainer handles if not done)
