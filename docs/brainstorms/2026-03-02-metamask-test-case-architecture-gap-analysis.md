# MetaMask Test Case: Architecture Gap Analysis

**Date:** 2026-03-02
**Status:** Complete
**Scope:** Step-by-step evaluation of the "Install MetaMask → Import Wallet → Connect to DApp → Verify Feature" test case against the Hybrid Docker+MCP architecture (Phased Rollout).

---

## Executive Summary

**Verdict: Our current plan CANNOT handle this test case in Phase 1. Phase 2+3 can handle it, but with significant gaps that aren't addressed in existing architecture documents.**

The MetaMask test case is a **perfect stress test** for our architecture because it hits every blind spot simultaneously:
- Browser extension loading (not standard web automation)
- Extension popup windows (separate browser contexts)
- Cross-context coordination (DApp page ↔ MetaMask popup)
- Security-hardened extension UI (LavaMoat, CSP)
- Sensitive data entry (private keys)

This is not an edge case. **Any Web3 testing, password manager testing, ad-blocker testing, or browser extension QA hits these same walls.** If we claim to offer "full PC-like workspaces," we must solve this class of problem.

---

## Step-by-Step Analysis

### Step 1: Open Chrome Browser

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ⚠️ PARTIAL | Playwright MCP auto-launches Chromium on first tool call. But it uses a **non-persistent default context** — extensions CANNOT be loaded in this mode. Playwright requires `launchPersistentContext()` with `--load-extension` flags. The MCP server's standard launch flow doesn't support this. |
| **xdotool + vision (Phase 3)** | ✅ YES | `xdotool` can launch any application: `chromium --load-extension=/path/to/metamask`. Full control over launch arguments. |
| **Human via noVNC** | ✅ YES | Click the Chromium icon or run from terminal. Trivial. |

**Gap identified:** Playwright MCP has no tool to configure browser launch arguments. The `browser_navigate` tool creates a default context. There is no `browser_launch_with_extensions` tool.

**Severity: BLOCKER for Phase 1**

---

### Step 2: Navigate to Chrome Web Store / Load MetaMask .crx

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ❌ NO | Playwright's bundled Chromium **does not support Chrome Web Store**. CWS requires Google's proprietary APIs. Even navigating to the store page works, but the "Add to Chrome" button is non-functional. The only path is side-loading via `--load-extension` at launch time — which MCP doesn't expose. |
| **xdotool + vision (Phase 3)** | ⚠️ PARTIAL | Can navigate to CWS, but the same Chromium limitation applies. However, xdotool can launch Chrome (not Chromium) if installed, or pre-install the extension via CLI: `chromium --load-extension=/opt/metamask-unpacked`. The Docker image can pre-bundle MetaMask. |
| **Human via noVNC** | ✅ YES | Can use Chrome Web Store if running Google Chrome (not Chromium). Or manually load unpacked extension via `chrome://extensions`. |

**Gap identified:** Extension installation is fundamentally a **container image build-time concern**, not a runtime automation concern. The correct approach is:
1. Download MetaMask release (.crx or unpacked) during Docker image build
2. Pre-install it in the container image
3. Launch Chromium with `--load-extension` pointing to the pre-installed path

**This means our Docker container image spec needs an "extension bundle" layer.** Not addressed in current architecture docs.

**Severity: BLOCKER — requires architecture change (build-time extension bundling)**

---

### Step 3: Install MetaMask Extension

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ❌ NO | See Step 2. Cannot install extensions at runtime. |
| **xdotool + vision (Phase 3)** | ✅ YES (with pre-bundling) | If MetaMask is pre-bundled in the Docker image and loaded via `--load-extension`, "installation" is automatic at browser launch. No runtime installation step needed. |
| **Human via noVNC** | ✅ YES | Manual installation works. |

**Design decision required:** Do we support **runtime** extension installation (agent decides to install MetaMask during task), or only **build-time** pre-bundling (container comes with MetaMask already installed)?

- Runtime installation = much harder, requires Chrome Web Store support or manual .crx handling
- Build-time bundling = simpler, deterministic, but less flexible

**Recommendation:** Build-time bundling with a **library of pre-built extension images**:
```
clawd-workspace:base          → No extensions
clawd-workspace:web3          → MetaMask + common Web3 tools
clawd-workspace:devtools      → React DevTools, Redux DevTools
clawd-workspace:testing       → Axe, Lighthouse CI extension
```

