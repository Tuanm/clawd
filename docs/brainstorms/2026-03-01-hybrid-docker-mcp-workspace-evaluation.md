# Hybrid Docker + MCP Workspace Architecture Evaluation

**Date:** 2026-03-01
**Status:** Complete
**Scope:** Evaluate hybrid Docker container (Xvfb + XFCE + noVNC) + MCP (Playwright + Chrome DevTools) + vision fallback (xdotool + scrot) as the workspace architecture for Claw'd AI agents.

---

## 1. Problem Statement

Claw'd needs to give each AI agent a **full working environment** — equivalent to a human sitting at a PC — where the agent controls mouse, keyboard, screen, filesystem, and applications. The solution must:

- Support **web tasks** (majority of dev work): browsing, form-filling, testing
- Support **native app tasks**: IDEs, terminals, file managers, custom GUIs
- Provide **full isolation** between agents (filesystem, processes, display)
- Allow **human monitoring** of agent activity
- Scale to **N concurrent agents**
- Be **provider-agnostic** (not locked to Claude, GPT, or any single model)
- Integrate with Claw'd's **existing MCP architecture** (zero or minimal code changes)

---

## 2. Proposed Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CLAW'D HOST                       │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │           Agent Container (per-agent)         │   │
│  │                                               │   │
│  │  Ubuntu 22.04 + XFCE + Xvfb (:99, 1920x1080)│   │
│  │                                               │   │
│  │  ┌─────────────┐  ┌──────────────────────┐   │   │
│  │  │ Playwright   │  │ Chrome DevTools      │   │   │
│  │  │ MCP Server   │  │ MCP Server           │   │   │
│  │  │ :3001 (HTTP) │  │ :3002 (HTTP)         │   │   │
│  │  └──────┬──────┘  └──────────┬───────────┘   │   │
│  │         │ accessibility tree  │ network/perf   │   │
│  │         └──────────┬──────────┘               │   │
│  │                    │                          │   │
│  │  ┌────────────────┴────────────────────┐     │   │
│  │  │         Chromium Browser             │     │   │
│  │  └─────────────────────────────────────┘     │   │
│  │                                               │   │
│  │  ┌──────────────┐  ┌──────────────────┐      │   │
│  │  │ xdotool      │  │ scrot/screenshot │      │   │
│  │  │ (mouse/kbd)  │  │ (screen capture) │      │   │
│  │  └──────────────┘  └──────────────────┘      │   │
│  │                                               │   │
│  │  ┌──────────────────────────────────────┐    │   │
│  │  │ noVNC → x11vnc → Xvfb (:6080)       │    │   │
│  │  │ (human monitoring)                    │    │   │
│  │  └──────────────────────────────────────┘    │   │
│  │                                               │   │
│  │  Ports exposed: 3001, 3002, 6080              │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  Claw'd Agent Loop:                                 │
│    1. Connect to container MCP servers (HTTP)       │
│    2. Web task? → Playwright MCP (a11y tree)        │
│    3. Native task? → screenshot + xdotool           │
│    4. Verify? → screenshot → vision model           │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## 3. PRO-by-PRO Analysis (Argued)

### ✅ PRO: "Best of both worlds — cheap web, universal native"

**Verdict: PARTIALLY TRUE, with major caveats.**

The "$0.01/action for web" claim is **misleading**. Recent benchmarks show Playwright MCP accessibility tree snapshots are NOT cheap:

| Page               | Playwright MCP tokens | Optimized CLI tokens | Ratio |
|--------------------|----------------------|---------------------|-------|
| Wikipedia          | 16,044               | 7,860               | 2x    |
| GitHub repo        | 19,409               | 4,304               | 4.5x  |
| Hacker News        | 14,547               | 3,052               | 4.8x  |
| Complex workflow   | ~114,000             | ~27,000             | 4.2x  |

