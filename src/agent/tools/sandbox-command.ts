/**
 * Sandbox command enforcement — single chokepoint for every shell command
 * an agent can launch (foreground bash, background bash, job_submit,
 * tmux_send_command, …).
 *
 * Without this helper, each call site re-implemented its own policy (or
 * worse, forgot to). That drift produced the bypass bugs where
 * `bash(run_in_background=true)` / `job_submit` / `tmux_send_command`
 * skipped the `.env` block and/or the kernel sandbox wrap.
 *
 * Responsibilities (in order):
 *   1. Resolve `workDir` (caller-provided `cwd` or the sandbox project root).
 *   2. When sandbox is enabled:
 *      - validate `workDir` is inside the allowed roots (projectRoot + /tmp).
 *      - block commands matching the `.env` read/write pattern (raw source,
 *        BEFORE wrapping — the kernel sandbox only blocks paths *outside*
 *        project root, so `.env` inside the project must be denied here).
 *   3. When sandbox is *ready* (init succeeded): wrap with bwrap / sandbox-exec
 *      via `wrapCommandForSandbox`. When enabled-but-not-ready (missing deps),
 *      return the raw command — path validation above still applied.
 *   4. In YOLO mode (sandbox disabled): no-op, just echo inputs back.
 */

import {
  getSandboxProjectRoot,
  isSandboxEnabled,
  isSandboxReady,
  validatePath,
  wrapCommandForSandbox,
} from "./registry";

/**
 * Matches `.env` / `.env.production` / etc. but *not* `.env.example` or
 * anything ending with `.example`. Anchored on word-ish boundaries so
 * substrings inside identifiers (e.g. `my.env.module`) don't match.
 */
export const ENV_FILE_PATTERN =
  /(?:^|[^a-zA-Z0-9_.])\.env(?!\.[a-zA-Z]*example)(?:\.[a-zA-Z0-9_]*)?(?:[^a-zA-Z0-9_.]|$)/;

export type SandboxPolicyOutcome =
  | { ok: true; wrapped: string; workDir: string; sandboxed: boolean; notice: string }
  | { ok: false; error: string };

export interface SandboxPolicyInput {
  /** Raw command the agent requested. Will be wrapped when sandbox is ready. */
  command: string;
  /** Optional caller-provided cwd. Falls back to sandbox project root. */
  cwd?: string;
  /** Human label for error messages (e.g. "bash cwd", "job cwd"). */
  operation: string;
}

/**
 * Apply every sandbox policy to a shell command. Returns either a wrapped
 * command ready to hand to a spawner, or a structured error to return to
 * the agent.
 *
 * Keep the logic here in sync across *all* command-launching tools —
 * adding a new code path that launches shell commands MUST go through this.
 */
export async function enforceSandboxPolicy(input: SandboxPolicyInput): Promise<SandboxPolicyOutcome> {
  const { command, cwd, operation } = input;
  const projectRoot = getSandboxProjectRoot();
  const workDir = cwd || projectRoot;

  // YOLO mode — sandbox disabled: pass through untouched.
  if (!isSandboxEnabled()) {
    return { ok: true, wrapped: command, workDir, sandboxed: false, notice: "" };
  }

  // 1. cwd must be inside the allowed roots.
  const cwdError = validatePath(workDir, operation);
  if (cwdError) return { ok: false, error: cwdError };

  // 2. `.env` block — applied to the *raw* command, before any wrap.
  //    The kernel sandbox permits project-root paths (that's where the agent
  //    lives), so `.env` files inside it would otherwise be readable.
  if (ENV_FILE_PATTERN.test(command)) {
    return {
      ok: false,
      error:
        "SANDBOX RESTRICTION: Access to .env files is blocked for security reasons. " +
        "These files may contain secrets. Use .env.example as a template instead.",
    };
  }

  const notice = `[SANDBOX MODE] You can ONLY access: ${projectRoot} and /tmp. All other paths are blocked.\n\n`;

  // 3. Kernel-level wrap — only if sandbox init succeeded. When enabled but
  //    not ready, fall through with the raw command; validation above has
  //    already enforced what it can at the userspace layer.
  if (!isSandboxReady()) {
    return { ok: true, wrapped: command, workDir, sandboxed: false, notice };
  }

  try {
    const wrapped = await wrapCommandForSandbox(command, workDir);
    return { ok: true, wrapped, workDir, sandboxed: true, notice };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Sandbox wrapping failed: ${message}` };
  }
}
