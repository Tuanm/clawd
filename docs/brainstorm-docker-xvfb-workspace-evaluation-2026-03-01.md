# Docker + Xvfb + xdotool + noVNC — Agent Desktop Workspace Evaluation

**Date:** 2026-03-01
**Status:** Evaluation Complete
**Context:** Claw'd AI platform — providing agents with full desktop environments

---

## Problem Statement

Claw'd agents need **full working environments** (like a PC) where they control mouse, keyboard, and screen — like a real human completing tasks. The evaluated approach: Docker container running Ubuntu + Xvfb (virtual X11) + lightweight WM + xdotool (mouse/keyboard) + scrot (screenshots) + noVNC (human monitoring). Agent takes screenshots → sends to vision model → gets action plan → executes via xdotool.

---

## Architecture Under Evaluation

```
┌─── Docker Container (Ubuntu) ────────────────────────┐
│                                                       │
│  ┌─ Xvfb ─────────────────────────────────────────┐  │
│  │  Virtual X11 Display (:99)                      │  │
│  │  ┌─────────────────────────────────────────┐    │  │
│  │  │  Fluxbox/XFCE Window Manager            │    │  │
│  │  │  ┌─────────┐ ┌──────────┐ ┌──────────┐  │    │  │
│  │  │  │ Browser  │ │ Terminal │ │ IDE/App  │  │    │  │
│  │  │  └─────────┘ └──────────┘ └──────────┘  │    │  │
│  │  └─────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ┌─ Control Layer ─────────────────────────────────┐  │
│  │  xdotool (mouse/keyboard)                       │  │
│  │  scrot (screenshots)                            │  │
│  │  x11vnc → noVNC (human monitoring @ :6080)      │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ┌─ Agent Bridge ──────────────────────────────────┐  │
│  │  MCP Server exposing tools:                     │  │
│  │  • screenshot() → base64 PNG                    │  │
│  │  • click(x, y) → xdotool                       │  │
│  │  • type(text) → xdotool                        │  │
│  │  • keypress(keys) → xdotool                    │  │
│  │  • scroll(direction) → xdotool                 │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
         ↑                              ↑
    Claw'd Agent                   Human via browser
    (MCP client)                   (noVNC @ :6080)
```

### The Action Loop

```
Agent receives task
    ↓
screenshot() → base64 PNG (~100-300KB)
    ↓
Send to vision model (Claude/GPT-4V) with prompt:
  "Here is the current screen. To accomplish X, what action should I take?"
    ↓
Model returns: { action: "click", x: 542, y: 318 }
    ↓
xdotool mousemove 542 318 && xdotool click 1
    ↓
Wait 500-2000ms for UI response
    ↓
screenshot() again → verify result
    ↓
Repeat until task complete (typically 10-200 actions)
```

---

## PROS — Argued with Evidence

### 1. Startup Time & Resource Efficiency ✅

**Argument:** Xvfb + Fluxbox is shockingly lightweight.

| Component | RAM (idle) | CPU | Notes |
|-----------|-----------|-----|-------|
| Xvfb (1280×800×24) | 20-50 MB | ~0% | Just a framebuffer in RAM |
| Fluxbox WM | 5-10 MB | ~0% | Minimal window manager |
| x11vnc + noVNC | 10-20 MB | ~0% idle | Only active when human watches |
| Docker overhead | 3-5 MB | negligible | Shared kernel, no VM |
| **Base total** | **~40-85 MB** | **~0%** | **Before launching any apps** |

Cold start: Docker container with Xvfb boots in **2-5 seconds**. That's fast enough for on-demand workspace provisioning. Pre-built images with warm caching bring this under 1 second.

**Verdict:** Excellent. The base environment is cheaper than a browser tab. The real cost comes from what you run *inside* (Chrome alone is 200-500MB).

---

### 2. Perfect Isolation Quality ✅

**Argument:** Docker provides filesystem, process, and network namespace isolation by default.

