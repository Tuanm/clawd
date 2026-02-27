# Claw'd - Agentic Collaborative Chat

Claw'd is a next-generation open-source platform for agentic, collaborative, multi-agent chat and workflow automation. It combines streaming LLM response handling, agent management, extensible tool and plugin systems, and a real-time web UI.

---

## Architecture Overview

- **Monorepo Layout:**
  - `src/`       — Main server, agent, and system logic (TypeScript).
  - `packages/ui`— Modern React SPA web UI (Vite + React + TypeScript).
  - `dist/server`— Compiled Bun binaries for multiple platforms.
  - `docs/`      — High-level design and agent system documentation.
  - `scripts/`   — Utility scripts (e.g., UI asset embedding).

- **Main Components:**
  - **Claw'd Server:** Unified HTTP/WebSocket server hosting the chat API, agent management, worker orchestration, and serving the embedded UI.
  - **Agentic Loop:** Each agent runs a managed loop for tool use, streaming LLM interaction, autonomous task polling, and cooperative workflows.
  - **Plugin System:** Supports plugins for extending agent tools, hooks, scheduling, and new agent types.
  - **UI:** Real-time collaborative chat interface, planning/task boards, and agent controls.

---

## Install & Build Instructions

### Requirements
- [Bun](https://bun.sh/) (v1.3.9+)
- Node.js (for some plugin/UI workflows, optional)

### Quick Start

```sh
# Clone the repo
bun install
bun run build   # (builds both server + UI)
```

#### Run Development
```sh
bun run dev         # Start server+agents
bun run dev:ui      # (from ./packages/ui) Run SPA in dev mode for hot reload
```

#### Build Binaries (cross-platform)
```sh
bun run build:all   # Output to dist/server/clawd-app-*
```

#### Install Locally
```sh
bun run install:local   # Copy server binary to ~/.clawd/bin/
```

---

## Usage and Features

- Open http://localhost:PORT after starting the server (default 3000 or as set by CLI/config).
- Manage agents, workers, and plans from the UI or API endpoints.
- Agents can execute tools, run workflows, answer questions, and work collaboratively.

---

## Configuration

- Settings are loaded from CLI flags and `~/.clawd/config.json` (see `src/config.ts`).
- Agent/project/workspace scopes and sleep/activation are manageable via the API and UI dialogs.
- Plugins/extensions: Place custom plugins in `~/.clawd/plugins/`, and use the plugin API for new agent toolkits or workflow logic.

---

## Directory Structure

- `src/` — core server, agent system, config, API routes, worker management, agent logic.
- `src/agent/` — agent loop, tools, memory/context management, skill/plugin system.
- `src/spaces/` — workspace management for per-project/channel isolation.
- `src/scheduler/` — background/recurring job logic (and plan system).
- `packages/ui` — complete front-end, bootstrapped via Vite.
- `dist/server/` — all compiled binaries for all supported OS/architecture targets.

---

## API

- REST endpoints for agent management, file/project browsing (read-only), planning, and scheduling. See src/api/agents.ts and articles.ts for conventions.
- Security: project root sandbox enforcement, sensitive file filtering, strict agent config

---

## Development & Extensibility

- Biome and TypeScript for code formatting/lint/checking.
- Plugins, custom tool integrations, skills, and agent types can be added without forking core code.
- UI is a modern React/Vite/TypeScript SPA, easily extendable.
- Scripting: see `scripts/` for automation (e.g., UI embedding for binary-only deployments).

---

## Credits

Claw'd draws on agentic LLM research, collaborative devchat UIs, and state-of-the-art multi-agent systems such as Claude Code.

---

## License

[MIT]
