# Securing Tmux-Based Process Execution in Multi-Agent Systems

**Date**: 2026-03-04
**Scope**: 8 research topics covering tmux isolation, process lifecycle, injection prevention, socket security, SSH interaction, and safe file writing
**Context**: Claw_d agent system using TmuxJobManager for persistent background task execution

---

## 1. Tmux Config Isolation: -f /dev/null

### Findings

**-f /dev/null replaces only the USER config, NOT the system config.**

Verified experimentally on tmux 3.4. The man page confirms:

> tmux loads the system configuration file from /etc/tmux.conf, if present, then looks for a user configuration file at ~/.tmux.conf ... -f file: Specify an alternative configuration file.

The -f flag replaces the user config search path. /etc/tmux.conf is **always** loaded if it exists.

### Verification Results

    With user.conf:  status off    <- user config applied
    With /dev/null:  status on     <- user config skipped, default restored

### Edge Cases

| Edge Case | Behavior |
|-----------|----------|
| /etc/tmux.conf exists with aggressive settings | Loaded regardless of -f /dev/null |
| Config uses source-file to load more files | Loaded transitively from system config |
| Config sets set-option -g default-shell /bin/zsh | Changes shell for all sessions on this server |
| Config sets set-option -g remain-on-exit on | Panes do not close on process exit -- breaks exit detection |
| Config binds keys that conflict with send-keys | Can interfere with programmatic key input |
| Config loaded once per server start | If server already running (shared socket), config already loaded -- -f on subsequent commands is ignored |

### Recommendation

Use BOTH -f /dev/null AND a dedicated socket (-S). Dedicated socket = separate server = fresh config load. The dedicated socket is the real isolation mechanism. -f /dev/null is belt-and-suspenders.
---

## 2. Tmux Session Isolation

### Key Finding: No Per-Session Permissions

Tmux has **no per-session permission model**. All sessions on a server share the same permission boundary. Verified experimentally: two separate sockets can have identically-named sessions with zero interference.

    Server 1 sessions: mysession (created Wed Mar  4 02:15:50 2026)
    Server 2 sessions: mysession (created Wed Mar  4 02:15:50 2026)
    Socket permissions: srw------- 1 vi vi 0 (0600)

### Isolation Architecture

| Strategy | Isolation Level | Recommendation |
|----------|----------------|----------------|
| Same server, different sessions | None -- any client can attach to any session | Never for multi-agent |
| Separate socket per agent (-S) | Full server isolation | Current approach is correct |
| Separate socket per job | Maximum but many servers | Overkill unless adversarial |
| Socket + directory permissions | Server isolation + filesystem ACL | Best practice |

**Cross-session interference risks on shared server:**
- `kill-server` affects ALL sessions
- Global options (set -g) affect all sessions
- list-sessions reveals all session names
- Any client can send-keys to any session
- Buffer/paste buffer is shared across sessions

**Verdict**: Codebase use of -S with a per-project socket is correct. No changes needed.

---

## 3. Process Tree Cleanup in Tmux

### What `kill-session` Actually Does

1. Destroys the session, closing windows linked to it
2. Closes the PTY (pseudo-terminal) for each pane
3. The shell in the pane receives **SIGHUP** (from PTY close)
4. Bash with huponexit enabled forwards SIGHUP to children
5. Default bash does NOT have huponexit -- children may survive

### What Survives Session Destruction

| Process Type | Survives? | Why |
|-------------|-----------|-----|
| Direct child of pane shell | Usually NO | Gets SIGHUP from PTY close |
| nohup command & | **YES** | Ignores SIGHUP |
| setsid command | **YES** | New session, no controlling terminal |
| disowned background job | **YES** | Removed from bash job table |
| Double-fork daemon | **YES** | Reparented to init, new session |
| command & (without disown) | Depends | Gets SIGHUP if bash has huponexit |

### Robust Cleanup: Process Group Approach (Recommended)

```typescript
function cancelJob(id: string): boolean {
  const sessionName = `${JOB_PREFIX}${id}`;

  // Get pane PID before destroying session
  const panePid = execFileSync("tmux", [
    "-S", SOCKET_PATH(), "list-panes", "-t", sessionName,
    "-F", "#{pane_pid}"
  ], { encoding: "utf8", timeout: 5000 }).trim();

  if (!panePid) return false;

  // Get process group ID
  const pgid = execFileSync("ps", ["-o", "pgid=", "-p", panePid],
    { encoding: "utf8" }).trim();

  if (pgid) {
    // process.kill with negative PID = entire process group
    try {
      process.kill(-parseInt(pgid), "SIGTERM");
      setTimeout(() => {
        try { process.kill(-parseInt(pgid), "SIGKILL"); } catch {}
      }, 2000);
    } catch {}
  }

  // Then destroy the session
  execFileSync("tmux", ["-S", SOCKET_PATH(), "kill-session", "-t", sessionName],
    { timeout: 5000 });
  return true;
}
```

### Wrapper Script Defense-in-Depth