- Each container gets its own filesystem, PID namespace, network stack
- Agent A cannot see Agent B's screen, files, or processes
- Resource limits via cgroups: cap CPU, RAM, disk I/O per container
- Read-only rootfs possible: agent can trash its own workspace, host is untouched
- No GPU/hardware passthrough needed (Xvfb is pure software)

**Counterargument addressed:** "Docker shares the host kernel — a kernel exploit could escape." True, but:
- Claw'd agents run LLM-directed xdotool commands, not arbitrary kernel exploits
- Add `--security-opt=no-new-privileges`, drop all capabilities, use AppArmor/seccomp profiles
- For paranoid mode: swap Docker runtime for gVisor (`runsc`) — same Docker API, syscall-filtered kernel — at ~5-15% performance cost
- Full VM isolation (Kata/Firecracker) is overkill for this use case unless running truly adversarial untrusted code

**Verdict:** Good enough for production with hardened profiles. Upgradeable to gVisor/Kata if threat model demands it.

---

### 3. MCP Integration — Natural Fit ✅

**Argument:** This architecture maps perfectly to Claw'd's existing MCP tool model.

Claw'd agents already consume tools via MCP (stdio or HTTP transport). The desktop container exposes an MCP server with ~5 tools:

```typescript
// Tools exposed via MCP from the container
tools: [
  { name: "screenshot",  description: "Capture current screen state" },
  { name: "click",       description: "Click at (x,y) coordinates" },
  { name: "type_text",   description: "Type text via keyboard" },
  { name: "key_press",   description: "Press key combination (e.g., ctrl+s)" },
  { name: "scroll",      description: "Scroll up/down at position" },
  { name: "mouse_move",  description: "Move mouse to (x,y)" },
]
```

The agent doesn't need to know it's controlling a Docker container. It just calls MCP tools like any other. This is the same pattern as Playwright MCP, git tools, or file operations — unified tool interface.

**Verdict:** Seamless integration. Zero architectural friction with Claw'd.

---

### 4. Universal Software Compatibility ✅

**Argument:** If it runs on Ubuntu, it runs in this container. Period.

| Category | Examples | Works? |
|----------|----------|--------|
| Browsers | Chrome, Firefox, Chromium | ✅ Full GUI |
| IDEs | VS Code, IntelliJ, Sublime | ✅ Full GUI |
| Terminal apps | bash, vim, htop, tmux | ✅ |
| Office | LibreOffice | ✅ |
| Design | GIMP, Inkscape | ✅ |
| Custom apps | Any .deb, .AppImage, snap | ✅ |
| CLI tools | git, docker, kubectl, aws-cli | ✅ |
| Programming | Python, Node.js, Go, Rust, Java | ✅ |

This is the *only* approach that truly gives agents "a full PC." API-based tools (Playwright, Selenium) only work for browsers. xdotool works for **everything with a GUI**.

**Verdict:** Unmatched universality. This is the strongest pro.

---

### 5. Multi-Agent Scaling ✅

**Argument:** Containers are designed for horizontal scaling.

```bash
# Spin up 10 agent workspaces in parallel
for i in $(seq 1 10); do
  docker run -d --name agent-$i \
    --memory=2g --cpus=1 \
    -p $((6080+$i)):6080 \
    clawd-workspace:latest
done
```

| Agents | RAM (base) | RAM (with browser) | CPUs | Feasible on... |
|--------|-----------|-------------------|------|----------------|
| 1 | ~80 MB | ~500 MB | 0.5 | Laptop |
| 5 | ~400 MB | ~2.5 GB | 2.5 | Laptop |
| 10 | ~800 MB | ~5 GB | 5 | Workstation |
| 50 | ~4 GB | ~25 GB | 25 | Cloud VM (32-core) |
| 100 | ~8 GB | ~50 GB | 50 | Cloud cluster |

