# Research Report: AI Agents Controlling Windows via RDP

## Executive Summary

**Yes, AI agents can programmatically control Windows machines via RDP.** The answer is more mature than expected. A purpose-built library (`agent-rdp`) already exists, is actively maintained (v0.6.5, published 6 days ago), and provides exactly the primitives needed: connect, screenshot, mouse, keyboard, clipboard, OCR locate, Windows UI Automation accessibility tree, and drive mapping — all via a clean Node.js API and CLI.

For integrating into the existing Clawd workspace architecture (Docker + Xvfb + noVNC + workspace-mcp), the **recommended approach is Pattern A: `agent-rdp` as the RDP backend** inside (or alongside) workspace containers, exposing the same MCP tool interface that the Linux workspace currently uses. This avoids reinventing the wheel — agent-rdp handles the hard protocol work (IronRDP Rust core), NLA/CredSSP auth, frame decoding, input injection, and even Windows UI Automation via a PowerShell DVC agent.

The alternatives (FreeRDP C library, Apache Guacamole, PyRDP) are viable but significantly more work to integrate. agent-rdp is the 80/20 solution.

## Research Methodology
- Sources: npm registry, local package inspection, FreeRDP apt packages, codebase analysis
- Date: 2026-03-04
- Key search terms: agent-rdp, FreeRDP, pyrdp, guacamole-lite, RDP programmatic control, AI agent Windows

---

## 1. RDP Protocol Fundamentals for Automation

### Protocol Architecture

RDP is a multi-channel binary protocol operating over TCP:3389 (or UDP for lossy transport):

```
┌──────────────────────────────────────────────┐
│  Application Layer (Clipboard, Drive, Audio) │  ← Virtual Channels
├──────────────────────────────────────────────┤
│  Graphics Pipeline (GFX / RemoteFX / Bitmap) │  ← Display updates
├──────────────────────────────────────────────┤
│  Input Channel (Keyboard / Mouse PDUs)       │  ← Scancodes + mouse events
├──────────────────────────────────────────────┤
│  MCS (T.125) Multipoint Communication        │
├──────────────────────────────────────────────┤
│  X.224 / TPKT / CredSSP / TLS               │  ← Transport + Auth
├──────────────────────────────────────────────┤
│  TCP:3389                                     │
└──────────────────────────────────────────────┘
```

**Key channels for agent control:**

| Channel | Purpose | Agent Use |
|---------|---------|-----------|
| Input (static) | Keyboard scancodes, mouse position/buttons | Send keystrokes, clicks |
| Graphics (GFX/RFX) | Bitmap updates, progressive codec | Capture screenshots |
| Clipboard (cliprdr) | Bidirectional clipboard sync | Copy/paste text |
| Drive Redirection (rdpdr) | Map local dirs as network drives | File transfer |
| Dynamic Virtual Channel (DVC) | Custom bidirectional IPC | UI Automation agent comm |

### Input Encoding

- **Keyboard**: Sent as scancode events (make/break) per T.128 spec. Unicode input also supported via TS_UNICODE_KEYBOARD_EVENT PDU (allows direct Unicode char injection without scancode mapping)
- **Mouse**: TS_POINTER_EVENT PDU with x, y coordinates + button flags. Coordinate space = desktop resolution
- **Programmatic control is fully possible** — no GUI needed. The RDP client just needs to encode PDUs and send over the MCS channel

### Display Decoding

- Bitmap updates: raw bitmap tiles sent when regions change
- RemoteFX (RFX): wavelet-based codec, better compression
- GFX Pipeline (RDPGFX): modern progressive codec, used by Windows 10+
- All decoders produce pixel buffers that can be captured as screenshots

### Can RDP be headless?

**Yes.** The RDP client doesn't need a local display — it's just a network protocol. FreeRDP and IronRDP both support headless operation where the decoded framebuffer exists only in memory.

---

## 2. Programmatic RDP Libraries & Tools

### Tier 1: Production-Ready for Agent Use

#### `agent-rdp` (npm) ⭐ RECOMMENDED

**The killer find.** Purpose-built for AI agents controlling Windows via RDP.

