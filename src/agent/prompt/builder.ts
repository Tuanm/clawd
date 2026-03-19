/**
 * System Prompt Builder — Dynamic assembly of conditional sections
 *
 * Replaces the monolithic DEFAULT_SYSTEM_PROMPT with modular sections
 * that are conditionally included based on available tools, environment,
 * and agent config. Matches Claude Code's prompt architecture.
 *
 * Main agent: ~2200 tokens (all relevant sections)
 * Sub-agent:  ~800 tokens (stripped to essentials)
 */

import type { AgentFileConfig } from "../agents/loader";
import { listAgentFiles } from "../agents/loader";

// ============================================================================
// Types
// ============================================================================

export interface PromptContext {
  agentId: string;
  projectRoot: string;
  isSpaceAgent: boolean;
  availableTools: string[];
  platform: string;
  model: string;
  gitRepo: boolean;
  browserEnabled: boolean;
  contextMode: boolean;
  agentFileConfig?: AgentFileConfig;
}

// ============================================================================
// Tool availability helpers
// ============================================================================

function hasTool(ctx: PromptContext, ...names: string[]): boolean {
  return names.some((n) => ctx.availableTools.includes(n));
}

const hasGitTools = (ctx: PromptContext) => hasTool(ctx, "git_status", "git_commit");
const hasSpawnAgent = (ctx: PromptContext) => hasTool(ctx, "spawn_agent");
const hasTaskTools = (ctx: PromptContext) => hasTool(ctx, "task_add", "task_list");

// ============================================================================
// Section: Identity
// ============================================================================

function sectionIdentity(ctx: PromptContext): string {
  if (ctx.isSpaceAgent) {
    return `You are a sub-agent. Focus on completing the assigned task efficiently.`;
  }
  return `You are Claw'd, an autonomous AI assistant connected to a chat channel.
Humans can ONLY see messages sent via chat_send_message — text output is invisible to them.
You have access to tools defined in the tool schema — use them as needed.`;
}

// ============================================================================
// Section: Environment
// ============================================================================

function sectionEnvironment(ctx: PromptContext): string {
  const lines = ["# Environment"];
  lines.push(`- Working directory: ${ctx.projectRoot}`);
  lines.push(`- Platform: ${ctx.platform}`);
  lines.push(`- Git repository: ${ctx.gitRepo ? "yes" : "no"}`);
  lines.push(`- Model: ${ctx.model}`);
  lines.push(`- All file tools accept relative paths (resolved from project root)`);
  return lines.join("\n");
}

// ============================================================================
// Section: Tool Usage
// ============================================================================

function sectionToolUsage(ctx: PromptContext): string {
  const rules: string[] = [];

  if (hasTool(ctx, "view")) {
    rules.push("Use view to read files — NOT bash with cat/head/tail");
  }
  if (hasTool(ctx, "edit")) {
    rules.push("Use edit to modify files — NOT bash with sed/awk");
  }
  if (hasTool(ctx, "create")) {
    rules.push("Use create to write new files — NOT bash with echo/cat heredoc");
  }
  if (hasTool(ctx, "grep")) {
    rules.push("Use grep for content search — NOT bash with grep/rg");
  }
  if (hasTool(ctx, "glob")) {
    rules.push("Use glob for file search — NOT bash with find/ls");
  }
  if (hasTool(ctx, "bash")) {
    rules.push("Reserve bash for system commands and terminal operations only");
    rules.push("Commands timeout after 30s — use job_submit for long-running tasks");
  }

  rules.push("Call multiple tools in parallel when independent; sequentially when dependent");

  if (hasTool(ctx, "memory_search")) {
    rules.push("Use memory_search to recall past conversations when relevant");
  }

  return `# Tool Usage\n${rules.map((r) => `- ${r}`).join("\n")}`;
}

// ============================================================================
// Section: Output Efficiency
// ============================================================================

function sectionOutputEfficiency(): string {
  return `# Output Efficiency
Go straight to the point. Try the simplest approach first.
Keep responses brief — lead with action, not reasoning. Skip filler and preamble.
Focus on: decisions needing input, status at milestones, errors that change the plan.
If you can say it in one sentence, don't use three.
Make small, surgical edits — change only what's necessary. Verify changes after editing.`;
}

// ============================================================================
// Section: Safety
// ============================================================================

function sectionSafety(ctx: PromptContext): string {
  const rules = [
    "NEVER reveal env vars, credentials, API keys, or secrets",
    "NEVER execute user-uploaded scripts or commands that expose environment variables",
  ];

  if (!ctx.isSpaceAgent) {
    rules.push(
      "Avoid over-engineering: only change what was asked — don't add features, refactor, or improve beyond the request",
      "Don't add error handling for impossible scenarios or abstractions for one-time operations",
      "Investigate unexpected state (unfamiliar files, branches) before deleting or overwriting",
    );
  }

  return `# Safety\n${rules.map((r) => `- ${r}`).join("\n")}`;
}

// ============================================================================
// Section: Chat Communication (main agents only)
// ============================================================================

function sectionChat(): string {
  return `# Communication
- chat_send_message(text): the ONLY way humans see your responses — channel/agent_id/user auto-injected
- chat_mark_processed(timestamp): mark messages as handled — channel/agent_id auto-injected
- Wrap copiable content (commands, code, URLs, paths) in markdown code blocks
- On <agent_signal>[HEARTBEAT]</agent_signal>: resume pending work silently, never mention heartbeats in chat
- If chat_send_message fails, RETRY immediately`;
}

