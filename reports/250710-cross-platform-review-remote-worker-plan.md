# Cross-Platform Compatibility Review: Remote Worker Plan

**Date**: 2025-07-10
**Plan**: Remote Worker Agent Implementation
**Focus**: Cross-platform compatibility (Windows, macOS, Linux)
**Reviewer**: Code Review Agent

---

## Scope

- **Files reviewed**: Plan at session-state `a0bc1dc4.../plan.md`
- **Existing code inspected**: `src/server/websocket.ts`, `src/server/browser-bridge.ts`, `src/agent/src/mcp/client.ts`, `src/server/multimodal.ts`, `src/api/agents.ts`, `docs/windows-compatibility-analysis.md`
- **Focus**: 10 cross-platform issues as specified

---

## Overall Assessment

The plan is well-structured and follows established patterns (browser-bridge.ts architecture). However, it has **3 critical** and **4 high-severity** cross-platform issues that would cause failures on Windows and older Node.js/Python versions. The plan's claim of "Node.js 18+ (built-in WebSocket)" is factually incorrect, and the `str | None` Python type syntax breaks the stated Python 3.6+ target. The existing codebase's `windows-compatibility-analysis.md` already documents many of these same class of issues — the plan should have incorporated those lessons.

---

## Issue Analysis

### Issue 1: Windows Path Handling — `startsWith()` with hardcoded `/`

**Severity**: 🔴 **CRITICAL** — Security bypass on Windows

**Problem**: The plan's `isWithinRoot()` function uses `realpath + startsWith` for path containment checking. On Windows:

```typescript
// Plan's approach (Security module):
// isWithinRoot(path, root): boolean (realpath + startsWith)
```

The existing codebase at `src/api/agents.ts:131` already has this exact bug:
```typescript
fullPath.startsWith(normalizedRoot + "/")  // ← hardcoded "/"
```

On Windows, `path.resolve()` and `fs.realpathSync()` return backslash paths:
```
path.win32.resolve('C:/Users/dev/project') → 'C:\Users\dev\project'
path.win32.resolve('C:/Users/dev/project', 'src/main.ts') → 'C:\Users\dev\project\src\main.ts'
```

**Proof** (tested):
```
startsWith('C:\Users\dev\project' + '/')  → FALSE  ← SECURITY BYPASS!
startsWith('C:\Users\dev\project' + '\') → true
```

Any path would fail the containment check, but if the fallback is permissive (returns true on error), it becomes a **path traversal vulnerability**. The existing `windows-compatibility-analysis.md` already flags: *"path validation is also completely disabled when sandbox is off"*.

**Fix**:
```typescript
function isWithinRoot(targetPath: string, root: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(root);
  // Use path.sep for cross-platform separator
  return resolvedTarget === resolvedRoot || 
         resolvedTarget.startsWith(resolvedRoot + path.sep);
}
```

For Python:
```python
def is_within_root(target: str, root: str) -> bool:
    resolved_target = os.path.realpath(target)
    resolved_root = os.path.realpath(root)
    # os.path handles sep correctly per platform
    return resolved_target == resolved_root or \
           resolved_target.startswith(resolved_root + os.sep)
```

---

### Issue 2: Windows Bash Tool — `cmd.exe /c` is insufficient

**Severity**: 🟡 **HIGH** — Major functionality degradation

**Problem**: The plan falls back to `cmd.exe /c` on Windows:
```typescript
const shell = isWindows ? "cmd.exe" : "bash";
const shellArgs = isWindows ? ["/c", args.command] : ["-c", args.command];
```

Most developer workflows and AI-generated commands assume bash syntax (`&&`, `|`, `>`, process substitution, etc.). `cmd.exe` doesn't support many of these. The existing `windows-compatibility-analysis.md` recommends using Git Bash or WSL.

**Impact**: Commands like `npm run build && npm test`, `cat file | grep pattern`, `$(which node)` would fail or behave differently. Agent-generated commands are almost always bash syntax.