| Attribute | Detail |
|-----------|--------|
| Package | `agent-rdp` on npm |
| Version | 0.6.5 (2026-02-26) |
| GitHub | `github.com/thisnick/agent-rdp` |
| Core | Rust (IronRDP by Devolutions) |
| Bindings | Node.js TypeScript API + CLI |
| Platforms | Linux x64, Windows x64/arm64, macOS x64/arm64 |
| Auth | NLA/CredSSP + TLS |
| License | MIT OR Apache-2.0 |

**Capabilities:**

```typescript
import { RdpSession } from 'agent-rdp';

const rdp = new RdpSession({ session: 'default' });

// Connect
await rdp.connect({
  host: '192.168.1.100',
  username: 'Administrator',
  password: 'secret',
  width: 1280,
  height: 800,
  enableWinAutomation: true,  // Injects PowerShell agent via DVC
});

// Screenshot (base64 PNG)
const { base64, width, height } = await rdp.screenshot({ format: 'png' });

// Mouse/Keyboard (identical to Clawd workspace tools)
await rdp.mouse.click({ x: 100, y: 200 });
await rdp.keyboard.type({ text: 'Hello World' });
await rdp.keyboard.press({ keys: 'ctrl+c' });

// OCR-based element location (no accessibility API needed)
const matches = await rdp.locate({ text: 'Cancel' });
await rdp.mouse.click({ x: matches[0].center_x, y: matches[0].center_y });

// Windows UI Automation (accessibility tree - like browser a11y)
const snapshot = await rdp.automation.snapshot({ interactive: true });
await rdp.automation.click('@e5');       // Click by element ref
await rdp.automation.fill('#input', 'text');
await rdp.automation.run('notepad.exe'); // Launch apps

// Clipboard + Drive mapping
await rdp.clipboard.set({ text: 'data' });
const drives = await rdp.drives.list();
```

**Architecture:**
- CLI spawns a daemon process per session (IPC via Unix socket or TCP)
- Daemon maintains persistent RDP connection
- Commands are JSON-RPC over IPC
- WebSocket streaming for real-time display (optional)
- Binary size: ~37.6 MB (native Rust binary)

**Critical advantage over alternatives:** The UI Automation feature injects a PowerShell agent INTO the Windows session via RDP's Dynamic Virtual Channel. This gives structured access to the Windows accessibility tree — no vision model needed for many tasks.

---

### Tier 2: Viable but More Work

#### FreeRDP (C library + CLI)

| Attribute | Detail |
|-----------|--------|
| Package | `freerdp3-x11` (apt) or build from source |
| Version | 3.5.1 (Ubuntu 24.04) |
| Language | C |
| License | Apache 2.0 |

**Headless operation:**
```bash
# FreeRDP can run headless with /video output
xfreerdp3 /v:192.168.1.100 /u:Administrator /p:secret \
  /cert:ignore /size:1280x800 /bpp:32 \
  +gfx +clipboard /sec:tls
```

To capture screenshots, FreeRDP requires custom C code using `libfreerdp` API to hook the `update->BitmapUpdate` callback. No built-in "headless screenshot" mode.

**Programmatic input injection** requires using `freerdp_input_send_keyboard_event()` and `freerdp_input_send_mouse_event()` C functions. No Python/Node bindings exist.

**Verdict:** Powerful but requires C development. Only use if agent-rdp has a showstopper limitation.

#### Apache Guacamole + guacamole-lite (Node.js)

| Attribute | Detail |
|-----------|--------|
| Package | `guacamole-lite` (npm) + `guacd` (apt/docker) |
| Architecture | Browser ↔ WS ↔ guacamole-lite ↔ TCP ↔ guacd ↔ RDP |

**How it works:**
```
Browser (guacamole-common-js) 
  ↕ WebSocket (Guacamole protocol)
guacamole-lite (Node.js)
  ↕ TCP socket (Guacamole protocol)  
guacd (C daemon using FreeRDP internally)
  ↕ RDP
Windows machine
```

