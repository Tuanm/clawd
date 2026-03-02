# Brainstorm: Agent Workspace Strategy — Pragmatic Minimal Approach

> **Date:** 2026-03-01  
> **Status:** Complete  
> **Verdict:** 8/10 — Best available strategy with surgical corrections needed

---

## Problem Statement

Give each Claw'd agent a FULL working environment (like a PC) — mouse, keyboard, screen control — so it can complete tasks like a real human. The constraint: Claw'd is a standalone Bun-compiled binary with minimal dependencies. The question: what's the minimum viable path?

---

## Current Reality (What Agents Can Do Today)

| Capability | Status | Implementation |
|-----------|--------|----------------|
| File CRUD | ✅ | Native tools: `view`, `edit`, `create`, `grep`, `glob` |
| Bash execution | ✅ | Sandboxed via bwrap (Linux) / sandbox-exec (macOS) |
| Git workflows | ✅ | 13 native git tools, SSH key at `~/.clawd/.ssh/` |
| Background jobs | ✅ | tmux-based sessions (`job_submit`, `tmux_*` tools) |
| Sub-agent spawn | ✅ | `spawn_agent`, `list_agents`, `kill_agent` |
| MCP client | ✅ | stdio + HTTP transports, auto tool discovery |
| Vision/analysis | ✅ | `read_image` via Gemini (CPA primary, direct fallback) |
| Web fetch/search | ✅ | `web_fetch`, `web_search` |
| Browser control | ❌ | — |
| Desktop control | ❌ | — |
| Container isolation | ❌ | No Docker infrastructure exists |

**Key architectural facts:**
- MCP servers configured via `~/.clawd/config.json` → `mcp_servers` object
- Zero code changes needed to add new MCP servers
- Each agent gets its own `MCPManager` connection pool
- Sandbox wraps tool execution, NOT MCP server processes (security gap)
- Single binary: `bun build --compile` → `clawd-app`
- Only runtime dep: `sharp` (image processing). No Python, no heavy runtimes.

---

## Evaluation of the 3-Phase Pragmatic Approach

### Phase 1: Playwright MCP (NOW)

**Proposed:** Add `@playwright/mcp` to config. Zero code changes.

**Verdict: CORRECT. Do this.**