---

### Step 4: MetaMask Popup → "Get Started" → "Import Wallet"

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ❌ NO | MetaMask opens a **new tab** (`chrome-extension://<id>/home.html#onboarding/welcome`) after loading. Playwright MCP's `browser_snapshot` and `browser_click` operate on the **current active page**. The MCP server would need to: (1) detect the new tab, (2) switch to it, (3) take a snapshot of the extension page. The MCP server **does** have `browser_tab_list` and `browser_tab_select` tools — so tab switching IS possible. **HOWEVER**, accessibility tree snapshots of `chrome-extension://` pages may be incomplete due to MetaMask's LavaMoat security sandbox and Shadow DOM usage. |
| **xdotool + vision (Phase 3)** | ✅ YES | Screenshot the screen → vision model sees the MetaMask welcome page → identify "Get Started" button coordinates → `xdotool` click. Works regardless of DOM structure, Shadow DOM, or security policies — it sees pixels, not DOM. |
| **Human via noVNC** | ✅ YES | Click buttons visually. Trivial. |

**Gap identified:** Even IF Playwright MCP can switch to the extension tab, the accessibility tree of MetaMask's onboarding flow may be **incomplete or empty** because:
1. MetaMask uses Shadow DOM extensively
2. LavaMoat security sandbox may block Playwright's accessibility inspection
3. MetaMask's React-based UI generates accessibility attributes inconsistently

**This needs empirical testing.** We cannot assume it works based on architecture alone.

**Severity: HIGH RISK — requires proof-of-concept validation**

---

### Step 5: Accept Terms of Service

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ❌ UNLIKELY | Same as Step 4. Requires extension page accessibility tree to work. TOS pages often use scrollable containers with checkboxes — accessibility representation may not capture scroll state correctly. |
| **xdotool + vision (Phase 3)** | ✅ YES | Vision sees checkbox/button → xdotool clicks. May need to scroll — vision model identifies scroll needed → `xdotool key Page_Down` → re-screenshot → click "Accept". Multi-step but reliable. |
| **Human via noVNC** | ✅ YES | Scroll and click. Trivial. |

---

### Step 6: Enter Private Key in MetaMask's Input Field

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ❌ UNLIKELY | Even if the accessibility tree works on the extension page, MetaMask's private key input field uses **security-hardened input handling**. The input may: (a) not appear in the accessibility tree, (b) use custom input components that don't respond to Playwright's `browser_type` tool, (c) have paste protection or input filtering. |
| **xdotool + vision (Phase 3)** | ✅ YES | Vision identifies the input field → xdotool clicks it → `xdotool type "private_key_here"`. Works at the X11 input level — no DOM interaction. Bypasses all JavaScript-level input protections because the OS is literally typing keystrokes. |
| **Human via noVNC** | ✅ YES | Type directly. Trivial. |

**CRITICAL SECURITY CONCERN:** The agent has a private key in its context/memory. This means:
- Private keys must NEVER appear in logs
- Agent memory/context must be treated as sensitive
- The Docker container's filesystem must be ephemeral
- noVNC monitoring means a human COULD see the private key on screen

**This is a security architecture concern, not a technical automation concern.** Not addressed in current docs.

**Severity: SECURITY — requires sensitive data handling policy**

---

### Step 7: Set Password, Confirm

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ❌ UNLIKELY | Same extension page limitations as Steps 4-6. |
| **xdotool + vision (Phase 3)** | ✅ YES | Vision identifies password fields → xdotool types → clicks confirm. Standard flow. |
| **Human via noVNC** | ✅ YES | Trivial. |

---

### Step 8: MetaMask Is Now Configured

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ⚠️ VERIFICATION ONLY | Could potentially screenshot the extension page and use vision to verify "MetaMask is ready" text. But this is Phase 3 capability (vision), not Phase 1. |
| **xdotool + vision (Phase 3)** | ✅ YES | Screenshot → vision confirms MetaMask dashboard is visible with correct wallet address. |
| **Human via noVNC** | ✅ YES | Visual confirmation. |

---

### Step 9: Navigate to the DApp Website

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ✅ YES | `browser_navigate` to the DApp URL. Standard web navigation. This is Playwright's bread and butter. **HOWEVER** — the browser must ALREADY have MetaMask loaded. If Playwright MCP launched its own browser without `--load-extension`, MetaMask won't be there even if it was "installed" in the earlier steps. This is the fundamental disconnect. |
| **xdotool + vision (Phase 3)** | ✅ YES | Navigate via URL bar or xdotool keyboard shortcut. |
| **Human via noVNC** | ✅ YES | Type URL. Trivial. |

