# Evaluation: Pure MCP Approach for Agent Workspaces

**Date:** 2026-03-01
**Evaluator:** Solution Brainstormer
**Subject:** Playwright MCP + Chrome DevTools MCP + mcp-desktop-pro (no containers, host-only)
**Verdict:** 4/10 — Wrong tool for the stated requirement

---

## Problem Statement

**Requirement:** Give each Claw'd agent a FULL working environment (like a PC) where it controls mouse, keyboard, screen — like a real human completing tasks.

**Proposed Solution:** Pure MCP stack running on the host:
- **Playwright MCP** — browser automation via accessibility tree
- **Chrome DevTools MCP** — browser debugging (network, console, performance)
- **mcp-desktop-pro** — desktop control (mouse, keyboard, screenshots, windows)

---

## PRO-BY-PRO ARGUMENT

### ✅ PRO 1: Accessibility Tree — ~$0.01/action, 93% token savings vs screenshots

**Verdict: TRUE, but overstated.**

The numbers are real and compelling:
- Accessibility tree snapshots: **3–20K tokens** per page
- Screenshot + vision model: **10–100K+ tokens** per page
- That's a **51–79% reduction** in practice, up to 4x in optimized CLI mode

**But here's what people miss:** This advantage is *browser-only*. The requirement says "full working environment like a PC." The moment an agent needs to interact with a native desktop app (file manager, IDE, terminal UI, system settings), the accessibility tree gives you **nothing**. You fall back to mcp-desktop-pro's screenshot pipeline, which uses vision models — wiping out your token savings for non-browser tasks.

**Real cost model:**
- Pure web tasks: ~$0.01/action ✅
- Desktop tasks (screenshots): ~$0.05–0.15/action ❌
- Mixed workflows: Weighted average, no longer "93% savings"

**Score for this pro: 8/10** — Genuinely excellent for browser-only workloads. Misleading for "full PC" claims.

---

### ✅ PRO 2: Playwright MCP — Deterministic, robust, no vision model needed for web

**Verdict: TRUE and legitimately strong.**

Playwright MCP uses semantic selectors (role-based references like "button named Submit") instead of pixel coordinates. This means:
- No vision model latency or cost
- No coordinate drift when layouts change
- Deterministic: same action → same result
- Works with any text-only LLM (no multimodal requirement)

**Counter-argument:** Determinism breaks on:
- Canvas/WebGL content (games, complex visualizations)
- Custom-rendered UIs (Figma, Google Docs editor surface)
- Shadow DOM components with poor accessibility attributes
- SPAs with aggressive lazy loading where tree is incomplete

**For standard web apps (forms, dashboards, CRUD), this is genuinely best-in-class.**

**Score for this pro: 9/10** — Hard to argue against for web automation.

---

### ✅ PRO 3: Zero container overhead — MCP servers are lightweight Node.js processes

**Verdict: TRUE, and this is where the trap lives.**

Yes, MCP servers are lightweight:
- ~30–80MB RAM per server
- Sub-second startup
- No Docker daemon, no VM, no kernel overhead

**But "lightweight" is the wrong metric when the requirement is isolation.** The reason Docker containers exist isn't because people love overhead — it's because you need to give each agent its own isolated filesystem, network, process space, and display server. "Zero overhead" means "zero isolation."

A Docker + XFCE + noVNC container costs:
- ~256–512MB RAM
- ~2–5s startup
- Full isolation (own X server, own filesystem, own network namespace)

For a system meant to run multiple agents concurrently, the extra 200MB RAM per agent is **trivially cheap** compared to the security and correctness guarantees you get.

**Score for this pro: 5/10** — True statement, wrong optimization target.

---

### ✅ PRO 4: Claw'd ALREADY supports MCP — zero code changes needed

**Verdict: TRUE, and this is the strongest argument.**

From the codebase analysis:
- `MCPManager` class already handles multiple MCP servers
- Stdio transport spawns MCP servers as subprocesses
- HTTP transport supports remote servers
- MCP tools are auto-converted to OpenAI function format
- Config lives in `~/.clawd/config.json` — just add entries

