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

import { arch as osArch, userInfo as osUserInfo } from "node:os";
import type { AgentFileConfig } from "../agents/loader";
import { listAgentFiles } from "../agents/loader";
import { CLAUDE_CODE_RUNTIME_BLOCK, MAIN_AGENT_RUNTIME_BLOCK } from "./shared";

// ============================================================================
// Helpers
// ============================================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ============================================================================
// Types
// ============================================================================

export interface PromptContext {
  agentId: string;
  channel: string;
  projectRoot: string;
  isSpaceAgent: boolean;
  availableTools: string[];
  platform: string;
  model: string;
  gitRepo: boolean;
  browserEnabled: boolean;
  contextMode: boolean;
  agentFileConfig?: AgentFileConfig;
  /** Other agents in the same channel (excluding self) */
  otherAgents?: (AgentFileConfig & { status?: string })[];
  /** Map of agent_id -> status for quick lookup */
  otherAgentStatuses?: Record<string, { status: string; hibernate_until?: string | null }>;
  /** Whether this agent is running in a git worktree */
  worktreeEnabled?: boolean;
  /** Worktree branch name, e.g., "clawd/a3f7b2" */
  worktreeBranch?: string;
  /**
   * MCP tool name prefix for Claude Code SDK agents where tools are exposed
   * via MCP (e.g. "mcp__clawd__"). Leave undefined for clawd-chat agents
   * where tools are injected directly without a prefix.
   */
  mcpPrefix?: string;
  /**
   * Whether the agent receives channel messages as role-structured SDK input
   * (CC agent: each message is a separate user-role turn with "[ts] author: text"
   * content). When false/undefined the messages come via the legacy preamble
   * format with `## Previously Seen` / `## New Messages` sections in a single
   * prompt string (non-CC agents). The chat section adapts instructions to
   * match — misleading an agent about where its messages live will make it
   * fail to recognise incoming input.
   */
  roleStructuredInput?: boolean;
}

// ============================================================================
// Tool availability helpers
// ============================================================================

function hasTool(ctx: PromptContext, ...names: string[]): boolean {
  return names.some((n) => ctx.availableTools.includes(n));
}

const hasGitTools = (ctx: PromptContext) => hasTool(ctx, "git_status", "git_commit");
const hasSpawnAgent = (ctx: PromptContext) => hasTool(ctx, "spawn_agent");
const hasTaskTools = (ctx: PromptContext) => hasTool(ctx, "todo_write", "todo_read");
const hasSkillTools = (ctx: PromptContext) => hasTool(ctx, "skill_activate", "skill_list") || !!ctx.mcpPrefix;

// ============================================================================
// Section: Identity
// ============================================================================

function sectionIdentity(ctx: PromptContext): string {
  if (ctx.isSpaceAgent) {
    return `You are a sub-agent. Focus on completing the assigned task efficiently.`;
  }
  // Claude Code SDK agents use the MCP-prefixed tool name in the runtime block
  const runtimeBlock = ctx.mcpPrefix ? CLAUDE_CODE_RUNTIME_BLOCK : MAIN_AGENT_RUNTIME_BLOCK;

  // Get agent name from config or fallback
  const agentName = ctx.agentFileConfig?.name || "Claw'd";
  const channel = ctx.channel || "unknown";

  // Build other agents section if available (excluding self)
  let otherAgentsSection = "";
  if (ctx.otherAgents && ctx.otherAgents.length > 0) {
    const otherList = ctx.otherAgents
      .filter((a) => a.name !== ctx.agentId) // Exclude self
      .map((a) => {
        const agentStatus = ctx.otherAgentStatuses?.[a.agent_id || ""];
        // Determine display status: active if "ready", otherwise show the status
        const statusLabel = agentStatus?.status === "ready" ? "active" : agentStatus?.status || "unknown";
        // Use XML with CDATA for descriptions (handles multi-line content)
        if (a.description) {
          return `  <agent name="${escapeXml(a.name)}" status="${statusLabel}"><![CDATA[${a.description}]]></agent>`;
        }
        return `  <agent name="${escapeXml(a.name)}" status="${statusLabel}"/>`;
      })
      .join("\n");

    if (otherList) {
      otherAgentsSection = `

<other_agents channel="${channel}">
${otherList}
</other_agents>`;
    }
  }

  return `You are "${agentName}", an autonomous AI assistant connected to a chat channel "${channel}" in our Claw'd platform.${otherAgentsSection}

${runtimeBlock}`;
}