```bash
#!/bin/bash
shopt -s huponexit       # Forward HUP to all children
trap cleanup_fn EXIT     # Cleanup on exit

cleanup_fn() {
  local pg=$(ps -o pgid= -p $$ | tr -d " ")
  [ -n "$pg" ] && /bin/kill -- -"$pg" 2>/dev/null
}

exec > "${LOG_FILE}" 2>&1
( ${COMMAND} )
EXIT_CODE=$?
echo $EXIT_CODE > "${EXIT_FILE}"
exit $EXIT_CODE
```

### Current Code Gap

Current `cancel()` only calls `kill-session`. Daemonized children **WILL** leak. Must add PGID-based cleanup before session destruction.

### Other Strategies

- **Cgroup-based**: systemd-run --scope then systemctl stop terminates everything in cgroup (most robust)
- **PID namespace**: unshare --pid --fork -- when namespace init dies all children die
- **Nuclear**: `kill-server` terminates ALL sessions on that socket
---

## 4. `execFile` vs `execSync` Security

### Injection Proof (Verified)

```
execFileSync("echo", ["hello; whoami"])  -> "hello; whoami"  (literal, SAFE)
execSync("echo hello; whoami")           -> "hello\nvi"      (INJECTED!)
```

**`execSync` spawns a shell** (`/bin/sh -c "..."`) which interprets metacharacters.
**`execFileSync` does NOT spawn a shell** -- arguments passed directly via `execvp()`.

### Current Codebase Issues

```typescript
// LINE 96-98: String concatenation into shell command
function tmuxCmd(args: string): string {
  return `tmux -S "${SOCKET_PATH()}" ${args}`;
}

// LINE 100-102: Passed to execSync = SHELL INTERPRETS ARGS
function execTmux(args: string): string {
  return execSync(tmuxCmd(args), { encoding: "utf8", timeout: 5000 }).trim();
}

// LINE 172: Session name goes through shell
execSync(tmuxCmd(`new-session -d -s "${sessionName}" "${scriptFile}"`));

// LINE 297: tail -n with number (minor)
execSync(`tail -n ${tail} "${logFile}"`, { encoding: "utf8" });
```

Risk is **LOW today** (sessionName=UUID, scriptFile=controlled path) but **fragile**.

### Recommended Refactor

```typescript
import { execFileSync } from "node:child_process";

function execTmux(args: string[]): string {
  try {
    return execFileSync("tmux", ["-f", "/dev/null", "-S", SOCKET_PATH(), ...args], {
      encoding: "utf8", timeout: 5000
    }).trim();
  } catch { return ""; }
}

function sessionExists(name: string): boolean {
  try {
    execFileSync("tmux", ["-S", SOCKET_PATH(), "has-session", "-t", name],
      { timeout: 5000 });
    return true;
  } catch { return false; }
}

// Submit job:
execFileSync("tmux", [
  "-f", "/dev/null", "-S", SOCKET_PATH(),
  "new-session", "-d", "-s", sessionName, scriptFile
], { encoding: "utf8", timeout: 5000 });

// Get logs:
execFileSync("tail", ["-n", String(tail), logFile], { encoding: "utf8" });
```

**Key change**: args from `string` to `string[]`. Every argument is a separate array element -- no shell interpretation.

---

## 5. Unix Socket Security on NFS

### Core Finding: Unix Sockets DO NOT Work on NFS

The Linux kernel does not support Unix domain sockets on NFS. `bind()` may succeed (creates inode) but `connect()` fails -- socket is a local kernel object.

| Filesystem | Unix Sockets | Notes |
|------------|-------------|-------|
| ext4, xfs, btrfs | Full support | Local filesystems |
| tmpfs | Full support | Fastest, RAM-backed |
| NFS v3/v4 | **Broken** | bind creates inode but connect fails |
| CIFS/SMB | **Broken** | Same as NFS |
| 9p (WSL, VMs) | Varies | Often broken or unreliable |

### Alternatives

**Option 1: XDG_RUNTIME_DIR (Recommended)**

```typescript
function getSocketDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR; // /run/user/1000, guaranteed local tmpfs
  if (xdg) return join(xdg, "clawd");
  return join("/tmp", `clawd-${process.getuid()}`);
}
```

**Option 2: Abstract Sockets (Linux only)**

Abstract sockets live in kernel memory, no filesystem path. BUT tmux does NOT support them. Not an option for tmux sockets.

**Option 3: /tmp with subdirectory**

/tmp is almost always local tmpfs. Use 0700 permissions on subdirectory.

**Path Length**: sun_path limited to 107 bytes. Use short socket paths.

---

## 6. Remote Tmux Session Lifecycle

### Creating Sessions Remotely

```bash
ssh -o BatchMode=yes host "tmux -f /dev/null new-session -d -s agent-ID /path/script.sh"
```

**Critical**: Use `execFileSync("ssh", [...args])` NOT `execSync("ssh host ...")` to avoid double-shell-interpretation.

### Monitoring Session Health

