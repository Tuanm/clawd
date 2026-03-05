/**
 * Agent Management API
 *
 * REST endpoints for managing agents per channel.
 * These are registered on the clawd-chat server alongside existing routes.
 *
 * Endpoints:
 *   GET  /api/app.agents.list?channel=<ch>   - List agents (optionally per channel)
 *   POST /api/app.agents.add                  - Add agent to a channel
 *   POST /api/app.agents.remove               - Remove agent from a channel
 *   POST /api/app.agents.update               - Update agent config (model, active)
 *   GET  /api/app.agents.status               - Get worker loop status for all agents
 *   GET  /api/app.models.list                 - List available AI models
 *   GET  /api/app.providers.list              - List configured providers (built-in + custom)
 *   GET  /api/app.folders.list                - List directories (for folder picker)
 *
 * Project File Browser (read-only):
 *   GET  /api/app.project.tree?channel=<ch>&agent_id=<id>  - Get project directory tree
 *   GET  /api/app.project.listDir?channel=<ch>&agent_id=<id>&path=<p>  - List directory contents
 *   GET  /api/app.project.readFile?channel=<ch>&agent_id=<id>&path=<p> - Read file content
 *
 * Security:
 *   - Path validation prevents traversal attacks (../, absolute paths)
 *   - Paths are validated to be within project root
 *   - Sensitive files are blocked (.env, .git/*, credentials, etc.)
 *   - .gitignore patterns are respected for file listing
 */

import type { Database } from "bun:sqlite";
import type { WorkerManager } from "../worker-manager";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative, isAbsolute, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { listConfiguredProviders, BUILTIN_PROVIDERS } from "../agent/src/api/provider-config";

// ============================================================================
// Security: Sensitive file patterns (blocked from reading)
// ============================================================================

/**
 * Patterns for sensitive files that should NEVER be exposed via the API.
 * These are blocked even if they're tracked in git.
 */
const SENSITIVE_PATTERNS = [
  // Environment and secrets
  /^\.env($|\.)/i, // .env, .env.local, .env.production, etc.
  /^\.secret/i, // .secrets, .secret.json, etc.
  /credentials/i, // Any file with "credentials" in name
  /^\.aws$/, // AWS credentials directory
  /^\.ssh$/, // SSH keys directory
  /^\.gnupg$/, // GPG keys
  /^\.npmrc$/, // npm auth tokens
  /^\.pypirc$/, // PyPI auth tokens
  /^\.netrc$/, // Network credentials
  /^\.docker$/, // Docker config with auth
  /^\.kube$/, // Kubernetes config

  // Private keys
  /\.pem$/i, // SSL/TLS private keys
  /\.key$/i, // Generic key files
  /id_rsa/i, // SSH private keys
  /id_ed25519/i, // SSH ed25519 keys
  /id_ecdsa/i, // SSH ECDSA keys
  /id_dsa/i, // SSH DSA keys

  // Git internals (prevent reading git objects)
  /^\.git\//, // Anything inside .git directory
];

/**
 * Check if a file path matches any sensitive pattern.
 */
function isSensitivePath(relativePath: string): boolean {
  const pathLower = relativePath.toLowerCase();

  // Check each segment of the path
  const segments = relativePath.split("/");
  for (const segment of segments) {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(segment)) {
        return true;
      }
    }
  }

  // Also check the full path for patterns like .git/
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(relativePath)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Security: Path validation (sandbox-style)
// ============================================================================

/**
 * Validate and resolve a relative path within a project root.
 * Returns the full resolved path if valid, or null if invalid.
 *
 * Security checks:
 * 1. Reject paths with ".." traversal
 * 2. Reject absolute paths
 * 3. Resolve symlinks and verify final path is within project root
 * 4. Block sensitive files (credentials, keys, etc.)
 */
