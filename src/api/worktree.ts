/**
 * Worktree API — Git worktree management endpoints for the Worktree dialog.
 *
 * Read endpoints:
 *   GET /api/app.worktree.enabled   — Is worktree enabled for this channel?
 *   GET /api/app.worktree.status    — Worktree info for all agents in channel
 *   GET /api/app.worktree.diff      — Unified diff for a specific agent's file
 *   GET /api/app.worktree.log       — Commit log for agent's worktree branch
 *
 * Write endpoints:
 *   POST /api/app.worktree.stage, unstage, discard, commit, merge,
 *        resolve, abort, apply, stash, stash_pop, push,
 *        stage_hunk, revert_hunk, unstage_hunk
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildCommitMessage,
  type FileDiff,
  getAllDiffs,
  getCurrentBranch,
  getFileDiff,
  getWorktreeStatus,
  resolveGitPath,
  revertHunk,
  stageHunk,
  unstageHunk,
} from "../agent/workspace/worktree";
import { isWorktreeEnabled } from "../config-file";
import type { WorkerManager } from "../worker-manager";

// ============================================================================
// Helpers
// ============================================================================

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Validate a file path is within the worktree (prevents traversal) */
function validateWorktreePath(filePath: string, worktreeRoot: string): string | null {
  if (!filePath || filePath.includes("\0")) return null;
  const resolved = resolve(worktreeRoot, filePath);
  if (!resolved.startsWith(worktreeRoot + "/") && resolved !== worktreeRoot) return null;
  // Block .git internals
  if (resolved.includes("/.git/") || resolved.endsWith("/.git")) return null;
  return resolved;
}

/** Simple per-worktree mutex to prevent concurrent write operations */
const worktreeLocks = new Map<string, Promise<void>>();

async function withWorktreeLock<T>(worktreePath: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any existing lock
  const existing = worktreeLocks.get(worktreePath);
  if (existing) {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("worktree_busy")), 30_000));
    try {
      await Promise.race([existing, timeout]);
    } catch (err: any) {
      if (err.message === "worktree_busy") {
        throw err;
      }
    }
  }

  // Create new lock
  let unlock: () => void;
  const lock = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  worktreeLocks.set(worktreePath, lock);

  try {
    return await fn();
  } finally {
    unlock!();
    if (worktreeLocks.get(worktreePath) === lock) {
      worktreeLocks.delete(worktreePath);
    }
  }
}

/** Helper to get git-capable agent info (worktree or direct repo) */
function getGitInfoOrError(
  workerManager: WorkerManager,
  channel: string,
  agentId: string,
): { path: string; branch: string; originalRoot: string } | Response {
  // First try worktree
  const wtInfo = workerManager.getAgentWorktreeInfo(channel, agentId);
  if (wtInfo) {
    if (!existsSync(wtInfo.path)) {
      return json({ ok: false, error: "worktree_missing", message: "Worktree directory does not exist" }, 404);
    }
    return wtInfo;
  }

  // Fallback: check if agent has a git repo as project root
  const allGit = workerManager.getChannelGitInfo(channel);
  const agentGit = allGit.find((a) => a.agentId === agentId);
  if (agentGit && existsSync(agentGit.path)) {
    return { path: agentGit.path, branch: agentGit.branch, originalRoot: agentGit.originalRoot };
  }

  return json({ ok: false, error: "no_git", message: "Agent has no git repository" }, 404);
}

// ============================================================================
// Route Registration
// ============================================================================

