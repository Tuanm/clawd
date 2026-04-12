/**
 * Git Tools — git_status, git_diff, git_log, git_branch, git_checkout,
 *             git_add, git_commit, git_push, git_pull, git_fetch,
 *             git_stash, git_reset, git_show
 *
 * Registers git tools into the shared tool registry.
 * All git commands are non-interactive (no GPG signing, no SSH prompts).
 * Uses sandbox on Linux/macOS when available.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { bustReadOnceCache } from "../utils/read-once";
import {
  getAgentContext,
  getSandboxProjectRoot,
  IS_WINDOWS,
  isSandboxReady,
  registerTool,
  runInSandbox,
} from "./registry";

// ============================================================================
// Git Execution Helper
// ============================================================================

/**
 * Execute a git command. Cross-platform, non-interactive.
 * Disables GPG signing, SSH host verification prompts, terminal prompts.
 * Uses sandbox on Linux/macOS, direct spawn on Windows.
 */
function execGitCommand(args: string[], cwd?: string): Promise<{ success: boolean; output: string; error?: string }> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const sshKey = `${home}/.clawd/.ssh/id_ed25519`;
  const gitConfigPath = `${home}/.clawd/.gitconfig`;

  // Non-interactive env vars (all platforms)
  const gitEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: gitConfigPath,
  };

  // SSH config (skip on Windows if no ssh key — git may use credential manager)
  if (!IS_WINDOWS || existsSync(sshKey)) {
    gitEnv.GIT_SSH_COMMAND = `ssh -F /dev/null -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o BatchMode=yes -i ${sshKey}`;
  }

  const fullArgs = ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "--no-pager", ...args];

  // On Linux/macOS with sandbox: run via sandbox for isolation
  if (isSandboxReady()) {
    const escaped = fullArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const gitCmd = `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL='${gitConfigPath}' GIT_SSH_COMMAND='${gitEnv.GIT_SSH_COMMAND || ""}' git ${escaped}`;
    return runInSandbox("bash", ["-c", gitCmd], { cwd, timeout: 30000 }).then((result) => {
      if (result.success) {
        return { success: true, output: result.stdout.trim() };
      }
      const error = result.stderr.includes("TIMEOUT")
        ? "TIMEOUT: Git command exceeded 30s."
        : result.stderr.trim() || `Exit code: ${result.code}`;
      return { success: false, output: result.stdout.trim(), error };
    });
  }

  // Direct spawn (Windows, or Linux/macOS without sandbox)
  return new Promise((res) => {
    const proc = spawn("git", fullArgs, { cwd, timeout: 30000, env: gitEnv });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        res({ success: true, output: stdout.trim() });
      } else {
        res({ success: false, output: stdout.trim(), error: stderr.trim() || `Exit code: ${code}` });
      }
    });
    proc.on("error", (err) => {
      res({ success: false, output: "", error: err.message });
    });
  });
}

// ============================================================================
// Git Tools
// ============================================================================

registerTool(
  "git_status",
  "Show the working tree status (staged, unstaged, untracked files).",
  {
    path: { type: "string", description: "Repository path (default: current directory)" },
  },
  [],
  async ({ path }) => {
    return execGitCommand(["status", "--short"], path);
  },
);