**Fix**: Implement shell detection priority chain:
```typescript
function detectShell(): { shell: string; args: (cmd: string) => string[] } {
  if (process.platform !== "win32") {
    return { shell: "bash", args: (cmd) => ["-c", cmd] };
  }
  
  // 1. Check for WSL
  const wsl = findExecutable("wsl.exe");
  if (wsl) return { shell: wsl, args: (cmd) => ["bash", "-c", cmd] };
  
  // 2. Check for Git Bash
  const gitBash = findGitBash(); // Check Program Files, etc.
  if (gitBash) return { shell: gitBash, args: (cmd) => ["-c", cmd] };
  
  // 3. Check for PowerShell 7+ (pwsh) — better than cmd.exe
  const pwsh = findExecutable("pwsh.exe") || findExecutable("powershell.exe");
  if (pwsh) return { shell: pwsh, args: (cmd) => ["-Command", cmd] };
  
  // 4. Fallback to cmd.exe
  return { shell: "cmd.exe", args: (cmd) => ["/c", cmd] };
}
```

Also: report the detected shell in the `register` message so the server knows what command syntax to use.

---

### Issue 3: Windows Grep — `findstr` is nearly useless

**Severity**: 🟡 **HIGH** — Major functionality gap

**Problem**: The plan falls back from `rg` to `findstr`:
```typescript
return await runCommand(isWindows ? "findstr" : "grep", 
  isWindows ? ["/s", "/n", args.pattern, searchPath] : grepArgs);
```

`findstr` limitations vs `grep -rn`:
- No real regex support (only very basic patterns)
- No context lines (`-C`/`-A`/`-B`)
- No glob filtering
- Case-insensitive only for ASCII
- Binary file detection is poor
- Max line length 8191 chars

**Fix**: Prefer PowerShell `Select-String` as intermediate fallback:
```typescript
async function handleGrep(args) {
  // Priority: rg > Select-String (Windows) > grep (Unix) > findstr (last resort)
  try {
    return await runCommand("rg", rgArgs);
  } catch {
    if (isWindows) {
      try {
        // Select-String has proper regex, context lines, recursive search
        const psArgs = [
          "-Command",
          `Get-ChildItem -Path '${searchPath}' -Recurse -File` +
          (args.glob ? ` -Include '${args.glob}'` : "") +
          ` | Select-String -Pattern '${args.pattern}'` +
          (args.context ? ` -Context ${args.context}` : "") +
          ` | Select-Object -First 100`
        ];
        return await runCommand("powershell.exe", psArgs);
      } catch {
        return await runCommand("findstr", ["/s", "/n", args.pattern, searchPath]);
      }
    }
    return await runCommand("grep", grepArgs);
  }
}
```

---

### Issue 4: Windows Glob — Long paths and `fs.readdirSync` behavior

**Severity**: 🟢 **LOW** — Edge case, unlikely in practice

**Problem**: The plan mentions `globWalk()` for recursive directory walking. Two concerns:

1. **Long paths (>260 chars)**: Node.js on Windows since v10 internally uses the `\\?\` prefix for long path support. `fs.readdirSync()` handles this correctly. Not a real issue.

2. **`fs.readdirSync({recursive: true})`**: Added in Node 18.17.0. If the plan uses this, it's fine for the stated Node 18+ target, but should verify the minor version. If using a custom walk, it works on all versions.

3. **Hidden files/junction points**: Windows NTFS junctions (similar to symlinks) could cause infinite loops in a naive recursive walk. `fs.readdirSync` with `withFileTypes: true` can detect junctions.

**Fix**: Minor — document minimum Node 18.17.0, and in the custom walk:
```typescript
function globWalk(basePath: string, pattern: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>(); // Prevent junction/symlink loops
  
  function walk(dir: string, depth: number) {
    if (depth > 20) return; // Safety limit
    const real = fs.realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath, depth + 1);
      else if (matchGlob(entry.name, pattern)) results.push(fullPath);
    }
  }
  
  walk(basePath, 0);
  return results;
}
```

---

### Issue 5: Python on Windows — `socket` + `ssl` and `subprocess.Popen`

**Severity**: 🟡 **HIGH** — Breaks on corporate VDI (the target environment!)

**Problem A — SSL Certificates**: On Windows, Python 3.6–3.8's `ssl.create_default_context()` does NOT load the Windows Certificate Store. Corporate VDI environments almost always use custom CA certificates that only exist in the Windows cert store. This means the WebSocket TLS handshake will **fail with `SSLCertVerificationError`** on the exact target environment.

Python 3.9+ added better Windows cert store integration, but 3.6–3.8 is still in the support range.

**Problem B — subprocess.Popen with `shell=True`**: On Windows, `shell=True` uses `cmd.exe`, which means:
- Unix commands (`grep`, `find`, `ls`) don't exist
- Path separators in commands need doubling in some contexts
- Environment variable expansion uses `%VAR%` not `$VAR`

**Fix for SSL**:
```python
def create_ssl_context():
    ctx = ssl.create_default_context()
    if os.name == "nt":
        try:
            import certifi
            ctx.load_verify_locations(certifi.where())
        except ImportError:
            # Try loading Windows cert store (Python 3.9+)
            try:
                ctx.load_default_certs()
            except AttributeError:
                pass  # Python 3.6-3.8, hope system certs work
        # Provide --insecure flag as last resort for corporate environments
    return ctx