**Gap identified:** The **browser instance continuity** problem. Steps 1-8 configure MetaMask in a browser. Step 9 must use THE SAME browser instance. If Playwright MCP manages its own browser lifecycle (which it does), there's a disconnect between "the browser xdotool was controlling in Steps 1-8" and "the browser Playwright MCP controls in Step 9."

**This is a critical orchestration gap.** Two automation systems cannot share the same browser instance unless explicitly designed to do so.

**Severity: ARCHITECTURE — requires single browser instance shared between automation layers**

---

### Step 10: Click "Connect Wallet" on the DApp

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ✅ YES | `browser_snapshot` → find "Connect Wallet" button → `browser_click`. Standard web interaction. The DApp page IS a normal web page. Accessibility tree works fine here. |
| **xdotool + vision (Phase 3)** | ✅ YES | Vision identifies button → xdotool clicks. |
| **Human via noVNC** | ✅ YES | Click button. Trivial. |

**No gap.** But this step TRIGGERS Step 11, which is where things break again.

---

### Step 11: MetaMask Popup Appears Asking to Approve Connection

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ❌ NO — THIS IS THE HARDEST STEP | When the DApp calls `window.ethereum.request({ method: 'eth_requestAccounts' })`, MetaMask opens a **notification popup window**. This is NOT a new tab — it's a new browser window (`chrome-extension://<id>/notification.html`). Playwright MCP's behavior here is UNDEFINED. The `browser_tab_list` tool may not see it (it's a window, not a tab). The `browser_snapshot` tool is scoped to the current page. There is no `browser_window_list` or `browser_switch_window` tool in Playwright MCP. Even if the popup appears as a new page in the context, MetaMask's notification popup uses aggressive CSP and LavaMoat, making accessibility tree extraction unreliable. |
| **xdotool + vision (Phase 3)** | ✅ YES | This is where vision SHINES. Screenshot shows the popup window floating over the DApp. Vision model identifies "Connect" button in the popup. `xdotool` clicks at those coordinates. It doesn't matter that it's a separate window, extension popup, or has CSP — it's just pixels on the screen and the X11 desktop renders all windows to the same framebuffer. |
| **Human via noVNC** | ✅ YES | Click "Connect" in the popup. Trivial. |

**This is the single biggest gap in the entire analysis.** Cross-window extension popup interaction is:
- Unsupported by Playwright MCP's tool surface
- Unreliable even with raw Playwright API due to security hardening
- Perfectly natural for vision+xdotool (it just sees the screen)
- Perfectly natural for humans

**Severity: BLOCKER — fundamental capability gap in Playwright MCP for extension popups**

---

### Step 12: Click "Connect" in MetaMask Popup

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ❌ NO | Same as Step 11. Cannot interact with extension popup window. |
| **xdotool + vision (Phase 3)** | ✅ YES | Click the "Connect" button in the popup. Straightforward vision+click. |
| **Human via noVNC** | ✅ YES | Trivial. |

---

### Step 13: Verify "Feature A" Works

| Approach | Can Handle? | Details |
|----------|------------|---------|
| **Playwright MCP (Phase 1)** | ✅ PARTIAL | IF we're now back on the DApp page (after MetaMask connection), Playwright MCP can snapshot the page and verify text/elements. For visual verification, it can screenshot and send to vision model (but that's Phase 3 capability). For text-based assertions, accessibility tree works. |
| **xdotool + vision (Phase 3)** | ✅ YES | Screenshot → vision model analyzes → confirms Feature A is visible/working. |
| **Human via noVNC** | ✅ YES | Visual confirmation. Trivial. |

---

## Capability Matrix Summary

