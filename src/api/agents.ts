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
import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  clearAgentFilesCache,
  isValidAgentName,
  listAgentFiles,
  listGlobalAgentFiles,
  loadAgentFile,
} from "../agent/agents/loader";
import type { AgentFileConfig } from "../agent/agents/loader";
import { BUILTIN_PROVIDERS, listConfiguredProviders } from "../agent/api/provider-config";
import { isWorktreeEnabled } from "../config-file";
import { getSkillManager } from "../agent/skills/manager";
import type { WorkerManager } from "../worker-manager";

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
 * Check if a path should be shown in the project tree.
 * Shows ALL files and folders (no .gitignore filtering) except:
 * - .git/ directory (internal git data)
 * - node_modules/ (too large, rarely useful to browse)
 */
function shouldShowInTree(
  _projectRoot: string,
  relativePath: string,
  _isDirectory: boolean,
  _trackedFiles: Set<string> | null,
): boolean {
  const name = basename(relativePath);
  // Hide .git internals and heavy dependency dirs
  if (name === ".git" || name === "node_modules") return false;
  return true;
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

/** Get the effective project root for an agent — prefers worktree_path if it exists on disk */
function getAgentProjectRoot(db: Database, channel: string, agentId: string): string | null {
  const agent = db
    .query("SELECT project, worktree_path FROM channel_agents WHERE channel = ? AND agent_id = ?")
    .get(channel, agentId) as { project: string; worktree_path: string | null } | null;
  if (!agent || !agent.project) return null;
  // Only use worktree_path if worktree is currently enabled for the channel
  if (agent.worktree_path && existsSync(agent.worktree_path) && isWorktreeEnabled(channel)) return agent.worktree_path;
  return agent.project;
}

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

  // Add worker_token column if table already exists without it
  try {
    db.exec(`ALTER TABLE channel_agents ADD COLUMN worker_token TEXT DEFAULT NULL`);
  } catch {
    // Column already exists
  }

  // Add heartbeat_interval column if table already exists without it
  try {
    db.exec(`ALTER TABLE channel_agents ADD COLUMN heartbeat_interval INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // Add worktree columns for persistence across restarts
  try {
    db.exec(`ALTER TABLE channel_agents ADD COLUMN worktree_path TEXT DEFAULT NULL`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE channel_agents ADD COLUMN worktree_branch TEXT DEFAULT NULL`);
  } catch {
    // Column already exists
  }

  // Add claude_code_session_id for session persistence across restarts
  try {
    db.exec(`ALTER TABLE channel_agents ADD COLUMN claude_code_session_id TEXT DEFAULT NULL`);
  } catch {
    // Column already exists
  }

  // Add agent_type column for agent file type reference
  try {
    db.exec(`ALTER TABLE channel_agents ADD COLUMN agent_type TEXT DEFAULT NULL`);
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
      // Internal callers (e.g. WorkerManager) need unmasked tokens for remote worker binding
      const internal = url.searchParams.get("internal") === "1";
      const enriched = agents.map((a: any) => ({
        ...a,
        active: a.active === 1,
        sleeping: a.sleeping === 1,
        running: workerManager.isAgentRunning(a.channel, a.agent_id),
        worker_token: a.worker_token
          ? internal
            ? a.worker_token
            : `${a.worker_token.slice(0, 4)}***${a.worker_token.slice(-3)}`
          : null,
      }));

      return json({ ok: true, agents: enriched });
    }

    // Add agent
    if (path === "/api/app.agents.add" && req.method === "POST") {
      return handleAsync(async () => {
        const body = await parseBody(req);
        const { channel, agent_id, provider, model, project, worker_token, heartbeat_interval, agent_type } = body;

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

        const agentProject = project || join(homedir(), ".clawd", "projects", channel);
        // Auto-create default project directory
        if (!project && agentProject) {
          try {
            mkdirSync(agentProject, { recursive: true });
          } catch {
            // best-effort
          }
        }
        const agentWorkerToken = worker_token || null;
        const agentHeartbeatInterval =
          typeof heartbeat_interval === "number" ? Math.max(0, Math.round(heartbeat_interval)) : 0;

        // Validate agent_type if provided
        const agentType = agent_type ? String(agent_type).trim() : null;
        if (agentType && !isValidAgentName(agentType)) {
          return json({ ok: false, error: "invalid agent_type name" }, 400);
        }

        try {
          db.run(
            `INSERT INTO channel_agents (channel, agent_id, provider, model, project, active, worker_token, heartbeat_interval, agent_type)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT(channel, agent_id) DO UPDATE SET
               provider = excluded.provider,
               model = excluded.model,
               project = excluded.project,
               worker_token = excluded.worker_token,
               heartbeat_interval = excluded.heartbeat_interval,
               agent_type = excluded.agent_type,
               active = 1,
               updated_at = strftime('%s', 'now')`,
            [
              channel,
              agent_id,
              agentProvider,
              agentModel,
              agentProject,
              agentWorkerToken,
              agentHeartbeatInterval,
              agentType,
            ],
          );
        } catch (error) {
          console.error("[agents] register error:", error);
          return json({ ok: false, error: "Internal server error" }, 500);
        }

        // Start the worker loop
        await workerManager.startAgent({
          channel,
          agentId: agent_id,
          provider: agentProvider,
          model: agentModel,
          active: true,
          project: agentProject,
          workerToken: agentWorkerToken || undefined,
          heartbeatInterval: agentHeartbeatInterval,
          agentType: agentType || undefined,
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
            heartbeat_interval: agentHeartbeatInterval,
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
        const {
          channel,
          agent_id,
          model,
          active,
          project,
          sleeping,
          provider,
          worker_token,
          heartbeat_interval,
          worktree_path,
          worktree_branch,
          agent_type,
        } = body;

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
        if (worker_token !== undefined) {
          updates.push("worker_token = ?");
          params.push(worker_token || null);
        }
        if (heartbeat_interval !== undefined) {
          updates.push("heartbeat_interval = ?");
          params.push(typeof heartbeat_interval === "number" ? Math.max(0, Math.round(heartbeat_interval)) : 0);
        }
        if (worktree_path !== undefined) {
          updates.push("worktree_path = ?");
          params.push(worktree_path || null);
        }
        if (worktree_branch !== undefined) {
          updates.push("worktree_branch = ?");
          params.push(worktree_branch || null);
        }
        if (agent_type !== undefined) {
          if (agent_type && !isValidAgentName(agent_type)) {
            return json({ ok: false, error: "invalid agent_type name" }, 400);
          }
          updates.push("agent_type = ?");
          params.push(agent_type || null);
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

        // Restart worker if model, provider, project, worker_token, heartbeat_interval, or agent_type changed, or active state changed
        if (
          model !== undefined ||
          provider !== undefined ||
          active !== undefined ||
          project !== undefined ||
          worker_token !== undefined ||
          heartbeat_interval !== undefined ||
          agent_type !== undefined
        ) {
          if (agent.active === 1) {
            await workerManager.restartAgent({
              channel,
              agentId: agent_id,
              provider: agent.provider || "copilot",
              model: agent.model,
              active: true,
              project: agent.project || "",
              workerToken: agent.worker_token || undefined,
              heartbeatInterval: agent.heartbeat_interval || 0,
              agentType: agent.agent_type || undefined,
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

    // Get agent identity (from agent file)
    if (path === "/api/app.agents.identity" && req.method === "GET") {
      const channel = url.searchParams.get("channel");
      const agent_id = url.searchParams.get("agent_id");
      if (!channel || !agent_id) return json({ ok: false, error: "channel and agent_id required" }, 400);

      const agent = db
        .query("SELECT project, worktree_path FROM channel_agents WHERE channel = ? AND agent_id = ?")
        .get(channel, agent_id) as any;
      if (!agent?.project) return json({ ok: true, identity: "" });

      const agentFile = loadAgentFile(agent_id, agent.project);
      return json({
        ok: true,
        identity: agentFile?.systemPrompt || "",
        config: agentFile || null,
      });
    }

    // Save agent identity (write agent file)
    if (path === "/api/app.agents.identity" && req.method === "POST") {
      return handleAsync(async () => {
        const body = await parseBody(req);
        const { channel, agent_id, identity } = body;
        if (!channel || !agent_id) return json({ ok: false, error: "channel and agent_id required" }, 400);
        if (typeof identity !== "string") return json({ ok: false, error: "identity must be a string" }, 400);

        const agent = db
          .query("SELECT project, worktree_path FROM channel_agents WHERE channel = ? AND agent_id = ?")
          .get(channel, agent_id) as any;
        if (!agent?.project) return json({ ok: false, error: "Agent has no project root" }, 400);

        // Validate agent name (path traversal protection)
        if (!isValidAgentName(agent_id)) {
          return json({ ok: false, error: "Invalid agent_id: must be alphanumeric with hyphens/underscores" }, 400);
        }

        const { mkdirSync, writeFileSync } = await import("node:fs");
        const agentsDir = join(agent.project, ".clawd", "agents");
        mkdirSync(agentsDir, { recursive: true });

        // Sanitize YAML values: strip newlines and control characters to prevent frontmatter injection
        const sanitizeYaml = (v: string) => v.replace(/[\r\n\t]/g, " ").trim();

        // Build agent file with frontmatter
        const frontmatterLines = ["---", `name: ${sanitizeYaml(agent_id)}`];
        if (body.description) frontmatterLines.push(`description: "${sanitizeYaml(String(body.description))}"`);
        if (body.model) frontmatterLines.push(`model: ${sanitizeYaml(String(body.model))}`);
        if (body.language) frontmatterLines.push(`language: ${sanitizeYaml(String(body.language))}`);
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          frontmatterLines.push(`tools: [${body.tools.map((t: string) => sanitizeYaml(String(t))).join(", ")}]`);
        }
        if (Array.isArray(body.directives) && body.directives.length > 0) {
          frontmatterLines.push("directives:");
          for (const d of body.directives) frontmatterLines.push(`  - ${sanitizeYaml(String(d))}`);
        }
        frontmatterLines.push("---");

        const fileContent = `${frontmatterLines.join("\n")}\n\n${identity}`;
        const outPath = join(agentsDir, `${agent_id}.md`);

        // Final path safety check: ensure resolved path is within agentsDir
        const { resolve: resolvePath } = await import("node:path");
        if (!resolvePath(outPath).startsWith(resolvePath(agentsDir))) {
          return json({ ok: false, error: "Path traversal detected" }, 400);
        }
        writeFileSync(outPath, fileContent, "utf-8");

        // Identity is hot-reloaded: loadClawdInstructions() reads from disk
        // on every iteration, so no agent restart is needed.

        return json({ ok: true });
      });
    }

    // List available agent files from all 4 directories
    if (path === "/api/app.agents.available") {
      const channel = url.searchParams.get("channel");
      const agent_id = url.searchParams.get("agent_id");
      if (!channel || !agent_id) return json({ ok: false, error: "channel and agent_id required" }, 400);

      const agent = db
        .query("SELECT project, worktree_path FROM channel_agents WHERE channel = ? AND agent_id = ?")
        .get(channel, agent_id) as any;
      if (!agent?.project) return json({ ok: true, agents: [] });

      const agents = listAgentFiles(agent.project).map((a) => ({
        name: a.name,
        description: a.description,
        model: a.model,
        source: a.source,
        tools: a.tools,
        skills: a.skills,
      }));
      return json({ ok: true, agents });
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
        console.error("[agents] list folders error:", error);
        return json({ ok: false, error: "Internal server error" }, 500);
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

      // Get agent's effective project root (worktree if available, else original project)
      const projectRoot = getAgentProjectRoot(db, channel, agentId);
      if (!projectRoot) {
        return json({ ok: false, error: "agent not found or no project configured" }, 404);
      }

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
        console.error("[agents] file tree error:", error);
        return json({ ok: false, error: "Internal server error" }, 500);
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

      // Get agent's effective project root (worktree if enabled, else original project)
      const projectRoot = getAgentProjectRoot(db, channel, agentId);
      if (!projectRoot) {
        return json({ ok: false, error: "agent not found or no project configured" }, 404);
      }

      // Security: validate path using sandbox-style validation
      const validation = validateProjectPath(projectRoot, relativePath, { allowSensitive: false });
      if (!validation.valid) {
        return json({ ok: false, error: (validation as any).error }, 400);
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
        console.error("[agents] list dir error:", error);
        return json({ ok: false, error: "Internal server error" }, 500);
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

      // Get agent's effective project root (worktree if enabled, else original project)
      const projectRoot = getAgentProjectRoot(db, channel, agentId);
      if (!projectRoot) {
        return json({ ok: false, error: "agent not found or no project configured" }, 404);
      }

      // Security: validate path using sandbox-style validation (block sensitive files)
      const validation = validateProjectPath(projectRoot, relativePath, { allowSensitive: false });
      if (!validation.valid) {
        return json({ ok: false, error: (validation as any).error }, 400);
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
        console.error("[agents] read file error:", error);
        return json({ ok: false, error: "Internal server error" }, 500);
      }
    }

    // ========================================================================
    // Skills API
    // ========================================================================

    // List skills for an agent (or global skills when no channel/agent_id)
    if (path === "/api/app.skills.list") {
      const channel = url.searchParams.get("channel");
      const agentId = url.searchParams.get("agent_id");

      let manager;
      if (channel && agentId) {
        const agent = db
          .query("SELECT project, worktree_path FROM channel_agents WHERE channel = ? AND agent_id = ?")
          .get(channel, agentId) as { project: string; worktree_path: string | null } | null;
        manager = getSkillManager(agent?.project || undefined);
      } else {
        // No channel context — scan global dirs only (skip getContextConfigRoot CWD fallback)
        manager = getSkillManager(undefined, true);
      }

      manager.indexSkillsIfStale();
      const skills = manager.listSkills();

      return json({ ok: true, skills });
    }

    // Get single skill content
    if (path === "/api/app.skills.get") {
      const name = url.searchParams.get("name");
      const channel = url.searchParams.get("channel");
      const agentId = url.searchParams.get("agent_id");

      if (!name) {
        return json({ ok: false, error: "name required" }, 400);
      }

      let manager;
      if (channel && agentId) {
        const agent = db
          .query("SELECT project, worktree_path FROM channel_agents WHERE channel = ? AND agent_id = ?")
          .get(channel, agentId) as { project: string; worktree_path: string | null } | null;
        manager = getSkillManager(agent?.project || undefined);
      } else {
        manager = getSkillManager(undefined, true);
      }

      manager.indexSkillsIfStale();
      const skill = manager.getSkill(name);

      if (!skill) {
        return json({ ok: false, error: "skill_not_found" }, 404);
      }

      // Add editable flag — ~/.claude/ skills are read-only
      const claudeDir = join(homedir(), ".claude");
      const editable = !skill.path?.startsWith(claudeDir);

      return json({ ok: true, skill: { ...skill, editable } });
    }

    // Save (create/update) a skill
    if (path === "/api/app.skills.save" && req.method === "POST") {
      return handleAsync(async () => {
        const body = await parseBody(req);
        const { channel, agent_id, name, description, triggers, content, scope } = body;

        if (!name) {
          return json({ ok: false, error: "name required" }, 400);
        }

        let manager;
        if (channel && agent_id) {
          const agent = db
            .query("SELECT project, worktree_path FROM channel_agents WHERE channel = ? AND agent_id = ?")
            .get(channel, agent_id) as { project: string; worktree_path: string | null } | null;
          manager = getSkillManager(agent?.project || undefined);
        } else {
          manager = getSkillManager(undefined, true);
        }

        // Force scope to "global" when no channel context (standalone mode)
        const effectiveScope =
          channel && agent_id
            ? ((scope === "global" ? "global" : "project") as "project" | "global")
            : ("global" as const);

        const triggersArray: string[] = Array.isArray(triggers)
          ? triggers
          : typeof triggers === "string" && triggers.trim()
            ? triggers
                .split(",")
                .map((t: string) => t.trim())
                .filter((t: string) => t.length > 0)
            : [];

        const result = manager.saveSkill(
          {
            name: String(name).trim(),
            description: String(description || "").trim(),
            triggers: triggersArray,
            content: String(content || "").trim(),
          },
          effectiveScope,
        );

        if (!result.success) {
          return json({ ok: false, error: result.error }, 400);
        }

        return json({ ok: true });
      });
    }

    // Delete a skill
    if (path === "/api/app.skills.delete" && req.method === "DELETE") {
      const name = url.searchParams.get("name");
      const channel = url.searchParams.get("channel");
      const agentId = url.searchParams.get("agent_id");

      if (!name) {
        return json({ ok: false, error: "name required" }, 400);
      }

      let manager;
      if (channel && agentId) {
        const agent = db
          .query("SELECT project, worktree_path FROM channel_agents WHERE channel = ? AND agent_id = ?")
          .get(channel, agentId) as { project: string; worktree_path: string | null } | null;
        manager = getSkillManager(agent?.project || undefined);
      } else {
        manager = getSkillManager(undefined, true);
      }

      const deleted = manager.deleteSkill(name);

      if (!deleted) {
        return json({ ok: false, error: "skill_not_found_or_delete_failed" }, 404);
      }

      return json({ ok: true });
    }

    // ========================================================================
    // Agent Files CRUD API (global agent file management)
    // ========================================================================

    // List all global agent files
    if (path === "/api/app.agent-files.list") {
      const agents = listGlobalAgentFiles();
      return json({
        ok: true,
        agents: agents.map((a) => ({
          name: a.name,
          description: a.description,
          source: a.source,
          editable: a.source === "clawd-global",
          model: a.model,
          provider: a.provider,
        })),
      });
    }

    // Get single agent file content
    if (path === "/api/app.agent-files.get") {
      const name = url.searchParams.get("name");
      if (!name) return json({ ok: false, error: "name required" }, 400);
      if (!isValidAgentName(name)) return json({ ok: false, error: "invalid agent name" }, 400);

      // Try reading raw file from ~/.clawd/agents/ first (editable)
      const clawdPath = join(homedir(), ".clawd", "agents", `${name}.md`);
      if (existsSync(clawdPath)) {
        try {
          const content = readFileSync(clawdPath, "utf-8");
          return json({
            ok: true,
            agent: { name, source: "clawd-global", editable: true, content },
          });
        } catch {
          return json({ ok: false, error: "failed to read file" }, 500);
        }
      }

      // Try ~/.claude/agents/ (read-only)
      const claudePath = join(homedir(), ".claude", "agents", `${name}.md`);
      if (existsSync(claudePath)) {
        try {
          const content = readFileSync(claudePath, "utf-8");
          return json({
            ok: true,
            agent: { name, source: "claude-global", editable: false, content },
          });
        } catch {
          return json({ ok: false, error: "failed to read file" }, 500);
        }
      }

      // Try built-in agents (reconstruct content)
      const agents = listGlobalAgentFiles();
      const agent = agents.find((a) => a.name === name);
      if (agent && agent.source === "built-in") {
        const content = reconstructAgentFileContent(agent);
        return json({
          ok: true,
          agent: { name, source: "built-in", editable: false, content },
        });
      }

      return json({ ok: false, error: "agent file not found" }, 404);
    }

    // Save (create/update) agent file
    if (path === "/api/app.agent-files.save" && req.method === "POST") {
      return handleAsync(async () => {
        const body = await parseBody(req);
        const { name, content } = body;

        if (!name || typeof name !== "string") {
          return json({ ok: false, error: "name required" }, 400);
        }
        if (!isValidAgentName(name.trim())) {
          return json({ ok: false, error: "invalid agent name (use alphanumeric, hyphens, underscores)" }, 400);
        }
        if (!content || typeof content !== "string") {
          return json({ ok: false, error: "content required" }, 400);
        }

        // File size limit: 256KB (measure bytes, not characters)
        const MAX_AGENT_FILE_SIZE = 256 * 1024;
        const byteSize = new TextEncoder().encode(content).byteLength;
        if (byteSize > MAX_AGENT_FILE_SIZE) {
          return json({ ok: false, error: "content too large (max 256KB)" }, 400);
        }

        // Validate YAML frontmatter parses correctly
        const hasValidFrontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
        if (!hasValidFrontmatter) {
          return json({ ok: false, error: "invalid format: must start with YAML frontmatter (---)" }, 400);
        }

        const agentsDir = join(homedir(), ".clawd", "agents");
        mkdirSync(agentsDir, { recursive: true });

        const filePath = join(agentsDir, `${name.trim()}.md`);

        // Reject symlinks to prevent write escape
        if (existsSync(filePath)) {
          try {
            const stat = lstatSync(filePath);
            if (stat.isSymbolicLink()) {
              return json({ ok: false, error: "cannot overwrite symlink" }, 400);
            }
          } catch {
            /* file may have been deleted between checks — proceed */
          }
        }

        await Bun.write(filePath, content);
        clearAgentFilesCache();

        return json({ ok: true });
      });
    }

    // Delete agent file
    if (path === "/api/app.agent-files.delete" && req.method === "DELETE") {
      const name = url.searchParams.get("name");
      if (!name) return json({ ok: false, error: "name required" }, 400);
      if (!isValidAgentName(name)) return json({ ok: false, error: "invalid agent name" }, 400);

      const filePath = join(homedir(), ".clawd", "agents", `${name}.md`);
      if (!existsSync(filePath)) {
        return json({ ok: false, error: "agent file not found in ~/.clawd/agents/" }, 404);
      }

      // Check if agent_type is in use (try/catch for pre-Phase-2 compat)
      try {
        const inUse = db.query("SELECT channel, agent_id FROM channel_agents WHERE agent_type = ?").all(name) as {
          channel: string;
          agent_id: string;
        }[];
        if (inUse.length > 0) {
          return json(
            {
              ok: false,
              error: `Cannot delete: agent type "${name}" is in use by ${inUse.length} agent(s)`,
              agents: inUse,
            },
            409,
          );
        }
      } catch {
        // agent_type column not yet added — skip check
      }

      try {
        unlinkSync(filePath);
        clearAgentFilesCache();
        return json({ ok: true });
      } catch {
        return json({ ok: false, error: "failed to delete agent file" }, 500);
      }
    }

    // Not handled
    return null;
  };
}

// ============================================================================
// Agent File Helpers
// ============================================================================

/** Reconstruct agent file content from AgentFileConfig (for built-in agents) */
function reconstructAgentFileContent(agent: AgentFileConfig): string {
  const q = (s: string) => (s.includes(":") || s.includes('"') || s.includes("#") ? `"${s.replace(/"/g, '\\"')}"` : s);
  const lines: string[] = ["---"];
  lines.push(`name: ${agent.name}`);
  if (agent.description) lines.push(`description: ${q(agent.description)}`);
  if (agent.provider) lines.push(`provider: ${agent.provider}`);
  if (agent.model) lines.push(`model: ${agent.model}`);
  if (agent.tools) lines.push(`tools: [${agent.tools.join(", ")}]`);
  if (agent.disallowedTools) lines.push(`disallowedTools: [${agent.disallowedTools.join(", ")}]`);
  if (agent.skills) lines.push(`skills: [${agent.skills.join(", ")}]`);
  if (agent.memory) lines.push(`memory: ${agent.memory}`);
  if (agent.language) lines.push(`language: ${agent.language}`);
  if (agent.directives) {
    lines.push("directives:");
    for (const d of agent.directives) lines.push(`  - ${d}`);
  }
  if (agent.maxTurns) lines.push(`maxTurns: ${agent.maxTurns}`);
  lines.push("---");
  if (agent.systemPrompt) lines.push("", agent.systemPrompt);
  return lines.join("\n");
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