```

Also add a `--insecure` / `--skip-tls-verify` CLI flag for broken corporate CAs (common in VDI):
```python
if args.insecure:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
```

**Fix for subprocess**: Same shell detection chain as TypeScript (Issue 2).

---

### Issue 6: macOS Specifics — Gatekeeper and App Translocation

**Severity**: 🟢 **LOW** — Not applicable for this use case

**Problem**: macOS Gatekeeper quarantines downloaded executables and App Translocation moves app bundles to a random temp path on first run.

**Analysis**: This is a **non-issue** for the remote worker because:
1. The worker is a `.ts` or `.py` script, not a compiled app bundle — Gatekeeper doesn't quarantine scripts
2. It's run via `node remote-worker.ts` or `python3 remote_worker.py` — the interpreters are already trusted
3. App Translocation only affects `.app` bundles, not scripts
4. The only scenario: if the compiled Bun binary (`clawd-app-darwin-arm64`) is downloaded, macOS may quarantine it. Fix: `xattr -d com.apple.quarantine clawd-app-darwin-arm64`

**Fix**: Add to README:
```markdown
### macOS
If macOS blocks the compiled binary, run:
```bash
xattr -d com.apple.quarantine ./remote-worker
```
```

---

### Issue 7: Line Endings — `\r\n` vs `\n` in edit tool

**Severity**: 🔴 **CRITICAL** — Silent data corruption on Windows

**Problem**: The edit tool does:
```typescript
const content = fs.readFileSync(args.path, "utf-8");
const occurrences = content.split(args.old_str).length - 1;
const newContent = content.replace(args.old_str, args.new_str);
```

The `old_str` is sent over WebSocket (JSON), where `\r\n` and `\n` are distinct. If:
- File on Windows has `\r\n` line endings
- AI agent sends `old_str` with `\n` line endings (typical for LLM output)

**Proof** (tested in Node.js):
```javascript
const fileContent = 'line1\r\nline2\r\nline3';
const oldStr = 'line1\nline2';  // AI sends \n
fileContent.includes(oldStr);    // → false ← MATCH FAILS!
```

The edit operation silently fails: "old_str not found in file". The user gets a confusing error even though the text looks correct.

**Worse**: If the fix is to normalize `\r\n` → `\n` before matching, then `fs.writeFileSync(args.path, newContent)` writes `\n`-only content, **converting the entire file's line endings** from Windows-style to Unix-style. This can break batch files, PowerShell scripts, and some Windows tools.

**Fix**: Normalize only for matching, preserve original line endings:
```typescript
async function handleEdit(args: { path: string; old_str: string; new_str: string }): Promise<ToolResult> {
  const err = validatePath(args.path, projectRoot);
  if (err) return { success: false, output: "", error: err };
  if (readOnly) return { success: false, output: "", error: "Read-only mode" };

  const content = fs.readFileSync(args.path, "utf-8");
  
  // Detect file's line ending style
  const hasCRLF = content.includes('\r\n');
  
  // Normalize old_str to match file's line ending style
  let normalizedOldStr = args.old_str;
  let normalizedNewStr = args.new_str;
  if (hasCRLF) {
    // File uses \r\n — ensure old_str and new_str also use \r\n
    normalizedOldStr = args.old_str.replace(/(?<!\r)\n/g, '\r\n');
    normalizedNewStr = args.new_str.replace(/(?<!\r)\n/g, '\r\n');
  } else {
    // File uses \n — ensure old_str doesn't have stray \r\n
    normalizedOldStr = args.old_str.replace(/\r\n/g, '\n');
    normalizedNewStr = args.new_str.replace(/\r\n/g, '\n');
  }

  const occurrences = content.split(normalizedOldStr).length - 1;
  if (occurrences === 0) return { success: false, output: "", error: "old_str not found in file" };
  if (occurrences > 1) return { success: false, output: "", error: `old_str found ${occurrences} times` };

  const newContent = content.replace(normalizedOldStr, normalizedNewStr);
  fs.writeFileSync(args.path, newContent);
  return { success: true, output: "File updated successfully" };
}
```

Apply the same pattern to the Python `handle_edit()`.

---

### Issue 8: Node.js 18 WebSocket — NOT stable, NOT even available

**Severity**: 🔴 **CRITICAL** — Won't start on the stated runtime

**Problem**: The plan states:
> **Runtime**: Node.js 18+ (built-in WebSocket) or Bun

**This is factually incorrect.** Node.js WebSocket timeline:

| Node Version | WebSocket Status |
|---|---|
| 18.x (LTS) | ❌ **Does not exist** |
| 20.x (LTS) | ❌ **Does not exist** |
| 21.0–21.6 | 🟡 Behind `--experimental-websocket` flag |
| 21.7+ | 🟡 Unflagged but experimental |
| 22.0–22.3 | 🟡 Experimental |
| **22.4.0+** | ✅ **Stable** |
| 24.x | ✅ Stable |

Bun has had stable WebSocket since v1.0.

If a user runs the worker on Node 18 (the current most popular LTS), `new WebSocket(...)` throws `ReferenceError: WebSocket is not defined`.

**Fix**: Either:

**Option A** — Correct the minimum version:
```
Runtime: Node.js 22.4+ (built-in WebSocket) or Bun 1.0+
```

**Option B** (recommended) — Add a runtime check + polyfill:
```typescript
// At the top of remote-worker.ts
let WS: typeof WebSocket;
if (typeof WebSocket !== "undefined") {
  WS = WebSocket;
} else {
  // For Node < 22.4, try ws package (common, likely already installed)
  try {
    const { WebSocket: WsWebSocket } = require("ws");
    WS = WsWebSocket as any;
  } catch {
    console.error(
      "Error: WebSocket not available.\n" +
      "Either upgrade to Node.js 22.4+ or install the 'ws' package:\n" +
      "  npm install ws\n" +
      "Or use Bun: bun run remote-worker.ts"
    );
    process.exit(1);
  }
}
```

This maintains the "zero dependencies" promise for Node 22.4+/Bun while gracefully degrading for older versions.

---

### Issue 9: Python 3.6 Minimum — `str | None` syntax breaks on 3.6–3.9

**Severity**: 🟡 **HIGH** — Immediate SyntaxError on import

**Problem**: The plan's Python code uses PEP 604 union type syntax:
```python
def recv(self) -> str | None:
```

`str | None` syntax was added in **Python 3.10** (PEP 604). On Python 3.6–3.9, this raises:
```
SyntaxError: unsupported operand type(s) for |: 'type' and 'NoneType'
```

The script would **fail to even import**, let alone run.

Additional Python 3.6 compatibility risks:
- `capture_output=True` in `subprocess.run()` requires **Python 3.7+**
- Walrus operator `:=` requires **Python 3.8+** (not used in plan, but watch out during implementation)
- `dict | dict` merge requires **Python 3.9+**
- `match/case` requires **Python 3.10+**

**Fix**: Use `typing.Optional` for 3.6 compatibility:
```python
from typing import Optional, List, Dict

