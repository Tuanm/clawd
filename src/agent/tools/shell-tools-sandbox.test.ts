/**
 * Integration tests — verify that every shell-launching tool actually routes
 * through `enforceSandboxPolicy`. These tests catch regressions where a future
 * refactor might skip the policy for one path (like the original bypass bugs
 * in bash(run_in_background=true) / job_submit / tmux_send_command).
 *
 * We keep coverage at the policy boundary: assert that `.env` access is
 * rejected and out-of-bounds cwd is rejected with a clear error, without
 * actually invoking tmux / spawning child processes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableSandbox, setSandboxProjectRoot } from "../utils/sandbox";
import "./shell-tools";
import { tools } from "./registry";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "shell-tools-sandbox-test-"));
  setSandboxProjectRoot(projectRoot);
  enableSandbox(true);
});

afterEach(() => {
  enableSandbox(false);
  rmSync(projectRoot, { recursive: true, force: true });
});

// ── Foreground bash ────────────────────────────────────────────────────────

describe("bash (foreground) — sandbox enabled, not ready", () => {
  test("rejects .env read", async () => {
    const bash = tools.get("bash");
    expect(bash).toBeDefined();
    const r = await bash!({ command: "cat .env" });
    expect(r.success).toBe(false);
    expect(r.error).toContain(".env");
  });

  test("rejects cwd outside project root", async () => {
    const bash = tools.get("bash");
    const r = await bash!({ command: "ls", cwd: "/etc" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("SANDBOX RESTRICTION");
  });
});

// ── Background bash (run_in_background=true → tmux job) ────────────────────

describe("bash (background) — sandbox enabled, not ready", () => {
  test("rejects .env read before submitting job", async () => {
    const bash = tools.get("bash");
    const r = await bash!({ command: "cat .env", run_in_background: true });
    expect(r.success).toBe(false);
    expect(r.error).toContain(".env");
  });

  test("rejects cwd escape before submitting job", async () => {
    const bash = tools.get("bash");
    const r = await bash!({ command: "ls", cwd: "/etc", run_in_background: true });
    expect(r.success).toBe(false);
    expect(r.error).toContain("SANDBOX RESTRICTION");
  });
});

// ── job_submit ─────────────────────────────────────────────────────────────

describe("job_submit — sandbox enabled, not ready", () => {
  test("rejects .env commands", async () => {
    const jobSubmit = tools.get("job_submit");
    if (!jobSubmit) return; // tmux not installed in this env — skip
    const r = await jobSubmit({ name: "leak", command: "cat .env.production" });
    expect(r.success).toBe(false);
    expect(r.error).toContain(".env");
  });
});

// ── tmux_send_command ──────────────────────────────────────────────────────

describe("tmux_send_command — sandbox enabled, not ready", () => {
  test("rejects .env commands", async () => {
    const tmuxSend = tools.get("tmux_send_command");
    if (!tmuxSend) return; // tmux not installed — skip
    const r = await tmuxSend({ session: "dev", command: "cat .env" });
    expect(r.success).toBe(false);
    expect(r.error).toContain(".env");
  });

  test("rejects cwd outside project root", async () => {
    const tmuxSend = tools.get("tmux_send_command");
    if (!tmuxSend) return;
    const r = await tmuxSend({ session: "dev", command: "ls", cwd: "/etc" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("SANDBOX RESTRICTION");
  });
});

// ── YOLO mode — none of the above restrictions apply ───────────────────────

describe("YOLO mode (sandbox disabled) — restrictions bypassed", () => {
  beforeEach(() => enableSandbox(false));

  test("bash foreground does NOT block .env (would actually try to run it)", async () => {
    // We don't execute — just check policy path returns ok. Run a harmless
    // command that simply mentions .env in a way that would be blocked in
    // sandbox mode, and confirm it's not rejected with the sandbox error.
    const bash = tools.get("bash");
    const r = await bash!({ command: "echo '.env mentioned'", timeout: 5000 });
    expect(r.success).toBe(true);
  });
});
