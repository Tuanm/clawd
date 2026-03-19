/**
 * Agent File Loader — Claude Code-compatible agent file format
 *
 * Loads agent definitions from markdown files with YAML frontmatter.
 * Four directories scanned in priority order (highest wins on name collision):
 *   1. {projectRoot}/.clawd/agents/{name}.md   (Claw'd project — highest)
 *   2. {projectRoot}/.claude/agents/{name}.md   (Claude Code project)
 *   3. ~/.clawd/agents/{name}.md                (Claw'd global)
 *   4. ~/.claude/agents/{name}.md                (Claude Code global — lowest)
 *
 * File format:
 *   ---
 *   name: agent-name
 *   description: When to use this agent
 *   model: sonnet
 *   tools: [bash, view, grep]
 *   skills: [code-review]
 *   memory: project
 *   ---
 *   # System prompt markdown...
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export type AgentSource = "claude-global" | "clawd-global" | "claude-project" | "clawd-project";

export interface AgentFileConfig {
  name: string;
  description: string;
  provider?: string;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  memory?: "user" | "project" | "local";
  language?: string;
  directives?: string[];
  maxTurns?: number;
  background?: boolean;
  /** All frontmatter fields (including unknown) for forward compat */
  rawFrontmatter: Record<string, unknown>;
  /** Markdown body = system prompt */
  systemPrompt: string;
  /** Which directory this was loaded from */
  source: AgentSource;
  /** Absolute path to the .md file */
  filePath: string;
}

// ============================================================================
// Frontmatter Parser (enhanced — supports multi-line YAML arrays)
// ============================================================================

interface ParsedFrontmatter {
  metadata: Record<string, unknown>;
  body: string;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Supports: strings, numbers, booleans, inline arrays [a, b], multi-line arrays (- item).
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: content };
  }

  const [, yaml, body] = match;
  const metadata: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);

  let currentKey = "";
  let currentArray: string[] | null = null;

  for (const line of lines) {
    // Multi-line array item: "  - value"
    if (currentArray !== null && /^\s+-\s+/.test(line)) {
      currentArray.push(line.replace(/^\s+-\s+/, "").trim());
      continue;
    }

    // If we were collecting a multi-line array, save it
    if (currentArray !== null) {
      metadata[currentKey] = currentArray;
      currentArray = null;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (!key) continue;
    currentKey = key;

    // Empty value after colon → start multi-line array
    if (rawValue === "") {
      currentArray = [];
      continue;
    }

    // Inline array: [a, b, c]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      metadata[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      continue;
    }

    // Boolean
    if (rawValue === "true") {
      metadata[key] = true;
      continue;
    }
    if (rawValue === "false") {
      metadata[key] = false;
      continue;
    }

    // Number (integers only — avoid float confusion with version strings)
    if (/^\d+$/.test(rawValue)) {
      metadata[key] = Number.parseInt(rawValue, 10);
      continue;
    }

    // String (strip optional quotes)
    metadata[key] = rawValue.replace(/^["']|["']$/g, "");
  }

  // Flush trailing multi-line array
  if (currentArray !== null) {
    metadata[currentKey] = currentArray;
  }

  return { metadata, body };
}

// ============================================================================
// Agent File Parser
// ============================================================================

/**
 * Parse a single agent .md file into AgentFileConfig.
 * Returns null if file is malformed or missing required fields.
 */
export function parseAgentFile(filePath: string, source: AgentSource): AgentFileConfig | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const { metadata, body } = parseFrontmatter(content);

  // Name: from frontmatter, or derive from filename
  const name = typeof metadata.name === "string" ? metadata.name : basename(filePath, ".md");

  // Description is required for Claude Code compat, but we're lenient
  const description = typeof metadata.description === "string" ? metadata.description : "";

  if (!name) {
    console.warn(`[Agent Loader] Skipping ${filePath}: missing name`);
    return null;
  }

  return {
    name,
    description,
    provider: typeof metadata.provider === "string" ? metadata.provider : undefined,
    model: typeof metadata.model === "string" ? metadata.model : undefined,
    tools: Array.isArray(metadata.tools) ? (metadata.tools as string[]) : undefined,
    disallowedTools: Array.isArray(metadata.disallowedTools) ? (metadata.disallowedTools as string[]) : undefined,
    skills: Array.isArray(metadata.skills) ? (metadata.skills as string[]) : undefined,
    memory: isMemoryScope(metadata.memory) ? metadata.memory : undefined,
    language: typeof metadata.language === "string" ? metadata.language : undefined,
    directives: Array.isArray(metadata.directives) ? (metadata.directives as string[]) : undefined,
    maxTurns: typeof metadata.maxTurns === "number" ? metadata.maxTurns : undefined,
    background: typeof metadata.background === "boolean" ? metadata.background : undefined,
    rawFrontmatter: metadata,
    systemPrompt: body.trim(),
    source,
    filePath,
  };
}

function isMemoryScope(v: unknown): v is "user" | "project" | "local" {
  return v === "user" || v === "project" || v === "local";
}

/** Validate agent name: no path traversal, no slashes, safe for filesystem */
const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name) && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

// ============================================================================
// Directory Resolution
// ============================================================================

interface AgentDir {
  dir: string;
  source: AgentSource;
}

/**
 * Get agent directories in priority order (lowest → highest).
 * Later entries override earlier ones on name collision.
 */