export function registerWorktreeRoutes(
  workerManager: WorkerManager,
): (req: Request, url: URL, path: string) => Response | Promise<Response> | null {
  return (req: Request, url: URL, path: string): Response | Promise<Response> | null => {
    // ========================================================================
    // GET /api/app.worktree.enabled
    // ========================================================================
    if (path === "/api/app.worktree.enabled" && req.method === "GET") {
      const channel = url.searchParams.get("channel") || "";
      // Dialog available if worktree is enabled OR any agent in channel has a git repo
      const worktreeOn = isWorktreeEnabled(channel);
      const hasGitAgents = channel ? workerManager.getChannelGitInfo(channel).length > 0 : false;
      return json({ ok: true, enabled: worktreeOn || hasGitAgents });
    }

    // ========================================================================
    // GET /api/app.worktree.status
    // ========================================================================
    if (path === "/api/app.worktree.status" && req.method === "GET") {
      const channel = url.searchParams.get("channel");
      if (!channel) return json({ ok: false, error: "channel required" }, 400);

      const agents = workerManager.getChannelGitInfo(channel);
      const result = agents.map((a) => {
        const status = getWorktreeStatus(a.path);
        return {
          agent_id: a.agentId,
          branch: status.branch || a.branch,
          base_branch: getBaseBranch(a.path),
          worktree_path: a.path,
          original_project: a.originalRoot,
          clean: status.clean,
          ahead: status.ahead,
          behind: status.behind,
          has_conflicts: status.hasConflicts,
          merge_in_progress: status.mergeInProgress,
          is_worktree: a.isWorktree,
          files: status.files,
        };
      });

      return json({ ok: true, enabled: isWorktreeEnabled(channel), agents: result });
    }

    // ========================================================================
    // GET /api/app.worktree.diff
    // ========================================================================
    if (path === "/api/app.worktree.diff" && req.method === "GET") {
      const channel = url.searchParams.get("channel") || "";
      const agentId = url.searchParams.get("agent_id") || "";
      const file = url.searchParams.get("file");
      const source = (url.searchParams.get("source") || "unstaged") as "unstaged" | "staged";

      const info = getGitInfoOrError(workerManager, channel, agentId);
      if (info instanceof Response) return info;

      let diffs: FileDiff[];
      if (file) {
        const d = getFileDiff(info.path, file, source);
        diffs = d ? [d] : [];
      } else {
        diffs = getAllDiffs(info.path, source);
      }

      const summary = diffs.reduce(
        (acc, d) => ({
          total_files: acc.total_files + 1,
          additions: acc.additions + d.additions,
          deletions: acc.deletions + d.deletions,
        }),
        { total_files: 0, additions: 0, deletions: 0 },
      );

      return json({ ok: true, agent_id: agentId, branch: info.branch, files: diffs, summary });
    }

    // ========================================================================
    // GET /api/app.worktree.log
    // ========================================================================
    if (path === "/api/app.worktree.log" && req.method === "GET") {
      const channel = url.searchParams.get("channel") || "";
      const agentId = url.searchParams.get("agent_id") || "";
      const limit = parseInt(url.searchParams.get("limit") || "20");

      const info = getGitInfoOrError(workerManager, channel, agentId);
      if (info instanceof Response) return info;

      try {
        const baseBranch = getBaseBranch(info.path);
        const range = baseBranch ? `${baseBranch}..HEAD` : "HEAD";
        const raw = execFileSync("git", ["log", range, `--max-count=${limit}`, "--format=%H|%s|%an|%ae|%aI"], {
          cwd: info.path,
          encoding: "utf-8",
          stdio: "pipe",
        }).trim();

        const commits = raw
          ? raw.split("\n").map((line) => {
              const [hash, subject, authorName, authorEmail, date] = line.split("|");
              return { hash, subject, author: { name: authorName, email: authorEmail }, date };
            })
          : [];

        return json({ ok: true, agent_id: agentId, branch: info.branch, commits });
      } catch {
        return json({ ok: true, agent_id: agentId, branch: info.branch, commits: [] });
      }
    }

    // ========================================================================
    // POST endpoints — parse body and dispatch
    // ========================================================================
    if (req.method === "POST" && path.startsWith("/api/app.worktree.")) {
      return handlePostEndpoint(req, path, workerManager);
    }

    return null; // Not our route
  };
}

// ============================================================================
// POST Endpoint Handler
// ============================================================================

