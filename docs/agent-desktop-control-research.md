# Agent Desktop & Browser Control Research

> Research on technologies enabling Claw'd agents to control user browsers, desktops, and collaborate visually with users. Final target: agents freely work on the host machine.

---

## Table of Contents

1. [How Antigravity Handles Browser Control](#1-antigravity-browser-control)
2. [Browser Automation Technologies](#2-browser-automation-technologies)
3. [Desktop Control Technologies](#3-desktop-control-technologies)
4. [Screen Sharing / Vision-Based Approaches](#4-screen-sharing--vision-based-approaches)
5. [MCP-Based Desktop/Browser Control Servers](#5-mcp-based-desktopbrowser-control-servers)
6. [Feasibility Analysis for Claw'd](#6-feasibility-analysis-for-clawd)
7. [Recommended Architecture](#7-recommended-architecture)
8. [Security Considerations](#8-security-considerations)
9. [Implementation Roadmap (Initial)](#9-implementation-roadmap-initial)
10. [Solution Evaluation & Final Decision](#10-solution-evaluation--final-decision)
11. [Detailed Implementation Plan](#11-detailed-implementation-plan)
12. [Gap Analysis: "Human at a PC" Capability](#12-gap-analysis-human-at-a-pc-capability)
13. [Revised Architecture: Unified Workspace MCP Server](#13-revised-architecture-unified-workspace-mcp-server)

---

## 1. Antigravity Browser Control

Google Antigravity is an agent-first IDE that provides built-in browser control for AI agents to debug web applications in real time.

### How It Works

| Component | Description |
|-----------|-------------|
| **Browser Agent** | Agents launch/interact with a built-in or remote Chrome browser |
| **Actions** | Navigate, click, type, submit forms, capture screenshots, record sessions |
| **Closed-loop Validation** | Agents verify their code changes by running them in the browser, detecting errors, and auto-fixing |
| **Mission Control** | "Manager" spawns multiple agents (frontend, backend, test) working in parallel |
| **Artifacts** | Plans, diffs, test results, screenshots, and browser recordings for async review |
| **Autonomy Levels** | Agent-assisted (human review) → fully autonomous (iterate without pausing) |

### Key Takeaways for Claw'd

- **Tight integration**: Browser control is NOT a separate tool — it's woven into the development loop (code → run → verify → fix)
- **Multi-agent orchestration**: One agent codes backend, another handles UI, a third runs browser tests — all simultaneously
- **Artifact-driven review**: Screenshots and recordings serve as "proof of work" — agents don't just claim success, they demonstrate it
- **Model flexibility**: Works with Gemini 3, Claude Sonnet, OpenAI — not locked to one model

### Applicable Patterns

1. **Closed-loop development**: Agent makes a code change → launches browser → verifies visually → iterates if broken
2. **Evidence-based debugging**: Screenshots + console logs + network traces = agent understands the full picture
3. **Configurable autonomy**: User chooses how much control to retain

---

## 2. Browser Automation Technologies

### 2.1 Playwright MCP Server (Microsoft)

The most relevant technology for Claw'd's MCP-native architecture.

| Feature | Detail |
|---------|--------|
| **Protocol** | MCP (Model Context Protocol) — native to Claw'd |
| **Engine** | Playwright (Chromium, Firefox, WebKit) |
| **No Vision Required** | Uses accessibility tree (structured DOM), NOT screenshots |
| **Token Efficiency** | Transmits structured data, not pixel dumps — fits agent context windows |
| **Multi-client** | Multiple agents can share one browser session |
| **Setup** | `npx @playwright/mcp@latest` — single command |
| **Scalability** | Tested up to 10,000+ concurrent AI agents |

**Integration with Claw'd**: Since Claw'd already supports `mcp_servers` in config, Playwright MCP can be added with zero code changes:

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

**Why Accessibility Tree > Screenshots**:
- Structured: buttons, inputs, links are labeled with roles and names
- Deterministic: no coordinate guessing, no OCR errors
- Token-efficient: a page snapshot is ~2KB text vs ~500KB screenshot
- Robust: works even if CSS changes, themes switch, or layout reflows

### 2.2 Chrome DevTools MCP Server

Official Google Chrome team project for AI-driven browser debugging.

| Feature | Detail |
|---------|--------|
| **Protocol** | MCP (wraps Chrome DevTools Protocol) |
| **Capabilities** | DOM/CSS inspection, network monitoring, console logs, performance tracing |
| **Use Case** | Deep debugging (Core Web Vitals, JS profiling, CORS errors) |
| **Setup** | npm package, connects to local Chrome |

**Best for**: When agents need to debug beyond UI interaction — network issues, performance bottlenecks, JavaScript errors. Complements Playwright MCP.

### 2.3 Browserbase / Stagehand (Cloud-Hosted)

Cloud-native headless browser infrastructure for AI agents.

| Feature | Detail |
|---------|--------|
| **Model** | Cloud-hosted browser fleet (no local browser needed) |
| **Stagehand SDK** | AI-native: combine code instructions + natural language prompts |
| **Anti-bot** | CAPTCHA solving, proxy rotation, fingerprinting |
| **Self-healing** | Adapts when DOM changes break selectors |
| **Compliance** | SOC-2, HIPAA |

**Best for**: When Claw'd agents need to interact with external websites (not just localhost dev servers). Pay-per-session pricing.

### 2.4 Comparison Matrix

| Technology | Protocol | Vision Needed | Local/Cloud | Token Cost | Best For |
|-----------|----------|---------------|-------------|------------|----------|
| Playwright MCP | MCP | No (a11y tree) | Local | Low | Web app testing, form automation |
| Chrome DevTools MCP | MCP | No (structured) | Local | Low | Deep debugging, performance |
| Browserbase/Stagehand | API | Optional | Cloud | Medium | External sites, anti-bot |
| Puppeteer (raw) | CDP | Screenshot | Local | High | Legacy, pixel-level control |

### 2.5 Browser Extensions, Dialogs & Toolbar Interaction

An important gap: how can agents interact with browser chrome (not page content)?

| Scenario | Playwright MCP | Chrome DevTools MCP | Vision-based |
|----------|---------------|-------------------|-------------|
| **JS alerts/confirms/prompts** | ✅ `dialog.accept()` / `dialog.dismiss()` | ❌ Not supported | ✅ Screenshot → click |
| **Permission dialogs** (camera, location) | ✅ `browserContext.grantPermissions()` | ❌ | ⚠️ Unreliable |
| **File upload dialogs** | ✅ `setInputFiles()` (bypass native dialog) | ❌ | ❌ OS-native, hard to automate |
| **Browser extensions** | ⚠️ Load via `--load-extension` flag | ⚠️ Extension debugging via CDP | ✅ Can click extension icons |
| **Extension popups/modals** | ❌ Not accessible via page automation | ⚠️ Partial via CDP targets | ✅ Screenshot → click |
| **Download dialogs** | ✅ Auto-accept via download path config | ❌ | ⚠️ Unreliable |
| **Auth popups (OAuth)** | ✅ Handle as new page/popup | ✅ Track network flow | ✅ Can interact visually |

**Key Findings**:
- **Playwright handles most dialogs programmatically** — JS alerts, permissions, file uploads all have API support
- **Browser extension interaction is the hardest** — extensions run in separate contexts with their own popup/background pages
- **Workaround for extensions**: Load extensions via `--load-extension` flag, then interact with their popup via CDP `chrome.debugger` or fall back to vision-based clicking
- **Best hybrid approach**: Use Playwright for page-level automation + vision (read_image + desktop MCP screenshot) for browser chrome elements that Playwright can't reach

---

## 3. Desktop Control Technologies

### 3.1 Anthropic Computer Use (Claude API)

The most mature AI desktop control solution.

| Feature | Detail |
|---------|--------|
| **How It Works** | Claude receives screenshots → analyzes UI → sends mouse/keyboard commands |
| **Scope** | ANY GUI application (browsers, IDEs, creative suites, legacy software) |
| **Actions** | Mouse move/click/drag, keyboard type/shortcuts, scroll, zoom |
| **Adaptation** | Self-corrects when UI changes (buttons move, popups appear) |
| **API** | `computer-use-2025-11-24` beta header |
| **Benchmark** | 61%+ on OSWorld (state-of-the-art) |

**Architecture**:
```
Agent → Screenshot(desktop) → Claude Vision → Action plan
  → execute(mouse_move(x,y)) → execute(click()) → Screenshot(result)
  → Verify → Next action or complete
```

**Critical Requirement**: Must run in sandboxed VM/container. Claude can see EVERYTHING on screen (passwords, secrets, personal data).

### 3.2 OpenAI Computer-Using Agent (CUA) / Operator

| Feature | Detail |
|---------|--------|
| **How It Works** | GPT-4o vision + virtual browser/desktop |
| **Operator** | Consumer product — AI completes web tasks autonomously |
| **CUA API** | Developer API for programmatic desktop control |
| **Security** | Runs in secure virtual browser (sandboxed by default) |

### 3.3 Linux Desktop Automation (Native Tools)

Tools available on most Linux systems for programmatic desktop control:

| Tool | Display | Capabilities | Root? |
|------|---------|-------------|-------|
| **xdotool** | X11 only | Mouse, keyboard, window management | No |
| **ydotool** | X11 + Wayland | Mouse, keyboard (uinput subsystem) | Yes |
| **xdg-open** | Both | Open files/URLs with default apps | No |
| **scrot/grim** | X11/Wayland | Screenshots | No |
| **wmctrl** | X11 | Window activate/resize/position | No |
| **xclip/wl-clipboard** | X11/Wayland | Clipboard read/write | No |
| **pyautogui** | X11 (+ Wayland partial) | Python: mouse, keyboard, screenshot, image matching | No |
| **SikuliX** | X11 | Image-based automation (find UI by screenshot) | No |

> **Note**: Table focuses on low-level system tools available without Python/Java. PyAutoGUI and SikuliX require runtimes but are commonly used for desktop automation.

**Headless Setup (Docker/CI)**:
```
Xvfb → Virtual X11 display
  + fluxbox → Lightweight window manager
  + x11vnc → VNC server
  + noVNC → Browser-based access (HTML5)
```

### 3.4 macOS Desktop Automation

| Tool | Capabilities |
|------|-------------|
| **osascript/AppleScript** | App automation, UI scripting, dialogs |
| **Automator** | Visual workflow builder |
| **Accessibility API** | Programmatic UI element access |
| **screencapture** | Built-in screenshot tool |
| **cliclick** | Mouse/keyboard control from CLI |

### 3.5 MCP Desktop Control Servers (Existing)

Production-ready MCP servers for desktop automation:

| Server | Platform | Language | Features |
|--------|----------|----------|----------|
| **mcp-desktop-pro** | Win/Mac/Linux | TypeScript | Mouse, keyboard, window mgmt, screenshot, Retina |
| **Windows-MCP** | Windows | TypeScript | Full Windows GUI automation, PowerShell, registry |
| **computer-control-mcp** | Cross-platform | Python | PyAutoGUI, OCR, GPU screenshots |
| **kwin-mcp** | Linux (KDE) | Python | Mouse, keyboard, touch, a11y tree, screenshots, isolated sessions |

---

## 4. Screen Sharing / Vision-Based Approaches

### 4.1 WebRTC Screen Sharing

Real-time screen sharing from user's browser to agent's vision model.

**How It Works**:
```
User Browser → getDisplayMedia() → WebRTC stream
  → Server captures frames → AI vision model analyzes
  → Agent sends back guidance or actions
```

**Pros**:
- Works on any OS (browser-native API)
- User explicitly grants permission (consent-first)
- Low latency (~100-300ms frame-to-frame)
- No software installation beyond the browser

**Cons**:
- Read-only by default — agent can SEE but not CONTROL
- Requires continuous frame processing (expensive vision API calls)
- High bandwidth consumption
- Privacy concerns (agent sees everything on shared screen)

### 4.2 Microsoft Copilot Vision

- Scans entire desktop in real-time
- Provides contextual AI help based on what's visible
- Field masking for privacy
- Tight integration with Windows ecosystem

### 4.3 Aura AI Remote Desktop

Open-source project: AI agent with grid-precise remote desktop control.

```
AI Vision Model → Parse screen → Grid overlay
  → Select grid cell → Execute mouse/keyboard action
  → Capture result → Repeat
```

### 4.4 Docker + noVNC (Sandboxed Desktop)

Best approach for **safe, sandboxed agent desktop control**:

```dockerfile
# Minimal agent desktop
FROM ubuntu:22.04
RUN apt-get install -y xvfb fluxbox x11vnc novnc
# Xvfb :99 → x11vnc → noVNC on port 6080
# Agent controls via xdotool + screenshots
# Human monitors via browser at http://host:6080
```

**Architecture**:
```
Docker Container:
  ├── Xvfb :99 (virtual display 1920x1080)
  ├── fluxbox (window manager)
  ├── x11vnc → noVNC (human monitoring at :6080)
  ├── Target app (browser, IDE, etc.)
  └── Agent controller:
      ├── xdotool (mouse/keyboard)
      ├── scrot (screenshots)
      └── → AI vision model → action decisions
```

**Why This Is Ideal**:
- Strong isolation — container boundary limits agent access (see Docker hardening in Section 8)
- Human can watch in real-time via browser
- Reproducible environment
- Works headlessly in CI/CD
- Can be reset/destroyed instantly

---

## 5. MCP-Based Desktop/Browser Control Servers

Since Claw'd already supports MCP, the most natural integration path is via MCP servers.

### Recommended MCP Server Stack

| Layer | MCP Server | Purpose |
|-------|-----------|---------|
| **Browser (Web Apps)** | `@playwright/mcp` | Navigate, click, fill, extract, test |
| **Browser (Debugging)** | `chrome-devtools-mcp` | Console, network, performance, DOM |
| **Desktop (Cross-platform)** | `mcp-desktop-pro` | Mouse, keyboard, screenshots, windows |
| **Desktop (Windows)** | `windows-mcp` | Full Windows automation |

### Integration in Claw'd Config

```json
{
  "mcp_servers": {
    "browser": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    },
    "devtools": {
      "command": "npx",
      "args": ["@anthropic-ai/chrome-devtools-mcp@latest"]
    },
    "desktop": {
      "command": "npx",
      "args": ["mcp-desktop-pro"]
    }
  }
}
```

No code changes needed — Claw'd's existing MCP client infrastructure handles discovery, tool listing, and execution.

---

## 6. Feasibility Analysis for Claw'd

### Current Claw'd Capabilities

| Capability | Status | Notes |
|-----------|--------|-------|
| MCP client (stdio + HTTP) | ✅ Exists | `src/agent/mcp/client.ts` |
| External MCP server config | ✅ Exists | `mcp_servers` in `~/.clawd/config.json` |
| Sandbox (bwrap/sandbox-exec) | ✅ Exists | Kernel-level isolation |
| Multi-agent support | ✅ Exists | Per-agent context isolation |
| Vision (image analysis) | ✅ Server-side | `read_image` MCP tool in `src/server/mcp.ts`, backed by `multimodal.ts` |
| Image generation | ✅ Server-side | `create_image` / `edit_image` MCP tools (CPA primary, Gemini fallback) |
| Browser control | ❌ Missing | No native tools |
| Desktop control | ❌ Missing | No native tools |
| Screen sharing | ❌ Missing | No WebRTC/vision loop |

### Feasibility Tiers

#### Tier 1: Browser Control via MCP (Effort: LOW, Impact: HIGH)
- **Zero code changes** — just add Playwright MCP to config
- Agent gets ~25 browser tools automatically (navigate, click, fill, screenshot, etc.)
- Works with Claw'd's existing sandbox model
- **Recommended as Phase 1**

#### Tier 2: Desktop Control via MCP (Effort: LOW-MEDIUM, Impact: HIGH)
- Add mcp-desktop-pro to config for cross-platform desktop automation
- Requires relaxing sandbox for desktop access (similar to `--yolo` mode)
- Need to document which tools require elevated access
- **Recommended as Phase 2**

#### Tier 3: Vision-Augmented Desktop Loop (Effort: MEDIUM, Impact: VERY HIGH)
- Agent takes screenshot → analyzes with read_image → plans actions → executes via desktop MCP
- Combines existing vision tools with new desktop control
- Creates closed-loop: see → think → act → verify
- **Recommended as Phase 3**

#### Tier 4: Sandboxed Docker Desktop (Effort: HIGH, Impact: VERY HIGH)
- Docker container with Xvfb + noVNC + xdotool
- Agent gets its own isolated desktop environment
- Human monitors via browser
- Requires Docker infrastructure
- **Recommended as Phase 4 (advanced users)**

#### Tier 5: Screen Sharing from User (Effort: HIGH, Impact: MEDIUM)
- WebRTC-based screen sharing from Claw'd web UI
- Agent sees user's desktop via periodic screenshots
- Read-only initially (guidance only), upgradeable to control
- Requires significant frontend work
- **Recommended as Phase 5 (future)**

### What's NOT Feasible or NOT Recommended (Today)

| Approach | Why Not |
|----------|---------|
| **Anthropic Computer Use API** | Best experience with Anthropic models; proxy support exists (LiteLLM) but model capabilities vary. Tight coupling to Claude-specific tool format. |
| **OpenAI CUA/Operator** | API available but restricted to Tier 3-5 developers; tightly coupled to OpenAI models; Claw'd's multi-provider architecture would require model-specific branching |
| **Native Wayland control** | Wayland security model deliberately prevents automation; only KWin has workaround (kwin-mcp) |
| **Cross-OS unified control** | Each OS has different automation APIs; MCP servers abstract this |

---

## 7. Recommended Architecture

### Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Claw'd Agent                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ bash/edit │  │read_image│  │ chat_*   │  (existing) │
│  └──────────┘  └──────────┘  └──────────┘             │
│  ┌──────────────────────────────────────────┐          │
│  │         MCP Client (existing)            │          │
│  └──────────┬──────────┬──────────┬─────────┘          │
└─────────────┼──────────┼──────────┼─────────────────────┘
              │          │          │
    ┌─────────▼──┐ ┌─────▼─────┐ ┌─▼──────────┐
    │ Playwright  │ │  Chrome   │ │  Desktop   │
    │ MCP Server  │ │ DevTools  │ │  MCP Pro   │
    │             │ │ MCP Server│ │            │
    │ • navigate  │ │ • console │ │ • mouse    │
    │ • click     │ │ • network │ │ • keyboard │
    │ • fill      │ │ • perf    │ │ • screenshot│
    │ • snapshot  │ │ • DOM     │ │ • windows  │
    └─────────────┘ └───────────┘ └────────────┘
```

### Vision-Augmented Closed Loop (Phase 3)

```
Agent thinks: "I need to verify the login page works"
  │
  ├─► [playwright] navigate("http://localhost:3000/login")
  ├─► [playwright] snapshot()                    → accessibility tree
  ├─► [playwright] fill("#email", "test@x.com")
  ├─► [playwright] click("button[type=submit]")
  ├─► [playwright] screenshot()                  → saves to /tmp/screenshot.png
  ├─► [read_image] analyze("/tmp/screenshot.png", "Is login successful?")
  │     → "The page shows 'Welcome, test!' indicating successful login"
  └─► Agent concludes: ✅ Login works, proceeding to next task
```

### Sandboxed Desktop Loop (Phase 4)

```
Docker Container (Xvfb + noVNC):
  │
  Agent controller:
  ├─► [desktop] screenshot()              → /tmp/desktop.png
  ├─► [read_image] analyze(screenshot)    → "Firefox is open showing Google"
  ├─► [desktop] mouse_click(400, 300)     → Click address bar
  ├─► [desktop] type("http://localhost:3000")
  ├─► [desktop] key("Return")
  ├─► [desktop] screenshot()              → Verify page loaded
  └─► [read_image] analyze(screenshot)    → "Page shows login form"
  
  Human monitors at http://host:6080 (noVNC)
```

---

## 8. Security Considerations

### Threat Model

| Threat | Risk | Mitigation |
|--------|------|------------|
| Agent accesses sensitive data on screen | HIGH | Sandboxed container (Docker/VM), no host desktop access |
| Agent clicks malicious links | MEDIUM | URL allowlisting, network isolation |
| Agent installs software | HIGH | Read-only filesystem, no sudo in container |
| Agent exfiltrates data via browser | MEDIUM | Network egress rules, proxy logging |
| Agent modifies system settings | HIGH | No root access, container isolation |
| Browser extension manipulation | LOW | Extension allowlist, controlled Chrome profile |
| **MCP server is malicious/compromised** | **HIGH** | Allowlist-only mode, code signing, run MCP servers inside bwrap sandbox |
| **Supply chain attack via npx** | **HIGH** | Pin MCP server versions, verify checksums, audit dependencies |
| **MCP server escalates privileges** | **HIGH** | Separate user context for MCP servers, capability-based security |
| **PII exposure in screenshots** | **HIGH** | Auto-delete screenshots after analysis, encrypt at rest, field masking |

### MCP Server Trust Model

> **Critical**: Currently, MCP servers run OUTSIDE the sandbox. They are spawned via `spawn()` with inherited environment (`process.env`), meaning they have full access to API keys, SSH keys, and filesystem. This is the highest-priority security gap to address.

**Current architecture** (insecure for untrusted MCP servers):
```
Claw'd (unsandboxed) → spawns MCP server (UNSANDBOXED, inherits env)
                     ↓
                     bash tool → executes in bwrap/sandbox-exec
```

**Recommended architecture**:
```
Claw'd → spawns MCP server INSIDE bwrap sandbox
           → filtered env (only necessary vars passed)
           → restricted filesystem (read-only except working dirs)
           → no network access unless explicitly allowed
```

### Sandbox Integration

Claw'd's sandbox (bwrap/sandbox-exec) wraps tool execution, NOT MCP server processes. Desktop/browser control requires careful handling:

```
MCP Server Sandbox Levels:

  Level 0 (--yolo): Full access to host desktop/browser
    → For trusted local development only
    → MCP servers still inherit full env

  Level 1 (sandbox + MCP): MCP servers run OUTSIDE sandbox (current limitation)
    → Agent tools (bash, etc.) sandboxed by bwrap
    → MCP servers have unrestricted access (trust boundary!)
    → Browser sees all paths; desktop control available if display exists
    → TODO: Wrap MCP server spawn in bwrap for untrusted servers

  Level 2 (Docker sandbox): Agent gets isolated virtual desktop
    → Full desktop control within container
    → Container isolation (not "zero host access" — see Docker hardening below)
    → Human monitoring via noVNC
```

### Docker Security Hardening

The Docker sandbox (Level 2) provides strong but NOT absolute isolation. Required hardening:

```bash
docker run \
  --security-opt=no-new-privileges \
  --cap-drop=ALL \
  --read-only \
  --tmpfs /tmp:size=512m \
  --memory=2g --cpus=2 \
  --network=none \  # or custom bridge for localhost only
  -p 6080:6080 \    # noVNC monitoring
  clawd-desktop
```

**Mandatory rules**:
- ❌ NEVER mount Docker socket (`/var/run/docker.sock`)
- ❌ NEVER use `--privileged` flag
- ❌ NEVER run container as root (use `--user 1000:1000`)
- ✅ Use seccomp/AppArmor profiles
- ✅ Pin and scan base images for vulnerabilities
- ✅ Use user namespaces (`--userns=host` or rootless Docker)
- ✅ Set cgroup resource limits (CPU, memory, PIDs)

### Privacy & Legal Compliance

Screen capture and desktop control create significant privacy obligations:

| Concern | Requirement |
|---------|-------------|
| **GDPR Article 6** | Lawful basis for processing (explicit user consent) |
| **Data minimization** | Capture only necessary screen regions, not full desktop |
| **Retention** | Auto-delete screenshots within session; never persist to disk beyond `/tmp` |
| **Right to deletion** | User can purge all captured data at any time |
| **PII redaction** | Mask passwords, credit cards, health data before sending to vision APIs |
| **Recording consent** | Screen recording features require explicit opt-in; some jurisdictions require two-party consent |
| **Employee monitoring** | Corporate use may trigger labor law notification requirements |
| **Data transfer** | Screenshots sent to cloud APIs (Gemini, CPA) cross jurisdictional boundaries |

### Principle of Least Privilege

- **Browser MCP**: Enforce via Chrome policy JSON limiting allowed domains; use `--disable-extensions` unless explicitly needed
- **Desktop MCP**: Only inside Docker container; never on host desktop unless `--yolo`. Reject file paths outside container via path validation.
- **Vision loop**: Screenshots stored in `/tmp`, encrypted if possible, auto-cleaned after analysis within same request
- **MCP servers**: Run as dedicated non-root user via `runuser` or Docker user namespaces; filtered env (pass only required vars, not full `process.env`)

---

## 9. Implementation Roadmap (Initial)

> **Note:** This was the initial 5-phase roadmap from early research. It has been superseded by the **revised 4-phase implementation plan** in [Section 11](#11-detailed-implementation-plan), which incorporates findings from the solution evaluation in [Section 10](#10-solution-evaluation--final-decision). Key differences: Phase 2 (Browser Debugging) was merged into Phase 1; Docker workspace (Phase 4 here) became Phase 2 in the revised plan.

### Phase 1: Browser Control (Minimal Effort)

**What**: Add Playwright MCP server to config template and documentation.

**Changes Required**:
- Documentation update only (config example in docs/architecture.md)
- Optional: Default MCP server suggestion in config-file.ts

**Agent Gains**:
- ~25 browser automation tools (navigate, click, fill, extract, screenshot, etc.)
- Accessibility tree snapshots (structured, token-efficient)
- Multi-tab, multi-browser support

### Phase 2: Browser Debugging

**What**: Add Chrome DevTools MCP for deep debugging.

**Changes Required**:
- Documentation update
- Optional: Helper tool to launch Chrome with `--remote-debugging-port`

**Agent Gains**:
- Console log inspection
- Network request analysis (CORS, 404s, timeouts)
- Performance tracing (Core Web Vitals)
- DOM/CSS live inspection

### Phase 3: Vision-Augmented Loop

**What**: Wire existing `read_image` tool into browser/desktop screenshot feedback loop.

**Changes Required**:
- New `screenshot_and_analyze` convenience tool in mcp.ts
- Takes screenshot via MCP → saves to /tmp → analyzes via read_image → returns text
- Combines two existing capabilities into one atomic operation

**Agent Gains**:
- Closed-loop visual verification
- "See what the user sees" capability
- Visual regression detection

### Phase 4: Desktop Control

**What**: Add desktop control MCP server support.

**Changes Required**:
- Config template for mcp-desktop-pro
- Sandbox policy adjustment: desktop MCP only in --yolo or Docker mode
- Docker compose template for sandboxed desktop (Xvfb + noVNC + xdotool)

**Agent Gains**:
- Full desktop automation (any OS application)
- Window management (open, close, resize, focus)
- Clipboard integration
- File drag-and-drop

### Phase 5: Screen Sharing (Future)

**What**: WebRTC-based screen sharing from Claw'd web UI.

**Changes Required**:
- WebRTC client in Claw'd frontend
- Frame capture server endpoint
- Periodic screenshot → read_image pipeline
- UI for granting/revoking screen access

**Agent Gains**:
- See user's actual desktop
- Provide real-time contextual guidance
- Collaborative debugging ("I see you're on the settings page, try clicking...")

---

## Key References

| Resource | URL | Relevance |
|----------|-----|-----------|
| Playwright MCP | github.com/microsoft/playwright-mcp | Browser automation via MCP |
| Chrome DevTools MCP | github.com/ChromeDevTools/chrome-devtools-mcp | Browser debugging via MCP |
| mcp-desktop-pro | github.com/lksrz/mcp-desktop-pro | Cross-platform desktop control |
| Windows-MCP | windowsmcp.io | Windows desktop automation |
| Anthropic Computer Use | platform.claude.com/docs/...computer-use-tool | Vision-based desktop control API |
| OpenAI CUA/Operator | openai.com/index/computer-using-agent/ | Desktop control agent |
| Browserbase/Stagehand | browserbase.com / stagehand.dev | Cloud browser infrastructure |
| Open-Interface | github.com/AmberSahdev/Open-Interface | Open-source LLM desktop control |
| noVNC Docker | github.com/theasp/docker-novnc | Sandboxed virtual desktop |
| ydotool | github.com/ReimuNotMoe/ydotool | X11+Wayland automation |
| Aura AI Remote Desktop | github.com/RorriMaesu/Aura-AI-Remote-Desktop | Grid-based AI desktop control |

---

## 10. Solution Evaluation & Final Decision

### 10.1 Comparative Analysis

Five candidate architectures were evaluated by independent analysis agents debating pros/cons with logical reasoning.

| # | Approach | Score | Verdict |
|---|----------|-------|---------|
| 1 | **Docker + Xvfb + xdotool + noVNC** (pure vision) | 7/10 | Right solution, wrong layer — vision-only is 10-15x more expensive than structured approaches |
| 2 | **Pure MCP on host** (Playwright + mcp-desktop-pro) | 4/10 | Security showstopper — controls HOST desktop with host privileges, no agent isolation, multi-agent collision impossible |
| 3 | **C/UA + ScreenEnv** (purpose-built platforms) | 5/10 | Right problem, wrong fit — Python runtime dependency violates Claw'd's standalone binary constraint |
| 4 | **Hybrid Docker+MCP** (MCP inside containers) | 8/10 | Best architecture — accessibility tree for web (cheap), vision fallback for native apps (universal) |
| 5 | **Pragmatic Phased** (incremental delivery) | 8/10 | Right execution order — delivers value at each phase, no "all or nothing" |

### 10.2 Winner: Hybrid Docker+MCP with Phased Rollout

The winning strategy combines the **Hybrid Docker+MCP architecture** (solution #4) with the **Pragmatic Phased execution** (solution #5). This delivers:

- **Immediate value** (Phase 1: Playwright MCP config → browser control in <1 day)
- **Full isolation** (Phase 2: each agent gets its own container)
- **Cost efficiency** (accessibility tree for web ≈ $0.016-0.06/action depending on model, vs $0.002-0.015 for vision per screenshot)
- **Universal capability** (Phase 3: vision fallback for native apps when needed)
- **Zero Claw'd core changes** (MCP servers are external — config, not code)

### 10.3 Key Arguments That Decided the Winner

**Against pure Docker+Xvfb (#1):** Vision-only control (screenshot + vision model per action) is slower and less accurate than structured approaches (accessibility tree). While per-screenshot API cost is modest ($0.002-0.015/action depending on model), the real cost comes from the retry loops needed to compensate for 60-75% accuracy — a 50-step task at 75% accuracy per step has ~0% chance of zero errors. The hybrid approach uses vision as a *last resort* (Priority 4), cutting 80-90% of vision calls and their associated retry overhead.

**Against pure MCP on host (#2):** 
- mcp-desktop-pro controls the HOST desktop with host privileges — one prompt injection gives the agent full desktop access
- One mouse cursor, one keyboard focus — two agents cannot work simultaneously
- Claw'd's bwrap/seatbelt sandbox does NOT cover MCP servers (spawned as unsandboxed subprocesses)

**Against C/UA + ScreenEnv (#3):**
- Both require Python 3.10+ runtime (pip install). Claw'd compiles to a standalone Bun binary with no external runtime dependencies
- ScreenEnv is functionally equivalent to "Docker + MCP inside" — but adds Python as a middleman
- C/UA uses Apple Virtualization.Framework (macOS only) — irrelevant for Linux servers/cloud

**For Hybrid Docker+MCP (#4+5):**
- Claw'd's MCP client (`src/agent/mcp/client.ts`) already supports HTTP transport — connecting to a container's MCP endpoint requires zero code changes
- GoClaw architecture (analyzed in Section 1 of goclaw-architecture.md) already defines Docker sandbox lifecycle patterns
- Layered control priority minimizes cost while maximizing capability

### 10.4 Layered Control Priority Model

```
Priority 1: CLI tools (bash, git, file edit)     → $0.000/action, 100% accurate, ~0.1s
Priority 2: Playwright MCP (browser a11y tree)    → $0.016-0.06/action*, 90%+ accurate, ~1s
Priority 3: AT-SPI2 (Linux native GUI a11y tree) → $0.016-0.06/action*, 80%+ accurate, ~1s
Priority 4: Vision + xdotool (screenshot-based)   → $0.002-0.015/action**, 60-75% accurate, ~3-5s

* A11y tree costs: 16K-19K tokens per page. Haiku 4.5 ($1/M) = $0.016-0.019.
  Sonnet 4 ($3/M) = $0.048-0.057. Output tokens add ~$0.005-0.045 per action.
** Vision costs per screenshot: GPT-4o (~765 tokens, $2.50/M) = $0.002.
   Claude Sonnet 4 (~1.5K-3K tokens, $3/M) = $0.005-0.009 + output.
   Note: Low per-action cost is offset by poor accuracy requiring 2-5x retries.
```

**Why a11y tree is preferred despite higher per-action cost:** While vision API cost per screenshot is lower, the accessibility tree is 90%+ accurate vs 60-75% for vision. A 20-step task with vision needs ~30-50 total actions (retries), while a11y tree needs ~22 actions. Total cost with retries: a11y tree ~$0.35-1.32 vs vision ~$0.06-0.75 but with far lower reliability. The primary advantage of a11y tree is **determinism** — it returns structured data, not pixel coordinates.

**Agent decision logic:** Always try the cheapest/fastest method first. Only escalate when the current priority cannot handle the task. The workspace MCP server auto-selects based on availability:
1. If tool supports CLI/API → Priority 1 (always)
2. If target is a web page → Priority 2 (Playwright MCP)
3. If target is a native Linux app with AT-SPI2 support → Priority 3
4. If none of the above work → Priority 4 (vision fallback)

### 10.5 Corrections Applied from Debate

| Original Claim | Correction | Source |
|---|---|---|
| "~$0.01/action for web (accessibility tree)" | **$0.016-0.06/action** depending on model — Haiku 4.5 ($1/M): $0.016-0.019, Sonnet 4 ($3/M): $0.048-0.057, for 16K-19K tokens per page snapshot | Hybrid agent, cost review |
| "~$0.10-0.30/action for vision" | **$0.002-0.015/action per screenshot** — GPT-4o: $0.002, Sonnet 4: $0.005-0.009. Higher total cost comes from retry loops (2-5x) needed due to 60-75% accuracy | Cost review agent |
| "~500 lines of code for workspace MCP server" | **~1,400+ lines** — must include X11 session management, process lifecycle, error handling, container startup | Pragmatic agent (agent-114) |
| "Use XFCE for desktop environment" | **Use fluxbox (~2MB) not XFCE (~400MB)** — agents don't need a pretty desktop, just window management | Docker agent (agent-110), Hybrid agent (agent-113) |
| "Vision fallback needed from the start" | **YAGNI** — developer tasks use CLI + browser 95% of the time; defer vision to Phase 3 when a real use case demands it | C/UA agent (agent-112), Pragmatic agent (agent-114) |
| "MCP is safe on host" | **MCP servers run OUTSIDE Claw'd's sandbox** — they inherit full `process.env` and filesystem access; must containerize for real isolation | MCP agent (agent-111) |
| "Docker image ~850 MB" | **~1.0-1.2 GB** — Ubuntu 77MB + fluxbox 2MB + X11 tools 50MB + Node.js 200MB + Playwright+Chromium 450MB + noVNC 10MB + dev tools 250MB | Accuracy review agent |

### 10.6 Resource Requirements per Agent Workspace

| Resource | Estimate | Notes |
|---|---|---|
| Docker image size | ~1.0-1.2 GB | Ubuntu minimal + fluxbox + Playwright+Chromium + Node.js + dev tools |
| Runtime RAM | ~512 MB – 1 GB | Xvfb + fluxbox + browser + MCP server |
| CPU | 0.5-1 core | Mostly idle (waiting for agent commands) |
| Disk | ~2 GB per container | Image layer + writable layer + workspace files |
| Network | Port-mapped | MCP (HTTP), noVNC (WebSocket + VNC password auth), optional SSH |
| Max concurrent (dev machine) | ~10-20 | On a 32GB/16-core host |
| Max concurrent (CI/CD free tier) | ~3-6 | GitHub Actions 7GB RAM; factor OS overhead |

---

> **Note:** The phase plan in this section has been **superseded** by the revised architecture in [Section 13](#13-revised-architecture-unified-workspace-mcp-server). Read Section 13 for the current plan. This section is preserved for historical context and detailed implementation notes that Section 13 references.

## 11. Detailed Implementation Plan

### Phase 1: Browser Control via Playwright MCP (Immediate)

**Goal:** Give Claw'd agents browser control with minimal effort.

**Effort:** Configuration + restart (~1-2 hours including testing)

**What:**
- Add Playwright MCP server to Claw'd's MCP config (`~/.clawd/config.json`)
- Agent gains: navigate, click, type, fill forms, extract text, take screenshots — all via accessibility tree
- Works with existing `MCPManager` in `src/agent/mcp/client.ts`

**Config:**
```json
{
  "mcp_servers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/playwright-mcp@latest"],
      "env": {}
    }
  }
}
```

**⚠️ Important Notes:**
- MCP servers are loaded at startup (via `clawd-chat` plugin agent.ts:474-484) — **Claw'd restart required** after config change
- No dynamic MCP server reload exists; if needed, implement `MCPManager.reloadConfig()` in future
- Pin specific version (e.g., `@anthropic-ai/playwright-mcp@0.1.0`) instead of `@latest` to avoid supply-chain risks

**Covers:** ~80% of developer browser workflow (web debugging, form filling, visual verification)

**Limitations:**
- Runs on host (no isolation) — acceptable for single-agent use only
- Browser only (no native app control)
- Requires Node.js/npx on host — a **temporary constraint violation** of Claw'd's standalone binary goal; resolved by Phase 2 (containerized)
- MCP server inherits host `process.env` (API keys, SSH keys, etc.) — see Security section

**Security note:** Playwright MCP inherits host `process.env`. This is the existing MCP trust model (see `client.ts:120` — `env: { ...process.env, ...this.env }`). For sensitive environments, wait for Phase 2 (containerized).

---

### Phase 2: Workspace Container with MCP Server

**Goal:** Give each agent an isolated workspace — its own display, filesystem, browser, terminal.

**Effort:** ~3-4 weeks (MVP quality; production-ready may take longer)

**What:**
1. Build a Docker image: `clawd-workspace`
2. Image contains: Ubuntu 24.04 minimal + fluxbox + Xvfb + Playwright MCP + xdotool + scrot + noVNC + common dev tools
3. Build a lightweight MCP server (TypeScript/Node.js, ~1,400+ lines) running inside the container
4. Claw'd spawns one container per agent task, connects via HTTP MCP transport (`MCPHttpConnection`)

**Docker Image Contents:**
```dockerfile
FROM ubuntu:24.04

# Display server + tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb fluxbox x11vnc xdotool scrot \
    novnc websockify \
    # Dev tools
    git curl wget vim nano \
    # Build tools
    build-essential python3 \
    # Node.js for MCP server (use NodeSource for consistent version)
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright + bundled Chromium (NOT apt chromium-browser which is snap in 24.04)
RUN npx -y playwright@latest install chromium \
    && npx -y playwright@latest install-deps chromium

# Install Playwright MCP server (pinned version)
RUN npm install -g @anthropic-ai/playwright-mcp@0.1.0

# Create non-root user for container security
RUN useradd -m -u 1000 -s /bin/bash agent \
    && mkdir -p /workspace \
    && chown agent:agent /workspace

# Custom workspace MCP server
COPY workspace-mcp-server/ /opt/workspace-mcp/
WORKDIR /opt/workspace-mcp
RUN npm install

# Startup script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Run as non-root
USER agent

EXPOSE 3000 6080 5900
HEALTHCHECK --interval=30s --timeout=5s CMD curl -f http://localhost:3000/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
```

**Workspace MCP Server Tools:**
| Tool | Description | Control Method |
|---|---|---|
| `screenshot` | Capture current display | scrot → base64 → save to file → return path |
| `click` | Click at coordinates | xdotool mousemove + click |
| `type_text` | Type text at current focus | xdotool type |
| `key_press` | Press key combination | xdotool key |
| `launch_app` | Start an application | subprocess |
| `list_windows` | List open windows | xdotool search + getactivewindow |
| `focus_window` | Bring window to front | xdotool windowactivate |
| `read_file` | Read file from workspace | fs.readFileSync |
| `write_file` | Write file to workspace | fs.writeFileSync |
| `run_command` | Execute shell command | child_process.exec |
| `browser_navigate` | Navigate browser (via Playwright) | Playwright MCP proxy |
| `browser_snapshot` | Get accessibility tree snapshot | Playwright MCP proxy |

**Claw'd Integration:**
```typescript
// In src/agent/workspace/container.ts (NEW)

interface WorkspaceConfig {
  image: string;           // "clawd-workspace:v1.0.0" (pinned, NOT :latest)
  ports: { mcp: number; novnc: number; vnc: number };
  volumes: string[];       // ["/path/to/project:/workspace:rw"]
  env: Record<string, string>; // Only non-sensitive env vars
}

// Port pool: MCP 6000-6099, noVNC 7000-7099, VNC 5900-5999
const PORT_POOL = { mcp: [6000, 6099], novnc: [7000, 7099], vnc: [5900, 5999] };

async function spawnWorkspace(config: WorkspaceConfig): Promise<string> {
  // 1. Check Docker daemon is running: spawn("docker", ["info"])
  // 2. Allocate ports from pool (check availability)
  // 3. Create isolated network: docker network create clawd-ws-{id}-net
  // 4. For git projects: git worktree add /tmp/clawd-ws/{id} -b agent-{id}-{ts}
  // 5. docker run -d --name clawd-ws-{id} \
  //      --user 1000:1000 --security-opt no-new-privileges \
  //      --cap-drop ALL --memory 1g --cpus 1 --pids-limit 200 \
  //      --read-only --tmpfs /tmp:size=500m \
  //      --network clawd-ws-{id}-net \
  //      -p 127.0.0.1:{mcp_port}:3000 \
  //      -p 127.0.0.1:{novnc_port}:6080 \
  //      -v {worktree_or_project}:/workspace:rw \
  //      -v ~/.clawd/config.json:/etc/clawd/config.json:ro \
  //      clawd-workspace:v1.0.0
  //    (See Section 11.5 for full security flags and Chromium sandbox notes)
  // 6. Wait for health check (max 30s)
  // Returns container ID
  // On error: graceful fallback to Phase 1 (host Playwright MCP)
}

async function connectToWorkspaceMCP(containerId: string): Promise<MCPConnection> {
  // Connect via MCPHttpConnection (already in client.ts:352-471)
  // POST-based JSON-RPC over HTTP, 30s timeout
}

async function destroyWorkspace(containerId: string): Promise<void> {
  // docker stop (10s grace) + docker rm
  // Cleanup: release port pool slots
}
```

**Error Recovery:**
- **Docker daemon not running**: Fall back to Phase 1 (host Playwright MCP), warn user
- **Container startup failure**: Retry up to 3 times with exponential backoff, then fail with actionable error
- **MCP server crash inside container**: Detect via health check failure, restart container (preserve volumes)
- **Claw'd crash**: On next startup, detect orphan containers (`docker ps --filter name=clawd-ws-`) and clean up
- **Port conflict**: Try next available port in pool; if pool exhausted, fail with "max workspaces reached"

**File Sharing:** Docker bind mounts — the project directory is mounted at `/workspace:rw` inside the container. Agent reads/writes files there; they're visible on the host. Container runs as UID 1000 to match typical host user (avoids root:root file ownership issues).

**Human Monitoring:** noVNC exposed at `http://localhost:{novnc_port}` per container (bound to `127.0.0.1` only). Protected with random VNC password generated at container startup and displayed in Claw'd logs.

**State Persistence:**
- **Project files**: On bind mount — survive container destruction
- **Build artifacts (node_modules, .next, etc.)**: Named Docker volume `clawd-ws-{id}-cache` mounted at `/workspace/.cache`
- **Agent task state**: Stored in Claw'd's session database, NOT in container
- **Container crash recovery**: Spawn new container with same volumes; agent resumes task

---

### Phase 3: Vision-Augmented Native App Control (Deferred)

**Goal:** Let agents control any native application via screenshot → vision model → action loop.

**Effort:** ~1-2 weeks (after Phase 2 is stable)

**What:**
1. Add `vision_action_loop` tool to workspace MCP server
2. Agent provides a goal ("Click the Save button in LibreOffice")
3. MCP server takes screenshot → sends to Gemini/CPA vision model → gets coordinates → executes xdotool action → retakes screenshot → verifies
4. Retry loop with "am I stuck?" detection

**When to build this:** Only when a concrete use case demands native app control that can't be handled by CLI tools or Playwright. For ~95% of developer tasks (coding, git, browser, testing), Phases 1-2 are sufficient.

**Cost mitigation:** While per-screenshot API cost is modest ($0.002-0.015/action), the retry loops needed for 60-75% accuracy make it expensive in aggregate. To minimize total cost:
- Only use vision when Playwright MCP returns "no browser available" or agent explicitly requests desktop interaction
- Cache screenshots: don't re-screenshot if no action was taken
- Use smaller screenshot resolution (1024x768 instead of 1920x1080) — reduces tokens by ~60%
- Limit retry loops to 5 attempts before escalating to human
- Use Claw'd's existing `analyzeImage()` function from `src/server/multimodal.ts` (CPA primary, Gemini fallback)

---

### Phase 4: Multi-Agent Workspace Orchestration (Future)

**Goal:** Multiple agents working simultaneously in separate workspaces on the same project.

**What:**
1. Workspace pool manager: pre-warm N containers, allocate on demand
2. Shared project volume with git-based isolation (each agent gets a branch)
3. Agent coordination: task assignment, conflict resolution, merge management
4. Resource limits: CPU/memory caps per container to prevent one agent from starving others

**Architecture:**
```
┌─────────────────────────────────────────────────────────┐
│                    Claw'd Core                          │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐          │
│  │  Agent A   │  │  Agent B   │  │  Agent C   │          │
│  │ (frontend) │  │ (backend)  │  │ (testing)  │          │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘          │
│        │               │               │                │
│  ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐          │
│  │ MCP HTTP   │  │ MCP HTTP   │  │ MCP HTTP   │          │
│  │ :3001      │  │ :3002      │  │ :3003      │          │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘          │
└────────┼───────────────┼───────────────┼────────────────┘
         │               │               │
   ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
   │ Container A│  │ Container B│  │ Container C│
   │ ┌────────┐ │  │ ┌────────┐ │  │ ┌────────┐ │
   │ │ Xvfb   │ │  │ │ Xvfb   │ │  │ │ Xvfb   │ │
   │ │fluxbox │ │  │ │fluxbox │ │  │ │fluxbox │ │
   │ │Chromium│ │  │ │Terminal │ │  │ │Chromium│ │
   │ │MCP Srv │ │  │ │MCP Srv │ │  │ │MCP Srv │ │
   │ └────────┘ │  │ └────────┘ │  │ └────────┘ │
   │ /workspace │  │ /workspace │  │ /workspace │
   │ (branch:a) │  │ (branch:b) │  │ (branch:c) │
   └────────────┘  └────────────┘  └────────────┘
         ▲               ▲               ▲
         └───────────────┼───────────────┘
                    Shared Volume
                  (host project dir)
```

**Git workspace isolation:** For Git repositories, use **git worktrees** created on the HOST (NOT inside the container, to avoid data loss on container destruction):
```bash
# On host, before starting container:
git worktree add /tmp/clawd-ws/{id} -b agent-{container_id}-{timestamp}
# Then start container with worktree as workspace:
docker run -v /tmp/clawd-ws/{id}:/workspace:rw ...
```
- Branch naming: `agent-{container_id}-{timestamp}` to prevent collisions
- Host can review worktree files at any time
- Merge back: via pull request or `git merge` after agent completes
- Force push disabled: workspace MCP server blocks `git push --force`
- Cleanup: `git worktree remove /tmp/clawd-ws/{id}` after container destruction

**Non-Git workspace isolation:** For projects that are not Git repositories (or have nested submodules):
- Host project directory mounted read-only at `/workspace-src:ro`
- Writable directories mounted as named volumes: `docker run -v clawd-ws-{id}-data:/workspace -v /path/to/project:/workspace-src:ro`
- Entrypoint creates a selective copy with rsync: `rsync -a --exclude node_modules/ --exclude .git/ /workspace-src/ /workspace/`
- For very large projects (>1GB), use Docker named volumes + selective rsync (only copy source files, let agent run `npm install` inside container)
- To apply changes: diff `/workspace` vs `/workspace-src` and copy approved files back to host
- Note: OverlayFS inside containers requires `CAP_SYS_ADMIN` (security risk); selective rsync + named volumes is preferred

---

### 11.5 Security Hardening

**Container security (Phase 2):**
```bash
docker run -d --name clawd-ws-{id} \
  --user 1000:1000 \                          # Non-root
  --security-opt no-new-privileges \           # Prevent privilege escalation
  --cap-drop ALL \                             # Drop all capabilities
  --memory 1g --cpus 1 \                       # Resource limits
  --pids-limit 200 \                           # Prevent fork bombs
  --read-only --tmpfs /tmp:size=500m \         # Minimal writable areas
  -p 127.0.0.1:{port}:3000 \                  # Localhost-only binding
  clawd-workspace:v1.0.0

# Note on Chromium sandbox: Chromium requires either CAP_SYS_ADMIN (for user
# namespaces) or kernel.unprivileged_userns_clone=1 enabled on host. Adding
# CAP_SYS_ADMIN weakens container isolation. Preferred approach:
# 1. Enable unprivileged user namespaces on host (sysctl kernel.unprivileged_userns_clone=1)
# 2. If not possible, run Chromium with --no-sandbox inside the container
#    (acceptable since the CONTAINER is the sandbox boundary, not Chromium's)
```

**Secret management:**
- API keys (GEMINI_API_KEY, CPA credentials) are NOT passed as container env vars
- VNC password is also NOT passed as env var (avoids `/proc/1/environ` leakage)
- Instead: mount `~/.clawd/config.json` as read-only at `/etc/clawd/config.json:ro`
- Workspace MCP server reads all secrets (including VNC password) from mounted config
- VNC password is auto-generated and written to a tmpfs-backed file inside the container
- Container's `/proc/1/environ` does NOT contain any secrets
- Alternative for higher security: use Docker secrets (`docker secret create`)

**MCP endpoint authentication (Phase 2+):**
- Each container's MCP HTTP endpoint requires an `Authorization: Bearer {random_token}` header
- Claw'd generates the token, passes it via the mounted config file, and includes it in all HTTP requests
- Prevents other processes on the host from connecting to the MCP endpoint
- Token is NOT in the URL path (avoids leakage in server logs, Referer headers, and stack traces)

**Network isolation:**
- Each workspace gets its own Docker bridge network: `docker network create clawd-ws-{id}-net`
- Container attached to its isolated network — prevents lateral movement between workspace containers
- Containers can still access the internet (for git clone, npm install, etc.) via NAT
- MCP port exposed only on `127.0.0.1` (not `0.0.0.0`)
- Optional hardened mode: add egress firewall rules (allowlist npm registry, GitHub, etc.)

### 11.6 Cross-Platform Considerations

**macOS (Docker Desktop):**
- Docker Desktop runs containers in a Linux VM (HyperKit or Apple Virtualization.Framework)
- File I/O performance with bind mounts is 2-10x slower than native Linux (use virtiofs, not gRPC-FUSE)
- Alternative: [OrbStack](https://orbstack.dev/) offers significantly faster Docker on macOS
- noVNC works fine through the VM layer (negligible added latency for human observation)
- xdotool works inside containers (Linux containers, not macOS containers)
- Recommendation: Use Phase 1 (host Playwright MCP) as primary on macOS; Phase 2 containers for isolation-critical tasks

**Windows:**
- Docker Desktop uses WSL2 backend; containers work but with WSL2 performance characteristics
- File sharing between Windows host and WSL2 containers is slow for non-WSL2 filesystems
- Alternative: use `windows-mcp` (windowsmcp.io) for native Windows desktop control without containers
- Recommendation: Phase 1 (Playwright MCP) works on Windows; Phase 2 containers supported but not optimized

**ARM64 (Apple Silicon, AWS Graviton):**
- Dockerfile must support multi-arch: `docker buildx build --platform linux/amd64,linux/arm64`
- All packages in Dockerfile (Xvfb, fluxbox, xdotool, Node.js, Playwright) support ARM64
- Chromium ARM64 builds available via Playwright's bundled browser
- Publish multi-arch image to registry: `ghcr.io/clawd-pilot/workspace:v1.0.0`

### 11.7 Observability & Monitoring

- **Health checks**: Docker `HEALTHCHECK` pings MCP server `/health` endpoint every 30s
- **Logs**: Capture with `docker logs clawd-ws-{id}` — forward to Claw'd UI
- **Task progress**: Workspace MCP server sends structured progress events (tool call count, last action, errors)
- **Resource monitoring**: `docker stats clawd-ws-{id}` for CPU/RAM/network per container
- **Dashboard**: Claw'd web UI shows active workspaces, their status, and noVNC links
- **Cleanup**: Automatic container removal after task completion + orphan detection on Claw'd startup

### 11.8 Image Maintenance

- **Registry**: Publish to `ghcr.io/clawd-pilot/workspace:v1.0.0` (GitHub Container Registry)
- **Versioning**: Semantic versioning; Claw'd config specifies image version
- **Updates**: `clawd workspace update` pulls latest compatible image
- **Customization**: Users can extend with custom Dockerfile (`FROM ghcr.io/clawd-pilot/workspace:v1.0.0`)
- **Security patches**: Monthly automated rebuilds with latest Ubuntu security updates
- **CI/CD testing**: GitHub Actions builds multi-arch image, runs smoke tests (spawn container → connect MCP → verify tools)

### 11.9 Cloud Deployment (Future)

For teams and CI/CD where local Docker is impractical:
- **E2B (e2b.dev)**: Serverless sandboxed environments for AI agents — fastest cold start (~200ms), but external dependency
- **Fly.io Machines**: Fast-starting VMs, pay-per-second, multi-region — good for team deployment
- **AWS ECS Fargate**: Managed containers, no Docker daemon on CI runners
- Recommendation: Phase 2-3 focus on local Docker (developer use case); evaluate cloud providers in Phase 4+ for CI/CD and team deployment

---

### Decision Summary

| Decision | Choice | Reasoning |
|---|---|---|
| **Architecture** | Hybrid Docker+MCP | Best cost/capability balance; MCP inside containers for isolation |
| **Desktop environment** | fluxbox (~2MB) | Agents don't need a full DE; fluxbox provides window management only |
| **Browser control** | Playwright MCP (accessibility tree) | More accurate and deterministic than vision; 90%+ for web tasks |
| **Native app control** | xdotool + scrot + vision model | Universal fallback; deferred to Phase 3 (YAGNI) |
| **Communication** | MCP over HTTP (POST JSON-RPC) | Already supported by Claw'd's MCPHttpConnection (client.ts:352-471) |
| **File sharing (git)** | Git worktrees created on HOST, mounted into containers | Avoids `.git/index.lock` races; host can review; clean merge via branches |
| **File sharing (non-git)** | Read-only mount + rsync + named volumes | Selective copy avoids `cp -a` performance issues for large projects |
| **Human monitoring** | noVNC + VNC password from config file | Zero-install, works in any browser, localhost-only binding |
| **Multi-agent isolation** | Separate containers + git worktrees | Each agent has its own display, filesystem, processes |
| **Phase 1 (immediate)** | Playwright MCP config + restart | Minimal effort, 80% of value |
| **Phase 2 (main work)** | clawd-workspace Docker image + MCP server | ~3-4 weeks, delivers full workspace |
| **Phase 3 (deferred)** | Vision loop for native apps | Only when 95% CLI+browser isn't enough |
| **Phase 4 (future)** | Multi-agent orchestration + cloud | Workspace pool, git worktrees, team deployment |

---

## 12. Gap Analysis: "Human at a PC" Capability

> **Test case:** "Install MetaMask, import wallet with private key, connect to DApp, verify feature A."
>
> This section evaluates whether our architecture can handle this and similar real-world tasks where agents must act like humans with full PC control.

### 12.1 MetaMask Test Case — Step-by-Step Evaluation

| Step | Action | Playwright MCP (Phase 1) | Vision+xdotool (Phase 2b) | Verdict |
|------|--------|--------------------------|---------------------------|---------|
| 1 | Open Chrome | ❌ Playwright uses its own browser | ✅ xdotool can click | **Pre-configured in container** |
| 2 | Install MetaMask | ❌ No Chrome Web Store in Playwright Chromium | ⚠️ Could click through store UI | **Pre-bake in Docker image** |
| 3 | Extension loaded | ❌ Playwright uses non-persistent context | N/A | **`--load-extension` at launch** |
| 4-7 | MetaMask onboarding (import wallet, set password) | ❌ Extension popup UI invisible to a11y tree | ✅ Screenshot + click buttons | **Vision required** |
| 8 | MetaMask configured | N/A | N/A | State checkpoint |
| 9-10 | Navigate DApp, click "Connect Wallet" | ✅ Standard web page | ✅ Also works | **Playwright preferred** |
| 11-12 | MetaMask approval popup → click Connect | ❌ Popup is separate window, invisible | ✅ Screenshot detects popup | **Vision required** |
| 13 | Verify feature on DApp | ✅ Read DOM elements | ✅ Also works | **Playwright preferred** |

**Result: Phase 1 (Playwright MCP alone) can handle 3 of 13 steps. Phase 2b (vision engine) is NOT optional — it's required for any workflow involving browser extensions.**

### 12.2 Critical Capability Gaps

| # | Gap | Severity | Current Status | Solution | Effort |
|---|-----|----------|---------------|----------|--------|
| 1 | **Browser extension support** | 🔴 CRITICAL | Not supported | Pre-bake in Docker image + shared browser via CDP | Built into Phase 2 |
| 2 | **Extension popup interaction** | 🔴 CRITICAL | Not supported | Vision + xdotool for extension UIs; Playwright `waitForEvent('page')` for `notification.html` windows | Built into Phase 2 |
| 3 | **Shared browser instance** | 🔴 CRITICAL | Playwright launches own browser | Container launches Chrome with `--remote-debugging-port=9222`; Playwright connects via CDP | Built into Phase 2 |
| 4 | **Cross-app clipboard** | 🔴 CRITICAL | Not supported | `xclip` MCP tools (multi-MIME: text, HTML, images, file URIs) | 1-2 days |
| 5 | **TOTP 2FA codes** | 🔴 CRITICAL | Not supported | `oathtool --totp` from stored secrets (secret storage, provisioning, multi-account) | 2-3 days |
| 6 | **Native file dialogs** | 🟡 IMPORTANT | Not supported | Path typing in GTK/Qt dialogs (`Ctrl+L`) + AT-SPI2 | 1-2 days |
| 7 | **Multi-window management** | 🟡 IMPORTANT | Not supported | `wmctrl`/`xdotool` window management MCP tools | 1 day |
| 8 | **Desktop notifications** | 🟡 IMPORTANT | Not supported | `dunst` notification daemon + log capture | 0.5 day |
| 9 | **VPN/proxy for corporate tools** | 🟡 IMPORTANT | Not supported | WireGuard/OpenVPN client in container | 0.5-1 day |
| 10 | **Audio subsystem** | 🟢 NICE-TO-HAVE | Not supported | PulseAudio in container (for media testing) | 1 day |
| 11 | **Agent-human handoff** | 🔴 CRITICAL | Not supported | Pause/notify/wait mechanism for human input (CAPTCHAs, manual auth, confirmations) | 2-3 days |
| 12 | **Workflow error recovery** | 🔴 CRITICAL | Not supported | Action history, undo tool for reversible ops, checkpoints, warning for irreversible actions | 3-5 days |
| 13 | **Rich clipboard formats** | 🟡 IMPORTANT | Not supported | Multi-MIME xclip (text, HTML, images, file URIs) | 1-2 days |
| 14 | **QR code scanning (TOTP provisioning)** | 🟡 IMPORTANT | Not supported | Vision + QR decoder for extracting TOTP secrets from setup screens | 1-2 days |

### 12.3 Industry Landscape (Extension Support)

Research across all major AI agent platforms reveals a universal pattern:

| Platform | Extension Support | Method |
|----------|------------------|--------|
| **Anthropic Computer Use** | ❌ No extension support | Full desktop Docker, vision-only |
| **OpenAI Operator/CUA** | ❌ Explicitly confirmed unsupported | Isolated virtual browser |
| **Google Project Mariner** | ❌ IS an extension, can't interact with others | Chrome extension, page content only |
| **Browserbase** | ✅ L1 only (pre-loaded at session creation) | Extension upload API + CDP |
| **Synpress (testing framework)** | ✅ L1+L2 (pre-load + automate UI) | Playwright `launchPersistentContext` + `--load-extension` |
| **ScreenEnv (HuggingFace)** | ⚠️ Possible via Dockerfile customization | Docker + Chromium |
| **E2B** | ⚠️ Custom Docker images can pre-load | DIY |

**Three levels of extension interaction:**
- **L1 (Pre-bake):** Install extensions at Docker image build time → ✅ SOLVED by everyone
- **L2 (Interact):** Agent clicks extension popup UI via screenshots/vision → ⚠️ Reliable for well-designed extensions (e.g., MetaMask), fragile for others
- **L3 (Discover & install):** Agent autonomously finds and installs extensions → ❌ UNSOLVED by entire industry (browser security model intentionally prevents this)

**Claw'd target: L1 + L2** — pre-bake common extensions in workspace Docker images; interact with their UIs via the vision layer.

**Note on L2 reliability:** Reliability depends on extension architecture. Extensions that serve full HTML pages (like MetaMask's `notification.html`) can be reliably controlled — Synpress has demonstrated stable L2 MetaMask automation in CI for years. Extensions using only small popups or non-standard rendering are less reliable. Evaluate per-extension during Docker image creation.

### 12.4 Key Architectural Insight

> **Don't make the agent mimic human GUI gestures when programmatic interfaces exist.**

| Task | Human Does | Agent Should Do |
|------|-----------|-----------------|
| Send Slack message | Open Slack app, click channel, type | Slack API via MCP tool |
| Open file | Navigate Finder, double-click | `xdg-open /path/to/file` via CLI |
| Drag-and-drop files | Mouse gesture | `cp`/`mv` command |
| Check notifications | Glance at system tray | Query D-Bus / notification daemon log |
| Install npm package | Open terminal, type command | `bash` tool (already available) |
| Interact with MetaMask popup | Click buttons | **Vision — no programmatic alternative** |
| Test UI hover effects | Hover mouse, verify tooltip | **Vision + xdotool — testing GUI behavior requires actual GUI interaction** |

The vision layer is the **last resort** for things that have no programmatic interface. Most desktop tasks have faster, cheaper, more reliable programmatic alternatives.

This guideline applies to operational tasks. When the task IS to test GUI behavior (visual regression, hover effects, animation), GUI interaction via vision is the correct approach.

---

> **Note:** This section supersedes the implementation plan from [Section 11](#11-detailed-implementation-plan). The unified MCP server architecture described here replaces the separate server design from Section 11.

## 13. Revised Architecture: Unified Workspace MCP Server

### 13.1 The Core Change: One Server, Two Engines

The original plan proposed separate MCP servers (Playwright + Desktop). The revised architecture uses a **single unified workspace MCP server** with two internal control engines:

```
┌──────────────────────────────────────────────────┐
│              Unified Workspace MCP Server          │
│                                                    │
│  ┌──────────────┐       ┌──────────────────────┐  │
│  │  Engine 1:    │       │  Engine 2:            │  │
│  │  Playwright   │       │  Vision + xdotool     │  │
│  │  (persistent) │       │  (scrot + LLM)        │  │
│  │  ─ a11y tree  │       │  ─ screenshots         │  │
│  │  ─ DOM access │       │  ─ coordinate clicks   │  │
│  │  ─ navigation │       │  ─ keyboard input      │  │
│  │  ─ form fill  │       │  ─ window management   │  │
│  └──────┬───────┘       └──────────┬───────────┘  │
│         │      ┌─────────┐         │               │
│         └──────┤ Router  ├─────────┘               │
│                └────┬────┘                          │
│                     │ context_changed flag          │
│  ┌──────────────────▼──────────────────────────┐   │
│  │           Shared Chrome Instance             │   │
│  │  Launched by: Playwright launchPersistentContext() │   │
│  │  Control via: Playwright API + xdotool on DISPLAY  │   │
│  └─────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

**Why ONE server, not TWO:**
1. **Agent shouldn't route** — LLMs frequently pick the wrong server; routing is the server's job
2. **Shared state** — server knows "Playwright action triggered extension popup" and can notify agent
3. **`context_changed` flag** — every tool response tells agent whether foreground changed and which control mode applies

### 13.2 The Shared Browser Pattern

The container's entrypoint starts Xvfb, the window manager, and VNC. Chrome is launched by the MCP server via Playwright's `launchPersistentContext()` to ensure full extension support:

```bash
#!/bin/bash
# entrypoint.sh

# Start Xvfb
Xvfb :99 -screen 0 1280x1024x24 &
export DISPLAY=:99
while ! xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.1; done

# Start window manager
fluxbox &

# Start VNC with auth (password from mounted config or generated)
VNC_PASSWORD=$(cat /run/secrets/vnc_password 2>/dev/null || openssl rand -base64 16)
echo "VNC password: $VNC_PASSWORD" >&2  # Retrievable via docker logs
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vncpass
chmod 600 /tmp/vncpass
x11vnc -display :99 -forever -rfbauth /tmp/vncpass -rfbport 5900 &
websockify --web /usr/share/novnc 6080 localhost:5900 &

# NOTE: Chrome is launched by the MCP server via Playwright launchPersistentContext()
# This ensures Playwright has full extension support (connectOverCDP does NOT support extensions)

# Start the unified workspace MCP server
node /opt/workspace-mcp/server.js --port 3000
```

The MCP server launches Chrome via Playwright's `launchPersistentContext()` with extensions:

```typescript
const context = await chromium.launchPersistentContext('/data/.chrome-profile', {
  headless: false,
  args: [
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=TranslateUI',
    '--remote-debugging-port=9222',
    '--load-extension=/opt/extensions/metamask,/opt/extensions/...',
  ],
});
```

Note: We use Playwright's bundled Chromium (not system `chromium-browser`) via `launchPersistentContext()` because `connectOverCDP()` does NOT support extension loading. This is the same pattern used by Synpress for MetaMask automation. The Chrome profile is stored in a Docker named volume (`/data/.chrome-profile`) rather than a host bind mount, preventing accidental exposure of wallet data on the host filesystem.

### 13.3 Tool API Design (17 Tools)

| Category | Tool | Description | Engine |
|----------|------|-------------|--------|
| **Setup** | `launch_browser` | Open URL in shared Chrome (or new tab) | Playwright |
| | `launch_app` | Start native app (e.g., `code`, `libreoffice`) | subprocess + xdotool |
| **Interaction** | `click` | Click element (by ref, coordinates, or description) | **Auto-routed** |
| | `type_text` | Type text at current focus | Playwright or xdotool |
| | `press_key` | Press key/combo (Enter, Ctrl+C, etc.) | Playwright or xdotool |
| | `select_option` | Select from dropdown | Playwright |
| | `drag` | Drag from point A to B | xdotool |
| | `handle_dialog` | Accept/dismiss browser dialog | Playwright |
| **Observation** | `snapshot` | Get accessibility tree of current page | Playwright |
| | `screenshot` | Capture display screenshot | scrot → return path |
| | `observe` | Screenshot → vision model → structured description | Vision LLM |
| | `get_context` | Current state: active window, URL, control mode | Both |
| **Management** | `window_manage` | List/focus/resize/close windows | wmctrl + xdotool |
| | `clipboard` | Get/set clipboard content | xclip |
| | `file_dialog` | Handle native open/save dialog | xdotool + path typing |
| | `wait` | Wait for condition (element, text, timeout) | Playwright or polling |
| | `totp_code` | Generate TOTP 2FA code from stored secret | oathtool |

### 13.4 Auto-Routing: The `click` Tool

The `click` tool accepts three input modes and auto-routes to the correct engine:

```typescript
// Input mode 1: Structured reference (Playwright)
click({ ref: "button#submit" })  // → Playwright locator, $0.001

// Input mode 2: Coordinates (xdotool)
click({ x: 1020, y: 680 })      // → xdotool mousemove + click, $0.000

// Input mode 3: Description (Vision)
click({ description: "the blue Connect button in MetaMask popup" })
// → screenshot → vision LLM identifies coordinates → xdotool click, $0.02-0.06
```

**Routing precedence:** `ref` > `coordinates` > `description`. If multiple modes provided, highest-precedence wins. Invalid inputs (empty params, out-of-bounds coordinates, both `ref` and `description`) return validation errors. If `ref` is provided but the element is not found in the DOM/a11y tree, the tool returns an error (no automatic fallback to description mode) — the agent must explicitly retry with a different input mode.

**Mutual exclusion:** Only one engine operates at a time. The router queues requests to prevent Playwright and xdotool from conflicting on the same window. This eliminates race conditions when switching between structured and vision modes.

### 13.5 The `context_changed` Pattern

Every tool response includes a `context_changed` field that tells the agent what happened:

```json
{
  "result": "Clicked 'Connect Wallet' button",
  "context_changed": true,
  "active_context": "extension_popup",
  "control_mode": "vision",
  "hint": "MetaMask popup detected. Use 'observe' to see current state, then 'click' with coordinates or description."
}
```

This eliminates the agent guessing. When `control_mode` switches from `"structured"` to `"vision"`, the agent knows to use `observe` + coordinate-based `click` instead of `snapshot` + ref-based `click`.

**Implementation detail:** Context detection uses CDP's `Target.setDiscoverTargets({ discover: true })` to monitor for new windows/tabs. When `Target.targetCreated` fires with a URL matching `chrome-extension://*/notification.html` or similar patterns, the server sets `context_changed: true` and `control_mode: "vision"`. Event listeners are registered BEFORE any tool actions to avoid the race condition where a popup appears before the listener is active.

### 13.6 MetaMask Test Case — Complete Flow

```
Agent receives: "Install MetaMask, import wallet with key XXX, connect to DApp, verify feature A"

1. Container starts with MetaMask pre-loaded (Docker image: clawd-workspace:web3)

2. Agent: launch_browser({ url: "chrome-extension://<metamask-id>/home.html" })
   → Playwright opens MetaMask home page
   → Response: { control_mode: "structured" }

3. Agent: observe()
   → Screenshot of MetaMask onboarding page → vision model → structured description
   → Agent sees "Import wallet" button and page layout

4. Agent: click({ description: "Import wallet button" })
   → Vision identifies coordinates → xdotool clicks
   → MetaMask shows import form (still same page, not popup)
   → Response: { control_mode: "vision" }

5. Agent: observe() → sees private key input field
   Agent: click({ description: "private key input field" })
   Agent: type_text({ text: "XXX" })
   → xdotool types private key into form
   → ⚠️ WARNING: Private key is passed via MCP tool call parameter. While the container
     isolates network access, the key exists in the MCP HTTP request body, server memory,
     and the agent's conversation history. For production use, inject secrets via Docker
     secrets API (see Section 11.5) rather than passing as tool call parameters.
     This example uses inline text for demonstration only.

6. Agent: click({ description: "Import button" })
   → Wallet imported
   → Agent continues through password setup via vision-based observe + click

7. Agent: launch_browser({ url: "https://dapp.example.com" })
   → Navigates to DApp

8. Agent: snapshot()
   → DApp page a11y tree → "Connect Wallet" button visible

9. Agent: click({ ref: "button:Connect Wallet" })
   → DApp triggers MetaMask popup window
   → Server detects new window via CDP event
   → Response: { context_changed: true, active_context: "extension_popup",
                  control_mode: "vision",
                  hint: "MetaMask connection popup detected" }

10. Agent: observe()
    → Screenshot of MetaMask popup → vision model → "MetaMask is requesting
       permission to connect. 'Connect' button at bottom-right."

11. Agent: click({ description: "Connect button in MetaMask popup" })
    → Vision identifies coordinates → xdotool clicks → popup closes
    → Server detects popup closed, DApp page active again
    → Response: { context_changed: true, control_mode: "structured" }

12. Agent: snapshot()
    → DApp shows "Connected: 0xf39f..." → Feature A content visible
    → Agent verifies feature A
    → Task complete ✅
```

**Total cost:** ~$0.12-0.40 (vision calls at $0.02-0.06 each for MetaMask interactions + ~$0.001 each for structured Playwright calls)

### 13.7 Docker Image Variants

```
clawd-workspace:base      → Ubuntu + fluxbox + Xvfb + Chrome + dev tools (~1.2 GB)
clawd-workspace:web3      → base + MetaMask + WalletConnect + Hardhat (~1.4 GB)
clawd-workspace:devtools  → base + React DevTools + Redux DevTools + Lighthouse (~1.3 GB)
clawd-workspace:office    → base + LibreOffice + GIMP + Inkscape (~2.0 GB)
clawd-workspace:full      → all of the above (~2.5 GB)
```

Users can also create custom images by extending the base:
```dockerfile
FROM ghcr.io/clawd-pilot/workspace:base
COPY my-extension/ /opt/extensions/my-extension/
```

### 13.8 Revised Phase Plan

| Phase | Content | Effort | Delivers |
|-------|---------|--------|----------|
| **Phase 1** | Playwright MCP config on host (unchanged) | 1-2 hours | Browser control for web pages (80% of dev tasks) |
| **Phase 2** | Unified workspace MCP server + Docker image | 6-8 weeks (single dev) | Full "human at PC" capability with shared browser, vision layer, extension support |
| **Phase 2a** | Base Docker image + entrypoint + Chrome+CDP | Week 1-2 | Container with shared browser + Playwright via CDP |
| **Phase 2b** | Vision engine (screenshot → LLM → xdotool) | Week 3-4 | Extension popup interaction, native app control |
| **Phase 2c** | Utility tools (clipboard, TOTP, file_dialog, window) | Week 4-5 | Cross-app workflows, 2FA, file management |
| **Phase 2d** | Image variants + testing + docs + CI | Week 6-8 | web3, devtools, office images; CI smoke tests |
| **Phase 3** | Multi-agent orchestration | 4-6 weeks | Workspace pools, git worktrees, coordination |
| **Phase 4** | Cloud deployment + advanced features | Future | E2B/Fly.io, AT-SPI2 for native apps, audio |

### 13.9 What We Explicitly Cannot Do (Industry-Wide Limitations)

| Capability | Status | Reason |
|-----------|--------|--------|
| **L3: Agent discovers & installs unknown extensions** | ❌ Impossible | Chrome security model requires user consent; intentional design |
| **Hardware keys (YubiKey, FIDO2)** | ❌ Impossible in Docker | USB passthrough to containers is complex and unreliable |
| **Biometric auth** | ❌ Impossible | No fingerprint/face sensors in Docker |
| **Real webcam/microphone** | ❌ No real hardware | Can use virtual devices for testing only |
| **DRM-protected content** | ❌ Missing Widevine | Chromium in Docker lacks DRM modules |

These are inherent limitations of containerized environments. For hardware-dependent tasks, the agent must escalate to a human or use alternative approaches (e.g., TOTP instead of hardware 2FA).

### 13.10 Security Considerations (Revised)

1. **MCP transport security**: Tool calls (including `type_text` with secrets) traverse HTTP in plaintext over localhost. For production, consider stdio MCP transport or TLS. For credential injection, use Docker secrets API (`/run/secrets/*`) in production, or mount `~/.clawd/config.json` as read-only (`/etc/clawd/config.json:ro`) for simpler setups (see Section 11.5 for implementation details).

2. **MCP server sandbox isolation**: MCP servers inherit full `process.env` including API keys, SSH keys, and filesystem access (see Section 8 for threat model). For production, wrap MCP server spawn in bwrap/gVisor sandbox with filtered environment (only pass necessary vars, not full `process.env`) and restricted filesystem access. This is the highest-priority security gap to address.

3. **Vision screenshot privacy**: Screenshots sent to external vision APIs (Gemini/CPA) may contain PII, passwords, wallet data. Mitigations: auto-delete screenshots after analysis, encrypt screenshots at rest in `/tmp` (use tmpfs with encryption), opt-in external APIs (local models preferred for sensitive workflows), field masking for passwords/credit cards/health data before LLM analysis, audit logging of all vision API calls.

4. **CDP port protection**: Port 9222 is accessible inside the container only. NEVER expose to host via `-p 9222:9222`. Add iptables rule in container startup to drop non-localhost traffic to port 9222.

5. **Chrome profile isolation**: Stored in Docker named volume (`/data/.chrome-profile`), NEVER use host bind mounts (`-v host_path:/data/.chrome-profile`) which would expose wallet data/cookies/passwords on host filesystem. If you create a local `.chrome-profile` directory for testing, add it to `.gitignore`.

6. **Extension updates**: Extensions are frozen at image build time. Establish a rebuild schedule for security patches. Pin specific extension versions in the Dockerfile to ensure reproducible builds.

7. **VNC access**: Password-protected (see entrypoint script in Section 13.2), localhost-only. VNC exposes all visible content including sensitive data — use only in trusted environments. Make VNC opt-in via environment variable (`CLAWD_VNC_ENABLED=true`).

8. **TOTP secret storage**: TOTP secrets for the `totp_code` tool are stored in an encrypted file within the Docker named volume (`/data/.totp-secrets.enc`), decrypted at runtime via a key from Docker secrets API. Secrets are never stored in plaintext on disk. Multi-account support via key-value format (`account_name → TOTP_secret`).
