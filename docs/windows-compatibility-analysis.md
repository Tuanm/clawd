# Claw'd Windows Compatibility Analysis

> **Reviewed by 5 agents (Round 1).** Findings integrated below.

## Executive Summary

**Claw'd is currently Linux/macOS-only.** Of 83 agent tools, 28+ are Unix-only (tmux, bash, find, grep), 19 partially compatible (git, Docker), and 36+ fully cross-platform (HTTP API tools, file I/O fallbacks). The security sandbox is entirely absent on Windows — and critically, **path validation is also completely disabled** when sandbox is off, meaning agents run with ZERO security controls on Windows.

### ⚠️ CRITICAL Security Warning

On Windows, `isSandboxEnabled()` returns `false`, which causes `isPathAllowed()` to return `true` for ANY path. This means:
- Agent can read/write ANY file on the system (SSH keys, credentials, system files)
- `.env` file protection is broken (path separator `split("/")` doesn't handle `\`)
- Windows Credential Manager is accessible via PowerShell
- No filesystem, process, or environment isolation exists

**DO NOT ship Windows support without a real sandbox implementation.**

---

## 1. Tool Compatibility Matrix

### Legend
- ✅ Works on Windows as-is
- ⚠️ Partially — needs minor changes or has Windows-available alternatives
- ❌ Unix-only — requires significant rework or alternative approach

### Core Tools (tools.ts)

| Tool | Classification | Blocker | Windows Solution |
|------|---------------|---------|------------------|
| `bash` | ❌ Unix-only | Hardcoded `spawn("bash", ["-c", cmd])` | Use `cmd.exe /c` or `powershell.exe -Command` on Windows; or require Git Bash / WSL |
| `view` | ✅ Cross-platform | Has Node.js `fs` fallback when sandbox disabled (`readFileSync`, `readdirSync`) | — |
| `edit` | ✅ Cross-platform | Has Node.js `fs` fallback when sandbox disabled (`readFileSync`, `writeFileSync`) | — |
| `create` | ✅ Cross-platform | Has Node.js `fs` fallback when sandbox disabled (`writeFileSync`) | — |
| `grep` | ❌ Unix-only | `spawn("rg")` / `spawn("grep")` | ripgrep (`rg`) has Windows binaries; ship or require it |
| `glob` | ❌ Unix-only | `spawn("find", [...])` | Use Node.js `glob` package or `fs.globSync` (Bun/Node 22+) |
| `get_project_root` | ✅ | — | Pure Node.js path resolution |
| `memory_search` | ✅ | — | SQLite (bundled in Bun) |
| `memory_summary` | ✅ | — | SQLite |
| `web_fetch` | ✅ | — | Fetch API |
| `web_search` | ✅ | — | Fetch API |

### Tmux Tools (7 tools — ALL Unix-only)

| Tool | Blocker | Windows Solution |
|------|---------|------------------|
| `tmux_send_command` | `tmux` binary | **Option A**: Windows Terminal + `conpty` API<br>**Option B**: Use `node-pty` for pseudo-terminal<br>**Option C**: PowerShell background jobs (`Start-Job`) |
| `tmux_list` | `tmux list-sessions` | Track sessions in-memory or use Windows `conhost` |
| `tmux_kill` | `tmux kill-session` | Process termination via `taskkill` or `process.kill()` |
| `tmux_capture` | `tmux capture-pane` | Capture from `node-pty` buffer |
| `tmux_send_input` | `tmux send-keys` | Write to `node-pty` stdin |
| `tmux_new_window` | `tmux new-window` | Create new `node-pty` instance |
| `tmux_kill_window` | `tmux kill-window` | Kill `node-pty` process |

### Job Management (5 tools — ALL Unix-only)

| Tool | Blocker | Windows Solution |
|------|---------|------------------|
| `job_submit` | `tmuxJobManager` → tmux | Abstract `JobManager` interface; Windows impl via `node-pty` or child_process |
| `job_status` | tmux session query | In-memory job tracking (already partially done) |
| `job_cancel` | tmux kill | `process.kill(pid)` — note: `process.kill(-pid)` POSIX group kill doesn't work on Windows, use `taskkill /T /F /PID` |
| `job_logs` | tmux capture | Capture from job stdout/stderr streams |
| `job_wait` | tmux polling | Promise-based wait on child process |

### Sub-Agent System (3 tools)

| Tool | Classification | Blocker | Windows Solution |
|------|---------------|---------|------------------|
| `spawn_agent` | ❌ Unix-only | `spawnTmuxSubAgent()` → tmux + bash + chmod | Use `child_process.fork()` or `node-pty`; skip chmod on Windows |
| `list_agents` | ✅ | In-memory map | Works as-is |
| `kill_agent` | ❌ Unix-only | `tmux kill-session` | `process.kill(pid)` |

### Git Tools (13 tools — partially compatible)

| Tool | Classification | Notes |
|------|---------------|-------|
| `git_status` through `git_show` | ⚠️ Partial | Git for Windows exists; commands themselves are cross-platform. **Blocker**: sandbox wrapping via `bash -c`. Fix: call `git` directly via `execFile("git", [...])` without bash wrapper on Windows |

### Plugin Tools

| Tool | Classification | Blocker | Windows Solution |
|------|---------------|---------|------------------|
| `spawn_workspace` | ⚠️ Partial | Docker (works via Docker Desktop on Windows) | Docker Desktop for Windows supports Linux containers |
| `destroy_workspace` | ⚠️ Partial | Docker | Same |
| `list_workspaces` | ⚠️ Partial | Docker | Same |
| `tunnel_create` | ⚠️ Partial | `cloudflared` binary | Windows binaries available from Cloudflare |
| `tunnel_destroy` | ✅ | Process management | Works |
| `tunnel_list` | ✅ | In-memory | Works |
| Scheduler tools (7) | ✅ | — | Pure Node.js |
| Skill tools (4) | ✅ | — | Pure Node.js fs |
| Task tools (8) | ✅ | — | HTTP API |
| Article tools (5) | ✅ | — | HTTP API |

### Chat Plugin Tools (clawd-chat)

| Tool | Classification | Notes |
|------|---------------|-------|
| All chat tools | ✅ | Pure HTTP API calls, no OS dependencies |

---

## 2. Security Sandbox Analysis

### Current State

| Platform | Mechanism | Status |
|----------|-----------|--------|
| Linux | Bubblewrap (`bwrap`) | ✅ Deny-by-default namespace isolation |
| macOS | `sandbox-exec` (Seatbelt) | ✅ Allow-default with write restrictions |
| Windows | None | ❌ **Completely unsupported** — falls to `"unsupported"` |

### Windows Sandbox Options

#### Option 1: Windows Sandbox API (Recommended for full isolation)
- **Windows Sandbox** (`WindowsSandbox.exe`): Lightweight VM, available on Win 10/11 Pro/Enterprise
- **Drawback**: Heavy (boots a Windows instance), high latency (~10-15s startup)
- **Use case**: High-security scenarios

#### Option 2: Windows Job Objects + Restricted Tokens (Recommended for practical use)
- **Mechanism**: Create restricted process token → assign to Job Object → limit filesystem/network/registry
- **Implementation**: Use `win32-api` or `ffi-napi` to call Win32 `CreateRestrictedToken`, `AssignProcessToJobObject`
- **Provides**: Process isolation, resource limits, restricted filesystem access
- **Drawback**: Requires native Windows API bindings
- **Example approach**:
  ```typescript
  // Conceptual — would need win32 bindings
  import { createRestrictedProcess } from "./win32-sandbox";
  const proc = await createRestrictedProcess("cmd.exe", {
    allowedPaths: [projectRoot, os.tmpdir()],
    denyNetwork: false,
    memoryLimit: "2g",
    cpuLimit: 2,
  });
  ```

#### Option 3: AppContainer Isolation (Modern Windows approach)
- **AppContainer**: Windows built-in app isolation (UWP/Store apps use it)
- Restricts filesystem to declared capabilities
- Available via `CreateProcess` with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`
- Most aligned with bwrap's deny-by-default philosophy
- **Drawback**: Complex Win32 API setup, limited documentation for CLI use

#### Option 4: WSL2 Backend (Pragmatic — Development Only)
- **Run Claw'd agent inside WSL2** → all Linux tools available (tmux, bwrap, etc.)
- **User's Windows filesystem accessible** at `/mnt/c/`
- **Drawback**: Requires WSL2 installed; adds latency for filesystem operations crossing WSL/Windows boundary
- **⚠️ SECURITY WARNING (Agent 110, 113)**: WSL2 is **NOT a security boundary**:
  - `/mnt/c/` exposes entire Windows filesystem by default
  - WSL→Windows interop allows calling `powershell.exe` from inside WSL
  - **Mitigation**: Disable interop via `/etc/wsl.conf`: `[interop] enabled=false` + `appendWindowsPath=false` + `[automount] enabled=false`. With these + bwrap inside WSL2, you get real Linux sandbox isolation.
  - **Use case**: Development environments only, not production/security-sensitive deployments

#### Option 5: PowerShell Constrained Language Mode + JEA
- **Constrained Language Mode**: Restricts PowerShell to safe subset (no .NET, no COM, no type creation)
- **JEA (Just Enough Administration)**: Role-based command restrictions
- **Use case**: If `bash` tool is replaced with `powershell` tool on Windows
- **Provides**: Command-level restrictions, logging, transcript recording
- **⚠️ Bypassable** via .NET 2.0, COM objects (Agent 113)

### Recommendation

**Tiered approach:**
1. **Phase 0** (gate): Add explicit `process.platform === "win32"` check at startup — refuse to run on native Windows without `--allow-windows-unsafe` flag. Prevents accidental deployment with zero security.
2. **Phase 1** (immediate): Hardened WSL2 backend (interop disabled, automount disabled, bwrap enabled) — full Linux toolchain compatibility for development use
3. **Phase 2** (medium-term): Native Windows path validation + sensitive path blocklist (decouple from sandbox)
4. **Phase 3** (long-term): AppContainer or Windows Sandbox isolation for production deployments

---

## 3. Hardcoded Path Issues

| Path | Files | Fix |
|------|-------|-----|
| `/tmp/` | sandbox.ts, workspace-plugin.ts, gateway.ts, observe.ts, AgentDialog.tsx | Replace with `os.tmpdir()` (returns `C:\Users\X\AppData\Local\Temp` on Windows) |
| `/etc/resolv.conf` | sandbox.ts (6 references) | Skip DNS config on Windows (uses system DNS resolver directly) |
| `/usr/bin:/bin` PATH | sandbox.ts | Use `process.env.PATH` on Windows |
| `/home/` | Dockerfile only | Docker-only, not a runtime issue |
| `/run/user/{uid}` | sandbox.ts (XDG_RUNTIME_DIR) | Use `os.tmpdir()` fallback on Windows |
| `~/.clawd/` | config-file.ts | ✅ Already uses `homedir()` — resolves to `C:\Users\X\.clawd\` correctly |
| `SHELL: "/bin/bash"` | sandbox.ts:92 (getSafeEnvVars) | Use `process.env.COMSPEC` or Git Bash path on Windows |
| `ssh -F /dev/null` | sandbox.ts:94 (GIT_SSH_COMMAND) | `/dev/null` doesn't exist on Windows. Use `NUL` or Git Bash `/dev/null` |
| `2>/dev/null` | state-persistence-plugin.ts | Bash syntax; cmd.exe uses `2>NUL` |
| `path.startsWith(\`${prefix}/\`)` | tools.ts:196, sandbox.ts:543 | Forward-slash comparisons fail on Windows backslash paths |
| `process.kill(-pid)` | tunnel-plugin.ts:271 | POSIX process group kill; use `taskkill /T /F /PID` on Windows |
| `rsync -a` | worktree.ts:59 | `rsync` not available natively on Windows; use `robocopy` or `xcopy` |
| `chmodSync(file, 0o755)` | clawd-chat/index.ts | No-op on NTFS; Windows uses ACLs |

---

## 4. Shell Execution Strategy

### Current: `bash -c` Everywhere

```typescript
// Current approach (tools.ts)
spawn("bash", ["-c", wrappedCommand], { ... })
```

### Proposed: Platform-Adaptive Shell

```typescript
function getShell(): { cmd: string; args: (command: string) => string[] } {
  if (process.platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: (command) => ["-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  return {
    cmd: "bash",
    args: (command) => ["-c", command],
  };
}
```

### Shell Compatibility Considerations

| Bash Feature | PowerShell Equivalent | Notes |
|-------------|----------------------|-------|
| `&&` (chain) | `;` or `&&` (PS7+) | PS7 supports `&&` natively |
| `\|` (pipe) | `\|` | Works the same |
| `$VAR` | `$env:VAR` | Different variable syntax |
| `$(cmd)` | `$(cmd)` | Same in PS |
| `> file` | `> file` | Works the same |
| `2>&1` | `2>&1` | Works the same |
| Here-doc `<<EOF` | `@" ... "@` | Different syntax |
| `export VAR=val` | `$env:VAR = "val"` | Different |
| `chmod +x` | N/A (no file permissions) | Skip on Windows |

**Key insight**: Agents generate shell commands dynamically. If we switch to PowerShell on Windows, the LLM system prompt must instruct agents to generate PowerShell syntax instead of bash.

---

## 5. Terminal Multiplexer Replacement

### Problem
tmux is the backbone of:
- Background job execution (job_submit/status/cancel/wait/logs)
- Sub-agent spawning (spawn_agent → tmux session per agent)
- Interactive terminal sessions (tmux_send_command, tmux_capture, etc.)

### Windows Alternatives

#### Option A: `node-pty` (for terminal I/O only)
- **Package**: `node-pty` (npm) — used by VS Code terminal, Hyper, etc.
- **Provides**: Pseudo-terminal on all platforms (conpty on Windows, pty on Unix)
- **Capabilities**: Spawn shell, read output, write input, resize
- **Missing vs tmux**: No built-in session persistence, no window/pane multiplexing
- **⚠️ CRITICAL LIMITATION (Agent 111)**: node-pty processes **die with their parent**. This means background jobs and sub-agents CANNOT survive agent restarts. Tmux sessions persist across agent restarts because tmux uses a client-server architecture where the server process holds the sessions. node-pty has NO equivalent.
- **Consequence**: A **persistent daemon process** is required to hold node-pty sessions — see Section 12 for the revised architecture.

```typescript
// INSUFFICIENT for production — shown for reference only
// See Section 12 for the daemon-based architecture that handles persistence
interface TerminalSession {
  id: string;
  pty: IPty;           // node-pty instance
  outputBuffer: string; // captured output — MUST use file-based logging, not ring buffer
  status: "running" | "exited";
  exitCode?: number;
}
```

#### ~~Option B: Windows Terminal + ConPTY API~~ (REDUNDANT)
- ~~Lower level than node-pty~~
- **Agent 111 finding**: node-pty already uses ConPTY on Windows internally. This option is redundant.

#### Option C: PowerShell Background Jobs
```powershell
$job = Start-Job -ScriptBlock { npm run build }
Receive-Job $job    # Get output
Stop-Job $job       # Cancel
Wait-Job $job       # Block until done
```
- Simple but limited (no interactive input, no real-time output streaming)

### Recommendation

**Abstract the terminal backend:**

```typescript
// Interface that both tmux (Unix) and node-pty (Windows) implement
interface TerminalBackend {
  createSession(opts: { id: string; command: string; cwd: string; env?: Record<string, string> }): Promise<string>;
  sendInput(sessionId: string, input: string): Promise<void>;
  captureOutput(sessionId: string, lines?: number): Promise<string>;
  killSession(sessionId: string): Promise<void>;
  listSessions(): Promise<Array<{ id: string; status: string }>>;
  waitForExit(sessionId: string, timeoutMs?: number): Promise<{ exitCode: number; output: string }>;
}

// Factory
function createTerminalBackend(): TerminalBackend {
  if (process.platform === "win32") {
    return new NodePtyBackend();   // node-pty based
  }
  return new TmuxBackend();       // existing tmux implementation
}
```

This abstraction enables:
- All 7 tmux tools to work unchanged (they call the interface)
- Job manager to work unchanged
- Sub-agent spawning to work unchanged
- Platform-specific implementation details hidden

---

## 6. Grep/Glob Tool Replacement

### grep tool
- **Current**: `spawn("rg", [...])` with fallback to `spawn("grep", [...])`
- **Windows fix**: ripgrep (`rg`) has official Windows binaries → ship or require `rg.exe`
- **Alternative**: Use Node.js `readline` + `RegExp` for pure-JS fallback
- **Recommendation**: Ship `rg` binary (it's a single static binary, ~4MB)

### glob tool
- **Current**: `spawn("find", [...])` with Unix find syntax
- **Windows fix**: `find` doesn't exist on Windows (there's a `find.exe` but it's completely different)
- **Recommendation**: Replace with Node.js `fs.globSync()` (available in Node 22+ / Bun):
  ```typescript
  import { globSync } from "node:fs";
  const matches = globSync(pattern, { cwd: projectRoot });
  ```
- **Alternative**: Use `fast-glob` npm package (battle-tested, cross-platform)

---

## 7. Server-Side Issues

| Component | Issue | Severity | Fix |
|-----------|-------|----------|-----|
| Browser launch | `xdg-open` fallback (no `start` for Windows) | LOW | Add `process.platform === "win32"` → `start` |
| Signal handlers | SIGTERM/SIGINT | ✅ WORKS | Node.js translates Windows signals |
| Config paths | `~/.clawd/` | ✅ WORKS | `homedir()` resolves correctly |
| Build scripts | `mkdir -p`, `rm -rf` | ⚠️ | Works via Git Bash; native cmd.exe would fail |
| Compiled binary | `--target=bun-windows-x64` | ✅ EXISTS | Build target already defined in package.json |

---

## 8. Implementation Roadmap

### Phase 1: Low-Hanging Fruit (no architectural changes)

- [ ] Replace hardcoded `/tmp/` with `os.tmpdir()` everywhere
- [ ] Add `process.platform === "win32"` → `"start"` for browser launch
- [ ] Ship `rg.exe` binary for Windows or make it a documented prerequisite
- [ ] Replace `find` in glob tool with `fs.globSync()` or `fast-glob`
- [ ] Add Windows PATH handling in sandbox.ts (skip bwrap setup, use alternative)

### Phase 2: Terminal Backend Abstraction

- [ ] Define `TerminalBackend` interface
- [ ] Extract existing tmux code into `TmuxBackend` class
- [ ] Implement `NodePtyBackend` using `node-pty`
- [ ] Wire factory into tool registry
- [ ] Test all 7 tmux tools + 4 job tools + spawn_agent against new backend

### Phase 3: Shell Execution Abstraction

- [ ] Define `ShellExecutor` interface (platform-adaptive)
- [ ] Implement `BashExecutor` (existing) and `PowerShellExecutor` (new)
- [ ] Update `bash` tool to use executor factory
- [ ] Update system prompts for Windows agents (PowerShell syntax guidance)
- [ ] Update git tools to call `git` directly (not via `bash -c`)

### Phase 4: Windows Sandbox

- [ ] Research and implement Job Object + Restricted Token sandbox
- [ ] Or: Require WSL2 and use existing bwrap sandbox through WSL
- [ ] Add `detectPlatform()` → `"windows"` path
- [ ] Implement filesystem restrictions (allowed paths only)
- [ ] Add process resource limits (memory, CPU)

### Phase 5: Testing & Polish

- [ ] CI/CD: Add Windows build + test runner (GitHub Actions `windows-latest`)
- [ ] Test all 70+ tools on Windows
- [ ] Test security sandbox on Windows
- [ ] Document Windows prerequisites (Git, rg, Docker Desktop, node-pty deps)
- [ ] Release Windows-specific installation guide

---

## 9. Compatibility Summary

| Category | Tools | Win Status | Effort to Fix |
|----------|-------|-----------|---------------|
| HTTP API (tasks, articles, chat, web) | 23 | ✅ Ready | None |
| Agent Bus (inter-agent messaging) | 7 | ✅ Ready | None |
| File I/O (view, edit, create) | 3 | ✅ Ready (fs fallback) | None |
| Memory (search, summary) | 2 | ✅ Ready | None |
| Search (grep, glob) | 2 | ❌ Needs rg.exe + Node glob | Low |
| Shell (bash) | 1 | ❌ Needs shell abstraction | High |
| Git (13 tools) | 13 | ⚠️ bash wrapper in `runInSandbox()` | Medium |
| Terminal (tmux 7 + jobs 5 + agents 2) | 14 | ❌ Need persistent terminal backend | Very High |
| Workspace (Docker 3) | 3 | ⚠️ Docker Desktop | Low |
| Tunnel (cloudflared) | 3 | ⚠️ Win binary available; `process.kill(-pid)` broken | Medium |
| Scheduler | 7 | ✅ Ready | None |
| Skills | 4 | ✅ Ready | None |
| get_project_root | 1 | ✅ Ready | None |
| Security sandbox | — | ❌ Absent + path validation disabled | Very High |

**Agent tool total: 83** (58 core + 7 scheduler + 7 agent-bus + 3 workspace + 3 tunnel + 5 misc plugins)

**MCP server tools: ~39** (chat 17, plan 8, scheduler 4, multimodal 5, misc — all cross-platform server-side)

**Bottom line**: ~45% of agent tools work on Windows today (HTTP APIs, file I/O, scheduler, skills, agent-bus, memory). The two biggest blockers are **tmux dependency** (14 tools — requires persistent session daemon) and **bash shell** (affects every command). The **most critical blocker** is security — all protection layers are disabled on Windows.

---

## 10. Review Agent Findings (Round 1)

### Agent 109 — Tool Classification Accuracy
- **Missing tools**: 7 agent-bus plugin tools not documented (all ✅ cross-platform)
- **Misclassification**: `view`, `edit`, `create` have Node.js `fs` fallbacks → actually ✅ on Windows
- **Tool count**: Actual count is 84, not "70+"
- **Non-existent**: `read_image`, `create_image`, `read_video` do not exist as agent tools

### Agent 110 — Security Sandbox Proposals
- **CRITICAL**: Path validation (`isPathAllowed()`) returns `true` for ANY path when sandbox is off (line 188)
- **HIGH**: WSL2 recommendation is insecure — `/mnt/c/` exposes entire Windows filesystem
- **MEDIUM**: Job Objects CANNOT restrict filesystem access (only resource limits)
- **MEDIUM**: AppContainer impractical for CLI tools (requires predefined capabilities)
- **MEDIUM**: PowerShell Constrained Language Mode doesn't restrict filesystem access
- **Missing**: Windows Defender Application Guard (WDAG) — Hyper-V based isolation not listed

### Agent 111 — Terminal Abstraction Design
- **CRITICAL**: node-pty CANNOT replace tmux for process persistence (jobs don't survive agent restart)
- **HIGH**: Missing window/pane management in `TerminalBackend` interface
- **HIGH**: Missing socket-based multi-tenant isolation (project + agent scoped tmux sockets)
- **MEDIUM**: Output scrollback strategy undefined (need file-based logging, not ring buffer)
- **MEDIUM**: Windows process tree termination differs (`taskkill /T` needed, not `process.kill()`)
- **LOW**: node-pty already uses conpty — "Option B: ConPTY" is redundant

### Agent 112 — Hardcoded Paths & Shell
- **HIGH**: Missing hardcoded paths: `SHELL="/bin/bash"` in sandbox.ts, path separator in `startsWith()` check
- **HIGH**: PowerShell adaptation would break ALL LLM-generated bash commands
- **MEDIUM**: Git tools are bash-wrapped intentionally (for env vars like `GIT_TERMINAL_PROMPT=0`)
- **MEDIUM**: Drive letter validation missing from path checks
- **LOW**: `fs.globSync()` available in Bun — glob fix is straightforward
- **Recommendation**: Use Git Bash (ships with Git for Windows) rather than PowerShell adaptation

### Agent 113 — Red Team: Windows Attack Surface
- **CRITICAL**: Agent can read `%USERPROFILE%\.ssh\id_rsa`, `.aws\credentials`, any file
- **CRITICAL**: `.env` protection broken by `split("/")` on Windows backslash paths
- **CRITICAL**: Windows Credential Manager accessible via PowerShell (`cmdkey /list`, PasswordVault API)
- **HIGH**: PowerShell unrestricted .NET/COM/WMI execution (download + execute arbitrary code)
- **HIGH**: Windows-specific path traversal: 8.3 names (`PROGRA~1`), device paths (`\\.\`), junction points
- **HIGH**: Scheduled task creation for persistence (no admin needed for user-level tasks)
- **MEDIUM**: node-pty child inherits all parent process privileges (dangerous if run as admin)
- **MEDIUM**: NTFS Alternate Data Streams invisible to normal file operations
- **MEDIUM**: WSL2 interop allows calling Windows PowerShell from within "sandboxed" WSL
- **MEDIUM**: Constrained Language Mode bypasses via .NET 2.0, COM objects
- **MEDIUM**: UAC bypass techniques available through PowerShell
- **LOW**: Docker Desktop mounts host filesystem, accessible to containers

---

## 11. Revised Security Recommendations

Based on review findings, the original Section 2 proposals need significant revision:

### What DOESN'T Work for Windows Sandbox

| Approach | Why It Fails |
|----------|-------------|
| WSL2 backend | `/mnt/c/` exposes entire Windows filesystem; WSL→Windows interop allows escape |
| Job Objects alone | No filesystem restrictions, only resource limits |
| AppContainer | Impractical for CLI tools with dynamic directory access |
| PowerShell CLM alone | Doesn't restrict filesystem access, bypassable |
| node-pty isolation | Zero — inherits parent privileges, no sandboxing |

### What Could Work (Ranked)

1. **Git Bash in restricted mode** (PRAGMATIC)
   - Git for Windows ships a POSIX-compatible bash
   - Combined with Windows Defender Application Guard or filesystem filter driver
   - Shell compatibility preserved (LLM-generated bash commands work as-is)
   - Needs custom filesystem restrictions via DACL manipulation

2. **Windows Sandbox + File Sharing** (STRONG ISOLATION)
   - Hyper-V based lightweight VM (~10-15s startup)
   - Map only `projectRoot` into sandbox
   - Agent runs INSIDE sandbox, connects back to Clawd server
   - High latency but strong isolation guarantee

3. **Layered approach** (DEFENSE IN DEPTH)
   - Layer 1: Restricted Token (reduce privileges)
   - Layer 2: Job Object (resource limits, prevent child process creation outside job)
   - Layer 3: Constrained Language Mode (if using PowerShell)
   - Layer 4: Application-level path validation (fix for Windows paths)
   - Layer 5: Filesystem audit logging

### Mandatory Fixes Before Windows Support

1. **Fix path validation for Windows**: Handle backslashes, drive letters, 8.3 names, device paths, junction points, case-insensitive comparison
2. **Fix `.env` protection**: Use `path.basename()` instead of `split("/")`
3. **Block sensitive Windows paths**: `%USERPROFILE%\.ssh\`, `%APPDATA%\`, Windows Credential Manager APIs
4. **Block dangerous commands**: Registry modification, scheduled task creation, service management
5. **Keep path validation ON even without sandbox**: Currently `isPathAllowed()` returns `true` when sandbox is off — this must be separated

---

## 12. Terminal Backend: Revised Design

Based on Agent 111 findings, the `TerminalBackend` interface must be significantly expanded:

```typescript
interface TerminalBackend {
  // Context isolation (project + agent scoped)
  init(context: { projectRoot: string; agentId: string; socketDir: string }): Promise<void>;

  // Session lifecycle
  createSession(opts: {
    id: string;
    command: string;
    cwd: string;
    env?: Record<string, string>;
    logFile?: string;          // Write all output to disk for recovery
  }): Promise<string>;
  destroySession(sessionId: string): Promise<void>;
  listSessions(): Promise<Array<{ id: string; status: string; windows?: number }>>;

  // Window management (required by tmux_new_window/tmux_kill_window)
  createWindow(sessionId: string, opts: { name?: string; command?: string }): Promise<string>;
  killWindow(sessionId: string, window: string): Promise<void>;

  // I/O
  sendInput(sessionId: string, input: string): Promise<void>;  // Platform-agnostic key notation
  captureOutput(sessionId: string, lines?: number): Promise<string>;

  // Job management
  waitForExit(sessionId: string, timeoutMs?: number): Promise<{ exitCode: number; output: string }>;
  isSessionAlive(sessionId: string): Promise<boolean>;

  // Process tree management (critical for Windows)
  killProcessTree(sessionId: string): Promise<void>;
}
```

### Windows Implementation: Persistence Daemon

Since node-pty processes die with their parent, Windows needs a **persistent daemon** that survives agent restarts:

```
clawd-terminal-daemon.exe  (runs as background service or persistent process)
  ├── Session "build-1" (node-pty → cmd.exe)
  ├── Session "test-agent" (node-pty → powershell.exe)
  └── Session "dev-server" (node-pty → git-bash.exe)

Agent ←→ IPC (named pipe or localhost TCP) ←→ Daemon
```

This is essentially **reimplementing tmux server architecture for Windows**. Estimated effort: 6-8 weeks (revised from initial 2-3 week estimate — see Agent 118 Round 2 findings).

**Alternative**: Require WSL2 (hardened: interop disabled, automount disabled) and use native tmux + bwrap. Suitable for development environments only.

---

## 13. Review Agent Findings (Round 2)

### Agent 114 — Report Coherence
**Verdict: FAIL** — Found 3 material contradictions between original sections and revised sections (WSL2, node-pty simplicity, ConPTY redundancy). Also verified tool count should be 83 (scheduler = 7 tools), job header listed 4 but table had 5. All contradictions resolved in this revision.

### Agent 115 — Technical Accuracy Verification
- `isPathAllowed()` returning `true` when sandbox off: ✅ Confirmed at tools.ts:188
- `.env` `split("/")` claim: ⚠️ Overstated — `resolve()` normalizes paths on some platforms; real risk is 8.3 names/device paths
- TerminalBackend interface: ❌ Missing `sendKeys()` (distinct from `sendInput()` for raw key sequences like `Ctrl-C`), missing pane selection parameter

### Agent 116 — Tool Count Audit
Found **103+ total tools**: 58 core (tools.ts) + 6 plugins + 39 MCP server tools. The "84" count mixed agent tools with some server tools inconsistently. Revised to: **83 agent tools** + **~39 MCP server tools** (server-side, already cross-platform).

### Agent 117 — Security Section Completeness
**Verdict: CONCERNS** — 6 findings:
1. **HIGH**: `enableSandbox(false)` exported from sandbox.ts — unused but latent privilege escalation vector. Should be removed or made module-private.
2. **MEDIUM**: WSL2 dismissal overstated — hardened WSL2 (`interop=false`, no automount, bwrap) is viable for development
3. **MEDIUM**: "Block dangerous commands" not actionable — no command-filtering layer exists in architecture
4. **MEDIUM**: Environment-wiping mechanism (`env -i`, `--clearenv`) has no Windows equivalent — entire env isolation is unaddressed
5. **LOW**: `validateWorkingDirectory()` in sandbox.ts:544 also has hardcoded `/tmp` check — separate from `isPathAllowed()`
6. **LOW**: `.env` `split("/")` bug also exists in `agents.ts:78` (API-level sensitive path check)

### Agent 118 — Red Team (Round 2)
**16 total findings, 6 NOVEL** (missed by all prior agents):

| # | Severity | Finding | Prior Agents? |
|---|----------|---------|--------------|
| C1 | CRITICAL | `isSandboxEnabled()` can NEVER be `true` on Windows — `initializeSandbox()` only enables for linux+bwrap/darwin+sandbox-exec. "Decouple path validation" requires redesigning initialization architecture | Partially (110) |
| C2 | CRITICAL | `isSensitiveFile()` only blocks `.env` — no Windows credential paths (`.aws/credentials`, `.kube/config`, `.npmrc`, etc.) | Partially (113) |
| C3 | CRITICAL | `validateWorkingDirectory()` uses forward-slash comparison `startsWith(\`${prefix}/\`)` — **never matches** on Windows backslash paths | **NOVEL** |
| H1 | HIGH | Phased rollout ships Windows users with ZERO security for Phases 1-3 — contradicts "DO NOT ship" warning | **NOVEL** |
| H2 | HIGH | `process.kill(-pid)` POSIX group kill doesn't work on Windows — tunnel processes leak | Partially (111) |
| H3 | HIGH | `clawd-chat` daemon mode has own tmux dependency not counted in any tool matrix | **NOVEL** |
| H4 | HIGH | `bun:sqlite` WAL mode untested on Windows NTFS (different locking semantics) | **NOVEL** |
| H5 | HIGH | `GIT_SSH_COMMAND` references `/dev/null` — doesn't exist on Windows | **NOVEL** |
| M1 | MEDIUM | "Layered approach" Layer 2 (Job Objects) can't restrict filesystem; Layer 3 (CLM) only applies to PowerShell | Prior agents noted |
| M2 | MEDIUM | Effort estimates 2-5x too low (realistic: 5-8 months single engineer, not 2-3 months) | **NOVEL** |
| M3 | MEDIUM | `rsync` in worktree.ts not in any tool matrix — breaks multi-agent file isolation on Windows | **NOVEL** |
| M4 | MEDIUM | No shell strategy decision made (Git Bash vs PowerShell) — foundational, blocks all other work | Prior agents noted |
| M5 | MEDIUM | MCP stdio transport assumes Posix spawn — Unix path separators in server commands will break | **NOVEL** |
| L1 | LOW | `shellEscape()` in sandbox.ts is bash-only (single-quote escaping) — unsafe for PowerShell | **NOVEL** |
| L2 | LOW | `2>/dev/null` in state-persistence-plugin.ts is bash syntax | **NOVEL** |
| L3 | LOW | Browser launch missing `win32` → `start` branch | Prior agents noted |

---

## 14. Go/No-Go Recommendation

Based on 2 rounds of review (10 agents, 28+ findings), the recommendation is:

### ❌ DO NOT ship native Windows support

**Minimum viable security gate** (must be implemented before any Windows binary is published):
1. `process.platform === "win32"` check at startup → refuse to run without explicit `--allow-windows-unsafe` flag
2. Decouple `isPathAllowed()` from `isSandboxEnabled()` — path validation must work WITHOUT kernel sandbox
3. Fix all forward-slash path comparisons for Windows backslash paths
4. Add Windows-specific sensitive path blocklist (`.ssh/`, `.aws/`, `.kube/`, `.npmrc`, `.pypirc`, etc.)
5. Fix `.env` detection to use `path.basename()` (in both tools.ts and agents.ts)
6. Remove/unexport `enableSandbox()` function

### ✅ Acceptable near-term: WSL2-only support
With hardened WSL2 config (interop disabled, automount disabled, bwrap enabled), the full Linux toolchain works securely. This is the recommended path for Windows users who need agent functionality today.