At $3/M input tokens (Sonnet-class), a 19K-token GitHub page snapshot costs **$0.057 per action**, not $0.01. For a 10-step workflow, that's **$0.57** just in accessibility tree reads. Still cheaper than vision ($0.10-0.30/screenshot), but not the order-of-magnitude difference claimed.

**However**, the core argument holds: accessibility tree is **3-10x cheaper** than screenshots AND **deterministic**. The fallback to vision for native apps is a sound engineering decision. The hybrid routing logic ("web → MCP, native → vision") is the correct split.

**Adjusted reality**: ~$0.03-0.06/action for web tasks, ~$0.10-0.30/action for native app tasks.

---

### ✅ PRO: "Full isolation — own filesystem, display, process space"

**Verdict: TRUE and CRITICAL.**

This is the strongest argument for the architecture. Docker containers provide:
- **Filesystem isolation**: Agent can `rm -rf /` without affecting anything
- **Process isolation**: Runaway processes die with the container
- **Display isolation**: Each agent gets its own `:99` display — no collision
- **Network isolation**: Can restrict outbound access per-container
- **Resource limits**: Memory/CPU/PID caps prevent resource starvation

**BUT** — Docker isolation is **namespace-based, not hardware-based**. All containers share the host kernel. For truly untrusted workloads, this is insufficient. The GoClaw architecture already documents the right hardening:
- `--cap-drop=ALL`
- `--read-only` root filesystem
- `--no-new-privileges`
- `--security-opt=no-new-privileges`
- Memory/CPU/PID limits
- Non-root user

For Claw'd's use case (agents running developer tasks in sandboxed containers), Docker isolation is **sufficient**. E2B/Firecracker microVMs would be overkill unless serving untrusted external users.

---

### ✅ PRO: "Multi-agent: N containers, no collision"

**Verdict: TRUE, with scaling considerations.**

Each container is ~1-1.5 GB image (one-time pull), ~500MB-1GB runtime memory. Realistic scaling:

| Host RAM | Agents (concurrent) | Notes                          |
|----------|--------------------|---------------------------------|
| 16 GB    | 4-6                | Developer laptop                |
| 32 GB    | 10-15              | Workstation                     |
| 64 GB    | 25-30              | Server                          |
| 128 GB   | 50-60              | Production server               |

**Key constraint**: Port mapping. Each container needs 3 ports (MCP×2 + noVNC). Dynamic port allocation required. Claw'd's container manager must track port assignments.

This is a real advantage over non-containerized approaches where N agents would fight over display `:0`, file paths, and processes.

---

### ✅ PRO: "Web tasks use efficient accessibility tree"

**Verdict: TRUE — the RIGHT default for dev work.**

For the 80% case (browsing docs, filling forms, navigating GitHub, testing web apps), accessibility tree provides:
- **Structured data** — LLM gets element names, roles, states, not pixels
- **Deterministic targeting** — Click element by ref, not by pixel coordinate
- **No vision model needed** — Works with any text-only LLM
- **Faster execution** — No screenshot render/encode/decode cycle

This is the correct architectural choice. The Playwright MCP server runs INSIDE the container alongside Chrome, so there's no network latency for the browser ↔ MCP communication — only the agent ↔ container MCP call crosses the network.

---

### ✅ PRO: "Native app tasks still possible via vision"

**Verdict: TRUE, but EXPENSIVE and FRAGILE.**

Vision-based desktop control (screenshot → LLM analyze → xdotool act) works for:
- IDE interactions (VSCode, IntelliJ)
- Terminal applications (htop, vim)
- File managers
- Custom native GUIs

**Cost reality per vision action cycle**:
1. `scrot` screenshot capture: ~50ms, free
2. Base64 encode + send to vision LLM: ~$0.01-0.05 per image
3. LLM analyzes and decides action: ~$0.05-0.20 (depends on model/complexity)
4. `xdotool` execute: ~10ms, free
5. **Total: $0.06-0.25 per action, 2-5 seconds latency**

A 20-step native app workflow costs **$1.20-5.00** and takes **40-100 seconds**. This is acceptable as a FALLBACK, not a primary mode.

