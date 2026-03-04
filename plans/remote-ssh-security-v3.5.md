# Claw'd — Remote Machine Support Plan (v3 — Final Refinement)

## Problem Statement

Agents currently operate only on the local filesystem via sandboxed `fs` and `child_process` calls. Users need agents to work on remote machines accessible via SSH (hosts defined in `~/.ssh/config`). The project field in the Agents dialog must support `machine:/path/to/project` syntax, and all file/bash tools must transparently execute on the remote machine when configured.

## Proposed Approach

**Abstraction layer:** Introduce a `ProjectExecutor` that wraps command/file execution. For local projects, the executor unifies the existing dual sandbox/direct-fs paths. For remote projects, it tunnels operations over SSH via ControlMaster multiplexed connections.

**Key design principles:**
1. Parse `~/.ssh/config` for host discovery, but use `-F /dev/null` and reconstruct SSH args (only Hostname, Port, User, IdentityFile) to prevent dangerous config options like ProxyCommand from executing
2. `LocalExecutor` unifies both sandbox and non-sandbox code paths (one tool path, not three)
3. Remote is explicit **trust mode** — no false security claims about containment
4. Strangler Fig migration — tools migrated in batches, not big-bang
5. All file writes use stdin piping, never heredoc (fixes pre-existing injection vulnerability)
6. Remote commands use `bash --norc --noprofile` to prevent shell init scripts from re-introducing secrets

---

## Review Findings Incorporated

Three rounds of independent review (5 agents each, 15 total) + one targeted tmux security audit (5 agents). All critical and high-priority findings addressed:

### Round 1 (v1 → v2)
| Agent | Focus | Critical | High | Medium | Key Finding |
|-------|-------|----------|------|--------|-------------|
| Agent-54 | Architecture | 3 | 4 | 3 | Heredoc injection, host validation, incomplete interface |
| Agent-55 | Tool Adaptation | 3 | 5 | 7 | Sub-agent tools unaddressed, TmuxJobManager sync, 3-path risk |
| Agent-56 | Security | 4 | 5 | 3 | Double-shell injection, ForwardAgent, .env bypass, path traversal |
| Agent-57 | UI/UX | 1 | 3 | 3 | ProjectsDialog crash, combobox, AbortController |
| Agent-58 | Phases | 3 | 2 | 4 | Redundant phases, big-bang risk, missing testing |

### Round 2 (v2 → v3)
| Agent | Focus | Critical | High | Medium | Key Finding |
|-------|-------|----------|------|--------|-------------|
| Agent-59 | Security | 1 | 2 | 1 | SSH config bleedthrough (ProxyCommand), writeFile path injection, env-i login shell bypass |
| Agent-60 | Architecture | 0 | 2 | 2 | listDir return type, hooks disabled for remote, sync→async cascade |
| Agent-61 | Phases | 1 | 3 | 2 | Phase 3 needs batches 1-4, AgentContext task, security items in Phase 2 |
| Agent-62 | Tools/UX | 0 | 3 | 3 | Category A split (A1/A2), DB migration, server-side agents.ts changes |
| Agent-63 | Edge Cases | 3 | 5 | 5 | Include recursion bomb, --norc/--noprofile, SIGTERM propagation, LANG=C.UTF-8 |

### Round 3: Tmux Security Deep Audit (v3 → v3.1)
Targeted security review of tmux session handling (jobs, sub-agents, interactive sessions). 34 unique findings across 5 specialized agents:

| Agent | Focus | Critical | High | Medium | Low | Key Finding |
|-------|-------|----------|------|--------|-----|-------------|
| Agent-69 | Job command injection & sandbox bypass | 1 | 3 | 3 | 1 | tmux_send_command bypasses sandbox entirely |
| Agent-70 | Sub-agent privilege escalation & escape | 4 | 2 | 2 | 1 | Sub-agents run WITHOUT sandbox, name/task injection |
| Agent-71 | Tmux socket isolation & lifecycle | 0 | 3 | 7 | 3 | Shared socket = cross-agent hijack, no resource limits |
| Agent-72 | Remote SSH + tmux interaction | 2 | 4 | 5 | 1 | Multi-layer shell injection, TOCTOU, poll hang |
| Agent-73 | Trust model & defense-in-depth | 4 | 4 | 3 | 3 | No centralized security middleware, no audit trail |

**Deduplicated totals: 7 CRITICAL, 12 HIGH, 11 MEDIUM, 4 LOW — all addressed in Phase 0 below.**

### Round 4: Phase 0 Remediation Review (v3.1 → v3.2)
Targeted review of Phase 0 security hardening plan. 5 specialized agents with distinct focuses:

| Agent | Focus | Verdict | Key Finding |
|-------|-------|---------|-------------|
| Agent-75 | Phase 0A exec injection fixes | CONDITIONAL PASS | Missed files: clawd-chat/index.ts (2× execSync), worktree.ts (9× execSync). Heredoc fix blocked by runInSandbox stdin:ignore. |
| Agent-76 | Phase 0B sub-agent security | CONDITIONAL PASS | **BLOCKER:** bwrap --die-with-parent defeats tmux persistence. --tmpfs /home hides socket. CLAWD_AGENT_DEPTH stripped by --clearenv. |
| Agent-77 | Phase 0C-0E isolation/audit | CONDITIONAL PASS | **CRITICAL:** `tmux_send_input` = complete sandbox escape (not in any fix). Audit log in project root writable by sandbox. |
| Agent-78 | Overall plan coherence | CONDITIONAL PASS | Phase dependency DAG too conservative (not all Phase 0 blocks Phase 1). H5 must cover all 3 socket systems. |
| Agent-79 | Residual attack surface (red team) | FAIL | **NEW:** tmux command-mode escape (C-b : run-shell), SSRF via web_fetch, no internal API auth. |

**All findings addressed in v3.2 Phase 0 update above. Key fixes:**
1. `tmux_send_input` added to C1 scope (0C) — .env check + command-mode blocking
2. bwrap architectural conflict resolved (0B) — sandbox clawd INSIDE script, not tmux invocation
3. `CLAWD_AGENT_DEPTH` added to `getSafeEnvVars()` (0B)
4. Phase dependency DAG formalized at top of Phase 0
5. H5 expanded to cover all 3 socket systems (0C)
6. clawd-chat/index.ts and worktree.ts added to 0A scope
7. Heredoc fix uses temp-file-then-copy (not stdin piping) due to runInSandbox stdin:ignore
8. Startup reaper added for crash recovery (0D)
9. Tool security metadata registry designed (0E)
10. Audit log moved to ~/.clawd/audit/ (not project dir)
11. Security regression tests added (0G)

### Round 5: v3.2 Verification Review (v3.2 → v3.3)
Final verification of Round 4 fixes. 5 focused agents:

| Agent | Focus | Verdict | Key Finding |
|-------|-------|---------|-------------|
| Agent-80 | C1 tmux_send_input fix | CONCERN | Regex insufficient — MUST disable ALL tmux tools for sandboxed agents as primary fix |
| Agent-81 | C2 bwrap+tmux resolution | CONCERN | Nested bwrap breaks (inner bwrap inside outer). Use inner per-tool sandboxing instead. Need config.json mount. |
| Agent-82 | Heredoc temp-file fix | CONCERN | runInSandbox API mismatch (cmd+args not string). /tmp IS visible (bind mount ✅). Need try/finally. |
| Agent-83 | Phase dependency DAG | CONCERN | 0F merged with 0A (same file). 0A heredoc merges INTO Batch 1. Tools.ts parallel branches need rebase. |
| Agent-84 | v3.2 completeness | **PASS** | 12/12 gaps addressed ✅. Minor: SSRF/API auth out of scope, audit naming fix. |

**All concerns resolved in v3.3 update:**
1. Tmux tools → disabled for sandboxed agents (primary), regex as supplementary UX signal
2. C2 → rely on inner per-tool sandboxing, not outer bwrap (avoids nested namespace issue)
3. Heredoc → `runInSandbox("cp", [tmpFile, resolvedPath])` with try/finally
4. DAG → 0A+0F merged, heredoc into Batch 1, rebase documented

### Round 6: Deep Security Audit (v3.3 → v3.4)
6 specialized agents (85–90) with full source code access. 17 findings total (4 CRITICAL, 8 HIGH, 5 MEDIUM). **11 are NOVEL** — not covered by any previous round:

| Agent | Focus | Verdict | C/H/M | Key Novel Finding |
|-------|-------|---------|-------|-------------------|
| Agent-85 | 0A exec injection | CONCERN | 3/4/3 | Script-content injection (name/task in bash script body) NOT fixed by execFileSync. 5 injection sites, plan covers 2. |
| Agent-86 | 0B sub-agent security | CONCERN | 3/4/3 | Zero plan items implemented. --task-file flag doesn't exist. CLAWD_SANDBOXED=1 bypassable (process.env mutable). |
| Agent-87 | 0C tmux isolation | **FAIL** | 3/4/3 | Full process.env leaked to tmux. No cwd validation on tmux_send_command. Socket collision via .slice(-20). |
| Agent-88 | 0D-0E resources/audit | **FAIL** | 3/3/3 | Bash tool creates untracked tmux sessions bypassing ALL limits. 0% implementation of any 0D/0E item. |
| Agent-89 | Phase 2 remote SSH | CONCERN | 2/3/1 | **BASH_ENV bypass CONFIRMED empirically** — outer bash sources BASH_ENV before env -i runs. SSH shellEscape() unspecified. |
| Agent-90 | Red team full surface | CONCERN | 4/5/4 | **NOVEL:** Hook system RCE outside sandbox. Zero API auth + CORS *. macOS ~/.config leak. MCP tools bypass. enableSandbox() exported. |

**CRITICAL novel findings requiring plan updates:**

1. **R6-C1: Project hooks RCE (Agent-90)** — `.clawd/hooks/{name}/index.js` loaded via dynamic `import()` in main process. Runs with full host privileges OUTSIDE sandbox. Attacker repo gets RCE. ALL sandbox hardening is moot.
   → **Add Phase 0H: Hook Security** — either sandbox hook execution, require user approval per project, or restrict to `~/.clawd/hooks/` only.

2. **R6-C2: Zero API auth + CORS * (Agent-90)** — All endpoints on `0.0.0.0` with `Access-Control-Allow-Origin: *`. Any webpage can call localhost API. SSH remote exec in Phase 3 makes this CRITICAL.
   → **Add pre-Phase 3 auth requirement** — at minimum: localhost-only bind, CORS restriction, session token.