**Guacamole protocol** is text-based, human-readable:
```
# Send mouse click at (100, 200), left button pressed
3.mouse,3.100,3.200,1.1;

# Send keypress 'A' (keycode 65), pressed
3.key,2.65,1.1;

# Receive image update
3.img,1.0,3.png,1.0,1.0,3.100,3.100;
```

**Can an agent intercept this?** Yes — `guacamole-lite` sits in the middle. You can:
1. Inject mouse/key instructions by writing to the guacd TCP socket
2. Intercept `img` instructions to capture screenshots
3. Build a custom Node.js server that speaks Guacamole protocol without any browser

**Verdict:** Good for web-based viewing/interaction. Adds complexity (extra daemon, extra protocol layer). Use if you need browser-based human observation alongside agent control.

#### PyRDP (Python)

| Attribute | Detail |
|-----------|--------|
| Package | `pyrdp` (pip) |
| GitHub | `github.com/GoSecure/pyrdp` |
| Purpose | RDP man-in-the-middle proxy + replay tool |

PyRDP can:
- Act as RDP MITM proxy (capture sessions)
- Replay RDP sessions with screenshots
- Inject input during live sessions (via the MITM proxy)
- Extract screenshots from replay files

**Not designed as an RDP client library.** It's a security/forensics tool. Could be adapted but wrong tool for the job.

#### aardwolf (Python)

Pure Python RDP/VNC client library. Less mature, limited documentation. Can establish connections and decode frames but lacks the high-level automation features of agent-rdp.

### Tier 3: Not Recommended

| Library | Why Not |
|---------|---------|
| `node-rdp` (npm) | Just wraps `mstsc.exe` on Windows — not cross-platform, not headless |
| `rdpy` (Python) | Abandoned (last update 2017), Python 2 only |
| `remmina` | GUI application, no programmatic API |
| `rustdesk` | P2P remote desktop, not standard RDP |

---

## 3. Screen Capture & Vision from RDP

### Screenshot Methods (ranked by quality)

| Method | Latency | Quality | Complexity |
|--------|---------|---------|------------|
| `agent-rdp screenshot --base64` | ~200ms | Full framebuffer PNG | Trivial |
| agent-rdp WebSocket stream | ~100ms per frame | JPEG stream | Low |
| FreeRDP bitmap callback | ~50ms | Raw bitmap | High (C code) |
| Guacamole `img` instructions | ~150ms | PNG tiles | Medium |
| PyRDP replay extraction | N/A | Post-hoc only | Medium |

### Vision Model Integration Pattern

```typescript
// Agent loop: screenshot → vision → action → repeat
async function agentLoop(rdp: RdpSession, visionModel: VisionAPI) {
  while (true) {
    // 1. Capture
    const { base64, width, height } = await rdp.screenshot({ format: 'png' });
    
    // 2. Analyze (send to Claude/GPT-4V/Gemini)
    const actions = await visionModel.analyze(base64, {
      prompt: "What should I click next to complete the task?",
      width, height,
    });
    
    // 3. Execute
    for (const action of actions) {
      if (action.type === 'click') await rdp.mouse.click(action);
      if (action.type === 'type') await rdp.keyboard.type(action);
      if (action.type === 'press') await rdp.keyboard.press(action);
    }
    
    // 4. Wait for UI to settle
    await new Promise(r => setTimeout(r, 500));
  }
}
```

### Hybrid: Vision + Accessibility Tree (Best Approach)

agent-rdp's UI Automation gives you the **accessibility tree** — structured element data with refs. This is identical to how Clawd's workspace-mcp uses Playwright's accessibility snapshot for browser pages:

```typescript
// PREFER: structured accessibility approach (fast, reliable)
const snapshot = await rdp.automation.snapshot({ interactive: true, compact: true });
// Returns:
// - Window "Notepad" [ref=e1]
//   - MenuBar [ref=e2]
//     - MenuItem "File" [ref=e3]
//   - Edit "Text Editor" [ref=e5, value="Hello"]

await rdp.automation.click('@e3'); // Click "File" menu

// FALLBACK: vision approach (for WebViews, custom UI, etc.)
const { base64 } = await rdp.screenshot();
const coords = await visionModel.locateElement(base64, 'Save button');
await rdp.mouse.click(coords);

// FALLBACK 2: OCR approach (cheaper than vision)
const matches = await rdp.locate({ text: 'Save' });
await rdp.mouse.click({ x: matches[0].center_x, y: matches[0].center_y });
```

