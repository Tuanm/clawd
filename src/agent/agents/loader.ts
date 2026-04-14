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
import { mapModelName } from "../api/provider-config";

// ============================================================================
// Types
// ============================================================================

export type AgentSource = "built-in" | "claude-global" | "clawd-global" | "claude-project" | "clawd-project";

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
// Built-in Agents (lowest priority — overridable by any directory)
// ============================================================================

const BUILTIN_AGENTS: AgentFileConfig[] = [
  {
    name: "explore",
    description:
      "Fast read-only agent for searching and analyzing codebases. Use for file discovery, code search, and codebase exploration without making changes.",
    model: "haiku",
    tools: ["view", "grep", "glob", "bash", "today", "get_environment", "web_search", "web_fetch"],
    disallowedTools: ["edit", "create", "custom_script"],
    systemPrompt: `You are a fast, read-only codebase explorer. Your job is to search, read, and analyze code efficiently.

When invoked, determine the thoroughness needed:
- **Quick**: Targeted lookup — find a specific file, function, or pattern
- **Medium**: Balanced exploration — understand a module or feature
- **Thorough**: Comprehensive analysis — map dependencies, trace data flow, audit patterns

Guidelines:
- Use grep for content search, glob for file discovery, view for reading files
- Use bash for git log, wc, find, or other read-only commands
- Summarize findings concisely — the main agent needs actionable information, not raw output
- Never modify files — you are read-only`,
    source: "built-in",
    filePath: "(built-in)",
    rawFrontmatter: {},
  },
  {
    name: "plan",
    description:
      "Research agent for gathering context before creating implementation plans. Use when planning features or changes that need codebase understanding first.",
    model: "inherit",
    tools: ["view", "grep", "glob", "bash", "today", "get_environment", "web_search", "web_fetch"],
    disallowedTools: ["edit", "create", "custom_script"],
    systemPrompt: `You are a planning research agent. Your job is to gather codebase context needed for implementation planning.

When invoked:
1. Understand what is being planned (feature, refactor, fix)
2. Explore relevant code: architecture, patterns, dependencies
3. Identify files that would need changes
4. Note constraints, risks, and existing patterns to follow
5. Return a structured research summary

Focus on:
- Current architecture and how the planned work fits in
- Existing patterns the implementation should follow
- Dependencies and potential impact areas
- Technical constraints or blockers

Return findings as a structured report, not raw code. The main agent will use your research to create the actual plan.`,
    source: "built-in",
    filePath: "(built-in)",
    rawFrontmatter: {},
  },
  {
    name: "general",
    description:
      "Capable general-purpose agent for complex multi-step tasks requiring both exploration and action. Use for tasks needing code modifications, multi-step operations, or complex reasoning.",
    model: "inherit",
    systemPrompt: `You are a capable general-purpose agent. You can explore codebases, modify files, run commands, and complete complex multi-step tasks.

When invoked:
1. Understand the task fully before acting
2. Explore relevant code to build context
3. Implement changes carefully with verification
4. Test your changes when possible
5. Return a clear summary of what you did and any remaining items

Guidelines:
- Read before writing — understand existing patterns first
- Make minimal, focused changes
- Verify changes compile/pass basic checks before reporting completion
- If the task is ambiguous, make reasonable assumptions and state them`,
    source: "built-in",
    filePath: "(built-in)",
    rawFrontmatter: {},
  },
];