3. **R6-C3: BASH_ENV bypass (Agent-89)** — Empirically confirmed: `sshd → bash -c "env -i ..."` sources BASH_ENV in the OUTER bash. Side effects run before env -i. Fix: `unset BASH_ENV ENV;` prefix or use `/bin/sh` as outer shell.
   → **Add to Phase 2 SSH design**.

4. **R6-C4: Script-content injection (Agent-85/86)** — Plan's execFileSync conversion fixes the `execSync` call but NOT the name/task interpolation into the bash script body. This is a separate vulnerability.
   → **Strengthen 0A/0B: Pass ALL values via env vars in scripts, not interpolation.**

**HIGH novel findings:**
- **R6-H1:** macOS Seatbelt allows ~/.config (cloud credentials) — restrict to specific tool-chain dirs
- **R6-H2:** Hook singleton leaks across agents/projects — reinitialize per agent
- **R6-H4:** `enableSandbox()` exported — make non-exported or frozen
- **R6-H5:** process.env leaked to tmux — use `getSafeEnvVars()`
- **R6-H6:** clawd-chat script content injection (L170-178) — not just L185/L191 execSync
- **R6-H7:** SSH shell escaping unspecified — must use execFile("ssh",...) to avoid local shell
- **R6-H8:** Bash tool creates untracked tmux — add tmux to restricted commands or monitor

### Round 7: v3.4 Verification + Red Team (v3.4 → v3.5)
6 specialized agents (91–96) with full source code access. 24 findings total (6 CRITICAL, 11 HIGH, 5 MEDIUM, 2 LOW). **19 are NOVEL**:

| Agent | Focus | Verdict | C/H/M/L | Key Novel Finding |
|-------|-------|---------|---------|-------------------|
| Agent-91 | 0A/0B script injection | CONCERN | 0/2/1/1 | clawd-chat `args.join(" ")` reconstruction unsafe; worktree.ts + tmux_send_command workDir still unaddressed |
| Agent-92 | 0H hook/plugin security | CONCERN | 3/3/2/1 | **initializeSandbox() not idempotent** — yolo agent disables sandbox for ALL. Path-based approval bypassable via symlinks. MCP env leak. |
| Agent-93 | 0I/0J bash tmux + API auth | CONCERN | 2/4/3/0 | Regex trivially bypassed (8 techniques). **macOS has no binary deny**. WebSocket no origin check. Session token bootstrap problem. |
| Agent-94 | Phase 2 SSH BASH_ENV | CONCERN | 1/2/0/0 | **bash-as-sh STILL sources BASH_ENV** (breaks Option A). **NEW Option C: stdin pipe + bash --posix** is strongest mitigation. |
| Agent-95 | tmux env/resource/lifecycle | **FAIL** | 0/3/2/0 | **4 env leak paths** not 1. Zero resource limits implemented. No reaper. No shutdown cleanup. Dead code. 3 disconnected socket topologies. |
| Agent-96 | Red team full surface | **FAIL** | 3/4/4/2 | **NOVEL:** html_preview stored XSS→RCE via blob URL. chat_upload_local_file arbitrary file read. ReDoS. WebSocket cross-channel. Agent identity spoofing. |

**CRITICAL novel findings requiring plan updates:**

1. **R7-02: Stored XSS → RCE via html_preview (Agent-96)** — `chat_send_message` MCP tool stores arbitrary HTML. UI renders in `<iframe sandbox="allow-scripts">`. "Open in new tab" creates unsandboxed Blob URL → full RCE. Combined with zero auth (R7-01), any webpage can inject persistent XSS.
   → **Add to Phase 0K: MCP Tool Security Hardening** — sanitize HTML server-side, remove unsafe blob URL opener.

2. **R7-03: Arbitrary file read via chat_upload_local_file (Agent-96)** — MCP tool accepts any absolute path, reads with `readFileSync`, zero path validation. Can read `/etc/shadow`, `~/.ssh/id_rsa`, `~/.clawd/config.json` (API keys).
   → **Add to Phase 0K** — add path validation identical to `validateProjectPath()`.

3. **R7-14: initializeSandbox() not idempotent (Agent-92)** — Each `executePrompt()` re-calls `initializeSandbox()`. Agent B with `yolo:true` sets process-global `sandboxIsEnabled=false`, disabling sandbox for concurrent Agent A. **Active race condition.**
   → **Strengthen 0H** — add idempotency guard + lockSandbox().

4. **R7-15: Path-based hook approval bypassable (Agent-92)** — Symlink/rename attacks bypass path-based `approved-hooks.json`. Must use content hash of `.clawd/hooks/` directory.
   → **Update 0H** — use content-hash-based approval, not path-based.

5. **R7-20: bash-as-sh STILL sources BASH_ENV (Agent-94)** — On systems where `/bin/sh → bash`, Option A fails. `bash --posix` suppresses BASH_ENV. Stdin pipe approach avoids outer-shell BASH_ENV entirely.
   → **Replace Phase 2 Options A/B with Option C: stdin pipe + bash --posix + random heredoc delimiter.**