**Critical question**: How often do agents ACTUALLY need native app control? For development work:
- Git: CLI (no vision needed)
- IDE: Can use CLI tools, LSP, file editing (no vision needed for 90% of tasks)
- Terminal: Direct bash access (no vision needed)
- Browser: Playwright MCP (covered above)

**The vision fallback may be needed <5% of the time** in practice. This is a safety net, not a workhorse.

---

### ✅ PRO: "Human can monitor via noVNC"

**Verdict: TRUE and VALUABLE.**

noVNC at port 6080 gives any human a browser-based window into the agent's desktop. This enables:
- **Debugging**: Watch what the agent is doing in real-time
- **Intervention**: Take over control if agent gets stuck
- **Audit**: Record/replay sessions
- **Trust-building**: Show clients/stakeholders that agents are working correctly

**Minimal cost**: x11vnc + noVNC adds ~20MB to image and <5MB RAM at runtime. The value-to-cost ratio is extremely high.

One concern: noVNC must be **authenticated** in production. Exposing an unauthenticated desktop to the network is a security risk. Basic auth or token-based access should be mandatory.

---

### ✅ PRO: "MCP-native — connects like any external MCP server"

**Verdict: TRUE and THIS IS THE KILLER ADVANTAGE.**

Claw'd's MCP client (`src/agent/src/mcp/client.ts`) already supports HTTP transport. Connecting to a container's MCP server requires ZERO code changes:

```json
{
  "mcp_servers": {
    "agent_workspace_playwright": {
      "url": "http://localhost:13001",
      "transport": "http"
    },
    "agent_workspace_devtools": {
      "url": "http://localhost:13002",
      "transport": "http"
    }
  }
}
```

The container's MCP servers appear as standard external tools. The agent loop doesn't know or care that they're running inside a Docker container. This is clean architecture that respects Claw'd's existing design.

The ONLY new code needed is **container lifecycle management** (spawn/destroy/port-mapping), which is already designed in the GoClaw architecture.

---

## 4. CON-by-CON Analysis (Argued)

### ❌ CON: "Complexity — two control paths"

**Verdict: VALID, but MANAGEABLE.**

The routing logic is straightforward:

```
if task.type == "web" or task.involves_browser:
    use playwright_mcp tools (navigate, click, fill, snapshot)
elif task.type == "native_app":
    use screenshot + xdotool (vision cycle)
else:
    use bash/file tools (no desktop needed)
```