// ============================================================================
// Section: Environment
// ============================================================================

function sectionEnvironment(ctx: PromptContext): string {
  const isWindows = ctx.platform === "win32";
  const shell = isWindows ? process.env.COMSPEC || "cmd.exe" : process.env.SHELL || "/bin/bash";
  const shellType = isWindows
    ? shell.toLowerCase().includes("powershell")
      ? "powershell"
      : "cmd"
    : (shell.split("/").pop() ?? "sh");
  const user = (() => {
    try {
      return osUserInfo().username;
    } catch {
      return "unknown";
    }
  })();
  const runtime = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`;
  const shellSyntaxHint = isWindows ? "PowerShell/cmd syntax" : "bash syntax";

  const lines = ["# Environment"];
  lines.push(`- Working directory (project root): ${ctx.projectRoot}`);
  lines.push(`- Platform: ${ctx.platform} (${osArch()})`);
  lines.push(`- Shell: ${shell} [${shellType}] — use ${shellSyntaxHint} in bash commands`);
  lines.push(`- User: ${user}`);
  lines.push(`- Runtime: ${runtime}`);
  lines.push(`- Git repository: ${ctx.gitRepo ? "yes" : "no"}`);
  lines.push(`- Model: ${ctx.model}`);
  lines.push(`- File tools accept relative paths (resolved from project root) or absolute paths`);
  return lines.join("\n");
}

// ============================================================================
// Section: Tool Usage
// ============================================================================

function sectionToolUsage(ctx: PromptContext): string {
  const rules: string[] = [];
  const p = ctx.mcpPrefix || "";

  // MCP file tools (Phase 2) take precedence over legacy direct file tools.
  // They are sandbox-scoped to the project root and should be used for all file operations.
  if (hasTool(ctx, "file_view")) {
    rules.push(`Use ${p}file_view to read files — NOT bash with cat/head/tail`);
    rules.push(`Use ${p}file_edit or ${p}file_multi_edit to modify files — NOT bash with sed/awk`);
    rules.push(`Use ${p}file_create to write new files — NOT bash with echo/cat heredoc`);
    rules.push(`Use ${p}file_grep for content search — NOT bash with grep/rg`);
    rules.push(`Use ${p}file_glob for file search — NOT bash with find/ls`);
  } else {
    // Legacy direct file tools (clawd-chat agent path)
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
    "NEVER kill, restart, stop, or interfere with the Claw'd server process (clawd) or its supporting services — this is the system you are running on",
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

function sectionChat(ctx: PromptContext): string {
  const p = ctx.mcpPrefix || "";
  const messageFormat = ctx.roleStructuredInput
    ? `- Each NEW channel message arrives as a user-role turn with the content format \`[timestamp] author: text\` (author is \`human\` for a human user, otherwise an agent/system id). Respond only to the new messages in THIS turn — prior turns are shown as conversation history and are already handled. End each turn with ${p}reply_human(text="<reply or [SILENT]>", timestamp="<latest msg ts>") — this delivers the reply AND marks the message processed in one call.`
    : `- The prompt may contain two message sections: \`## Previously Seen (not yet processed)\` (messages you saw last turn but didn't finish processing) and \`## New Messages\` (brand-new messages). End the turn with ${p}reply_human(text=..., timestamp=<latest ts>) to handle both sections in one go.`;
  return `# Communication
- ${p}reply_human(text, timestamp): ends the turn. Delivers visible text AND marks the triggering message processed. channel/agent_id/user auto-injected.
- text="" or text="[SILENT]" skips the visible reply but still ends the turn and marks processed.
- Every turn MUST end with exactly one ${p}reply_human call — otherwise the message re-polls next cycle.
- Do NOT reply in streaming text — your text output is never delivered to users; call ${p}reply_human instead.
- Wrap copiable content (commands, code, URLs, paths) in markdown code blocks.
- On <agent_signal>[HEARTBEAT]</agent_signal>: resume pending work silently, never mention heartbeats in chat.
- If ${p}reply_human fails, RETRY immediately.
- If a system reminder tells you ${p}reply_human was not called (e.g. "Your turn did not end", "Reminder #N", "FINAL NOTICE"), your ONLY permitted next action is ${p}reply_human — no other tool, no analysis, no prose. Call it with text="[SILENT]" and the supplied timestamp if you have nothing to say.
${messageFormat}

## Attachments
- When a message has files attached, you will see a line like \`[Attached files: name1.pdf, screenshot.png]\` after the message text. The filenames appear inline; the file CONTENT is NOT delivered automatically.
- To list attachments: ${p}chat_get_message_files(channel, ts) — returns file ids, names, mimetypes, sizes.
- To read a text/binary attachment: ${p}download_file(file_id) — saves into the project root, then open it with your file-reading tool (e.g. \`file_view\` / \`Read\`).
- To read an image: use the \`read_image\` tool with the file_id directly (do not download first).
- If a message references an attachment but you cannot find it, the human probably attached it to an EARLIER message — check the recent history or ask.`;
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
// Section: Git (isolated branch mode — replaces sectionGit when worktree is active)
// ============================================================================

function sectionWorktree(_ctx: PromptContext): string {
  return `# Git Operations
- Use git_* tools for all git operations — NOT bash for git commands
- Git tools run in sandbox with dedicated SSH key and git config
- Stage specific files by name, not -A or . (prevents leaking secrets/binaries)
- NEVER commit without explicit user request
- NEVER commit files with secrets (.env, credentials)
- Commits automatically include author attribution — no extra setup needed
- If a git operation is blocked, follow the error message guidance`;
}

// ============================================================================
// Section: Sub-Agent Guidance (conditional — only if spawn_agent available)
// ============================================================================

function sectionSubAgents(ctx: PromptContext): string {
  const p = ctx.mcpPrefix || "";

  // Build dynamic agent list
  let agentList = `Built-in agents:
- explore (haiku): Fast read-only agent for file discovery, code search, and codebase exploration without making changes.
- plan (inherit): Research agent for gathering context before creating implementation plans.
- general (inherit): General-purpose agent for complex multi-step tasks needing code modifications or multi-step operations.`;

  try {
    const { getContextConfigRoot } = require("../utils/agent-context");
    const configRoot = getContextConfigRoot() || ctx.projectRoot;
    const custom = listAgentFiles(configRoot).filter(
      (a) => a.name !== "explore" && a.name !== "plan" && a.name !== "general",
    );
    if (custom.length > 0) {
      const customList = custom.map((a) => `- ${a.name}: ${a.description || "no description"}`).join("\n");
      agentList += `\nCustom agents:\n${customList}`;
    }
  } catch {
    /* best-effort */
  }

  const doNotDelegate = [
    "Reading a specific file (use view directly — faster)",
    "Simple grep/glob search (faster than spawning)",
    "Quick targeted change where latency matters",
    "Avoid duplicating work a sub-agent is already doing",
  ];
  if (ctx.mcpPrefix) {
    doNotDelegate.push(`Do NOT use the Agent tool — use ${p}spawn_agent instead for sub-agents`);
  }

  return `# Sub-Agents
Use ${p}spawn_agent to delegate tasks.
Use ${p}list_agents(type="available") to discover all agents.
Use ${p}get_agent_report(agent_id) to read a completed sub-agent's structured result, or ${p}get_agent_logs(agent_id) for raw output logs.

${agentList}

**When to delegate:**
- Task produces verbose output you don't need in context
- Broad codebase exploration needing more than 3 queries
- Independent research paths that can run in parallel
- Self-contained work that returns a summary

**When NOT to delegate:**
${doNotDelegate.map((r) => `- ${r}`).join("\n")}

**Active sub-agents:**
- Before starting any task, check ${p}list_agents for actively-running sub-agents
- Sub-agents report their results back to the main channel when complete
- Never start work that overlaps an in-flight sub-agent's task — wait for its report first

**DO NOT POLL sub-agents.** After spawning, continue with other work. The sub-agent's final report arrives in the chat on its own. Do NOT call ${p}list_agents, ${p}get_agent_report, or ${p}get_agent_logs in a loop waiting for completion — each call burns tokens and wall-clock time for no benefit. Only inspect a sub-agent's state when you have a specific reason (debugging a reported failure, checking before retasking, etc.).`;
}

// ============================================================================
// Section: Task Management (conditional)
// ============================================================================

function sectionTasks(ctx: PromptContext): string {
  const p = ctx.mcpPrefix || "";
  return `# Todo List
You have a personal Todo list to track multi-step work. Skip for quick single-turn tasks.

**When to use:**
- Work requiring 3+ distinct steps → create a Todo list BEFORE starting
- Write all items at once with ${p}todo_write (not one at a time)

**Workflow:**
1. Plan: call ${p}todo_write([{content: "step 1"}, {content: "step 2"}, ...]) — creates your list
2. Work: update items as you go with ${p}todo_update(item_id, "in_progress") then ${p}todo_update(item_id, "completed")
3. Report: after each completed item, tell the user: "Done: [item]. Next: [item]. (3/7)"
4. Finish: when all items completed, the list auto-deletes. Send a final summary.

**Rules:**
- Only ONE active Todo list at a time — complete or clear before creating new
- Keep items short and actionable (imperative: "Add validation", not "Adding validation")
- Use ${p}todo_read to check your current list state`;
}

// ============================================================================
// Section: Skills (conditional — only if skill tools available)
// ============================================================================

function sectionSkills(ctx: PromptContext): string {
  const p = ctx.mcpPrefix || "";
  if (ctx.mcpPrefix) {
    // Claude Code SDK agents: native Skill tool + mcp__clawd__skill_* MCP tools both available
    return `# Skills
Check available skills with the Skill tool or \`${p}skill_list\` before invoking one.

- \`Skill(skill: "name", args: "...")\` — invoke a skill (Claude Code native tool, preferred)
- \`${p}skill_activate(name, args)\` — same as above via MCP
- \`${p}skill_list()\` — list all installed skills
- \`${p}skill_search(query)\` — find a skill by topic
- \`${p}skill_create(name, description, content)\` — create a new skill
- \`${p}skill_delete(name)\` — remove a skill`;
  }
  // Non-CC agents: only mcp skill_ tools (no native Skill tool)
  return `# Skills
- \`${p}skill_list()\` — list all installed skills
- \`${p}skill_search(query)\` — find a skill by topic
- \`${p}skill_activate(name, args)\` — invoke a skill`;
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
// Section: Custom Scripts (conditional — only if scripts exist)
// ============================================================================

function sectionCustomScripts(ctx: PromptContext): string {
  const p = ctx.mcpPrefix || "";
  let count = 0;
  try {
    const { existsSync, readdirSync, statSync } = require("fs");
    const { join } = require("path");
    const toolsDir = join(ctx.projectRoot, ".clawd", "tools");
    if (existsSync(toolsDir)) {
      count = readdirSync(toolsDir).filter((e: string) => {
        const d = join(toolsDir, e);
        return statSync(d).isDirectory() && existsSync(join(d, "tool.json"));
      }).length;
    }
  } catch {
    count = 0;
  }
  if (count === 0) return "";
  return `# Custom Scripts
You have ${count} project-specific custom script${count === 1 ? "" : "s"} available via \`${p}custom_script\`. Always check them before writing ad-hoc solutions — they may already solve your problem.

- \`${p}custom_script(mode="list")\` — see all scripts with descriptions
- \`${p}custom_script(mode="view", tool_id="<id>")\` — inspect a script's code and parameters
- \`${p}custom_script(mode="execute", tool_id="<id>", arguments={...})\` — run a script

You can also add, edit, or delete scripts via \`mode="add"|"edit"|"delete"\`.`;
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
  return `# MANDATORY: Call complete_task When Done
You MUST call complete_task(result) with your final result when the task is complete.
This is the ONLY way to deliver your work. If you don't call it, your work is lost.
Do NOT use reply_human or any chat_* tools — they are not available to sub-agents.`;
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
    sections.push(sectionChat(ctx));

    if (hasGitTools(ctx)) {
      if (ctx.worktreeEnabled && ctx.worktreeBranch) {
        sections.push(sectionWorktree(ctx));
      } else {
        sections.push(sectionGit());
      }
    }
    if (hasSpawnAgent(ctx)) {
      sections.push(sectionSubAgents(ctx));
    }
    if (hasTaskTools(ctx)) {
      sections.push(sectionTasks(ctx));
    }
    sections.push(sectionArtifacts());
    if (hasSkillTools(ctx)) {
      sections.push(sectionSkills(ctx));
    }
  }

  if (ctx.browserEnabled) {
    sections.push(sectionBrowser());
  }

  // Custom scripts hint — shown to all agents (main + space) when scripts exist
  const customScriptsSection = sectionCustomScripts(ctx);
  if (customScriptsSection) {
    sections.push(customScriptsSection);
  }

  sections.push(sectionContext());

  if (ctx.isSpaceAgent) {
    sections.push(sectionSubAgentInstructions());
  }

  return sections.join("\n\n");
}