export function getAgentDirs(projectRoot: string): AgentDir[] {
  return [
    { dir: join(homedir(), ".claude", "agents"), source: "claude-global" },
    { dir: join(homedir(), ".clawd", "agents"), source: "clawd-global" },
    { dir: join(projectRoot, ".claude", "agents"), source: "claude-project" },
    { dir: join(projectRoot, ".clawd", "agents"), source: "clawd-project" },
  ];
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List all available agent files, deduplicated by name (highest priority wins).
 */
export function listAgentFiles(projectRoot: string): AgentFileConfig[] {
  const dirs = getAgentDirs(projectRoot);
  const agentMap = new Map<string, AgentFileConfig>();

  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }

    for (const filename of entries) {
      const filePath = join(dir, filename);
      const agent = parseAgentFile(filePath, source);
      if (agent) {
        // Later entries (higher priority) overwrite earlier ones
        agentMap.set(agent.name, agent);
      }
    }
  }

  return Array.from(agentMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load a single agent by name from the highest-priority directory.
 * Returns null if no agent file found.
 */
export function loadAgentFile(name: string, projectRoot: string): AgentFileConfig | null {
  if (!isValidAgentName(name)) {
    console.warn(`[Agent Loader] Invalid agent name: ${name}`);
    return null;
  }
  // Search in reverse priority order (highest first) for early exit
  const dirs = getAgentDirs(projectRoot).reverse();

  for (const { dir, source } of dirs) {
    const filePath = join(dir, `${name}.md`);
    if (!existsSync(filePath)) continue;
    const agent = parseAgentFile(filePath, source);
    if (agent) return agent;
  }

  return null;
}

/**
 * Build a complete system prompt for an agent, including identity, directives,
 * language, and awareness of other agents in the project.
 */
export function buildAgentSystemPrompt(agent: AgentFileConfig, allAgents: AgentFileConfig[]): string {
  const sections: string[] = [];

  // 1. Identity header
  sections.push(
    `## YOUR IDENTITY — FOLLOW STRICTLY\n\nYou ARE "${agent.name}". You MUST stay in character at ALL times.`,
  );

  // 2. Description
  if (agent.description) {
    sections.push(agent.description);
  }

  // 3. System prompt body
  if (agent.systemPrompt) {
    sections.push(agent.systemPrompt);
  }

  // 4. Standing directives
  if (agent.directives && agent.directives.length > 0) {
    sections.push(
      `### Standing Directives\n\nThese are your standing behavioral rules. Follow them at ALL times:\n\n${agent.directives.map((d) => `- ${d}`).join("\n")}`,
    );
  }

  // 5. Language directive
  if (agent.language) {
    sections.push(`You MUST communicate in language: "${agent.language}".`);
  }

  // 6. Other agents awareness
  const others = allAgents
    .filter((a) => a.name !== agent.name)
    .map((a) => `- **${a.name}**: ${a.description || "No description"}`);

  if (others.length > 0) {
    sections.push(`## Other Agents in This Project\n\n${others.join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Resolve a model alias to a full model ID.
 * Aliases: sonnet, opus, haiku, inherit (returns parentModel).
 * Full model IDs pass through unchanged.
 */
export function resolveModelAlias(alias: string, parentModel: string): string {
  const ALIASES: Record<string, string> = {
    sonnet: "claude-sonnet-4.6",
    opus: "claude-opus-4.6",
    haiku: "claude-haiku-4.5",
    inherit: parentModel,
  };
  return ALIASES[alias] || alias;
}

// ============================================================================
// Tool Name Alias Map (Claude Code → Claw'd)
// ============================================================================

/**
 * Maps Claude Code tool names to Claw'd equivalents.
 * Claude Code uses PascalCase; Claw'd uses snake_case.
 * Tools with no mapping pass through unchanged (case-insensitive match).
 */
const TOOL_ALIASES: Record<string, string> = {
  // Core file tools
  Read: "view",
  Write: "create",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  Bash: "bash",
  // Notebook
  NotebookEdit: "edit",
  // Web tools
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  // Agent/task tools
  Agent: "spawn_agent",
  TaskCreate: "task_add",
  TaskGet: "task_get",
  TaskList: "task_list",
  TaskUpdate: "task_update",
  TaskOutput: "agent_logs",
  TaskStop: "kill_agent",
  TodoWrite: "task_add",
  // Skill tool
  Skill: "skill_activate",
  // MCP tools
  ListMcpResourcesTool: "list_mcp_resources",
  ReadMcpResourceTool: "read_mcp_resource",
  ToolSearch: "tool_search",
  // Plan/worktree (no direct Claw'd equivalents — pass through)
  // EnterPlanMode, ExitPlanMode, EnterWorktree, ExitWorktree
  // Cron tools
  CronCreate: "job_submit",
  CronDelete: "job_cancel",
  CronList: "task_list",
  // Message tool (Claude Code SendMessage → Claw'd chat_send_message)
  SendMessage: "chat_send_message",
  // Question tool
  AskUserQuestion: "chat_send_message",
};

/**
 * Resolve a Claude Code tool name to Claw'd equivalent.
 * Returns the Claw'd tool name, or the original name lowercased if no alias.
 */
export function resolveToolAlias(name: string): string {
  return TOOL_ALIASES[name] || name.toLowerCase();
}

/**
 * Resolve a list of tool names from agent file (may contain Claude Code names)
 * to Claw'd-compatible names. Deduplicates after resolution.
 */
export function resolveToolAliases(names: string[]): string[] {
  const resolved = new Set<string>();
  for (const name of names) {
    resolved.add(resolveToolAlias(name));
  }
  return Array.from(resolved);
}
