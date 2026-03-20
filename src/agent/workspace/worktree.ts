/**
 * Git Worktree Manager for Multi-Agent File Isolation
 *
 * Each agent gets an isolated worktree branch under {projectRoot}/.clawd/worktrees/{agentId}.
 * Same filesystem = git hard-links = near-zero disk overhead.
 *
 * Security: all git commands use execFileSync (array args, no shell injection).
 * Branch naming: clawd/{randomId} — same name locally and on remote.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAuthorConfig } from "../../config-file";

// ============================================================================
// Git Detection
// ============================================================================

export function isGitRepo(path: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: path, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function hasSubmodules(path: string): boolean {
  return existsSync(join(path, ".gitmodules"));
}

export function isGitInstalled(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the git repo has user.name and user.email configured.
 */
export function hasGitUserConfig(cwd: string): boolean {
  try {
    execFileSync("git", ["config", "user.name"], { cwd, stdio: "pipe" });
    execFileSync("git", ["config", "user.email"], { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Branch ID Generation
// ============================================================================

/** Generate a random branch name: clawd/{6-char-hex} */
export function generateBranchName(): string {
  return `clawd/${randomBytes(3).toString("hex")}`;
}

// ============================================================================
// Worktree Lifecycle
// ============================================================================

export interface WorktreeResult {
  path: string;
  branch: string;
}

/**
 * Ensure a .gitignore file contains required entries. Creates the file if missing.
 */
function ensureGitignoreEntries(gitignorePath: string, entries: string[]): void {
  try {
    let content = "";
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf-8");
    }
    const lines = content.split("\n").map((l) => l.trim());
    const missing = entries.filter((e) => !lines.includes(e));
    if (missing.length > 0) {
      const append = (content.length > 0 && !content.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n";
      writeFileSync(gitignorePath, content + append, "utf-8");
    }
  } catch {
    // Best-effort
  }
}

/**
 * Ensure gitignore files are properly set up for the project:
 * 1. {projectRoot}/.gitignore — includes .clawd/ (created if missing)
 * 2. {projectRoot}/.clawd/.gitignore — includes files/ and worktrees/
 */
export function ensureClawdGitignore(projectRoot: string): void {
  try {
    // Project root .gitignore — ensure .clawd/ is ignored
    ensureGitignoreEntries(join(projectRoot, ".gitignore"), [".clawd/"]);

    // .clawd/.gitignore — ensure files/ and worktrees/ are ignored
    const clawdDir = join(projectRoot, ".clawd");
    mkdirSync(clawdDir, { recursive: true });
    ensureGitignoreEntries(join(clawdDir, ".gitignore"), ["files/", "worktrees/"]);
  } catch {
    // Best-effort — don't block worktree creation
  }
}

/**
 * Get the worktree base directory for a project.
 * Worktrees are stored at {projectRoot}/.clawd/worktrees/
 */
export function getWorktreeBase(projectRoot: string): string {
  return join(projectRoot, ".clawd", "worktrees");
}

/**
 * Create a git worktree for an agent.
 * Returns { path, branch } on success.
 * Throws if project is not a git repo or git is not installed.
 */
export async function createWorktree(projectPath: string, agentId: string): Promise<WorktreeResult> {
  if (!isGitRepo(projectPath)) {
    throw new Error(`Not a git repository: ${projectPath}`);
  }

  const base = getWorktreeBase(projectPath);
  mkdirSync(base, { recursive: true });
  ensureClawdGitignore(projectPath);
  const worktreePath = join(base, agentId);

  // Reuse existing worktree if it's still valid (preserves uncommitted work across restarts)
  if (existsSync(worktreePath)) {
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
      if (branch) {
        console.log(`[Worktree] Reusing existing worktree: ${worktreePath} (branch: ${branch})`);
        return { path: worktreePath, branch };
      }
    } catch {
      // Invalid worktree — remove and recreate
      console.log(`[Worktree] Existing worktree invalid, recreating: ${worktreePath}`);
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: projectPath, stdio: "pipe" });
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }
  }

  const branchName = generateBranchName();

  // Create worktree on a new branch
  execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath], { cwd: projectPath, stdio: "pipe" });

  // Initialize submodules in the new worktree — roll back on failure
  if (hasSubmodules(projectPath)) {
    try {
      execFileSync("git", ["submodule", "update", "--init", "--recursive"], {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 300_000, // 5 min timeout for large submodules
      });
    } catch (subErr: any) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: projectPath, stdio: "pipe" });
      } catch {}
      throw new Error(`Submodule init failed (worktree rolled back): ${subErr.message}`);
    }
  }

  // Install dependencies in the worktree (best-effort, non-blocking)
  installWorktreeDeps(worktreePath).catch((err) => {
    console.warn(`[Worktree] Dependency install failed for ${worktreePath}:`, err.message);
  });

  return { path: worktreePath, branch: branchName };
}

