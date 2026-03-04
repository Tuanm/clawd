# Phase 0A Security Remediation Review - Agent-75

**Date**: 2026-03-04
**Reviewer**: Agent-75 (Security Code Review)
**Scope**: Phase 0A plan - Eliminate execSync shell injection across tmux subsystem
**Files examined**: tmux-manager.ts (422 LOC), tools.ts (3280 LOC), worktree.ts (125 LOC), clawd-chat/index.ts (885 LOC), sandbox.ts

---

## Code Review Summary

### Scope
- **Primary files**: `src/agent/src/jobs/tmux-manager.ts`, `src/agent/src/tools/tools.ts`
- **Scout files**: `src/agent/src/workspace/worktree.ts`, `src/agent/workers/clawd-chat/index.ts`, `src/agent/src/plugins/state-persistence-plugin.ts`
- **LOC reviewed**: ~4,712
- **Focus**: All `execSync` with string interpolation; heredoc injection; script template injection

### Overall Assessment

The plan addresses the highest-severity injection vectors correctly, but has **significant coverage gaps**. Three files with the same vulnerability class are not mentioned. Two fixes have implementation concerns.

**Verdict: CONDITIONAL PASS** - Fixes 1, 2, 5 are sound; Fix 3 needs hardening; Fix 4 needs careful implementation; and 3 missed files must be added to plan scope.

---

## Fix-by-Fix Review

### Fix 1: tmux-manager.ts - Replace execTmux() with execFileTmux()

**Rating: PASS**

**Vulnerability** (L96-102): tmuxCmd() builds a shell string via template literal, passed to execSync(). Shell metacharacters in args would be interpreted.

**Analysis**: execFileSync("tmux", ["-f", "/dev/null", "-S", SOCKET_PATH(), ...args]) bypasses the shell entirely. Correct approach.

**Concerns - call-site migration**:

| Call Site | Issue | Fix |
|---|---|---|
| L110: has-session with `2>/dev/null && echo yes` | Shell AND + redirect | Use try/catch. Success = exists. |
| L115: list-sessions with `2>/dev/null` | Redirect | Remove redirect; handle stderr via try/catch. |
| L172: new-session with quoted args | Shell quoting | Array args need no quotes. |
| L318: kill-session with quoted name | Shell quoting | Straightforward array conversion. |
| L413: kill-server | Clean | Trivial. |

sessionName at L137 uses randomUUID() (hex+hyphens) - no injection risk.

---

### Fix 2: getLogs() tail injection

**Rating: PASS**

execFileSync("tail", ["-n", String(Math.max(1, parseInt(tail))), logFile]) is correct. Also handle NaN. Consider pure-Node alternative (readFileSync + split + slice).

---

### Fix 3: Script generation injection

**Rating: CONCERN - Misidentified target**

The `${command}` is intentionally arbitrary (a bash execution tool). The real injection risk is the **path template variables** (`${logFile}`, `${exitFile}`) which could contain shell metacharacters if user home dir has special chars.

**Recommendation**: Use environment variables for path interpolation:
```bash
exec > "$CLAWD_LOG_FILE" 2>&1
( bash "$CLAWD_COMMAND_FILE" )
```

TOCTOU risk: LOW (0o700 perms, same-privilege race).

---

### Fix 4: Heredoc CLAWD_EOF injection

**Rating: CONCERN - Implementation blocker**

If content contains literal `CLAWD_EOF` on its own line, heredoc terminates early -> shell command injection. **Real, exploitable vector.**

Proposed stdin piping is correct BUT runInSandbox() uses `stdio: ["ignore", ...]` - **stdin is IGNORED**. Cannot pipe content without interface modification.

**Alternative**: Write content to temp file via Node fs, then copy through sandbox:
```typescript
writeFileSync(tmpPath, content, { mode: 0o644 });
await runInSandbox("cp", [tmpPath, resolvedPath]);
unlinkSync(tmpPath);
```

---

### Fix 5: Agent termination execSync injection

**Rating: PASS**

execFileSync("tmux", ["-S", socketPath, "kill-session", "-t", sessionName]) eliminates shell interpretation. Correct.

Must also apply to identical pattern at L3186 (terminateAllSubAgents).

---

## MISSED VULNERABILITIES (Not in Plan)

### CRITICAL MISS 1: spawnTmuxSubAgent() - tools.ts L2126-2143

Unvalidated `name` parameter from spawn_agent tool is:
1. Interpolated into sessionName (L2079)
2. Interpolated into shell script template (L2129)
3. Interpolated into clawdCmd (L2133)
4. Interpolated into execSync command (L2140-2143)