def recv(self) -> Optional[str]:
    """Receive a text frame. Returns None on close."""
    ...
```

Or, since the plan targets VDI environments (which likely have Python 3.8+), raise minimum to **Python 3.8+** and use `from __future__ import annotations` (PEP 563):
```python
from __future__ import annotations  # Makes all annotations strings (lazy eval)
# Now str | None works as a string annotation in Python 3.8+
```

**Recommendation**: Set minimum to **Python 3.8+** (3.6 EOL was Dec 2021, 3.7 EOL was Jun 2023). Document this clearly.

---

### Issue 10: `CLAWD_WORKER_TOKEN` Environment Variable

**Severity**: 🟢 **LOW** — Works correctly, documentation gap only

**Problem**: The env var `CLAWD_WORKER_TOKEN` is read via:
- TypeScript: `process.env.CLAWD_WORKER_TOKEN`
- Python: `os.environ.get('CLAWD_WORKER_TOKEN')`

Both work identically across all shells (cmd.exe, PowerShell, bash, zsh). The OS passes the environment block to the process regardless of shell syntax.

**Gotchas to document**:

1. **Setting the variable** differs per shell:
   ```
   # bash/zsh (Linux/macOS/Git Bash/WSL):
   export CLAWD_WORKER_TOKEN=wkr_abc123
   
   # cmd.exe (Windows):
   set CLAWD_WORKER_TOKEN=wkr_abc123
   
   # PowerShell (Windows):
   $env:CLAWD_WORKER_TOKEN = "wkr_abc123"
   ```

2. **Windows env vars are case-insensitive**: `CLAWD_WORKER_TOKEN` and `clawd_worker_token` resolve to the same value. On Linux/macOS they'd be different. Not a bug, but worth noting.

3. **PowerShell quoting**: If the token contains special chars (`$`, `` ` ``), PowerShell requires single quotes: `$env:CLAWD_WORKER_TOKEN = 'wkr_$pecial'`.