/**
 * Detect package manager and install dependencies in a worktree.
 * Runs async, non-blocking. Best-effort — failure is logged but not fatal.
 */
async function installWorktreeDeps(worktreePath: string): Promise<void> {
  const { spawn } = await import("node:child_process");

  const run = (cmd: string, args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { cwd: worktreePath, stdio: "pipe", timeout: 300_000 });
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
      proc.on("error", reject);
    });

  if (existsSync(join(worktreePath, "bun.lockb"))) {
    await run("bun", ["install", "--frozen-lockfile"]);
  } else if (existsSync(join(worktreePath, "package-lock.json"))) {
    await run("npm", ["ci"]);
  } else if (existsSync(join(worktreePath, "yarn.lock"))) {
    await run("yarn", ["install", "--frozen-lockfile"]);
  } else if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) {
    await run("pnpm", ["install", "--frozen-lockfile"]);
  }
  // No lockfile detected — skip (static project, no deps)
}

/**
 * Safely delete a worktree. Checks for uncommitted changes first.
 * @param worktreePath - Path to the worktree directory
 * @param projectRoot - Original project root (for safety validation)
 */
export async function safeDeleteWorktree(
  worktreePath: string,
  projectRoot: string,
): Promise<{ deleted: boolean; reason?: string }> {
  const expectedBase = getWorktreeBase(projectRoot);
  if (!worktreePath.startsWith(expectedBase + "/") && worktreePath !== expectedBase) {
    throw new Error(`Safety check: worktreePath must be under ${expectedBase}`);
  }

  if (!existsSync(worktreePath)) {
    return { deleted: true };
  }

  // Check for uncommitted changes
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    if (status.length > 0) {
      return { deleted: false, reason: "has_uncommitted_changes" };
    }
  } catch {
    // If git status fails, force-remove
  }

  // Clean worktree — remove it
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const repoRoot = gitDir.replace("/.git", "").replace(/\/\.git\/worktrees.*/, "");

    if (repoRoot && existsSync(repoRoot)) {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot, stdio: "pipe" });
      return { deleted: true };
    }
  } catch {}

  // Fallback: just delete the directory
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
  return { deleted: true };
}

/**
 * List all worktrees for a project.
 */
export async function listWorktrees(
  projectPath: string,
): Promise<Array<{ path: string; branch: string; head: string }>> {
  if (!isGitRepo(projectPath)) return [];

  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
    const worktrees: Array<{ path: string; branch: string; head: string }> = [];
    let current: Partial<{ path: string; branch: string; head: string }> = {};

    for (const line of out.trim().split("\n")) {
      if (line.startsWith("worktree ")) current.path = line.slice(9);
      else if (line.startsWith("HEAD ")) current.head = line.slice(5);
      else if (line.startsWith("branch ")) current.branch = line.slice(7).replace("refs/heads/", "");
      else if (line === "") {
        if (current.path)
          worktrees.push({ path: current.path, branch: current.branch || "", head: current.head || "" });
        current = {};
      }
    }
    // Handle last entry (no trailing blank line)
    if (current.path) worktrees.push({ path: current.path, branch: current.branch || "", head: current.head || "" });
    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Prune stale worktree entries (e.g., after crash recovery).
 */
export function pruneWorktrees(projectPath: string): void {
  if (!isGitRepo(projectPath)) return;
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: projectPath, stdio: "pipe" });
  } catch {}
}