async function handlePostEndpoint(req: Request, path: string, workerManager: WorkerManager): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { channel, agent_id } = body;
  if (!channel || !agent_id) return json({ ok: false, error: "channel and agent_id required" }, 400);

  const info = getGitInfoOrError(workerManager, channel, agent_id);
  if (info instanceof Response) return info;
  const wt = info;

  const action = path.replace("/api/app.worktree.", "");

  try {
    switch (action) {
      // ====================================================================
      // stage / unstage / discard
      // ====================================================================
      case "stage": {
        const { paths } = body;
        if (!Array.isArray(paths) || paths.length === 0) return json({ ok: false, error: "paths array required" }, 400);
        for (const p of paths) {
          if (!validateWorktreePath(p, wt.path)) return json({ ok: false, error: `invalid path: ${p}` }, 400);
        }
        return withWorktreeLock(wt.path, async () => {
          // Group paths by their resolved git working directory (handles submodule files)
          const byDir = new Map<string, string[]>();
          for (const p of paths) {
            const { cwd, relativePath } = resolveGitPath(wt.path, p);
            if (!byDir.has(cwd)) byDir.set(cwd, []);
            byDir.get(cwd)!.push(relativePath);
          }
          for (const [cwd, relPaths] of byDir) {
            execFileSync("git", ["add", "--", ...relPaths], { cwd, stdio: "pipe" });
          }
          return json({ ok: true });
        });
      }

      case "unstage": {
        const { paths } = body;
        if (!Array.isArray(paths) || paths.length === 0) return json({ ok: false, error: "paths array required" }, 400);
        for (const p of paths) {
          if (!validateWorktreePath(p, wt.path)) return json({ ok: false, error: `invalid path: ${p}` }, 400);
        }
        return withWorktreeLock(wt.path, async () => {
          // Group paths by their resolved git working directory (handles submodule files)
          const byDir = new Map<string, string[]>();
          for (const p of paths) {
            const { cwd, relativePath } = resolveGitPath(wt.path, p);
            if (!byDir.has(cwd)) byDir.set(cwd, []);
            byDir.get(cwd)!.push(relativePath);
          }
          for (const [cwd, relPaths] of byDir) {
            execFileSync("git", ["restore", "--staged", "--", ...relPaths], { cwd, stdio: "pipe" });
          }
          return json({ ok: true });
        });
      }

      case "discard": {
        const { paths, confirm } = body;
        if (!Array.isArray(paths) || paths.length === 0) return json({ ok: false, error: "paths array required" }, 400);
        if (!confirm) return json({ ok: false, error: "confirm: true required for discard" }, 400);
        for (const p of paths) {
          if (!validateWorktreePath(p, wt.path)) return json({ ok: false, error: `invalid path: ${p}` }, 400);
        }
        return withWorktreeLock(wt.path, async () => {
          // Group paths by their resolved git working directory (handles submodule files)
          const byDir = new Map<string, string[]>();
          for (const p of paths) {
            const { cwd, relativePath } = resolveGitPath(wt.path, p);
            if (!byDir.has(cwd)) byDir.set(cwd, []);
            byDir.get(cwd)!.push(relativePath);
          }
          for (const [cwd, relPaths] of byDir) {
            execFileSync("git", ["checkout", "--", ...relPaths], { cwd, stdio: "pipe" });
          }
          return json({ ok: true });
        });
      }

      // ====================================================================
      // commit
      // ====================================================================
      case "commit": {
        const { message } = body;
        if (!message || typeof message !== "string") return json({ ok: false, error: "message required" }, 400);
        return withWorktreeLock(wt.path, async () => {
          const { args } = buildCommitMessage(wt.path, message);
          execFileSync("git", args, { cwd: wt.path, stdio: "pipe" });
          return json({ ok: true, branch: getCurrentBranch(wt.path) });
        });
      }

      // ====================================================================
      // merge (from another agent's branch)
      // ====================================================================
      case "merge": {
        const { source_agent_id } = body;
        if (!source_agent_id) return json({ ok: false, error: "source_agent_id required" }, 400);
        const sourceInfo = workerManager.getAgentWorktreeInfo(channel, source_agent_id);
        if (!sourceInfo) return json({ ok: false, error: "source agent has no worktree" }, 404);
        return withWorktreeLock(wt.path, async () => {
          try {
            execFileSync("git", ["merge", "--no-edit", sourceInfo.branch], { cwd: wt.path, stdio: "pipe" });
            return json({ ok: true, result: "merged" });
          } catch {
            // Check if conflicts
            const status = getWorktreeStatus(wt.path);
            if (status.hasConflicts) {
              return json({ ok: true, result: "conflicts", conflicts: status.files.conflicted });
            }
            return json({ ok: false, error: "merge_failed" }, 500);
          }
        });
      }

      // ====================================================================
      // resolve (conflict resolution)
      // ====================================================================
      case "resolve": {
        const { path: filePath, resolution } = body;
        if (!filePath || !resolution) return json({ ok: false, error: "path and resolution required" }, 400);
        if (!["ours", "theirs", "both"].includes(resolution))
          return json({ ok: false, error: "resolution must be ours, theirs, or both" }, 400);
        const validated = validateWorktreePath(filePath, wt.path);
        if (!validated) return json({ ok: false, error: "invalid path" }, 400);
        return withWorktreeLock(wt.path, async () => {
          if (resolution === "ours") {
            execFileSync("git", ["checkout", "--ours", "--", filePath], { cwd: wt.path, stdio: "pipe" });
          } else if (resolution === "theirs") {
            execFileSync("git", ["checkout", "--theirs", "--", filePath], { cwd: wt.path, stdio: "pipe" });
          } else {
            // "both" — keep both versions (already in the file as conflict markers, just stage)
          }
          execFileSync("git", ["add", "--", filePath], { cwd: wt.path, stdio: "pipe" });
          return json({ ok: true });
        });
      }

      // ====================================================================
      // abort (merge/rebase)
      // ====================================================================
      case "abort": {
        return withWorktreeLock(wt.path, async () => {
          try {
            execFileSync("git", ["merge", "--abort"], { cwd: wt.path, stdio: "pipe" });
          } catch {
            try {
              execFileSync("git", ["rebase", "--abort"], { cwd: wt.path, stdio: "pipe" });
            } catch {}
          }
          return json({ ok: true });
        });
      }

      // ====================================================================
      // apply (merge worktree branch into base)
      // ====================================================================
      case "apply": {
        const { strategy = "merge" } = body;
        return withWorktreeLock(wt.path, async () => {
          const baseBranch = getBaseBranch(wt.path) || "main";
          const currentBranch = getCurrentBranch(wt.path);

          // Merge is done in the original project root, not the worktree
          try {
            if (strategy === "squash") {
              execFileSync("git", ["merge", "--squash", currentBranch], { cwd: wt.originalRoot, stdio: "pipe" });
              // Squash merge leaves changes staged — auto-commit
              execFileSync("git", ["commit", "--no-edit", "-m", `Squash merge ${currentBranch}`], {
                cwd: wt.originalRoot,
                stdio: "pipe",
              });
            } else {
              execFileSync("git", ["merge", "--no-ff", "--no-edit", currentBranch], {
                cwd: wt.originalRoot,
                stdio: "pipe",
              });
            }
            return json({ ok: true, result: "merged", base_branch: baseBranch });
          } catch {
            return json(
              { ok: false, error: "apply_failed", message: `Failed to merge ${currentBranch} into ${baseBranch}` },
              500,
            );
          }
        });
      }

      // ====================================================================
      // stash / stash_pop
      // ====================================================================
      case "stash": {
        const { message: stashMsg } = body;
        return withWorktreeLock(wt.path, async () => {
          const args = ["stash", "push"];
          if (stashMsg) args.push("-m", stashMsg);
          execFileSync("git", args, { cwd: wt.path, stdio: "pipe" });
          return json({ ok: true });
        });
      }

      case "stash_pop": {
        return withWorktreeLock(wt.path, async () => {
          execFileSync("git", ["stash", "pop"], { cwd: wt.path, stdio: "pipe" });
          return json({ ok: true });
        });
      }

      // ====================================================================
      // push
      // ====================================================================
      case "push": {
        const { remote = "origin" } = body;
        const branch = getCurrentBranch(wt.path);
        return withWorktreeLock(wt.path, async () => {
          try {
            execFileSync("git", ["push", "-u", remote, branch], { cwd: wt.path, stdio: "pipe", timeout: 60_000 });
            return json({ ok: true, branch, remote });
          } catch (err: any) {
            return json({ ok: false, error: "push_failed", message: err.message || "Push failed" });
          }
        });
      }

      // ====================================================================
      // stage_hunk / revert_hunk / unstage_hunk
      // ====================================================================
      case "stage_hunk": {
        const { file, hunk_hash } = body;
        if (!file || !hunk_hash) return json({ ok: false, error: "file and hunk_hash required" }, 400);
        return withWorktreeLock(wt.path, async () => {
          const result = stageHunk(wt.path, file, hunk_hash);
          if (!result.ok && result.error === "hunk_not_found") {
            return json({ ok: false, error: "hunk_not_found", message: "Diff has changed, please refresh" }, 409);
          }
          return json(result, result.ok ? 200 : 500);
        });
      }

      case "revert_hunk": {
        const { file, hunk_hash } = body;
        if (!file || !hunk_hash) return json({ ok: false, error: "file and hunk_hash required" }, 400);
        return withWorktreeLock(wt.path, async () => {
          const result = revertHunk(wt.path, file, hunk_hash);
          if (!result.ok && result.error === "hunk_not_found") {
            return json({ ok: false, error: "hunk_not_found", message: "Diff has changed, please refresh" }, 409);
          }
          return json(result, result.ok ? 200 : 500);
        });
      }

      case "unstage_hunk": {
        const { file, hunk_hash } = body;
        if (!file || !hunk_hash) return json({ ok: false, error: "file and hunk_hash required" }, 400);
        return withWorktreeLock(wt.path, async () => {
          const result = unstageHunk(wt.path, file, hunk_hash);
          if (!result.ok && result.error === "hunk_not_found") {
            return json({ ok: false, error: "hunk_not_found", message: "Diff has changed, please refresh" }, 409);
          }
          return json(result, result.ok ? 200 : 500);
        });
      }

      default:
        return json({ ok: false, error: `unknown action: ${action}` }, 404);
    }
  } catch (err: any) {
    if (err.message === "worktree_busy") {
      return json({ ok: false, error: "worktree_busy", message: "Another git operation is in progress" }, 503);
    }
    console.error(`[worktree.${action}] Error:`, err);
    return json({ ok: false, error: err.message || "Internal error" }, 500);
  }
}

// ============================================================================
// Git Helpers
// ============================================================================

/** Get the base branch (what the worktree branched from) */
function getBaseBranch(worktreePath: string): string {
  try {
    // Try to find the merge base with common branches
    for (const candidate of ["main", "master", "develop"]) {
      try {
        execFileSync("git", ["show-ref", "--verify", `refs/heads/${candidate}`], { cwd: worktreePath, stdio: "pipe" });
        return candidate;
      } catch {}
    }
    return "main"; // Default fallback
  } catch {
    return "main";
  }
}
