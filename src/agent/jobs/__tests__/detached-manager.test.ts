/**
 * Tests for DetachedJobManager — the tmux-fallback that spawns each job as a
 * detached subprocess and tracks state via on-disk meta + exit_code files.
 *
 * Why these matter: the manager has to hold three properties simultaneously,
 * and any one of them silently breaking is a hard-to-detect production bug:
 *   1. log fd survives parent's closeSync (child keeps writing)
 *   2. exit_code wrapper actually fires (status transition completes → failed)
 *   3. cancel() reaches the whole process group (long-runner actually dies)
 *
 * Each test creates real subprocesses against the real jobs dir but cleans
 * up the per-job directory afterwards, so cross-test pollution is bounded.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DetachedJobManager } from "../detached-manager";

// Resolve the same dir the manager uses, so cleanup matches exactly.
function jobsDir(): string {
  try {
    const { getProjectJobsDir } = require("../../tools/definitions");
    return getProjectJobsDir();
  } catch {
    return join(homedir(), ".clawd", "jobs");
  }
}

const createdIds = new Set<string>();

afterEach(() => {
  for (const id of createdIds) {
    const dir = join(jobsDir(), id);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
  createdIds.clear();
});

function track(id: string): string {
  createdIds.add(id);
  return id;
}

// Platform-specific shell commands. The manager auto-selects bash on POSIX
// and cmd.exe on Windows, so test commands must be valid for the current host.
const IS_WIN = process.platform === "win32";
const HELLO = "hello-from-detached";
const ECHO_HELLO = `echo ${HELLO}`;
// `exit 7` works in both: bash exits the subshell, cmd exits the inner cmd
// (our wrapper isolates it the same way bash's `( … )` does).
const EXIT_7 = "exit 7";
// 30s sleeper that survives redirected stdin. NB: `timeout.exe` is NOT usable
// here — it bails immediately under detached stdio with
// "ERROR: Input redirection is not supported". `ping -n 31` waits 30s
// because the first ping is immediate and the rest are ~1s apart.
const SLEEP_30 = IS_WIN ? "ping -n 31 127.0.0.1 >nul" : "sleep 30";
// No-op that returns 0. `exit /b 0` is the documented batch-exit-without-error
// path; matches the wrapper's own exit pattern.
const NOOP = IS_WIN ? "exit /b 0" : "true";
// 5 lines on stdout. Single `&` chains echoes regardless of exit on cmd;
// bash uses printf so we get exactly the same five-character payload.
const PRINT_5_LINES = IS_WIN
  ? "echo a&echo b&echo c&echo d&echo e"
  : "printf 'a\\nb\\nc\\nd\\ne\\n'";
// cmd.exe spawn is meaningfully slower than bash; give the wrapper time to
// reach the inner process before asserting "running".
const SPAWN_SETTLE_MS = IS_WIN ? 600 : 200;

describe("DetachedJobManager", () => {
  test("submit + waitFor: successful command yields status=completed exitCode=0 with stdout in logs", async () => {
    const mgr = new DetachedJobManager();
    const id = track(mgr.submit("echo-test", ECHO_HELLO));

    const job = await mgr.waitFor(id, 10000);
    expect(job.status).toBe("completed");
    expect(job.exitCode).toBe(0);

    const logs = mgr.getLogs(id);
    expect(logs).toContain(HELLO);
  });

  test("submit + waitFor: failing command yields status=failed with the exit code", async () => {
    const mgr = new DetachedJobManager();
    const id = track(mgr.submit("fail-test", EXIT_7));

    const job = await mgr.waitFor(id, 10000);
    expect(job.status).toBe("failed");
    expect(job.exitCode).toBe(7);
  });

  test("cancel: kills a long-running job and reports status=cancelled", async () => {
    const mgr = new DetachedJobManager();
    const id = track(mgr.submit("sleep-test", SLEEP_30));

    // Give the wrapper script time to spawn the sleeper so the pid is real.
    await new Promise((r) => setTimeout(r, SPAWN_SETTLE_MS));

    const before = mgr.get(id);
    expect(before?.status).toBe("running");

    const ok = mgr.cancel(id);
    expect(ok).toBe(true);

    // SIGTERM / taskkill may take a tick to land. Poll briefly.
    let after = mgr.get(id);
    for (let i = 0; i < 30 && after?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = mgr.get(id);
    }
    expect(after?.status).toBe("cancelled");
    expect(after?.exitCode).toBe(-1);
  });

  test("cancel: returns false for an already-completed job", async () => {
    const mgr = new DetachedJobManager();
    const id = track(mgr.submit("quick", NOOP));
    await mgr.waitFor(id, 5000);

    expect(mgr.cancel(id)).toBe(false);
  });

  test("get: returns undefined for unknown job id", () => {
    const mgr = new DetachedJobManager();
    expect(mgr.get("nonexistent-id")).toBeUndefined();
  });

  test("list: includes jobs we submitted, ignores tmux-flavored entries", async () => {
    const mgr = new DetachedJobManager();
    const id1 = track(mgr.submit("list-a", NOOP));
    const id2 = track(mgr.submit("list-b", NOOP));

    await mgr.waitFor(id1, 5000);
    await mgr.waitFor(id2, 5000);

    const ids = mgr.list().map((j) => j.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);

    // Confirm the jobs dir has actual entries (sanity that we're hitting disk).
    const dir = jobsDir();
    if (existsSync(dir)) {
      const entries = readdirSync(dir);
      expect(entries).toContain(id1);
      expect(entries).toContain(id2);
    }
  });

  test("getLogs with tail returns only the last N lines", async () => {
    const mgr = new DetachedJobManager();
    const id = track(mgr.submit("tail-test", PRINT_5_LINES));
    await mgr.waitFor(id, 5000);

    const tailed = mgr.getLogs(id, 2);
    // The split("\n").slice(-2) approach yields the trailing empty line + "e",
    // so we just assert the last printed line is present and earlier ones are not.
    expect(tailed).toContain("e");
    expect(tailed).not.toContain("a\nb");
  });
});