// ============================================================================
// Worktree Status & Diff
// ============================================================================

export interface WorktreeStatus {
  branch: string;
  clean: boolean;
  ahead: number;
  behind: number;
  hasConflicts: boolean;
  mergeInProgress: boolean;
  files: {
    staged: string[];
    modified: string[];
    untracked: string[];
    deleted: string[];
    conflicted: string[];
  };
}

/**
 * Unquote a git path that may be surrounded by quotes with octal escape sequences.
 * Git quotes paths containing non-ASCII characters: "path/\303\251file" → path/éfile
 * Octal sequences are UTF-8 bytes that must be decoded together.
 */
function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  // Collect segments: plain text and octal byte sequences
  const bytes: number[] = [];
  const result: string[] = [];
  let i = 0;

  const flushBytes = () => {
    if (bytes.length > 0) {
      result.push(Buffer.from(bytes).toString("utf-8"));
      bytes.length = 0;
    }
  };

  while (i < inner.length) {
    if (inner[i] === "\\" && i + 3 < inner.length && /^[0-7]{3}$/.test(inner.slice(i + 1, i + 4))) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 4;
    } else if (inner[i] === "\\" && i + 1 < inner.length) {
      flushBytes();
      result.push(inner[i + 1] === "n" ? "\n" : inner[i + 1] === "t" ? "\t" : inner[i + 1]);
      i += 2;
    } else {
      flushBytes();
      result.push(inner[i]);
      i++;
    }
  }
  flushBytes();
  return result.join("");
}

/**
 * Get the status of a worktree (staged, unstaged, untracked files).
 */
export function getWorktreeStatus(worktreePath: string): WorktreeStatus {
  const branch = getCurrentBranch(worktreePath);
  const files = {
    staged: [] as string[],
    modified: [] as string[],
    untracked: [] as string[],
    deleted: [] as string[],
    conflicted: [] as string[],
  };

  try {
    // --untracked-files=all: individual files inside untracked dirs
    // --ignore-submodules=none: include submodule changes
    const status = execFileSync(
      "git",
      ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=none"],
      {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: "pipe",
      },
    );

    let ahead = 0;
    let behind = 0;

    for (const line of status.split("\n")) {
      if (line.startsWith("# branch.ab")) {
        const match = line.match(/\+(\d+) -(\d+)/);
        if (match) {
          ahead = parseInt(match[1]);
          behind = parseInt(match[2]);
        }
      } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
        // Porcelain v2 changed entry:
        // Type 1: "1 XY sub mH mI mW hH hI path"
        // Type 2: "2 XY sub mH mI mW hH hI X-score path\torigPath"
        const parts = line.split("\t")[0].split(" ");
        const xy = parts[1]; // XY status
        const sub = parts[2]; // submodule indicator (N... or S...)
        const isSubmodule = sub.startsWith("S");

        // Path is always the last field (after tab split for renames)
        const rawPath = line.startsWith("2 ") ? line.split("\t")[0].split(" ").pop()! : line.split(" ").pop()!;
        const path = unquoteGitPath(rawPath);

        if (isSubmodule) {
          // For submodules, get the changed files INSIDE the submodule
          const subPath = join(worktreePath, path);
          if (existsSync(subPath)) {
            try {
              const subStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
                cwd: subPath,
                encoding: "utf-8",
                stdio: "pipe",
              }).trim();
              if (subStatus) {
                for (const subLine of subStatus.split("\n")) {
                  if (!subLine.trim()) continue;
                  const subXY = subLine.slice(0, 2);
                  const subFile = unquoteGitPath(subLine.slice(3));
                  const fullPath = `${path}/${subFile}`;
                  if (subXY[0] !== " " && subXY[0] !== "?") files.staged.push(fullPath);
                  if (subXY[1] === "M" || subXY[1] === "A") files.modified.push(fullPath);
                  else if (subXY[1] === "D") files.deleted.push(fullPath);
                  else if (subXY === "??") files.untracked.push(fullPath);
                }
              } else {
                // Submodule commit changed but no file changes inside — show as modified entry
                files.modified.push(path);
              }
            } catch {
              // Can't read submodule status — show the submodule itself
              files.modified.push(path);
            }
          } else {
            files.modified.push(path);
          }
        } else {
          if (xy[0] !== ".") files.staged.push(path);
          if (xy[1] === "M") files.modified.push(path);
          else if (xy[1] === "D") files.deleted.push(path);
        }
      } else if (line.startsWith("u ")) {
        // Unmerged (conflict)
        const path = unquoteGitPath(line.split(" ").pop()!);
        files.conflicted.push(path);
      } else if (line.startsWith("? ")) {
        files.untracked.push(unquoteGitPath(line.slice(2)));
      }
    }

    const mergeInProgress =
      existsSync(join(worktreePath, ".git", "MERGE_HEAD")) || existsSync(join(worktreePath, "MERGE_HEAD")); // worktree .git may be a file

    return {
      branch,
      clean:
        files.staged.length === 0 &&
        files.modified.length === 0 &&
        files.untracked.length === 0 &&
        files.deleted.length === 0 &&
        files.conflicted.length === 0,
      ahead,
      behind,
      hasConflicts: files.conflicted.length > 0,
      mergeInProgress,
      files,
    };
  } catch {
    return { branch, clean: true, ahead: 0, behind: 0, hasConflicts: false, mergeInProgress: false, files };
  }
}

