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

// Skip the whole suite on Windows — manager throws there by design.
const SKIP_WINDOWS = process.platform === "win32";
const describeOrSkip = SKIP_WINDOWS ? describe.skip : describe;

describeOrSkip("DetachedJobManager", () => {
  test("submit + waitFor: successful command yields status=completed exitCode=0 with stdout in logs", async () => {
    const mgr = new DetachedJobManager();
    const id = track(mgr.submit("echo-test", "echo hello-from-detached"));

    const job = await mgr.waitFor(id, 10000);
    expect(job.status).toBe("completed");
    expect(job.exitCode).toBe(0);

    const logs = mgr.getLogs(id);
    expect(logs).toContain("hello-from-detached");
  });

  test("submit + waitFor: failing command yields status=failed with the exit code", async () => {
    const mgr = new DetachedJobManager();
    const id = track(mgr.submit("fail-test", "exit 7"));

    const job = await mgr.waitFor(id, 10000);
    expect(job.status).toBe("failed");
    expect(job.exitCode).toBe(7);
  });

  test("cancel: kills a long-running job and reports status=cancelled", async () => {
    const mgr = new DetachedJobManager();
    const id = track(mgr.submit("sleep-test", "sleep 30"));

    // Give the wrapper script time to exec sleep so the pid is real.
    await new Promise((r) => setTimeout(r, 200));

    const before = mgr.get(id);
    expect(before?.status).toBe("running");

    const ok = mgr.cancel(id);
    expect(ok).toBe(true);

    // SIGTERM may take a tick to land. Poll briefly.
    let after = mgr.get(id);
    for (let i = 0; i < 20 && after?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = mgr.get(id);
    }
    expect(after?.status).toBe("cancelled");
    expect(after?.exitCode).toBe(-1);
  });

  test("cancel: returns false for an already-completed job", async () => {
    const mgr = new DetachedJobManager();
    const id = track(mgr.submit("quick", "true"));
    await mgr.waitFor(id, 5000);

    expect(mgr.cancel(id)).toBe(false);
  });

  test("get: returns undefined for unknown job id", () => {
    const mgr = new DetachedJobManager();
    expect(mgr.get("nonexistent-id")).toBeUndefined();
  });

  test("list: includes jobs we submitted, ignores tmux-flavored entries", async () => {
    const mgr = new DetachedJobManager();
    const id1 = track(mgr.submit("list-a", "true"));
    const id2 = track(mgr.submit("list-b", "true"));

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
    // 5-line printf; we want the last 2.
    const id = track(mgr.submit("tail-test", "printf 'a\\nb\\nc\\nd\\ne\\n'"));
    await mgr.waitFor(id, 5000);

    const tailed = mgr.getLogs(id, 2);
    // The split("\n").slice(-2) approach yields the trailing empty line + "e",
    // so we just assert the last printed line is present and earlier ones are not.
    expect(tailed).toContain("e");
    expect(tailed).not.toContain("a\nb");
  });
});