---

## 4. Existing Agent-over-RDP Projects

### Direct Matches

| Project | Description | Status |
|---------|-------------|--------|
| **agent-rdp** | Purpose-built CLI + API for AI agents over RDP | Active, v0.6.5 |
| **Anthropic Computer Use** | Claude model with computer-use tool | Supports VNC, not RDP natively. agent-rdp README suggests combining them |
| **OpenAI Operator** | Browser agent | Web only, no RDP |
| **Open Interpreter** | Local code + computer control | Uses pyautogui locally, no RDP |

### Research/Experimental

| Project | Approach |
|---------|----------|
| CogAgent / SeeClick / OmniParser | Vision-based UI agents — could consume RDP screenshots but don't have RDP integration |
| Windows Agent Arena (Microsoft) | Benchmarks for Windows desktop agents — uses local VM not RDP |
| OSWorld benchmark | Cross-platform OS agent benchmark, uses VNC for Linux, VM for Windows |

### Key Insight

agent-rdp is essentially **the only production-quality open-source project** for "AI agent controls Windows via RDP." The author designed it specifically for Claude Code integration (even has `npx add-skill` support for Claude Code skill injection).

---

## 5. Architecture Patterns

### Recommended: Pattern A — agent-rdp as Windows workspace backend

```
┌─────────────────────────────────────────────────────┐
│  Clawd Server                                        │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │ Linux Workspace   │  │ Windows Workspace         │ │
│  │ (Docker container)│  │ (agent-rdp daemon)        │ │
│  │                   │  │                            │ │
│  │ Xvfb+fluxbox     │  │ RDP → Windows VM/machine  │ │
│  │ + Chrome          │  │                            │ │
│  │ + workspace-mcp   │  │ workspace-mcp-windows     │ │
│  │   (Express)       │  │   (Express, same API)     │ │
│  │                   │  │                            │ │
│  │ Tools:            │  │ Tools (same interface):    │ │
│  │  screenshot       │  │  screenshot → rdp.screenshot│
│  │  click (xdotool)  │  │  click → rdp.mouse.click  │ │
│  │  type (xdotool)   │  │  type → rdp.keyboard.type │ │
│  │  snapshot (a11y)  │  │  snapshot → rdp.automation │ │
│  │  observe (vision) │  │  observe → screenshot+AI  │ │
│  └──────────────────┘  └──────────────────────────┘ │
│              ↕ MCP JSON-RPC          ↕ MCP JSON-RPC  │
│  ┌────────────────────────────────────────────────┐  │
│  │              Agent Orchestrator                  │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Implementation plan:**

1. Create `workspace-mcp-windows` — a thin Express server with the same MCP JSON-RPC interface as workspace-mcp
2. Internally uses `agent-rdp` Node.js API instead of xdotool/Playwright
3. Tool mapping:

| Linux Tool | Windows Equivalent via agent-rdp |
|------------|----------------------------------|
| `screenshot` (scrot/Xvfb) | `rdp.screenshot()` |
| `click` (xdotool/Playwright) | `rdp.mouse.click()` or `rdp.automation.click()` |
| `type_text` (xdotool/Playwright) | `rdp.keyboard.type()` |
| `press_key` (xdotool) | `rdp.keyboard.press()` |
| `snapshot` (Playwright a11y) | `rdp.automation.snapshot()` |
| `observe` (vision AI) | screenshot + vision AI (same flow) |
| `scroll` | `rdp.scroll.up/down()` |
| `clipboard` (xclip) | `rdp.clipboard.get/set()` |
| `window_manage` (wmctrl) | `rdp.automation.listWindows/focusWindow()` |
| `launch_app` | `rdp.automation.run()` |
| `launch_browser` | `rdp.automation.run('msedge', { args: [url] })` |

4. Container setup: Can run in Docker (Linux) since agent-rdp has Linux x64 native binary. Container connects OUT to Windows RDP target.

**Key difference from Linux workspace:** No local display needed. The "display" is the remote Windows machine. The workspace container just runs the MCP server + agent-rdp daemon.

### Pattern B — Guacamole Middleware

```
Agent → WebSocket → guacamole-lite (Node.js) → guacd → RDP → Windows
```

Adds complexity. Use only if you need:
- Browser-based human viewing (already have noVNC for Linux, would need Guacamole for Windows)
- Multi-protocol support (VNC+RDP+SSH through one proxy)

**guacamole-lite code example:**
```typescript
import GuacamoleLite from 'guacamole-lite';
import http from 'http';

