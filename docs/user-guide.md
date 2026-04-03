# Claw'd User Guide

> A beginner-friendly guide to getting started with Claw'd

---

## Table of Contents

1. [What is Claw'd?](#1-what-is-clawd)
2. [Installation](#2-installation)
3. [Getting Started](#3-getting-started)
4. [Managing Agents and Skills](#4-managing-agents-and-skills)
5. [Connecting External Services](#5-connecting-external-services)
6. [Best Practices](#6-best-practices)
7. [Common Pitfalls to Avoid](#7-common-pitfalls-to-avoid)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. What is Claw'd?

**Claw'd** is an open-source platform where AI agents work alongside you through a real-time chat interface. Think of it as a collaborative workspace where you and AI agents can:

- **Chat in real-time** — communicate with multiple AI agents simultaneously
- **Execute code** — agents can read, write, and run code in sandboxed environments
- **Browse the web** — agents can control a Chrome browser to gather information
- **Spawn sub-agents** — delegate tasks to specialized agents that work in parallel
- **Remember things** — agents persist memories across sessions
- **Schedule tasks** — set up recurring or delayed agent tasks

### Key Concepts

| Term | Description |
|------|-------------|
| **Channel** | A chat room where you interact with agents. Each channel can have its own agents and configuration. |
| **Agent** | An AI assistant configured with specific instructions, tools, and behaviors. |
| **Skill** | A reusable instruction set that extends what an agent can do. |
| **MCP Server** | External tool providers (like GitHub) that agents can connect to. |
| **Sub-agent** | A specialized agent spawned to handle a specific task. |

### Who is Claw'd for?

- **Developers** who want AI assistance with coding tasks
- **Teams** that need multiple AI agents working collaboratively
- **Power users** who want fine-grained control over AI behavior
- **Anyone** who wants persistent, memory-aware AI assistants

---

## 2. Installation

### Prerequisites

- [Bun](https://bun.sh/) v1.3.9 or later
- [Git](https://git-scm.com/) (for cloning the repository)
- Chrome browser (for browser automation features)
- macOS, Linux, or Windows (with WSL2 for best experience)

### Step 1: Clone and Build

```bash
# Clone the repository
git clone https://github.com/Tuanm/clawd.git
cd clawd

# Install dependencies and build
bun install
bun run build
```

This creates a single executable at `dist/clawd`.

### Step 2: Quick Start

```bash
# Run with the compiled binary
./dist/clawd          # Linux/macOS
# ./dist/clawd-windows-x64.exe  # Windows

# Or use development mode (hot reload)
bun run dev
```

The server starts on **http://localhost:3456**. Open this URL in your browser.

### Step 3: Docker Installation (Optional)

```bash
# Pull and run with Docker
docker compose up -d
```

The app will be available at http://localhost:3456.

### Step 4: Configure LLM Provider

Claw'd needs an AI model provider. Create `~/.clawd/config.json`:

```json
{
  "host": "0.0.0.0",
  "port": 3456,
  "providers": {
    "copilot": {
      "api_key": "your_github_pat_here"
    }
  }
}
```

**Available Providers:**

| Provider | Setup | Notes |
|----------|-------|-------|
| **GitHub Copilot** | Requires GitHub PAT with `copilot` scope | Recommended for most users |
| **Anthropic** | API key from console.anthropic.com | Direct Claude access |
| **OpenAI** | API key from platform.openai.com | GPT models |
| **Ollama** | Local installation | No API key needed |
| **Groq** | API key from console.groq.com | Fast inference, free tier |

#### How to Create a GitHub Personal Access Token (PAT)

1. Go to **https://github.com/settings/tokens**
2. Click **"Generate new token"** → **"Generate new token (classic)"**
3. Give it a name (e.g., "Claw'd Access")
4. Set an expiration date (recommended: 90 days)
5. Check the following **scopes**:
   - ✅ `copilot` — Required for GitHub Copilot access
   - ✅ `repo` — For repository operations (optional)
6. Click **"Generate token"**
7. **Copy the token immediately** — you won't see it again!

> **Important:** Treat your PAT like a password. Never share it or commit it to git.

### Step 5: Install Browser Extension (Recommended)

The browser extension enables agents to browse the web and interact with websites. After starting the Claw'd server, load the extension directly from it.

**Installation Steps:**

1. Start Claw'd server: `./dist/clawd`
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right corner)
4. Click **"Load unpacked"**
5. Visit **http://localhost:3456/browser/extension** in a new tab
6. Extract the downloaded extension files
7. Select the extracted extension folder

**After Installation:**

- Look for the Claw'd icon (🦞) in your browser toolbar
- Click the icon to see connection status
- A green indicator means the extension is connected to Claw'd

**Enabling for Incognito:**

1. Go to `chrome://extensions/`
2. Find Claw'd extension
3. Click **"Details"**
4. Toggle **"Allow in Incognito"**

### Environment Variables (Optional)

Create `~/.clawd/.env` for secrets that agents can access when running code:

```env
GITHUB_TOKEN=ghp_...
NPM_TOKEN=npm_...
```

These are automatically loaded when agents run — you can use these variables in your code without hardcoding secrets.

---

## 3. Getting Started

### Creating Your First Channel

**Channels** are separate workspaces for different projects or topics. Think of them like different tabs or chat rooms.

1. Open Claw'd at http://localhost:3456
2. Click the **Claw'd logo** (top-left corner) to open the channel dialog
3. Click the **+** button to create a new channel
4. Enter a channel name (e.g., "general", "coding", "research")
5. Click **Create**

You now have a dedicated workspace for interacting with agents.

### Adding Your First Agent

1. In your channel, look at the **header bar** at the top
2. Click the **robot icon** (the connection indicator with Copilot logo)
3. Click **Add** to add a new agent
4. Configure the agent:
   - **Name**: A friendly identifier (e.g., "assistant", "code-helper")
   - **Provider**: Select your configured provider (e.g., "copilot")
   - **Model**: Choose a model (see below)
   - **Project Path**: The folder this agent can access (optional, leave empty for no restrictions)
   - **Heartbeat Interval**: How often the agent checks for messages (30s is a good default)
5. Click **Save**

The header bar contains these buttons (from left to right):
- Claw'd logo (channel selection)
- Online agent avatars
- Robot icon (agent settings)
- Star icon (skills management)
- MCP icon (MCP servers, only visible when connected)
- Project button
- Theme toggle

#### Choosing a Model

Different models have different capabilities, speeds, and costs:

| Model Tier | Examples | Best For | Cost |
|------------|----------|----------|------|
| **Fast/cheap** | Haiku, GPT-4o-mini | Quick questions, simple tasks | Low |
| **Balanced** | GPT-4.1, Claude Sonnet 4 | General assistance, coding | Medium |
| **Powerful** | Claude Opus 4, GPT-4.5 | Complex reasoning, research | High |

**Recommendation for beginners:** Start with "balanced" models like `gpt-4.1` or `claude-sonnet-4.6`. Upgrade to powerful models only when needed.

The agent joins your channel and is ready to help!

### Talking to Your Agent

Type a message and send it. Your agent will:

1. Read your message
2. Think about how to respond
3. Use tools if needed (browse web, read files, run code)
4. Respond with text, code, or visual artifacts

### Understanding Agent Responses

Agents can respond with:

- **Text** — plain explanations and answers
- **Code blocks** — syntax-highlighted code you can copy
- **Artifacts** — interactive components:
  - HTML/React apps
  - Charts and graphs
  - Data tables
  - Diagrams

### Basic Commands

| Command | Description |
|---------|-------------|
| `@agent message` | Send a message to a specific agent |
| `/help` | Get help with available commands |
| `@agent:task task` | Ask an agent to perform a task |
| `/spawn agent-name task` | Spawn a specialized sub-agent |

---

## 4. Managing Agents and Skills

### Agent Files

Agents are defined in markdown files with YAML frontmatter. Create one at:

```
~/.clawd/agents/my-agent.md          # Global (all projects)
{projectRoot}/.clawd/agents/my-agent.md  # Project-specific
```

**Example Agent File:**

```markdown
---
name: my-agent
description: A helpful coding assistant
provider: copilot
model: gpt-4.1
---

# My Agent

You are a helpful coding assistant specializing in:
- Writing clean, efficient code
- Explaining complex concepts simply
- Debugging and troubleshooting

When writing code:
1. Always add comments explaining key sections
2. Follow the project's coding style
3. Include error handling
```

### Built-in Agents

Claw'd includes three built-in agents:

| Agent | Purpose | Model |
|-------|---------|-------|
| **explore** | Fast read-only codebase search | Haiku (fast, cheap) |
| **plan** | Research and gather context before planning | Inherits from parent |
| **general** | Complex multi-step tasks | Inherits from parent |

### Skills

Skills are reusable instruction sets that agents can activate on demand.

**Creating a Skill via UI:**

1. In the channel header, click the **star icon** (Skills button)
2. Click **Add** to create a new skill
3. Fill in:
   - **Name**: `code-review`
   - **Description**: `Review code for quality and security`
   - **Triggers**: `review, check, audit`
   - **Content**: Your skill instructions
4. Choose scope: **Project** (this project only) or **Global** (all projects)
5. Click **Save**

**SKILL.md Format:**

```markdown
---
name: code-review
description: Review code for quality, security, and performance
triggers: [review, check, audit]
allowed-tools: [bash, view, grep]
---

# Code Review Guidelines

When reviewing code, check for:

1. **Security** — SQL injection, XSS, path traversal
2. **Performance** — N+1 queries, memory leaks
3. **Readability** — Clear naming, small functions

Use `grep` to find common issues:
- `grep "TODO|FIXME|HACK"` for tech debt
```

**Skill Directories:**

Skills are loaded from 4 directories. Higher priority (lower number) overrides lower priority:

| Priority | Path | Scope |
|----------|------|-------|
| 1 (highest) | `{project}/.clawd/skills/` | Project (Claw'd) |
| 2 | `{project}/.claude/skills/` | Project (Claude Code) |
| 3 | `~/.clawd/skills/` | Global (Claw'd) |
| 4 (lowest) | `~/.claude/skills/` | Global (Claude Code) |

> **Note:** Within each scope (project/global), Claw'd skills take priority over Claude Code skills.

### Finding Skills

**Trusted Sources for Skills:**

1. **Claw'd GitHub** — Check the `.clawd/skills/` folder in the repository
2. **Claude Code Templates** — Community-shared skills at claudecode.com
3. **GitHub Gists** — Search for "claude skill" or "clawd skill"
4. **Build Your Own** — Create custom skills for your workflow

**Tip:** Search GitHub for repositories with `.clawd/skills/` or `.claude/skills/` directories.

---

## 5. Connecting External Services

### MCP Servers

MCP (Model Context Protocol) servers provide external tools to agents. Examples:

- **GitHub** — Search repositories, manage issues, code review
- **Slack** — Send messages, manage channels
- **Filesystem** — Access files outside the project
- **Custom servers** — Build your own tools

### Adding MCP Servers

1. In the channel header, click the **MCP icon** (two arrows symbol) to open MCP settings
2. You'll see a list of available servers from the catalog
3. Click **Connect** next to the server you want to add
4. For servers requiring authentication (like GitHub), you'll be prompted to authorize

**Note:** The MCP button only appears in the header when you have MCP servers connected or available.

### MCP Catalog

Available servers from the catalog:

| Server | Description | Auth Required |
|--------|-------------|---------------|
| GitHub | Repository and issue management | Yes (OAuth/PAT) |
| Filesystem | Access local files | No |
| PostgreSQL | Database queries | No |
| Sentry | Error tracking | Yes (OAuth) |
| Notion | Workspace content | Yes (OAuth) |
| Slack | Messaging | Yes (OAuth) |
| Web Fetch | Page content extraction | No |
| Puppeteer | Browser automation | No |
| Atlassian | Jira/Confluence | Yes (OAuth) |

For more servers, visit the [MCP Server Catalog](https://github.com/modelcontextprotocol/servers).

### Remote Workers (Advanced)

Remote workers let agents execute tools on other machines.

**Setup (TypeScript):**

```bash
# On the remote machine
git clone https://github.com/Tuanm/clawd.git
cd clawd
CLAWD_WORKER_TOKEN=your-token bun packages/clawd-worker/typescript/remote-worker.ts \
  --server wss://your-server.com
```

**Setup (Python):**

```bash
python3 packages/clawd-worker/python/remote_worker.py \
  --server wss://your-server.com
```

Add `--browser` flag to enable browser automation on the remote machine.

---

## 6. Best Practices

### For Coding Tasks

**Do:**

- ✅ Provide context — share relevant files or explain the project structure
- ✅ Be specific — "Fix the null pointer exception in user.ts" works better than "fix bug"
- ✅ Use artifacts — ask agents to generate charts, diagrams, or interactive demos
- ✅ Spawn sub-agents — use parallel agents for independent tasks
- ✅ Review changes — always check code before accepting

**Example Prompts:**

```
"Review the authentication module for security issues"
"Write tests for the calculateTotal function"
"Explain why this regex isn't matching correctly"
"Refactor this function to be more readable"
```

### For Non-Coding Tasks

**Do:**

- ✅ Break tasks into steps — "First find X, then summarize Y"
- ✅ Set constraints — "Summarize in 3 bullet points"
- ✅ Ask for reasoning — "Why did you choose this approach?"
- ✅ Request alternatives — "Give me 3 options with pros/cons"

**Example Prompts:**

```
"Research the best practices for REST API design"
"Summarize this article: [paste URL]"
"What are the key differences between React and Vue?"
"Help me plan a 5-day trip to Tokyo"
```

### Agent Communication

- **Direct messages**: Use `@agent message` to talk to a specific agent
- **Broadcast**: Address all agents with "all" or no prefix
- **Context window**: This is how much conversation history the agent can "remember" at once. Very long conversations may lose earlier context — ask the agent to summarize if needed

### Memory and Persistence

Agents remember:
- **Session context** — current conversation
- **Project knowledge** — files and patterns in your project
- **Long-term memories** — facts you explicitly save

**Save important information:**

```
@agent memo_save: Remember that we use custom error codes: E001=timeout, E002=auth failed
```

### Sub-Agent Workflows

Spawn specialized agents for:
- Code reviews
- Documentation writing
- Testing
- Research
- Parallel task execution

```
/spawn code-reviewer Review the security of this login flow
/spawn tester Run integration tests for the payment module
/spawn researcher Find best practices for React state management
```

---

## 7. Common Pitfalls to Avoid

### Understanding Sandboxing

**Sandboxing** is a protective barrier that keeps agents safe to use. It prevents agents from:
- Accessing files outside their allowed scope
- Running dangerous commands on your system
- Reading sensitive files (like SSH keys or passwords)

The sandbox is enabled by default. The `--yolo` flag disables this protection — **only use it in isolated, trusted environments**.

### Security Issues

❌ **Don't** share sensitive credentials in chat
- Agents can see all messages
- Credentials should go in `~/.clawd/.env`, not chat

❌ **Don't** use `--yolo` mode without understanding the risks
- Disables all security restrictions
- Only use for testing or in Docker containers

❌ **Don't** grant excessive file permissions
- Agents should only access project directories
- Deny read/write to sensitive folders

### Agent Behavior

❌ **Don't** expect perfect code on first try
- Iterate and refine
- Review all generated code

❌ **Don't** overwhelm agents with giant tasks
- Break into smaller steps
- Let agents complete one task before moving to the next

❌ **Don't** ignore agent warnings
- Agents flag potential issues
- Investigate before proceeding

### Configuration Mistakes

❌ **Don't** skip provider configuration
- Without a provider, agents can't function
- Double-check API keys and permissions

❌ **Don't** use expired API keys
- Rate limits and authentication failures
- Monitor key usage in Settings

❌ **Don't** ignore the heartbeat setting
- Too short: unnecessary resource usage
- Too long: slow response times
- 30 seconds is a good default

### Common Mistakes

❌ **Wrong directory**: Agents work in their configured project path
❌ **Typo in agent names**: Check exact spelling
❌ **Forgetting to save**: Click Save after changes
❌ **Multiple conflicting agents**: Disable unused agents
❌ **Context overflow**: Long chats may lose earlier context

---

## 8. Troubleshooting

### First-Time Setup Checklist

If you're setting up Claw'd for the first time and things aren't working:

1. ✅ **Server running?** — You should see "Claw'd server started" in your terminal
2. ✅ **Browser open?** — Go to http://localhost:3456
3. ✅ **Provider configured?** — Check `~/.clawd/config.json` has your API key
4. ✅ **Agent added?** — Click the **robot icon** in the header → Add Agent
5. ✅ **Agent online?** — Look for colored dots (agent avatars) in the header bar

### Agent Not Responding

1. **Check status** — Do you see colored dots (agent avatars) in the header? If not, agents may be offline
2. **Restart agent** — Click the robot icon → find the agent → toggle it off and on
3. **Check logs** — Look for errors in the agent logs panel
4. **Verify API key** — Ensure provider credentials are valid in `~/.clawd/config.json`

### API Errors

| Error | Solution |
|-------|----------|
| `401 Unauthorized` | Check API key in `~/.clawd/config.json` |
| `429 Rate Limited` | Wait, reduce requests, or upgrade plan |
| `403 Forbidden` | Verify key permissions (e.g., Copilot scope) |

### Browser Extension Not Working

1. **Reload extension** — Disable and re-enable in chrome://extensions/
2. **Check connection** — Look for the Claw'd icon in toolbar
3. **Allow permissions** — Grant "Allow access to file URLs"
4. **Try stealth mode** — If blocked by websites, use stealth browser mode

### Slow Performance

- Reduce the number of active agents
- Disable unused MCP servers
- Use a faster model for simple tasks (Haiku instead of Opus)
- Check system resources (CPU, memory)

### File Access Issues

1. **Verify path** — Ensure the project path exists
2. **Check permissions** — Agent needs read/write access
3. **Relative paths** — Use absolute paths to be safe
4. **Outside project** — Configure MCP server for external files

### Memory Problems

- **Clear old sessions** — Delete old conversation history
- **Forget memories** — Use `memo_delete` to remove outdated memories
- **Summarize** — Ask agents to summarize long discussions

### Getting Help

1. **Check docs** — See [docs/architecture.md](architecture.md) for technical details
2. **GitHub Issues** — Search existing issues or create new ones
3. **Community** — Ask questions in GitHub Discussions
4. **Logs** — Enable debug mode (`--debug`) for detailed logs

---

## Quick Reference

### CLI Flags

```bash
clawd --host 0.0.0.0      # Bind address
clawd -p 3456             # Port
clawd --debug             # Debug logging
clawd --yolo              # Disable sandbox
clawd --no-open-browser   # Don't auto-open browser
```

### Default Ports

| Service | Port |
|---------|------|
| Claw'd Server | 3456 |
| Browser Extension | (auto-detected) |

### Key Paths

| Path | Purpose |
|------|---------|
| `~/.clawd/config.json` | Main configuration |
| `~/.clawd/.env` | Environment variables |
| `~/.clawd/agents/` | Agent definitions |
| `~/.clawd/skills/` | Skill definitions |
| `~/.clawd/data/` | SQLite databases |

### Useful Commands

```bash
# Start server
./dist/clawd           # Linux/macOS
# dist/clawd-windows-x64.exe  # Windows

# Development mode
bun run dev

# Build binary
bun run build

# Run tests
bun test
```

---

**Still have questions?** Check the [Architecture Reference](architecture.md) or open an issue on GitHub.
