/**
 * Chat Tools — skill_*, todo_write/read/update, spawn_agent, list_agents,
 *              kill_agent, get_agent_report, get_agent_logs, article_*, chat_send_article
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
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
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
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
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
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
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
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
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
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
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
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
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
  } catch (err: unknown) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
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
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
);

// ============================================================================
// Sub-Agent System (delegates to spawn-helper)
// ============================================================================

// Lazy import to avoid circular deps — spawn-helper is self-contained
async function getSpawnHelper() {
  const mod = await import("../../spaces/spawn-helper");
  return mod;
}

/**
 * Spawn a sub-agent using the shared space/worker system.
 * Replaces the broken tmux subprocess approach.
 */
async function spawnAgentViaHelper(
  task: string,
  options: { name?: string; agentType?: string; context?: string; model?: string },
): Promise<{ success: boolean; output: string; error?: string }> {
  const { executeSpawnAgent, SpawnContext } = await getSpawnHelper();

  // Build a minimal SpawnContext — chat-tools has access to these from registry
  const ctx: SpawnContext = {
    channel: currentChannel(),
    agentId: currentAgentId(),
    apiUrl: chatApiUrl(),
    spaceManager: undefined as any, // WorkerLoop provides these; chat-tools runs in main
    spaceWorkerManager: undefined as any,
    trackedSpaces: new Map(),
    getAgentConfig: async () => null, // Chat tools don't have per-channel agent config
  };

  const result = await executeSpawnAgent(ctx, {
    task,
    agentType: options.agentType || "general",
    context: options.context,
    name: options.name,
    model: options.model,
  });

  return {
    success: result.success,
    output: result.output || "",
    error: result.error,
  };
}