```json
{
  "mcp_servers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

**What the agent gains:**
- ~25 browser tools (navigate, click, fill, snapshot, screenshot)
- Accessibility tree snapshots (2KB text vs 500KB screenshot)
- Multi-tab, multi-browser support
- Zero token inflation (structured data, not pixels)

**What this actually covers:**
- ✅ Web app development (code → run dev server → test in browser → fix)
- ✅ Form automation, data entry, web scraping
- ✅ Visual verification (screenshot → `read_image` → analyze)
- ✅ E2E testing workflows
- ❌ Native apps (Figma desktop, Slack desktop, terminal GUIs)
- ❌ OS-level operations (file dialogs, notifications, system settings)

**Honest assessment:** This covers **80%+ of developer tasks** is accurate, but ONLY for web-centric development. If the agent needs to interact with native GUIs, this is 0% coverage. Know your use case.

**Risk:** `npx` at runtime requires Node.js on the host. This IS a dependency, just one most developers already have. For the compiled single-binary story, this is an asterisk.

**Effort: ~15 minutes** (config change + doc update)

---

### Phase 2: Workspace Container MCP (SOON)

**Proposed:** Docker container per agent with Linux desktop (Xvfb + XFCE) + MCP server inside.

**Verdict: DIRECTIONALLY CORRECT, but the proposal under-estimates scope and over-prescribes the solution.**

#### What's Right
- Docker as the isolation boundary: ✅ Correct
- MCP server inside container: ✅ Correct (Claw'd connects like any other MCP server)
- Shared volume for project files: ✅ Correct
- Pre-installed tools (terminal, browser, git): ✅ Correct

#### What's Wrong or Missing

**1. "~500 lines of code" is fantasy**

A production-quality workspace MCP server needs:

| Component | Lines (estimate) | Why |
|-----------|-----------------|-----|
| MCP server (tool handlers) | ~300 | screenshot, click, type, launch_app, read_file |
| X11 session management | ~200 | Xvfb lifecycle, display routing, resolution |
| Process management | ~150 | Launch/kill apps, PID tracking, zombie cleanup |
| Screenshot pipeline | ~100 | scrot/import → compress → base64/file |
| Input injection | ~150 | xdotool wrapper with coordinate validation |
| Error handling & logging | ~200 | Container health, crash recovery |
| Container lifecycle | ~200 | Startup script, graceful shutdown, signal handling |
| Dockerfile + build | ~100 | Multi-stage build, security hardening |
| **Total** | **~1,400** | And that's WITHOUT tests |

Not 500 lines. Not 2,000 either. But honest scoping matters.

**2. XFCE is overkill**

XFCE pulls in ~400MB of dependencies. For an agent that interacts programmatically, use:
- **fluxbox** (~2MB) or **openbox** (~4MB) as window manager
- No file manager, no panel, no desktop icons
- The agent doesn't need a "pretty" desktop — it needs windows to exist and be manageable

**3. noVNC for human monitoring is non-negotiable**

The proposal mentions it but doesn't emphasize: you MUST have a way for humans to watch what the agent is doing. noVNC via browser is the right call. This is a safety requirement, not a nice-to-have.

**4. Container orchestration is the ACTUAL hard problem**

The proposal glosses over:
- How does Claw'd start/stop containers per agent?
- How does container lifecycle tie to agent lifecycle?
- What happens when a container crashes mid-task?
- How do you route MCP connections to the right container?
- Port allocation for noVNC (one port per agent)?

This is where the real engineering lives. The MCP server inside is straightforward; the orchestration outside is where complexity hides.

**Revised effort estimate: 2-4 weeks** for a production-quality implementation, not "soon."

---

### Phase 3: Vision-Augmented Loop (LATER)

**Proposed:** Add vision loop for native app control inside containers.

**Verdict: CORRECT TIMING, but the infrastructure already exists.**

Claw'd already has `read_image` (Gemini vision). The container MCP would provide `screenshot()`. The loop is:

```
screenshot() → save to /tmp → read_image(path, "what do you see?") → decide action → click/type
```

This is NOT a new feature — it's a **prompt pattern** using existing tools. The agent can already do this the moment Phase 2 lands. What Phase 3 really adds is:
- Optimized screenshot → vision pipeline (skip file I/O, direct base64)
- Smart region capture (don't screenshot the whole desktop every time)
- Action verification (did my click actually work?)
- Coordinate calibration (map vision model coords to xdotool coords)

**This is a refinement phase, not a new capability phase.** Correct to defer.

---

## The Critical Question Answered

> Given that Claw'd is a standalone executable (TypeScript/Bun), what is the MINIMUM viable path to give agents their own workspace without adding heavy dependencies?

### Answer: It depends on what "workspace" means.

**If workspace = "browser + terminal + files":**
→ You already HAVE this. Agents have bash, file tools, git, tmux, web_fetch. Add Playwright MCP and you're at 90% coverage. **Minimum viable path: one config line.** Done.

**If workspace = "isolated environment with GUI":**
→ Docker is unavoidable. There is no lighter path to GUI isolation. But Docker is already a standard dev tool — it's not "heavy" in the way Python/Java runtimes are heavy. The dep is reasonable.

**If workspace = "full desktop like Anthropic Computer Use":**
→ Docker + Xvfb + xdotool + noVNC + vision loop. This is Phase 2+3. Accept the complexity.

### The Dependency Reality Check

| Dependency | Phase | Already on dev machines? | Weight |
|-----------|-------|------------------------|--------|
| Node.js (for npx) | Phase 1 | 99% yes | Negligible |
| Docker | Phase 2 | 85% yes | Acceptable |
| Xvfb + xdotool | Phase 2 | Inside container only | Zero host impact |
| noVNC | Phase 2 | Inside container only | Zero host impact |
| Python | Never | N/A | Avoided entirely |

**The insight:** Phases 2-3 dependencies live INSIDE Docker. The host machine only needs Docker itself. This preserves the "standalone binary" story perfectly.

---

## Challenges to the Proposal

### Challenge 1: "Is incremental just kicking the can?"

**No.** Here's why:

Incremental is bad when Phase 1 choices create technical debt that blocks Phase 2. Let's check:

| Phase 1 Choice | Blocks Phase 2? | Why |
|----------------|----------------|-----|
| Playwright MCP via config | ❌ | Phase 2 adds a DIFFERENT MCP server. They coexist. |
| Accessibility tree (not vision) | ❌ | Phase 3 adds vision. Not replacing, augmenting. |
| No Docker | ❌ | Phase 2 introduces Docker. No rip-and-replace needed. |

**Verdict:** These phases are additive, not conflicting. Incremental is the right call.

### Challenge 2: "Phase 1 agents can't control native apps — is that a real limitation?"

**For 90% of Claw'd's target use cases (developer agents), no.** Developers work in:
- Browser (web apps, docs, dashboards) → Playwright covers this
- Terminal (builds, tests, servers) → bash/tmux already covers this  
- Code editor (file editing) → edit/create/view already covers this
- Git (version control) → git tools already cover this

The remaining 10% (Figma desktop, Photoshop, legacy Windows apps) genuinely needs Phase 2+. But building for that 10% before delivering the 90% is YAGNI violation.

### Challenge 3: "MCP servers run outside the sandbox — isn't this a security hole?"

**Yes. This is the biggest real risk, and the proposal doesn't address it.**

Currently:
```
Claw'd → spawn("npx", ["@playwright/mcp"]) → UNSANDBOXED
  → Has full filesystem access
  → Inherits process.env (API keys, secrets)
  → Can make network requests