The escapedTask escaping (L2110) misses backslash, newlines, other bash metacharacters.

**Fix**: Validate name, convert L2143 to execFileSync, use env vars in script template.

### CRITICAL MISS 2: clawd-chat/index.ts L185, L191

Same execSync + tmux pattern. Also lacks dedicated socket (-S). Script template interpolates unsanitized projectRoot and args.

**Fix**: Apply execFileSync. Add -S socket. Validate script template variables.

### HIGH MISS 3: worktree.ts - 9 execSync calls with string interpolation

branchName from agentId is single-quote escaped but breaks with embedded single quotes.

**Fix**: Use execFileSync with array args for all git and rsync calls.

### MEDIUM MISS 4: state-persistence-plugin.ts L95

Static command, no user input. Low risk. Modernize to execFileSync.

### MEDIUM MISS 5: tmux_send_command workDir injection (tools.ts L2639)

workDir with shell metacharacters breaks cd quoting. Fix: use tmux -c flag.

---

## Summary Table

| Fix | Rating | Notes |
|-----|--------|-------|
| Fix 1: execTmux to execFileTmux | PASS | Must adapt each call site for shell constructs |
| Fix 2: getLogs tail validation | PASS | Consider pure-Node. Handle NaN |
| Fix 3: Script generation | CONCERN | Real risk is path interpolation. Use env vars |
| Fix 4: Heredoc CLAWD_EOF | CONCERN | runInSandbox stdin blocker. Use temp-file approach |
| Fix 5: Agent termination execSync | PASS | Must also apply to L3186 |
| MISS: spawnTmuxSubAgent | CRITICAL | Unvalidated name param in shell + script template |
| MISS: clawd-chat/index.ts | CRITICAL | Same execSync+tmux, no dedicated socket |
| MISS: worktree.ts | HIGH | 9 execSync calls, single-quote escaping breakable |
| MISS: state-persistence-plugin.ts | MEDIUM | Static command, low risk |
| MISS: tmux_send_command workDir | MEDIUM | cd quoting breakable |

---

## Positive Observations

1. **tmux socket isolation is correct**: Per-project -S sockets provide genuine process isolation.
2. **Job IDs use randomUUID()**: Eliminates path traversal and injection in tmux-manager.ts.
3. **tools.ts execTmux (L2566) already uses spawn("tmux", args)**: Interactive tmux tools use the safe pattern.
4. **Session name validation exists** (L2625): /^[a-zA-Z0-9_-]+$/ for user-facing tmux tools - replicate to spawnTmuxSubAgent.
5. **Sandbox architecture is sound**: runInSandbox with bwrap/sandbox-exec and shellEscape() is well-designed.
6. **clawd-chat sanitizes sessionName** (L154): Good pattern to replicate everywhere.

---

## Recommended Actions (Priority Order)

1. **[CRITICAL] Add spawnTmuxSubAgent to plan scope** - Validate name, convert L2143 to execFileSync, sanitize script template.
2. **[CRITICAL] Add clawd-chat/index.ts to plan scope** - Convert L185, L191 to execFileSync. Add -S socket.
3. **[HIGH] Add worktree.ts to plan scope** - Convert all 9 execSync calls to execFileSync with array args.
4. **[HIGH] Fix 4 implementation** - Use temp-file-then-copy pattern to work within runInSandbox interface.
5. **[MEDIUM] Fix 3 refinement** - Use environment variables for path interpolation in script templates.
6. **[MEDIUM] Add name parameter validation** to spawn_agent tool.
7. **[LOW]** Convert state-persistence-plugin.ts L95 to execFileSync.
8. **[LOW]** Fix tmux_send_command workDir quoting via tmux -c flag.

---

## Final Verdict

### CONDITIONAL PASS

The 5 planned fixes are directionally correct and will meaningfully reduce the attack surface. However:

- **3 files with identical vulnerability patterns are not covered** (spawnTmuxSubAgent in tools.ts, clawd-chat/index.ts, worktree.ts)
- **Fix 4 has an implementation blocker** (runInSandbox stdin interface)
- **Fix 3 addresses the wrong injection target** (the command is intentionally arbitrary; the path variables are the real risk)

**The plan should be amended to include the missed files before implementation begins.** The risk of implementing only the 5 planned fixes is creating a false sense of completion while leaving exploitable vectors in the sub-agent spawning path - arguably the highest-risk code path since an LLM directly controls the parameters.

---

*Report generated by Agent-75. No code changes made - findings and recommendations only.*