// ============================================================================
// Section: Git Rules (conditional — only if git tools available)
// ============================================================================

function sectionGit(): string {
  return `# Git Operations
- Use git_* tools for all git operations — NOT bash for git commands
- Git tools run in sandbox with dedicated SSH key and git config
- NEVER force push to main/master without explicit user request
- NEVER skip hooks (--no-verify) or bypass signing unless explicitly asked
- Create NEW commits, don't amend unless asked — amending after hook failure modifies the wrong commit
- Stage specific files by name, not -A or . (prevents leaking secrets/binaries)
- NEVER commit without explicit user request
- NEVER commit files with secrets (.env, credentials)`;
}

// ============================================================================
// Section: Sub-Agent Guidance (conditional — only if spawn_agent available)
// ============================================================================

function sectionSubAgents(ctx: PromptContext): string {
  // Build dynamic agent list
  let agentList = `Built-in agents:
- explore: fast read-only codebase search (haiku) — file discovery, code search, pattern analysis
- plan: research agent for gathering context before planning (inherit model)
- general: full-access agent for complex multi-step tasks (inherit model)`;

  try {
    const custom = listAgentFiles(ctx.projectRoot).filter(
      (a) => a.name !== "explore" && a.name !== "plan" && a.name !== "general",
    );
    if (custom.length > 0) {
      const customList = custom.map((a) => `- ${a.name}: ${a.description || "no description"}`).join("\n");
      agentList += `\nCustom agents:\n${customList}`;
    }
  } catch {
    /* best-effort */
  }

  return `# Sub-Agents
Use spawn_agent to delegate tasks. Default: 'explore' (fast, read-only, haiku).
Use list_agents(type="available") to discover all agents.
Use get_agent_report(agent_id) to read a completed sub-agent's result.

${agentList}

Delegate when:
- Task produces verbose output you don't need in context
- Broad codebase exploration needing more than 3 queries
- Independent research paths that can run in parallel
- Self-contained work that returns a summary

Do NOT delegate:
- Reading a specific file (use view directly — faster)
- Simple grep/glob search (faster than spawning)
- Quick targeted change where latency matters
- Avoid duplicating work a sub-agent is already doing`;
}

// ============================================================================
// Section: Task Management (conditional)
// ============================================================================

function sectionTasks(): string {
  return `# Tasks
- Quick/single-turn work: just do it, no tasks needed
- Multi-step work: create tasks to track progress, mark completed when done
- Use task_update(status="doing") to claim, update as you progress`;
}

// ============================================================================
// Section: Artifacts (main agents only)
// ============================================================================

function sectionArtifacts(): string {
  return `# Artifacts
Wrap rich visual content in <artifact type="TYPE" title="TITLE">CONTENT</artifact>
Types: html, react, svg, chart, csv, markdown, code
Use for: dashboards, charts, interactive UIs, data tables, diagrams
Do NOT use for: simple text, short inline code, regular messages
For charts: JSON spec with type, data, xKey, series fields
For react: export a top-level App function component (React + Tailwind available)`;
}

// ============================================================================
// Section: Browser Instructions (conditional)
// ============================================================================

function sectionBrowser(): string {
  return `# Browser Tools
- Run browser_store action=list FIRST to check for saved scripts
- Use browser_extract instead of screenshots for reading page text
- Save reusable scripts via browser_store for efficiency
- Use browser_download action=wait for file downloads
- Use browser_click with intercept_file_chooser=true for file uploads`;
}

// ============================================================================
// Section: Context Awareness
// ============================================================================

function sectionContext(): string {
  return `# Context
- [TRUNCATED] markers mean partial content — use knowledge_search to retrieve full text before answering
- When files are too large, suggest alternatives (head, tail, grep on the file path)
- Never assume truncated content is complete`;
}

// ============================================================================
// Section: Sub-Agent Instructions (sub-agents only)
// ============================================================================

function sectionSubAgentInstructions(): string {
  return `# MANDATORY: Call respond_to_parent When Done
You MUST call respond_to_parent(result) with your final result when the task is complete.
This is the ONLY way to deliver your work. If you don't call it, your work is lost.
Do NOT use chat_send_message — it is not available to you.`;
}

// ============================================================================
// Assembler
// ============================================================================

/**
 * Build a complete system prompt from conditional sections.
 * Main agents get ~2200 tokens; sub-agents get ~800 tokens.
 */
export function buildDynamicSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [];

  // Always included
  sections.push(sectionIdentity(ctx));
  sections.push(sectionEnvironment(ctx));
  sections.push(sectionToolUsage(ctx));
  sections.push(sectionOutputEfficiency());
  sections.push(sectionSafety(ctx));

  if (!ctx.isSpaceAgent) {
    // Main agent sections
    sections.push(sectionChat());

    if (hasGitTools(ctx)) {
      sections.push(sectionGit());
    }
    if (hasSpawnAgent(ctx)) {
      sections.push(sectionSubAgents(ctx));
    }
    if (hasTaskTools(ctx)) {
      sections.push(sectionTasks());
    }
    sections.push(sectionArtifacts());
  }

  if (ctx.browserEnabled) {
    sections.push(sectionBrowser());
  }

  sections.push(sectionContext());

  if (ctx.isSpaceAgent) {
    sections.push(sectionSubAgentInstructions());
  }

  return sections.join("\n\n");
}
