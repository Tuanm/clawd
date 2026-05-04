/**
 * Tests for gitignoreCache mtime-based invalidation.
 *
 * The cache is keyed on `.git/index` mtime so that after a `git add` / `git rm` /
 * commit the next call sees the new tracked-file set without per-call wall-clock
 * timeouts. We exercise three paths:
 *   1. Repeat call with no index change → identical Set instance (cache hit)
 *   2. After staging a new file → fresh Set with the new entry (cache miss + refresh)
 *   3. mtime=0 fallback (no .git/index, e.g. fresh init before first add) → no cache hit
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testHooks } from "../crud";

const { getGitTrackedFilesForRoot, getGitIndexMtime, gitignoreCache } = __testHooks;

function initRepo(dir: string): void {
  execSync("git init -q", { cwd: dir });
  // Suppress global config noise; the test repo doesn't need an identity unless we commit.
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
}

describe("gitignoreCache mtime invalidation", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "clawd-gitignore-test-"));
    gitignoreCache.clear();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    gitignoreCache.clear();
  });

  test("returns same Set instance on repeated call when index unchanged", () => {
    initRepo(tmp);
    writeFileSync(join(tmp, "a.ts"), "x");
    execSync("git add a.ts", { cwd: tmp });

    const first = getGitTrackedFilesForRoot(tmp);
    const second = getGitTrackedFilesForRoot(tmp);
    expect(first).not.toBeNull();
    expect(first).toBe(second!); // same object reference → cache hit
    expect(first!.has("a.ts")).toBe(true);
  });

  test("invalidates after `git add` modifies .git/index mtime", () => {
    initRepo(tmp);
    writeFileSync(join(tmp, "a.ts"), "x");
    execSync("git add a.ts", { cwd: tmp });

    const first = getGitTrackedFilesForRoot(tmp);
    expect(first).not.toBeNull();
    expect(first!.size).toBe(1);

    // Mutate working tree + index. Sleep 20ms to ensure mtime resolution
    // bumps even on filesystems with coarse mtime granularity.
    Bun.sleepSync(20);
    writeFileSync(join(tmp, "b.ts"), "y");
    execSync("git add b.ts", { cwd: tmp });

    const second = getGitTrackedFilesForRoot(tmp);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first!); // fresh Set instance after invalidation
    expect(second!.size).toBe(2);
    expect(second!.has("a.ts")).toBe(true);
    expect(second!.has("b.ts")).toBe(true);
  });

  test("invalidates after `git rm` removes a file from index", () => {
    initRepo(tmp);
    writeFileSync(join(tmp, "a.ts"), "x");
    writeFileSync(join(tmp, "b.ts"), "y");
    execSync("git add .", { cwd: tmp });
    const first = getGitTrackedFilesForRoot(tmp);
    expect(first!.size).toBe(2);

    Bun.sleepSync(20);
    // Need a commit before `git rm` will remove a staged-only file; use -f instead.
    execSync("git rm -fq b.ts", { cwd: tmp });

    const second = getGitTrackedFilesForRoot(tmp);
    expect(second).not.toBe(first!);
    expect(second!.size).toBe(1);
    expect(second!.has("a.ts")).toBe(true);
    expect(second!.has("b.ts")).toBe(false);
  });

  test("getGitIndexMtime returns 0 when .git/index missing", () => {
    initRepo(tmp);
    // Fresh init has no .git/index until something is added.
    expect(getGitIndexMtime(tmp)).toBe(0);

    // After add, mtime is real.
    writeFileSync(join(tmp, "a.ts"), "x");
    execSync("git add a.ts", { cwd: tmp });
    expect(getGitIndexMtime(tmp)).toBeGreaterThan(0);
  });

  test("getGitIndexMtime returns 0 for non-git directory", () => {
    expect(getGitIndexMtime(tmp)).toBe(0);
  });

  test("with mtime=0 (no index), call still works but does not cache", () => {
    initRepo(tmp);
    // No file added yet → no .git/index → mtime=0.
    // git ls-files returns empty list, but call should still succeed.
    expect(getGitIndexMtime(tmp)).toBe(0);

    const first = getGitTrackedFilesForRoot(tmp);
    expect(first).not.toBeNull();
    expect(first!.size).toBe(0);

    // mtime=0 means cache is NOT trusted → next call re-runs git ls-files (different Set).
    const second = getGitTrackedFilesForRoot(tmp);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first!); // not cached, fresh Set
  });

  test("submodule layout (.git as file pointing to gitdir) resolves index", () => {
    // Simulate a submodule: working tree at `tmp/sub`, real gitdir elsewhere.
    const realGitDir = join(tmp, "modules", "sub");
    const workTree = join(tmp, "sub");
    mkdirSync(realGitDir, { recursive: true });
    mkdirSync(workTree, { recursive: true });
    execSync(`git init -q --separate-git-dir="${realGitDir}" "${workTree}"`, { cwd: tmp });
    execSync("git config user.email test@example.com", { cwd: workTree });
    execSync("git config user.name test", { cwd: workTree });
    writeFileSync(join(workTree, "f.ts"), "z");
    execSync("git add f.ts", { cwd: workTree });

    const mtime = getGitIndexMtime(workTree);
    expect(mtime).toBeGreaterThan(0);

    const tracked = getGitTrackedFilesForRoot(workTree);
    expect(tracked).not.toBeNull();
    expect(tracked!.has("f.ts")).toBe(true);
  });
});