**HIGH novel findings:**
- **R7-04:** ReDoS via `new RegExp(userInput)` in chat_query_messages — DoS the server
- **R7-05:** WebSocket cross-channel subscription + "receive all" fallback — full surveillance
- **R7-06:** Agent identity spoofing — no agent_id verification on mutation endpoints
- **R7-16:** Node module cache prevents hook reloading after git pull
- **R7-17:** macOS has no tmux binary deny mechanism (sandbox-exec can't shadow binaries)
- **R7-18:** WebSocket has no origin validation — cross-site WS hijacking
- **R7-21:** NEW Option C (stdin pipe) is strongest SSH BASH_ENV mitigation
- **R7-23:** process.env leaked in 4 tmux paths (tools.ts, tmux-manager.ts×2, clawd-chat)

**MEDIUM/LOW novel findings:**
- **R7-08:** saveSkill path traversal via skill.name
- **R7-09:** MCP chat_upload_file no size limit (100MB body accepted)
- **R7-11:** gitignoreCache + fileCache unbounded growth → OOM
- **R7-12:** Content-Disposition header injection via file.name
- **R7-13:** Mermaid SVG dangerouslySetInnerHTML

---

## Architecture

### 1. Executor Interface (Extended)

```typescript
interface ProjectExecutor {
  // File operations
  readFile(path: string): Promise<string>;
  readFileBinary(path: string): Promise<Buffer>;
  writeFile(path: string, content: string | Buffer): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ isDir: boolean; size: number; mode: number }>;
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  resolvePath(relativePath: string): string;
  
  // Command execution
  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;
  execStream(command: string, opts?: ExecOpts): AsyncIterable<string>;
  
  // Metadata
  readonly isRemote: boolean;
  readonly projectRoot: string;
  readonly host?: string;
  readonly remoteHome?: string; // remote $HOME (fetched once on connect)
  
  // Lifecycle
  destroy(): Promise<void>;
}

interface ExecOpts {
  cwd?: string;
  timeout?: number;
  stdin?: string | Buffer;
  env?: Record<string, string>; // additional env vars (merged, not replaced)
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}
```

Two implementations:
- **`LocalExecutor`** — unifies BOTH existing sandbox and direct-fs paths into one interface (eliminates dual `if (isSandboxReady())` branching across tools.ts)
- **`RemoteExecutor`** — tunnels operations over SSH via ControlMaster

### 2. RemoteExecutor Design

```
┌─────────────────────────────────────────────────────────┐
│  Agent Tool (bash, view, edit, grep, glob, git_*)       │
│  ↓ calls executor.exec() / executor.readFile()          │
├─────────────────────────────────────────────────────────┤
│  RemoteExecutor                                          │
│  ├── SSH ControlMaster (persistent multiplexed conn)    │
│  ├── exec() → execFile("ssh", [...args, command])       │
│  │   command wrapped: env -i LANG=C.UTF-8 HOME=$HOME    │
│  │   PATH=$PATH bash --norc --noprofile -c '...'        │
│  ├── readFile() → ssh "cat <escaped-path>" | pipe       │
│  ├── writeFile() → pipe stdin → ssh                     │
│  │   "T=$(mktemp) && cat > $T && mv $T <escaped-path>"  │
│  │   (atomic via mktemp+mv, shell-escaped path)         │
│  └── resolvePath() → uses remoteHome, not local cwd     │
├─────────────────────────────────────────────────────────┤
│  SSH connection built with -F /dev/null (ignores user   │
│  config) + reconstructed args from parsed SSH config:   │
│  -o Hostname=x -o Port=y -o User=z -i <identityFile>   │
│  -o ControlMaster=auto -o ControlPath=~/.clawd/ssh/ctrl │
│  -o ForwardAgent=no -o ForwardX11=no                    │
│  -o PermitLocalCommand=no -o SendEnv= -o SetEnv=        │
├─────────────────────────────────────────────────────────┤
│  ControlMaster socket at ~/.clawd/ssh/ctrl-<hash>       │
│  0700 dir, per-agent (keyed by host+agentId)            │
│  ControlPersist=120, ServerAliveInterval=15             │
│  Stale socket cleanup on startup                        │
└─────────────────────────────────────────────────────────┘
```

**Critical security: SSH config isolation.** The SSH config is parsed for host discovery (Hostname, Port, User, IdentityFile only), but SSH commands use `-F /dev/null` to ignore the actual config file. This prevents dangerous directives like `ProxyCommand`, `LocalCommand`, `SendEnv`, `RemoteForward` from executing. Connection parameters are reconstructed programmatically.

**Remote command wrapping:**
```bash
# Every remote command is wrapped to:
# 1. Clear environment (env -i)
# 2. Set only safe vars (LANG, HOME, PATH)
# 3. Skip shell init files (--norc --noprofile)
# 4. Run in project directory
env -i LANG=C.UTF-8 HOME=$HOME PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  bash --norc --noprofile -c 'cd /path/to/project && <actual-command>'
```

**File write transport (atomic, injection-safe):**
```bash
# Content piped via stdin → mktemp ensures no symlink attack
# Path shell-escaped for remote shell
echo "<content>" | ssh host "T=\$(mktemp) && cat > \"\$T\" && mv \"\$T\" '<shell-escaped-path>'"
```

**ControlMaster lifecycle:**
```bash
# On first use (setup ControlMaster — uses -F /dev/null + reconstructed args):
execFile("ssh", [
  "-F", "/dev/null",
  "-o", "Hostname=<parsed>", "-o", "Port=<parsed>", "-o", "User=<parsed>",
  "-i", "<parsed-identity-file>",
  "-o", "ControlMaster=auto",
  "-o", "ControlPath=~/.clawd/ssh/ctrl-<sha256-hash-12chars>",
  "-o", "ControlPersist=120",
  "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
  "-o", "ConnectTimeout=10",
  "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
  "-o", "PermitLocalCommand=no",
  "-o", "SendEnv=", "-o", "SetEnv=",
  "-o", "LogLevel=ERROR",
  "-N", "<host-alias>"
])

# Each operation (via execFile, no local shell):
execFile("ssh", ["-F", "/dev/null", "-o", "ControlPath=...", "<host-alias>",
  "env -i LANG=C.UTF-8 HOME=... PATH=... bash --norc --noprofile -c '...'"
])

# On destroy (agent.close() lifecycle hook):
execFile("ssh", ["-F", "/dev/null", "-o", "ControlPath=...", "-O", "exit", "<host-alias>"])
# With 5s timeout — if hangs, force-remove socket file

# On startup — stale socket cleanup:
# Scan ~/.clawd/ssh/ctrl-* for sockets older than ControlPersist
# Remove orphaned sockets from crashed agents
```

**ControlMaster socket naming:** Use SHA-256 hash (truncated to 12 chars) of `host+agentId`, NOT string truncation. Ensures total ControlPath length stays under 104-char Unix socket limit. Verify: `~/.clawd/ssh/ctrl-<12chars>` = ~35 chars + home dir length.

**ControlMaster socket location:** `~/.clawd/ssh/` with 0700 directory permissions. NOT `/tmp/` (fixes H1 from Agent-56, M4 from Agent-55). Socket path: `~/.clawd/ssh/ctrl-<hash>` where hash includes host+agentId.

### 3. SSH Config Parsing

Parse `~/.ssh/config` (with `Include` directive support) to extract connection parameters:

```typescript
interface SSHHost {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

function parseSSHConfig(): SSHHost[] {
  // Read ~/.ssh/config
  // Process Include directives recursively:
  //   - Max recursion depth: 16 (matches OpenSSH)
  //   - Cycle detection via visited-file set
  //   - Glob expansion cap: 100 files per Include
  //   - Resolve relative paths against containing file's directory
  // Skip Match blocks (including Match exec — no local command execution)
  // Extract Host entries
  // Skip wildcard entries (Host *, Host 192.168.*)
  // Skip entries with numeric-only aliases (IP addresses)
  // Extract ONLY: alias, Hostname, Port, User, IdentityFile
  // Ignore all other directives (ProxyCommand, SendEnv, etc.)
  // Return sorted list
}
```

Exposed via: `GET /api/ssh/hosts`

**SSH config isolation strategy:** The parser extracts connection parameters for UI display and for building SSH command args. The actual SSH command uses `-F /dev/null` to prevent any config directive from executing. This prevents `ProxyCommand`, `LocalCommand`, `SendEnv`, `RemoteForward` and other dangerous directives from user configs.

**Host validation:** `parseProjectPath()` validates that the host alias exists in parsed SSH config. Arbitrary hostnames NOT accepted — deny-by-default.

### 4. Project Path Format

Current: `/path/to/project` (local)
New: `host:/path/to/project` (remote) or `/path/to/project` (local, backward compatible)

```typescript
function parseProjectPath(project: string): { host: string | null; path: string } {
  // Support ~/relative paths for remote
  const match = project.match(/^([a-zA-Z][a-zA-Z0-9._-]*):(\/.*|~\/.*)$/);
  if (match) {
    const host = match[1];
    // MUST validate host exists in SSH config (deny-by-default)
    if (!isKnownSSHHost(host)) throw new Error(`Unknown SSH host: ${host}`);
    return { host, path: match[2] };
  }
  return { host: null, path: project };
}
```

---

## Database Changes

No schema change needed — the existing `project TEXT` column in `channel_agents` stores both:
- `/local/path` (local, backward compatible)
- `myserver:/remote/path` (remote)

Parsing happens at the application layer when creating the executor.

---

## Tool Classification (57 tools total)

Based on Agent-55 and Agent-62's analysis:

| Category | Count | Tools | Adaptation Effort |
|----------|-------|-------|-------------------|
| **A1 — Clean executor mapping (git)** | 13 | git_status thru git_show (all via execGitCommand) | Low |
| **A2 — SSH wrapping needed (fs/process)** | 8 | view, edit, create, bash, grep, glob, get_project_root + 1 | Medium-High |
| **B — Heavy rewrite needed** | 12 | job_×5, tmux_×7 | Very High |
| **C — Disable for remote** | 3 | spawn_agent, list_agents, kill_agent | N/A (local only) |
| **D — No adaptation needed** | 21 | task_×7, article_×5, chat_send_article, web_×2, memory_×2, skill_×4 | Zero |

**Category A1 (git tools):** All funnel through `execGitCommand()` → `executor.exec()`. Truly clean one-line change.

**Category A2 (fs/process tools):** Have hidden local dependencies (readFileSync, stat, spawn, sandbox wrapping). Each needs SSH-specific paths for file I/O and command execution. Not "just pipe through SSH."

**Category B (job/tmux):** Requires full async TmuxJobManager rewrite. Remote job polling via blocking SSH command, not 500ms poll loop. Remote tmux sessions on remote machine.

**Category C (sub-agents):** Disabled when `executor.isRemote`. Future: could run locally with remote executor injected.

**Category D (no change):** All API/HTTP/local-infra tools. `skill_*` and `memory_*` intentionally stay local (server-side storage — documented, not accidental).

**Hooks:** `.clawd/hooks/` disabled for remote projects (can't `import()` remote JS files). Global hooks (`~/.clawd/hooks/`) still load normally.

---

## Server Changes

### New files:
- `src/agent/src/utils/executor.ts` — `ProjectExecutor` interface, `LocalExecutor`, `RemoteExecutor`
- `src/agent/src/utils/ssh-config.ts` — `~/.ssh/config` parser (with `Include` support)
- `src/agent/src/tools/file-tools.ts` — split from tools.ts (view, edit, create)
- `src/agent/src/tools/search-tools.ts` — split from tools.ts (grep, glob)
- `src/agent/src/tools/bash-tools.ts` — split from tools.ts (bash)
- `src/agent/src/tools/git-tools.ts` — split from tools.ts (git_*)
- `src/agent/src/tools/job-tools.ts` — split from tools.ts (job_*, tmux_*)

### Modified files:

#### `src/agent/src/tools/tools.ts` → becomes thin registry
- Imports tool definitions from split modules
- Registers all tools in a single `registerTools()` function
- Individual tool handlers moved to per-category modules above

#### `src/agent/src/utils/agent-context.ts`
- Add `executor: ProjectExecutor` to AgentContext
- Add `destroy()` lifecycle method for executor cleanup (fixes Agent-58 finding)

#### `src/agent/src/utils/tmux-manager.ts`
- **Convert from sync to async** — prerequisite for remote support
- Replace 31× `readFileSync`/`writeFileSync` with executor calls
- Replace 6× `execSync` with `executor.exec()`
- Remote job polling: use blocking SSH command (`ssh host "while ! test -f exit_code; do sleep 1; done; cat exit_code"`) instead of 500ms poll loop (fixes H3 from Agent-55)

#### `src/worker-loop.ts`
- Parse project path → create LocalExecutor or RemoteExecutor
- Pass executor into AgentContext
- Call `executor.destroy()` on completion (finally block)
- For remote: use executor to load CLAWD.md and agent identity (fixes Agent-54 finding about `loadClawdInstructions`)

#### `src/api/agents.ts`
- New endpoint: `GET /api/ssh/hosts` — returns parsed SSH config hosts
- New endpoint: `GET /api/ssh/test?host=<host>` — tests SSH connectivity (timeout: 5s)
- Modify project validation to accept `host:/path` format

#### `src/index.ts`
- Register new SSH endpoints
- Update `app.project.tree`/`listDir`/`readFile` to support remote paths via executor

### UI Changes:

#### `packages/ui/src/AgentDialog.tsx`
- Replace plain text `Project` input with two-field UI:
  - **Machine combobox** (filterable, searchable): lists SSH hosts from `/api/ssh/hosts` plus "Local (this machine)" default. Filterable combobox, not plain dropdown (fixes Agent-57: 50+ hosts scenario)
  - **Path input**: the project path on the selected machine
- Auto-test SSH connection on machine selection (inline status indicator: ✅/❌/⏳, not separate button) (fixes Agent-57)
- Remote folder browser via SSH with `AbortController`, 5s timeout, debounced input (fixes Agent-57)
- Display remote indicator icon (🌐) next to agent name in channel when remote
- Support `~/` relative paths in path input

---

## Implementation Phases

### Phase 0: Security Hardening + Pre-requisites

**Phase dependency graph (refined per Agent-83, Agent-84, Round 6):**
- **0A + 0F are a merged work unit** (same file: tmux-manager.ts — security + async together)
- **0A heredoc fixes (tools.ts L691/L782) merge INTO Phase 1 Batch 1** (fix-during-extract, same pass)
- **0H (hooks), 0I (bash tmux), 0J (API auth), 0K (MCP/UI security) are independent** — can start immediately in parallel
- **0J MUST complete before Phase 3** (SSH endpoints without auth = critical)
- Phase 1 batches 1-4: require **0A on tmux-manager.ts/worktree.ts/clawd-chat** only
- Phase 1 batch 5: requires **0A + 0B + 0C + 0F complete** (all tmux/job security)
- **0B, 0C, 0D, 0E execute in parallel** with Phase 1 batches 1-4 (but their tools.ts changes must rebase after batches 1-4 merge — line numbers shift)
- **0G depends on 0A + 0B + 0C** (tests what they fix)
- Phase 2+: requires all Phase 0 + Phase 1
- **Deferred (separate security track):** SSRF via web_fetch, MCP tool sandboxing, internal API auth beyond 0J, skill system prompt injection

#### 0A. Eliminate execSync Shell Injection (C3, C4, H2, H3, H4)

The root cause of most injection vulnerabilities is `execSync` with string interpolation. Replace ALL instances with `execFileSync`/`execFile` using argument arrays.

**Scope (expanded per Agent-75 review):**
- `tmux-manager.ts` — ~15 `execSync` call sites
- `tools.ts` — `kill_agent` (L2280), `terminateAllSubAgents` (L3186), `spawnTmuxSubAgent` (L2140-2143), heredoc (L691, L782)
- `clawd-chat/index.ts` — L185, L191 (execSync with tmux, no `-S` socket — uses default tmux server)
- `worktree.ts` — 9× `execSync` with single-quote shell escaping (breaks on embedded quotes in branchName/agentId). **Path: `src/agent/src/workspace/worktree.ts`** (not utils/)

- [ ] **tmux-manager.ts: Replace `execTmux()` with `execFileTmux()`** — Change `execSync(tmuxCmd(args))` (string interpolation) to `execFileSync("tmux", ["-f", "/dev/null", "-S", socketPath, ...args])`. Affects ~15 call sites. Add `-f /dev/null` to all invocations (prevents user `.tmux.conf` hooks — M2). **Note (Agent-75, Agent-78):** Remove shell redirects like `2>/dev/null` from `has-session` and `list-sessions` calls — these don't work with `execFileSync`. Handle stderr via try/catch instead.
  ```typescript
  // BEFORE (vulnerable):
  function execTmux(args: string): string {
    return execSync(`tmux -S "${SOCKET_PATH()}" ${args}`, ...).trim();
  }
  // AFTER (safe):
  function execFileTmux(...args: string[]): string {
    return execFileSync("tmux", ["-f", "/dev/null", "-S", SOCKET_PATH(), ...args],
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  }
  ```
- [ ] **tmux-manager.ts: Fix `getLogs()` tail injection (H2)** — Validate `tail` as positive integer. Consider pure-Node approach (`readFileSync` + `split().slice(-n)`) to eliminate subprocess entirely (Agent-75 recommendation).
- [ ] **tmux-manager.ts: Fix script generation** — Currently `${logFile}` and `${exitFile}` paths are interpolated into bash script (L159-167). Pass via environment variables instead (Agent-75 finding: the real risk is path interpolation, not the command itself which is intentionally arbitrary):
  ```bash
  #!/bin/bash
  exec > "$LOG_FILE" 2>&1
  ( bash "$COMMAND_FILE" )
  echo $? > "$EXIT_FILE"
  ```
- [ ] **tools.ts: Fix heredoc CLAWD_EOF injection (H4)** — Replace heredoc writes at L691 and L782. Use temp-file-then-copy (Agent-82: `/tmp` IS visible in sandbox via bind mount, not tmpfs). **Fix `runInSandbox` API** (Agent-82: takes `command, args[]`, not single string):
  ```typescript
  const tmpFile = join(os.tmpdir(), `clawd-write-${randomUUID()}`);
  try {
    writeFileSync(tmpFile, content, { mode: 0o600 });
    await runInSandbox("cp", [tmpFile, resolvedPath]);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
  ```
  **Note (Agent-82):** Add missing imports: `tmpdir` from `os`, `randomUUID` from `crypto`, `join` from `path`, `unlinkSync` from `fs`. Apply at BOTH L691 (edit) and L782 (create). This fix merges into Phase 1 Batch 1 extraction (same code, same pass).
- [ ] **tools.ts: Fix kill_agent + terminateAllSubAgents `execSync`** — Replace L2280 and L3186 with `execFileSync("tmux", ["-f", "/dev/null", "-S", socketPath, "kill-session", "-t", sessionName])`.
- [ ] **clawd-chat/index.ts: Fix L185, L191 execSync** — Replace with `execFileSync("tmux", [...])`. Also add `-S` dedicated socket instead of using default tmux server (Agent-75 finding).
- [ ] **clawd-chat/index.ts: Fix script content injection (L170-178)** — **NEW (Agent-85 R6-H6):** `channel`, `agentId`, `projectRoot` interpolated raw into bash script body. Pass via env vars: `CLAWD_CHANNEL`, `CLAWD_AGENT_ID`, `CLAWD_PROJECT_ROOT`.
- [ ] **worktree.ts: Fix 9× execSync** — Replace single-quote shell escaping with `execFileSync("git", [...args])`. Agent IDs with special chars in branch names must be sanitized (Agent-75 finding). **Path: `src/agent/src/workspace/worktree.ts`**

#### 0B. Sub-Agent Security (C2, C3, C4, C5)

- [ ] **Sanitize sub-agent `name` parameter (C3)** — Validate with strict allowlist: `/^[a-zA-Z0-9_-]{1,64}$/`. Reject names with shell metacharacters, path separators, or unicode. Apply at **entry point** in `spawn_agent` tool handler (L2208-2211), NOT inside `spawnTmuxSubAgent`. **C3 is a hard prerequisite for C4** — name flows into bash script regardless of task passing method (Agent-76).
  ```typescript
  const SAFE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid agent name: must be alphanumeric/dash/underscore, max 64 chars`);
  // Note: tmux session names cannot contain . or : (tmux interprets as window/pane separators)
  ```
- [ ] **Fix script-content injection in spawnTmuxSubAgent (R6-C4)** — **NEW (Agent-85, Agent-86):** Even with C3 name sanitization AND C4 file-based task passing, the script body at L2126-2136 interpolates `name`, `sandboxRoot`, `logFile`, `clawdCmd` directly. Pass ALL values via env vars in the script:
  ```bash
  #!/bin/bash
  export CLAWD_AGENT_DEPTH=$((${CLAWD_AGENT_DEPTH:-0} + 1))
  cd "$CLAWD_SANDBOX_ROOT"
  echo "Starting sub-agent: $CLAWD_AGENT_NAME" >> "$CLAWD_LOG_FILE"
  exec "$CLAWD_CMD" 2>&1 | tee -a "$CLAWD_LOG_FILE"
  ```
  Set env vars via tmux `new-session` env or `writeFileSync` the script with env vars set via `execFileSync` env option.
- [ ] **Fix task injection — file-based passing (C4)** — Write task to file, pass via `--task-file` CLI flag:
  ```typescript
  const taskFile = join(agentDir, "task.txt");
  const tmpFile = `${taskFile}.tmp`;
  writeFileSync(tmpFile, task, { mode: 0o600 }); // atomic write
  renameSync(tmpFile, taskFile);
  // In script: clawd --task-file "${taskFile}" --result-file "${resultFile}" ...
  // Sub-agent reads task, then deletes file: unlinkSync(taskFile)
  ```
  **Implementation notes (Agent-76):**
  - Requires adding `--task-file` to clawd CLI arg parser (verify which binary sub-agent invokes — `clawd -p` may mean `--port`, not `--prompt`)
  - Task file size limit: reject >1MB (multi-MB prompts cause LLM API failures)
  - File perms `0o600` (owner-only read/write)
  - Sub-agent deletes task file after reading (no parent race condition)
- [ ] **Sandbox sub-agent execution (C2)** — **Approach: Rely on inner per-tool sandboxing (Agent-81 Option 3).**
  
  Don't outer-bwrap the sub-agent. The sub-agent clawd process already calls `initializeSandbox()` and wraps each tool call individually via `wrapCommandForSandbox()`. This is NOT a security gap — each tool invocation IS sandboxed. The tmux session is just a process manager.
  
  **Why not outer bwrap (Agent-81):** Nested bwrap (outer → inner per tool) may fail on kernels with limited `user.max_user_namespaces`. Inner bwrap tries to create mount/user namespaces inside an already-namespaced environment.
  
  **Defense-in-depth:** Set `CLAWD_SANDBOXED=1` env var. Sub-agent detects and prevents `--yolo`:
  ```typescript
  // At startup, FREEZE the value (Agent-86: process.env is mutable, so check once and store):
  const FORCED_SANDBOX = Object.freeze({ value: process.env.CLAWD_SANDBOXED === "1" });
  if (FORCED_SANDBOX.value && args.yolo) {
    throw new Error("Cannot disable sandbox when spawned by sandboxed parent");
  }
  ```
  
  **Required mounts if outer bwrap added in future (Agent-81):**
  - `~/.clawd/config.json` read-only (provider config)
  - `~/.clawd/projects/{hash}/` read-write (result.json)
  - Binary: `~/.clawd/bin/clawd-app-linux-x64` directly (symlink under /home tmpfs)
- [ ] **Enforce recursive depth limit (C5)** — Pass `CLAWD_AGENT_DEPTH` env var AND `--agent-depth N` CLI flag (belt-and-suspenders — Agent-76). Check at top of `spawnTmuxSubAgent()` BEFORE any tmux or filesystem operations.
  ```typescript
  const currentDepth = Math.max(0, parseInt(process.env.CLAWD_AGENT_DEPTH || "0", 10) || 0);
  if (currentDepth >= MAX_DEPTH) {
    return { success: false, output: "", error: `Max agent depth (${MAX_DEPTH}) reached` };
  }
  ```
  **Critical (Agent-76):** Add `CLAWD_AGENT_DEPTH` to `getSafeEnvVars()` in sandbox.ts — bwrap `--clearenv` and macOS `env -i` strip all env vars. The depth var must be explicitly preserved:
  ```typescript
  // In getSafeEnvVars():
  if (process.env.CLAWD_AGENT_DEPTH) {
    env.CLAWD_AGENT_DEPTH = process.env.CLAWD_AGENT_DEPTH;
  }
  ```

#### 0C. Tmux Sandbox & Isolation (C1, H1, H5, H7)

- [ ] **Sandbox `tmux_send_command` AND `tmux_send_input` (C1)** — **PRIMARY FIX (Agent-80): Disable ALL tmux tools for sandboxed agents.** This is the only reliable fix — regex-based blocking is trivially bypassed via multi-call splitting, encoding, and character-by-character typing. When `isSandboxEnabled()`, return error from: `tmux_send_command`, `tmux_send_input`, `tmux_new_window`, `tmux_kill`, `tmux_capture`, `tmux_kill_window`.
  ```typescript
  // At top of each tmux tool handler:
  if (isSandboxEnabled()) {
    return { success: false, error: "SANDBOX RESTRICTION: tmux tools are not available in sandbox mode. Use the bash tool instead." };
  }
  ```
  **Supplementary (defense-in-depth):** Additionally add `.env` pattern check and tmux command-mode blocking as UX friction signals (not security boundaries):
  - `envFilePattern` check on `tmux_send_command` command and `tmux_send_input` keys
  - Block `C-b :` / `C-a :` / `Escape :` sequences in `tmux_send_input`
  - Add `validatePath(workDir)` check to `tmux_send_command`
  - Add session name validation (`/^[a-zA-Z0-9_-]+$/`) to all tmux tools (currently only in `tmux_send_command`)
- [ ] **Add `.env` check to `job_submit` (H1)** — Check `envFilePattern` regex before job submission (same pattern as bash tool).
- [ ] **Per-agent tmux socket isolation — ALL 3 socket systems (H5)** — **Expanded scope (Agent-78):** The codebase has 3 distinct tmux socket mechanisms. All must use per-agent sockets:
  1. **Jobs** (`tmux-manager.ts`): `SOCKET_PATH()` → `<jobsDir>/tmux.sock` (SHARED — fix this)
  2. **Sub-agents** (`tools.ts` L2219-2221): `getSubAgentSocketPath()` → `<agentsDir>/tmux.sock` (SHARED — fix this)
  3. **Interactive tmux** (`tools.ts` L2602-2608): `getTmuxSocket()` → `-L clawd_<hash>_<agent>` (ALREADY per-agent ✅)
  
  Fix systems 1 and 2:
  ```typescript
  // System 1 (jobs): store agentId in socket name
  const SOCKET_PATH = (agentId: string) => join(JOBS_DIR(), `tmux-${agentId}.sock`);
  // System 2 (sub-agents): same pattern
  const getSubAgentSocketPath = (agentId: string) => join(agentsDir, `tmux-${agentId}.sock`);
  ```
  **Impact (Agent-77):** Cross-agent job status will show `cancelled` for other agents' jobs since session not found on the calling agent's socket. Fix: store `agentId` in job metadata so `get()` can check the correct socket.
- [ ] **Fix agent directory permissions (H7)** — Change `mkdirSync(agentDir, { recursive: true })` to `{ recursive: true, mode: 0o700 }`. **Also ensure parent `getProjectAgentsDir()` is created with `0o700`** (Agent-77: recursive mkdir only applies mode to leaf directory).
- [ ] **Fix process.env leakage to tmux sessions (R6-H5)** — **NEW (Agent-87):** `execTmux()` at tools.ts:2570 passes `{ ...process.env, TERM: "xterm-256color" }`. Replace with `{ ...getSafeEnvVars(), TERM: "xterm-256color" }`. Also apply to tmux-manager.ts `execTmux()`.
- [ ] **Fix tmux socket collision (R6-M3)** — **NEW (Agent-87):** `getTmuxSocket()` uses `.slice(-20)` truncation creating collision risk. Replace with crypto hash:
  ```typescript
  const hash = createHash("sha256").update(`${projectRoot}:${agentId}`).digest("hex").slice(0, 16);
  return `clawd_${hash}`;
  ```

#### 0D. Resource Limits & Lifecycle (H6, M4, M6, M8)

- [ ] **Add resource limits (H6)** — Enforce at **manager class level** (primary) AND middleware (belt-and-suspenders — Agent-77):
  ```typescript
  const MAX_JOBS_PER_AGENT = 10;
  const MAX_TMUX_SESSIONS_PER_AGENT = 5;
  const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
  const MAX_SCROLLBACK_LINES = 10000;
  ```
  **Enforcement (Agent-77):** Check in `TmuxJobManager.submit()` and `tmux_send_command` handler (manager-level can't be bypassed regardless of how called). For logs: add `ulimit -f` in wrapper script or use tmux `set-option history-limit 10000` when creating sessions.
- [ ] **Fix `killServer()` scope (M4)** — With per-agent sockets (H5), `kill-server` naturally scopes to agent. Explicit dependency on H5.
- [ ] **Sanitize log/tmux output (M6)** — Strip ANSI escape sequences and cap output size. Apply to ALL output-returning tools (not just tmux_capture — Agent-77):
  ```typescript
  const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
  function sanitizeOutput(output: string, maxBytes: number = 50_000): string {
    return output.replace(ANSI_REGEX, "").slice(0, maxBytes);
  }
  ```
- [ ] **Add tmux cleanup to agent lifecycle + startup reaper (M8)** — Two-part fix (Agent-77):
  1. **Graceful shutdown:** In `agent.close()`, call `tmuxManager.killServer()` (scoped to agent) and `terminateAllSubAgents()`.
  2. **Crash recovery (SIGKILL case):** Add **startup reaper** that runs on agent init:
  ```typescript
  function reapOrphanSessions(agentId: string) {
    // Scan for tmux sockets belonging to this agent
    // If the agent process that created them is gone (check PID file), kill them
    // Also check for sockets older than MAX_AGE (e.g., 24 hours)
  }
  // Call on agent startup, before any tmux operations
  ```

#### 0E. Centralized Security & Audit (M9, H12)

- [ ] **Add security middleware with tool metadata registry (M9)** — Instead of per-tool security checks (which new tools miss), add centralized pre-execution validation. **Requires tool security metadata registry** (Agent-77 — without this, middleware is a leaky sieve):
  ```typescript
  // Tool security metadata (registered alongside tool definition)
  interface ToolSecurityMeta {
    commandArgs?: string[];   // args containing shell commands → .env check
    pathArgs?: string[];      // args containing file paths → validatePath
    createsResources?: boolean; // subject to resource limits
  }
  
  const toolSecurityRegistry = new Map<string, ToolSecurityMeta>();
  toolSecurityRegistry.set("bash", { commandArgs: ["command"], pathArgs: ["cwd"] });
  toolSecurityRegistry.set("tmux_send_command", { commandArgs: ["command"], pathArgs: ["cwd"], createsResources: true });
  toolSecurityRegistry.set("view", { pathArgs: ["path"] });
  // ... registered per tool
  
  async function executeTool(name: string, args: any, ...): Promise<ToolResult> {
    const meta = toolSecurityRegistry.get(name);
    if (meta) {
      for (const arg of meta.pathArgs || []) if (args[arg]) validatePath(args[arg]);
      for (const arg of meta.commandArgs || []) if (args[arg] && envFilePattern.test(args[arg])) return { error: ".env access blocked" };
      if (meta.createsResources) checkResourceLimits(name);
    }
    // Then dispatch to handler...
  }
  ```
  **Note:** Security middleware MUST be blocking and failure-hard. Do NOT implement as a hook (hooks are failure-silent by design — Agent-77).
- [ ] **Add audit logging (H12)** — Log tmux/job/agent operations to structured JSONL. **Location (Agent-77):** Write to `~/.clawd/audit/<project-hash>.jsonl` (NOT project dir — project dir may be read-only, and sandbox-writable audit log is a tampering risk).
  ```typescript
  interface AuditEntry {
    timestamp: number;
    agentId: string;
    action: "tmux_create" | "tmux_kill" | "job_submit" | "agent_spawn" | "agent_kill";
    target: string;
    command?: string; // first 200 chars, redacted for sensitive tools
  }
  ```
  **Concurrency:** Use `fs.openSync(path, 'a', 0o600)` + `fs.writeSync()` for atomic append (O_APPEND, atomic for writes ≤ PIPE_BUF on Linux). Use per-agent audit files (`~/.clawd/audit/audit-{agentId}.jsonl`) for maximum concurrent safety.
  **Rotation:** Max 50MB per file, rotate to `.1` suffix. Prune files >7 days on startup.

#### 0F. Remaining Pre-requisites (merged with 0A — same file, same work unit)

- [ ] **Convert TmuxJobManager to async** — Replace 31x sync fs calls and 6x execSync with async equivalents. Done in SAME pass as 0A on tmux-manager.ts (Agent-83: security + async together).
- [ ] **Cache instructions at agent startup** — Read `CLAWD.md`, agent identity, and system instructions once at startup, store in AgentContext.

#### 0G. Security Regression Tests (depends on 0A + 0B + 0C — Agent-84)

- [ ] **Add injection resistance tests** — For each 0A-0C fix, add regression tests that pass shell metacharacters (`` ; | & $ ` " ' $() \n ``) in job names, sub-agent names, task text, `tail` parameter, and tmux commands. Verify no command execution.
- [ ] **Add resource limit tests** — Verify job/session caps are enforced.
- [ ] **Add depth limit test** — Spawn sub-agent at MAX_DEPTH, verify rejection.
- [ ] **Add tmux sandbox restriction test** — Verify tmux tools return error when `isSandboxEnabled()`, not just `.env` patterns.

#### 0H. Hook & Plugin Security (R6-C1, R6-H2, R6-H4 + R7-14, R7-15, R7-16 — Rounds 6+7)

- [ ] **Restrict project-level hooks to trusted projects only (R6-C1)** — **CRITICAL (Agent-90):** `.clawd/hooks/{name}/index.js` loaded via `import()` in main process — OUTSIDE sandbox. Attacker repo gets RCE with full host privileges. **Approval gate MUST wrap the `import()` call — top-level module code executes on import (R7, Agent-92).**
  1. **(Recommended)** Require user approval per project. **Use content hash of `.clawd/hooks/` directory** (not path — R7-15: path-based approval is bypassable via symlinks/renames). Store in `~/.clawd/approved-hooks.json` as `{ "<sha256-of-hooks-dir>": { "project": "/path", "approved_at": "..." } }`.
  2. **(Alternative)** Disable project-level hooks entirely; only allow user-level hooks from `~/.clawd/hooks/`.
  3. **(Future)** Execute hooks inside sandbox via worker thread with restricted permissions.
- [ ] **Add hook module cache-busting (R7-16)** — **HIGH (Agent-92):** Node/Bun caches `import()` results. After `git pull` changes hooks, in-memory module is stale. Fix: append cache-bust query `import(modulePath + '?v=' + contentHash)`.
- [ ] **Fix HookManager singleton cross-agent leakage (R6-H2)** — **HIGH (Agent-90):** Global singleton means hooks from first project persist for all agents. Fix: reinitialize per agent in `runWithAgentContext()`, or make HookManager per-agent stored in AgentContext.
- [ ] **Fix initializeSandbox() idempotency (R7-14)** — **CRITICAL (Agent-92): Active race condition.** Each `executePrompt()` re-calls `initializeSandbox()`. Agent B with `yolo:true` sets process-global `sandboxIsEnabled=false`, disabling sandbox for concurrent Agent A. Fix:
  ```typescript
  // In initializeSandbox():
  if (sandboxInitialized && sandboxLocked) return; // idempotency guard
  ```
  Call `lockSandbox()` ONCE at process startup after first `initializeSandbox()`.
- [ ] **Protect enableSandbox() from external callers (R6-H4)** — **HIGH (Agent-90):** `enableSandbox(false)` is exported AND re-exported through tools.ts (R7, Agent-92). Fix: remove export + lockSandbox():
  ```typescript
  let sandboxLocked = false;
  export function lockSandbox() { sandboxLocked = true; }
  export function enableSandbox(enabled: boolean) {
    if (sandboxLocked) throw new Error("Sandbox state is locked");
    sandboxIsEnabled = enabled;
  }
  // Call lockSandbox() ONCE in index.ts after initial initializeSandbox()
  // --yolo must be per-agent scoping in AgentContext, not a global toggle
  ```
- [ ] **Fix sandbox state process-global scope (R6-M1)** — **MEDIUM (Agent-90):** `sandboxIsEnabled` is a module-level boolean. Move to AgentContext with global fallback:
  ```typescript
  export function isSandboxEnabled(): boolean {
    const ctx = getAgentContext();
    if (ctx?.sandboxEnabled !== undefined) return ctx.sandboxEnabled;
    return sandboxIsEnabled; // global fallback for non-agent code paths
  }
  ```
- [ ] **Fix macOS Seatbelt ~/.config blanket allow (R6-H1)** — **HIGH (Agent-90):** Restrict to `~/.config/git` only (Agent-92 confirmed this is sufficient).

#### 0I. Bash Tool Tmux Restriction (R6-H8 + R7-17 — Rounds 6+7)

- [ ] **Prevent bash tool from creating untracked tmux sessions (R6-H8)** — **HIGH (Agent-88):** Agent can `tmux new-session` via bash tool. **Layered strategy required (Agent-93):**
  1. **(Primary — Linux)** Shadow tmux binary inside bwrap: `--ro-bind /dev/null /usr/bin/tmux` (and `/usr/local/bin/tmux`). This is safe — legitimate tmux callers (job_submit, tmux_* tools, spawn_agent) invoke tmux from the host Node.js process, NOT from inside bwrap (Agent-93 confirmed).
  2. **(Primary — macOS)** macOS sandbox-exec has NO binary deny mechanism (R7-17, Agent-93). Use PATH manipulation in `getMacOSCommandPrefix()` to exclude tmux, or add Seatbelt deny rule for tmux execution if feasible.
  3. **(Defense-in-depth)** Add regex pattern `/(?:^|[;&|`$( ])\s*(?:\/\S*\/)?tmux\b/` as tripwire (catches naive attempts, not security boundary).
  4. **(Belt-and-suspenders)** Periodic tmux session auditor that detects untracked sessions on known sockets.

#### 0J. Pre-Phase 3 API Security (R6-C2 + R7-01, R7-05, R7-06, R7-18, R7-19 — Rounds 6+7)

- [ ] **Bind to 127.0.0.1 by default (R6-C2)** — Change config.ts default from `0.0.0.0` to `127.0.0.1`. Keep `--host` CLI flag for Docker use. Agent-93 confirmed: doesn't break Cloudflare tunnel (cloudflared connects via localhost).
- [ ] **Restrict CORS to same-origin (R6-C2)** — Change `Access-Control-Allow-Origin: *` to `http://localhost:${PORT}` in BOTH `src/index.ts:398` AND `src/server/mcp.ts:1340` (Agent-93: separate CORS headers). Native MCP clients (Claude Desktop, VS Code) don't send Origin headers → unaffected.
- [ ] **Add session token auth (R6-C2, R7-01)** — Generate `crypto.randomUUID()` at startup, inject into HTML page as `window.__CLAWD_TOKEN`, require as `Authorization: Bearer <token>` on all POST endpoints. Log token to console for CLI tools/MCP clients.
- [ ] **Add WebSocket origin validation (R7-18)** — **HIGH (Agent-93):** No origin check in `handleWebSocketOpen`. Cross-site WebSocket hijacking possible. Reject non-localhost origins.
- [ ] **Fix WebSocket cross-channel subscription (R7-05)** — **HIGH (Agent-96):** Any WS client subscribes to any channel. "Receive all" fallback (`!ws.data.channel || ws.data.channel === channel`) enables full surveillance. Fix: validate channel access, remove "receive all" fallback.
- [ ] **Add agent identity verification (R7-06)** — **HIGH (Agent-96):** All agent mutation endpoints trust `agent_id` from request body. Associate agent_id with a session token generated when worker loop starts. Validate on all agent-mutating endpoints.
- [ ] **Remove `reusePort: true` (R7-19)** — **MEDIUM (Agent-93):** Allows another process to bind same port and intercept traffic. Remove unless load-balancing reason documented.

