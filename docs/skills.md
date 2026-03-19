# Skills

Skills are reusable instruction sets that extend agent behavior. Each skill is a markdown file (`SKILL.md`) with metadata and instructions that agents load on demand. Skills can also include sidecar scripts for agents to execute.

Skills are compatible with Claude Code — the same `SKILL.md` format works in both tools.

---

## Quick Start

### Create a Skill Manually

Create a folder with a `SKILL.md` file:

**Project-scoped** (available to agents working in this project):

```
{projectRoot}/.clawd/skills/code-review/SKILL.md
```

**Global** (available to all agents on this machine):

```
~/.clawd/skills/code-review/SKILL.md
```

**SKILL.md:**

```markdown
---
name: code-review
description: Review code for quality, security, and performance issues
triggers: [review, code-review, audit, quality]
---
# Code Review Guidelines

When reviewing code, check for:

1. **Security** — SQL injection, XSS, path traversal, secrets in code
2. **Performance** — N+1 queries, unnecessary re-renders, memory leaks
3. **Readability** — Clear naming, small functions, minimal nesting
4. **Error handling** — Edge cases, null checks, proper error messages

Use `grep` to search for common patterns:
- `grep "TODO|FIXME|HACK"` for known tech debt
- `grep "eval\(|exec\("` for unsafe code execution

Report findings as a markdown checklist with severity (critical/warning/info).
```

Agents discover it automatically and can activate it with the `skill_activate` tool.

### Create a Skill via the UI

1. Click the star icon (next to MCP button) in the chat interface
2. Select an agent from the avatar bar
3. Click **Add**
4. Fill in name, description, triggers, and content
5. Choose scope: **Project** or **Global**
6. Click **Save**

### Ask an Agent to Use a Skill

Skills are lazy-loaded — agents see a summary of available skills in their system prompt but only load the full content when needed. You can trigger a skill by:

- Using a trigger keyword in your message (e.g., "review this code")
- Explicitly asking: "Use the code-review skill to check this file"
- The agent calling `skill_activate` on its own when it matches triggers

---

## SKILL.md Format

```markdown
---
name: skill-name
description: Brief description (<200 chars)
triggers: [keyword1, keyword2, keyword3]
allowed-tools: [bash, view, grep]
---
# Skill Instructions

Markdown content with guidelines, steps, and examples...
```

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique identifier (lowercase, alphanumeric, hyphens, underscores, max 64 chars) |
| `description` | string | Yes | What the skill does — shown in agent's skill summary (<200 chars) |
| `triggers` | string[] | Yes | Keywords that activate this skill when matched in user messages |
| `allowed-tools` | string[] | No | Restrict which tools the agent can use while following this skill |
| `version` | string | No | Semantic version (e.g., `1.0.0`) |
| `argument-hint` | string | No | Hint for expected arguments (e.g., `[filepath]`) |

### Body Content

Everything after the closing `---` is the skill body. Write it as markdown instructions that tell the agent:

- What to do and in what order
- Which tools to use and how
- What output format to produce
- Any constraints or rules to follow

Keep it concise — the full content is injected into the agent's context when activated, consuming tokens.

---

## Source Directories & Priority

Skills are loaded from 4 directories. Same-name skills in higher-priority directories override lower ones:

| Priority | Path | Scope | Editable via UI |
|----------|------|-------|-----------------|
| 1 (lowest) | `~/.claude/skills/{name}/SKILL.md` | Global | No (read-only) |
| 2 | `~/.clawd/skills/{name}/SKILL.md` | Global | Yes |
| 3 | `{projectRoot}/.claude/skills/{name}/SKILL.md` | Project | No (read-only) |
| 4 (highest) | `{projectRoot}/.clawd/skills/{name}/SKILL.md` | Project | Yes |

This priority system lets you:

- Share skills between Claude Code and Claw'd (`.claude/skills/` directories)
- Override global skills per-project (project-scoped takes precedence)
- Keep some skills read-only (`.claude/` paths are not editable via the UI)

---

## Trigger Matching

When a user sends a message, the skill manager scores each skill against the message:

| Match Type | Score | Example |
|------------|-------|---------|
| **Exact trigger match** | +1.0 | Message contains "review", trigger is "review" |
| **Partial trigger match** | +0.5 | Message contains "debug", trigger is "debugging" |
| **Description match** | +0.3 | Message contains "security", description mentions "security" |

Top 3 matches are suggested to the agent. The agent decides whether to activate them.

---