This means you could add Playwright MCP in **under 5 minutes**:
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@anthropic/playwright-mcp"],
      "transport": "stdio"
    }
  }
}
```

**No code changes. No PR. No deploy cycle.** That's genuinely powerful for rapid iteration.

**But:** "Easy to add" ≠ "right architecture." It's also easy to `rm -rf /`. The question isn't "can we?" — it's "should we?"

**Score for this pro: 9/10** — Real operational advantage for prototyping and Phase 1.

---

### ✅ PRO 5: Multi-agent — can multiple agents share one browser session?

**Verdict: TECHNICALLY POSSIBLE, PRACTICALLY TERRIBLE.**

Playwright MCP can manage multiple browser contexts (tabs, profiles) within one browser instance. So technically, Agent A gets Tab 1 and Agent B gets Tab 2.

**Why this falls apart:**
1. **Single process, shared resources:** One browser crash kills all agents
2. **Cookie/storage bleed:** Even with separate contexts, some state leaks (extensions, DNS cache, proxy settings)
3. **Resource contention:** 10 agents in one Chrome instance = memory pressure, GC pauses affecting all
4. **No isolation guarantee:** A malicious or buggy website in Agent A's tab can potentially access Agent B's data via browser exploits
5. **Debugging nightmare:** Which agent caused that Chrome OOM?

**The right model is one browser per agent, in separate containers.** That's what every production system (Browserbase, ScreenEnv, Cursor Cloud Agents) does.

**Score for this pro: 3/10** — Works for demos. Breaks in production.

---

## CON-BY-CON ARGUMENT

### ❌ CON 1: NOT a full workspace — agents don't get "their own PC"

**Verdict: THIS IS THE FATAL FLAW.**

The requirement literally says "like a PC." Let's check what a PC provides:

| Capability | Real PC | Pure MCP |
|---|---|---|
| Own filesystem | ✅ | ❌ Shares host |
| Own network | ✅ | ❌ Shares host |
| Own display server | ✅ | ❌ Shares host |
| Install software | ✅ | ❌ Affects host |
| Own process space | ✅ | ❌ Shares host |
| Persistent state | ✅ | ⚠️ Partial |
| Survive crashes independently | ✅ | ❌ Shared browser |
| Run arbitrary apps | ✅ | ❌ Browser only |

**The pure MCP approach delivers maybe 20% of what "like a PC" means.** It gives you a browser remote control and a dangerous desktop clicker. That's not a workspace — it's a browser extension with system-level side effects.

**Severity: CRITICAL** — This is a requirements mismatch, not a technical limitation to work around.

---

### ❌ CON 2: mcp-desktop-pro controls the HOST desktop — dangerous

**Verdict: THIS IS A SECURITY SHOWSTOPPER.**

From the research:
- mcp-desktop-pro requires **system-level permissions** for screen capture and input control
- It operates on the **primary display** of the host machine
- It inherits the **host user's privileges**

What this means in practice:
- Agent can click on ANY window on your desktop (email, banking, admin panels)
- Agent can read ANY visible content via screenshots (passwords, tokens, PII)
- Agent can type into ANY focused application
- **Claw'd's existing sandbox (bubblewrap/seatbelt) does NOT cover MCP servers** — they run outside the sandbox

From the Claw'd research doc itself: *"MCP servers currently run unsandboxed outside Claw'd's sandbox, inheriting full environment access."*

**This is not a theoretical risk. This is a certainty.** Any prompt injection, hallucination, or tool misuse gives the agent full desktop access as the current user.

**Severity: CRITICAL** — Unacceptable for any multi-tenant or production deployment.

---

### ❌ CON 3: No isolation between agents

**Verdict: CONFIRMED DEALBREAKER FOR MULTI-AGENT.**

With pure MCP on host:
- All agents see the same screen
- All agents share the same mouse cursor
- All agents share the same keyboard focus
- Agent A's browser tabs are visible to Agent B's screenshots
- Agent A can accidentally close Agent B's window

There is exactly ONE mouse cursor and ONE keyboard focus on a host. Period. No amount of MCP protocol cleverness changes this physical constraint.

**The only solutions are:**
1. **Serialize all agents** (one at a time) — defeats the purpose of multi-agent
2. **Virtual desktops per agent** (Docker + Xvfb) — but then you're not "pure MCP" anymore
3. **Time-sliced locking** — fragile, slow, and complex to implement correctly

**Severity: CRITICAL** — Multi-agent on shared host desktop is architecturally broken.

---

### ❌ CON 4: Cannot install software, change system settings, or run arbitrary apps

**Verdict: TRUE, and this is the "PC" requirement failing again.**

A real workspace lets an agent:
- `apt install python3-opencv` → Not safe on host
- Configure a dev server on port 3000 → Port conflicts between agents
- Run a database for testing → State pollution
- Modify `.bashrc`, env vars → Affects all agents

Pure MCP gives you: "click this button in Chrome." That's it.

**Severity: HIGH** — Depends on use case. If agents only do web browsing, this doesn't matter. If they need to "work like a human on a PC," it's disqualifying.

---

### ❌ CON 5: Playwright only works for web content

**Verdict: TRUE, with nuance.**

Playwright MCP is superb at web. But "full working environment" implies:
- IDE usage (VS Code, IntelliJ)
- File manager operations
- Terminal/shell interactions
- Office applications
- System configuration

For these, you fall back to mcp-desktop-pro's screenshot + click approach, which is:
- Expensive (vision model per screenshot)
- Fragile (pixel coordinates break on resolution/theme changes)
- Slow (screenshot → vision → reasoning → action loop)
- Dangerous (operates on host, see CON 2)

**The accessibility tree advantage vanishes for 100% of non-browser work.**

**Severity: HIGH** — Narrows the solution to "web-only agent" which contradicts the requirement.

---

### ❌ CON 6: MCP servers run OUTSIDE the sandbox

**Verdict: CONFIRMED FROM CODEBASE ANALYSIS.**

Claw'd has a production-grade sandbox (`src/agent/src/utils/sandbox.ts`):
- Linux: bubblewrap (namespace isolation)
- macOS: sandbox-exec (seatbelt profiles)
- Denies writes outside projectRoot, /tmp, ~/.clawd
- Wipes environment, rebuilds with safe vars

**But MCP servers are spawned as stdio subprocesses outside this sandbox.** The `MCPManager` in `src/agent/src/mcp/client.ts` spawns them as regular Node.js processes with full host access.

This means:
- Sandbox protects `bash`, `git`, `grep`, `view`, `edit` → ✅
- Sandbox does NOT protect Playwright MCP, mcp-desktop-pro → ❌

**Any MCP tool call bypasses all of Claw'd's security guarantees.**

**Severity: CRITICAL** — The security model has a hole exactly where the most dangerous tools live.

---

### ❌ CON 7: Multi-agent collision on shared screen

**Verdict: UNSOLVABLE WITHOUT ISOLATION.**

Two agents. One screen. One cursor. The math doesn't work.

```
Agent A: "Click button at (450, 300)"
Agent B: "Click button at (800, 500)"
OS receives: Two rapid mouse moves + clicks
Result: Unpredictable — depends on timing, OS event queue, window manager
```

Solutions tried by the industry:
- **MouseMux** (Windows only, not Linux/macOS)
- **TwinDesktop** (separate virtual desktops — i.e., containers)
- **Action queuing** (serialize agents — defeats parallelism)
- **Window targeting** (MCP targets specific windows — but still one cursor)

**Every real solution to this problem involves giving each agent its own display server.** Which means Docker + Xvfb/Xvnc. Which means you're not doing "pure MCP on host" anymore.

**Severity: CRITICAL** — Fundamental physics of desktop I/O, not a software bug.

---

## VERDICT

### Score: 4/10

### Why not lower?
The Playwright MCP component is genuinely excellent technology. For **browser-only, single-agent** web automation, this stack is actually **best-in-class**. The accessibility tree approach is a real innovation that saves tokens, improves reliability, and works without vision models. Claw'd's existing MCP infrastructure makes integration trivial. As a **Phase 1 prototype** for web automation, it's a smart starting point.

### Why not higher?
Because the requirement is **"full working environment like a PC"** and this solution delivers **"browser remote control on a shared host."** That's a fundamental requirements mismatch. The security implications of mcp-desktop-pro on host are unacceptable. The multi-agent collision problem is unsolvable without isolation. The desktop automation falls back to expensive, fragile screenshot pipelines.

### The Honest Summary

| Dimension | Score | Notes |
|---|---|---|
| Browser automation | 9/10 | Best-in-class with Playwright MCP |
| Desktop automation | 2/10 | Dangerous, fragile, expensive |
| Agent isolation | 1/10 | None. Shared everything. |
| Security | 2/10 | MCP servers bypass sandbox |
| Multi-agent support | 1/10 | Physically impossible on shared screen |
| Token efficiency | 8/10 | For web only; desktop wipes gains |
| Integration effort | 10/10 | Zero code changes needed |
| Production readiness | 2/10 | Demo-grade, not production-grade |
| **Requirement match** | **3/10** | **"PC-like workspace" ≠ "browser clicker"** |

---

## WHAT SHOULD BE DONE INSTEAD

### The Right Architecture: Hybrid (MCP-inside-Container)

```
┌─────────────────────────────────────────────┐
│  Per-Agent Docker Container                  │
│  ┌────────────┐  ┌──────────────────────┐   │
│  │ Xvfb/Xvnc  │  │ Playwright MCP       │   │
│  │ (own display│  │ (accessibility tree) │   │
│  │  server)    │  │                      │   │
│  └──────┬──────┘  └──────────┬───────────┘   │
│         │                    │               │
│  ┌──────┴──────┐  ┌─────────┴────────────┐  │
│  │ Desktop env  │  │ Chrome DevTools MCP  │  │
│  │ (XFCE/i3)   │  │                      │  │
│  └─────────────┘  └──────────────────────┘  │
│                                              │
│  Own filesystem, network, process space      │
│  noVNC for human monitoring                  │
└──────────────────────────┬───────────────────┘
                           │ MCP stdio/HTTP
                    ┌──────┴──────┐
                    │ Claw'd Agent │
                    │ (host)       │
                    └─────────────┘
