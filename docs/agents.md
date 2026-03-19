# Agents

Agents are persistent AI personalities defined in markdown files with YAML frontmatter. Each agent file contains a system prompt, model preference, tool restrictions, and behavioral directives. Agents can be assigned to chat channels or spawned as sub-agents for specific tasks.

Agent files are compatible with Claude Code's agent format — the same files work in both tools.

---

## Quick Start

### Create an Agent Manually

Create a markdown file in your project:

```
{projectRoot}/.clawd/agents/code-reviewer.md
```

```markdown
---
name: code-reviewer
description: Reviews code for quality, security, and best practices
model: sonnet
tools: [bash, view, grep, glob, git_diff, git_status]
---

You are a senior code reviewer. When invoked:

1. Run `git diff` to see recent changes
2. Focus on modified files
3. Review for: security issues, performance problems, readability, test coverage

Provide feedback organized by priority:
- **Critical** (must fix)
- **Warning** (should fix)
- **Suggestion** (consider improving)
```

### Create a Global Agent

Save to `~/.clawd/agents/` to make it available across all projects:

```
~/.clawd/agents/debugger.md
```

---

## Agent File Format

```markdown
---
name: agent-name
description: When to use this agent
model: sonnet
tools: [bash, view, grep, glob]
disallowedTools: [create]
skills: [deploy-checklist]
memory: project
language: en
directives:
  - Always respond concisely
  - Never modify test files
maxTurns: 50
background: false
---

System prompt markdown goes here...
```

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique identifier (lowercase, hyphens, underscores) |
| `description` | string | Yes | When to delegate to this agent — shown to other agents for awareness |
| `model` | string | No | `sonnet`, `opus`, `haiku`, `inherit`, or full model ID (e.g., `claude-sonnet-4.6`). Defaults to `inherit` |
| `tools` | string[] | No | Tool allowlist — only these tools available. Inherits all if omitted |
| `disallowedTools` | string[] | No | Tool denylist — removed from available tools |
| `skills` | string[] | No | Skills preloaded into agent context at startup |
| `memory` | string | No | Persistent memory scope: `user`, `project`, or `local` |
| `language` | string | No | Language the agent must communicate in |
| `directives` | string[] | No | Standing behavioral rules injected into every session |
| `maxTurns` | number | No | Maximum agentic turns before stopping (0 = unlimited) |
| `background` | boolean | No | Always run as background sub-agent (default: false) |

Unknown frontmatter fields are preserved for forward compatibility with future Claude Code features.

### Body Content

Everything after the closing `---` is the agent's system prompt. Write it as markdown instructions that define the agent's personality, behavior, and workflow.

---

## Source Directories & Priority

Agent files are loaded from 4 directories. Same-name agents in higher-priority directories override lower ones:

| Priority | Path | Scope |
|----------|------|-------|
| 1 (lowest) | `~/.claude/agents/{name}.md` | Claude Code global |
| 2 | `~/.clawd/agents/{name}.md` | Claw'd global |
| 3 | `{projectRoot}/.claude/agents/{name}.md` | Claude Code project |
| 4 (highest) | `{projectRoot}/.clawd/agents/{name}.md` | Claw'd project |

This priority system enables:
- **Claude Code compatibility** — `.claude/agents/` files work in both tools
- **Project overrides** — project-scoped agents take precedence over global
- **Team sharing** — check `.clawd/agents/` into version control

---

## Assigning Agents to Channels

Agents are assigned to chat channels via the UI (AgentDialog) or the API. Each channel can have multiple agents, each with its own provider, model, and project root.

When an agent is assigned to a channel, Claw'd looks for its agent file by name. If found, the agent file's system prompt, directives, and language are injected into the agent's context.

---

## Sub-Agent Spawning

Agents can spawn sub-agents that use a specific agent file's configuration:

```
spawn_agent(task: "Review the auth module", agent: "code-reviewer")
```

When the `agent` parameter is provided:
- The agent file is loaded from the 4-directory priority system
- Sub-agent gets the agent file's **system prompt** as its identity
- Sub-agent uses the agent file's **model** (or inherits from parent)
- Sub-agent is restricted to the agent file's **tools** (if specified)
- Sub-agent's **directives** and **language** are applied
- Sub-agent's **maxTurns** limits iteration count

Without the `agent` parameter, `spawn_agent` creates an anonymous sub-agent that inherits the parent's configuration (existing behavior, unchanged).

### Model Override

The `model` field supports aliases and full model IDs:

| Value | Resolves to |
|-------|-------------|
| `sonnet` | `claude-sonnet-4.6` |
| `opus` | `claude-opus-4.6` |
| `haiku` | `claude-haiku-4.5` |
| `inherit` | Parent agent's model |
| `claude-sonnet-4.6` | Used as-is (full model ID) |

---

## Agent Awareness

Each agent automatically knows about other agents in the project. The loader injects a summary of all available agents (name + description) into every agent's context. This enables agents to recommend spawning specific sub-agents for tasks.

---

## Tool Restrictions

### Allowlist (tools)

When `tools` is specified, the agent can **only** use listed tools:

```yaml
tools: [view, grep, glob, bash]
```

### Denylist (disallowedTools)

When `disallowedTools` is specified, listed tools are removed from the available set:

```yaml
disallowedTools: [create, edit, git_push]
```

Both can be combined — the allowlist is applied first, then the denylist removes from the result.

When neither is specified, the agent inherits all available tools.

---

## Memory

The `memory` field enables persistent cross-session learning:

| Scope | Location | Use case |
|-------|----------|----------|
| `user` | `~/.clawd/agent-memory/{name}/` | Knowledge across all projects |
| `project` | `.clawd/agent-memory/{name}/` | Project-specific, shareable via VCS |
| `local` | `.clawd/agent-memory-local/{name}/` | Project-specific, not in VCS |

---

## Migration from Old Format

If you have agents configured with the old `agents.json` + `roles/` format, run the migration script:

```sh
bun scripts/migrate-agents.ts /path/to/project
```

This reads `.clawd/agents.json` and `.clawd/roles/*.md`, merges them into `.clawd/agents/{name}.md` files. Verify the output, then delete the old files:

```sh
rm -f .clawd/agents.json
rm -rf .clawd/roles/
```

---

## Examples

### Debugger

```markdown
---
name: debugger
description: Debugging specialist for errors, test failures, and unexpected behavior
tools: [bash, view, edit, grep, glob]
model: inherit
---

You are an expert debugger specializing in root cause analysis.

When invoked:
1. Capture error message and stack trace
2. Identify reproduction steps
3. Isolate the failure location
4. Implement minimal fix
5. Verify solution works

Focus on fixing the underlying issue, not the symptoms.
```

### Documentation Writer

```markdown
---
name: doc-writer
description: Generates and updates project documentation
tools: [view, grep, glob, create, edit]
disallowedTools: [bash, git_push]
model: haiku
directives:
  - Write concise, scannable documentation
  - Use code examples liberally
  - Never include internal implementation details in user-facing docs
---

You are a technical writer. Generate clear, accurate documentation
from source code. Follow the project's existing doc style.
```

### Security Auditor

```markdown
---
name: security-auditor
description: Scans code for security vulnerabilities and compliance issues
tools: [view, grep, glob, bash]
model: sonnet
language: en
directives:
  - Never modify code — report only
  - Classify findings by CVSS severity
  - Reference OWASP Top 10 categories
---

You are a security auditor. Scan the codebase for:
- SQL injection, XSS, path traversal
- Exposed secrets, hardcoded credentials
- Missing input validation
- Insecure dependencies

Report each finding with: severity, location, description, remediation.
```