/**
 * Get the current branch name of a worktree.
 */
export function getCurrentBranch(worktreePath: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return "(detached)";
  }
}

// ============================================================================
// Diff Parsing & Hunk Operations
// ============================================================================

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{ type: "context" | "addition" | "deletion"; content: string; oldNo?: number; newNo?: number }>;
  hash: string; // SHA1 of raw hunk text for identification
}

export interface FileDiff {
  path: string;
  status: "A" | "M" | "D" | "R";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

/**
 * Detect if a file path is inside a git submodule. Returns { submoduleRoot, relativePath }
 * or null if not a submodule path.
 */
function resolveSubmodulePath(worktreePath: string, filePath: string): { cwd: string; relativePath: string } | null {
  // Check if any prefix of the path is a submodule (has .git file/dir inside worktreePath)
  const parts = filePath.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const subPath = join(worktreePath, prefix);
    const gitMarker = join(subPath, ".git");
    if (existsSync(gitMarker)) {
      return { cwd: subPath, relativePath: parts.slice(i).join("/") };
    }
  }
  return null;
}

/**
 * Get the unified diff for a specific file in a worktree.
 * Automatically detects submodule files and runs diff inside the submodule.
 * @param source - "unstaged" (working tree vs index) or "staged" (index vs HEAD)
 */
export function getFileDiff(
  worktreePath: string,
  filePath: string,
  source: "unstaged" | "staged" = "unstaged",
): FileDiff | null {
  // Check if file is inside a submodule
  const sub = resolveSubmodulePath(worktreePath, filePath);
  const cwd = sub ? sub.cwd : worktreePath;
  const diffPath = sub ? sub.relativePath : filePath;

  const args = source === "staged" ? ["diff", "--cached", "-U3", "--", diffPath] : ["diff", "-U3", "--", diffPath];

  try {
    const raw = execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
    if (!raw.trim()) return null;
    const diffs = parseDiffOutput(raw);
    if (diffs[0]) {
      // Restore the full path (including submodule prefix) for UI display
      diffs[0].path = filePath;
    }
    return diffs[0] || null;
  } catch {
    return null;
  }
}

/**
 * Get diffs for all changed files in a worktree.
 */
export function getAllDiffs(worktreePath: string, source: "unstaged" | "staged" = "unstaged"): FileDiff[] {
  const args =
    source === "staged"
      ? ["diff", "--cached", "-U3", "--ignore-submodules=none", "--submodule=diff"]
      : ["diff", "-U3", "--ignore-submodules=none", "--submodule=diff"];

  try {
    const raw = execFileSync("git", args, { cwd: worktreePath, encoding: "utf-8", stdio: "pipe" });
    if (!raw.trim()) return [];
    return parseDiffOutput(raw);
  } catch {
    return [];
  }
}

/**
 * Resolve the correct git working directory and relative path for a file.
 * Handles submodule files transparently.
 */