function validateProjectPath(
  projectRoot: string,
  relativePath: string,
  options: { allowSensitive?: boolean } = {},
): { valid: true; fullPath: string; relativePath: string } | { valid: false; error: string } {
  // Check for traversal attempts
  if (relativePath.includes("..")) {
    return { valid: false, error: "Path traversal (..) not allowed" };
  }

  // Check for absolute paths
  if (isAbsolute(relativePath)) {
    return { valid: false, error: "Absolute paths not allowed" };
  }

  // Resolve the full path
  const fullPath = resolve(projectRoot, relativePath);

  // Ensure the resolved path is within project root
  const normalizedRoot = resolve(projectRoot);
  if (!fullPath.startsWith(normalizedRoot + "/") && fullPath !== normalizedRoot) {
    return { valid: false, error: "Path outside project root" };
  }

  // Check for sensitive files (unless explicitly allowed)
  if (!options.allowSensitive && isSensitivePath(relativePath)) {
    return { valid: false, error: "Access to sensitive files is not allowed" };
  }

  // Compute the normalized relative path
  const normalizedRelPath = relative(normalizedRoot, fullPath);

  return { valid: true, fullPath, relativePath: normalizedRelPath };
}

// ============================================================================
// Gitignore support
// ============================================================================

/**
 * Cache for gitignore checking per git root (can be project root, submodule, or nested repo)
 */
const gitignoreCache = new Map<string, Set<string>>();

/**
 * Check if a directory is a git repository (has .git file or directory).
 * For submodules, .git is a file pointing to the parent's .git/modules folder.
 */
function isGitRepository(dirPath: string): boolean {
  const gitPath = join(dirPath, ".git");
  return existsSync(gitPath);
}

/**
 * Get the set of git-tracked files for a specific git root.
 * Uses `git ls-files` to get all tracked files, which respects .gitignore.
 * Results are cached per git root.
 */