```typescript
function isRemoteSessionAlive(host: string, session: string): boolean {
  try {
    execFileSync("ssh", ["-o", "BatchMode=yes", host,
      "tmux", "has-session", "-t", session], { timeout: 10000 });
    return true;
  } catch { return false; }
}

// Activity timestamp
function getSessionActivity(host: string, session: string): number {
  const output = execFileSync("ssh", ["-o", "BatchMode=yes", host,
    "tmux", "list-sessions", "-F", "#{session_name}:#{session_activity}",
    "-f", `#{==:#{session_name},${session}}`
  ], { encoding: "utf8", timeout: 10000 }).trim();
  return parseInt(output.split(":")[1]);
}
```

### Orphan Cleanup

Query session_created timestamps, compare against max age, destroy stale sessions.

### Hijacking Prevention

1. Dedicated tmux socket per agent with 0700 directory
2. Session names include UUID (cryptographic randomness)
3. SSH ForwardAgent=no (see security review)
4. Restricted authorized_keys: `command="/usr/local/bin/clawd-remote-exec",restrict`

---

## 7. SSH ControlMaster + Tmux Interaction

### They Operate at Different Layers

| Aspect | SSH ControlMaster | Remote tmux |
|--------|------------------|-------------|
| Layer | Transport (TCP/SSH) | Application (PTY mux) |
| Lifecycle | Dies when master closes | Persists independently |
| Scope | Multiplexes SSH connections | Multiplexes terminal sessions |

### When ControlMaster Drops

1. Master SSH connection terminates
2. All multiplexed SSH sessions over it also terminate
3. Remote tmux sessions **completely unaffected** -- just processes on remote
4. New SSH connections create new master (if ControlMaster auto)
5. Can re-attach to remote tmux after reconnect

### Key Scenario: Multiple Agents

If Agent A closes the master (ssh -O exit), Agent B pending commands fail.

**Solution**: Separate ControlPath per agent:

```typescript
const controlPath = join(controlDir, `cm-${agentId}-%h-%p-%r`);
```

### Recommendations

1. Separate ControlPath per agent
2. Reconnect logic: retry once after brief delay
3. Use `ssh -O check` before critical operations
4. Explicit cleanup: `ssh -O exit` during agent shutdown

---

## 8. Safe File Writing in Bash

### Comparison Matrix

| Method | Shell Expansion | Binary Safe | Injection Risk |
|--------|----------------|-------------|----------------|
| Heredoc quoted (<< 'EOF') | Safe | No | Low |
| Heredoc unquoted (<< EOF) | **UNSAFE** | No | **HIGH** |
| printf '%s' | Safe | No | Low |
| base64 encode/decode | Safe | Yes | **Lowest** |
| Node.js fs.writeFile | N/A (no shell) | Yes | **None** |

### Verified Results

```
Content:  $HOME "quotes" `command` $(injection) \n backslash

Heredoc quoted:  $HOME "quotes" `command` $(injection) \n backslash   SAFE
Heredoc unquoted: /home/vi "quotes" ...                               EXPANDED!
base64 roundtrip: perfect fidelity                                    SAFE
```

### Recommendations by Context

**Local files from Node.js**: `fs.writeFileSync(path, content)` -- no shell, best option.

**Remote files**: base64 encode in Node, pipe to `base64 -d` on remote via stdin.

**Shell scripts**: Quoted heredoc with unique delimiter, or base64 round-trip for binary.

**Current codebase**: Already correct -- uses writeFileSync then passes file path to tmux.

---

## Summary

| Topic | Current State | Risk | Action |
|-------|--------------|------|--------|
| Config isolation | No -f /dev/null | Low | Add -f /dev/null to all tmux calls |
| Session isolation | Dedicated socket | None | No change |
| Process cleanup | Only kill-session | **Medium** | Add PGID cleanup |
| Shell injection | execSync + string | **Medium** | Refactor to execFileSync |
| NFS sockets | Socket in project dir | **High on NFS** | Move to XDG_RUNTIME_DIR |
| Remote lifecycle | Not implemented | -- | Use Section 6 patterns |
| ControlMaster | Not implemented | -- | Per-agent ControlPath |
| File writing | writeFileSync | None | No change needed |

## Priority Fixes

1. **P1**: Refactor execTmux from execSync(string) to execFileSync("tmux", string[]) -- eliminates injection class
2. **P1**: Add process group cleanup to cancel() before kill-session -- prevents process leaks
3. **P2**: Add -f /dev/null to all tmux invocations -- defense-in-depth
4. **P2**: Move tmux socket to local filesystem (XDG_RUNTIME_DIR or /tmp)
5. **P3**: Add huponexit and process-group trap to wrapper script

## Unresolved Questions

1. Does Docker deployment already provide cgroup isolation making PGID cleanup redundant?
2. tmux -f /dev/null verified on 3.4 -- older 2.x versions may differ.
3. Is abstract socket support in tmux worth pursuing vs /tmp fallback?
4. WSL runs ext4 -- NFS-mounted home dirs on native Linux would make socket location critical.