const server = http.createServer();
const guacServer = new GuacamoleLite({ server }, {
  host: '127.0.0.1', // guacd host
  port: 4822,        // guacd port
});

// Connections carry encrypted tokens with RDP params:
// { connection: { type: 'rdp', settings: { hostname, port, username, password, width, height }}}
```

### Pattern C — Hybrid RDP + WinRM

For tasks that don't need visual interaction:
```typescript
// Use PowerShell Remoting for structured tasks
const { stdout } = await execFileAsync('pwsh', [
  '-Command', 
  `Invoke-Command -ComputerName ${host} -Credential $cred -ScriptBlock { Get-Process }`
]);

// Use RDP only when visual interaction needed
await rdp.connect({ host, username, password });
await rdp.screenshot(); // See what's on screen
```

**When to use:** When most tasks are CLI/PowerShell automatable and only occasional GUI interaction needed.

### Pattern D — No Good xdotool Equivalent for RDP

On Linux, xdotool injects X11 events directly. There is **no equivalent for RDP** because:
- RDP input must be encoded as RDP PDUs
- You need an active RDP session to send input
- agent-rdp IS the equivalent — it encodes and sends RDP input PDUs

### Architecture Recommendation

**Pattern A is the clear winner.** Reasons:
1. **Minimal new code** — agent-rdp handles all RDP complexity
2. **Same MCP interface** — agents don't need to know if they're on Linux or Windows
3. **Structured + Visual** — UI Automation for structured access, vision fallback
4. **Already Node.js** — fits the existing TypeScript codebase perfectly
5. **Docker-compatible** — Linux x64 binary runs in containers

---

## 6. Security Considerations

### Authentication

| Method | Support | Notes |
|--------|---------|-------|
| NLA (Network Level Auth) | ✅ agent-rdp, FreeRDP | Default on modern Windows. Required. |
| CredSSP | ✅ agent-rdp (IronRDP) | Underlying NLA mechanism |
| TLS | ✅ All | Encrypts channel |
| RDP Security (legacy) | ❌ Avoid | Vulnerable to MITM |

### Credential Management

```
CRITICAL: Never hardcode RDP credentials in code or config files.
```

Recommended approaches (least to most secure):
1. **Environment variables** — `AGENT_RDP_USERNAME`, `AGENT_RDP_PASSWORD` — acceptable for containers
2. **Stdin pipe** — `echo $secret | agent-rdp connect --password-stdin` — prevents ps visibility
3. **Vault integration** — Fetch from HashiCorp Vault / AWS Secrets Manager at runtime
4. **Certificate-based auth** — No password needed, but requires PKI setup on Windows
5. **Azure AD / Entra ID** — For Azure-hosted VMs, use managed identity (no password)

### Session Isolation

| Scenario | Windows Edition | Behavior |
|----------|----------------|----------|
| Single concurrent session | Win 10/11 Pro | RDP disconnects console user |
| Multiple sessions | Windows Server | Each user gets isolated session |
| Same user, multiple sessions | Server (with config) | Possible but requires registry tweak |

**For multi-agent control of one Windows machine:** Use Windows Server with separate user accounts per agent.

### Risks

| Risk | Mitigation |
|------|------------|
| Accidental input to wrong window | Use automation refs (`@e5`) instead of coordinates when possible |
| Credential exposure in logs | Strip passwords from all logging; use --password-stdin |
| Agent takes destructive action | Implement confirmation for dangerous operations (format, delete, install) |
| Session hijacking | NLA + TLS + strong passwords; rotate credentials |
| Zombie sessions | Implement session timeout and cleanup (agent-rdp has `session close`) |

---

## 7. Comparison with Alternatives

### RDP vs VNC for Agent Control

| Factor | RDP | VNC |
|--------|-----|-----|
| **Windows native** | ✅ Built-in, optimized | ❌ Requires 3rd-party server |
| **Linux native** | ❌ Needs xrdp server | ✅ Native X11 + x11vnc |
| **Authentication** | NLA/CredSSP (strong) | Password only (weak) |
| **Performance** | Better (RemoteFX/GFX codec) | Worse (raw bitmap) |
| **Clipboard** | Built-in bidirectional | Protocol-dependent |
| **File transfer** | Drive redirection | Not standard |
| **Audio** | Built-in | Not standard |
| **Accessibility tree** | Via agent-rdp + UI Automation | Not available |
| **Headless client** | Yes (agent-rdp, FreeRDP) | Yes (many clients) |
| **Multi-monitor** | Native support | Varies |

**Verdict:** RDP for Windows targets, VNC for Linux targets. This is the natural split.

### RDP vs SSH + PowerShell

| Factor | RDP (Visual) | SSH/WinRM (CLI) |
|--------|-------------|-----------------|
| GUI interaction | ✅ Full desktop | ❌ None |
| Speed for CLI tasks | ❌ Slower (visual overhead) | ✅ Fast, direct |
| Reliability | Medium (UI can be flaky) | High (deterministic) |
| Bandwidth | High (graphics stream) | Low (text) |
| Complexity | Medium (agent-rdp handles it) | Low |

**Verdict:** Use SSH/WinRM for CLI-automatable tasks; RDP only when GUI interaction is required.

### RDP vs WinRM

| Factor | RDP | WinRM |
|--------|-----|-------|
| Protocol | RDP (TCP 3389) | HTTP/HTTPS (5985/5986) |
| Interaction | Full desktop GUI | PowerShell commands only |
| Setup | Enabled by default | Requires `Enable-PSRemoting` |
| Firewall | Usually open | Often blocked |
| Use case | GUI automation | Server management, scripting |

### Decision Matrix

```
Need GUI interaction with Windows?
  ├── YES → Use RDP (via agent-rdp)
  │         └── Supplement with UI Automation for structured access
  └── NO → 
      ├── Need to run PowerShell/CLI commands? → Use WinRM/SSH
      └── Need file operations only? → Use SMB/CIFS or drive mapping