```

**This gives you:**
- ✅ Playwright MCP's token efficiency (accessibility tree inside container)
- ✅ Full desktop isolation per agent
- ✅ Safe desktop control (mcp-desktop-pro inside container, not on host)
- ✅ Multi-agent parallelism (each agent has own screen, cursor, keyboard)
- ✅ Human monitoring via noVNC
- ✅ Software installation without host pollution
- ✅ Claw'd's MCP infrastructure unchanged (just point at container's MCP endpoint)
- ⚠️ ~256–512MB RAM per agent (acceptable trade-off)
- ⚠️ ~2–5s container startup (acceptable for workspace-class tasks)

### Recommended Phased Approach

1. **Phase 1 (Now):** Add Playwright MCP to Claw'd config. Zero changes. Single-agent web automation works immediately. Use this to validate the agent loop and tool integration.

2. **Phase 2 (Next):** Build a Docker container image with Xvfb + XFCE + Playwright MCP + noVNC. Claw'd agent connects to the container's MCP endpoint over HTTP instead of stdio.

3. **Phase 3 (Later):** Add mcp-desktop-pro INSIDE the container for native app automation. Agent can now control desktop apps safely within its own sandbox.

4. **Phase 4 (Scale):** Container orchestration (Docker Compose or K8s) for multi-agent workspace management with resource limits, auto-cleanup, and persistent storage volumes.

---

## BOTTOM LINE

**Pure MCP on host is the right Phase 1 prototype for browser-only tasks.**
**It is the wrong architecture for "full PC-like workspaces."**
**The answer is MCP-inside-containers — you get both the token efficiency AND the isolation.**

Don't choose between "lightweight but dangerous" and "heavy but safe." Choose "lightweight inside safe."