registerTool(
  "git_diff",
  "Show changes between commits, commit and working tree, etc.",
  {
    path: { type: "string", description: "Repository path" },
    staged: { type: "boolean", description: "Show staged changes (--cached)" },
    file: { type: "string", description: "Specific file to diff" },
  },
  [],
  async ({ path, staged, file }) => {
    const args = ["diff"];
    if (staged) args.push("--cached");
    if (file) args.push("--", file);
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_log",
  "Show commit logs.",
  {
    path: { type: "string", description: "Repository path" },
    count: { type: "number", description: "Number of commits to show (default: 10)" },
    oneline: { type: "boolean", description: "Show one line per commit (default: true)" },
    file: { type: "string", description: "Show commits for specific file" },
  },
  [],
  async ({ path, count = 10, oneline = true, file }) => {
    const args = ["log", `-${count}`];
    if (oneline) args.push("--oneline");
    if (file) args.push("--", file);
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_branch",
  "List, create, or delete branches.",
  {
    path: { type: "string", description: "Repository path" },
    name: { type: "string", description: "Branch name to create" },
    delete: { type: "boolean", description: "Delete the branch" },
    all: { type: "boolean", description: "List all branches including remotes" },
  },
  [],
  async ({ path, name, delete: del, all }) => {
    const ctx = getAgentContext();
    if (ctx?.worktreePath && del && name?.startsWith("clawd/")) {
      return {
        success: false,
        output: "",
        error: "Cannot delete clawd/* branches. These are managed by the system.",
      };
    }
    const args = ["branch"];
    if (all) args.push("-a");
    if (name && del) {
      args.push("-d", name);
    } else if (name) {
      args.push(name);
    }
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_checkout",
  "Switch branches or restore working tree files.",
  {
    path: { type: "string", description: "Repository path" },
    target: { type: "string", description: "Branch name, commit, or file to checkout" },
    create: { type: "boolean", description: "Create new branch (-b)" },
  },
  ["target"],
  async ({ path, target, create }) => {
    const ctx = getAgentContext();
    const isWorktree = !!ctx?.worktreePath;

    if (isWorktree) {
      if (create) {
        // Task switch: only allow creating clawd/* branches
        if (!target?.startsWith("clawd/")) {
          return { success: false, output: "", error: "New branches must use the 'clawd/' prefix." };
        }
        // Server generates the random ID — override whatever agent passes
        if (!/^clawd\/[a-f0-9]{1,20}$/.test(target)) {
          const { randomBytes } = await import("node:crypto");
          target = `clawd/${randomBytes(3).toString("hex")}`;
        }
        // Allow: git checkout -b clawd/xxx main
      } else if (target && !target.startsWith("--")) {
        // Block branch switching (not file restore)
        // Use show-ref (precise: only matches branches, not tags/commits)
        try {
          const { execFileSync } = await import("node:child_process");
          const cwd = path || ctx.projectRoot;
          execFileSync("git", ["show-ref", "--verify", `refs/heads/${target}`], { cwd, stdio: "pipe" });
          // It's a branch — block
          return {
            success: false,
            output: "",
            error: "Branch switching is not allowed. Use 'git checkout -- <file>' to restore files.",
          };
        } catch {
          // Not a branch — allow (file restore or commit ref)
        }
      }
    }

    const args = ["checkout"];
    if (create) args.push("-b");
    args.push(target);
    const result = await execGitCommand(args, path);
    // Bust cache for file restores (target starts with "--" like "-- file")
    if (result.success && target?.startsWith("--")) {
      // Extract file paths from the restore operation
      const filePaths = target
        .replace(/^--\s*/, "")
        .split("--")
        .map((p) => p.trim())
        .filter(Boolean);
      for (const fp of filePaths) {
        if (fp)
          try {
            bustReadOnceCache(fp);
          } catch {
            /* best-effort */
          }
      }
    }
    return result;
  },
);

registerTool(
  "git_add",
  "Add file contents to the staging area.",
  {
    path: { type: "string", description: "Repository path" },
    files: { type: "string", description: 'Files to add (space-separated, or "." for all)' },
  },
  ["files"],
  async ({ path, files }) => {
    const args = ["add", ...files.split(/\s+/)];
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_commit",
  "Record changes to the repository.",
  {
    path: { type: "string", description: "Repository path" },
    message: { type: "string", description: "Commit message" },
    all: { type: "boolean", description: "Commit all changed files (-a)" },
  },
  ["message"],
  async ({ path, message, all }) => {
    const ctx = getAgentContext();
    const isWorktree = !!ctx?.worktreePath;

    if (isWorktree && message) {
      // Isolated branch mode: handle author/co-author
      const { getAuthorConfig } = await import("../../config/config-file");
      const { hasGitUserConfig } = await import("../workspace/worktree");
      const cwd = path || ctx.projectRoot;
      const author = getAuthorConfig();
      const hasLocal = hasGitUserConfig(cwd);

      if (hasLocal && author) {
        // Use git interpret-trailers for safe Co-Authored-By injection
        try {
          const { execFileSync } = await import("node:child_process");
          message = execFileSync(
            "git",
            ["interpret-trailers", "--trailer", `Co-Authored-By: ${author.name} <${author.email}>`],
            {
              cwd,
              input: message,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            },
          ).trim();
        } catch {
          // Fallback: simple append
          message = `${message}\n\nCo-Authored-By: ${author.name} <${author.email}>`;
        }
      } else if (!hasLocal && author) {
        // No git config — use config.author as main author
        const args = ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message];
        if (all) args.push("-a");
        return execGitCommand(args, path);
      }
    }

    const args = ["commit", "-m", message];
    if (all) args.push("-a");
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_push",
  "Update remote refs along with associated objects.",
  {
    path: { type: "string", description: "Repository path" },
    remote: { type: "string", description: "Remote name (default: origin)" },
    branch: { type: "string", description: "Branch to push" },
    force: { type: "boolean", description: "Force push (-f)" },
    setUpstream: { type: "boolean", description: "Set upstream (-u)" },
  },
  [],
  async ({ path, remote = "origin", branch, force, setUpstream }) => {
    const ctx = getAgentContext();
    if (ctx?.worktreePath) {
      // Block pushing to protected branches
      const protectedBranches = ["main", "master", "develop", "release"];
      const effectiveBranch = branch || ctx.worktreeBranch || "";
      if (protectedBranches.some((p) => effectiveBranch === p || effectiveBranch.startsWith(`${p}/`))) {
        return {
          success: false,
          output: "",
          error:
            "Cannot push to protected branches (main, master, develop, release). Push your clawd/* branch instead.",
        };
      }
    }
    const args = ["push"];
    if (force) args.push("-f");
    if (setUpstream) args.push("-u");
    args.push(remote);
    if (branch) args.push(branch);
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_pull",
  "Fetch from and integrate with another repository or a local branch.",
  {
    path: { type: "string", description: "Repository path" },
    remote: { type: "string", description: "Remote name (default: origin)" },
    branch: { type: "string", description: "Branch to pull" },
    rebase: { type: "boolean", description: "Rebase instead of merge" },
  },
  [],
  async ({ path, remote, branch, rebase }) => {
    const ctx = getAgentContext();
    if (ctx?.worktreePath) {
      return {
        success: false,
        output: "",
        error: "git_pull is not available. Use git_fetch to download remote updates.",
      };
    }
    const args = ["pull", "--no-edit"];
    if (rebase) args.push("--rebase");
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_fetch",
  "Download objects and refs from another repository.",
  {
    path: { type: "string", description: "Repository path" },
    remote: { type: "string", description: "Remote name (default: all)" },
    prune: { type: "boolean", description: "Prune deleted remote branches" },
  },
  [],
  async ({ path, remote, prune }) => {
    const args = ["fetch"];
    if (prune) args.push("--prune");
    if (remote) {
      args.push(remote);
    } else {
      args.push("--all");
    }
    return execGitCommand(args, path);
  },
);

registerTool(
  "git_stash",
  "Stash the changes in a dirty working directory.",
  {
    path: { type: "string", description: "Repository path" },
    action: { type: "string", description: "Action: push, pop, list, drop, apply (default: push)" },
    message: { type: "string", description: "Stash message (for push)" },
  },
  [],
  async ({ path, action = "push", message }) => {
    const args = ["stash", action];
    if (action === "push" && message) args.push("-m", message);
    const result = await execGitCommand(args, path);
    // Bust cache for stash pop (restores files from stash)
    if (result.success && (action === "pop" || action === "apply")) {
      // Parse output to extract modified files (best-effort)
      const files = result.output.split("\n").filter((l) => l.includes("file:") || l.match(/\.\/[\w\-./]/));
      for (const f of files) {
        const match = f.match(/[./][\w\-./]+/g);
        if (match)
          for (const fp of match)
            try {
              bustReadOnceCache(fp);
            } catch {
              /* best-effort */
            }
      }
    }
    return result;
  },
);

registerTool(
  "git_reset",
  "Reset current HEAD to the specified state.",
  {
    path: { type: "string", description: "Repository path" },
    target: { type: "string", description: "Commit to reset to (default: HEAD)" },
    mode: { type: "string", description: "Reset mode: soft, mixed, hard (default: mixed)" },
    file: { type: "string", description: "File to unstage" },
  },
  [],
  async ({ path, target, mode, file }) => {
    const args = ["reset"];
    if (mode) args.push(`--${mode}`);
    if (target) args.push(target);
    if (file) args.push("--", file);
    const result = await execGitCommand(args, path);
    // Bust cache for file-level reset (unstages files)
    if (result.success) {
      if (file) {
        // Single file reset
        try {
          bustReadOnceCache(file);
        } catch {
          /* best-effort */
        }
      } else if (mode === "hard" || mode === "mixed") {
        // Whole-repo reset modifies many files - bust entire session cache
        try {
          const { clearReadOnceCache } = await import("../utils/read-once");
          const sessionId = getContextSessionId();
          if (sessionId) clearReadOnceCache(sessionId);
        } catch {
          /* best-effort */
        }
      }
    }
    return result;
  },
);

registerTool(
  "git_show",
  "Show various types of objects (commits, tags, etc.).",
  {
    path: { type: "string", description: "Repository path" },
    object: { type: "string", description: "Object to show (commit, tag, etc.)" },
    stat: { type: "boolean", description: "Show diffstat only" },
  },
  [],
  async ({ path, object = "HEAD", stat }) => {
    const args = ["show", object];
    if (stat) args.push("--stat");
    return execGitCommand(args, path);
  },
);