```

---

## 8. Integration Plan for Clawd

### Phase 1: Minimal Windows Workspace (Recommended Start)

```
Goal: Windows workspace with same MCP tool interface as Linux workspace
Effort: ~2-3 days
Dependencies: agent-rdp npm package, target Windows machine with RDP enabled
```

1. **Create `workspace-mcp-windows/` package** — Express server, same JSON-RPC protocol
2. **Install `agent-rdp` as dependency** — provides RDP client + UI Automation
3. **Map existing tool names to agent-rdp calls** (see table in §5)
4. **Dockerfile:** Ubuntu base + Node.js + agent-rdp (no Xvfb/Chrome needed)
5. **Configuration:** Windows host, credentials passed as env vars to container

```typescript
// workspace-mcp-windows/src/server.ts (sketch)
import { RdpSession } from 'agent-rdp';
import express from 'express';

const rdp = new RdpSession({ session: 'workspace' });

// Connect on startup
await rdp.connect({
  host: process.env.WINDOWS_HOST!,
  username: process.env.WINDOWS_USER!,
  password: process.env.WINDOWS_PASS!,
  width: 1280, height: 800,
  enableWinAutomation: true,
});

// Same MCP tool handler as Linux workspace
async function handleToolCall(name: string, args: any) {
  switch (name) {
    case 'screenshot': {
      const { base64, width, height } = await rdp.screenshot({ format: 'png' });
      return { base64, width, height }; // Upload to chat server same as Linux
    }
    case 'click': {
      if (args.ref) return rdp.automation.click(args.ref);
      if (args.x && args.y) return rdp.mouse.click({ x: args.x, y: args.y });
      if (args.description) { /* vision fallback */ }
    }
    case 'type_text': return rdp.keyboard.type({ text: args.text });
    case 'press_key': return rdp.keyboard.press({ keys: args.key });
    case 'snapshot': return rdp.automation.snapshot({ interactive: true, compact: true });
    case 'launch_app': return rdp.automation.run(args.app, { args: args.args });
    case 'clipboard': {
      if (args.action === 'get') return { text: await rdp.clipboard.get() };
      return rdp.clipboard.set({ text: args.text });
    }
    // ... etc
  }
}
```

### Phase 2: Human Observation (Optional)

Add WebSocket streaming for human observation of Windows sessions:
- agent-rdp supports `--stream-port 9224` for WebSocket JPEG streaming
- Or add Guacamole for richer browser-based interaction
- Replace noVNC viewer with Guacamole viewer for Windows workspaces

### Phase 3: Multi-Windows (Optional)

- Pool of Windows VMs (Azure/AWS)
- Dynamic provisioning per agent
- Session-per-agent isolation on Windows Server

---

## Appendix A: agent-rdp CLI Quick Reference

```bash
# Connect
agent-rdp connect --host 10.0.0.1 -u Admin -p secret --enable-win-automation

