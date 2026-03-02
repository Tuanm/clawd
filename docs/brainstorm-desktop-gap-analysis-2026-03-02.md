# Desktop Gap Analysis: What Human Office Workers Do That Our Plan Can't Handle

**Date:** 2026-03-02
**Status:** Complete
**Context:** Systematic enumeration of gaps between our Phase 1-3 architecture and real human office worker PC usage.

---

## Architecture Baseline (What We Have)

| Phase | Capabilities | Control Method |
|-------|-------------|----------------|
| **Phase 1** | CLI tools (bash, git, files) + Playwright MCP (browser a11y tree) | Structured data, deterministic |
| **Phase 2** | Docker container: Xvfb + fluxbox/XFCE + xdotool + scrot + noVNC + Playwright MCP | Programmatic X11 control |
| **Phase 3** | Vision-based control: screenshot → vision model → xdotool actions | Pixel-based, probabilistic |

**Fallback chain:** CLI → Playwright MCP (a11y tree) → AT-SPI2 (native a11y) → Vision (screenshot)

---

## Gap Summary Table

| # | Gap | Category | Rating | Phase That Addresses It | Residual Gap? |
|---|-----|----------|--------|------------------------|---------------|
| 1 | Browser extensions (MetaMask, 1Password, etc.) | Extensions | **IMPORTANT** | Phase 2+3 partial | YES — no a11y tree for extension popups |
| 2 | Extension background scripts/service workers | Extensions | NICE-TO-HAVE | None | YES |
| 3 | Native desktop apps (Slack, Discord, Figma) | Native Apps | **IMPORTANT** | Phase 2+3 | YES — Linux versions only, vision-only control |
| 4 | Office suites (Microsoft 365 desktop, Google Docs offline) | Native Apps | **IMPORTANT** | Phase 2+3 partial | YES — MS Office is Windows-only native |
| 5 | VS Code / IDE GUI interactions | Native Apps | NICE-TO-HAVE | Phase 1 (CLI/LSP) | NO — CLI covers 95%+ |
| 6 | WiFi/VPN/proxy configuration | System Settings | **CRITICAL** | Phase 2 partial | YES — Docker network is host-managed |
| 7 | Display settings / resolution changes | System Settings | NICE-TO-HAVE | Phase 2 | NO — Xvfb resolution is configurable |
| 8 | Multi-window management (side-by-side, tiling) | Multi-Window | **IMPORTANT** | Phase 2+3 | YES — xdotool can move windows but vision can't reliably parse two windows |
| 9 | Drag between applications | Multi-Window | **IMPORTANT** | Phase 3 partial | YES — drag-and-drop is multi-step, fragile |
| 10 | File drag-and-drop (into browser, between apps) | File Mgmt | **IMPORTANT** | Phase 2 partial | YES — no native drag events |
| 11 | Native file dialogs (Open/Save As) | File Mgmt | **CRITICAL** | Phase 2+3 | YES — OS-native dialogs, no a11y tree |
| 12 | Clipboard across applications | Clipboard | **CRITICAL** | Phase 2 | Mostly NO — solvable with xclip |
| 13 | Rich clipboard (images, formatted text, files) | Clipboard | **IMPORTANT** | Phase 2 partial | YES — xclip handles text, not rich objects |
| 14 | OAuth popup flows | Auth | **IMPORTANT** | Phase 1 (Playwright) | Mostly NO — Playwright handles popups |
| 15 | TOTP-based 2FA | Auth | **CRITICAL** | None built-in | YES — need TOTP secret + code generation |
| 16 | Biometric authentication | Auth | NICE-TO-HAVE | None | YES — impossible in Docker |
| 17 | Hardware security keys (YubiKey, FIDO2) | Auth/Hardware | **IMPORTANT** | None | YES — no USB passthrough |
| 18 | Screen recording / video capture | Audio/Video | **IMPORTANT** | Phase 2 partial | YES — can record Xvfb but no audio |
| 19 | Video calls (Zoom, Meet, Teams) | Audio/Video | **CRITICAL** | None | YES — no mic/camera/audio |
| 20 | Audio playback / verification | Audio/Video | **IMPORTANT** | None | YES — no audio subsystem |
| 21 | Printers | USB/Hardware | NICE-TO-HAVE | None | YES — irrelevant for AI agents |
| 22 | External drives / USB storage | USB/Hardware | NICE-TO-HAVE | Phase 2 (volume mounts) | Mostly NO |
| 23 | Desktop notifications / toast messages | Notifications | **IMPORTANT** | Phase 2+3 | YES — notifications vanish, hard to capture |
| 24 | System tray / status icons | Notifications | **IMPORTANT** | Phase 3 only | YES — vision-only, small targets |