registerTool(
  "spawn_agent",
  `Spawn a sub-agent to work on a task asynchronously. The sub-agent operates in the same chat channel and reports results back directly.

**When to spawn a sub-agent:**
- Parallelize independent research paths that can run simultaneously
- Delegate complex multi-step tasks that would block the main agent
- Offload file analysis, code search, or documentation tasks
- Run independent work while the main agent handles coordination

**Agent type selection:**
- \`explore\` (default, fast) — Code search, file discovery, pattern analysis. Uses Haiku model. Best for: "find all files related to X", "search the codebase for Y", "analyze the structure of Z".
- \`general\` — Full-access agent for complex multi-step tasks. Uses the parent model. Best for: "implement feature X", "refactor module Y", "debug issue Z".
- \`plan\` — Research agent for gathering context before planning. Uses the parent model. Best for: "analyze requirements for X", "research options for Y", "gather context for Z".

**Do NOT delegate:**
- Reading a specific file (use view directly — faster)
- Simple grep/glob search (faster than spawning)
- Quick targeted changes where latency matters
- Single-step operations that take <5 seconds

**Important:** Do NOT wait for or poll the sub-agent. Continue with other work immediately after spawning. The sub-agent will report back via chat when complete.`,
  {
    task: {
      type: "string",
      description:
        "The task for the sub-agent to complete. Be specific and include all necessary context, constraints, and expected deliverables.",
    },
    name: {
      type: "string",
      description: "Optional friendly name for the sub-agent (for tracking in list_agents)",
    },
    agent: {
      type: "string",
      description:
        "Agent type: 'explore' (fast, read-only), 'general' (full access), or 'plan' (research). Defaults to 'general'.",
    },
    context: {
      type: "string",
      description: "Optional additional context to prepend to the agent's system prompt.",
    },
    model: {
      type: "string",
      description:
        "Optional model override: 'sonnet', 'opus', 'haiku', 'inherit' (use parent's model), or a specific model name.",
    },
  },
  ["task"],
  async ({ task, name, agent, context, model }) => {
    try {
      const result = await spawnAgentViaHelper(task, {
        name,
        agentType: agent,
        context,
        model,
      });

      if (result.success) {
        return result;
      }
      return { success: false, output: "", error: result.error };
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
);

registerTool(
  "list_agents",
  "List all spawned sub-agents and their current status. Useful to check which agents are running before using kill_agent.",
  {
    type: {
      type: "string",
      description:
        "Filter by agent type: 'available' (registered but not completed), 'spawned' (all), or omit for all.",
      enum: ["available", "spawned"],
    },
    status: {
      type: "string",
      description: "Filter by status: 'running', 'completed', 'failed', 'stopped'.",
    },
    query: {
      type: "string",
      description: "Search by agent name (case-insensitive substring match).",
    },
    limit: {
      type: "number",
      description: "Maximum results to return (default: 10, max: 50).",
    },
    offset: {
      type: "number",
      description: "Pagination offset (default: 0).",
    },
  },
  ["limit", "offset"],
  async ({ status, query, limit = 10, offset = 0 }) => {
    const maxLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const pageOffset = Number(offset) || 0;
    const q = (query as string | undefined)?.toLowerCase();

    let agents = Array.from(subAgents.values())
      .filter((a) => {
        if (q) return a.name.toLowerCase().includes(q);
        return true;
      })
      .filter((a) => {
        if (status) return a.status === status;
        return true;
      })
      .map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        task: a.task.slice(0, 100) + (a.task.length > 100 ? "..." : ""),
        started_at: new Date(a.startedAt).toISOString(),
        completed_at: a.completedAt ? new Date(a.completedAt).toISOString() : null,
        duration_ms: a.completedAt ? a.completedAt - a.startedAt : Date.now() - a.startedAt,
      }));

    const total = agents.length;
    agents = agents.slice(pageOffset, pageOffset + maxLimit);

    if (agents.length === 0) {
      return { success: true, output: "No sub-agents found." };
    }

    return {
      success: true,
      output: JSON.stringify({ total, count: agents.length, offset: pageOffset, limit: maxLimit, agents }),
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
  "get_agent_logs",
  "Get the output logs of a sub-agent by its ID. Use start_line/end_line to read specific line ranges (1-indexed, inclusive), or tail to get the last N lines.",
  {
    agent_id: {
      type: "string",
      description: "The ID of the sub-agent",
    },
    start_line: {
      type: "number",
      description: "Start line (1-indexed, inclusive). Use with end_line to read a range.",
    },
    end_line: {
      type: "number",
      description: "End line (1-indexed, inclusive). Use with start_line to read a range.",
    },
    tail: {
      type: "number",
      description: "Get last N lines (default: 100). Use this OR start_line/end_line, not both.",
    },
    max_length: {
      type: "number",
      description: "Truncate output to N characters (default: 5000, max: 30000)",
    },
  },
  ["agent_id", "start_line", "end_line", "tail", "max_length"],
  async ({ agent_id, start_line, end_line, tail = 100, max_length = 5000 }) => {
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

      let selectedLines: string[];
      let rangeLabel: string;
      if (start_line !== undefined || end_line !== undefined) {
        const start = Math.max(1, Number(start_line) || 1) - 1;
        const end = end_line !== undefined ? Number(end_line) : lines.length;
        selectedLines = lines.slice(start, end);
        rangeLabel = `lines ${start + 1}–${end} of ${lines.length}`;
      } else {
        selectedLines = lines.slice(-Math.max(1, Number(tail) || 100));
        rangeLabel = `last ${Math.min(Number(tail) || 100, lines.length)} lines of ${lines.length}`;
      }

      let output = selectedLines.join("\n");
      const safeMaxLen = Math.min(Math.max(Number(max_length) || 5000, 100), 30000);
      if (output.length > safeMaxLen) {
        output = output.slice(0, safeMaxLen) + "\n... (truncated)";
      }

      return {
        success: true,
        output: `Agent: ${agentInfo.name} [${agentInfo.status.toUpperCase()}]\nTask: ${agentInfo.task.slice(0, 200)}${agentInfo.task.length > 200 ? "..." : ""}\n\n--- Output (${rangeLabel}, max ${safeMaxLen} chars) ---\n${output || "(no output)"}`,
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
// Tool: Agent Report
// ============================================================================

registerTool(
  "get_agent_report",
  "Get a sub-agent's structured result, status, or error by ID. Use to check on sub-agents you spawned earlier — returns status, result data, and any error message.",
  {
    agent_id: {
      type: "string",
      description: "The ID of the sub-agent",
    },
  },
  ["agent_id"],
  async ({ agent_id }) => {
    const agentInfo = subAgents.get(agent_id);
    if (!agentInfo) {
      return {
        success: false,
        output: "",
        error: `Agent ${agent_id} not found. Use list_agents to see available agents.`,
      };
    }
    return {
      success: true,
      output: JSON.stringify(
        {
          id: agentInfo.id,
          name: agentInfo.name,
          status: agentInfo.status,
          task: agentInfo.task.slice(0, 500),
          result: agentInfo.result ?? null,
          error: agentInfo.error ?? null,
          startedAt: new Date(agentInfo.startedAt).toISOString(),
          completedAt: agentInfo.completedAt ? new Date(agentInfo.completedAt).toISOString() : null,
        },
        null,
        2,
      ),
    };
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

// ============================================================================
// Skill Review Trigger (registered by skill-review-plugin on init)
// ============================================================================

/** Module-level registry for the skill-review plugin's manual trigger function. */
let skillReviewTrigger: (() => Promise<void>) | null = null;

/**
 * Register the skill-review plugin's manual trigger function.
 * Called by the plugin during `onInit`.
 */
export function registerSkillReviewTrigger(fn: () => Promise<void>): void {
  skillReviewTrigger = fn;
}

/**
 * Unregister on plugin shutdown.
 */
export function unregisterSkillReviewTrigger(): void {
  skillReviewTrigger = null;
}

registerTool(
  "trigger_skill_review",
  "Manually trigger a skill review. Analyzes recent conversation for patterns worth capturing as skills. Results are auto-saved as project skills. Use this when you've discovered important patterns that should become reusable skills.",
  {
    focus: {
      type: "string",
      description: "Optional focus area: 'corrections', 'workflows', 'patterns', 'all'",
      default: "all",
    },
  },
  ["focus"],
  async ({ focus }) => {
    if (!skillReviewTrigger) {
      return {
        success: false,
        output: "",
        error: "Skill review plugin is not enabled. Configure skillReview in the agent config to enable it.",
      };
    }

    try {
      await skillReviewTrigger();
      return {
        success: true,
        output: `Skill review triggered (focus: ${focus ?? "all"}). Results will be saved to .clawd/skills/ when complete.`,
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `Skill review failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
);