## Allowed Tools

Skills can restrict which tools the agent may use while following the skill's instructions:

```yaml
allowed-tools: [bash, view, grep, glob]
```

When specified, sub-agents spawned for this skill are limited to only these tools. This is useful for:

- **Read-only skills:** `allowed-tools: [view, grep, glob]` — prevents modifications
- **Safe automation:** `allowed-tools: [bash, view]` — limits to specific operations
- **Focused tasks:** Prevents agents from going off-track with unrelated tools

If omitted, agents have access to all available tools.

---

## Including Scripts

Skills can include sidecar scripts in the same folder:

```
.clawd/skills/db-migrate/
├── SKILL.md
├── migrate.sh
├── rollback.sh
└── templates/
    └── migration.sql.tmpl
```

**SKILL.md** references the scripts in its instructions:

```markdown
---
name: db-migrate
description: Create and run database migrations
triggers: [migrate, migration, schema]
---
# Database Migration Skill

## Creating a Migration
Run the migration generator:
```bash
bash .clawd/skills/db-migrate/migrate.sh create <name>
```

## Rolling Back
```bash
bash .clawd/skills/db-migrate/rollback.sh <migration-id>
```
```

### Script Access Rules

| Scope | Agent Access |
|-------|-------------|
| Project skills (`.clawd/skills/`) | Read + execute (sandbox) |
| Global skills (`~/.clawd/skills/`) | Read only (injected into context) |
| Claude Code skills (`.claude/skills/`) | Read only |

Scripts from project skills run in the same sandbox as other agent tools — with project root as working directory, timeout enforcement, and output capture.

---

## How Agents Use Skills

### Lazy Loading

To save tokens, agents don't receive full skill content upfront. Instead:

1. **System prompt** includes a summary: skill names + descriptions only
2. Agent sees: `"- **code-review** (project): Review code for quality, security, and performance issues"`
3. When the agent needs a skill, it calls `skill_activate` to load the full content
4. Full skill body is injected into the conversation

### Agent Tools for Skills

| Tool | Description |
|------|-------------|
| `skill_activate` | Load a skill's full content into context |
| `skill_search` | Search skills by keyword |
| `skill_list` | List all available skills |

---

## Managing Skills via API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `app.skills.list` | GET | List skills for an agent's project |
| `app.skills.get` | GET | Get full skill content |
| `app.skills.save` | POST | Create or update a skill |
| `app.skills.delete` | DELETE | Remove a skill |

---

## Examples

### Deployment Checklist

```markdown
---
name: deploy-checklist
description: Pre-deployment verification checklist
triggers: [deploy, release, ship, production]
---
# Deployment Checklist

Before deploying, verify each item:

1. **Tests pass:** Run `bun test` and confirm 0 failures
2. **No console.log:** `grep -r "console.log" src/ --include="*.ts" -l`
3. **No TODO/FIXME:** `grep -rn "TODO\|FIXME" src/ --include="*.ts"`
4. **Types check:** Run `bun run typecheck`
5. **Build succeeds:** Run `bun run build`
6. **Env vars documented:** Check `.env.example` matches required vars
7. **Migration safe:** Review any new SQL migrations for breaking changes

Report as a checklist with pass/fail for each item.
```

### Git Commit Standards

```markdown
---
name: commit-standards
description: Enforce conventional commit messages and clean history
triggers: [commit, git, conventional]
allowed-tools: [bash, view]
---
# Commit Standards

## Format
```
type(scope): description

[optional body]
```

## Types
- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code restructuring (no behavior change)
- `docs`: Documentation only
- `test`: Adding/fixing tests
- `chore`: Build, CI, deps

## Rules
- Subject line < 72 chars, imperative mood ("add" not "added")
- No AI references in commit messages
- One logical change per commit
- Run `bun run lint` before committing
```

### API Documentation Generator

```markdown
---
name: api-docs
description: Generate API documentation from route handlers
triggers: [api-docs, document-api, endpoints, swagger]
---
# API Documentation Generator

## Steps

1. Find all route files: `glob "src/api/**/*.ts"`
2. For each file, extract:
   - HTTP method and path
   - Request body schema (if POST/PUT)
   - Response format
   - Authentication requirements
3. Generate markdown table per route group
4. Save to `docs/api-reference.md`

## Output Format

For each endpoint:
```markdown
### `METHOD /path`
**Auth:** Required | None
**Body:** `{ field: type }`
**Response:** `{ field: type }`
**Description:** What this endpoint does
```
```