---

## Detailed Analysis by Category

---

### 1. Browser Extensions

#### Gap 1.1: Extension Popup Interaction — **IMPORTANT**

**The problem:** MetaMask, 1Password, uBlock Origin, React DevTools — all operate through extension popups that exist outside the DOM. Playwright MCP can automate page content but **cannot access extension popup contexts**. The a11y tree only covers the page, not browser chrome.

**What a human does:** Clicks the extension icon in the toolbar, interacts with the popup (approve transaction, fill password, configure settings).

**What our agent can do:**
- Phase 1: ❌ Playwright can't reach extension popups
- Phase 2: ⚠️ Can load extensions via `--load-extension` flag, but can't interact programmatically
- Phase 3: ✅ Vision can screenshot the popup and click coordinates — but extension popups are small, dense UI with tiny buttons. Accuracy ~50-60%.

**Proposed solution:**
```
APPROACH: CDP Extension Debugging + Vision Fallback

1. Load extensions via Chromium --load-extension=/path/to/extension
2. Use Chrome DevTools Protocol (CDP) to:
   a. List extension background/service worker targets
   b. Attach debugger to extension popup page
   c. Execute JS within extension context (e.g., chrome.runtime.sendMessage)
3. For extensions that expose their popup as an HTML page:
   - Navigate to chrome-extension://<id>/popup.html
   - Playwright can now automate it as a regular page
4. Fallback: Vision-based clicking for extensions that resist programmatic access

EFFORT: ~2 days (CDP extension target discovery + popup page navigation)
RISK: Some extensions detect automation and refuse to operate
```

#### Gap 1.2: Extension Background Scripts — **NICE-TO-HAVE**

**The problem:** Extensions like ad blockers, privacy tools run background scripts/service workers. Agents can't inspect or control these.

**Why NICE-TO-HAVE:** Agents rarely need to configure ad blockers. Pre-configure extensions in the Docker image. If the agent needs MetaMask, build a MetaMask-ready image with a pre-loaded wallet.

**Proposed solution:** Pre-baked extension profiles in Docker images. No runtime interaction needed.

---

### 2. Native Applications

#### Gap 2.1: Desktop Apps (Slack, Discord, Figma) — **IMPORTANT**

**The problem:** Human office workers live in Slack, Discord, Figma desktop apps. Our Phase 2 Docker container runs Linux — most of these have Linux builds (Slack: Electron/snap, Discord: Electron, Figma: Electron) but they are **web-wrapped** apps. The native desktop versions have no accessibility API coverage worth relying on.

**What our agent can do:**
- Phase 2+3: Install the Linux builds in the Docker image, use vision to interact
- BUT: Vision accuracy of 60-75% per action means a 10-step Slack interaction has ~6-17% end-to-end success rate

**Proposed solution:**
```
APPROACH: Prefer Web Versions + API-First

1. PRIMARY: Use web versions (slack.com, discord.com, figma.com)
   → Playwright MCP a11y tree works perfectly on these
   → Zero vision cost, deterministic, 95%+ reliability

2. SECONDARY: Use official APIs directly
   → Slack: Web API (chat.postMessage, channels.list, etc.)
   → Discord: Bot API / webhook
   → Figma: REST API (read/write designs, export assets)
   → These are MORE capable than GUI interaction

3. LAST RESORT: Vision-based desktop app control (Phase 3)
   → Only for apps with no web or API alternative
   → Add AT-SPI2 to Docker image for GTK/Qt apps

DECISION: Don't install native apps by default.
Configure web bookmarks + API tokens instead.
```

#### Gap 2.2: Microsoft Office Suite — **IMPORTANT**

**The problem:** Word, Excel, PowerPoint are daily tools. MS Office doesn't run on Linux (inside our Docker container). LibreOffice is the Linux alternative but has different UI, different file format edge cases.