Docker Compose or Kubernetes handles orchestration. Each agent gets an independent DISPLAY and VNC port. No interference.

**Verdict:** Scales linearly. Resource-predictable. Well within modern hardware capabilities for 10-50 concurrent agents.

---

### 6. Human Observability via noVNC ✅

**Argument:** noVNC provides real-time, zero-install monitoring through any browser.

- Human opens `http://host:6080` → sees exactly what the agent sees
- Can watch the agent work in real-time (debugging, demos, trust-building)
- Optional: allow human to take over mouse/keyboard (pair programming with AI)
- Multiple observers can connect simultaneously
- No VNC client install needed — pure HTML5/WebSocket

This is a **killer feature** for trust and debugging. You can literally watch your AI agent click through a UI and catch mistakes in real-time.

**Verdict:** Enormous UX value. No other approach offers this level of observability.

---

## CONS — Brutally Honest Assessment

### 1. Screenshot-Based Vision: The Cost Elephant 🔴

**This is the #1 weakness of the entire approach.**

**The math:**
- Each screenshot (1280×800, JPEG quality 80): ~100-200KB → ~130-260K tokens as base64
- Vision model API cost per screenshot: **~$0.01-0.05** (Haiku/mini) to **~$0.10-0.20** (Sonnet/GPT-4o)
- A typical task (e.g., "fill out this web form") requires **30-100 actions**
- Each action = 1 screenshot + 1 LLM call (minimum; often 2 screenshots for verify)

| Metric | Screenshot + Vision | Accessibility Tree (text) |
|--------|-------------------|--------------------------|
| Data per action | 100-200 KB (image) | 0.5-2 KB (text) |
| Cost per action | $0.01-0.15 | $0.001-0.01 |
| Cost per 100-action task | $1-15 | $0.10-1.00 |
| Accuracy | 60-75% | 81-90%+ |
| Latency per action | 2-5 seconds | 0.5-1 second |

**At scale:** 10 agents × 10 tasks/day × 100 actions/task = 10,000 vision calls/day = **$100-1,500/day** on vision API alone.

**Mitigation strategies:**
- Use cheaper vision models (Claude Haiku, GPT-4o-mini) for routine screenshots
- Cache UI state: don't re-screenshot if action was keyboard-only
- Reduce resolution: 800×600 is often sufficient, cutting token cost ~40%
- Hybrid: use accessibility tree (AT-SPI on Linux) for known applications, fall back to vision for unknown GUIs
- Delta screenshots: only send changed regions (requires client-side diffing)

**Verdict:** Expensive but manageable with optimizations. The hybrid approach (AT-SPI + vision fallback) is the correct long-term strategy.

---

### 2. Vision Model Accuracy: The Reliability Gap 🟠

**Argument:** Vision models make coordinate errors, miss small UI elements, and hallucinate.

**Real-world failure modes:**
- **Off-by-N-pixels clicks:** Model says click (542, 318), but the button is at (548, 322). Miss.
- **Small UI elements:** Checkboxes, radio buttons, dropdown arrows — hard to hit precisely
- **OCR failures:** Misreading text in screenshots, especially with anti-aliasing or small fonts
- **Dynamic content:** Loading spinners, animations, auto-complete dropdowns — screenshot captures mid-transition
- **Modal dialogs:** Pop-ups that occlude the target element
- **State confusion:** Model doesn't remember what it clicked 3 steps ago without explicit state tracking

**Benchmarks say:** 60-75% accuracy per action. In a 50-action task, probability of completing without error: 0.75^50 = **0.00006 (0.006%)**. You *will* need error recovery.

**Mitigation:**
- Implement retry loops with verification screenshots
- Add "am I stuck?" detection: if 3 consecutive screenshots look identical, escalate
- Use accessibility tree data alongside screenshots when available (AT-SPI2 on Linux)
- Lower resolution but add visual markers (red cursor dot) to aid coordinate precision
- Implement "grid overlay" mode: overlay numbered grid on screenshot so model says "click grid cell 4B" instead of raw coordinates

