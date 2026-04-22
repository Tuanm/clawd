/**
 * Unit tests for the unified sandbox command policy helper.
 *
 * Covers the bypass bugs that motivated creating this helper:
 *   - `bash(run_in_background=true)` / `job_submit` / `tmux_send_command` used
 *     to skip the `.env` block and cwd validation. Every call site now goes
 *     through `enforceSandboxPolicy` so a regression would break these tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableSandbox, setSandboxProjectRoot } from "../utils/sandbox";
import { ENV_FILE_PATTERN, enforceSandboxPolicy } from "./sandbox-command";

// ── test fixtures ──────────────────────────────────────────────────────────

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "sandbox-policy-test-"));
  setSandboxProjectRoot(projectRoot);
});

afterEach(() => {
  enableSandbox(false);
  rmSync(projectRoot, { recursive: true, force: true });
});

// ── ENV_FILE_PATTERN ───────────────────────────────────────────────────────

describe("ENV_FILE_PATTERN", () => {
  const blocked = [
    "cat .env",
    "cat /app/.env",
    "source .env",
    "source .env.production",
    "source .env.local",
    "grep DB_URL .env.staging",
    "echo X >> .env",
    "rm .env",
    "printenv && cat .env && echo done",
  ];
  for (const cmd of blocked) {
    test(`blocks: ${cmd}`, () => {
      expect(ENV_FILE_PATTERN.test(cmd)).toBe(true);
    });
  }

  const allowed = [
    "cat .env.example",
    "cp .env.example .env.example.bak",
    "grep DB .env.template.example",
    "echo prod.env.module",
    "node my.env.module.js",
    "cat foo.env", // no leading boundary
  ];
  for (const cmd of allowed) {
    test(`allows: ${cmd}`, () => {
      expect(ENV_FILE_PATTERN.test(cmd)).toBe(false);
    });
  }
});

// ── YOLO mode (sandbox disabled) ───────────────────────────────────────────

describe("enforceSandboxPolicy — YOLO mode", () => {
  beforeEach(() => enableSandbox(false));

  test("passes command through untouched", async () => {
    const r = await enforceSandboxPolicy({ command: "ls -la", operation: "bash cwd" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wrapped).toBe("ls -la");
      expect(r.sandboxed).toBe(false);
      expect(r.notice).toBe("");
    }
  });

  test("does NOT block .env access (YOLO skips sandbox entirely)", async () => {
    const r = await enforceSandboxPolicy({ command: "cat .env", operation: "bash cwd" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wrapped).toBe("cat .env");
      expect(r.sandboxed).toBe(false);
    }
  });

  test("does NOT validate cwd against sandbox roots", async () => {
    const r = await enforceSandboxPolicy({
      command: "ls",
      cwd: "/etc",
      operation: "bash cwd",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.workDir).toBe("/etc");
    }
  });
});

// ── Sandbox enabled but not ready (no bwrap init) ──────────────────────────

describe("enforceSandboxPolicy — sandbox enabled, not ready", () => {
  beforeEach(() => enableSandbox(true));

  test("blocks .env read", async () => {
    const r = await enforceSandboxPolicy({ command: "cat .env", operation: "bash cwd" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(".env");
  });

  test("blocks .env write via redirect", async () => {
    const r = await enforceSandboxPolicy({
      command: "echo FOO=bar > .env.production",
      operation: "bash cwd",
    });
    expect(r.ok).toBe(false);
  });

  test("allows .env.example access", async () => {
    const r = await enforceSandboxPolicy({
      command: "cat .env.example",
      operation: "bash cwd",
    });
    expect(r.ok).toBe(true);
  });

  test("rejects cwd outside project root and /tmp", async () => {
    const r = await enforceSandboxPolicy({
      command: "ls",
      cwd: "/etc",
      operation: "bash cwd",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("SANDBOX RESTRICTION");
  });

  test("accepts cwd inside project root", async () => {
    const r = await enforceSandboxPolicy({
      command: "ls",
      cwd: projectRoot,
      operation: "bash cwd",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Not-ready → raw command, sandboxed=false, but notice is set so the
      // agent knows restrictions are in effect.
      expect(r.wrapped).toBe("ls");
      expect(r.sandboxed).toBe(false);
      expect(r.notice).toContain("[SANDBOX MODE]");
      expect(r.notice).toContain(projectRoot);
    }
  });

  test("falls back to project root when cwd omitted", async () => {
    const r = await enforceSandboxPolicy({ command: "pwd", operation: "bash cwd" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workDir).toBe(projectRoot);
  });

  test("env pattern takes precedence over cwd validation failures", async () => {
    // Either error is acceptable — we just need policy to reject, not silently
    // pass. The important thing is `.env` is still caught even with bad cwd.
    const r = await enforceSandboxPolicy({
      command: "cat .env",
      cwd: "/etc",
      operation: "bash cwd",
    });
    expect(r.ok).toBe(false);
  });
});