**What our agent can do:**
- Use LibreOffice inside Docker (handles .docx/.xlsx/.pptx with ~90% fidelity)
- Use Microsoft 365 web apps via Playwright MCP (full fidelity, Microsoft's actual rendering)
- Use CLI tools: `pandoc` for document conversion, `python-docx`/`openpyxl` for programmatic manipulation

**Proposed solution:**
```
APPROACH: Layered office document strategy

1. PROGRAMMATIC (best): python-docx, openpyxl, python-pptx, pandoc
   → Create/modify documents via code, not GUI clicks
   → Deterministic, fast, zero vision cost

2. WEB APPS: office.com via Playwright MCP
   → For tasks that require visual layout (formatting, reviewing)
   → Full a11y tree support

3. LIBREOFFICE: Fallback for offline or complex rendering
   → Pre-install in Docker image
   → Vision-based interaction when needed

EFFORT: Zero — all tools already available via apt/pip
```

#### Gap 2.3: VS Code GUI Interactions — **NICE-TO-HAVE**

**Why NICE-TO-HAVE:** Agents already have CLI access to everything VS Code does: file editing, LSP (via language servers), git, terminal, debugging (via DAP), extensions (via CLI). The GUI is irrelevant for an AI agent. No human is watching the agent use VS Code.

**No solution needed.** CLI/LSP covers 99% of developer IDE needs.

---

### 3. System Settings

#### Gap 3.1: VPN / Proxy / Network Configuration — **CRITICAL**

**The problem:** Office workers connect to corporate VPNs, configure proxies to access internal resources. Inside a Docker container, the agent controls its own userspace but **network configuration is managed by Docker's network stack on the host**.

**What our agent cannot do:**
- Run a VPN client inside the container (needs `NET_ADMIN` capability, `--cap-add=NET_ADMIN`, and `/dev/net/tun`)
- Configure proxy settings (can set env vars but can't modify system proxy)
- Access internal corporate networks that require VPN

**This is CRITICAL because** many real office tasks involve accessing internal tools (Jira, Confluence, internal dashboards) that sit behind VPNs.

**Proposed solution:**
```
APPROACH: Container-level VPN + Proxy injection

OPTION A: VPN inside container (recommended)
  1. Add --cap-add=NET_ADMIN and --device=/dev/net/tun to container
  2. Install OpenVPN/WireGuard client in Docker image
  3. Mount VPN config as a Docker secret: -v /path/to/vpn.conf:/etc/openvpn/client.conf
  4. Agent runs: openvpn --config /etc/openvpn/client.conf --daemon
  5. All container traffic now routes through VPN

OPTION B: Host-level VPN (simpler)
  1. Run VPN on the host machine
  2. Docker container inherits host network routes
  3. Use --network=host or custom Docker network
  4. Agent doesn't need to know about VPN — it just works

OPTION C: Proxy injection
  1. Set HTTP_PROXY/HTTPS_PROXY env vars in Docker run
  2. Configure Chromium: --proxy-server=http://proxy:8080
  3. Works for corporate proxies without VPN

RECOMMENDED: Option B for simplicity (Phase 2),
             Option A for multi-tenant isolation (Phase 4)

EFFORT: Option B: 0 days (config change)
        Option A: 1 day (Dockerfile + entrypoint script)
```

#### Gap 3.2: Display / Resolution Settings — **NICE-TO-HAVE**

**No real gap.** Xvfb resolution is set at launch: `Xvfb :99 -screen 0 1920x1080x24`. Change resolution by restarting Xvfb with different args. Agent can even do this itself via bash.

---

### 4. Multi-Monitor / Multi-Window Workflows

#### Gap 4.1: Multi-Window Management — **IMPORTANT**

**The problem:** Humans routinely work with 2-4 windows side-by-side: browser on left, IDE on right, Slack in corner. Vision models struggle when multiple windows overlap or tile — they can't reliably distinguish which window to interact with, misidentify click targets, and get confused by overlapping UI elements.

**What our agent can do:**
- Phase 2: `xdotool` can move/resize/focus windows programmatically
- `wmctrl` can tile windows, list windows, activate by name
- Phase 3: Vision can see the whole screen but accuracy drops significantly with complex layouts

**Proposed solution:**
```
APPROACH: Explicit window management MCP tools

1. Add window management tools to the desktop MCP server:
   - window_list() → returns [{id, title, x, y, w, h, focused}]
   - window_focus(title_pattern) → activates + raises window
   - window_tile(layout: "left-half|right-half|maximize|quarter-NW")
   - window_screenshot(title_pattern) → screenshot of JUST that window

2. KEY INSIGHT: Don't screenshot the whole desktop.
   Screenshot individual windows via:
   xdotool search --name "Firefox" | xargs -I {} import -window {} /tmp/shot.png
   → This gives vision a SINGLE window to analyze, not a cluttered desktop
   → Dramatically improves vision accuracy

3. Agent workflow:
   a. window_list() to see what's open
   b. window_focus("Slack") to bring Slack forward
   c. window_screenshot("Slack") to see JUST Slack
   d. Interact with Slack (screenshot of single window, high accuracy)
   e. window_focus("Firefox") to switch back

EFFORT: 1 day (6 xdotool/wmctrl wrapper tools in MCP server)
IMPACT: Transforms multi-window from "fragile" to "reliable"
```

#### Gap 4.2: Drag Between Applications — **IMPORTANT**

**The problem:** Humans drag files from file manager to browser uploads, drag text between apps, drag tabs between windows. `xdotool` supports `mousemove` and `mousedown`/`mouseup` but:
- Drag-and-drop requires precise coordinate sequences across window boundaries
- Drop targets change when hovering (visual feedback the agent must interpret)
- Timing-sensitive: too fast = drop doesn't register, too slow = wrong target

**Proposed solution:**
```
APPROACH: Avoid drag-and-drop entirely — use programmatic alternatives

1. File uploads: Playwright setInputFiles() bypasses native file picker
2. File moves: CLI `mv` / `cp` commands
3. Text transfer: Clipboard (xclip) → copy in app A, paste in app B
4. Tab management: Chromium CDP protocol for tab manipulation
5. ONLY use drag-and-drop via xdotool as absolute last resort:
   - MCP tool: drag(from_x, from_y, to_x, to_y, duration_ms)
   - Implemented as: mousedown → slow mousemove → mouseup
   - With vision verification at end

PHILOSOPHY: A human drags because it's ergonomic with a mouse.
An agent should use the API/CLI equivalent because it's deterministic.

EFFORT: 0 days (avoid the problem) + 0.5 day (drag MCP tool as fallback)
```

---

### 5. File Management

#### Gap 5.1: Native File Dialogs (Open/Save As) — **CRITICAL**

**The problem:** When any app (browser, LibreOffice, Electron app) triggers a native "Open File" or "Save As" dialog, it's an OS-level GTK/Qt dialog. Playwright **cannot** interact with it (it's outside the browser process). The a11y tree doesn't cover it. These dialogs are required for:
- Uploading files in web apps (when setInputFiles doesn't work)
- Opening/saving documents in any native app
- Importing/exporting in any tool

**What our agent can do:**
- Phase 1 (Playwright): `setInputFiles()` bypasses the dialog for `<input type="file">` — works ~80% of the time
- Phase 2: xdotool can type the file path into the dialog's path bar
- Phase 3: Vision can see the dialog and try to navigate it — but file dialogs have complex tree views, tiny icons, and are notoriously hard for vision models

**Proposed solution:**
```
APPROACH: Multi-layer file dialog handling

LAYER 1: Bypass the dialog entirely (preferred)
  - Playwright: page.setInputFiles() for <input type="file">
  - Programmatic: Use app's CLI/API to open files (e.g., libreoffice --calc file.xlsx)
  - xdg-open: Open file with default app (no dialog needed)

LAYER 2: Type-path-and-enter (fast, reliable for known paths)
  When a file dialog opens:
  1. xdotool key ctrl+l  (many GTK/Qt dialogs: Ctrl+L = type path bar)
  2. xdotool type --delay 50 "/home/agent/documents/report.xlsx"
  3. xdotool key Return
  → Works for GTK2, GTK3, Qt5 file dialogs
  → No vision needed, deterministic, ~200ms

LAYER 3: AT-SPI2 for file dialog navigation
  - GTK file dialogs expose AT-SPI2 tree
  - python3 -c "import gi; gi.require_version('Atspi', '2.0')"
  - Navigate file tree programmatically
  → Works when dialog is a standard GTK widget

LAYER 4: Vision fallback (last resort)
  - Screenshot → identify path bar → type path

EFFORT: Layer 2: 0.5 day (3-line xdotool sequence wrapped in MCP tool)
         Layer 3: 2 days (AT-SPI2 integration for GTK dialogs)
```

#### Gap 5.2: Drag-and-Drop Files — **IMPORTANT**

Covered in §4.2 above. Same solution: avoid drag-and-drop, use CLI/API alternatives.

---

### 6. Clipboard

#### Gap 6.1: Cross-Application Text Clipboard — **CRITICAL**

**The problem:** Office workers constantly copy-paste between apps: copy URL from Slack → paste in browser, copy code from browser → paste in IDE, copy text from PDF → paste in email.

**What our agent can do:**
- Phase 2: `xclip` and `xsel` exist and work perfectly with X11
- `xclip -selection clipboard -i <<< "text"` → write to clipboard
- `xclip -selection clipboard -o` → read from clipboard
- `xdotool key ctrl+c` / `xdotool key ctrl+v` → trigger copy/paste in apps

**This is actually well-handled** in Phase 2 but needs to be exposed as MCP tools.

**Proposed solution:**
```
APPROACH: Clipboard MCP tools (trivial to implement)

MCP tools:
  - clipboard_write(text: string) → xclip -selection clipboard -i
  - clipboard_read() → xclip -selection clipboard -o
  - clipboard_copy() → xdotool key ctrl+c (trigger app's copy)
  - clipboard_paste() → xdotool key ctrl+v (trigger app's paste)

Agent workflow (copy from app A, paste in app B):
  1. window_focus("Slack")
  2. [select text with mouse or keyboard]
  3. clipboard_copy()  → triggers Ctrl+C in focused window
  4. window_focus("Firefox")
  5. [click target field]
  6. clipboard_paste()  → triggers Ctrl+V in focused window

EFFORT: 0.5 day (4 simple xclip/xdotool wrappers)
STATUS: SOLVABLE — not a real gap once MCP tools are built
```

#### Gap 6.2: Rich Clipboard (Images, HTML, Files) — **IMPORTANT**

**The problem:** Humans copy images (screenshot → paste into Slack), formatted HTML (copy from web → paste into email preserving formatting), and files (copy file in file manager → paste in another folder).

**What our agent can do:**
- `xclip` supports MIME types: `xclip -selection clipboard -t image/png -i < image.png`
- Reading rich clipboard: `xclip -selection clipboard -t text/html -o`
- But **file clipboard** (copying files) uses `x-special/gnome-copied-files` MIME type — fragile

**Proposed solution:**
```
APPROACH: Extended clipboard MCP tools

Additional tools:
  - clipboard_write_image(path: string) → xclip -selection clipboard -t image/png -i < path
  - clipboard_write_html(html: string) → xclip -selection clipboard -t text/html -i
  - clipboard_read_format(format: "text"|"html"|"image") → read specific format

For files: Skip clipboard. Use CLI:
  - cp /path/to/file /destination/  → faster and deterministic

EFFORT: 0.5 day
RISK: Low — xclip MIME type support is well-tested
```

---

### 7. Authentication Flows

#### Gap 7.1: OAuth Popup Flows — **IMPORTANT** (but mostly solved)

**The problem:** "Sign in with Google/GitHub/Microsoft" opens a popup window. Agent needs to interact with the popup to authenticate.

**What our agent can do:**
- Phase 1: Playwright handles popups via `page.waitForEvent('popup')`. The popup is a regular browser page — full a11y tree access.
- Phase 2: If popup opens a new window, xdotool can interact with it.
- Works well for standard OAuth flows.

**Residual gap:** Some OAuth flows use redirect-based (not popup-based) authentication. These work even better with Playwright since it's just page navigation.

**Proposed solution:** Already handled by Playwright. Add an MCP convenience tool:
```
oauth_flow(provider: "google"|"github"|"microsoft", credentials: {email, password})
→ Pre-scripted flows for common OAuth providers
→ Handles popup or redirect, enters credentials, approves consent

EFFORT: 1 day (scripted flows for top 3 providers)
```

#### Gap 7.2: TOTP-Based 2FA — **CRITICAL**

**The problem:** After entering username/password, many services require a 6-digit TOTP code from an authenticator app (Google Authenticator, Authy). Humans pull out their phone and type the code. Our agent has no phone and no authenticator app.

**This blocks login to:** GitHub (if 2FA enabled), Google Workspace, AWS Console, Slack (enterprise), virtually any service with mandatory 2FA.

**Proposed solution:**
```
APPROACH: Software TOTP generation

1. Store TOTP secrets in agent's secure config (not in code):
   - config.json: { "totp_secrets": { "github": "JBSWY3DPEHPK3PXP" } }
   - Or Docker secret mount: -v /secrets/totp:/run/secrets/totp

2. Generate TOTP codes programmatically:
   - Install oathtool in Docker image: apt install oathtool
   - oathtool --totp --base32 "JBSWY3DPEHPK3PXP" → outputs "492039"
   - Or Python: pyotp.TOTP("JBSWY3DPEHPK3PXP").now()

3. MCP tool:
   - totp_code(service: string) → generates current 6-digit code
   - Agent types the code into the 2FA prompt

4. SETUP FLOW: When user sets up a service with 2FA:
   - Capture the TOTP secret (QR code contains otpauth:// URI)
   - Store in agent's secure config
   - Agent can now generate codes forever

EFFORT: 0.5 day (oathtool + MCP wrapper)
RISK: TOTP secrets are highly sensitive — must be encrypted at rest
CRITICAL: This unblocks ALL 2FA-protected services
```

#### Gap 7.3: Biometric Authentication — **NICE-TO-HAVE**

**The problem:** Fingerprint readers, Face ID, Windows Hello. Can't be emulated in Docker.

**Why NICE-TO-HAVE:** Biometric auth is a human convenience. Services that require biometric also support password + 2FA as fallback. Agent uses the fallback.

#### Gap 7.4: Hardware Security Keys (YubiKey, FIDO2) — **IMPORTANT**

**The problem:** Some organizations mandate hardware key authentication. YubiKey plugs into USB and the browser talks to it via WebAuthn. Docker containers can't access USB devices by default.

**What our agent can do:**
- Docker `--device=/dev/bus/usb` can pass through USB devices — but this assumes a physical YubiKey is plugged into the host
- Chrome supports virtual authenticators via CDP: `WebAuthn.addVirtualAuthenticator()`

**Proposed solution:**
```
APPROACH: Virtual WebAuthn authenticator

1. Use Chrome DevTools Protocol (CDP):
   session.send('WebAuthn.enable')
   session.send('WebAuthn.addVirtualAuthenticator', {
     options: {
       protocol: 'ctap2',
       transport: 'usb',
       hasResidentKey: true,
       hasUserVerification: true
     }
   })

2. The virtual authenticator responds to WebAuthn challenges
   exactly like a real YubiKey — services can't tell the difference

3. Register the virtual authenticator with each service once
   (same as registering a new hardware key)

EFFORT: 1 day (CDP WebAuthn integration)
LIMITATION: Only works in the browser (Chrome/Chromium).
            Native apps requiring FIDO2 won't work.
```

---

### 8. Audio / Video

#### Gap 8.1: Video Calls (Zoom, Meet, Teams) — **CRITICAL**

**The problem:** Office workers spend hours in video calls. Agent needs to:
- Join a call (web or desktop app)
- See/hear other participants (process audio/video input)
- Share screen (present content to others)
- Speak (send audio output)
- Use chat (type messages in call sidebar)

**What our agent can do:**
- Join web-based calls via Playwright (navigate to meet.google.com)
- See the UI via screenshot/a11y tree
- Use in-call chat via Playwright
- **CANNOT:** Hear audio, speak, share camera, reliably share screen

**This is genuinely hard** because:
1. No audio subsystem in Docker/Xvfb (no PulseAudio, no ALSA, no hardware)
2. No camera/mic devices to give to the browser
3. WebRTC requires media devices that don't exist in the container

**Proposed solution:**
```
APPROACH: Headless participation + virtual media devices

TIER 1: Chat-only call participation (IMMEDIATE)
  - Agent joins call via web URL
  - Uses in-call chat for communication
  - Can see shared screens via screenshots
  - Reads captions/transcription if available
  - "I can't hear you but I'm following the chat and screen"
  EFFORT: 0 days (already works with Playwright)

TIER 2: Virtual audio/video devices (MEDIUM-TERM)
  1. Install PulseAudio in Docker: apt install pulseaudio
  2. Virtual mic: pactl load-module module-null-sink sink_name=virtual_mic
  3. Virtual camera: sudo modprobe v4l2loopback
     → Requires --device=/dev/video0 and host kernel module
  4. Feed audio TO the virtual mic: ffmpeg → PulseAudio sink
  5. Feed video TO the virtual camera: ffmpeg → v4l2loopback
  6. Chrome sees these as real devices

  Agent CAN then:
  - Send pre-recorded or TTS audio to calls
  - Send a static image or screen recording as "camera"
  - Record incoming call audio via PulseAudio monitor

  EFFORT: 3-5 days
  RISK: v4l2loopback requires host kernel module (not available in all envs)
  RISK: WebRTC quality with virtual devices needs tuning

TIER 3: API-first approach (RECOMMENDED for productivity)
  - Zoom/Meet/Teams all have bot APIs
  - Join calls as a "bot participant"
  - Receive transcriptions in real-time
  - Send messages to the call
  - Record the call (with proper permissions)
  - NO need for fake audio/video hardware

  EFFORT: 2-3 days per provider
  QUALITY: Superior to GUI interaction — gets structured data, not pixels

RECOMMENDED: Tier 1 (now) + Tier 3 (soon) — skip Tier 2 unless
             there's a specific use case requiring virtual media.
```

#### Gap 8.2: Audio Playback / Verification — **IMPORTANT**

**The problem:** Agent can't verify audio output (e.g., "did the notification sound play?", "is the video playing with sound?"). No audio subsystem in the container.

**Proposed solution:**
```
APPROACH: PulseAudio + audio capture

1. Install PulseAudio in Docker image (daemon-less mode):
   pulseaudio --start --daemonize=no --system=false

2. Configure ALSA to use PulseAudio:
   Set PULSE_SERVER=unix:/tmp/pulse-socket

3. Capture audio output:
   parec --monitor-of-sink=auto_null | ffmpeg -i pipe: -t 5 /tmp/audio.wav

4. MCP tool: audio_capture(duration_seconds) → captures audio → returns WAV
   Agent can then analyze the WAV (speech-to-text, frequency analysis)

EFFORT: 1 day
VALUE: Enables audio verification, call recording, media testing
```

#### Gap 8.3: Screen Recording — **IMPORTANT** (but mostly solved)

**The problem:** Recording agent activity for audit, debugging, or content creation.

**What we already have:** noVNC provides real-time viewing. For recording:
```
ffmpeg -video_size 1920x1080 -framerate 5 -f x11grab -i :99 output.mp4
```
This runs inside the Docker container and records the Xvfb display. Works perfectly.

**Proposed solution:** Add as MCP tool: `screen_record(start|stop, filename)`. **EFFORT: 0.5 day.**

---

### 9. USB / Hardware

#### Gap 9.1: Printers — **NICE-TO-HAVE**

**Why NICE-TO-HAVE:** AI agents don't need to print. If printing is needed, generate a PDF and let the human print it. The agent creates the document; the human presses "Print."

#### Gap 9.2: External Drives / USB Storage — **NICE-TO-HAVE**

**Not a real gap.** Docker volume mounts (`-v /host/path:/container/path`) give the agent access to any directory on the host. External drives mounted on the host are accessible the same way.

#### Gap 9.3: Hardware Security Keys — **IMPORTANT**

Covered in §7.4 above (Virtual WebAuthn authenticator via CDP).

---

### 10. Notifications

#### Gap 10.1: Desktop Notifications / Toast Messages — **IMPORTANT**

**The problem:** Web apps and native apps send desktop notifications (new Slack message, build complete, calendar reminder). These are ephemeral — they appear for a few seconds then vanish. Vision-based approach must screenshot at exactly the right moment.

**What our agent can do:**
- Phase 2: Notifications rendered by the WM's notification daemon (dunst, xfce4-notifyd)
- Phase 3: Vision might catch a notification if screenshot timing aligns — unreliable

**Proposed solution:**
```
APPROACH: Notification capture daemon

1. Install dunst (lightweight notification daemon) in Docker image
2. Configure dunst to LOG all notifications to a file:
   # ~/.config/dunst/dunstrc
   [global]
   startup_notification = false
   
   # dunst logs via dunstctl
   # OR use custom script in dunstrc:
   [urgency_low]
   script = /usr/local/bin/log-notification.sh

3. log-notification.sh:
   #!/bin/bash
   echo "$(date -Iseconds) | $DUNST_APP_NAME | $DUNST_SUMMARY | $DUNST_BODY" >> /tmp/notifications.log

4. MCP tools:
   - notifications_list(since: timestamp) → reads /tmp/notifications.log
   - notifications_clear() → truncates log

5. For browser notifications specifically:
   - Playwright can intercept via page.on('notification')
   - Or grant notification permission and capture via service worker

EFFORT: 0.5 day (dunst + log script + MCP wrapper)
RELIABILITY: 100% — captures every notification, no timing dependency
```

#### Gap 10.2: System Tray / Status Icons — **IMPORTANT**

**The problem:** Dropbox sync status, VPN connection indicator, chat app status — all live in the system tray as tiny 16x16 or 24x24 icons. Vision models cannot reliably interpret these.

**Proposed solution:**
```
APPROACH: Avoid system tray — use CLI/API alternatives

1. Most tray apps have CLI equivalents:
   - Dropbox: dropbox status, dropbox filestatus
   - VPN: wg show, nmcli connection show
   - Chat: API queries (Slack: users.getPresence)

2. If tray interaction is truly needed:
   - Use xdotool to click known tray coordinates
   - Or use dbus queries to read tray icon status:
     dbus-send --session --dest=org.freedesktop.StatusNotifierWatcher \
       /StatusNotifierWatcher org.freedesktop.DBus.Properties.GetAll \
       string:"org.freedesktop.StatusNotifierWatcher"

EFFORT: 0 (use CLI/API) or 1 day (D-Bus tray introspection)
```

---

## Priority Matrix

### 🔴 CRITICAL — Must solve before "real office worker" claim

| # | Gap | Proposed Solution | Effort | Phase |
|---|-----|------------------|--------|-------|
| 6 | VPN/Proxy access to internal networks | Container VPN (WireGuard/OpenVPN) or host VPN | 0-1 day | Phase 2 |
| 11 | Native file dialogs | Ctrl+L path typing + AT-SPI2 fallback | 0.5-2 days | Phase 2 |
| 12 | Cross-app clipboard | xclip MCP tools | 0.5 day | Phase 2 |
| 15 | TOTP 2FA | oathtool + secure secret storage | 0.5 day | Phase 2 |
| 19 | Video calls | Chat-only participation NOW + Meeting bot APIs | 0-3 days | Phase 2 |

### 🟡 IMPORTANT — Limits effectiveness significantly

| # | Gap | Proposed Solution | Effort | Phase |
|---|-----|------------------|--------|-------|
| 1 | Browser extension popups | CDP extension target + popup.html navigation | 2 days | Phase 2 |
| 3 | Native desktop apps | Prefer web versions + APIs, not desktop apps | 0 days | Phase 1 |
| 4 | Office suites | Programmatic (python-docx) + Office web apps | 0 days | Phase 1 |
| 8 | Multi-window management | Window-specific screenshot MCP tools | 1 day | Phase 2 |
| 9 | Drag between apps | Avoid drag-and-drop — use clipboard/CLI | 0.5 day | Phase 2 |
| 10 | File drag-and-drop | setInputFiles + CLI alternatives | 0 days | Phase 1 |
| 13 | Rich clipboard | xclip with MIME types | 0.5 day | Phase 2 |
| 14 | OAuth popups | Already solved by Playwright | 0 days | Phase 1 |
| 17 | Hardware security keys | Virtual WebAuthn via CDP | 1 day | Phase 2 |
| 18 | Screen recording | ffmpeg x11grab + MCP tool | 0.5 day | Phase 2 |
| 20 | Audio playback | PulseAudio in container | 1 day | Phase 2 |
| 23 | Desktop notifications | dunst + log capture | 0.5 day | Phase 2 |
| 24 | System tray icons | CLI/API alternatives + D-Bus | 0-1 day | Phase 2 |

### 🟢 NICE-TO-HAVE — Edge cases

| # | Gap | Notes |
|---|-----|-------|
| 2 | Extension background scripts | Pre-configure in Docker image |
| 5 | VS Code GUI | CLI/LSP covers 99% |
| 7 | Display settings | Xvfb resolution is configurable |
| 16 | Biometric auth | Fallback to password + 2FA |
| 21 | Printers | Agent creates PDF, human prints |
| 22 | External drives | Docker volume mounts |

---

## Key Architectural Insight

**The #1 meta-pattern across all gaps:**

> **Don't make the agent act like a human using a GUI. Make the agent use the programmatic interface that the GUI is a frontend for.**

- Don't click in Slack → use the Slack API
- Don't navigate file dialogs → type the path or use CLI
- Don't drag files → use `cp`/`mv`
- Don't read system tray → use `dbus` or CLI status commands
- Don't attend video calls with fake cameras → join as a bot via API

The vision-based approach (Phase 3) should be the **absolute last resort**, not the primary interaction model. The right priority stack:

```
Priority 1: CLI/API       → $0/action, 100% reliable, instant
Priority 2: Playwright    → $0.03-0.06/action, 95%+ reliable, ~1s
Priority 3: AT-SPI2       → $0.02-0.06/action, 80%+ reliable, ~1s
Priority 4: Vision+xdotool → $0.06-0.25/action, 60-75% reliable, 2-5s
```

**Total effort to close all CRITICAL gaps: ~2-7 days.**
**Total effort to close all IMPORTANT gaps: ~8-10 additional days.**
**No gaps require architectural changes** — all solutions fit within the existing Phase 2 Docker container model.

---

## Next Steps

1. **Immediate (Phase 2 Dockerfile additions):** xclip, oathtool, dunst, PulseAudio, wmctrl, ffmpeg
2. **MCP tool layer:** ~15 new tools covering clipboard, TOTP, notifications, window management, audio, screen recording
3. **VPN strategy decision:** Host VPN vs container VPN — depends on deployment model
4. **Meeting bot integration:** Evaluate Zoom/Meet/Teams bot APIs for call participation
5. **Detailed implementation plan** if approved