**Verdict:** Serious concern. Requires robust error handling and retry logic. Not suitable for tasks requiring 100% reliability without human supervision.

---

### 3. Resource Cost at Scale: Manageable but Not Free 🟡

**Argument:** Each container with a browser needs 500MB-2GB RAM. Not terrible, but adds up.

**Detailed breakdown for a "realistic" agent workspace:**

| Component | RAM | Notes |
|-----------|-----|-------|
| Ubuntu base + Xvfb + WM | 80 MB | Fixed overhead |
| Chromium (3 tabs) | 300-600 MB | Main memory consumer |
| VS Code (open project) | 200-400 MB | If doing dev tasks |
| Node.js / Python runtime | 50-150 MB | For agent's bridge server |
| File system cache | 100-200 MB | Linux will use available RAM |
| **Realistic total** | **700 MB - 1.4 GB** | **Per agent workspace** |

**10 agents = 7-14 GB RAM.** A 32GB workstation handles this. A 64GB cloud VM handles 30-40 agents comfortably.

**Comparison to alternatives:**
- E2B cloud sandbox: ~$0.10/hour per sandbox (you pay for their infra)
- Self-hosted Docker: ~$0.01-0.03/hour per container (your own hardware amortized)
- Bare metal (no container): $0/overhead, but no isolation

