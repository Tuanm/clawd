/**
 * Chat Tools — skill_*, todo_write/read/update, spawn_agent, list_agents,
 *              kill_agent, agent_logs, article_*, chat_send_article
 *
 * Registers chat/collaboration tools into the shared tool registry.
 */

import {
  chatApiUrl,
  currentAgentId,
  currentChannel,
  getContextAgentId,
  getContextChannel,
  getContextConfigRoot,
  getProjectAgentsDir,
  getProjectHash,
  getSandboxProjectRoot,
  registerTool,
  toolFetch,
} from "./registry";

// ============================================================================
// Sub-Agent Store (module-level state for tracking spawned agents)
// ============================================================================

const subAgents = new Map<
  string,
  {
    id: string;
    name: string;
    task: string;
    status: "running" | "completed" | "failed" | "aborted";
    result?: any;
    error?: string;
    startedAt: number;
    completedAt?: number;
    tmuxSession?: string;
    resultFile?: string;
  }
>();

// Helper: Get subagent tmux socket path (project-scoped)
function getSubAgentSocketPath(): string {
  const { join } = require("node:path");
  return join(getProjectAgentsDir(), "tmux.sock");
}

// ============================================================================
// Tool: Skill List
// ============================================================================

registerTool(
  "skill_list",
  "List all available skills (project-scoped + global). Use this to discover what skills are available.",
  {},
  [],
  async () => {
    try {
      const { getSkillManager } = await import("../skills/manager");
      const manager = getSkillManager();
      manager.indexSkillsIfStale();

      const skills = manager.listSkills();

      if (skills.length === 0) {
        return {
          success: true,
          output: "No skills installed. Use skill_create to add skills to the project.",
        };
      }

      const formatted = skills
        .map((s) => `• **${s.name}** (${s.source}): ${s.description}\n  Triggers: ${s.triggers.join(", ")}`)
        .join("\n\n");

      return { success: true, output: `Available skills:\n\n${formatted}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Skill Search
// ============================================================================

registerTool(
  "skill_search",
  "Search for relevant skills by keywords. Returns matching skills ranked by relevance.",
  {
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "Keywords to search for",
    },
  },
  ["keywords"],
  async ({ keywords }) => {
    try {
      const { getSkillManager } = await import("../skills/manager");
      const manager = getSkillManager();
      manager.indexSkillsIfStale();

      const matches = manager.searchByKeywords(keywords);

      if (matches.length === 0) {
        return { success: true, output: "No matching skills found." };
      }

      const formatted = matches
        .map(
          (m) =>
            `• **${m.skill.name}** (${m.skill.source}, ${Math.round(m.score * 100)}% match)\n  ${m.skill.description}\n  Matched: ${m.matchedTriggers.join(", ")}`,
        )
        .join("\n\n");

      return { success: true, output: `Matching skills:\n\n${formatted}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Skill Activate
// ============================================================================

registerTool(
  "skill_activate",
  "Load and activate a skill by name. Returns the full skill content to guide your actions.",
  {
    name: {
      type: "string",
      description: "Name of the skill to activate",
    },
  },
  ["name"],
  async ({ name }) => {
    try {
      const { getSkillManager } = await import("../skills/manager");
      const manager = getSkillManager();
      manager.indexSkillsIfStale();

      const skill = manager.getSkill(name);

      if (!skill) {
        return {
          success: false,
          output: "",
          error: `Skill '${name}' not found. Use skill_list to see available skills.`,
        };
      }

      return {
        success: true,
        output: `# Skill: ${skill.name} (${skill.source})\n\n${skill.content}\n\n---\n*Skill activated. Follow the guidelines above.*`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Skill Create
// ============================================================================

registerTool(
  "skill_create",
  "Create or update a skill. Saved as {projectRoot}/.clawd/skills/{name}/SKILL.md (Claude Code-compatible folder format). " +
    "Use scope='global' to save to ~/.clawd/skills/ instead.",
  {
    name: {
      type: "string",
      description: "Skill name (lowercase a-z, 0-9, hyphens, underscores, max 64 chars)",
    },
    description: {
      type: "string",
      description: "Brief description of what the skill does (<200 chars)",
    },
    triggers: {
      type: "array",
      items: { type: "string" },
      description: "Keywords that should trigger this skill",
    },
    content: {
      type: "string",
      description: "Full skill content in markdown format (instructions for the agent)",
    },
    scope: {
      type: "string",
      enum: ["project", "global"],
      description: 'Where to save: "project" (default, in .clawd/skills/) or "global" (~/.clawd/skills/)',
    },
  },
  ["name", "description", "triggers", "content"],
  async ({ name, description, triggers, content, scope }) => {
    try {
      const { getSkillManager } = await import("../skills/manager");
      const manager = getSkillManager();

      const result = manager.saveSkill({ name, description, triggers, content }, scope || "project");

      if (!result.success) {
        return { success: false, output: "", error: result.error };
      }

      return { success: true, output: `Skill '${name}' saved to ${scope || "project"} scope.` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Skill Delete
// ============================================================================

registerTool(
  "skill_delete",
  "Delete a skill by name. Removes the skill folder and its index entry.",
  {
    name: {
      type: "string",
      description: "Name of the skill to delete",
    },
  },
  ["name"],
  async ({ name }) => {
    try {
      const { getSkillManager } = await import("../skills/manager");
      const manager = getSkillManager();

      const deleted = manager.deleteSkill(name);

      if (!deleted) {
        return { success: false, output: "", error: `Skill '${name}' not found.` };
      }

      return { success: true, output: `Skill '${name}' deleted.` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Todo List Tools (Claude Code-style)
// ============================================================================

registerTool(
  "todo_write",
  "Write your Todo list. Creates a new list or replaces the existing one. Each item needs content and status. Only ONE active list per agent — complete or clear it before creating a new one.",
  {
    todos: {
      type: "array",
      description:
        "Todo items: [{id?, content, status}]. Status: pending, in_progress, completed. IDs auto-generated if omitted. Alias: items",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          content: { type: "string" },
          status: { type: "string" },
        },
        required: ["content"],
      },
    },
  },
  ["todos"],
  async ({ todos, items }) => {
    // Accept both "todos" (Claude Code compat) and "items" as parameter name
    const todoItems = todos || items;
    try {
      const res = await toolFetch(`${chatApiUrl}/api/todos.write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: getContextAgentId() || currentAgentId,
          channel: getContextChannel() || currentChannel,
          items: todoItems,
        }),
      });
      const data = (await res.json()) as any;
      if (!data.ok) return { success: false, output: "", error: data.error };

      if (data.completed) return { success: true, output: "All items completed. Todo list cleared." };
      const list = (data.items as any[]) || [];
      let output = `Todo list (${list.length} items):\n`;
      for (const t of list) output += `- [${t.status}] ${t.content} (${t.id})\n`;
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

registerTool("todo_read", "Read your current Todo list.", {}, [], async () => {
  try {
    const res = await toolFetch(
      `${chatApiUrl}/api/todos.read?agent_id=${encodeURIComponent(getContextAgentId() || currentAgentId)}&channel=${encodeURIComponent(getContextChannel() || currentChannel)}`,
    );
    const data = (await res.json()) as any;
    if (!data.ok) return { success: false, output: "", error: data.error };

    const list = (data.items as any[]) || [];
    if (list.length === 0) return { success: true, output: "No active todo list." };

    const done = list.filter((t: any) => t.status === "completed").length;
    let output = `Todo list (${done}/${list.length} completed):\n`;
    for (const t of list) output += `- [${t.status}] ${t.content} (${t.id})\n`;
    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
});

registerTool(
  "todo_update",
  "Update a Todo item's status. Use after completing a step.",
  {
    item_id: { type: "string", description: "The item ID to update" },
    status: { type: "string", description: "New status: pending, in_progress, completed" },
  },
  ["item_id", "status"],
  async ({ item_id, status }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/todos.update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: getContextAgentId() || currentAgentId,
          channel: getContextChannel() || currentChannel,
          item_id,
          status,
        }),
      });
      const data = (await res.json()) as any;
      if (!data.ok) return { success: false, output: "", error: data.error };

      if (data.completed) return { success: true, output: "All items completed. Todo list cleared." };
      const list = (data.items as any[]) || [];
      const done = list.filter((t: any) => t.status === "completed").length;
      let output = `Updated. Progress: ${done}/${list.length}\n`;
      for (const t of list) output += `- [${t.status}] ${t.content} (${t.id})\n`;
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Sub-Agent System
// ============================================================================

// Spawn a sub-agent in a detached tmux session (survives main agent exit)
async function spawnTmuxSubAgent(
  task: string,
  name: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  const { execSync, spawn } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  // Check if tmux is available
  try {
    execSync("which tmux", { stdio: "ignore" });
  } catch {
    return {
      success: false,
      output: "",
      error: "tmux is not installed. Install it with: apt install tmux (or brew install tmux on macOS)",
    };
  }

  const { randomUUID } = await import("node:crypto");
  const randomSuffix = randomUUID().replace(/-/g, "").substring(0, 12);

  const sessionName = `clawd-${name}-${randomSuffix}`;
  const agentId = `tmux-${sessionName}`;

  // Use project-scoped agents directory
  const agentsDir = getProjectAgentsDir();
  const agentDir = join(agentsDir, sessionName);
  try {
    mkdirSync(agentDir, { recursive: true });
  } catch {}
  const logFile = join(agentDir, "output.log");
  const resultFile = join(agentDir, "result.json");
  const scriptFile = join(agentDir, "run.sh");
  const metaFile = join(agentDir, "meta.json");

  // Write agent metadata
  const { writeFileSync, chmodSync } = await import("node:fs");
  writeFileSync(
    metaFile,
    JSON.stringify({
      id: agentId,
      name,
      task: task.slice(0, 500),
      status: "running",
      createdAt: Date.now(),
      projectHash: getProjectHash(),
    }),
  );

  // Append instruction to use report_agent_result tool
  const taskWithInstruction = `${task}\n\nIMPORTANT: When you complete this task, use the report_agent_result tool to write your final result/report. The parent agent will read this.`;
  // Use single-quote shell escaping: wrap in single quotes and escape embedded single quotes as '\''
  const shellSafeTask = taskWithInstruction.replace(/'/g, "'\\''");

  // Build clawd command - pass project-hash so sub-agent uses same project dir
  const currentProjectHash = getProjectHash();
  const baseClawdCmd = `clawd -p '${shellSafeTask}' --result-file "${resultFile}" --project-hash "${currentProjectHash}"`;

  // Get sandbox root (detect git root or use cwd)
  const sandboxRoot = getSandboxProjectRoot();

  // Run clawd directly in tmux (no sandbox wrapping)
  const clawdCmd = `${baseClawdCmd} 2>&1 | tee -a "${logFile}"`;

  // Dedicated tmux socket for sub-agents (project-scoped)
  const socketPath = join(agentsDir, "tmux.sock");

  // Create tmux session - write script to temp file to avoid quoting hell
  const scriptContent = `#!/bin/bash
# Sub-agent runs in sandbox root directory
cd "${sandboxRoot}"
echo "Starting sub-agent: ${name}" >> "${logFile}"
echo "Sandbox root: ${sandboxRoot}" >> "${logFile}"
echo "Project hash: ${currentProjectHash}" >> "${logFile}"
echo "---" >> "${logFile}"
${clawdCmd}
echo "---" >> "${logFile}"
echo "Exit code: $?" >> "${logFile}"
`;
  writeFileSync(scriptFile, scriptContent);
  chmodSync(scriptFile, 0o755);

  const tmuxCmd = `tmux -S "${socketPath}" new-session -d -s "${sessionName}" "${scriptFile}"`;

  try {
    execSync(tmuxCmd, { stdio: "ignore" });

    // Store agent info
    subAgents.set(agentId, {
      id: agentId,
      name,
      task,
      status: "running",
      startedAt: Date.now(),
      tmuxSession: sessionName,
      resultFile,
    });

    return {
      success: true,
      output: JSON.stringify(
        {
          agent_id: agentId,
          name,
          status: "running",
          project_hash: currentProjectHash,
          message: `Sub-agent spawned. Use list_agents to check status, agent_logs to view output, or kill_agent to stop it.`,
        },
        null,
        2,
      ),
    };
  } catch (err: any) {
    return {
      success: false,
      output: "",
      error: `Failed to spawn tmux session: ${err.message}`,
    };
  }
}

registerTool(
  "spawn_agent",
  `Spawn a sub-agent to work on a task. The sub-agent is a fully autonomous agent with the same capabilities (file ops, bash, web tools, etc.).

Use this for:
- Parallelizing independent tasks
- Delegating complex subtasks
- Running long operations

The sub-agent runs asynchronously and will respond directly to the chat channel when done — no need to wait or poll for results.

Sub-agents can spawn their own sub-agents (up to 3 levels deep). The sub-agent will run until it completes the task or hits max iterations.`,
  {
    task: {
      type: "string",
      description: "The task for the sub-agent to complete. Be specific and include all necessary context.",
    },
    name: {
      type: "string",
      description: "Optional friendly name for the sub-agent (for tracking)",
    },
  },
  ["task"],
  async ({ task, name }) => {
    try {
      const agentName = name || `subagent-${Date.now()}`;
      return await spawnTmuxSubAgent(task, agentName);
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

registerTool(
  "list_agents",
  "List all spawned sub-agents and their current status. Useful to check which agents are running before using kill_agent.",
  {},
  [],
  async () => {
    const agents = Array.from(subAgents.values()).map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      task: a.task.slice(0, 100) + (a.task.length > 100 ? "..." : ""),
      started_at: new Date(a.startedAt).toISOString(),
      completed_at: a.completedAt ? new Date(a.completedAt).toISOString() : null,
      duration_ms: a.completedAt ? a.completedAt - a.startedAt : Date.now() - a.startedAt,
    }));

    if (agents.length === 0) {
      return { success: true, output: "No sub-agents spawned in this session." };
    }

    return {
      success: true,
      output: JSON.stringify({ agents }, null, 2),
    };
  },
);

registerTool(
  "kill_agent",
  "Kill/terminate a running sub-agent and all its children (sub-sub-agents). The agent will stop at the next iteration.",
  {
    agent_id: {
      type: "string",
      description: "The ID of the sub-agent to kill",
    },
  },
  ["agent_id"],
  async ({ agent_id }) => {
    const agentInfo = subAgents.get(agent_id);
    if (!agentInfo) {
      return {
        success: false,
        output: "",
        error: `Agent ${agent_id} not found`,
      };
    }

    if (agentInfo.status !== "running") {
      return {
        success: false,
        output: "",
        error: `Agent ${agent_id} is not running (status: ${agentInfo.status})`,
      };
    }

    if (agentInfo.tmuxSession) {
      // Kill tmux session for detached agents
      const { execSync } = require("node:child_process");
      const socketPath = getSubAgentSocketPath();
      try {
        execSync(`tmux -S "${socketPath}" kill-session -t "${agentInfo.tmuxSession}" 2>/dev/null`, { stdio: "ignore" });
      } catch {
        // Session might already be gone
      }
    }

    agentInfo.status = "aborted";
    agentInfo.completedAt = Date.now();

    return {
      success: true,
      output: JSON.stringify(
        {
          message: `Agent ${agent_id} and its children have been terminated`,
          id: agent_id,
          name: agentInfo.name,
          status: "aborted",
          duration_ms: agentInfo.completedAt - agentInfo.startedAt,
        },
        null,
        2,
      ),
    };
  },
);

registerTool(
  "agent_logs",
  "Get the output logs of a sub-agent by its ID. Use this to check what a sub-agent is doing or has done.",
  {
    agent_id: {
      type: "string",
      description: "The ID of the sub-agent",
    },
    tail: {
      type: "number",
      description: "Only get last N lines (optional, returns last 100 by default)",
    },
  },
  ["agent_id"],
  async ({ agent_id, tail = 100 }) => {
    const agentInfo = subAgents.get(agent_id);
    if (!agentInfo) {
      return {
        success: false,
        output: "",
        error: `Agent ${agent_id} not found. Use list_agents to see available agents.`,
      };
    }

    const { join } = require("node:path");
    const agentsDir = getProjectAgentsDir();
    const sessionName = agentInfo.tmuxSession || agent_id.replace(/^tmux-/, "");
    const logFile = join(agentsDir, sessionName, "output.log");

    try {
      const { readFileSync } = require("node:fs");
      const content = readFileSync(logFile, "utf-8");
      const lines = content.split("\n");
      const output = tail ? lines.slice(-tail).join("\n") : content;

      return {
        success: true,
        output: `Agent: ${agentInfo.name} [${agentInfo.status.toUpperCase()}]\nTask: ${agentInfo.task.slice(0, 200)}${agentInfo.task.length > 200 ? "..." : ""}\n\n--- Output (last ${Math.min(tail, lines.length)} lines) ---\n${output || "(no output yet)"}`,
      };
    } catch {
      return {
        success: true,
        output: `Agent: ${agentInfo.name} [${agentInfo.status.toUpperCase()}]\n(no output yet — agent may still be starting)`,
      };
    }
  },
);

// ============================================================================
// Article Tools
// ============================================================================

registerTool(
  "article_create",
  "Create a new article (blog post, documentation, etc.). The article is stored and can be published to the channel. Provide content via one of: 'content' (raw markdown), 'file_id' (uploaded file from chat_upload_local_file), or 'message_ts' (existing chat message timestamp).",
  {
    title: { type: "string", description: "Article title" },
    content: {
      type: "string",
      description: "Article content in markdown format (mutually exclusive with file_id and message_ts)",
    },
    file_id: {
      type: "string",
      description:
        "File ID from chat_upload_local_file — file content used as article body (mutually exclusive with content and message_ts)",
    },
    message_ts: {
      type: "string",
      description:
        "Timestamp of an existing chat message — its text used as article body (mutually exclusive with content and file_id)",
    },
    description: { type: "string", description: "Short description/summary (optional)" },
    thumbnail_url: { type: "string", description: "URL for thumbnail image (optional)" },
    tags: { type: "array", description: "Array of tags for the article (optional)", items: { type: "string" } },
    published: { type: "boolean", description: "Whether to publish immediately (default: false)" },
  },
  ["title"],
  async ({ title, content, file_id, message_ts, description, thumbnail_url, tags, published }) => {
    const channel = getContextChannel();
    const agentId = getContextAgentId() || "agent";

    try {
      const res = await toolFetch(`${chatApiUrl}/api/articles.create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          author: agentId,
          title,
          ...(content !== undefined ? { content } : {}),
          ...(file_id !== undefined ? { file_id } : {}),
          ...(message_ts !== undefined ? { message_ts } : {}),
          description: description || "",
          thumbnail_url: thumbnail_url || "",
          tags: tags || [],
          published: published || false,
        }),
      });
      const data = (await res.json()) as any;
      if (data.ok) {
        return {
          success: true,
          output: JSON.stringify({
            id: data.article.id,
            title: data.article.title,
            url: `/articles/${data.article.id}`,
            published: data.article.published === 1,
          }),
        };
      }
      return { success: false, error: data.error || "Failed to create article", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

registerTool(
  "article_list",
  "List articles in a channel. Shows recent articles with metadata.",
  {
    channel: { type: "string", description: "Channel ID (optional, defaults to current)" },
    limit: { type: "number", description: "Max articles to return (default: 10)" },
    offset: { type: "number", description: "Pagination offset (default: 0)" },
    published_only: { type: "boolean", description: "Only show published articles (default: true)" },
  },
  [],
  async ({ channel, limit = 10, offset = 0, published_only = true }) => {
    const effectiveChannel = channel || getContextChannel();

    try {
      const url = new URL(`${chatApiUrl}/api/articles.list`);
      url.searchParams.set("channel", effectiveChannel);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("published", String(published_only));

      const res = await toolFetch(url.toString());
      const data = (await res.json()) as any;
      if (data.ok) {
        return {
          success: true,
          output: JSON.stringify({
            articles: data.articles.map((a: any) => ({
              id: a.id,
              title: a.title,
              description: a.description,
              author: a.author,
              published: a.published === 1,
              created_at: a.created_at,
            })),
          }),
        };
      }
      return { success: false, error: data.error || "Failed to list articles", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

registerTool(
  "article_get",
  "Get a specific article by ID. Returns full content and metadata.",
  {
    id: { type: "string", description: "Article ID" },
  },
  ["id"],
  async ({ id }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/articles.get?id=${encodeURIComponent(id)}`);
      const data = (await res.json()) as any;
      if (data.ok) {
        return {
          success: true,
          output: JSON.stringify({
            id: data.article.id,
            title: data.article.title,
            description: data.article.description,
            author: data.article.author,
            content: data.article.content,
            thumbnail_url: data.article.thumbnail_url,
            tags: JSON.parse(data.article.tags_json || "[]"),
            published: data.article.published === 1,
            created_at: data.article.created_at,
            updated_at: data.article.updated_at,
          }),
        };
      }
      return { success: false, error: data.error || "Article not found", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

registerTool(
  "article_update",
  "Update an existing article.",
  {
    id: { type: "string", description: "Article ID" },
    title: { type: "string", description: "New title (optional)" },
    content: { type: "string", description: "New content (optional)" },
    description: { type: "string", description: "New description (optional)" },
    thumbnail_url: { type: "string", description: "New thumbnail URL (optional)" },
    tags: { type: "array", description: "New tags (optional)", items: { type: "string" } },
    published: { type: "boolean", description: "Publish/unpublish (optional)" },
  },
  ["id"],
  async ({ id, title, content, description, thumbnail_url, tags, published }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/articles.update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          ...(title !== undefined && { title }),
          ...(content !== undefined && { content }),
          ...(description !== undefined && { description }),
          ...(thumbnail_url !== undefined && { thumbnail_url }),
          ...(tags !== undefined && { tags }),
          ...(published !== undefined && { published }),
        }),
      });
      const data = (await res.json()) as any;
      if (data.ok) {
        return {
          success: true,
          output: JSON.stringify({
            id: data.article.id,
            title: data.article.title,
            updated_at: data.article.updated_at,
          }),
        };
      }
      return { success: false, error: data.error || "Failed to update article", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

registerTool(
  "article_delete",
  "Delete an article.",
  {
    id: { type: "string", description: "Article ID to delete" },
  },
  ["id"],
  async ({ id }) => {
    try {
      const res = await toolFetch(`${chatApiUrl}/api/articles.delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = (await res.json()) as any;
      if (data.ok) {
        return { success: true, output: JSON.stringify({ id, deleted: true }) };
      }
      return { success: false, error: data.error || "Failed to delete article", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

registerTool(
  "chat_send_article",
  "Send an article as a message to the chat. This posts an article card to the channel that links to the full article page.",
  {
    article_id: { type: "string", description: "Article ID to send to chat" },
    channel: { type: "string", description: "Channel ID (optional, defaults to current channel)" },
  },
  ["article_id"],
  async ({ article_id, channel }) => {
    const effectiveChannel = channel || getContextChannel();
    const agentId = getContextAgentId() || "agent";

    if (!effectiveChannel) {
      return { success: false, error: "Channel not specified", output: "" };
    }

    try {
      // First get the article details
      const articleRes = await toolFetch(`${chatApiUrl}/api/articles.get?id=${encodeURIComponent(article_id)}`);
      const articleData = (await articleRes.json()) as any;

      if (!articleData.ok || !articleData.article) {
        return { success: false, error: "Article not found", output: "" };
      }

      const article = articleData.article;

      // Send message with article attachment
      const msgRes = await toolFetch(`${chatApiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: effectiveChannel,
          user: "UBOT",
          agent_id: agentId,
          text: `Article: ${article.title}`,
          subtype: "article",
          article_json: JSON.stringify({
            id: article.id,
            title: article.title,
            description: article.description,
            author: article.author,
            thumbnail_url: article.thumbnail_url,
          }),
        }),
      });
      const msgData = (await msgRes.json()) as any;

      if (msgData.ok) {
        return {
          success: true,
          output: JSON.stringify({
            message_ts: msgData.ts,
            article_id: article.id,
            article_url: `/articles/${article.id}`,
          }),
        };
      }
      return { success: false, error: msgData.error || "Failed to send article message", output: "" };
    } catch (err) {
      return { success: false, error: String(err), output: "" };
    }
  },
);

// ============================================================================
// Sub-Agent Cleanup helpers (exported for tools.ts)
// ============================================================================

/**
 * Wait for all running sub-agents to complete.
 * All agents are tmux-based (detached) — they survive process exit.
 */
export async function waitForSubAgents(_timeout: number = 60000): Promise<void> {
  const tmuxRunning = Array.from(subAgents.values()).filter((a) => a.status === "running" && a.tmuxSession);
  if (tmuxRunning.length > 0) {
    console.log(`[SubAgents] ${tmuxRunning.length} tmux sub-agent(s) still running (they will continue independently)`);
  }
}

/**
 * Terminate all running sub-agents immediately.
 */
export async function terminateAllSubAgents(): Promise<void> {
  const running = Array.from(subAgents.values()).filter((a) => a.status === "running");
  for (const agent of running) {
    try {
      if (agent.tmuxSession) {
        const { execSync } = require("node:child_process");
        const socketPath = getSubAgentSocketPath();
        try {
          execSync(`tmux -S "${socketPath}" kill-session -t "${agent.tmuxSession}" 2>/dev/null`, { stdio: "ignore" });
        } catch {}
      }
      agent.status = "aborted";
      agent.completedAt = Date.now();
    } catch {}
  }
}