/** Get a built-in agent by name */
export function getBuiltinAgent(name: string): AgentFileConfig | null {
  return BUILTIN_AGENTS.find((a) => a.name === name) || null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List all available agent files, deduplicated by name (highest priority wins).
 */
// Cache listAgentFiles results per projectRoot with 60s TTL
const agentFilesCache = new Map<string, { result: AgentFileConfig[]; ts: number }>();
const AGENT_FILES_CACHE_TTL = 60_000;

/** Clear the agent files cache (call after save/delete operations) */
export function clearAgentFilesCache(): void {
  agentFilesCache.clear();
}

/**
 * List global agent files only (no project root needed).
 * Scans ~/.claude/agents/ + ~/.clawd/agents/ + built-ins.
 * Used by the agent-files management API.
 */
export function listGlobalAgentFiles(): AgentFileConfig[] {
  const cacheKey = "__global__";
  const cached = agentFilesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AGENT_FILES_CACHE_TTL) {
    return cached.result;
  }

  const globalDirs: AgentDir[] = [
    { dir: join(homedir(), ".claude", "agents"), source: "claude-global" },
    { dir: join(homedir(), ".clawd", "agents"), source: "clawd-global" },
  ];
  const agentMap = new Map<string, AgentFileConfig>();

  // Seed with built-in agents (lowest priority)
  for (const agent of BUILTIN_AGENTS) {
    agentMap.set(agent.name, agent);
  }

  // Scan global dirs (lower priority first, higher overrides)
  for (const { dir, source } of globalDirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const filename of entries) {
      const agent = parseAgentFile(join(dir, filename), source);
      if (agent) agentMap.set(agent.name, agent);
    }
  }

  const result = Array.from(agentMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  agentFilesCache.set(cacheKey, { result, ts: Date.now() });
  return result;
}

export function listAgentFiles(projectRoot: string): AgentFileConfig[] {
  const cached = agentFilesCache.get(projectRoot);
  if (cached && Date.now() - cached.ts < AGENT_FILES_CACHE_TTL) {
    return cached.result;
  }

  const dirs = getAgentDirs(projectRoot);
  const agentMap = new Map<string, AgentFileConfig>();

  // Seed with built-in agents (lowest priority — overridden by any directory)
  for (const agent of BUILTIN_AGENTS) {
    agentMap.set(agent.name, agent);
  }

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
        agentMap.set(agent.name, agent);
      }
    }
  }

  const result = Array.from(agentMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  agentFilesCache.set(projectRoot, { result, ts: Date.now() });
  return result;
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

  // Fall back to built-in agents
  return getBuiltinAgent(name);
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
 *
 * When `provider` is provided, checks ~/.clawd/config.json's
 * `providers.{provider}.models.{alias}` first (so haiku maps to the
 * provider's configured model, not always claude-haiku-4-5).
 * Falls back to hardcoded defaults only when config has no mapping.
 */
export function resolveModelAlias(alias: string, parentModel: string, provider?: string): string {
  if (alias === "inherit") return parentModel;

  // Check config first — respects provider-specific model mappings from config.json
  const configModel = mapModelName(alias, provider);
  if (configModel !== alias) return configModel;

  // Fall back to hardcoded defaults only when config has no entry
  const ALIASES: Record<string, string> = {
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-6",
    haiku: "claude-haiku-4-5",
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
  MultiEdit: "multi_edit",
  Glob: "glob",
  Grep: "grep",
  LS: "glob",
  Bash: "bash",
  // Notebook
  NotebookEdit: "edit",
  // Web tools
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  // Agent/sub-agent tools
  Agent: "spawn_agent",
  TaskCreate: "todo_write",
  TaskGet: "todo_read",
  TaskList: "todo_read",
  TaskUpdate: "todo_update",
  TaskOutput: "get_agent_logs",
  TaskStop: "stop_agent",
  TodoWrite: "todo_write",
  // Skill tool
  Skill: "skill_activate",
  // MCP tools
  ListMcpResourcesTool: "list_mcp_resources",
  ReadMcpResourceTool: "read_mcp_resource",
  ToolSearch: "tool_search",
  // Cron/scheduler tools
  CronCreate: "schedule_job",
  CronDelete: "schedule_cancel",
  CronList: "schedule_list",
  // Message/communication tools
  SendMessage: "chat_send_message",
  AskUserQuestion: "chat_send_message",
  // Plan/worktree (pass through — no direct Claw'd equivalents)
  // EnterPlanMode, ExitPlanMode, EnterWorktree, ExitWorktree
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