export function resolveGitPath(worktreePath: string, filePath: string): { cwd: string; relativePath: string } {
  const sub = resolveSubmodulePath(worktreePath, filePath);
  return sub || { cwd: worktreePath, relativePath: filePath };
}

/**
 * Parse unified diff output into structured FileDiff objects.
 */
function parseDiffOutput(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");
    // Extract file path from first line: "a/path b/path"
    const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;

    const filePath = headerMatch[2];
    const binary = section.includes("Binary files");
    if (binary) {
      files.push({ path: filePath, status: "M", binary: true, additions: 0, deletions: 0, hunks: [] });
      continue;
    }

    // Detect status
    let status: "A" | "M" | "D" | "R" = "M";
    if (section.includes("new file mode")) status = "A";
    else if (section.includes("deleted file mode")) status = "D";
    else if (section.includes("rename from")) status = "R";

    // Parse hunks
    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;

    const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
    let currentHunk: DiffHunk | null = null;
    let hunkRawLines: string[] = [];
    let oldNo = 0;
    let newNo = 0;

    for (const line of lines) {
      const hunkMatch = line.match(hunkRegex);
      if (hunkMatch) {
        // Save previous hunk
        if (currentHunk) {
          currentHunk.hash = createHash("sha1").update(hunkRawLines.join("\n")).digest("hex");
          hunks.push(currentHunk);
        }
        oldNo = parseInt(hunkMatch[1]);
        newNo = parseInt(hunkMatch[3]);
        currentHunk = {
          header: line,
          oldStart: oldNo,
          oldLines: parseInt(hunkMatch[2] || "1"),
          newStart: newNo,
          newLines: parseInt(hunkMatch[4] || "1"),
          lines: [],
          hash: "",
        };
        hunkRawLines = [line];
      } else if (currentHunk) {
        hunkRawLines.push(line);
        if (line.startsWith("+")) {
          currentHunk.lines.push({ type: "addition", content: line.slice(1), newNo: newNo++ });
          additions++;
        } else if (line.startsWith("-")) {
          currentHunk.lines.push({ type: "deletion", content: line.slice(1), oldNo: oldNo++ });
          deletions++;
        } else if (line.startsWith(" ")) {
          currentHunk.lines.push({ type: "context", content: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        }
      }
    }
    // Save last hunk
    if (currentHunk) {
      currentHunk.hash = createHash("sha1").update(hunkRawLines.join("\n")).digest("hex");
      hunks.push(currentHunk);
    }

    files.push({ path: filePath, status, binary, additions, deletions, hunks });
  }

  return files;
}

// ============================================================================
// Selective Hunk Staging
// ============================================================================

/**
 * Find a hunk by its content hash in a file's diff.
 * @returns The matching hunk, or null if not found (diff changed since UI render).
 */
function findHunkByHash(
  worktreePath: string,
  filePath: string,
  hunkHash: string,
  source: "unstaged" | "staged",
): { hunk: DiffHunk; fileDiff: FileDiff } | null {
  const diff = getFileDiff(worktreePath, filePath, source);
  if (!diff) return null;
  const hunk = diff.hunks.find((h) => h.hash === hunkHash);
  if (!hunk) return null;
  return { hunk, fileDiff: diff };
}

/**
 * Reconstruct a minimal patch for a single hunk.
 */
function buildHunkPatch(filePath: string, hunk: DiffHunk, fileDiff: FileDiff): string {
  const isNew = fileDiff.status === "A";
  const isDel = fileDiff.status === "D";
  const a = isNew ? "/dev/null" : `a/${filePath}`;
  const b = isDel ? "/dev/null" : `b/${filePath}`;

  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- ${a}`,
    `+++ ${b}`,
    hunk.header,
    ...hunk.lines.map((l) => {
      if (l.type === "addition") return `+${l.content}`;
      if (l.type === "deletion") return `-${l.content}`;
      return ` ${l.content}`;
    }),
  ];
  return lines.join("\n") + "\n";
}

/**
 * Stage a single hunk (selective accept).
 * Identified by content hash — returns 409-equivalent if hash doesn't match.
 */
export function stageHunk(
  worktreePath: string,
  filePath: string,
  hunkHash: string,
): { ok: boolean; error?: string; remainingHunks?: number } {
  const result = findHunkByHash(worktreePath, filePath, hunkHash, "unstaged");
  if (!result) {
    return { ok: false, error: "hunk_not_found" };
  }

  const { cwd, relativePath } = resolveGitPath(worktreePath, filePath);
  const patch = buildHunkPatch(relativePath, result.hunk, result.fileDiff);
  try {
    execFileSync("git", ["apply", "--cached", "--unidiff-zero"], {
      cwd,
      input: patch,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Count remaining unstaged hunks
    const remaining = getFileDiff(worktreePath, filePath, "unstaged");
    return { ok: true, remainingHunks: remaining?.hunks.length ?? 0 };
  } catch (err: any) {
    return { ok: false, error: `apply_failed: ${err.message}` };
  }
}

/**
 * Revert (discard) a single hunk from working tree.
 */
export function revertHunk(
  worktreePath: string,
  filePath: string,
  hunkHash: string,
): { ok: boolean; error?: string; remainingHunks?: number } {
  const result = findHunkByHash(worktreePath, filePath, hunkHash, "unstaged");
  if (!result) {
    return { ok: false, error: "hunk_not_found" };
  }

  const { cwd, relativePath } = resolveGitPath(worktreePath, filePath);
  const patch = buildHunkPatch(relativePath, result.hunk, result.fileDiff);
  try {
    execFileSync("git", ["apply", "-R", "--unidiff-zero"], {
      cwd,
      input: patch,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const remaining = getFileDiff(worktreePath, filePath, "unstaged");
    return { ok: true, remainingHunks: remaining?.hunks.length ?? 0 };
  } catch (err: any) {
    return { ok: false, error: `apply_failed: ${err.message}` };
  }
}

/**
 * Unstage a single hunk (move from index back to working tree).
 * Uses diff of HEAD vs index (--cached).
 */
export function unstageHunk(
  worktreePath: string,
  filePath: string,
  hunkHash: string,
): { ok: boolean; error?: string; remainingHunks?: number } {
  const result = findHunkByHash(worktreePath, filePath, hunkHash, "staged");
  if (!result) {
    return { ok: false, error: "hunk_not_found" };
  }

  const { cwd, relativePath } = resolveGitPath(worktreePath, filePath);
  const patch = buildHunkPatch(relativePath, result.hunk, result.fileDiff);
  try {
    execFileSync("git", ["apply", "-R", "--cached", "--unidiff-zero"], {
      cwd,
      input: patch,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const remaining = getFileDiff(worktreePath, filePath, "staged");
    return { ok: true, remainingHunks: remaining?.hunks.length ?? 0 };
  } catch (err: any) {
    return { ok: false, error: `apply_failed: ${err.message}` };
  }
}

// ============================================================================
// Commit Helpers
// ============================================================================

/**
 * Build git commit args with correct author handling.
 * Priority:
 * 1. Git local config exists → main author. config.author → Co-Authored-By trailer via interpret-trailers.
 * 2. No git local config → config.author as main author via -c flags.
 * 3. Neither → throw error.
 */
export function buildCommitMessage(worktreePath: string, message: string): { args: string[]; message: string } {
  const author = getAuthorConfig();
  const hasLocal = hasGitUserConfig(worktreePath);

  if (hasLocal && author) {
    // Use git interpret-trailers to safely append Co-Authored-By
    try {
      const processed = execFileSync(
        "git",
        ["interpret-trailers", "--trailer", `Co-Authored-By: ${author.name} <${author.email}>`],
        {
          cwd: worktreePath,
          input: message,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ).trim();
      return { args: ["commit", "-m", processed], message: processed };
    } catch {
      // Fallback: simple append
      const processed = `${message}\n\nCo-Authored-By: ${author.name} <${author.email}>`;
      return { args: ["commit", "-m", processed], message: processed };
    }
  }

  if (!hasLocal && author) {
    return {
      args: ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message],
      message,
    };
  }

  if (hasLocal) {
    return { args: ["commit", "-m", message], message };
  }

  throw new Error('No author configured: set git user.name/email or add "author" to ~/.clawd/config.json');
}
