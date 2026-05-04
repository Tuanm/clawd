/**
 * Standalone Windows verification harness for DetachedJobManager.
 *
 * Mirrors the logic in src/agent/jobs/__tests__/detached-manager.test.ts but
 * runs as a single binary so we can compile to .exe and exercise the real
 * Windows code path from a Windows shell. Exits 0 on full pass, 1 on any
 * failure with a console.error explaining which check failed.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DetachedJobManager } from "../src/agent/jobs/detached-manager";

function jobsDir(): string {
  try {
    const { getProjectJobsDir } = require("../src/agent/tools/registry");
    return getProjectJobsDir();
  } catch {
    return join(homedir(), ".clawd", "jobs");
  }
}

const created = new Set<string>();
function track(id: string): string {
  created.add(id);
  return id;
}

const IS_WIN = process.platform === "win32";
const HELLO = "hello-from-detached";
const ECHO_HELLO = `echo ${HELLO}`;
const EXIT_7 = "exit 7";
const SLEEP_30 = IS_WIN ? "ping -n 31 127.0.0.1 >nul" : "sleep 30";
const NOOP = IS_WIN ? "exit /b 0" : "true";
const PRINT_5_LINES = IS_WIN ? "echo a&echo b&echo c&echo d&echo e" : "printf 'a\\nb\\nc\\nd\\ne\\n'";
const SPAWN_SETTLE_MS = IS_WIN ? 600 : 200;

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function run(): Promise<void> {
  console.log(`platform: ${process.platform}`);
  console.log(`jobs dir: ${jobsDir()}`);

  const mgr = new DetachedJobManager();

  // Test 1: success → completed, exit 0, stdout in logs
  console.log("\n[1] success → completed/0");
  {
    const id = track(mgr.submit("echo-test", ECHO_HELLO));
    const job = await mgr.waitFor(id, 10000);
    check("status === completed", job.status === "completed", `got ${job.status}`);
    check("exitCode === 0", job.exitCode === 0, `got ${job.exitCode}`);
    const logs = mgr.getLogs(id);
    check("logs contain HELLO", logs.includes(HELLO), `logs=${JSON.stringify(logs)}`);
  }

  // Test 2: failure → failed with exit code
  console.log("\n[2] exit 7 → failed/7");
  {
    const id = track(mgr.submit("fail-test", EXIT_7));
    const job = await mgr.waitFor(id, 10000);
    check("status === failed", job.status === "failed", `got ${job.status}`);
    check("exitCode === 7", job.exitCode === 7, `got ${job.exitCode}`);
  }

  // Test 3: cancel a long-runner
  console.log("\n[3] cancel long-runner → cancelled/-1");
  {
    const id = track(mgr.submit("sleep-test", SLEEP_30));
    await new Promise((r) => setTimeout(r, SPAWN_SETTLE_MS));

    const before = mgr.get(id);
    check("before cancel: running", before?.status === "running", `got ${before?.status}`);

    const ok = mgr.cancel(id);
    check("cancel returned true", ok === true, `got ${ok}`);

    let after = mgr.get(id);
    for (let i = 0; i < 30 && after?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = mgr.get(id);
    }
    check("after cancel: cancelled", after?.status === "cancelled", `got ${after?.status}`);
    check("after cancel: exitCode -1", after?.exitCode === -1, `got ${after?.exitCode}`);
  }

  // Test 4: cancel an already-completed job → false
  console.log("\n[4] cancel completed → false");
  {
    const id = track(mgr.submit("quick", NOOP));
    await mgr.waitFor(id, 5000);
    const ok = mgr.cancel(id);
    check("cancel returned false", ok === false, `got ${ok}`);
  }

  // Test 5: get unknown id → undefined
  console.log("\n[5] get unknown → undefined");
  {
    const got = mgr.get("nonexistent-id");
    check("undefined", got === undefined, `got ${JSON.stringify(got)}`);
  }

  // Test 6: list contains submitted ids
  console.log("\n[6] list contains submitted ids");
  {
    const id1 = track(mgr.submit("list-a", NOOP));
    const id2 = track(mgr.submit("list-b", NOOP));
    await mgr.waitFor(id1, 5000);
    await mgr.waitFor(id2, 5000);
    const ids = mgr.list().map((j) => j.id);
    check("list contains id1", ids.includes(id1));
    check("list contains id2", ids.includes(id2));

    const dir = jobsDir();
    if (existsSync(dir)) {
      const entries = readdirSync(dir);
      check("disk has id1", entries.includes(id1));
      check("disk has id2", entries.includes(id2));
    }
  }

  // Test 7: getLogs(tail) returns last N lines
  console.log("\n[7] getLogs tail");
  {
    const id = track(mgr.submit("tail-test", PRINT_5_LINES));
    await mgr.waitFor(id, 5000);
    const tailed = mgr.getLogs(id, 2);
    check("tailed contains 'e'", tailed.includes("e"), `tailed=${JSON.stringify(tailed)}`);
    check("tailed does not contain 'a\\nb'", !tailed.includes("a\nb"), `tailed=${JSON.stringify(tailed)}`);
  }

  // Cleanup — but if anything failed, dump the first job dir for debugging.
  if (failed > 0) {
    const firstId = [...created][0];
    if (firstId) {
      const dir = join(jobsDir(), firstId);
      console.error(`\n[DEBUG] Contents of ${dir}:`);
      try {
        for (const f of readdirSync(dir)) {
          const path = join(dir, f);
          const stat = require("node:fs").statSync(path);
          console.error(`  ${f} (${stat.size}B)`);
          if (stat.size > 0 && stat.size < 2000) {
            const content = require("node:fs").readFileSync(path, "utf8");
            console.error(`  ---\n${content}\n  ---`);
          }
        }
      } catch (e) {
        console.error("  dump error:", e);
      }
    }
  }
  for (const id of created) {
    const dir = join(jobsDir(), id);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }

  if (failed === 0) {
    console.log("\nALL CHECKS PASSED");
    process.exit(0);
  } else {
    console.error(`\n${failed} CHECK(S) FAILED`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