#### 0K. MCP Tool & UI Security Hardening (R7-02, R7-03, R7-04, R7-08, R7-09, R7-11, R7-12, R7-13 — NEW from Round 7)

- [ ] **Sanitize html_preview server-side (R7-02)** — **CRITICAL (Agent-96):** `chat_send_message` MCP tool stores arbitrary HTML. UI renders in `<iframe sandbox="allow-scripts">` but "Open in new tab" creates unsandboxed Blob URL → full RCE. Fix: sanitize HTML server-side (DOMPurify or equivalent), remove/sandbox the blob URL opener.
- [ ] **Add path validation to chat_upload_local_file (R7-03)** — **CRITICAL (Agent-96):** MCP tool accepts any absolute path with zero validation. Can read `/etc/shadow`, `~/.ssh/id_rsa`, `~/.clawd/config.json`. Fix: apply `SENSITIVE_PATTERNS` from agents.ts, restrict to project root + attachments dir.
- [ ] **Add ReDoS protection for chat_query_messages (R7-04)** — **HIGH (Agent-96):** `new RegExp(userInput)` with no complexity validation → catastrophic backtracking DoS. Fix: use `re2` library, or wrap in `vm.runInNewContext` with timeout, or validate regex complexity.
- [ ] **Validate skill names against path traversal (R7-08)** — **MEDIUM (Agent-96):** `saveSkill` uses `skill.name` in file path without sanitization. `../../../etc/cron.d/evil` → arbitrary file write. Fix: strict `/^[a-zA-Z0-9_-]+$/` validation.
- [ ] **Add size limit to MCP file upload (R7-09)** — **MEDIUM (Agent-96):** `chat_upload_file` decodes base64 with no size check. Fix: `if (buffer.length > 10 * 1024 * 1024) return error`.
- [ ] **Add LRU eviction to caches (R7-11)** — **MEDIUM (Agent-96):** `gitignoreCache` and `fileCache` grow unbounded → OOM. Fix: add max entry count or TTL-based eviction.
- [ ] **Fix Content-Disposition header injection (R7-12)** — **LOW (Agent-96):** `filename="${file.name}"` allows header injection. Fix: use RFC 5987 encoding.
- [ ] **Sanitize Mermaid SVG rendering (R7-13)** — **LOW (Agent-96):** `dangerouslySetInnerHTML={{ __html: svg }}` for Mermaid output. Fix: pass through DOMPurify before rendering.
- [ ] **Minimize MCP stdio subprocess env (R7-10)** — **MEDIUM (Agent-92/96):** MCP client passes `{ ...process.env, ...this.env }` to spawned servers. Fix: use `getSafeEnvVars()` + only explicitly needed vars.

