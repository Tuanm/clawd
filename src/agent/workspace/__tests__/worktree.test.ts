/**
 * Unit tests for git worktree utilities.
 *
 * Mocks all filesystem and git CLI operations to avoid real git/disk dependencies.
 * Covers: create/delete/list worktrees, branch generation, git detection.
 *
 * Phase 0.1c — regression harness BEFORE Phase 2 workspace/worktree rewrite.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module Mocks (hoisted by bun:test before static imports) ──────────────────

const mockExecFileSync = mock((..._args: any[]): any => "");

mock.module("node:child_process", () => ({
  execFileSync: mockExecFileSync,
  spawn: mock(() => ({
    on: mock((_event: string, _cb: any) => {}),
    stderr: { on: mock(() => {}) },
    stdout: { on: mock(() => {}) },
  })),
}));

const mockExistsSync = mock((_path: string): boolean => false);
const mockMkdirSync = mock((_path: string, _opts?: any): string | undefined => undefined);
const mockReadFileSync = mock((_path: string, _enc?: any): any => "");
const mockWriteFileSync = mock((_path: string, _data: any, _enc?: any): void => {});
const mockRmSync = mock((_path: string, _opts?: any): void => {});

mock.module("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  rmSync: mockRmSync,
}));

mock.module("../../../config/config-file", () => ({
  loadConfigFile: mock(() => ({})),
  reloadConfigFile: mock(() => ({})),
  getDataDir: mock(() => "/tmp/clawd-test"),
  getConfigEnv: mock(() => ({})),
  getEnvVar: mock(() => undefined),
  isBrowserEnabled: mock(() => false),
  isBrowserAuthRequired: mock(() => false),
  getAllBrowserTokens: mock(() => null),
  getBrowserTokensForChannel: mock(() => null),
  safeTokenEqual: mock(() => false),
  isAuthEnabled: mock(() => false),
  isChannelAuthRequired: mock(() => false),
  hasGlobalAuth: mock(() => false),
  validateApiToken: mock(() => false),
  isContainerEnv: mock(() => false),
  getAuthToken: mock(() => null),
  getChannelsForToken: mock(() => []),
  isWorktreeEnabled: mock(() => false),
  getAuthorConfig: mock(() => null),
}));

import {
  createWorktree,
  generateBranchName,
  getCurrentBranch,
  getWorktreeBase,
  isGitInstalled,
  isGitRepo,
  listWorktrees,
  pruneWorktrees,
  safeDeleteWorktree,
} from "../worktree";

// ── createWorktree ───────────────────────────────────────────────────────────

describe("createWorktree", () => {
  beforeEach(() => {
    mockExecFileSync.mockClear();
    mockExistsSync.mockClear();
    mockMkdirSync.mockClear();
    mockRmSync.mockClear();
    mockReadFileSync.mockClear();
    mockWriteFileSync.mockClear();
  });

  test("throws when project is not a git repo", async () => {
    // isGitRepo calls execFileSync(git rev-parse --git-dir) — make it throw
    mockExecFileSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });
    await expect(createWorktree("/not/a/repo", "agent-1")).rejects.toThrow("Not a git repository");
  });

  test("reuses existing valid worktree", async () => {
    const projectPath = "/project";
    const agentId = "agent-1";
    const worktreePath = "/project/.clawd/worktrees/agent-1";

    // isGitRepo → succeeds; existsSync for worktreePath → true; rev-parse for branch → returns main
    mockExistsSync.mockImplementation((p: string) => p === worktreePath);
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--git-dir")) return ".git\n";
      if (args.includes("--abbrev-ref")) return "clawd/abc123\n";
      return "";
    });

    const result = await createWorktree(projectPath, agentId);
    expect(result).toEqual({ path: worktreePath, branch: "clawd/abc123" });
    // Should NOT call `git worktree add` — reusing existing
    const calls = (mockExecFileSync as ReturnType<typeof mock>).mock.calls;
    const addCall = calls.find((c: any[]) => c[1]?.includes("add") && c[1]?.includes("worktree"));
    expect(addCall).toBeUndefined();
  });

  test("creates fresh worktree with generated branch name", async () => {
    const projectPath = "/project";
    const agentId = "agent-2";
    const worktreePath = "/project/.clawd/worktrees/agent-2";

    // existsSync: worktreePath does NOT exist → fresh creation path
    mockExistsSync.mockImplementation((_p: string) => false);
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--git-dir")) return ".git\n";
      // git worktree add succeeds silently
      return "";
    });

    const result = await createWorktree(projectPath, agentId);
    expect(result.path).toBe(worktreePath);
    expect(result.branch).toMatch(/^clawd\/[0-9a-f]{6}$/);
    // `git worktree add` must have been called
    const calls = (mockExecFileSync as ReturnType<typeof mock>).mock.calls;
    const addCall = calls.find((c: any[]) => Array.isArray(c[1]) && c[1].includes("add") && c[1].includes("-b"));
    expect(addCall).toBeDefined();
  });

  test("cleans up and recreates when existing worktree is invalid", async () => {
    const projectPath = "/project";
    const agentId = "agent-3";
    const worktreePath = "/project/.clawd/worktrees/agent-3";

    // existsSync for the worktreePath → true (stale worktree present)
    mockExistsSync.mockImplementation((p: string) => p === worktreePath);
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--git-dir")) return ".git\n";
      // --abbrev-ref throws → invalid worktree
      if (args.includes("--abbrev-ref")) throw new Error("invalid worktree");
      // worktree remove succeeds
      return "";
    });

    const result = await createWorktree(projectPath, agentId);
    expect(result.path).toBe(worktreePath);
    expect(result.branch).toMatch(/^clawd\/[0-9a-f]{6}$/);
    // Verify `git worktree add` was still called (fresh creation after cleanup)
    const calls = (mockExecFileSync as ReturnType<typeof mock>).mock.calls;
    const addCall = calls.find((c: any[]) => Array.isArray(c[1]) && c[1].includes("add") && c[1].includes("-b"));
    expect(addCall).toBeDefined();
  });
});

// ── generateBranchName ────────────────────────────────────────────────────────

describe("generateBranchName", () => {
  test("returns string matching clawd/<6-hex-chars>", () => {
    const name = generateBranchName();
    expect(name).toMatch(/^clawd\/[0-9a-f]{6}$/);
  });

  test("each call produces a unique branch name", () => {
    const names = new Set(Array.from({ length: 20 }, () => generateBranchName()));
    // With 20 random 3-byte values the probability of collision is negligible
    expect(names.size).toBe(20);
  });
});

// ── getWorktreeBase ───────────────────────────────────────────────────────────

describe("getWorktreeBase", () => {
  test("returns {projectRoot}/.clawd/worktrees", () => {
    expect(getWorktreeBase("/project/root")).toBe("/project/root/.clawd/worktrees");
  });

  test("works for any project root", () => {
    const base = getWorktreeBase("/home/user/myproject");
    expect(base).toContain(".clawd");
    expect(base).toContain("worktrees");
    expect(base.startsWith("/home/user/myproject")).toBe(true);
  });
});

// ── isGitRepo ─────────────────────────────────────────────────────────────────

describe("isGitRepo", () => {
  beforeEach(() => mockExecFileSync.mockClear());

  test("returns true when git rev-parse succeeds", () => {
    mockExecFileSync.mockImplementation(() => ".git\n");
    expect(isGitRepo("/some/path")).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--git-dir"],
      expect.objectContaining({ cwd: "/some/path" }),
    );
  });

  test("returns false when git rev-parse throws (not a repo)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });
    expect(isGitRepo("/not/a/repo")).toBe(false);
  });
});

// ── isGitInstalled ────────────────────────────────────────────────────────────

describe("isGitInstalled", () => {
  beforeEach(() => mockExecFileSync.mockClear());

  test("returns true when git --version succeeds", () => {
    mockExecFileSync.mockImplementation(() => "git version 2.39.0\n");
    expect(isGitInstalled()).toBe(true);
  });

  test("returns false when git binary is absent", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT: git not found");
    });
    expect(isGitInstalled()).toBe(false);
  });
});

// ── getCurrentBranch ──────────────────────────────────────────────────────────

describe("getCurrentBranch", () => {
  beforeEach(() => mockExecFileSync.mockClear());

  test("returns trimmed branch name on success", () => {
    mockExecFileSync.mockImplementation(() => "main\n");
    expect(getCurrentBranch("/project")).toBe("main");
  });

  test("returns clawd branch name for worktree branches", () => {
    mockExecFileSync.mockImplementation(() => "clawd/a3f7b2\n");
    expect(getCurrentBranch("/project/.clawd/worktrees/agent-1")).toBe("clawd/a3f7b2");
  });

  test("returns '(detached)' when git command throws", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(getCurrentBranch("/project")).toBe("(detached)");
  });
});

// ── listWorktrees ─────────────────────────────────────────────────────────────

describe("listWorktrees", () => {
  beforeEach(() => mockExecFileSync.mockClear());

  test("returns empty array when project is not a git repo", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    const result = await listWorktrees("/not/a/repo");
    expect(result).toEqual([]);
  });

  test("parses git worktree list --porcelain output into structured objects", async () => {
    const porcelain = [
      "worktree /project",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /project/.clawd/worktrees/agent-1",
      "HEAD def456",
      "branch refs/heads/clawd/a1b2c3",
      "",
    ].join("\n");

    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("rev-parse")) return ".git";
      if (args.includes("list")) return porcelain;
      return "";
    });

    const result = await listWorktrees("/project");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ path: "/project", branch: "main", head: "abc123" });
    expect(result[1]).toMatchObject({
      path: "/project/.clawd/worktrees/agent-1",
      branch: "clawd/a1b2c3",
      head: "def456",
    });
  });

  test("strips refs/heads/ prefix from branch names", async () => {
    const porcelain = ["worktree /project", "HEAD aaa111", "branch refs/heads/feature/my-branch", ""].join("\n");

    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("rev-parse")) return ".git";
      if (args.includes("list")) return porcelain;
      return "";
    });

    const result = await listWorktrees("/project");
    expect(result[0].branch).toBe("feature/my-branch");
  });

  test("returns empty array when git worktree list throws", async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse") return ".git";
      throw new Error("git error");
    });
    const result = await listWorktrees("/project");
    expect(result).toEqual([]);
  });
});

// ── safeDeleteWorktree ────────────────────────────────────────────────────────

describe("safeDeleteWorktree", () => {
  const projectRoot = "/project";
  const worktreeBase = "/project/.clawd/worktrees";

  beforeEach(() => {
    mockExecFileSync.mockClear();
    mockExistsSync.mockClear();
    mockRmSync.mockClear();
  });

  test("throws SafetyCheck error when path is outside expected base", async () => {
    await expect(safeDeleteWorktree("/tmp/evil", projectRoot)).rejects.toThrow("Safety check");
  });

  test("returns deleted=true immediately when worktree directory does not exist", async () => {
    mockExistsSync.mockImplementation(() => false);
    const result = await safeDeleteWorktree(`${worktreeBase}/agent-1`, projectRoot);
    expect(result).toEqual({ deleted: true });
  });

  test("returns deleted=false with reason when worktree has uncommitted changes", async () => {
    mockExistsSync.mockImplementation(() => true);
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("status") && args.includes("--porcelain")) {
        return " M src/index.ts\n";
      }
      return "";
    });

    const result = await safeDeleteWorktree(`${worktreeBase}/agent-1`, projectRoot);
    expect(result.deleted).toBe(false);
    expect(result.reason).toBe("has_uncommitted_changes");
  });

  test("calls git worktree remove for clean worktree", async () => {
    mockExistsSync.mockImplementation((p: string) => p.includes(".clawd") || p === projectRoot);
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("status") && args.includes("--porcelain")) return ""; // clean
      if (args.includes("--git-common-dir")) return "/project/.git\n";
      return "";
    });

    const result = await safeDeleteWorktree(`${worktreeBase}/agent-1`, projectRoot);
    expect(result.deleted).toBe(true);
    // Verify git worktree remove was invoked
    const calls = (mockExecFileSync as ReturnType<typeof mock>).mock.calls;
    const removeCall = calls.find((c: any[]) => c[1]?.includes("remove") && c[1]?.includes("worktree"));
    expect(removeCall).toBeDefined();
  });
});

// ── pruneWorktrees ────────────────────────────────────────────────────────────

describe("pruneWorktrees", () => {
  beforeEach(() => mockExecFileSync.mockClear());

  test("calls git worktree prune for a valid git repo", () => {
    mockExecFileSync.mockImplementation(() => ".git");
    pruneWorktrees("/project");
    const calls = (mockExecFileSync as ReturnType<typeof mock>).mock.calls;
    const pruneCall = calls.find((c: any[]) => c[1]?.includes("prune"));
    expect(pruneCall).toBeDefined();
    expect(pruneCall[1]).toEqual(["worktree", "prune"]);
  });

  test("does nothing (no throw) when directory is not a git repo", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not a repo");
    });
    expect(() => pruneWorktrees("/not/a/repo")).not.toThrow();
  });
});