**Verdict:** Acceptable. RAM is cheap. The vision API cost (Con #1) dwarfs the container cost by 10-100x.

---

### 4. No Native Accessibility Tree — Pure Pixel Control 🟠

**Argument:** Linux *does* have an accessibility framework (AT-SPI2), but it's underutilized and unreliable compared to Windows UI Automation or macOS Accessibility.

**The reality:**
- AT-SPI2 exists on Linux and works with GTK/Qt apps
- Chromium/Firefox expose accessibility trees via AT-SPI2
- BUT: many Linux apps have incomplete or broken AT-SPI support
- Electron apps (VS Code, Slack) have varying AT-SPI quality
- There's no universal "inspect any element" like Windows Inspect.exe

**What this means:**
- For **browser automation**: Use Playwright MCP instead (DOM access, 100% accurate, $0.001/action). Don't waste vision tokens on web pages.
- For **terminal automation**: Parse terminal output as text (already available via bash). Don't screenshot a terminal.
- For **native GUI apps**: Vision is the only option. This is where this approach shines — and where the cost is justified.

**Verdict:** Not a dealbreaker. The correct architecture is *layered*: Playwright for web, bash for CLI, vision+xdotool only for native GUI apps that can't be controlled any other way.

---

### 5. X11-Only (No Wayland) — Non-Issue Inside Docker 🟢

**Argument:** xdotool requires X11. Wayland doesn't expose the same low-level input injection APIs.

**Why this doesn't matter:**
- Inside Docker, **you control the display server**. You install Xvfb. Period.
- There is no "Wayland migration" pressure inside a container — it's your controlled environment
- The host system can run Wayland, macOS, Windows — doesn't matter, the container runs X11
- If Wayland becomes necessary in the future (e.g., for hardware acceleration), `ydotool` is the Wayland equivalent

**The only scenario where this matters:** If you wanted to control the *host* desktop directly (not containerized). But that's explicitly out of scope — the whole point is isolation.

**Verdict:** Complete non-issue. This concern evaporates inside Docker.

---

### 6. Docker Daemon Requirement — Manageable Concern 🟡

**Argument:** Docker daemon runs as root and represents an attack surface.

**The concerns:**
- Docker daemon (`dockerd`) runs as root by default
- Any user with Docker socket access can effectively become root on the host
- Docker-in-Docker (DinD) scenarios get complicated

**Mitigations:**
- **Rootless Docker**: Run Docker daemon as non-root user (available since Docker 20.10). Reduces attack surface significantly.
- **Podman**: Drop-in Docker replacement that is daemonless and rootless by default. Same OCI images, same CLI.
- **Socket protection**: Never expose Docker socket to containers. Use Docker API with TLS.
- Claw'd already blocks `.docker` directory in its sandbox (`src/api/agents.ts`) — shows awareness of this risk.

**For cloud deployment:** Use managed container runtimes (AWS Fargate, GCP Cloud Run) — no daemon to manage.

**Verdict:** Solvable problem. Rootless Docker or Podman eliminates most concerns. Not a blocker.

---

### 7. File Sharing Between Container and Host 🟡

**Argument:** Agents need to read/write files that persist beyond container lifetime.

**Options:**

| Method | Pros | Cons |
|--------|------|------|
| Docker volumes (`-v /host:/container`) | Fast, native FS performance | Permissions can be tricky |
| Docker named volumes | Managed by Docker, portable | Slightly less convenient |
| `docker cp` | On-demand, explicit | Manual, not real-time |
| Shared network storage (NFS/S3) | Multi-container access | Latency, complexity |
| MCP file tools | Already in Claw'd architecture | Another abstraction layer |

**Recommended approach for Claw'd:**
```bash
docker run -v /clawd/workspaces/agent-1:/home/agent/workspace clawd-desktop
```
- Mount a per-agent workspace directory
- Agent writes files to `/home/agent/workspace/` → appears on host
- Claw'd's existing file tools can read/write the same directory
- SQLite DB stays on host, not in container

**Verdict:** Solved problem. Docker volumes work perfectly. The MCP bridge can also expose file operations directly.

---

### 8. Network Isolation vs. Internet Access 🟡

**Argument:** Agents need internet (to browse, download, use APIs) but shouldn't access internal infrastructure.

**Docker network modes:**

| Mode | Internet | Host access | Agent-to-agent | Use case |
|------|----------|-------------|----------------|----------|
| `bridge` (default) | ✅ via NAT | ❌ by default | ✅ same network | Standard |
| `host` | ✅ | ✅ (dangerous!) | N/A | Never for agents |
| Custom bridge | ✅ configurable | ❌ | ✅ configurable | Recommended |
| `none` | ❌ | ❌ | ❌ | Air-gapped tasks |

**Recommended:**
```bash
# Create isolated network
docker network create --internal agent-net

# Agent with internet but no host access
docker run --network agent-net \
  --add-host=host.docker.internal:host-gateway \
  clawd-desktop
```

Add egress firewall rules via iptables to restrict outbound traffic (e.g., only allow HTTPS, block SSH to internal IPs).

**Verdict:** Fine-grained control available. Docker networking is mature and well-understood.

---

## Comparative Analysis: Alternatives Considered

| Criterion | Docker+Xvfb (evaluated) | E2B Desktop (cloud) | Kata/Firecracker (microVM) | Playwright-only (no desktop) |
|-----------|------------------------|---------------------|---------------------------|------------------------------|
| Full desktop? | ✅ Yes | ✅ Yes | ✅ Yes | ❌ Browser only |
| Self-hosted? | ✅ Yes | ❌ Cloud only | ✅ Yes | ✅ Yes |
| Cost per agent/hr | ~$0.01-0.03 | ~$0.10 | ~$0.02-0.05 | ~$0.001 |
| Startup time | 2-5s | 5-15s | 3-8s | <1s |
| Security isolation | Good (shared kernel) | Strong (Firecracker) | Strongest (VM boundary) | N/A (no OS) |
| Setup complexity | Low | Very low (SDK) | High | Very low |
| Universal app support | ✅ Everything | ✅ Everything | ✅ Everything | ❌ Web only |
| Human observability | ✅ noVNC | ✅ VNC | ✅ VNC | ❌ No visual |
| MCP compatibility | ✅ Natural fit | 🟡 Requires adapter | ✅ Natural fit | ✅ Native MCP |
| Claw'd readiness | Medium (build image) | Low (API integration) | High (complex setup) | High (already researched) |

---

## Recommended Solution: Layered Architecture

The Docker+Xvfb approach should NOT be the *only* control mechanism. It should be the **last resort** in a layered stack:

```
Priority 1: Direct API/CLI tools (bash, git, file ops)
  → Already in Claw'd. $0/action. 100% accurate. Use for ALL CLI tasks.

Priority 2: Playwright MCP (browser automation)
  → DOM-based, $0.001/action, 90%+ accurate. Use for ALL web tasks.

Priority 3: AT-SPI2 accessibility tree (Linux native GUI)
  → Text-based, $0.01/action, 80%+ accurate. Use for GTK/Qt apps.

Priority 4: Docker+Xvfb+Vision (full desktop control)  ← THIS EVALUATION
  → Screenshot-based, $0.05-0.15/action, 60-75% accurate.
  → Use ONLY when priorities 1-3 cannot handle the task.
  → Examples: proprietary GUI apps, visual verification, drag-and-drop,
    multi-window workflows, testing how a real user would experience the UI.
```

**This layered approach cuts vision API costs by 80-90%** while retaining universal capability.

---

## Final Verdict

### Score: 7/10

**Why not higher:**
- Vision cost ($0.05-0.15/action) makes this expensive as a primary control method (-1.5)
- 60-75% per-action accuracy requires robust retry logic and human fallback (-1)
- Added infrastructure complexity (Docker images, VNC, display management) (-0.5)

**Why not lower:**
- Only approach that gives agents a truly universal "full PC" environment (+2)
- Perfect MCP integration with Claw'd's existing architecture (+1)
- Excellent human observability via noVNC (+1)
- Proven pattern (Anthropic's computer-use-demo, E2B Desktop) — not experimental (+1)
- Reasonable resource cost (~500MB-1.5GB/agent) (+0.5)
- Claw'd's research doc already recommends this for Phase 4 — aligns with roadmap (+0.5)
- X11/Wayland concern is a non-issue inside Docker (+0.5)

### Bottom Line

**Docker+Xvfb+xdotool+noVNC is the RIGHT solution for Claw'd's desktop control layer** — but it must be deployed as **Priority 4** in a layered architecture, not as the primary control mechanism. The vision cost and accuracy limitations are real but acceptable when:

1. You use it only for tasks that *require* visual desktop control
2. You implement the layered fallback (CLI → Playwright → AT-SPI → Vision)
3. You add retry/verification logic for the screenshot→action loop
4. You use cost-optimized vision models (Haiku/mini) for routine screenshots

**For Claw'd specifically:** The existing MCP architecture makes this a natural extension. Build a `clawd-desktop` Docker image, expose 5-6 MCP tools, and agents gain desktop superpowers without any changes to the core platform.

---

## Implementation Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Vision API costs spiral | High | High | Layered architecture, model tiering, caching |
| Agent gets stuck in UI loop | High | Medium | "Stuck" detection, max-action limits, human escalation |
| Docker security escape | Very Low | Critical | gVisor runtime, rootless mode, seccomp profiles |
| Container sprawl (orphaned) | Medium | Low | TTL on containers, cleanup cron, resource limits |
| Screenshot latency causes timing issues | Medium | Medium | Configurable wait times, UI-ready detection heuristics |

---

## Next Steps

1. **Immediate:** Deploy Playwright MCP (Phase 1 from Claw'd research doc) — covers 70% of desktop needs with zero vision cost
2. **Short-term:** Build `clawd-desktop` Docker image with Xvfb+Fluxbox+xdotool+noVNC
3. **Medium-term:** Create MCP server inside container exposing screenshot/click/type tools
4. **Long-term:** Implement hybrid AT-SPI + vision approach for native GUI apps
5. **Future:** Evaluate Firecracker/Kata upgrade path if security requirements tighten
