/**
 * Git Worktree Manager for Multi-Agent File Isolation
 *
 * Each agent gets an isolated copy of the project:
 * - Git repos: git worktree (lightweight, shared history)
 * - Non-git: rsync copy
 * - Nested submodules: each submodule gets its own worktree init
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function isGitRepo(path: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd: path, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function hasSubmodules(path: string): boolean {
  return existsSync(join(path, '.gitmodules'));
}

const WORKTREE_BASE = join(tmpdir(), 'clawd-ws');

export async function createWorktree(projectPath: string, agentId: string): Promise<string> {
  mkdirSync(WORKTREE_BASE, { recursive: true });
  const worktreePath = join(WORKTREE_BASE, agentId);

  if (isGitRepo(projectPath)) {
    const branchName = `agent-${agentId}-${Date.now()}`;

    // Create worktree on a new branch
    execSync(
      `git worktree add -b '${branchName}' '${worktreePath}'`,
      { cwd: projectPath, stdio: 'pipe' }
    );

    // Initialize submodules in the new worktree — roll back on failure
    if (hasSubmodules(projectPath)) {
      try {
        execSync(
          'git submodule update --init --recursive',
          { cwd: worktreePath, stdio: 'pipe' }
        );
      } catch (subErr: any) {
        // Remove the registered worktree before re-throwing
        try { execSync(`git worktree remove --force '${worktreePath}'`, { cwd: projectPath, stdio: 'pipe' }); } catch {}
        throw new Error(`Submodule init failed (worktree rolled back): ${subErr.message}`);
      }
    }

    return worktreePath;
  } else {
    // Non-git: rsync copy
    mkdirSync(worktreePath, { recursive: true });
    try {
      execSync(
        `rsync -a --exclude='.git' --exclude='node_modules' --exclude='__pycache__' '${projectPath}/' '${worktreePath}/'`,
        { stdio: 'pipe' }
      );
    } catch (err: any) {
      if (err.message.includes('not found') || err.message.includes('No such file') || (err.status === 127)) {
        throw new Error(`rsync is not installed. Install it (e.g. "apt install rsync" or "brew install rsync") or use a git repository for worktree isolation.`);
      }
      throw err;
    }
    return worktreePath;
  }
}

export async function deleteWorktree(worktreePath: string): Promise<void> {
  if (!worktreePath.startsWith(WORKTREE_BASE)) {
    throw new Error(`Safety check: worktreePath must be under ${WORKTREE_BASE}`);
  }

  // Try git worktree remove first
  try {
    // Find the git repo root (parent worktrees)
    const gitDir = execSync('git rev-parse --git-common-dir', { cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe' }).trim();
    const repoRoot = gitDir.replace('/.git', '').replace(/\/\.git\/worktrees.*/, '');

    if (repoRoot && existsSync(repoRoot)) {
      execSync(`git worktree remove --force '${worktreePath}'`, { cwd: repoRoot, stdio: 'pipe' });
      return;
    }
  } catch {}

  // Fallback: just delete the directory
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

export async function listWorktrees(projectPath: string): Promise<Array<{ path: string; branch: string; head: string }>> {
  if (!isGitRepo(projectPath)) return [];

  try {
    const out = execSync('git worktree list --porcelain', { cwd: projectPath, encoding: 'utf-8', stdio: 'pipe' });
    const worktrees: Array<{ path: string; branch: string; head: string }> = [];
    let current: Partial<{ path: string; branch: string; head: string }> = {};

    for (const line of out.trim().split('\n')) {
      if (line.startsWith('worktree ')) current.path = line.slice(9);
      else if (line.startsWith('HEAD ')) current.head = line.slice(5);
      else if (line.startsWith('branch ')) current.branch = line.slice(7);
      else if (line === '') {
        if (current.path) worktrees.push({ path: current.path, branch: current.branch || '', head: current.head || '' });
        current = {};
      }
    }
    return worktrees;
  } catch {
    return [];
  }
}