# Screenshot
agent-rdp screenshot --base64            # Base64 output
agent-rdp --json screenshot --base64     # JSON wrapper

# Input
agent-rdp mouse click 500 300
agent-rdp keyboard type "Hello"
agent-rdp keyboard press "ctrl+s"

# Accessibility tree
agent-rdp automate snapshot -i -c        # Interactive, compact
agent-rdp automate click "@e5"           # Click element by ref
agent-rdp automate fill "#SearchBox" "query"

# OCR
agent-rdp locate "Save"                  # Find text on screen

# Session management
agent-rdp session list
agent-rdp session close
```

## Appendix B: FreeRDP Headless Screenshot (for reference)

If agent-rdp is unavailable, FreeRDP can capture via:
```bash
# Install
apt install freerdp3-x11

# Connect + screenshot requires custom code or xdotool hack:
# 1. Run xfreerdp3 in Xvfb
# 2. Use scrot to capture Xvfb framebuffer
# 3. Use xdotool to send input to xfreerdp3 window

# This is essentially what the Linux workspace already does — 
# just replacing Chrome with xfreerdp3 as the "app" in the Xvfb session.
# But it loses RDP-level control (clipboard, drive mapping, UI Automation).
```

## Appendix C: Guacamole Protocol Reference

```
# Mouse instruction: 3.mouse,<x_len>.<x>,<y_len>.<y>,<mask_len>.<mask>;
3.mouse,3.500,3.300,1.1;

# Keyboard instruction: 3.key,<keycode_len>.<keycode>,<pressed_len>.<pressed>;
3.key,2.65,1.1;   # 'A' pressed
3.key,2.65,1.0;   # 'A' released

# Screenshot: intercept 3.img instructions from guacd
```

---

## Unresolved Questions

1. **agent-rdp Linux binary in Docker** — Has this been tested in Alpine/Ubuntu Docker containers? The 37.6MB binary likely has glibc dependencies. Need to verify.

2. **agent-rdp UI Automation latency** — The PowerShell agent communicates via DVC (Dynamic Virtual Channel). What's the latency for snapshot + click cycles? Needs benchmarking.

3. **Windows licensing for headless VM** — Running Windows VMs for agent automation requires proper licensing (Windows Server CALs or Azure VM licensing). This is a business/legal consideration.

4. **agent-rdp stability at scale** — v0.6.5 is recent. Production stability for long-running sessions (hours/days) is unknown. Need to test daemon restart behavior.

5. **Concurrent sessions from one Linux host** — Can multiple agent-rdp daemons run simultaneously (different sessions) connecting to different Windows machines? The session naming suggests yes, but untested.

6. **RemoteFX/GFX codec support in IronRDP** — Does IronRDP support modern graphics codecs for high-quality screenshots, or only legacy bitmap?

7. **agent-rdp's OCR engine (ocrs)** — Accuracy vs commercial OCR? May need fallback to vision model for complex UIs.
