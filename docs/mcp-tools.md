# MCP Tools Reference

Model Context Protocol (MCP) tools available to agents via the Claw'd server. Tools are organized by category and exposed through `mcp__clawd__` prefixed names.

## Tool Categories

- [Agent Management](#agent-management) — Spawn, control, and monitor sub-agents
- [Memory](#memory) — Chat history, knowledge base, and long-term memories
- [Todo](#todo) — Task tracking
- [Jobs](#jobs) — Background job management via tmux
- [TMUX](#tmux) — Direct tmux session control
- [Skills](#skills) — Skill discovery and management
- [Articles](#articles) — Article/blog post management
- [Utility](#utility) — Environment, date, document conversion

---

## Agent Management

### spawn_agent

Spawn an autonomous sub-agent to handle a task independently.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `task`    | string | Yes      | Task description for the sub-agent |
| `name`    | string | No       | Friendly name for the agent |
| `model`   | string | No       | Model: "sonnet" (default), "haiku" (quick). Do not use "opus". |
| `agent`   | string | No       | Agent type from .clawd/agents/ to inherit system prompt |
| `context` | string | No       | Optional context to seed the sub-agent |

**Returns:** `{ ok, agent_id, name, status, message }`

**Limits:**
- Max 9 active sub-agents per channel
- 30-minute timeout per sub-agent
- Opus model is automatically downgraded to sonnet

**Example:**
```json
spawn_agent({
  "task": "Fix the authentication bug in login.ts",
  "model": "sonnet",
  "context": "The bug is related to token refresh handling"
})
```

### stop_agent

Stop a running sub-agent.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `agent_id`| string | Yes      | Sub-agent ID to stop |
| `reason`  | string | No       | Reason for stopping |

**Returns:** `{ ok, status, reason }`

### list_agents

List all spawned sub-agents and their status.

**Parameters:** None

**Returns:**
```json
{
  "ok": true,
  "count": 2,
  "agents": [
    { "id": "...", "name": "...", "status": "running", "result": "..." }
  ]
}
```

### get_agent_report

Get a sub-agent's result or status.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `agent_id`| string | Yes      | The sub-agent ID |

**Returns:** `{ ok, id, name, status, result }`

### get_agent_logs

Get the output logs of a sub-agent.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `agent_id`| string | Yes      | The sub-agent ID |
| `tail`    | number | No       | Number of lines to return (default: 100) |

---

## Memory

### memory_search

Search past conversation history with full-text search.

| Parameter   | Type     | Required | Description |
|-------------|----------|----------|-------------|
| `keywords`  | string[] | No       | Keywords for FTS5 search |
| `start_time`| number   | No       | Unix timestamp (ms) to search from |
| `end_time`  | number   | No       | Unix timestamp (ms) to search until |
| `role`      | string   | No       | Filter: "user", "assistant", "tool" |
| `session_id`| string   | No       | Limit to specific session |
| `limit`     | number   | No       | Max results (default: 20) |

**Example:**
```json
memory_search({
  "keywords": ["API", "authentication"],
  "role": "assistant",
  "limit": 10
})
```

### memory_summary

Get a summary of a conversation session.

| Parameter   | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `session_id`| string | Yes      | Session ID to summarize |

**Returns:**
```
Session: Project Discussion
Messages: 145
Time Range: 2024-01-15T10:00:00Z - 2024-01-15T14:30:00Z
Key Topics: auth, api, database, refactor

Summary: Discussed migration strategy | Added JWT validation | Reviewed query optimization
```

### knowledge_search

Search indexed tool outputs from the current channel.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `query`   | string | Yes      | Search query (keywords or phrases) |
| `scope`   | string | No       | "channel" (default) or "session" |
| `limit`   | number | No       | Max results (default: 10) |

**Use case:** Retrieve content that was truncated or from previous tool executions.

### memo_save

Save information to long-term memory.

| Parameter  | Type   | Required | Description |
|------------|--------|----------|-------------|
| `content`  | string | Yes      | Information to remember (1-5000 chars) |
| `category` | string | No       | Category: "fact", "preference", "decision", "lesson", "correction" (default: "fact") |
| `scope`    | string | No       | "channel" (default, this channel only) or "agent" (all channels) |

**Categories:**
- `fact` — Objective facts about the project
- `preference` — User preferences and habits
- `decision` — Design decisions and choices
- `lesson` — Learned insights and discoveries
- `correction` — Bug fixes and corrections

**Example:**
```json
memo_save({
  "content": "User prefers detailed explanations over quick answers",
  "category": "preference",
  "scope": "agent"
})
```

### memo_recall

Search long-term memories.

| Parameter  | Type   | Required | Description |
|------------|--------|----------|-------------|
| `query`    | string | No       | Search keywords (omit for recent) |
| `category` | string | No       | Filter by category |
| `limit`    | number | No       | Max results (default: 20, max: 50) |
| `offset`   | number | No       | Pagination offset (default: 0) |

**Example:**
```json
memo_recall({
  "query": "API endpoint",
  "category": "decision"
})
```

### memo_delete

Delete a memory by ID.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `id`      | number | Yes      | Memory ID to delete |

### memo_pin

Pin a memory so it's always loaded into context.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `id`      | number | Yes      | Memory ID to pin |

**Limits:** Max 25 pinned memories. Pinned memories have priority >= 80.

### memo_unpin

Unpin a previously pinned memory.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `id`      | number | Yes      | Memory ID to unpin |

---

## Todo

### todo_write

Create or replace the entire todo list.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `todos`   | array  | Yes      | Array of todo items |

**Todo Item Structure:**
```json
{
  "id": "unique-id",
  "content": "Task description",
  "status": "pending | in_progress | completed"
}
```

**Example:**
```json
todo_write({
  "todos": [
    { "id": "1", "content": "Fix auth bug", "status": "in_progress" },
    { "id": "2", "content": "Write tests", "status": "pending" }
  ]
})
```

### todo_read

Read the current todo list.

**Parameters:** None

**Returns:** Current todo items with IDs and statuses.

### todo_update

Update a single todo item's status.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `item_id` | string | Yes      | The item ID to update |
| `status`  | string | Yes      | New status: "pending", "in_progress", "completed" |

---

## Jobs

Background command execution via tmux (survives agent restarts).

### job_submit

Submit a background command that persists via tmux.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `name`    | string | Yes      | Job name |
| `command` | string | Yes      | Shell command to execute |
| `cwd`     | string | No       | Working directory |

**Returns:** `{ ok, job_id, message }`

**Example:**
```json
job_submit({
  "name": "dev-server",
  "command": "npm run dev",
  "cwd": "/project"
})
```

### job_status

Get status of background jobs.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `job_id`  | string | No       | Specific job ID (omit to list all) |

**Returns:** Job status, exit code, and summary.

### job_cancel

Cancel a background job.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `job_id`  | string | Yes      | Job ID to cancel |

### job_wait

Wait for a background job to complete.

| Parameter   | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `job_id`    | string | Yes      | Job ID to wait for |
| `timeout_ms`| number | No       | Timeout in ms (default: 60000) |

**Returns:** Job status, exit code, and full output.

### job_logs

Get output logs of a background job.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `job_id`  | string | Yes      | Job ID |
| `tail`    | number | No       | Number of lines (default: all) |

---

## TMUX

Direct tmux session control for interactive programs and long-running processes.

### tmux_send_command

Send a command to a tmux session.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `session` | string | Yes      | Session name (creates if not exists) |
| `command` | string | Yes      | Command to send |
| `wait`    | number | No       | Wait for output (ms, default: 0) |

### tmux_send_input

Send raw keystrokes to a tmux session.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `session` | string | Yes      | Session name |
| `input`   | string | Yes      | Keystrokes (C-m=Enter, C-i=Tab, C-[=Esc) |

### tmux_capture

Capture visible output from a tmux pane.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `session` | string | Yes      | Session name |
| `Pane`    | number | No       | Pane index (default: 0) |

### tmux_list

List all tmux sessions for this project.

**Parameters:** None

### tmux_kill

Kill a tmux session and all its processes.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `session` | string | Yes      | Session name |

### tmux_new_window

Create a new window in an existing tmux session.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `session` | string | Yes      | Session name |
| `name`    | string | No       | Window name |

### tmux_kill_window

Kill a specific window in a tmux session.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `session` | string | Yes      | Session name |
| `window`  | number | Yes      | Window index |

---

## Skills

Skill discovery and management. Skills are markdown files that provide specialized guidance.

### skill_list

List all available skills (project-scoped + global).

**Parameters:** None

### skill_search

Search for relevant skills by keywords.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `query`   | string | Yes      | Search keywords |

**Returns:** Matching skills ranked by relevance with descriptions.

### skill_activate

Load and activate a skill by name.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `name`    | string | Yes      | Skill name |

**Returns:** Full skill content to guide agent actions.

### skill_create

Create or update a skill.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `name`    | string | Yes      | Skill name |
| `content` | string | Yes      | Skill content (markdown) |
| `scope`   | string | No       | "project" (default) or "global" |

**Location:** Saved as `{projectRoot}/.clawd/skills/{name}/SKILL.md` (or `~/.clawd/skills/` for global).

### skill_delete

Delete a skill.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `name`    | string | Yes      | Skill name |

---

## Articles

Article/blog post management for the chat channel.

### article_create

Create a new article.

| Parameter    | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `title`      | string | Yes      | Article title |
| `content`    | string | No*      | Raw markdown content |
| `file_id`    | string | No*      | Uploaded file ID (from upload_file) |
| `message_ts` | string | No*      | Existing chat message timestamp |
| `tags`       | string | No       | Comma-separated tags |
| `channel`    | string | No       | Target channel |

*One of content, file_id, or message_ts required.

### article_get

Get a specific article by ID.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `id`      | string | Yes      | Article ID |

**Returns:** Full article content and metadata.

### article_list

List articles in a channel.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `channel` | string | No       | Channel filter (default: current) |
| `limit`   | number | No       | Max results (default: 20) |

### article_update

Update an existing article.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `id`      | string | Yes      | Article ID |
| `title`   | string | No       | New title |
| `content` | string | No       | New content |
| `tags`    | string | No       | New tags |

### article_delete

Delete an article.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `id`      | string | Yes      | Article ID |

### send_article

Send an article to the chat channel.

| Parameter   | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `article_id`| string | Yes      | Article ID to send |

---

## Utility

### bash

Execute a shell command on the host machine. Runs outside the Claude Code sandbox.

| Parameter           | Type    | Required | Description |
|---------------------|---------|----------|-------------|
| `command`           | string  | Yes      | Shell command |
| `working_directory` | string  | No       | Working directory |
| `run_in_background` | boolean | No       | Run in background (returns job ID) |

**Note:** On Windows, use PowerShell syntax.

### today

Get today's date and current time.

**Parameters:** None

**Returns:** `Friday, 2024-01-15 14:30:00`

### convert_to_markdown

Convert a document file to markdown for reading.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `path`    | string | Yes      | Absolute path to the file |

**Supported formats:** PDF, DOCX, XLSX, PPTX, HTML, EPUB, CSV

**Returns:** Saved path and content size.

---

## MCP Naming Convention

Tools are exposed via MCP with the `mcp__clawd__` prefix:

```
mcp__clawd__bash
mcp__clawd__spawn_agent
mcp__clawd__memory_search
mcp__clawd__memo_save
```

For clawd-chat agents (non-Claude Code), tools may be registered directly without prefix.

---

## Tool Availability

Not all tools are available in every context:

| Tool Category | Main Agent | Sub-Agent | CC Main Agent |
|--------------|------------|-----------|---------------|
| Agent Management | ✓ (limited) | ✗ | ✗ |
| Memory | ✓ | ✓ | ✓ |
| Todo | ✓ | ✓ | ✗ |
| Jobs | ✓ | ✓ | ✗ |
| TMUX | ✓ | ✓ | ✗ |
| Skills | ✓ | ✓ | ✗ |
| Articles | ✓ | ✓ | ✗ |
| Utility | ✓ | ✓ | ✓ |

Agent Management tools for the main agent are limited to `spawn_agent` via MCP (when enabled). Sub-agents cannot spawn additional agents to prevent infinite recursion.