| Step | Description | Playwright MCP (Phase 1) | xdotool+Vision (Phase 3) | Human (noVNC) |
|------|-------------|--------------------------|--------------------------|---------------|
| 1 | Open Chrome | ⚠️ PARTIAL (no extension args) | ✅ | ✅ |
| 2 | Load MetaMask | ❌ BLOCKED | ✅ (pre-bundled) | ✅ |
| 3 | Install extension | ❌ BLOCKED | ✅ (pre-bundled) | ✅ |
| 4 | Onboarding: Get Started | ❌ UNLIKELY | ✅ | ✅ |
| 5 | Accept TOS | ❌ UNLIKELY | ✅ | ✅ |
| 6 | Enter private key | ❌ UNLIKELY | ✅ | ✅ |
| 7 | Set password | ❌ UNLIKELY | ✅ | ✅ |
| 8 | Verify configured | ⚠️ NEEDS VISION | ✅ | ✅ |
| 9 | Navigate to DApp | ✅ (if same browser) | ✅ | ✅ |
| 10 | Click Connect Wallet | ✅ | ✅ | ✅ |
| 11 | MetaMask popup appears | ❌ BLOCKED | ✅ | ✅ |
| 12 | Click Connect in popup | ❌ BLOCKED | ✅ | ✅ |
| 13 | Verify Feature A | ✅ PARTIAL | ✅ | ✅ |

**Playwright MCP Phase 1 success rate: 2-3 out of 13 steps (15-23%)**
**xdotool + Vision Phase 3 success rate: 13 out of 13 steps (100%)**
**Human via noVNC: 13 out of 13 steps (100%)**

---

## Identified Architecture Gaps

### Gap 1: No Extension-Aware Browser Launch (BLOCKER)

**Problem:** Playwright MCP launches browsers with default context. No mechanism to pass `--load-extension` flags.

**Required:** Either:
- (a) A custom Playwright MCP server fork that accepts launch arguments, or
- (b) A separate "browser launcher" MCP tool that starts Chromium with extensions, and then Playwright MCP connects to the already-running browser via CDP (Chrome DevTools Protocol), or
- (c) Skip Playwright MCP entirely for extension workflows and use xdotool+vision from the start

**Recommendation:** Option (b) — a `workspace_launch_browser` MCP tool that starts Chromium with configured extensions and returns the CDP endpoint. Playwright MCP (or raw CDP) then connects to it.

### Gap 2: No Extension Popup Window Handling (BLOCKER)

**Problem:** Playwright MCP has no tools for detecting, listing, or interacting with browser popup windows (as opposed to tabs). Extension notification popups are windows, not tabs.

**Required:** Either:
- (a) New MCP tools: `browser_window_list`, `browser_window_select`, `browser_window_snapshot`, or
- (b) Automatic popup detection and forwarding (like Synpress does internally), or
- (c) Fall back to vision+xdotool for ALL extension popup interactions

**Recommendation:** Option (c) for pragmatism. Extension popups are inherently unreliable via DOM-based automation. Vision is the correct tool for this job.

### Gap 3: No Cross-Automation-Layer Browser Sharing (ARCHITECTURE)

**Problem:** If Steps 1-8 use xdotool+vision (because Playwright can't handle extensions) and Steps 9-13 should use Playwright MCP (because it's cheaper for web pages), they need to share the same browser instance. Currently, nothing in the architecture supports this.

**Required:** A shared browser instance model:
1. Container launches Chromium with extensions at startup
2. Chromium exposes CDP on a known port (e.g., `--remote-debugging-port=9222`)
3. Playwright MCP connects via CDP to the running browser (not launching its own)
4. xdotool operates on the same browser's X11 window
5. Both automation layers see the same state

**This is the most important architectural decision.** Without it, the hybrid approach cannot work for mixed workflows.

### Gap 4: No Build-Time Extension Bundling (INFRASTRUCTURE)

**Problem:** Extension installation cannot be reliably automated at runtime. Extensions must be pre-bundled in the Docker image.

**Required:**
- Docker image build pipeline that downloads and packages extensions
- Extension version pinning and update mechanism
- Multiple image variants (base, web3, devtools, etc.)
- Extension configuration (network settings, default accounts) as container environment variables

### Gap 5: No Sensitive Data Handling Policy (SECURITY)

**Problem:** The agent will handle private keys, seed phrases, and passwords. The current architecture has no concept of "sensitive data that must not be logged."