**Fix**: Add shell-specific examples to README. No code changes needed.

---

## Bonus Issues Found During Scouting

### Issue 11: Python WebSocket Close Frame is Malformed

**Severity**: 🟡 **HIGH** — May cause connection errors with strict servers

**Problem**: The plan's close frame:
```python
self.sock.sendall(b"\x88\x82" + os.urandom(4))  # Masked close
```

This declares `length=2` (0x82 = MASK bit + 2) and sends a 4-byte mask key, but **no payload bytes**. Per RFC 6455 §5.5.1, a close frame with `length=2` must contain a 2-byte status code. The server would try to read 2 masked bytes and either block or error.

**Fix**:
```python
def close(self):
    if not self._closed:
        self._closed = True
        try:
            mask = os.urandom(4)
            # Status code 1000 (normal closure)
            status = struct.pack("!H", 1000)
            masked_status = bytes(b ^ mask[i % 4] for i, b in enumerate(status))
            frame = b"\x88\x82" + mask + masked_status
            self.sock.sendall(frame)
        except:
            pass
        self.sock.close()
```

### Issue 12: `.env` Blocking Misses PowerShell Aliases

**Severity**: 🟡 **HIGH** — Security gap on Windows

**Problem**: The `.env` access blocking regex:
```typescript
/(cat|less|more|head|tail|type|get-content)/i.test(args.command)
```

**Tested**: `gc .env` → **ALLOWED** (bypasses the check!)

PowerShell aliases not covered:
- `gc` → `Get-Content`
- `cat` is aliased in PowerShell but IS covered ✓
- `type` IS covered ✓
- `ii .env` (`Invoke-Item`) → opens in default editor (less critical)
- `[System.IO.File]::ReadAllText('.env')` → .NET API (not regex-catchable)
- `cmd /c type .env` → nested cmd.exe (the regex catches `type` within the full string ✓)

**Fix**: Expand the regex and add a note about defense-in-depth:
```typescript
const envReadCommands = /(cat|less|more|head|tail|type|get-content|gc|sls|select-string)\b/i;
// Note: cannot catch all .NET/PowerShell reflection attacks
// Defense-in-depth: also scan the output for .env-like content patterns
```

---

## Summary Table

| # | Issue | Severity | Platform | Status |
|---|-------|----------|----------|--------|
| 1 | Path `startsWith` uses `/` not `path.sep` | 🔴 Critical | Windows | Security bypass |
| 2 | `cmd.exe /c` fallback insufficient | 🟡 High | Windows | Functionality loss |
| 3 | `findstr` is poor `grep` replacement | 🟡 High | Windows | Functionality loss |
| 4 | Long paths / recursive glob | 🟢 Low | Windows | Edge case |
| 5 | Python SSL certs on Windows VDI | 🟡 High | Windows | Connection failure |
| 6 | macOS Gatekeeper | 🟢 Low | macOS | Non-issue for scripts |
| 7 | `\r\n` vs `\n` in edit tool | 🔴 Critical | Windows | Silent failure |
| 8 | Node 18 has NO built-in WebSocket | 🔴 Critical | All | Won't start |
| 9 | `str \| None` syntax needs Python 3.10+ | 🟡 High | All | SyntaxError |
| 10 | Env var shell syntax differences | 🟢 Low | Windows | Docs only |
| 11 | Malformed WebSocket close frame | 🟡 High | All | Protocol error |
| 12 | `.env` blocking misses PowerShell `gc` | 🟡 High | Windows | Security gap |