```

**Mitigation (should be Phase 1.5):**
1. Wrap MCP server spawn in bwrap (Linux) / sandbox-exec (macOS)
2. Pass filtered env (only vars the MCP server needs)
3. Restrict filesystem to projectRoot + /tmp
4. This is ~200 lines of code in `src/agent/src/mcp/client.ts`

### Challenge 4: "What about Windows agents?"

The proposal is Linux/macOS-centric. Windows agents:
- Phase 1: Playwright MCP works on Windows ✅
- Phase 2: Docker Desktop for Windows exists, but WSL2 adds latency. Consider: Windows agents might just use `windows-mcp` (native MCP server) instead of Docker containers.
- Phase 3: Vision loop works cross-platform ✅

**Recommendation:** Don't try to unify. Let Phase 2 be Linux containers for Linux/macOS hosts, and native MCP servers for Windows hosts.

---

## Refined Strategy (What I'd Actually Recommend)

### Phase 1: Browser + MCP Sandbox Hardening (Week 1)
- Add Playwright MCP to default config template
- Harden MCP server spawning (bwrap wrapper, filtered env)
- Document the config for users
- **Delivers:** Browser automation for all agents, security fix

### Phase 1.5: Chrome DevTools MCP (Week 2)
- Add as optional config alongside Playwright
- **Delivers:** Deep debugging (console logs, network, performance)

### Phase 2: Workspace Container (Weeks 3-6)
- Dockerfile: Ubuntu + fluxbox + Xvfb + noVNC + xdotool + scrot + common dev tools
- MCP server inside container: ~1,400 lines TypeScript (runs on Bun)
- Container lifecycle manager in Claw'd: start/stop/health per agent
- Shared volume mount for project files
- **Delivers:** Full isolated desktop per agent, human monitoring via browser

### Phase 3: Vision Loop Optimization (Weeks 7-8)
- Optimized screenshot → read_image pipeline
- Region-based capture (don't screenshot full desktop every action)
- Action verification pattern (screenshot before + after)
- **Delivers:** Native app control inside containers

---

## Score: 8/10

**Why not 10:**
- Security gap (MCP sandbox) unaddressed (-1)
- Effort estimates are optimistic (-0.5)
- Windows story is hand-waved (-0.5)

**Why not lower:**
- Incremental phases are genuinely independent (no rip-and-replace)
- Phase 1 delivers real value with near-zero effort
- Docker-as-isolation is the industry standard (Anthropic, OpenAI, Browserbase all use it)
- Avoids premature complexity (YAGNI/KISS honored)
- Preserves standalone binary story (deps live in container)

**The strategy is sound. The execution details need tightening.**

---

## Success Metrics

| Phase | Metric | Target |
|-------|--------|--------|
| 1 | Agent can complete web form filling task end-to-end | < 2 min |
| 1 | Agent can verify UI change via screenshot + vision | Works on first attempt |
| 2 | Container starts with MCP connection in | < 10 seconds |
| 2 | Human can observe agent actions via noVNC | Real-time, < 500ms lag |
| 2 | Agent can launch app + interact + screenshot inside container | 3-action sequence works |
| 3 | Agent can navigate native app by vision alone | 70%+ success rate |

---

## Next Steps

1. **Immediate:** Add Playwright MCP to config template (15 min)
2. **This week:** Prototype MCP server sandbox hardening in `mcp/client.ts`
3. **Decision needed:** Choose between fluxbox vs openbox for container WM
4. **Decision needed:** Container orchestration — Docker CLI vs Docker SDK vs Podman?
5. **If proceeding:** Create detailed implementation plan for Phase 2

---

## Appendix: Alternative Approaches Considered and Rejected

### A. "Just use Anthropic Computer Use API directly"
- Ties to Claude-specific tool format
- Claw'd is multi-provider (Gemini, OpenAI, Claude)
- Vendor lock-in violates architecture principles
- **Rejected:** Correct to use generic MCP approach instead

### B. "Skip Docker, use native desktop control"
- Agent running xdotool on HOST desktop = security nightmare
- No isolation between agents
- Can't reset/destroy environment
- **Rejected:** Docker isolation is non-negotiable for multi-agent

### C. "Use Kubernetes instead of Docker"
- K8s for local dev agent workspaces is like using a cruise ship to cross a lake
- Adds etcd, kubelet, API server overhead
- **Rejected:** Docker Compose is sufficient. KISS.

### D. "Build a custom VNC-based solution from scratch"
- noVNC already exists and is battle-tested
- x11vnc → noVNC pipeline is ~3 lines of setup
- **Rejected:** Don't reinvent wheels. Use existing tools.

### E. "WebAssembly containers (WasmEdge/Wasmer)"
- Cool but immature for GUI workloads
- No X11/Wayland support in Wasm runtimes
- **Rejected:** Not ready for desktop simulation use case