**Required:**
- Sensitive parameter masking in agent logs
- Ephemeral container filesystems (no private key persists after task)
- noVNC session recording policies (don't record wallet setup)
- Secure secret injection (environment variables or vault, not in task description)

### Gap 6: Playwright MCP Doesn't Support Persistent Context Mode (TECHNICAL)

**Problem:** Playwright's `launchPersistentContext()` is REQUIRED for extension support. The Playwright MCP server uses default browser context. Even if we solve every other gap, this fundamental API mismatch means Playwright MCP cannot interact with extensions AT ALL in its current form.

**Required:** Either fork Playwright MCP to support persistent context launch, or accept that Playwright MCP is web-only and extensions are vision-only.

---

## Revised Architecture Proposal for Extension Workflows

```
┌─────────────────────────────────────────────────────────────┐
│              Agent Container (Extension-Aware)               │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Container Entrypoint:                                  │ │
│  │  1. Start Xvfb :99                                      │ │
│  │  2. Start window manager (fluxbox)                      │ │
│  │  3. Start Chromium with:                                │ │
│  │     --load-extension=/opt/extensions/metamask           │ │
│  │     --remote-debugging-port=9222                        │ │
│  │     --display=:99                                       │ │
│  │  4. Start noVNC → x11vnc → :99                          │ │
│  │  5. Start workspace MCP server                          │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌──────────────────┐  ┌─────────────────────────────────┐  │
│  │ Workspace MCP     │  │ Playwright (CDP-connected)       │  │
│  │ Server            │  │                                   │  │
│  │                   │  │ Connects to localhost:9222        │  │
│  │ Tools:            │  │ (does NOT launch own browser)     │  │
│  │  screenshot()     │  │                                   │  │
│  │  click(x,y)       │  │ Tools:                            │  │
│  │  type(text)       │  │  browser_snapshot (a11y tree)     │  │
│  │  launch_app()     │  │  browser_click (ref-based)        │  │
│  │  get_windows()    │  │  browser_type (text input)        │  │
│  │  key_combo()      │  │  browser_navigate                 │  │
│  └──────┬───────────┘  └──────────┬──────────────────────┘  │
│         │ xdotool/scrot            │ CDP protocol             │
│         └───────────┬──────────────┘                         │
│                     │                                        │
│  ┌──────────────────▼─────────────────────────────────────┐ │
│  │            Chromium (single shared instance)             │ │
│  │  Extensions: MetaMask, React DevTools, etc.              │ │
│  │  CDP: localhost:9222                                     │ │
│  │  Display: :99                                            │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  Agent Decision Logic:                                       │
│    IF target is regular web page:                            │
│      → Use Playwright MCP (cheap, deterministic)             │
│    IF target is extension popup / native UI / unknown:       │
│      → Use workspace MCP screenshot+vision+xdotool           │
│    IF needs verification:                                    │
│      → screenshot → read_image → assert                      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Key Changes from Current Architecture:

1. **Single Chromium instance** launched by container entrypoint, not by Playwright MCP
2. **Playwright connects via CDP** to the existing browser (using `browserType.connectOverCDP()`)
3. **Extensions pre-bundled** in Docker image and loaded at launch
4. **Two MCP servers share one browser** — Playwright for web pages, workspace MCP for everything else
5. **Agent routing logic** decides which MCP to use per-step based on target type

---

## Revised Test Case Execution Flow

With the proposed architecture, here's how the MetaMask test case would actually work:

| Step | Automation Layer | Why |
|------|-----------------|-----|
| 1. Open Chrome | Container entrypoint (automatic) | Browser pre-launched with extensions |
| 2-3. Load/Install MetaMask | Container image build (automatic) | Pre-bundled in Docker image |
| 4-7. MetaMask onboarding | **Workspace MCP (vision+xdotool)** | Extension UI — vision only |
| 8. Verify configured | **Workspace MCP (vision)** | Screenshot + vision assertion |
| 9. Navigate to DApp | **Playwright MCP (a11y tree)** | Standard web navigation — cheap |
| 10. Click Connect Wallet | **Playwright MCP (a11y tree)** | Standard web button — cheap |
| 11-12. MetaMask popup | **Workspace MCP (vision+xdotool)** | Extension popup — vision only |
| 13. Verify Feature A | **Playwright MCP (a11y tree)** | Back on DApp page — cheap |

**Cost estimate per full run:**
- Steps 4-8 (vision): 5 screenshot+action cycles × $0.10 = ~$0.50
- Steps 9-10 (a11y): 2 actions × $0.04 = ~$0.08
- Steps 11-12 (vision): 2 screenshot+action cycles × $0.10 = ~$0.20
- Step 13 (a11y): 1 action × $0.04 = ~$0.04
- **Total: ~$0.82 per full test run**

For comparison:
- Pure vision approach: 13 steps × $0.10 = ~$1.30
- Hybrid saves ~37% on token costs

---

## What Synpress Teaches Us

Synpress (the most mature MetaMask automation library) solves this by:
1. Pre-loading MetaMask as an unpacked extension at browser launch
2. Extracting the extension ID from the service worker URL
3. Navigating directly to `chrome-extension://<id>/popup.html` instead of waiting for popups
4. Using Playwright's `context.waitForEvent('page')` to catch notification windows
5. Wrapping all MetaMask interactions in a `MetaMask` class with retry logic

**What we can steal from Synpress:**
- Extension ID extraction pattern → bake into workspace MCP server
- Direct navigation to extension pages instead of waiting for popup windows
- Pre-configured wallet state (skip onboarding entirely for known test wallets)

**What we CANNOT steal from Synpress:**
- It's a JavaScript library, not an MCP server
- It requires programmatic Playwright API access (not MCP tool calls)
- It hardcodes MetaMask-specific selectors that break on updates

**Implication:** We may need a **"Web3 Testing MCP Server"** that wraps Synpress-like logic and exposes it as MCP tools:
- `metamask_import_wallet(private_key)`
- `metamask_connect_dapp()`
- `metamask_confirm_transaction()`
- `metamask_switch_network(chain_id)`

This would be a Phase 2.5 addition — specialized MCP servers for specific extension workflows.

---

## Honest Assessment: Can We Do This Today?

| Phase | Can Complete Test Case? | What's Missing? |
|-------|------------------------|-----------------|
| **Phase 1 (Playwright MCP only)** | ❌ NO (15% of steps) | Extensions fundamentally unsupported |
| **Phase 2 (Docker + workspace MCP)** | ⚠️ MOSTLY (with vision) | Needs CDP browser sharing, extension bundling |
| **Phase 3 (Vision loop)** | ✅ YES (100% of steps) | But expensive ($0.82-1.30/run) and slow (~60-120s) |
| **Phase 2.5 (Specialized extension MCP)** | ✅ YES (cheaper, faster) | New capability not in current roadmap |

**Bottom line:**
- Phase 1 is **useless** for this test case. Don't pretend otherwise.
- Phase 3 is **necessary** for extension workflows. It cannot be "deferred to later" — it's required for any non-trivial browser testing.
- The **hybrid routing** (Playwright for web pages, vision for extension UIs) is the correct final architecture, but requires the **shared browser instance via CDP** design that isn't in current docs.

---

## Recommendations

### Immediate (This Week)
1. **Accept the limitation.** Document that Phase 1 (Playwright MCP) covers web-only automation. Extension workflows require Phase 2+3.
2. **Prototype the CDP connection pattern.** Can Playwright MCP connect to an already-running browser via CDP? This is the critical experiment.

### Short-Term (Phase 2 Scope)
3. **Design the extension-aware Docker image.** Build-time extension bundling, launch arguments, CDP exposure.
4. **Implement shared browser architecture.** Container entrypoint launches Chromium; both Playwright and xdotool share it.
5. **Add sensitive data handling.** Log masking, ephemeral state, secret injection.

### Medium-Term (Phase 2.5)
6. **Build specialized extension MCP servers.** Start with MetaMask (biggest demand). Wrap Synpress-like automation as MCP tools.
7. **Create extension workflow templates.** Pre-built agent prompt patterns for common extension tasks.

### Long-Term (Phase 3 Refinement)
8. **Optimize vision pipeline.** Region-of-interest capture, cached element positions, smart retry logic.
9. **Build regression test suite.** The MetaMask test case becomes a standing regression test for the workspace architecture.

---

## Conclusion

This test case **exposes a fundamental truth**: browser extensions are a **different class of automation target** than web pages. Our Phase 1 architecture (Playwright MCP) was designed for web pages and works well for that. But claiming "browser control" without extension support is like claiming "file system control" without write permissions — technically true, practically incomplete.

The good news: our hybrid architecture was DESIGNED for this exact scenario. The bad news: the bridge between "Playwright handles web pages" and "vision handles everything else" requires infrastructure (shared browser via CDP, extension bundling, cross-layer coordination) that doesn't exist yet.

**The MetaMask test case should become our canonical "Phase 2 acceptance test."** If the workspace can complete this test case end-to-end autonomously, Phase 2 is done.