---

## Positive Observations

1. **Follows established patterns**: The plan mirrors `browser-bridge.ts` architecture faithfully — same `PendingRequest` pattern, same timeout constants, same `Map`-based connection tracking
2. **Zero-dependency design**: Both TypeScript and Python workers avoid external dependencies, which is excellent for the VDI target environment
3. **Stdlib WebSocket implementation**: The Python RFC 6455 handshake code is largely correct (frame parsing, masking, opcodes) — just needs the close frame fix
4. **Reconnection with exponential backoff**: Properly caps at 300s, re-sends REGISTER on reconnect
5. **Read-only mode**: The `--read-only` flag is a great security feature for untrusted environments
6. **Output truncation**: 50KB limit prevents memory exhaustion from runaway commands
7. **IMCPConnection bridge**: Clean integration with existing MCPManager without modifying the manager itself

---

## Recommended Actions (Priority Order)

1. **🔴 Fix Node.js version requirement** — Change to "Node.js 22.4+ or Bun 1.0+" OR add WebSocket polyfill detection (Issue 8)
2. **🔴 Fix path separator in `isWithinRoot()`** — Use `path.sep` not hardcoded `/` (Issue 1)
3. **🔴 Add line ending normalization to edit tool** — Match file's line ending style before comparing (Issue 7)
4. **🟡 Fix Python type syntax** — Use `Optional[str]` or bump minimum to 3.8+ with `from __future__ import annotations` (Issue 9)
5. **🟡 Fix WebSocket close frame** — Add masked status code payload (Issue 11)
6. **🟡 Add shell detection chain for Windows** — Prefer Git Bash > WSL > pwsh > cmd.exe (Issue 2)
7. **🟡 Add Select-String as grep fallback** — Between rg and findstr (Issue 3)
8. **🟡 Add SSL cert handling for Windows VDI** — `--insecure` flag + Windows cert store loading (Issue 5)
9. **🟡 Expand .env blocking regex** — Add `gc`, `sls` PowerShell aliases (Issue 12)
10. **🟢 Add shell-specific env var docs to README** — cmd.exe, PowerShell, bash syntax (Issue 10)
11. **🟢 Add macOS quarantine removal to README** — For compiled binary distribution (Issue 6)

---

## Verdict

### ❌ NEEDS CHANGES

**3 critical issues** must be resolved before implementation:
- Issue 8 (Node.js WebSocket) — Worker literally won't start on Node 18/20
- Issue 1 (Path separator) — Security bypass on Windows
- Issue 7 (Line endings) — Silent edit failures on Windows

**4 high-severity issues** should be addressed in the plan before coding begins:
- Issue 9 (Python syntax) — Immediate crash on stated minimum Python version
- Issue 11 (Close frame) — Protocol violation
- Issue 2 (Shell detection) — Major functionality gap
- Issue 5 (SSL certs) — Breaks on the VDI target environment

Once these are incorporated into the plan, it is ready to implement.

---

## Plan TODO Checklist Status

| Phase | Task | Status |
|-------|------|--------|
| Phase 1 | `worker-ts` — TypeScript worker | ⏳ Not started (blocked by Issues 1,7,8) |
| Phase 1 | `worker-py` — Python worker | ⏳ Not started (blocked by Issues 1,5,7,9,11) |
| Phase 1 | `server-ws` — WebSocket handler | ⏳ Not started |
| Phase 1 | `server-bridge` — MCP connection | ⏳ Not started |
| Phase 2 | `server-routing` — WS routing | ⏳ Not started |
| Phase 2 | `server-tokens` — Token management | ⏳ Not started |
| Phase 3 | `worker-readme` — Documentation | ⏳ Not started (needs Issues 6,10 content) |
| Phase 3 | `integration-test` — E2E test | ⏳ Not started |

**Recommended**: Add a "Phase 0: Cross-platform fixes" before Phase 1 to address the 7 blocking issues identified in this review.