function getGitTrackedFilesForRoot(gitRoot: string): Set<string> | null {
  // Check cache first
  if (gitignoreCache.has(gitRoot)) {
    return gitignoreCache.get(gitRoot)!;
  }

  try {
    // Get list of tracked files
    const output = execSync("git ls-files", {
      cwd: gitRoot,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const files = new Set(
      output
        .trim()
        .split("\n")
        .filter((f) => f),
    );
    gitignoreCache.set(gitRoot, files);
    return files;
  } catch {
    // Git command failed, return null to fall back to default behavior
    return null;
  }
}

/**
 * Get the set of git-tracked files for a project.
 * Uses `git ls-files` to get all tracked files, which respects .gitignore.
 * Results are cached per project root.
 */
function getGitTrackedFiles(projectRoot: string): Set<string> | null {
  // Check if this is a git repository
  if (!isGitRepository(projectRoot)) {
    return null; // Not a git repo
  }
  return getGitTrackedFilesForRoot(projectRoot);
}

/**
 * Determine the git context for a folder being listed.
 * Returns:
 * - { type: 'git', trackedFiles, gitRoot, prefix } if folder is inside a git repo
 * - { type: 'nested-git', trackedFiles, gitRoot } if folder IS a nested git repo (submodule or separate repo)
 * - { type: 'none' } if not in any git repo
 */
function getGitContextForFolder(
  projectRoot: string,
  folderRelativePath: string,
): {
  type: "git" | "nested-git" | "none";
  trackedFiles: Set<string> | null;
  gitRoot?: string;
  prefix?: string;
} {
  const folderFullPath = folderRelativePath ? join(projectRoot, folderRelativePath) : projectRoot;

  // Check if THIS folder is a git repo (submodule or nested repo)
  if (folderRelativePath && isGitRepository(folderFullPath)) {
    // This folder has its own .git - treat it as a separate repo
    const trackedFiles = getGitTrackedFilesForRoot(folderFullPath);
    return { type: "nested-git", trackedFiles, gitRoot: folderFullPath };
  }

  // Check if project root is a git repo
  if (isGitRepository(projectRoot)) {
    const trackedFiles = getGitTrackedFilesForRoot(projectRoot);
    return { type: "git", trackedFiles, gitRoot: projectRoot, prefix: folderRelativePath };
  }

  // Not in any git repo
  return { type: "none", trackedFiles: null };
}

/**
 * Check if a path should be shown based on git tracking.
 * For directories, checks if any tracked file is inside it.
 * Falls back to default ignore patterns if not a git repo.
 */
function shouldShowInTree(
  projectRoot: string,
  relativePath: string,
  isDirectory: boolean,
  trackedFiles: Set<string> | null,
): boolean {
  // Always hide .git directory itself
  if (relativePath === ".git" || relativePath.startsWith(".git/")) {
    return false;
  }

  // If we have git tracking info
  if (trackedFiles !== null) {
    if (isDirectory) {
      // Show directory if any tracked file is inside it
      const prefix = relativePath + "/";
      for (const file of trackedFiles) {
        if (file.startsWith(prefix) || file === relativePath) {
          return true;
        }
      }
      return false;
    } else {
      // Show file if it's tracked
      return trackedFiles.has(relativePath);
    }
  }

  // Fallback: use default ignore patterns (not a git repo)
  const FALLBACK_IGNORE = [
    "node_modules",
    "dist",
    "build",
    ".env",
    ".clawd",
    "__pycache__",
    ".venv",
    "vendor",
    ".next",
    ".nuxt",
    "coverage",
    ".cache",
    ".turbo",
  ];

  const name = basename(relativePath);
  return !FALLBACK_IGNORE.includes(name);
}

/** Available AI models */
const AVAILABLE_MODELS = [
  {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    description: "Fast and capable",
  },
  {
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5",
    description: "Most intelligent",
  },
  {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    description: "Fastest, lightweight",
  },
];

/** Initialize the channel_agents table in the database */
export function initAgentsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'copilot',
      model TEXT NOT NULL DEFAULT 'default',
      project TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      sleeping INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%s', 'now')),
      UNIQUE(channel, agent_id)
    )
  `);

  // Add project column if table already exists without it
  try {
    db.exec(`ALTER TABLE channel_agents ADD COLUMN project TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists
  }

  // Add provider column if table already exists without it
  try {
    db.exec(`ALTER TABLE channel_agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'copilot'`);
  } catch {
    // Column already exists
  }

  // Add sleeping column if table already exists without it
  try {
    db.exec(`ALTER TABLE channel_agents ADD COLUMN sleeping INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }
}

/** Register agent management API routes */
export function registerAgentRoutes(
  db: Database,
  workerManager: WorkerManager,
): (req: Request, url: URL, path: string, bunServer?: any) => Response | null {
  // Initialize table
  initAgentsTable(db);

  return (req: Request, url: URL, path: string, bunServer?: any): Response | null => {
    // List agents
    if (path === "/api/app.agents.list") {
      const channel = url.searchParams.get("channel");

      let agents: any[];
      if (channel) {
        agents = db
          .query(
            `SELECT ca.*, a.avatar_color FROM channel_agents ca
             LEFT JOIN agents a ON a.id = ca.agent_id AND a.channel = ca.channel
             WHERE ca.channel = ? ORDER BY ca.created_at ASC`,
          )
          .all(channel) as any[];
      } else {
        agents = db
          .query(
            `SELECT ca.*, a.avatar_color FROM channel_agents ca
             LEFT JOIN agents a ON a.id = ca.agent_id AND a.channel = ca.channel
             ORDER BY ca.channel, ca.created_at ASC`,
          )
          .all() as any[];
      }

      // Enrich with running status
      const enriched = agents.map((a: any) => ({
        ...a,
        active: a.active === 1,
        sleeping: a.sleeping === 1,
        running: workerManager.isAgentRunning(a.channel, a.agent_id),
      }));

      return json({ ok: true, agents: enriched });
    }

    // Add agent
    if (path === "/api/app.agents.add" && req.method === "POST") {
      return handleAsync(async () => {
        const body = await parseBody(req);
        const { channel, agent_id, provider, model, project } = body;

        if (!channel || !agent_id) {
          return json({ ok: false, error: "channel and agent_id required" }, 400);
        }

        // Validate provider: accept built-in names and any configured custom providers
        const configuredNames = listConfiguredProviders().map((p) => p.name);
        const allowedProviders = [...(BUILTIN_PROVIDERS as readonly string[]), ...configuredNames];
        const agentProvider = (provider || "copilot").toLowerCase();
        if (!allowedProviders.includes(agentProvider)) {
          return json(
            {
              ok: false,
              error: `Invalid provider: ${provider}. Must be one of: ${allowedProviders.join(", ")}`,
            },
            400,
          );
        }

        // Validate model (must not be empty)
        const agentModel = (model || "default").trim();
        if (!agentModel) {
          return json({ ok: false, error: "model cannot be empty" }, 400);
        }

        const agentProject = project || "";

        try {
          db.run(
            `INSERT INTO channel_agents (channel, agent_id, provider, model, project, active)
             VALUES (?, ?, ?, ?, ?, 1)
             ON CONFLICT(channel, agent_id) DO UPDATE SET
               provider = excluded.provider,
               model = excluded.model,
               project = excluded.project,
               active = 1,
               updated_at = strftime('%s', 'now')`,
            [channel, agent_id, agentProvider, agentModel, agentProject],
          );
        } catch (error) {
          return json({ ok: false, error: String(error) }, 500);
        }

        // Start the worker loop
        await workerManager.startAgent({
          channel,
          agentId: agent_id,
          provider: agentProvider,
          model: agentModel,
          active: true,
          project: agentProject,
        });

        return json({
          ok: true,
          agent: {
            channel,
            agent_id,
            provider: agentProvider,
            model: agentModel,
            project: agentProject,
            active: true,
            running: true,
          },
        });
      });
    }

    // Remove agent
    if (path === "/api/app.agents.remove" && req.method === "POST") {
      return handleAsync(async () => {
        const body = await parseBody(req);
        const { channel, agent_id } = body;

        if (!channel || !agent_id) {
          return json({ ok: false, error: "channel and agent_id required" }, 400);
        }

        // Stop the worker loop
        await workerManager.stopAgent(channel, agent_id);

        // Remove from database
        db.run("DELETE FROM channel_agents WHERE channel = ? AND agent_id = ?", [channel, agent_id]);

        return json({ ok: true, channel, agent_id });
      });
    }

    // Update agent config
    if (path === "/api/app.agents.update" && req.method === "POST") {
      return handleAsync(async () => {
        const body = await parseBody(req);
        const { channel, agent_id, model, active, project, sleeping, provider } = body;

        if (!channel || !agent_id) {
          return json({ ok: false, error: "channel and agent_id required" }, 400);
        }

        // Update database
        const updates: string[] = [];
        const params: any[] = [];

        if (provider !== undefined) {
          const configuredNames = listConfiguredProviders().map((p) => p.name);
          const allowedProviders = [...(BUILTIN_PROVIDERS as readonly string[]), ...configuredNames];
          const agentProvider = String(provider).toLowerCase();
          if (!allowedProviders.includes(agentProvider)) {
            return json(
              {
                ok: false,
                error: `Invalid provider: ${provider}. Must be one of: ${allowedProviders.join(", ")}`,
              },
              400,
            );
          }
          updates.push("provider = ?");
          params.push(agentProvider);
        }
        if (model !== undefined) {
          updates.push("model = ?");
          params.push(model);
        }
        if (project !== undefined) {
          updates.push("project = ?");
          params.push(project);
        }
        if (active !== undefined) {
          updates.push("active = ?");
          params.push(active ? 1 : 0);
        }
        if (sleeping !== undefined) {
          updates.push("sleeping = ?");
          params.push(sleeping ? 1 : 0);
        }

        if (updates.length === 0) {
          return json({ ok: false, error: "nothing to update" }, 400);
        }

        updates.push("updated_at = strftime('%s', 'now')");
        params.push(channel, agent_id);

        db.run(`UPDATE channel_agents SET ${updates.join(", ")} WHERE channel = ? AND agent_id = ?`, params);

        // Get updated record
        const agent = db
          .query("SELECT * FROM channel_agents WHERE channel = ? AND agent_id = ?")
          .get(channel, agent_id) as any;

        if (!agent) {
          return json({ ok: false, error: "agent_not_found" }, 404);
        }

        // Restart worker if model, provider, project changed, or active state changed
        if (model !== undefined || provider !== undefined || active !== undefined || project !== undefined) {
          if (agent.active === 1) {
            await workerManager.restartAgent({
              channel,
              agentId: agent_id,
              provider: agent.provider || "copilot",
              model: agent.model,
              active: true,
              project: agent.project || "",
            });
          } else {
            await workerManager.stopAgent(channel, agent_id);
          }
        }

        // Update sleeping state if changed
        if (sleeping !== undefined) {
          workerManager.setAgentSleeping(channel, agent_id, sleeping === true || sleeping === 1);
        }

        return json({
          ok: true,
          agent: {
            ...agent,
            active: agent.active === 1,
            sleeping: agent.sleeping === 1,
            running: workerManager.isAgentRunning(channel, agent_id),
          },
        });
      });
    }

    // Get worker status
    if (path === "/api/app.agents.status") {
      const status = workerManager.getStatus();
      return json({ ok: true, workers: status });
    }

    // List available models
    if (path === "/api/app.models.list") {
      return json({ ok: true, models: AVAILABLE_MODELS });
    }

    // List configured providers (built-in + custom)
    if (path === "/api/app.providers.list") {
      return json({ ok: true, providers: listConfiguredProviders() });
    }

    // List directories (for folder picker)
    if (path === "/api/app.folders.list") {
      const dir = url.searchParams.get("path") || homedir() || "/";
      try {
        const { readdirSync } = require("node:fs");
        const { join } = require("node:path");
        const entries = readdirSync(dir, { withFileTypes: true });
        const folders = entries
          .filter((e: any) => e.isDirectory() && !e.name.startsWith("."))
          .map((e: any) => ({
            name: e.name,
            path: join(dir, e.name),
          }))
          .sort((a: any, b: any) => a.name.localeCompare(b.name));
        return json({ ok: true, path: dir, folders });
      } catch (error) {
        return json({ ok: false, error: String(error) }, 500);
      }
    }

    // ========================================================================
    // Project File Browser API (read-only)
    // ========================================================================

    // Get project directory tree for an agent
    if (path === "/api/app.project.tree") {
      const channel = url.searchParams.get("channel");
      const agentId = url.searchParams.get("agent_id");

      if (!channel || !agentId) {
        return json({ ok: false, error: "channel and agent_id required" }, 400);
      }

      // Get agent's project root from database
      const agent = db
        .query("SELECT project FROM channel_agents WHERE channel = ? AND agent_id = ?")
        .get(channel, agentId) as { project: string } | null;

      if (!agent || !agent.project) {
        return json({ ok: false, error: "agent not found or no project configured" }, 404);
      }

      const projectRoot = agent.project;

      try {
        interface TreeNode {
          name: string;
          type: "file" | "dir";
          path: string;
          size?: number;
          children?: TreeNode[];
        }

        /**
         * Build tree recursively, handling nested git repos at each level.
         * @param dirPath - Full path to directory
         * @param relativePath - Path relative to projectRoot
         * @param depth - How many levels deep to recurse
         * @param currentGitTrackedFiles - Tracked files from the current git context (null = use fallback)
         * @param gitRelativePath - Path relative to the current git root (for filtering)
         */
        function buildTree(
          dirPath: string,
          relativePath: string,
          depth: number,
          currentGitTrackedFiles: Set<string> | null,
          gitRelativePath: string = "",
        ): TreeNode[] {
          if (depth <= 0) return [];

          try {
            const entries = readdirSync(dirPath, { withFileTypes: true });
            const result: TreeNode[] = [];

            for (const entry of entries) {
              // Path relative to project root (used for response and sensitive check)
              const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
              const fullPath = join(dirPath, entry.name);

              // Path relative to current git root (used for git tracking check)
              const entryGitRelPath = gitRelativePath ? `${gitRelativePath}/${entry.name}` : entry.name;

              // Use gitignore-aware filtering with path relative to git root
              if (!shouldShowInTree(projectRoot, entryGitRelPath, entry.isDirectory(), currentGitTrackedFiles)) {
                continue;
              }

              // Also skip sensitive files in tree view (use project-relative path)
              if (isSensitivePath(relPath)) {
                continue;
              }

              if (entry.isDirectory()) {
                // Check if this directory is a nested git repo (submodule or separate repo)
                let childGitTrackedFiles = currentGitTrackedFiles;
                let childGitRelativePath = entryGitRelPath;

                if (isGitRepository(fullPath)) {
                  // This folder has its own .git - get its tracked files
                  // Reset the git-relative path since we're in a new git root
                  childGitTrackedFiles = getGitTrackedFilesForRoot(fullPath);
                  childGitRelativePath = "";
                }

                // If we can recurse (depth > 1), include children
                // Otherwise, set children to undefined for lazy loading
                result.push({
                  name: entry.name,
                  type: "dir",
                  path: relPath,
                  children:
                    depth > 1
                      ? buildTree(fullPath, relPath, depth - 1, childGitTrackedFiles, childGitRelativePath)
                      : undefined,
                });
              } else if (entry.isFile()) {
                try {
                  const stats = statSync(fullPath);
                  result.push({
                    name: entry.name,
                    type: "file",
                    path: relPath,
                    size: stats.size,
                  });
                } catch {
                  // Skip files we can't stat
                }
              }
            }

            // Sort: directories first, then files, alphabetically
            return result.sort((a, b) => {
              if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          } catch {
            return [];
          }
        }

        // Get initial git tracked files from project root
        const rootGitTrackedFiles = getGitTrackedFiles(projectRoot);
        const tree = buildTree(projectRoot, "", 3, rootGitTrackedFiles, ""); // Max depth of 3 initially
        return json({ ok: true, root: projectRoot, tree });
      } catch (error) {
        return json({ ok: false, error: String(error) }, 500);
      }
    }

    // List directory contents (lazy loading)
    if (path === "/api/app.project.listDir") {
      const channel = url.searchParams.get("channel");
      const agentId = url.searchParams.get("agent_id");
      const relativePath = url.searchParams.get("path") || "";

      if (!channel || !agentId) {
        return json({ ok: false, error: "channel and agent_id required" }, 400);
      }

      // Get agent's project root from database
      const agent = db
        .query("SELECT project FROM channel_agents WHERE channel = ? AND agent_id = ?")
        .get(channel, agentId) as { project: string } | null;

      if (!agent || !agent.project) {
        return json({ ok: false, error: "agent not found or no project configured" }, 404);
      }

      const projectRoot = agent.project;

      // Security: validate path using sandbox-style validation
      const validation = validateProjectPath(projectRoot, relativePath, { allowSensitive: false });
      if (!validation.valid) {
        return json({ ok: false, error: validation.error }, 400);
      }

      const fullPath = validation.fullPath;

      try {
        // Get git context for this specific folder (handles submodules and nested repos)
        const gitContext = getGitContextForFolder(projectRoot, relativePath);

        const entries = readdirSync(fullPath, { withFileTypes: true });
        const result: any[] = [];

        for (const entry of entries) {
          // For nested git repos, the relative path is just the entry name (relative to the nested git root)
          // For regular git repos, use the full relative path from project root
          const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
          const entryPathForFiltering = gitContext.type === "nested-git" ? entry.name : entryRelPath;

          // Use gitignore-aware filtering with the appropriate tracked files
          if (!shouldShowInTree(projectRoot, entryPathForFiltering, entry.isDirectory(), gitContext.trackedFiles)) {
            continue;
          }

          // Skip sensitive files (always check full relative path)
          if (isSensitivePath(entryRelPath)) {
            continue;
          }

          const entryFullPath = join(fullPath, entry.name);

          if (entry.isDirectory()) {
            result.push({
              name: entry.name,
              type: "dir",
              path: entryRelPath,
            });
          } else if (entry.isFile()) {
            try {
              const stats = statSync(entryFullPath);
              result.push({
                name: entry.name,
                type: "file",
                path: entryRelPath,
                size: stats.size,
              });
            } catch {
              // Skip files we can't stat
            }
          }
        }

        // Sort: directories first, then files, alphabetically
        result.sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        return json({ ok: true, path: relativePath, entries: result });
      } catch (error) {
        return json({ ok: false, error: String(error) }, 500);
      }
    }

    // Read file content (read-only)
    if (path === "/api/app.project.readFile") {
      const channel = url.searchParams.get("channel");
      const agentId = url.searchParams.get("agent_id");
      const relativePath = url.searchParams.get("path") || "";

      if (!channel || !agentId) {
        return json({ ok: false, error: "channel and agent_id required" }, 400);
      }

      if (!relativePath) {
        return json({ ok: false, error: "path required" }, 400);
      }

      // Get agent's project root from database
      const agent = db
        .query("SELECT project FROM channel_agents WHERE channel = ? AND agent_id = ?")
        .get(channel, agentId) as { project: string } | null;

      if (!agent || !agent.project) {
        return json({ ok: false, error: "agent not found or no project configured" }, 404);
      }

      const projectRoot = agent.project;

      // Security: validate path using sandbox-style validation (block sensitive files)
      const validation = validateProjectPath(projectRoot, relativePath, { allowSensitive: false });
      if (!validation.valid) {
        return json({ ok: false, error: validation.error }, 400);
      }

      const fullPath = validation.fullPath;

      try {
        const stats = statSync(fullPath);
        const MAX_FILE_SIZE = 500 * 1024; // 500KB limit

        let content: string;
        let truncated = false;

        if (stats.size > MAX_FILE_SIZE) {
          // Read only first 500KB
          const { openSync, readSync, closeSync } = require("node:fs");
          const buffer = Buffer.alloc(MAX_FILE_SIZE);
          const fd = openSync(fullPath, "r");
          readSync(fd, buffer, 0, MAX_FILE_SIZE, 0);
          closeSync(fd);
          content = buffer.toString("utf-8");
          truncated = true;
        } else {
          content = readFileSync(fullPath, "utf-8");
        }

        // Detect language from extension for syntax highlighting
        const ext = relativePath.split(".").pop()?.toLowerCase() || "";
        const languageMap: Record<string, string> = {
          ts: "typescript",
          tsx: "typescript",
          js: "javascript",
          jsx: "javascript",
          json: "json",
          md: "markdown",
          py: "python",
          rs: "rust",
          go: "go",
          rb: "ruby",
          java: "java",
          c: "c",
          cpp: "cpp",
          h: "c",
          hpp: "cpp",
          css: "css",
          scss: "scss",
          html: "html",
          xml: "xml",
          yaml: "yaml",
          yml: "yaml",
          toml: "toml",
          sh: "bash",
          bash: "bash",
          zsh: "bash",
          sql: "sql",
        };

        return json({
          ok: true,
          path: relativePath,
          content,
          size: stats.size,
          truncated,
          language: languageMap[ext] || "plaintext",
        });
      } catch (error) {
        return json({ ok: false, error: String(error) }, 500);
      }
    }

    // Not handled
    return null;
  };
}

// ============================================================================
// Helpers
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function parseBody(req: Request): Promise<Record<string, any>> {
  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return (await req.json()) as Record<string, any>;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    return Object.fromEntries(params);
  }

  return {};
}

/** Handle an async route handler that returns a Response promise */
function handleAsync(fn: () => Promise<Response>): Response {
  // Bun.serve handles promises returned from fetch(), so we can
  // return the promise directly. But for type safety, we wrap.
  return fn() as any;
}