**The real complexity** isn't two paths — it's the **vision loop** itself. The screenshot → analyze → act cycle needs:
- Retry logic (vision misinterpretation)
- Coordinate normalization (resolution-dependent)
- State verification (did the action succeed?)
- Timeout handling (app didn't respond)

This complexity exists regardless of whether you have the Playwright path. Adding Playwright MCP actually **reduces** total complexity because it handles the 80% case without vision.

**Recommendation**: Build the MCP path first (Phase 1-2 in existing roadmap). Add vision fallback later (Phase 3-4) only when concrete native-app use cases demand it. YAGNI.

---

### ❌ CON: "Docker dependency on host"

**Verdict: MINOR CONCERN.**

Docker is ubiquitous in 2025/2026. Every developer machine, CI system, and cloud provider supports it. The GoClaw architecture already requires Docker for sandboxing.

**Edge cases that matter**:
- Windows without WSL2/Docker Desktop: Increasingly rare
- macOS Docker Desktop licensing: Free for individuals, $5/user/mo for teams
- Rootless Docker: Available but quirky with Xvfb
- Podman alternative: Compatible for most use cases

**Mitigation**: Document Docker as a hard requirement. It already is one for GoClaw's sandbox mode.

---

### ❌ CON: "Container size — 2-4 GB image"

**Verdict: VALID, but OPTIMIZABLE.**

Breakdown of a realistic image:

| Component          | Size     | Notes                          |
|--------------------|----------|-------------------------------|
| Ubuntu 22.04 base  | ~75 MB   | Minimal                       |
| XFCE desktop       | ~250 MB  | Heavyweight for a container   |
| Xvfb               | ~5 MB    | Tiny                          |
| x11vnc + noVNC     | ~20 MB   | Minimal                       |
| Chromium           | ~400 MB  | Single browser                |
| Playwright + Node  | ~200 MB  | Runtime only                  |
| xdotool + scrot    | ~5 MB    | Tiny                          |
| Dev tools (git, etc)| ~100 MB | Build essentials              |
| **Total**          | **~1.1 GB** | **Optimized**              |

The 2-4 GB estimate comes from unoptimized builds. With single-browser install, apt cleanup, and multi-stage builds, **1.0-1.5 GB is achievable**.

**Critical optimization**: Replace XFCE with **fluxbox or openbox** (~10 MB vs 250 MB). XFCE is unnecessary — the agent doesn't need a taskbar, file manager, or settings panel. A minimal window manager that can manage windows is sufficient. This alone saves 200+ MB.

```dockerfile
# Instead of XFCE:
RUN apt-get install -y fluxbox  # 10 MB, handles window management
```

**Optimized target: ~850 MB image.** The image is pulled once and cached. Runtime memory per container is the real cost (~500 MB-1 GB).

---

### ❌ CON: "Container management logic needed"

**Verdict: VALID and NON-TRIVIAL.**

Claw'd needs to implement:

1. **Spawn**: `docker run -d` with port mapping, resource limits, volume mounts
2. **Destroy**: `docker stop && docker rm` on agent session end
3. **Health check**: Is the MCP server responding? Is X11 up?
4. **Port allocation**: Dynamic port assignment for N containers
5. **Lifecycle hooks**: Start MCP servers after Xvfb is ready
6. **Cleanup**: Prune stale containers (crashed agents, orphans)
7. **Image management**: Pull/build/cache the workspace image

**However**, the GoClaw architecture ALREADY designs this. The `DockerSandbox` execution model covers create-on-demand, per-session scope, automatic pruning, and security hardening. This CON is pre-mitigated.

**Estimate**: ~500-800 lines of container management code, plus health check endpoints inside the container.

---

### ❌ CON: "MCP over HTTP — not stdio"

**Verdict: NON-ISSUE.**

Claw'd's MCP client already supports HTTP transport (`MCPHttpConnection` class, ~120 lines). The container runs MCP servers as HTTP endpoints. Claw'd connects via `url: "http://localhost:PORT"`.

The ONLY difference from stdio MCP:
- **Latency**: ~1-5ms network overhead (negligible vs LLM inference latency of 500ms-5s)
- **Connection management**: HTTP is stateless, stdio maintains persistent pipe
- **Startup detection**: Need to poll/wait for HTTP server readiness vs stdio pipe immediately available

**The Streamable HTTP transport** (MCP spec 2025) handles all of this cleanly. No custom work needed.

---

### ❌ CON: "Vision still expensive when used"

**Verdict: TRUE, but INFREQUENT.**

As analyzed in the PRO section, vision fallback costs $0.06-0.25/action. For a 20-step native workflow: $1.20-5.00.

**Mitigation strategies**:
1. **Minimize vision calls**: Use accessibility tree even for native apps that expose it (GTK/Qt apps do)
2. **Cache screenshots**: Don't re-capture if no action was taken
3. **Smart cropping**: Send only the relevant region, not full 1920×1080
4. **Low-res first**: 960×540 screenshot for initial analysis, full-res only when precision needed
5. **Action batching**: Analyze once, plan multiple actions

**Budget impact**: If vision is used <5% of total actions, the cost increase is marginal. At 100 total actions, 5 vision actions = $0.30-1.25 extra.

---

### ❌ CON: "File transfer between host and container"

**Verdict: VALID and REQUIRES DESIGN.**

Three approaches, ranked:

#### Option A: Docker volume mounts (RECOMMENDED)
```bash
docker run -v /host/workspace:/workspace agent-container
```
- **Pro**: Zero-copy, instant, bidirectional
- **Pro**: Agent reads/writes files that appear on host immediately
- **Con**: Shared filesystem state (but this is the DESIRED behavior for dev work)
- **Con**: Permission issues (container user ≠ host user) — fixable with `--user $(id -u):$(id -g)`

#### Option B: Docker cp
```bash
docker cp file.txt container:/workspace/
docker cp container:/workspace/output.txt .
```
- **Pro**: Explicit, no shared state
- **Con**: Manual, slow, requires orchestration

#### Option C: MCP resource protocol
- Container MCP server exposes files as MCP resources
- Agent reads/writes via `resources/read` and custom `resources/write`
- **Pro**: MCP-native, network-transparent
- **Con**: Requires custom MCP server code, overhead for large files

**Recommendation**: Volume mounts for the project workspace. This is the standard Docker pattern and works perfectly for development environments where the agent needs to read source code and write modified files.

---

## 5. Comparative Analysis

### vs. Pure Docker+Xvfb (NO MCP inside)

| Aspect                 | Hybrid (proposed)        | Pure Docker+Xvfb         |
|------------------------|--------------------------|--------------------------|
| Web automation         | Accessibility tree (cheap, fast) | Screenshot-only (expensive, slow) |
| Cost per web action    | $0.03-0.06               | $0.10-0.30               |
| Determinism            | High (element refs)      | Low (pixel coordinates)  |
| LLM model requirement  | Any text LLM             | Vision LLM required      |
| Native app support     | Same (vision fallback)   | Same (vision)            |
| Container complexity   | Higher (MCP servers)     | Lower (just X11 tools)   |
| Image size             | ~1.0 GB                  | ~0.7 GB                  |
| Provider lock-in       | None                     | Vision model dependency  |

**Verdict**: Hybrid wins decisively. For the 80% web case, accessibility tree saves **3-5x on cost** and **removes vision model dependency**. The 300 MB image size increase (adding Node + Playwright) is trivial. Pure Docker+Xvfb forces EVERY action through the expensive vision path — this is wasteful when structured browser data is available.

**The hybrid gains over pure Docker+Xvfb**: Cost efficiency on web tasks, deterministic automation, text-LLM compatibility.

---

### vs. Pure MCP-only (NO container)

| Aspect                 | Hybrid (proposed)        | Pure MCP-only             |
|------------------------|--------------------------|---------------------------|
| Filesystem isolation   | Full (container boundary)| None (host filesystem)    |
| Process isolation      | Full (container PID ns)  | None (host processes)     |
| Native app support     | Yes (Xvfb + xdotool)    | No (browser only)         |
| Display isolation      | Full (per-agent :99)     | No display at all         |
| Multi-agent safety     | Complete isolation        | Agents can interfere      |
| Human monitoring       | noVNC (visual)           | Logs only                 |
| Security               | Sandboxed                | Host-level access         |
| Setup complexity       | Higher (Docker)          | Lower (just npm install)  |
| Startup time           | ~2-5s (container start)  | ~500ms (process start)    |
| Resource cost          | ~500 MB-1 GB per agent   | ~100 MB per agent         |

**Verdict**: Pure MCP-only is **viable for browser-only tasks** but **fundamentally insufficient** for the stated requirement of "a full working environment like a PC." Without containers:
- No native app support
- No filesystem isolation (agent A can delete agent B's files)
- No process isolation (runaway processes affect everything)
- No visual monitoring
- Security nightmare (MCP servers run with host privileges)

**The hybrid gains over pure MCP-only**: Isolation, security, native app capability, monitoring, multi-agent safety. This is not marginal — these are hard requirements.

---

### vs. E2B/Firecracker microVMs

| Aspect                 | Hybrid Docker             | E2B microVM               |
|------------------------|---------------------------|---------------------------|
| Isolation strength     | Kernel namespaces (good)  | Hardware virtualization (best) |
| Startup time           | ~2-5s                     | ~150-200ms                |
| Cost                   | Free (self-hosted)        | $0.05-0.08/hr/vCPU       |
| Customization          | Full Dockerfile control   | Template-based            |
| Persistence            | Volume mounts             | Ephemeral only            |
| Self-hosting           | Docker only               | Requires Firecracker setup|
| GPU support            | nvidia-docker             | Not yet                   |
| Image size             | ~1 GB                     | Depends on template       |

**Verdict**: E2B is overkill for Claw'd's current use case. Docker provides sufficient isolation for trusted agent code. E2B makes sense for multi-tenant SaaS where untrusted users submit code — that's not Claw'd's model (agents run developer-configured tasks in private workspaces).

**Consider E2B when**: Claw'd offers hosted multi-tenant agent workspaces to external users.

---

## 6. Critical Risks & Mitigations

### Risk 1: Accessibility tree bloat on complex SPAs
- **Impact**: Token limits exceeded on large React/Angular apps (100K+ tokens)
- **Mitigation**: Playwright MCP `snapshot` supports filtering. Implement viewport-only snapshots, element-scoped queries, and max-token truncation.

### Risk 2: Container orchestration reliability
- **Impact**: Orphaned containers consuming resources, port conflicts
- **Mitigation**: Implement GoClaw's pruning logic (24h idle → kill, 7d → delete). Use Docker API for container listing, not shell commands. Health check HTTP endpoint in container.

### Risk 3: MCP server crash inside container
- **Impact**: Agent loses tool access mid-task
- **Mitigation**: Supervisor process inside container (supervisord or s6-overlay) restarts crashed MCP servers. Container health check verifies MCP responsiveness.

### Risk 4: File permission mismatches
- **Impact**: Container user can't write to mounted volume or host can't read container output
- **Mitigation**: Run container with `--user $(id -u):$(id -g)`. Or use a fixed UID that matches the host developer user.

### Risk 5: Network security
- **Impact**: Container MCP servers accessible to anyone on the network
- **Mitigation**: Bind to `127.0.0.1` only. Or use Docker network isolation with authenticated proxy.

---

## 7. Implementation Considerations

### Phased Rollout (aligned with existing roadmap)

**Phase 1 (1-2 weeks)**: Playwright MCP in standard config (no container)
- Just add `@playwright/mcp` to agent's MCP config
- Validates accessibility tree approach
- Zero Docker work needed

**Phase 2 (1-2 weeks)**: Containerized workspace prototype
- Build Docker image: Ubuntu + Xvfb + fluxbox + Chromium + Playwright MCP + noVNC
- Manual `docker run`, manual port assignment
- Connect Claw'd to container's MCP server over HTTP
- Validate end-to-end: agent → container MCP → browser action → result

**Phase 3 (2-3 weeks)**: Container lifecycle management
- Integrate Docker API into Claw'd
- Dynamic port allocation, health checks, auto-cleanup
- Per-agent container spawning on session start

**Phase 4 (2-3 weeks)**: Vision fallback
- Add xdotool + scrot to container image
- Implement screenshot → vision analysis → action cycle
- Build routing logic (web → MCP, native → vision)
- Only if concrete native-app use cases are identified

**Phase 5 (optional)**: Hardening & optimization
- Security audit (GoClaw hardening checklist)
- Image optimization (multi-stage build, single browser)
- Container pooling (pre-warmed containers for fast startup)
- noVNC authentication

### Estimated Container Image Dockerfile

```dockerfile
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV RESOLUTION=1920x1080x24

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb fluxbox x11vnc \
    curl wget git ca-certificates \
    xdotool scrot imagemagick \
    && rm -rf /var/lib/apt/lists/*

# Node.js (for MCP servers)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Playwright + Chromium only
RUN npx playwright install chromium --with-deps \
    && npx playwright install-deps chromium

# noVNC
RUN git clone --depth 1 https://github.com/novnc/noVNC /opt/novnc \
    && git clone --depth 1 https://github.com/novnc/websockify /opt/novnc/utils/websockify

# MCP servers
RUN npm install -g @playwright/mcp@latest

# Supervisor
RUN apt-get update && apt-get install -y supervisor && rm -rf /var/lib/apt/lists/*

COPY supervisord.conf /etc/supervisor/conf.d/

# Non-root user
RUN useradd -m -s /bin/bash agent
USER agent
WORKDIR /home/agent

EXPOSE 3001 6080

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
```

---

## 8. Success Metrics

| Metric                          | Target                    |
|---------------------------------|---------------------------|
| Web action cost (avg)           | < $0.05/action            |
| Web action latency (avg)        | < 2 seconds               |
| Container startup time          | < 5 seconds               |
| Container image size            | < 1.5 GB                  |
| Runtime memory per container    | < 1 GB                    |
| Concurrent agents (32 GB host)  | ≥ 10                      |
| Agent task success rate (web)   | > 90%                     |
| Agent task success rate (native)| > 70%                     |
| noVNC connection latency        | < 500ms                   |

---

## 9. Final Verdict

### Score: 8/10

**This is the RIGHT architecture for Claw'd.** Here's why:

**What earns the 8:**
- **Architecturally sound**: Leverages Claw'd's existing MCP infrastructure with zero core changes
- **Cost-optimized**: Accessibility tree for the 80% case, vision only when truly needed
- **Isolation-complete**: Each agent gets a genuine sandboxed PC
- **Provider-agnostic**: Not locked to any specific LLM vendor
- **Already designed**: GoClaw architecture + 5-phase roadmap = this solution is already validated in docs
- **Industry-convergent**: Anthropic's reference implementation uses exactly this pattern (Docker + Xvfb + noVNC + MCP)
- **Incrementally buildable**: Phase 1 (just MCP config) delivers value in days, not weeks

**What costs the 2 points:**
1. **YAGNI concern on vision path** (-0.5): The vision fallback for native apps may never be needed for 90%+ of developer agent workloads. Building it prematurely violates YAGNI. Phase 4 should be deferred until concrete demand.
2. **Accessibility tree token costs are higher than advertised** (-0.5): The "$0.01/action" claim is wrong — real cost is $0.03-0.06. Still good, but oversold. Consider Playwright CLI hybrid for token-sensitive workloads.
3. **Container management is real work** (-0.5): ~500-800 lines of lifecycle code, port management, health checks. Not trivial, though GoClaw designs mitigate this.
4. **XFCE is overkill** (-0.5): Fluxbox or openbox saves 200 MB and reduces attack surface. XFCE is a bad default for a headless agent workspace.

### Comparative Rankings

| Architecture                          | Score | Best For                      |
|---------------------------------------|-------|-------------------------------|
| **Hybrid Docker + MCP (proposed)**    | **8/10** | Full-stack dev agents         |
| Pure MCP-only (no container)          | 5/10  | Browser-only lightweight tasks|
| Pure Docker + Xvfb (no MCP)           | 6/10  | Native app-heavy workflows    |
| E2B microVMs                          | 7/10  | Multi-tenant untrusted agents |

### Bottom Line

**Build it in phases. Start with Phase 1 (Playwright MCP config — 1 day of work). This delivers 80% of the value immediately. Containerize in Phase 2-3 only when isolation is concretely needed. Defer vision fallback (Phase 4) until a real use case demands it.**

The architecture is correct. The execution order matters more than the design.

---

## 10. Next Steps

- [ ] Validate Phase 1: Add `@playwright/mcp` to a test agent's MCP config
- [ ] Benchmark: Measure actual token costs on Claw'd's target web tasks
- [ ] Prototype: Build minimal Docker image with fluxbox (not XFCE) + Playwright MCP
- [ ] Design: Container manager API (spawn, destroy, health, port allocation)
- [ ] Decide: Is Phase 4 (vision fallback) needed based on real agent task analysis?