#### Phase 0 Summary: Findings → Remediation Map (Rounds 3-7)

| ID | Severity | Finding | Fix Location | Phase 0 Section |
|----|----------|---------|-------------|-----------------|
| C1 | CRITICAL | tmux_send_command bypasses sandbox | tools.ts L2614+ | 0C |
| C2 | CRITICAL | Sub-agents run WITHOUT sandbox | tools.ts L2119 | 0B |
| C3 | CRITICAL | Sub-agent name injection | tools.ts L2079 | 0B |
| C4 | CRITICAL | Task escaping insufficient | tools.ts L2110 | 0B |
| C5 | CRITICAL | Depth limit not enforced in tmux | tools.ts spawn code | 0B |
| C6 | CRITICAL | Remote multi-layer shell injection | (Phase 2 — RemoteExecutor design) | Addressed in Phase 2 design |
| C7 | CRITICAL | Remote script TOCTOU | (Phase 2 — atomic mktemp+mv) | Addressed in Phase 2 design |
| H1 | HIGH | .env bypass via job_submit | tools.ts job_submit | 0C |
| H2 | HIGH | tail injection in getLogs() | tmux-manager.ts L297 | 0A |
| H3 | HIGH | execSync string interpolation | tmux-manager.ts (all) | 0A |
| H4 | HIGH | Heredoc CLAWD_EOF injection | tools.ts L691, L782 | 0A |
| H5 | HIGH | Cross-agent session hijack | tmux-manager.ts socket | 0C |
| H6 | HIGH | No resource limits | tmux-manager.ts + tools.ts | 0D |
| H7 | HIGH | Agent dir permissions 0755 | tools.ts spawn code | 0C |
| H8 | HIGH | Remote socket permissions | (Phase 2) | Addressed in Phase 2 design |
| H9 | HIGH | SSH poll hang | (Phase 2) | Addressed in Phase 2 design |
| H10 | HIGH | ControlMaster desync | (Phase 2) | Addressed in Phase 2 design |
| H11 | HIGH | Remote env leakage via tmux | (Phase 2) | Addressed in Phase 2 design |
| H12 | HIGH | No audit trail | New audit module | 0E |
| M1 | MEDIUM | Job ID directory traversal | tmux-manager.ts | Latent, mitigated by guards |
| M2 | MEDIUM | .tmux.conf not ignored | tmux-manager.ts | 0A (via `-f /dev/null`) |
| M3 | MEDIUM | Socket path length risk | tmux-manager.ts | Phase 2 (SHA-256 hash naming) |
| M4 | MEDIUM | killServer() kills ALL agents | tmux-manager.ts | 0D |
| M5 | MEDIUM | Remote exit_code poisoning | (Phase 2) | Phase 2 design |
| M6 | MEDIUM | Log output not sanitized | tools.ts job_logs | 0D |
| M7 | MEDIUM | Symlink attack on log/exit paths | tmux-manager.ts | Accept risk (same user) |
| M8 | MEDIUM | Tmux session orphan accumulation | worker-loop.ts | 0D |
| M9 | MEDIUM | No centralized security in executeTool | tools.ts | 0E |
| M10 | MEDIUM | tmux_send_command workdir injection | tools.ts L2639 | 0C (via sandbox wrapping) |
| M11 | MEDIUM | StrictHostKeyChecking in GIT_SSH | sandbox.ts | Nice-to-have |
| L1 | LOW | Script write→execute TOCTOU | tmux-manager.ts | Accept risk (same user) |
| L2 | LOW | tmux_kill/capture name not validated | tools.ts | 0A (execFile fix) |
| L3 | LOW | result.json prototype pollution | tools.ts | Accept risk (V8 mitigates) |
| L4 | LOW | Scrollback info disclosure | tmux | 0D (scrollback limit) |
| R6-C1 | CRITICAL | **Project hooks RCE outside sandbox** | hooks/loader.ts | **0H (NEW)** |
| R6-C2 | CRITICAL | **Zero API auth + CORS *** | src/index.ts, api/*.ts | **0J (NEW)** |
| R6-C3 | CRITICAL | **BASH_ENV bypass on SSH** | Phase 2 design | Phase 2 (updated) |
| R6-C4 | CRITICAL | **Script-content injection** | tools.ts L2126-2136 | 0B (updated) |
| R6-H1 | HIGH | **macOS ~/.config credential leak** | sandbox.ts Seatbelt | **0H (NEW)** |
| R6-H2 | HIGH | **Hook singleton cross-agent** | hooks/manager.ts | **0H (NEW)** |
| R6-H4 | HIGH | **enableSandbox() exported** | sandbox.ts | **0H (NEW)** |
| R6-H5 | HIGH | **process.env leaked to tmux** | tools.ts:2570 | 0C (updated) |
| R6-H6 | HIGH | **clawd-chat script injection** | clawd-chat/index.ts L170-178 | 0A (updated) |
| R6-H7 | HIGH | **SSH escaping unspecified** | Phase 2 design | Phase 2 (updated) |
| R6-H8 | HIGH | **Bash creates untracked tmux** | tools.ts bash tool | **0I (NEW)** |
| R6-M1 | MEDIUM | **Sandbox state process-global** | sandbox.ts | **0H (NEW)** |
| R6-M3 | MEDIUM | **Socket name .slice(-20) collision** | tools.ts:2606 | 0C (updated) |
| R7-02 | CRITICAL | **html_preview stored XSS → blob URL → RCE** | mcp.ts, UI MessageList | **0K (NEW)** |
| R7-03 | CRITICAL | **chat_upload_local_file arbitrary file read** | mcp.ts:2091 | **0K (NEW)** |
| R7-14 | CRITICAL | **initializeSandbox() not idempotent (yolo race)** | sandbox.ts | 0H (updated) |
| R7-15 | CRITICAL | **Path-based hook approval bypassable** | hooks/loader.ts | 0H (updated) |
| R7-20 | CRITICAL | **bash-as-sh STILL sources BASH_ENV** | Phase 2 design | Phase 2 (updated) |
| R7-04 | HIGH | **ReDoS via user regex** | mcp.ts:2317 | **0K (NEW)** |
| R7-05 | HIGH | **WebSocket cross-channel subscription** | websocket.ts | **0J (expanded)** |
| R7-06 | HIGH | **Agent identity spoofing** | index.ts API | **0J (expanded)** |
| R7-16 | HIGH | **Hook module cache prevents reload** | hooks/loader.ts | 0H (updated) |
| R7-17 | HIGH | **macOS no tmux binary deny** | sandbox.ts | 0I (updated) |
| R7-18 | HIGH | **WebSocket no origin validation** | websocket.ts | **0J (expanded)** |
| R7-21 | HIGH | **SSH Option C: stdin pipe strongest** | Phase 2 design | Phase 2 (updated) |
| R7-23 | HIGH | **process.env leaked in 4 tmux paths** | tools.ts, tmux-mgr, clawd-chat | 0C (updated) |
| R7-08 | MEDIUM | **saveSkill path traversal** | skills/manager.ts | **0K (NEW)** |
| R7-09 | MEDIUM | **MCP file upload no size limit** | mcp.ts | **0K (NEW)** |
| R7-11 | MEDIUM | **gitignoreCache unbounded growth** | agents.ts, index.ts | **0K (NEW)** |
| R7-19 | MEDIUM | **reusePort:true port hijack** | index.ts:450 | **0J (expanded)** |
| R7-12 | LOW | **Content-Disposition header injection** | index.ts:867 | **0K (NEW)** |
| R7-13 | LOW | **Mermaid SVG dangerouslySetInnerHTML** | UI MessageList | **0K (NEW)** |

### Phase 1: Executor Abstraction + Batch Tool Migration (Strangler Fig)
- [ ] Create `ProjectExecutor` interface in `executor.ts` (with all extended methods)
- [ ] Implement `LocalExecutor` that **unifies** both sandbox and direct-fs paths (single code path per tool)
- [ ] **Extend AgentContext interface** — Add `executor: ProjectExecutor`, add `destroy()` lifecycle. Update all `runWithAgentContext()` call sites to provide LocalExecutor by default.
- [ ] Wire up in `worker-loop.ts` — create executor, pass to context, destroy on completion (finally block)
- [ ] **Batch 1:** Extract `file-tools.ts` from tools.ts + migrate (view, edit, create) to executor
- [ ] **Batch 2:** Extract `search-tools.ts` + migrate (grep, glob) to executor
- [ ] **Batch 3:** Extract `bash-tools.ts` + migrate (bash) to executor
- [ ] **Batch 4:** Extract `git-tools.ts` + migrate (git_*) to executor
- [ ] **Batch 5:** Extract `job-tools.ts` + migrate (job_*, tmux_*) to executor
- [ ] `tools.ts` becomes thin registry (~200 LOC) importing all modules
- [ ] Each batch: unit test for executor parity (no behavior change)

Note: Phase 0 tools.ts split is merged INTO Phase 1 batches (extract + migrate in one step per batch, avoiding double-refactor). The 0A heredoc fix (L691/L782) is applied during Batch 1 extraction — not a separate pre-step.

### Phase 2: SSH Remote Executor
- [ ] Implement `ssh-config.ts` parser:
  - `Include` directive: max depth 16, cycle detection (visited set), glob cap 100 files
  - Skip `Match exec` blocks (no local command execution from config parsing)
  - Extract ONLY: alias, Hostname, Port, User, IdentityFile
- [ ] Implement `RemoteExecutor`:
  - **`-F /dev/null`** — ignore user SSH config entirely, reconstruct args from parsed values
  - Explicit security flags: `ForwardAgent=no`, `ForwardX11=no`, `PermitLocalCommand=no`, `SendEnv=`, `SetEnv=`
  - Connection params: `ServerAliveInterval=15`, `ServerAliveCountMax=3`, `ConnectTimeout=10`, `ControlPersist=120`
  - `LogLevel=ERROR` to suppress banners/MOTD
  - ControlMaster socket: `~/.clawd/ssh/ctrl-<sha256-12chars>` with 0700 dir. **Prefer `XDG_RUNTIME_DIR` if available (Agent-89).**
  - **BASH_ENV bypass fix (R6-C3 + R7-20 — CRITICAL):** Empirically confirmed: outer bash sources BASH_ENV before commands execute. **R7 finding (Agent-94): bash invoked as `sh` STILL sources BASH_ENV on some systems, breaking Option A. `bash --posix` suppresses BASH_ENV.**
    
    **Option C (RECOMMENDED — Agent-94, replaces Options A/B):** Stdin pipe + bash --posix + random heredoc delimiter:
    ```typescript
    // stdin pipe: SSH login shell is interactive → BASH_ENV NOT sourced
    // This is the ONLY approach that mitigates the outer-shell BASH_ENV problem
    const delimiter = `CLAWD_${crypto.randomBytes(8).toString("hex")}`;
    const ssh = spawn("ssh", ["-T", "-o", "BatchMode=yes", ...sshArgs, host], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    ssh.stdin.write(
      `exec env -i LANG=C.UTF-8 HOME="$HOME" PATH="/usr/local/bin:/usr/bin:/bin" ` +
      `/bin/bash --posix --norc --noprofile << '${delimiter}'\n` +
      `cd ${shellEscape(projectRoot)}\n` +
      `${command}\n` +
      `${delimiter}\n`
    );
    ssh.stdin.end();
    ```
    **Why Option C is strongest:**
    1. stdin pipe → interactive login shell → BASH_ENV not sourced (outer shell safe)
    2. `exec env -i` → replaces login shell, clears environment
    3. `bash --posix` → even if BASH_ENV somehow appears, --posix suppresses it
    4. `--norc --noprofile` → suppresses .bashrc/.profile in inner bash
    5. Random heredoc delimiter → prevents delimiter collision injection
    6. Single escaping context (only paths in heredoc body need escaping)
  - **Shell escaping specification (R6-H7 — HIGH, Agent-89):** Use `execFile("ssh", [...])` (NOT `spawn("bash", ["-c", "ssh ..."])`) to avoid local shell interpretation. With Option C (stdin pipe), only ONE escaping context (heredoc body). Use `shellEscape()` for remote paths. **Note (Agent-94): `shellEscape()` is currently private in sandbox.ts — must be exported for SSH module.**
    ```typescript
    // All SSH invocations: execFile/spawn, never shell string
    // Remote paths: shellEscape() wraps in single quotes (handles newlines safely)
    const remotePath = shellEscape(path);
    ```
  - `writeFile()`: stdin pipe → `mktemp -p $(dirname TARGET)` + atomic `mv`, path shell-escaped. **Use same-filesystem mktemp (Agent-89).**
  - `stat()`: portable `wc -c` / `test -d` (not GNU-specific `stat -c`)
  - `listDir()`: `ls -1F` parsed in one SSH call (not N+1 stat calls)
  - Fetch `remoteHome` on first connect (`ssh host 'echo $HOME'`)
  - **Output byte cap: 10MB max (R6, Agent-89, R7-22)** — **FAIL (Agent-94): No output byte cap exists anywhere in codebase.** All subprocess handlers use unbounded string concatenation. Must implement in: `sandbox.ts:runInSandbox()`, `tools.ts` bash tool (both paths), and new SSH remote path:
    ```typescript
    const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
    let totalBytes = 0;
    proc.stdout?.on("data", (data: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - totalBytes;
      if (remaining <= 0) return;
      const chunk = remaining >= data.length ? data : data.subarray(0, remaining);
      stdout += chunk.toString();
      totalBytes += chunk.length;
      if (totalBytes >= MAX_OUTPUT_BYTES) { proc.stdout?.destroy(); proc.stderr?.destroy(); }
    });
    ```
- [ ] SSH connection health check (`ssh -O check`) and auto-reconnect
- [ ] Stale socket cleanup on startup (scan `~/.clawd/ssh/ctrl-*` for orphans)
- [ ] Handle large files (streaming pipe, same size limits as local)
- [ ] Handle binary files (`readFileBinary` via base64 pipe)
- [ ] Timeout and error handling; sanitize SSH error messages before LLM (strip internal IPs)
- [ ] Signal propagation: SIGTERM via SSH before local SIGKILL for long-running commands

### Phase 3: Server API
*Depends on Phase 2 + Phase 1 batches 1-4 (file, search, bash, git). Not just batch 1.*
- [ ] `GET /api/ssh/hosts` — returns parsed SSH config hosts (re-parses on each call)
- [ ] `GET /api/ssh/test?host=<host>` — tests connectivity (5s timeout, returns latency)
- [ ] Update `app.project.tree`/`listDir`/`readFile` endpoints in `src/api/agents.ts` to work with remote projects via executor
- [ ] Update `loadClawdInstructions()` and `loadAgentIdentity()` to use executor for remote projects (or read from cached AgentContext)
- [ ] Update project validation in agents API to accept and validate `host:/path`
- [ ] Disable sub-agent tools (spawn_agent, list_agents, kill_agent) when executor is remote
- [ ] Disable project hooks (`.clawd/hooks/`) for remote projects; document limitation

### Phase 4: UI
- [ ] Machine selector: filterable combobox with SSH hosts + "Local" default
- [ ] Auto-test SSH connection on machine selection (inline ✅/❌/⏳ indicator)
- [ ] Remote folder browser with AbortController, 5s timeout, debounced input
- [ ] Support `~/` relative paths in path input
- [ ] Remote indicator icon (🌐) in channel agent list
- [ ] Fix ProjectsDialog.tsx to handle remote paths (no `readdirSync` on `host:/path`)

### Phase 5: Testing & Validation
- [ ] Unit tests for `ProjectExecutor` interface (both implementations)
- [ ] Unit tests for SSH config parser (including Include directives, wildcards)
- [ ] Integration test: local executor works identically to before migration
- [ ] Integration test: remote executor connects, reads, writes, execs on SSH host
- [ ] Integration test: job tools work on remote via async TmuxJobManager
- [ ] End-to-end: create agent with remote project, run tool commands
- [ ] Regression: verify no behavior change for existing local-only agents

---

## Security Model (Explicit)

### Trust Model
Remote execution operates in **explicit trust mode**. Unlike local execution where bwrap provides kernel-level containment, remote execution has NO containment beyond the SSH user's permissions. This is by design — the user chooses to grant their agent access to a remote machine with that user's full privileges.

### Mitigations Applied

| Threat | Mitigation | Review Source |
|--------|-----------|---------------|
| **SSH config bleedthrough (ProxyCommand etc.)** | `-F /dev/null` + reconstruct from parsed config (only Hostname/Port/User/IdentityFile) | Agent-59 C1 |
| **Double-shell injection** | Use `execFile("ssh", [...])` — no local shell interpretation | Agent-56 C1 |
| **Heredoc injection (CLAWD_EOF)** | All writes use stdin piping + `mktemp` + atomic mv, never heredoc | Agent-54 C2, Agent-69 |
| **SSH Agent Forwarding lateral movement** | `ForwardAgent=no` on all connections | Agent-56 C4 |
| **Login shell re-introduces secrets** | `bash --norc --noprofile` + `env -i` wrapping | Agent-59 H3, Agent-63 C2 |
| **writeFile path injection** | Shell-escape path for remote shell + `mktemp` for temp (no predictable paths) | Agent-59 H2 |
| **SSH Include recursion bomb** | Max depth 16, cycle detection, glob cap 100 | Agent-63 C1 |
| **ControlMaster socket hijacking** | `~/.clawd/ssh/` (0700), SHA-256 hash naming, stale cleanup on startup | Agent-56 H1 |
| **Host spoofing** | Validate host against SSH config allowlist, deny-by-default | Agent-56 H2 |
| **Remote env leakage** | `env -i` + `--norc --noprofile` + explicit `LANG=C.UTF-8 HOME PATH` only | Agent-55 H5, Agent-63 C2 |
| **SSH error info leakage** | `LogLevel=ERROR` + sanitize errors before LLM | Agent-56 M2 |
| **SSH banner/MOTD pollution** | `LogLevel=ERROR` suppresses banners | Agent-63 |
| **Signal propagation** | SIGTERM via SSH before local SIGKILL | Agent-63 |
| **UTF-8 encoding mismatch** | Explicit `LANG=C.UTF-8` in remote env | Agent-63 |
| **Path traversal** | Advisory `validatePath()` (NOT a security boundary) | Agent-56 C2 |
| **.env exposure** | Advisory pattern blocking (NOT enforced — trust mode) | Agent-56 C3 |
| **tmux_send_command sandbox bypass** | Apply `wrapCommandForSandbox()` to all tmux commands | Agent-69 C1, Agent-73 |
| **Sub-agent unsandboxed execution** | Sub-agents self-sandbox via `initializeSandbox()` per tool call; `CLAWD_SANDBOXED=1` prevents `--yolo` bypass | Agent-70 C2, Agent-73, Agent-81 |
| **Sub-agent name injection** | Strict allowlist regex: `/^[a-zA-Z0-9_-]{1,64}$/` | Agent-70 C3 |
| **Task shell escaping bypass** | File-based task passing (no shell interpretation) | Agent-70 C4 |
| **Recursive sub-agent bomb** | `CLAWD_AGENT_DEPTH` env var checked at startup | Agent-70 C5, Agent-73 |
| **execSync shell injection in tmux** | Replace all `execSync` with `execFileSync` + args array | Agent-69 H3, Agent-71 |
| **Cross-agent tmux session hijack** | Per-agent tmux sockets (keyed by agentId) | Agent-71 H5 |
| **No tmux resource limits** | Per-agent caps on jobs (10), sessions (5), logs (10MB), scrollback (10K) | Agent-71 H6 |
| **User .tmux.conf hooks** | `-f /dev/null` on ALL tmux invocations | Agent-71 M2 |
| **No security middleware** | Centralized `executeTool()` pre-validation (type, .env, path, rate) | Agent-73 M9 |
| **No audit trail** | Structured JSONL audit log for all tmux/job/agent operations | Agent-73 H12 |
| **Project hooks RCE (R6)** | Require user approval per project before loading hooks; lock sandbox state after init | Agent-90 R6-C1 |
| **Zero API auth (R6)** | Bind 127.0.0.1, restrict CORS, session token — pre-requisite for Phase 3 | Agent-90 R6-C2 |
| **BASH_ENV bypass (R6)** | Use `/bin/sh` as outer shell wrapper OR `unset BASH_ENV ENV` prefix | Agent-89 R6-C3 |
| **macOS ~/.config leak (R6)** | Restrict Seatbelt to specific tool-chain dirs, not blanket ~/.config | Agent-90 R6-H1 |
| **MCP tools bypass sandbox (R6)** | Route MCP tool execution through executor abstraction (deferred to Phase 1) | Agent-90 R6-H3 |
| **enableSandbox() exported (R6)** | Lock sandbox state after initialization; make non-exported | Agent-90 R6-H4 |
| **Bash creates untracked tmux (R6)** | Block `tmux` command pattern in bash tool when sandboxed | Agent-88 R6-H8 |

### What is NOT mitigated (by design — trust model)
- Remote user has full filesystem access
- `sudo` access if remote user has it
- Arbitrary command execution via bash tool
- Remote environment variables visible to commands (partially mitigated by `--norc`)
- Tunnel + remote = reverse shell path (documented risk)

These are accepted trade-offs. Users choosing remote execution accept these risks.

---

## Edge Cases & Mitigations

| Edge Case | Mitigation |
|-----------|-----------|
| SSH connection drops mid-operation | Auto-reconnect ControlMaster; retry once; writes are atomic (mktemp+mv) so no corruption |
| Remote machine has no rg/fd installed | Fallback to `grep -r` / `find`; detect tools on connect (`which rg fd 2>/dev/null`) |
| Large file read (>10MB) | Stream via SSH pipe, same size limits as local |
| Binary file operations | `readFileBinary()` → base64 encode over SSH pipe |
| Concurrent agents on same remote | Per-agent ControlMaster socket (SHA-256 hash of host+agentId, 12 chars) |
| SSH config changes while running | Re-parse on each `/api/ssh/hosts` call |
| SSH config `Include` directives | Recursive parsing: max depth 16, cycle detection, glob cap 100 |
| SSH config `Match exec` blocks | Skipped entirely (no local command execution from config parsing) |
| ProxyJump / bastion hosts | NOT supported via `-F /dev/null`; document limitation. Future: parse and reconstruct ProxyJump |
| Remote path doesn't exist | Validate on executor creation, return clear error |
| Permission denied on remote | Propagate SSH/shell error to agent |
| macOS remote (BSD stat) | Use portable `wc -c` / `test -d` instead of GNU `stat -c` |
| Remote CLAWD.md loading | Read via executor (or cached at agent startup) |
| Job polling over SSH | Blocking SSH command: `while ! test -f exit; do sleep 1; done` |
| TOCTOU on remote edit | Atomic write (mktemp+mv), accept wider race window |
| tmux socket path >108 chars | SHA-256 hash (12 chars) in socket path; verify total < 104 chars |
| `path.resolve()` on remote paths | `resolvePath()` uses `remoteHome`, not local cwd |
| Sub-agent tools on remote | Disabled (tools hidden when executor.isRemote) |
| Project hooks on remote | Disabled (`.clawd/hooks/` — can't `import()` remote JS); documented |
| Agent crash — orphan sockets | Stale socket cleanup on startup (scan `~/.clawd/ssh/ctrl-*`) |
| SSH key passphrase prompt | Auto-test catches at config time; runtime hang → ConnectTimeout=10s |
| Remote `~` expansion | Expand `~` paths using fetched `remoteHome`, not local homedir |
| UTF-8 encoding on remote | Explicit `LANG=C.UTF-8` in env wrapper |
| Remote process cleanup | SIGTERM via SSH before local SIGKILL on agent interrupt |

---

## Non-Goals (out of scope)
- Remote Docker/workspace container management
- Password-based SSH auth (use keys only)
- File sync / mirroring between local and remote
- Remote MCP server connections (future work)
- Remote sub-agent spawning (future: run locally with remote executor)
- Kernel-level containment on remote (bwrap) — trust mode only
- Remote audit logging (future work)
- ProxyJump/bastion support (future: reconstruct in `-F /dev/null` mode)
