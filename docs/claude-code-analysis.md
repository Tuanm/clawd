# Claude Code Agent System Analysis

A comprehensive analysis of Claude Code's agentic loop mechanism, architecture patterns, and recommendations for improving clawd-app's worker loop system.

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Agent System Architecture](#agent-system-architecture)
3. [Seven-Phase Feature Development Workflow](#seven-phase-feature-development-workflow)
4. [Specialized Agents Deep Dive](#specialized-agents-deep-dive)
5. [Triggering Mechanism](#triggering-mechanism)
6. [System Prompt Design Patterns](#system-prompt-design-patterns)
7. [Tool Access and Privileges](#tool-access-and-privileges)
8. [Quality Assurance Framework](#quality-assurance-framework)
9. [Plugin System Structure](#plugin-system-structure)
10. [Comparison with Clawd-App](#comparison-with-clawd-app)
11. [Recommendations for Clawd-App](#recommendations-for-clawd-app)

---

## Executive Summary

Claude Code implements a sophisticated multi-agent system designed for autonomous software development tasks. The system uses specialized agents with clear responsibilities, a structured seven-phase workflow for feature development, and robust triggering mechanisms based on example-based descriptions.

**Key Findings:**

- **Modular Agent Design**: Each agent has a specific domain expertise (code-explorer, code-architect, code-reviewer)
- **Example-Based Triggering**: Agents trigger based on `<example>` blocks in descriptions, not just keyword matching
- **Progressive Disclosure**: Heavy content is organized into references/ and examples/ subdirectories
- **Confidence Scoring**: Code review uses 0-100 confidence to filter high-priority issues
- **Model Selection**: Default to `inherit` (use parent model), `sonnet` for complex tasks, `haiku` for simple ones
- **Visual Coding**: Color system (blue/cyan/green/yellow/red/magenta) for quick agent identification

---

## Agent System Architecture

### File Structure

Claude Code plugins follow a consistent directory structure:

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── commands/                 # Slash commands
│   └── command-name.md
├── agents/                  # Agent definitions
│   ├── code-explorer.md
│   ├── code-architect.md
│   └── code-reviewer.md
├── skills/                   # Skill directories
│   └── skill-name/
│       ├── SKILL.md         # Main skill file
│       ├── references/       # Detailed documentation
│       ├── examples/         # Working examples
│       └── scripts/         # Utility scripts
├── hooks/
│   └── hooks.json           # Event hooks
├── README.md
└── .mcp.json                # MCP server configuration
```

### YAML Frontmatter Structure

Every agent file uses YAML frontmatter with required and optional fields:

```yaml
---
name: code-explorer                                    # REQUIRED: identifier (lowercase, hyphens, 3-50 chars)
description: Use this agent when...                    # REQUIRED: triggering conditions with <example> blocks
model: sonnet                                          # REQUIRED: inherit/sonnet/opus/haiku
color: yellow                                         # REQUIRED: visual identifier
tools: ["Glob", "Grep", "Read", "Write"]             # OPTIONAL: tool whitelist
---
```

#### Field Specifications

| Field | Required | Format | Purpose |
|-------|----------|--------|---------|
| `name` | Yes | lowercase-hyphens, 3-50 chars | Agent identifier |
| `description` | Yes | Text + `<example>` blocks | Triggering conditions |
| `model` | Yes | inherit/sonnet/opus/haiku | Model selection |
| `color` | Yes | blue/cyan/green/yellow/magenta/red | Visual category |
| `tools` | No | Array of tool names | Access restriction |

#### Color Semantics

| Color | Purpose | Examples |
|-------|---------|----------|
| blue | Analysis, review | code-reviewer, pr-analyzer |
| cyan | Documentation, information | docs-generator |
| green | Generation, creation | test-generator, code-generator |
| yellow | Validation, caution | plugin-validator |
| red | Security, critical analysis | security-analyzer |
| magenta | Transformation, creative | agent-creator, refactorer |

#### Tool Selection Principles

Claude Code follows the **principle of least privilege** for tool access:

- **Analysis agents**: `["Read", "Grep", "Glob"]` - read-only
- **Generation agents**: `["Read", "Write", "Grep"]` - can create/modify files
- **Executor agents**: `["Read", "Write", "Bash", "Grep"]` - can run commands
- **Full access**: Omit `tools` field or use `["*"]`

---

## Seven-Phase Feature Development Workflow

Claude Code implements a structured 7-phase workflow for feature development that ensures quality and thoroughness.

### Phase 1: Discovery

**Goal**: Understand what needs to be built

**Process**:
- Clarify ambiguous feature requests
- Identify the problem being solved
- Elicit constraints and requirements
- Summarize understanding and confirm with user

**Example interaction**:
```
You: /feature-dev Add caching
Claude: Let me understand what you need...
        - What should be cached? (API responses, computed values, etc.)
        - What are your performance requirements?
        - Do you have a preferred caching solution?
```

### Phase 2: Codebase Exploration

**Goal**: Understand relevant existing code and patterns

**Process**:
- Launch 2-3 `code-explorer` agents in parallel
- Each agent explores different aspects:
  - Find similar features and trace implementation
  - Map architecture and abstractions
  - Analyze current implementations
- Read all identified files for deep understanding
- Present comprehensive summary

**Agents launched**:
1. "Find features similar to [feature] and trace implementation"
2. "Map the architecture and abstractions for [area]"
3. "Analyze current implementation of [related feature]"

**Output**:
```
Found similar features:
- User authentication (src/auth/): Uses JWT tokens, middleware pattern
- Session management (src/session/): Redis-backed, 24hr expiry

Key files to understand:
- src/auth/AuthService.ts:45 - Core authentication logic
- src/middleware/authMiddleware.ts:12 - Request authentication
```

### Phase 3: Clarifying Questions

**Goal**: Fill gaps and resolve ambiguities before design

**Process**:
- Review codebase findings and feature request
- Identify underspecified aspects:
  - Edge cases
  - Error handling requirements
  - Integration points
  - Backward compatibility needs
  - Performance constraints
- Present organized questions
- **Wait for answers before proceeding**

**Example questions**:
```
Before designing the architecture, I need to clarify:

1. OAuth provider: Which OAuth providers? (Google, GitHub, custom?)
2. User data: Store OAuth tokens or just user profile?
3. Existing auth: Replace current auth or add alongside?
4. Sessions: Integrate with existing session management?
5. Error handling: How to handle OAuth failures?
```

### Phase 4: Architecture Design

**Goal**: Design multiple implementation approaches with trade-offs

**Process**:
- Launch 2-3 `code-architect` agents with different focuses:
  - **Minimal changes**: Smallest change, maximum reuse
  - **Clean architecture**: Maintainability, elegant abstractions
  - **Pragmatic balance**: Speed + quality
- Review all approaches
- Form opinion on best fit
- Present comparison with trade-offs and recommendation
- **Ask user for preference**

**Example output**:
```
I've designed 3 approaches:

Approach 1: Minimal Changes
- Extend existing AuthService with OAuth methods
- Add new OAuth routes to existing auth router
Pros: Fast, low risk
Cons: Couples OAuth to existing auth

Approach 2: Clean Architecture
- New OAuthService with dedicated interface
- Separate OAuth router and middleware
Pros: Clean separation, testable
Cons: More files, more refactoring

Approach 3: Pragmatic Balance
- New OAuthProvider abstraction
- Integrate into existing AuthService
Pros: Balanced complexity
Cons: Some coupling remains

Recommendation: Approach 3

Which approach would you like to use?
```

### Phase 5: Implementation

**Goal**: Build the feature following approved architecture

**Process**:
- **Wait for explicit approval** before starting
- Read all relevant files from Phase 2
- Implement following chosen architecture
- Follow codebase conventions strictly
- Write clean, well-documented code
- Update todos as progress is made

**Key principle**: Implementation only starts after approval.

### Phase 6: Quality Review

**Goal**: Ensure code is simple, DRY, elegant, and correct

**Process**:
- Launch 3 `code-reviewer` agents in parallel with different focuses:
  - **Simplicity/DRY/Elegance**: Code quality and maintainability
  - **Bugs/Correctness**: Functional correctness and logic errors
  - **Conventions/Abstractions**: Project standards and patterns
- Consolidate findings
- Identify highest severity issues
- **Present findings and ask user**:
  - Fix now
  - Fix later
  - Proceed as-is
- Address based on decision

**Example output**:
```
Code Review Results:

High Priority Issues:
1. Missing error handling in OAuth callback (src/auth/oauth.ts:67)
2. Memory leak: OAuth state not cleaned up (src/auth/oauth.ts:89)

Medium Priority:
1. Could simplify token refresh logic
2. Consider extracting OAuth config validation

All tests pass. Code follows project conventions.

What would you like to do?
```

### Phase 7: Summary

**Goal**: Document accomplishments and next steps

**Process**:
- Mark all todos complete
- Summarize:
  - What was built
  - Key decisions made
  - Files modified
  - Suggested next steps

**Example**:
```
Feature Complete: OAuth Authentication

What was built:
- OAuth provider abstraction supporting Google and GitHub
- OAuth routes and middleware integrated with existing auth
- Token refresh and session integration

Key decisions:
- Used pragmatic approach with OAuthProvider abstraction
- Integrated with existing session management

Files modified:
- src/auth/OAuthProvider.ts (new)
- src/auth/AuthService.ts
- src/routes/auth.ts

Suggested next steps:
- Add tests for OAuth flows
- Add more OAuth providers (Microsoft, Apple)
```

---

## Specialized Agents Deep Dive

### Code Explorer Agent

**Purpose**: Deeply analyzes existing codebase features by tracing execution paths

**Frontmatter**:
```yaml
name: code-explorer
description: Deeply analyzes existing codebase features by tracing execution paths...
tools: ["Glob", "Grep", "LS", "Read", "NotebookRead", "WebFetch", "TodoWrite", "WebSearch", "KillShell", "BashOutput"]
model: sonnet
color: yellow
```

**Core Responsibilities**:
1. Find entry points (APIs, UI components, CLI commands)
2. Locate core implementation files
3. Map feature boundaries and configuration
4. Follow call chains from entry to output
5. Trace data transformations at each step
6. Identify all dependencies and integrations
7. Document state changes and side effects
8. Map abstraction layers
9. Identify design patterns and architectural decisions

**Analysis Approach**:
```
1. Feature Discovery
   - Find entry points
   - Locate core implementation files
   - Map feature boundaries

2. Code Flow Tracing
   - Follow call chains
   - Trace data transformations
   - Identify dependencies

3. Architecture Analysis
   - Map abstraction layers
   - Identify design patterns
   - Document interfaces

4. Implementation Details
   - Key algorithms and data structures
   - Error handling and edge cases
   - Performance considerations
```

**Output Guidance**:
- Entry points with file:line references
- Step-by-step execution flow with data transformations
- Key components and their responsibilities
- Architecture insights: patterns, layers, design decisions
- Dependencies (external and internal)
- List of essential files to read

### Code Architect Agent

**Purpose**: Designs feature architectures by analyzing existing patterns

**Frontmatter**:
```yaml
name: code-architect
description: Designs feature architectures by analyzing existing codebase patterns...
tools: ["Glob", "Grep", "LS", "Read", "NotebookRead", "WebFetch", "TodoWrite", "WebSearch", "KillShell", "BashOutput"]
model: sonnet
color: green
```

**Core Process**:
1. **Codebase Pattern Analysis**
   - Extract existing patterns and conventions
   - Identify technology stack
   - Find module boundaries and abstraction layers
   - Find similar features

2. **Architecture Design**
   - Design complete feature architecture
   - Make decisive choices (pick one approach)
   - Ensure seamless integration
   - Design for testability and maintainability

3. **Complete Implementation Blueprint**
   - Specify every file to create or modify
   - Define component responsibilities
   - Document integration points and data flow
   - Break into clear phases with specific tasks

**Output Guidance**:
- **Patterns & Conventions Found**: Existing patterns with file:line references
- **Architecture Decision**: Chosen approach with rationale
- **Component Design**: Each component with file path, responsibilities, dependencies
- **Implementation Map**: Specific files to create/modify
- **Data Flow**: Complete flow from entry points through transformations
- **Build Sequence**: Phased implementation steps as checklist

**Key Principle**: "Make confident architectural choices rather than presenting multiple options."

### Code Reviewer Agent

**Purpose**: Reviews code for bugs, quality issues, and project conventions

**Frontmatter**:
```yaml
name: code-reviewer
description: Reviews code for bugs, logic errors, security vulnerabilities...
tools: ["Glob", "Grep", "LS", "Read", "NotebookRead", "WebFetch", "TodoWrite", "WebSearch", "KillShell", "BashOutput"]
model: sonnet
color: red
```

**Review Scope**:
- **Project Guidelines Compliance**: Verify adherence to CLAUDE.md, import patterns, framework conventions
- **Bug Detection**: Logic errors, null/undefined handling, race conditions, memory leaks, security vulnerabilities
- **Code Quality**: Duplication, missing error handling, accessibility, test coverage

#### Confidence Scoring System

Rates each issue 0-100:

| Range | Meaning |
|-------|---------|
| 0 | False positive, not confident at all |
| 25 | Somewhat confident, might be false positive |
| 50 | Moderately confident, real issue but not critical |
| 75 | Highly confident, verified real issue |
| 100 | Absolutely certain, will happen frequently |

**Rule**: **Only report issues with confidence >= 80.**

#### Output Structure

```
## Critical Issues (confidence 80-100)
- `file:line` - Issue description with confidence score
- Project guideline reference or bug explanation
- Concrete fix suggestion

## Important Issues (confidence 50-74)
- Lower confidence issues that may matter
```

---

## Triggering Mechanism

### Description Field Structure

The `description` field is the most critical for triggering. It must include:

1. **Trigger phrase**: "Use this agent when..."
2. **Example blocks**: 2-4 `<example>` blocks showing usage

### Example Block Format

```markdown
<example>
Context: [Situation description - what led to this interaction]
user: "[Exact user message]"
assistant: "[How Claude should respond before triggering]"
<commentary>
[Explanation of why agent should trigger]
</commentary>
assistant: "[How Claude triggers the agent]"
</example>
```

### Complete Example

```yaml
description: |
  Use this agent when the user asks to review code, check quality issues,
  or validate implementation. Examples:

  <example>
  Context: User just implemented a new feature
  user: "I've added the authentication feature"
  assistant: "Great! Let me review the code quality."
  <commentary>
  Code was written, trigger code-reviewer agent for review.
  </commentary>
  assistant: "I'll use the code-reviewer agent to analyze the changes."
  </example>

  <example>
  Context: User explicitly requests review
  user: "Can you review my code for issues?"
  assistant: "I'll use the code-reviewer agent to perform a thorough review."
  <commentary>
  Explicit review request triggers the agent.
  </commentary>
  </example>
```

### Types of Triggering Examples

| Type | Description | Example |
|------|-------------|---------|
| **Explicit Request** | User directly asks | "Review my code" |
| **Proactive** | Agent triggers after relevant work | After code is written |
| **Implicit** | User implies need | "This code is confusing" |
| **Tool Usage Pattern** | Based on prior tool usage | Multiple Edit tools used |

### Multiple Examples Strategy

Include 2-4 examples covering:
- Different phrasings for same intent
- Both explicit and proactive triggering
- Different contexts and scenarios

### Common Mistakes to Avoid

| Mistake | Why It's Bad | Fix |
|---------|--------------|-----|
| Missing context | No scene-setting | Add situation description |
| No commentary | No reasoning | Explain WHY trigger |
| Direct output | Shows results, not triggering | Show agent invocation |
| Too few examples | Limited triggering | Cover multiple scenarios |
| Generic descriptions | Too broad | Be specific |

---

## System Prompt Design Patterns

### Standard Structure

Every agent system prompt follows this proven structure:

```markdown
You are [specific role] specializing in [specific domain].

**Your Core Responsibilities:**
1. [Primary responsibility]
2. [Secondary responsibility]
3. [Additional responsibilities...]

**[Task Name] Process:**
1. [First concrete step]
2. [Second concrete step]
3. [Continue with clear steps]

**Quality Standards:**
- [Standard 1 with specifics]
- [Standard 2 with specifics]

**Output Format:**
Provide results structured as:
- [Component 1]
- [Component 2]

**Edge Cases:**
Handle these situations:
- [Edge case 1]: [Specific handling]
- [Edge case 2]: [Specific handling]
```

### Key Writing Guidelines

**Tone and Voice**:
- Use second person: "You are...", "You will...", "Your responsibilities..."
- Avoid first person: "I am...", "I will..."

**Clarity and Specificity**:
- Be specific, not vague
- Provide file:line references
- Categorize by severity

**Actionable Instructions**:
- Give concrete steps
- Define output format
- Include quality metrics

### Pattern 1: Analysis Agents

```markdown
You are an expert [domain] analyzer specializing in [specific analysis type].

**Your Core Responsibilities:**
1. Thoroughly analyze [what] for [specific issues]
2. Identify [patterns/problems/opportunities]
3. Provide actionable recommendations

**Analysis Process:**
1. **Gather Context**: Read [what] using available tools
2. **Initial Scan**: Identify obvious [issues/patterns]
3. **Deep Analysis**: Examine [specific aspects]:
   - [Aspect 1]: Check for [criteria]
   - [Aspect 2]: Verify [criteria]
4. **Synthesize Findings**: Group related issues
5. **Prioritize**: Rank by [severity/impact/urgency]
6. **Generate Report**: Format according to output template

**Output Format:**
## Summary
[2-3 sentence overview]

## Critical Issues
- [file:line] - [Issue] - [Recommendation]

## Major Issues
[...]

## Recommendations
[...]
```

### Pattern 2: Generation Agents

```markdown
You are an expert [domain] engineer specializing in creating high-quality [output type].

**Your Core Responsibilities:**
1. Generate [what] that meets [quality standards]
2. Follow [specific conventions/patterns]
3. Ensure [correctness/completeness/clarity]

**Generation Process:**
1. **Understand Requirements**: Analyze what needs to be created
2. **Gather Context**: Read existing [code/docs/tests] for patterns
3. **Design Structure**: Plan [architecture/organization/flow]
4. **Generate Content**: Create [output] following conventions
5. **Validate**: Verify [correctness/completeness]
6. **Document**: Add comments/explanations as needed
```

### Pattern 3: Validation Agents

```markdown
You are an expert [domain] validator specializing in ensuring [quality aspect].

**Your Core Responsibilities:**
1. Validate [what] against [criteria]
2. Identify violations and issues
3. Provide clear pass/fail determination

**Validation Process:**
1. **Load Criteria**: Understand validation requirements
2. **Scan Target**: Read [what] needs validation
3. **Check Rules**: For each rule, apply validation method
4. **Collect Violations**: Document each with details
5. **Assess Severity**: Categorize issues
6. **Determine Result**: Pass only if [criteria met]
```

### Pattern 4: Orchestration Agents

```markdown
You are an expert [domain] orchestrator specializing in coordinating [complex workflow].

**Your Core Responsibilities:**
1. Coordinate [multi-step process]
2. Manage [resources/tools/dependencies]
3. Ensure [successful completion/integration]

**Orchestration Process:**
1. **Plan**: Understand full workflow and dependencies
2. **Prepare**: Set up prerequisites
3. **Execute Phases**:
   - Phase 1: [What] using [tools]
   - Phase 2: [What] using [tools]
4. **Monitor**: Track progress, handle failures
5. **Verify**: Confirm successful completion
6. **Report**: Provide comprehensive summary
```

### Length Guidelines

| Agent Type | Word Count | Description |
|------------|-----------|-------------|
| Minimum | 500+ | Role + 3 responsibilities + 5 steps + output format |
| Standard | 1,000-2,000 | Detailed role + 5-8 responsibilities + 8-12 steps |
| Comprehensive | 2,000-5,000 | Complete with examples, extensive edge cases |
| Maximum | <10,000 | Beyond this has diminishing returns |

---

## Tool Access and Privileges

### Principle of Least Privilege

Claude Code restricts agent tool access to the minimum needed:

```yaml
# Read-only analysis agents
tools: ["Read", "Grep", "Glob"]

# Code generation agents
tools: ["Read", "Write", "Grep"]

# Full-stack agents
tools: ["Read", "Write", "Grep", "Bash"]

# Executor agents
tools: ["Read", "Write", "Bash", "Glob", "Grep", "TodoWrite"]
```

### Common Tool Sets

| Purpose | Tools |
|---------|-------|
| Code analysis | `["Read", "Grep", "Glob"]` |
| Test generation | `["Read", "Write", "Grep", "Bash"]` |
| Documentation | `["Read", "Write", "Grep", "Glob"]` |
| Plugin validation | `["Read", "Grep", "Glob", "Bash"]` |
| Full access | Omit `tools` field |

### Complete Tool Reference

| Tool | Purpose |
|------|---------|
| `Read` | Read file contents |
| `Write` | Create/overwrite files |
| `Edit` | Modify file contents |
| `Glob` | Find files by pattern |
| `Grep` | Search file contents |
| `Bash` | Execute shell commands |
| `TodoWrite` | Update task lists |
| `WebFetch` | Fetch URL content |
| `WebSearch` | Search the web |
| `NotebookRead` | Read Jupyter notebooks |
| `KillShell` | Terminate shell processes |
| `BashOutput` | Get shell output |

---

## Quality Assurance Framework

### Agent Validation Script

Claude Code provides `validate-agent.sh` to validate agent files:

```bash
./scripts/validate-agent.sh agents/your-agent.md
```

### Validation Checks

| Check | What It Validates | Severity |
|-------|-------------------|----------|
| Frontmatter present | File starts with `---` | Error |
| Closing frontmatter | Second `---` present | Error |
| Required fields | name, description, model, color | Error |
| Name format | lowercase, hyphens, 3-50 chars | Error |
| Description length | 10-5,000 characters | Warning |
| Trigger examples | `<example>` blocks present | Warning |
| "Use this agent when" | Trigger phrase present | Warning |
| Model valid | inherit/sonnet/opus/haiku | Warning |
| Color valid | blue/cyan/green/yellow/magenta/red | Warning |
| System prompt length | 20-10,000 chars | Warning |
| Second person | Uses "You are/You will" | Warning |

### Output Example

```
🔍 Validating agent file: agents/code-reviewer.md

✅ File exists
✅ Starts with frontmatter
✅ Frontmatter properly closed

Checking required fields...
✅ name: code-reviewer
✅ description: 1245 characters
✅ model: sonnet
✅ color: red

Checking system prompt...
✅ System prompt: 3245 characters

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ All checks passed!
```

### Confidence-Based Reporting

The code-reviewer agent uses confidence scoring to reduce noise:

| Confidence | Action |
|------------|--------|
| 0-49 | Never report (false positives) |
| 50-74 | Report as "Important" |
| 75-100 | Report as "Critical" |

---

## Plugin System Structure

### Plugin Manifest (.claude-plugin/plugin.json)

```json
{
  "name": "feature-dev",
  "version": "1.0.0",
  "description": "Structured feature development workflow",
  "author": "Claude Code",
  "mcpServers": {
    "filesystem": {
      "command": "uvx",
      "args": ["--from", "mcp-server-filesystem", "mcp-server-filesystem"]
    }
  }
}
```

### Directory Organization

```
feature-dev/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   └── feature-dev.md           # /feature-dev command
├── agents/
│   ├── code-explorer.md
│   ├── code-architect.md
│   └── code-reviewer.md
├── skills/
│   └── agent-development/
│       ├── SKILL.md
│       ├── references/
│       │   ├── system-prompt-design.md
│       │   ├── triggering-examples.md
│       │   └── agent-creation-system-prompt.md
│       ├── examples/
│       │   ├── agent-creation-prompt.md
│       │   └── complete-agent-examples.md
│       └── scripts/
│           └── validate-agent.sh
└── README.md
```

### Progressive Disclosure

Claude Code implements **progressive disclosure** for skill documentation:

1. **SKILL.md**: Essential information only (1,000-3,000 words)
2. **references/**: Detailed documentation
3. **examples/**: Working code examples
4. **scripts/**: Utility scripts

This keeps the main skill file lean while providing deep resources.

---

## Comparison with Clawd-App

### Current Clawd-App Architecture

```
clawd-app/
├── src/
│   ├── index.ts              # Main entry
│   ├── config.ts             # Configuration
│   ├── agent.ts              # Agent context
│   ├── worker-loop.ts        # Per-agent worker loop
│   ├── worker-manager.ts     # Manages multiple loops
│   └── api/providers/
│       ├── anthropic/        # Anthropic API
│       │   └── client.ts
│       ├── openai/           # OpenAI API
│       │   └── client.ts
│       └── factory.ts        # Provider factory
├── packages/ui/
│   └── src/
│       └── AgentDialog.tsx   # Agent management UI
└── CLAUDE.md                 # Project guidelines
```

### Key Differences

| Aspect | Claude Code | Clawd-App |
|--------|-------------|-----------|
| **Architecture** | Multi-agent with specialized roles | Single-agent loop per channel |
| **Workflow** | 7-phase structured process | Continuous streaming |
| **Triggering** | Example-based descriptions | Programmatic configuration |
| **Quality Review** | Dedicated code-reviewer agent | No automated review |
| **Architecture Design** | code-architect agent | No dedicated planning |
| **Exploration** | code-explorer agent | Manual investigation |
| **State Management** | Persistent agent sessions | WorkerLoop per request |
| **Configuration** | YAML frontmatter + plugin.json | TypeScript config |
| **Tool Access** | Per-agent restrictions | Same tools for all |
| **UI** | CLI-based | Electron + React UI |

### Clawd-App Strengths

1. **Real-time streaming**: Messages flow continuously
2. **Multi-provider**: Supports Anthropic and OpenAI
3. **Per-project**: Each agent can have different project root
4. **Desktop integration**: Full GUI with file browser
5. **Agent persistence**: Workers can run continuously

### Clawd-App Gaps

1. **No structured planning phase**: Jumps straight to implementation
2. **No code review**: Quality issues caught manually
3. **No architecture design**: Decisions made ad-hoc
4. **No exploration agent**: Requires manual investigation
5. **No clarifying questions**: Assumptions made without validation
6. **Single-loop architecture**: Each agent works in isolation
7. **No multi-agent coordination**: No parallel exploration/design
8. **No quality gates**: No automated checks before "complete"

---

## Recommendations for Clawd-App

### Phase 1: Enhanced Single-Agent Loop

Improve the existing WorkerLoop with Claude Code patterns:

#### 1.1 Add Planning Phase to WorkerLoop

```typescript
// Before starting work, agent pauses for planning
async planTask(message: string): Promise<TaskPlan> {
  const planningPrompt = `
    You are about to implement: "${message}"

    Before starting, analyze:
    1. What files need to be read/created/modified
    2. Potential edge cases and error scenarios
    3. Dependencies and integration points
    4. Testing approach

    Provide a brief plan (3-5 steps).
  `;

  return await this.anthropic.complete(planningPrompt);
}
```

#### 1.2 Implement Confidence-Based Review

```typescript
async reviewChanges(): Promise<ReviewResult> {
  const reviewPrompt = `
    Review these changes for:
    - Security issues (confidence >= 90)
    - Bugs (confidence >= 85)
    - Code quality (confidence >= 80)

    Only report issues above confidence threshold.
  `;

  // Only surface high-confidence issues
}
```

#### 1.3 Add Clarifying Questions

```typescript
async askClarifyingQuestions(ambiguities: string[]): Promise<string[]> {
  if (ambiguities.length > 0) {
    this.pauseAndWait(ambiguities);
  }
}
```

### Phase 2: Multi-Agent Coordination

Introduce specialized agents for complex tasks:

#### 2.1 Explorer Agent

```yaml
# src/agents/code-explorer.md
---
name: code-explorer
description: Use this agent when understanding existing code patterns...
model: inherit
color: yellow
---

You are an expert code analyst...

**Your Core Responsibilities:**
1. Find entry points for the feature
2. Trace execution flow
3. Map dependencies and integrations
...
```

#### 2.2 Architect Agent

```yaml
# src/agents/code-architect.md
---
name: code-architect
description: Use this agent when designing new features...
model: inherit
color: green
---

You are a senior software architect...

**Your Core Responsibilities:**
1. Analyze existing patterns
2. Design clean architecture
3. Create implementation blueprint
...
```

#### 2.3 Reviewer Agent

```yaml
# src/agents/code-reviewer.md
---
name: code-reviewer
description: Use this agent when code needs quality review...
model: inherit
color: red
---

You are an expert code reviewer...

**Your Core Responsibilities:**
1. Check for bugs (confidence >= 85)
2. Check for security issues (confidence >= 90)
3. Check for code quality (confidence >= 80)
...
```

### Phase 3: Structured Workflow Integration

Implement 7-phase workflow as a reusable system:

#### 3.1 Workflow Orchestrator

```typescript
interface WorkflowPhase {
  name: string;
  execute(): Promise<PhaseResult>;
  canProceed(): boolean;
}

class FeatureWorkflow {
  phases: WorkflowPhase[] = [
    new DiscoveryPhase(),
    new ExplorationPhase(),
    new ClarificationPhase(),
    new ArchitecturePhase(),
    new ImplementationPhase(),
    new ReviewPhase(),
    new SummaryPhase(),
  ];

  async run(featureRequest: string): Promise<void> {
    for (const phase of this.phases) {
      await phase.execute();
      if (!phase.canProceed()) break;
    }
  }
}
```

#### 3.2 Parallel Agent Execution

```typescript
async exploreInParallel(requests: string[]): Promise<AnalysisResult[]> {
  return await Promise.all(
    requests.map(req => this.codeExplorer.analyze(req))
  );
}
```

### Phase 4: UI Integration

Add workflow awareness to AgentDialog:

#### 4.1 Phase Indicator

```tsx
// In AgentDialog.tsx
<div className="workflow-phase-indicator">
  {currentPhase === 'discovery' && <DiscoveryIcon />}
  {currentPhase === 'exploration' && <ExplorationIcon />}
  {/* ... */}
  <span>Current: {phaseName}</span>
</div>
```

#### 4.2 Progress Tracking

```tsx
function WorkflowProgress({ phase, tasks }: Props) {
  return (
    <div className="workflow-progress">
      <ProgressBar value={phase / 7} />
      <TaskList tasks={tasks} />
    </div>
  );
}
```

### Phase 5: Validation and Testing

Add agent validation:

```bash
# scripts/validate-agent.sh
- Check frontmatter structure
- Validate name format (lowercase-hyphens)
- Verify description has <example> blocks
- Check system prompt length and structure
- Validate model and color values
```

### Implementation Priority Matrix

| Feature | Effort | Impact | Priority |
|---------|--------|--------|----------|
| Add planning to WorkerLoop | Low | High | 1 |
| Confidence-based review | Low | High | 2 |
| Clarifying questions | Medium | High | 3 |
| Explorer agent | Medium | High | 4 |
| Architect agent | Medium | High | 5 |
| Reviewer agent | Low | High | 6 |
| Workflow orchestrator | High | Very High | 7 |
| UI phase indicators | Medium | Medium | 8 |
| Validation scripts | Low | Medium | 9 |

### Risk Assessment

| Risk | Mitigation |
|------|------------|
| Increased latency from planning | Keep plans brief (3-5 steps) |
| More complex codebase | Use clear separation of concerns |
| User confusion | Add UI indicators for phases |
| Tool proliferation | Start with essential agents only |

### Success Metrics

- **Planning**: Agents produce actionable plans before coding
- **Review**: 80%+ of issues caught by automated review
- **Architecture**: Clear blueprints for new features
- **User satisfaction**: Reduced back-and-forth on ambiguities

---

## Appendix A: Agent Template Library

### Minimal Agent Template

```markdown
---
name: [agent-name]
description: |
  Use this agent when [triggering conditions]. Examples:

  <example>
  Context: [Situation]
  user: "[User message]"
  assistant: "[Response]"
  <commentary>
  [Why triggers]
  </commentary>
  </example>

model: inherit
color: [blue/cyan/green/yellow/magenta/red]
---

You are [role] specializing in [domain].

**Your Core Responsibilities:**
1. [Responsibility 1]
2. [Responsibility 2]

**Process:**
1. [Step 1]
2. [Step 2]

**Output Format:**
[Format description]
```

### Analysis Agent Template

```markdown
---
name: [analyzer]
description: Use this agent when [analysis needs]. Examples: <example>...</example>
model: sonnet
color: yellow
tools: ["Read", "Grep", "Glob"]
---

You are an expert [domain] analyzer.

**Your Core Responsibilities:**
1. Analyze [targets] for [issues]
2. Identify [patterns/opportunities]
3. Provide recommendations

**Analysis Process:**
1. **Gather Context**: Read relevant files
2. **Scan**: Identify obvious issues
3. **Deep Analysis**: Examine specific aspects
4. **Synthesize**: Group related findings
5. **Prioritize**: Rank by severity

**Output Format:**
## Summary
[Overview]

## Critical Issues
- `file:line` - [Issue]

## Recommendations
[Action items]
```

### Reviewer Agent Template

```markdown
---
name: [reviewer]
description: Use this agent when [review needs]. Examples: <example>...</example>
model: sonnet
color: red
tools: ["Read", "Grep", "Glob"]
---

You are an expert code reviewer.

**Your Core Responsibilities:**
1. Find bugs (confidence >= 85)
2. Find security issues (confidence >= 90)
3. Find quality issues (confidence >= 80)

**Review Process:**
1. Gather changes (git diff)
2. Read modified files
3. Analyze each issue
4. Assign confidence score
5. Report only confidence >= threshold

**Output Format:**
## Critical Issues (>=90 confidence)
[Issues]

## Important Issues (85-89 confidence)
[Issues]
```

---

## Appendix B: Complete Agent Example

### code-explorer.md (Full)

```markdown
---
name: code-explorer
description: Deeply analyzes existing codebase features by tracing execution paths, mapping architecture layers, understanding patterns and abstractions, and documenting dependencies to inform new development
tools: ["Glob", "Grep", "LS", "Read", "NotebookRead", "WebFetch", "TodoWrite", "WebSearch", "KillShell", "BashOutput"]
model: sonnet
color: yellow
---

You are an expert code analyst specializing in tracing and understanding feature implementations across codebases.

## Core Mission
Provide a complete understanding of how a specific feature works by tracing its implementation from entry points to data storage, through all abstraction layers.

## Analysis Approach

**1. Feature Discovery**
- Find entry points (APIs, UI components, CLI commands)
- Locate core implementation files
- Map feature boundaries and configuration

**2. Code Flow Tracing**
- Follow call chains from entry to output
- Trace data transformations at each step
- Identify all dependencies and integrations
- Document state changes and side effects

**3. Architecture Analysis**
- Map abstraction layers (presentation → business logic → data)
- Identify design patterns and architectural decisions
- Document interfaces between components
- Note cross-cutting concerns (auth, logging, caching)

**4. Implementation Details**
- Key algorithms and data structures
- Error handling and edge cases
- Performance considerations
- Technical debt or improvement areas

## Output Guidance

Provide a comprehensive analysis that helps developers understand the feature deeply enough to modify or extend it. Include:

- Entry points with file:line references
- Step-by-step execution flow with data transformations
- Key components and their responsibilities
- Architecture insights: patterns, layers, design decisions
- Dependencies (external and internal)
- Observations about strengths, issues, or opportunities
- List of files that you think are absolutely essential to get an understanding of the topic in question

Structure your response for maximum clarity and usefulness. Always include specific file paths and line numbers.
```

---

## Appendix C: Color System Reference

| Color | Hex | Purpose | Agent Examples |
|-------|-----|---------|----------------|
| blue | #3B82F6 | Analysis, review | code-reviewer, pr-analyzer |
| cyan | #06B6D4 | Documentation | docs-generator, skill-reviewer |
| green | #22C55E | Generation | test-generator, code-generator |
| yellow | #EAB308 | Caution, validation | plugin-validator, code-explorer |
| red | #EF4444 | Critical, security | security-analyzer, bug-hunter |
| magenta | #D946EF | Creative, transformation | agent-creator, refactorer |

---

## Conclusion

Claude Code's agent system demonstrates a mature approach to autonomous software development with:

1. **Specialized agents** for distinct responsibilities
2. **Structured workflows** that ensure quality at each phase
3. **Example-based triggering** that reduces false positives
4. **Confidence scoring** to filter noise from reviews
5. **Progressive disclosure** to keep documentation manageable
6. **Tool restrictions** following least-privilege principles

Implementing even a subset of these patterns in clawd-app would significantly improve code quality and developer productivity. The recommended phased approach allows incremental adoption without disrupting the existing streaming architecture.

The key insight is that **structure doesn't mean bureaucracy** - Claude Code's workflow is efficient because each phase produces actionable outputs that feed into the next. Clawd-app can adopt this pattern while maintaining its real-time streaming advantage.

---

## 12. Hook and Event System

Claude Code implements a powerful hook system that intercepts events throughout the agent lifecycle. This enables security checks, automation, and custom behaviors.

### Hook Event Types

| Event | When Triggered | Purpose |
|-------|----------------|---------|
| `PreToolUse` | Before any tool executes | Validation, security checks, warnings |
| `PostToolUse` | After a tool completes | Logging, cleanup, follow-up actions |
| `Stop` | When agent wants to stop | Final checks, cleanup |
| `UserPromptSubmit` | When user submits prompt | Pre-processing, context enrichment |

### Hook Configuration (`hooks/hooks.json`)

```json
{
  "description": "Hookify plugin - User-configurable hooks from .local.md files",
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [...],
    "Stop": [...],
    "UserPromptSubmit": [...]
  }
}
```

### Hook Input Data Structure

```python
input_data = {
    'session_id': 'abc123',              # Session identifier
    'tool_name': 'Bash',                 # Tool being executed
    'tool_input': {                      # Tool parameters
        'command': 'rm -rf /tmp/test'
    },
    'hook_event_name': 'bash',           # Event type (derived from tool_name)
    'transcript_path': '/path/to/transcript',  # For Stop events
    'reason': 'Task completed',           # For Stop events
    'user_prompt': 'Fix this bug'        # For UserPromptSubmit
}
```

### Hook Response Formats

**Allow operation:**
```python
{}  # Empty JSON
```

**Show warning but allow:**
```python
{
    "systemMessage": "⚠️ Security warning message shown to user"
}
```

**Block operation (PreToolUse):**
```python
{
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny"
    },
    "systemMessage": "Operation blocked by security rule"
}
```

**Block operation (Stop):**
```python
{
    "decision": "block",
    "reason": "Stop operation blocked",
    "systemMessage": "Cannot stop - cleanup required"
}
```

### Hook Exit Codes

| Exit Code | Meaning |
|-----------|---------|
| 0 | Allow operation (default) |
| 1+ | Reserved for future use |
| 2 | Block (PreToolUse hooks) |

---

## 13. Rule Engine

Claude Code implements a powerful regex-based rule engine for hook processing.

### Rule File Format (`.claude/hookify.*.local.md`)

```markdown
---
name: block-dangerous-rm
enabled: true
event: bash
conditions:
  - field: command
    operator: regex_match
    pattern: rm\s+-rf
action: block
---

⚠️ Dangerous command detected!
```

### Condition Structure

```python
@dataclass
class Condition:
    field: str      # "command", "new_text", "old_text", "file_path", etc.
    operator: str    # "regex_match", "contains", "equals", etc.
    pattern: str    # Pattern to match
```

### Supported Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `regex_match` | Regex pattern matching | `rm\s+-rf` |
| `contains` | Substring presence | `"test"` in command |
| `equals` | Exact match | `"ls"` == command |
| `not_contains` | Absence of substring | No `"sudo"` |
| `starts_with` | Prefix match | `git` starts command |
| `ends_with` | Suffix match | `.py` ends file |

### Field Extraction

The rule engine extracts fields from tool input:

```python
def _extract_field(self, field, tool_name, tool_input, input_data):
    # Bash tool
    if tool_name == 'Bash':
        if field == 'command':
            return tool_input.get('command', '')

    # Write/Edit tools
    elif tool_name in ['Write', 'Edit']:
        if field == 'content':
            return tool_input.get('content') or tool_input.get('new_string', '')
        elif field == 'file_path':
            return tool_input.get('file_path', '')

    # MultiEdit
    elif tool_name == 'MultiEdit':
        if field == 'file_path':
            return tool_input.get('file_path', '')
        elif field in ['new_text', 'content']:
            edits = tool_input.get('edits', [])
            return ' '.join(e.get('new_string', '') for e in edits)

    return None
```

### LRU-Cached Regex Compilation

```python
from functools import lru_cache

@lru_cache(maxsize=128)
def compile_regex(pattern: str) -> re.Pattern:
    """Compile regex with caching for performance."""
    return re.compile(pattern, re.IGNORECASE)
```

### Rule Priority System

1. **Blocking rules** take precedence over warning rules
2. All matching block rules combine messages
3. If any block matches, operation is denied
4. Warning rules run but don't block

---

## 14. Session State Management

Claude Code manages session-scoped state through JSON files in `~/.claude/`.

### Session State File Pattern

```python
# Session-specific state file
def get_state_file(session_id):
    return os.path.expanduser(f"~/.claude/security_warnings_state_{session_id}.json")
```

### State Persistence Pattern

```python
def load_state(session_id):
    """Load the state of shown warnings from file."""
    state_file = get_state_file(session_id)
    if os.path.exists(state_file):
        try:
            with open(state_file, "r") as f:
                return set(json.load(f))
        except (json.JSONDecodeError, IOError):
            return set()
    return set()

def save_state(session_id, shown_warnings):
    """Save the state of shown warnings to file."""
    state_file = get_state_file(session_id)
    try:
        os.makedirs(os.path.dirname(state_file), exist_ok=True)
        with open(state_file, "w") as f:
            json.dump(list(shwn_warnings), f)
    except IOError:
        pass  # Fail silently if we can't save
```

### Session State Cleanup

```python
def cleanup_old_state_files():
    """Remove state files older than 30 days."""
    state_dir = os.path.expanduser("~/.claude")
    current_time = datetime.now().timestamp()
    thirty_days_ago = current_time - (30 * 24 * 60 * 60)

    for filename in os.listdir(state_dir):
        if filename.startswith("security_warnings_state_") and filename.endswith(".json"):
            file_path = os.path.join(state_dir, filename)
            file_mtime = os.path.getmtime(file_path)
            if file_mtime < thirty_days_ago:
                os.remove(file_path)
```

### State Usage Pattern

```python
def main():
    # Extract session ID from hook input
    session_id = input_data.get("session_id", "default")

    # Load existing warnings for this session
    shown_warnings = load_state(session_id)

    # Check if we've already shown this warning
    warning_key = f"{file_path}-{rule_name}"
    if warning_key not in shown_warnings:
        shown_warnings.add(warning_key)
        save_state(session_id, shown_warnings)

        # Block and show warning
        print(reminder, file=sys.stderr)
        sys.exit(2)
```

---

## 15. Command System

Commands are slash commands with restricted tool access and inline execution.

### Command Definition Format

```markdown
---
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)
description: Create a git commit
---

## Context

- Current git status: !`git status`
- Current git diff: !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Your task

Based on the above changes, create a single git commit.
```

### Allowed Tools Syntax

| Pattern | Meaning |
|---------|---------|
| `Bash` | Allow Bash tool with no restrictions |
| `Bash(git add:*)` | Allow Bash with git add subcommand |
| `Bash(git add:*), Bash(git commit:*)` | Multiple specific patterns |
| `mcp__github__*` | Allow all MCP tools from github server |

### Inline Commands

Commands can execute and embed results using `!`command`` syntax:

```markdown
- Current git status: !`git status`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`
```

### Command Execution Flow

1. User invokes `/command-name [args]`
2. Command file is loaded
3. Inline commands execute and results embed in context
4. Agent receives command with:
   - Description
   - Allowed tools restriction
   - Context with inline command results
   - User arguments

---

## 16. Task and Sub-Agent Delegation

Claude Code implements sophisticated task delegation with parallel execution.

### Task Spawning Pattern

```markdown
1. Launch a haiku agent to check if any of the following are true:
   - The pull request is closed
   - The pull request is a draft

2. Launch a haiku agent to return a list of file paths for all relevant CLAUDE.md files

3. Launch a sonnet agent to view the pull request and return a summary

4. Launch 4 agents in parallel to independently review the changes
```

### Agent Model Selection

| Model | Use Case |
|--------|----------|
| `haiku` | Simple checks, boolean conditions, basic retrieval |
| `sonnet` | Standard analysis, moderate complexity |
| `opus` | Complex bugs, deep logic analysis, critical decisions |

### Parallel Execution Pattern

```markdown
Agents 1 + 2: CLAUDE.md compliance sonnet agents
Audit changes for CLAUDE.md compliance in parallel.

Agent 3: Opus bug agent (parallel subagent with agent 4)
Scan for obvious bugs.

Agent 4: Opus bug agent (parallel subagent with agent 3)
Look for problems in the introduced code.
```

### Sequential Delegation

```markdown
1. Launch agents to validate preconditions
2. Launch agents to gather context
3. Launch agents for parallel analysis
4. For each issue found, launch parallel subagents to validate
5. Filter and consolidate findings
6. Execute final actions
```

### Subagent Communication Pattern

```markdown
For each issue found in the previous step by agents 3 and 4,
launch parallel subagents to validate the issue.

These subagents should get:
- PR title and description
- Description of the issue

The agent's job is to validate that the stated issue is truly an issue
with high confidence.
```

---

## 17. MCP (Model Context Protocol) Integration

Claude Code supports external tools via MCP with multiple transport types.

### Stdio MCP Configuration

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "${CLAUDE_PROJECT_DIR}"],
    "env": {
      "LOG_LEVEL": "info"
    }
  },
  "database": {
    "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server.js",
    "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config/db.json"],
    "env": {
      "DATABASE_URL": "${DATABASE_URL}",
      "DB_POOL_SIZE": "10"
    }
  }
}
```

### HTTP/SSE MCP Configuration

```json
{
  "rest-api": {
    "type": "http",
    "url": "https://api.example.com/mcp",
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}",
      "Content-Type": "application/json"
    }
  }
}
```

### MCP Tool Invocation Syntax

```markdown
allowed-tools: mcp__github_inline_comment__create_inline_comment
```

### Environment Variable Substitution

| Variable | Description |
|----------|-------------|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin root directory |
| `${CLAUDE_PROJECT_DIR}` | Project directory |
| `${API_TOKEN}` | Custom API tokens |
| `${DATABASE_URL}` | Database connection strings |

### MCP Transport Types

| Type | Use Case |
|------|----------|
| `stdio` | Local processes, shell commands |
| `http` | REST APIs, HTTP endpoints |
| `sse` | Server-Sent Events streams |

---

## 18. Security and Permissions

Claude Code implements layered security with sandboxing and permission controls.

### Settings Configuration

```json
{
  "permissions": {
    "disableBypassPermissionsMode": "disable",
    "ask": ["Bash"],
    "deny": ["WebSearch", "WebFetch"]
  },
  "allowManagedPermissionRulesOnly": true,
  "allowManagedHooksOnly": true,
  "strictKnownMarketplaces": [],
  "sandbox": {
    "autoAllowBashIfSandboxed": false,
    "excludedCommands": [],
    "network": {
      "allowUnixSockets": [],
      "allowAllUnixSockets": false,
      "allowLocalBinding": false,
      "allowedDomains": [],
      "httpProxyPort": null
    }
  }
}
```

### Permission Modes

| Mode | Description |
|------|-------------|
| `ask` | User must approve each use |
| `allow` | Tool can be used without prompting |
| `deny` | Tool cannot be used |
| `disableBypassPermissionsMode` | Prevent bypassing permission checks |

### Sandbox Configuration

| Setting | Purpose |
|---------|---------|
| `excludedCommands` | Commands that cannot run in sandbox |
| `allowedDomains` | Whitelist of allowed domains |
| `allowUnixSockets` | Control Unix socket access |
| `allowLocalBinding` | Control local port binding |

### Security Hook Example

```python
SECURITY_PATTERNS = [
    {
        "ruleName": "child_process_exec",
        "substrings": ["child_process.exec", "exec(", "execSync("],
        "reminder": """⚠️ Security Warning: Using child_process.exec()...

        Use src/utils/execFileNoThrow.ts instead.
        """
    },
    {
        "ruleName": "eval_injection",
        "substrings": ["eval("],
        "reminder": "⚠️ Security Warning: eval() executes arbitrary code..."
    }
]
```

---

## 19. Configuration File Pattern

Claude Code uses YAML frontmatter for all declarative configurations.

### Frontmatter Parser

```python
def extract_frontmatter(content: str):
    """Extract YAML frontmatter and message body from markdown."""
    if not content.startswith('---'):
        return {}, content

    parts = content.split('---', 2)
    if len(parts) < 3:
        return {}, content

    frontmatter_text = parts[1]
    message = parts[2].strip()

    # Parse YAML (simplified)
    frontmatter = {}
    lines = frontmatter_text.split('\n')

    for line in lines:
        if not stripped or stripped.startswith('#'):
            continue

        if indent == 0 and ':' in line:
            key, value = line.split(':', 1)
            key = key.strip()
            value = value.strip()

            if not value:
                in_list = True
            else:
                frontmatter[key] = value.strip('"').strip("'")

    return frontmatter, message
```

### Dataclass Models

```python
@dataclass
class Condition:
    field: str
    operator: str
    pattern: str

@dataclass
class Rule:
    name: str
    enabled: bool
    event: str
    conditions: List[Condition] = field(default_factory=list)
    action: str = "warn"
    tool_matcher: Optional[str] = None
    message: str = ""
```

---

## 20. Key Implementation Patterns

### Error Handling in Hooks

```python
def main():
    try:
        input_data = json.load(sys.stdin)
        # Process hook
    except Exception as e:
        # Always allow on error
        error_output = {"systemMessage": f"Hook error: {str(e)}"}
        print(json.dumps(error_output), file=sys.stdout)
    finally:
        sys.exit(0)  # Never block due to hook errors
```

### Pattern: Graceful Degradation

```python
# Hooks should never block operations due to their own errors
except ImportError as e:
    error_msg = {"systemMessage": f"Hookify import error: {e}"}
    print(json.dumps(error_msg), file=sys.stdout)
    sys.exit(0)
```

### Pattern: Incremental Cleanup

```python
# Only clean up old state files occasionally
if random.random() < 0.1:  # 10% chance
    cleanup_old_state_files()
```

### Pattern: Deduplication

```python
warning_key = f"{file_path}-{rule_name}"
if warning_key not in shown_warnings:
    shown_warnings.add(warning_key)
    save_state(session_id, shown_warnings)
    # Show warning only once per session
```

### Pattern: Tool Input Extraction

```python
def extract_content_from_input(tool_name, tool_input):
    if tool_name == "Write":
        return tool_input.get("content", "")
    elif tool_name == "Edit":
        return tool_input.get("new_string", "")
    elif tool_name == "MultiEdit":
        edits = tool_input.get("edits", [])
        if edits:
            return " ".join(edit.get("new_string", "") for edit in edits)
        return ""
    return ""
```

---

## 21. Complete Code-Review Workflow Example

This example demonstrates the full orchestration of multiple agents, hooks, and commands:

```markdown
---
allowed-tools: Bash(gh issue view:*), Bash(gh search:*), Bash(gh pr comment:*), mcp__github__*
description: Code review a pull request
---

Provide a code review for the given pull request.

**Agent assumptions:**
- All tools are functional and will work without error
- Only call a tool if required to complete the task

Steps:

1. Launch haiku agent for preconditions:
   - PR closed? Draft? Already reviewed?
   If yes, stop.

2. Launch haiku agent to gather CLAUDE.md files

3. Launch sonnet agent for PR summary

4. Launch 4 agents in parallel:
   - 2 sonnet agents: CLAUDE.md compliance
   - 1 opus agent: Bug scanning
   - 1 opus agent: Logic issues

5. For each issue, launch parallel subagents to validate

6. Filter validated issues

7. Post inline comments with suggestions

**Critical: Only HIGH SIGNAL issues.**
- Compile/parse errors
- Clear logic errors
- Unambiguous CLAUDE.md violations

**Do NOT flag:**
- Style concerns
- Potential issues without validation
- Subjective suggestions
```

---

## 22. Additional Recommendations for Clawd-App

### Session Management Implementation

```typescript
// Session state file manager
interface SessionState {
    id: string;
    warningsShown: Set<string>;
    agentProgress: Map<string, Phase>;
    createdAt: Date;
}

class SessionManager {
    private stateDir = '~/.clawd/sessions';

    getStateFile(sessionId: string): string {
        return `${this.stateDir}/session_${sessionId}.json`;
    }

    async saveState(sessionId: string, state: SessionState): Promise<void> {
        await fs.writeJson(this.getStateFile(sessionId), state);
    }

    async loadState(sessionId: string): Promise<SessionState | null> {
        const path = this.getStateFile(sessionId);
        if (await fs.exists(path)) {
            return await fs.readJson(path);
        }
        return null;
    }

    async cleanupOldSessions(maxAgeDays: number = 30): Promise<void> {
        // Remove sessions older than maxAgeDays
    }
}
```

### Hook System Implementation

```typescript
type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop' | 'UserPromptSubmit';

interface HookInput {
    sessionId: string;
    toolName: string;
    toolInput: Record<string, any>;
    hookEventName: string;
}

interface HookOutput {
    systemMessage?: string;
    hookSpecificOutput?: {
        hookEventName: string;
        permissionDecision: 'allow' | 'deny';
    };
}

abstract class Hook {
    abstract event: HookEvent;
    abstract evaluate(input: HookInput): HookOutput | Promise<HookOutput>;
}

class HookExecutor {
    private hooks: Map<HookEvent, Hook[]> = new Map();

    async executePreToolUse(input: HookInput): Promise<HookOutput> {
        const hooks = this.hooks.get('PreToolUse') || [];
        for (const hook of hooks) {
            const result = await hook.evaluate(input);
            if (result.hookSpecificOutput?.permissionDecision === 'deny') {
                return result;
            }
        }
        return {};
    }
}
```

### Rule Engine Implementation

```typescript
interface Condition {
    field: string;
    operator: 'regex_match' | 'contains' | 'equals' | 'not_contains' | 'starts_with';
    pattern: string;
}

interface Rule {
    name: string;
    enabled: boolean;
    event: string;
    conditions: Condition[];
    action: 'warn' | 'block';
    message: string;
}

class RuleEngine {
    @lruCache(128)
    private compileRegex(pattern: string): RegExp {
        return new RegExp(pattern, 'i');
    }

    evaluate(rule: Rule, input: HookInput): boolean {
        // Check tool matcher
        if (rule.toolMatcher && !this.matchesTool(rule.toolMatcher, input.toolName)) {
            return false;
        }

        // All conditions must match
        return rule.conditions.every(cond => this.checkCondition(cond, input));
    }

    private checkCondition(cond: Condition, input: HookInput): boolean {
        const value = this.extractField(cond.field, input);
        if (value === null) return false;

        switch (cond.operator) {
            case 'regex_match':
                return this.compileRegex(cond.pattern).test(value);
            case 'contains':
                return value.includes(cond.pattern);
            case 'equals':
                return value === cond.pattern;
            // ... other operators
        }
    }
}
```

### Multi-Agent Orchestration

```typescript
type AgentModel = 'haiku' | 'sonnet' | 'opus';

interface AgentTask {
    model: AgentModel;
    prompt: string;
    onResult?: (result: any) => void;
}

class AgentOrchestrator {
    async launchAgent(task: AgentTask): Promise<any> {
        const model = this.getModelForRole(task.model);
        return await model.complete(task.prompt);
    }

    async launchParallel(tasks: AgentTask[]): Promise<any[]> {
        return Promise.all(tasks.map(task => this.launchAgent(task)));
    }

    async launchSequential(tasks: AgentTask[]): Promise<any[]> {
        const results = [];
        for (const task of tasks) {
            const result = await this.launchAgent(task);
            results.push(result);
            if (task.onResult) {
                task.onResult(result);
            }
        }
        return results;
    }

    async launchPipeline(stages: AgentTask[][]): Promise<any> {
        let context = {};
        for (const stage of stages) {
            const results = await this.launchParallel(stage);
            context = { ...context, ...this.aggregateResults(results) };
        }
        return context;
    }
}
```

### MCP Integration Pattern

```typescript
interface MCPConfig {
    stdio?: {
        command: string;
        args: string[];
        env?: Record<string, string>;
    };
    http?: {
        url: string;
        headers?: Record<string, string>;
    };
}

class MCPServerManager {
    private servers: Map<string, MCPProcess> = new Map();

    async startServer(name: string, config: MCPConfig): Promise<void> {
        if (config.stdio) {
            const process = spawn(config.stdio.command, config.stdio.args, {
                env: { ...process.env, ...config.stdio.env }
            });
            this.servers.set(name, process);
        } else if (config.http) {
            // Connect to HTTP MCP server
        }
    }

    async callTool(server: string, tool: string, params: any): Promise<any> {
        const process = this.servers.get(server);
        // Send request, receive response
    }
}
```

---

## Conclusion

Claude Code's implementation provides a comprehensive framework for:

1. **Event-Driven Hooks**: Pre/Post tool use, stop, and user prompt hooks
2. **Regex Rule Engine**: LRU-cached pattern matching with complex conditions
3. **Session State**: JSON persistence with automatic cleanup
4. **Command System**: Slash commands with allowed-tools restrictions
5. **Task Delegation**: Parallel and sequential agent orchestration
6. **MCP Integration**: External tool support via stdio/http/sse
7. **Security Layer**: Permission modes and sandbox configuration

These patterns can be adapted for clawd-app's worker loop system to provide:

- Security validation before tool execution
- Session-scoped state for multi-turn workflows
- Parallel agent execution for exploration
- External tool integration via MCP
- Rule-based automation for common tasks

The key insight is that Claude Code separates **concerns cleanly**:
- **Hooks** handle cross-cutting concerns (security, validation)
- **Agents** handle domain-specific tasks (exploration, review)
- **Commands** handle user-facing workflows (git operations)
- **MCP** handles external integrations (filesystems, APIs)

These patterns can be adapted for clawd-app's worker loop system to provide:

- Security validation before tool execution
- Session-scoped state for multi-turn workflows
- Parallel agent execution for exploration
- External tool integration via MCP
- Rule-based automation for common tasks

The key insight is that Claude Code separates **concerns cleanly**:
- **Hooks** handle cross-cutting concerns (security, validation)
- **Agents** handle domain-specific tasks (exploration, review)
- **Commands** handle user-facing workflows (git operations)
- **MCP** handles external integrations (filesystems, APIs)

---

## 23. Auto-Compact System

Claude Code implements automatic conversation compaction to enable infinite conversation length while managing context window constraints.

### Compaction Mechanisms

| Feature | Description |
|---------|-------------|
| **Auto-compact** | Automatic context summarization when threshold reached |
| **Manual compact** | `/compact` command for user-initiated compaction |
| **PreCompact hooks** | Preserve critical context before compaction |
| **Compact boundaries** | Respect message boundaries during compaction |

### Compaction Configuration

```json
{
  "context_window": {
    "used_percentage": 65,
    "remaining_percentage": 35,
    "auto_compact_threshold": 80
  }
}
```

### Auto-Compact Behavior

| Version | Threshold | Behavior |
|---------|-----------|----------|
| Earlier | 60% | Warn and compact |
| Current | 80% | More aggressive auto-compaction |
| Models with large output | Dynamic | Adjusted for output token limits |

### Compaction Events

From CHANGELOG:
```
- Fixed auto-compact triggering too early on models with large output token limits
- Made auto-compacting instant
- Fixed session compaction issues that could cause resume to load full history
- Fixed sub-agents using the wrong model during conversation compaction
- Improved compaction reliability
- Fixed an issue where auto-compact was running twice
- Fixed /compact failing with `prompt_too_long` by respecting compact boundaries
- Fixed context window blocking limit calculated using full vs effective context
```

### PreCompact Hook

The `PreCompact` hook executes before context compaction to preserve critical information:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/precompact.py",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

### Compaction Best Practices

1. **Preserve critical context**: Use PreCompact hooks to mark important messages
2. **Respect boundaries**: Don't split related messages
3. **Progressive summarization**: Summaries should themselves be compressible
4. **Track state changes**: Note what was preserved vs. summarized

---

## 24. Context Management

### Context Window Management

Claude Code implements sophisticated context window management:

| Feature | Description |
|---------|-------------|
| **Dynamic sizing** | Scales with model context window |
| **Usage tracking** | Real-time percentage display |
| **Blocking prevention** | Warns at ~98% usage |
| **Output reservation** | Reserves space for max output tokens |

### Context Budget Allocation

```
┌─────────────────────────────────────────────────────────┐
│ Total Context Window                                    │
├─────────────────────────────────────────────────────────┤
│  System Prompt (fixed)                                 │
├─────────────────────────────────────────────────────────┤
│  Tool Definitions (~10% for many tools)                │
├─────────────────────────────────────────────────────────┤
│  Conversation History (remaining)                       │
├─────────────────────────────────────────────────────────┤
│  Output Buffer (reserved for response)                 │
└─────────────────────────────────────────────────────────┘
```

### MCP Tool Context Optimization

When MCP tool descriptions exceed 10% of context window, they're automatically deferred:

```json
{
  "MCPSearch": {
    "auto": true,
    "threshold": 10,
    "behavior": "defer_and_discover"
  }
}
```

From CHANGELOG:
> "When MCP tool descriptions exceed 10% of the context window, they are automatically deferred and discovered via the MCPSearch tool instead of being loaded upfront."

### Skill Description Truncation

Skill descriptions are truncated based on context budget:

```json
{
  "skill_budget": {
    "percentage": 2,
    "scaling": "proportional_to_context_window"
  }
}
```

> "Skill character budget now scales with context window (2% of context), so users with larger context windows can see more skill descriptions without truncation."

### Large Output Handling

When background tasks produce large output, Claude Code truncates with file reference:

```python
# From CHANGELOG:
# "API context overflow when background tasks produce large output
#  by truncating to 30K chars with file path reference"
```

### Context Status Display

Real-time context information in status line:

```typescript
interface ContextStatus {
  used_percentage: number;
  remaining_percentage: number;
  current_usage: {
    tokens: number;
    percentage: number;
  };
}
```

---

## 25. Large Text Processing

### File Reading Limits

Claude Code implements token-based limits for file reads:

| Setting | Default | Override |
|---------|---------|----------|
| Max output tokens | Dynamic | `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` |

### PDF Handling

For large documents (>10 pages), Claude Code uses lightweight references:

```python
# From CHANGELOG:
# "Added `pages` parameter to the Read tool for PDFs"
# "Large PDFs (>10 pages) now return a lightweight reference
#  when @ mentioned instead of being inlined into context"
```

### Large Bash Output

Large command outputs are saved to disk instead of truncating:

```python
# From CHANGELOG:
# "Changed large bash command outputs to be saved to disk
#  instead of truncated, allowing Claude to read the full content"
# "Changed large tool outputs to be persisted to disk instead of truncated,
#  providing full output access via file references"
```

### Progress Indicators

Reading large files shows progress state:

```
Reading files...    ← Present tense while in progress
Read 5 files       ← Past tense when complete
```

### Memory Optimization

For long-running sessions:

```python
# From CHANGELOG improvements:
# - 68% reduction in resume memory by replacing session index
#   with lightweight stat-based loading
# - Fixed memory leak in git diff parsing where sliced strings
#   retained large parent strings
# - Fixed tree-sitter parse trees not being freed (WASM memory)
# - Fixed stream resources not cleaned up after shell commands
```

---

## 26. Image and Media Processing

### Image Input Support

Claude Code supports images via clipboard paste, drag-and-drop, and file references:

| Feature | Description |
|---------|-------------|
| **Clipboard paste** | Ctrl+V / Cmd+V for images |
| **Drag and drop** | Drop images onto terminal |
| **File references** | `@image.png` in prompts |
| **Screenshot paste** | OS screenshot shortcuts |

### Image Handling Pipeline

```
┌─────────────────────────────────────────────────────────┐
│ Image Input (clipboard/drag/file)                      │
├─────────────────────────────────────────────────────────┤
│ Format Detection (bytes vs extension)                  │
├─────────────────────────────────────────────────────────┤
│ Resize (prevent API limits)                           │
├─────────────────────────────────────────────────────────┤
│ Compression/Encoding                                   │
├─────────────────────────────────────────────────────────┤
│ Vision Model Processing                               │
└─────────────────────────────────────────────────────────┘
```

### Image Processing Details

From CHANGELOG entries:

| Issue | Fix |
|-------|-----|
| Large pasted images failing | "Image was too large" error handling |
| Binary files in memory | Fixed binary files (images, PDFs) being accidentally included via `@include` |
| Image media type detection | Fixed incorrect media type when format can't be detected |
| Image dimension metadata | Added for resized images (accurate coordinate mapping) |
| TIFF format support | Improved macOS screenshot paste reliability |
| Wayland support | Falls back to wl-paste when xclip unavailable |
| Image paste over SSH | Error message improvement with scp suggestion |

### Image Resizing

```python
# From CHANGELOG:
# "Resizes images before upload to prevent API size limit errors"
# "Added image dimension metadata when images are resized,
#  enabling accurate coordinate mappings for large images"
```

### Vision Capabilities

Images are processed through vision-enabled models with:
- Format auto-detection from bytes
- Coordinate preservation for large images
- Multi-image support in single prompts

### Binary File Protection

```python
# From CHANGELOG:
# "Fixed binary files (images, PDFs, etc.) being accidentally
#  included in memory when using @include directives"
# "Fixed Read tool image handling to identify format from bytes
#  instead of file extension"
```

---

## 27. Memory and Session Management

### Session Resume Optimization

Claude Code implements efficient session resume:

| Optimization | Impact |
|-------------|--------|
| Lightweight stat-based loading | 68% memory reduction |
| Progressive enrichment | Load metadata first, details on-demand |
| Cleanup old sessions | Remove sessions older than threshold |

### Session State Files

```
~/.claude/
├── sessions/
│   ├── session_abc123.json      # Session metadata
│   ├── transcript_abc123.json   # Full transcript
│   └── state_abc123.json        # Working state
├── debug-logs/
│   └── latest                   # Current session logs
└── security_warnings_state_*.json  # Session-scoped warnings
```

### Memory Optimization Patterns

From CHANGELOG fixes:

```python
# 1. Slice string optimization
# Fixed git diff parsing where sliced strings retained parent strings

# 2. WASM memory cleanup
# Fixed tree-sitter parse trees not being freed

# 3. Stream resource cleanup
# Fixed resources not cleaned up after shell commands

# 4. Subagent memory
# Fixed out-of-memory crashes when resuming sessions with heavy subagent usage
```

### Background Task Memory

```python
# From CHANGELOG:
# "Fixed API context overflow when background tasks produce
#  large output by truncating to 30K chars with file reference"
```

---

## 28. Progressive Disclosure for Large Content

Claude Code implements progressive disclosure to manage large documentation:

### Three-Level Loading System

| Level | Content | Limit |
|-------|---------|-------|
| **Metadata** | name + description | ~100 words |
| **SKILL.md body** | Core instructions | <5k words |
| **Bundled resources** | references/, examples/, scripts/ | Unlimited* |

*Scripts can execute without loading into context window

### Progressive Disclosure Pattern

```markdown
# SKILL.md
---
name: complex-skill
description: This skill handles complex workflows...
---

# Essential instructions only (~100 words)
This skill handles X, Y, Z workflows.

For detailed information, see:
- [API Reference](../references/api.md)
- [Examples](../examples/complete/)
- [Scripts](../scripts/)

## Usage
1. Step one
2. Step two

---
# references/api.md (loaded when needed)
# Full API documentation, schemas, etc.

---
# examples/complete/ (loaded when needed)
# Complete working examples

---
# scripts/ (executed without loading)
# Deterministic scripts
```

### Best Practices

1. **Keep SKILL.md lean**: <5k words, essential procedures only
2. **Move details to references**: Large files (>10k words) in references/
3. **Use scripts for repetition**: Scripts execute without context loading
4. **Include grep patterns**: Help Claude discover relevant references

```markdown
# In SKILL.md:
For database schemas, grep for:
- Table definitions in **/schema.sql
- Migrations in **/migrations/
```

---

## 29. Token Budgeting and Optimization

### Claude Code Token Allocation

```
Total Tokens = Model Context Window
├─ System Prompt: ~2-5K
├─ Tool Definitions: ~1-3K per tool (can be large!)
├─ Conversation History: Variable
└─ Response Buffer: ~1-2K reserved
```

### Optimization Strategies

| Strategy | Technique |
|----------|-----------|
| **Tool description deferral** | MCPSearch for tools >10% context |
| **Progressive disclosure** | Load references only when needed |
| **Large output to disk** | Truncate with file reference |
| **Session compaction** | Summarize old messages |
| **Binary exclusion** | Don't load images/PDFs in @include |

### Token Tracking

```typescript
interface TokenBudget {
  total: number;
  system: number;
  tools: number;
  history: number;
  reserved: number;
  available: number;
}

class TokenManager {
  trackUsage(message: Message): void;
  estimateCost(prompt: string): number;
  warnNearLimit(percentage: number): void;
  triggerCompact(): void;
}
```

---

## 30. Implementation Patterns for Clawd-App

### Auto-Compact Implementation

```typescript
interface CompactionConfig {
  thresholdPercentage: number;  // 80%
  minMessagesToCompact: number; // Don't compact too early
  preservePatterns: string[];    // Messages to always keep
}

class AutoCompactor {
  private config: CompactionConfig;
  private contextManager: ContextManager;

  shouldCompact(): boolean {
    const usage = this.contextManager.getUsagePercentage();
    return usage >= this.config.thresholdPercentage;
  }

  async compact(): Promise<ConversationSummary> {
    // 1. Identify preserve-worthy messages
    const preserved = this.identifyPreserved();

    // 2. Summarize old messages
    const summarized = await this.summarizeHistory();

    // 3. Return compact representation
    return { preserved, summarized };
  }
}
```

### Large File Handling

```typescript
class FileProcessor {
  async readLargeFile(path: string, maxTokens: number): Promise<ReadResult> {
    const fileSize = await this.getFileSize(path);

    if (fileSize.isImage) {
      return this.processImage(path);  // Resize, encode
    }

    if (fileSize.isPdf) {
      if (fileSize.pages > 10) {
        return this.createFileReference(path, "PDF > 10 pages");
      }
      return this.readPdfPages(path);
    }

    if (fileSize.tokens > maxTokens) {
      return this.truncateWithSummary(path, maxTokens);
    }

    return this.readFullFile(path);
  }
}
```

### Image Processing Pipeline

```typescript
class ImageProcessor {
  async process(input: ImageInput): Promise<ProcessedImage> {
    // 1. Detect format from bytes
    const format = await this.detectFormat(input.data);

    // 2. Check dimensions
    const dimensions = await this.getDimensions(input.data);

    // 3. Resize if needed (prevent API limits)
    const resized = await this.resizeIfNeeded(dimensions);

    // 4. Compress for efficiency
    const compressed = await this.compress(resized);

    // 5. Add metadata
    const withMeta = await this.addMetadata(compressed);

    return withMeta;
  }
}
```

### Session State Management

```typescript
interface SessionState {
  id: string;
  createdAt: Date;
  lastActivity: Date;
  contextTokens: number;
  messageCount: number;
  isCompacted: boolean;
}

class SessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private maxAgeDays = 30;

  async saveSession(session: SessionState): Promise<void> {
    const path = `~/.clawd/sessions/${session.id}.json`;
    await fs.writeJson(path, session);
  }

  async cleanupOldSessions(): Promise<void> {
    const cutoff = Date.now() - (this.maxAgeDays * 24 * 60 * 60 * 1000);
    for (const [id, session] of this.sessions) {
      if (session.lastActivity.getTime() < cutoff) {
        await this.archiveSession(id);
      }
    }
  }
}
```

### Context Budget Controller

```typescript
class ContextBudget {
  private model: Model;
  private systemPrompt: number;
  private toolDefs: number;
  private reserved: number;

  getAvailable(): number {
    const total = this.model.contextWindow;
    return total - this.systemPrompt - this.toolDefs - this.reserved;
  }

  checkThreshold(): 'ok' | 'warn' | 'critical' {
    const used = this.calculateUsedPercentage();
    if (used >= 98) return 'critical';
    if (used >= 80) return 'warn';
    return 'ok';
  }

  shouldDeferTools(): boolean {
    return this.toolDefs > (this.model.contextWindow * 0.1);
  }
}
```

### Progressive Disclosure Loader

```typescript
class ProgressiveLoader {
  async loadSkill(skillPath: string): Promise<SkillContent> {
    // 1. Load minimal metadata
    const metadata = await this.loadMetadata(skillPath);

    // 2. Load core SKILL.md if triggered
    const core = await this.loadCore(skillPath);

    // 3. Provide reference paths for detailed lookup
    const references = await this.listReferences(skillPath);

    return {
      metadata,    // Always loaded
      core,        // Loaded when skill triggers
      references,  // Available for on-demand loading
    };
  }

  async loadReference(refPath: string): Promise<string> {
    // Lazy load only when Claude determines it's needed
    return await fs.readFile(refPath);
  }
}
```

---

## 30b. Key Changelog References

### Critical Auto-Compact Fixes

| Version | Fix |
|---------|-----|
| 2.1.39 | Fixed auto-compact triggering too early on large output models |
| 2.1.21 | Made auto-compacting instant |
| 2.1.20 | Fixed session compaction issues on resume |
| 2.1.20 | Fixed subagents using wrong model during compaction |
| 2.1.18 | Improved compaction reliability |
| 2.1.15 | Fixed auto-compact running twice |
| 2.1.9 | Increased warning threshold from 60% to 80% |

### Critical Memory Fixes

| Version | Fix |
|---------|-----|
| 2.1.33 | Fixed memory crash when reading/writing large base64 images |
| 2.1.21 | 68% memory reduction in resume via stat-based loading |
| 2.1.14 | Fixed memory leak in tree-sitter parse trees (WASM) |
| 2.1.9 | Fixed memory leak in git diff parsing |
| 2.0.x | Fixed out-of-memory with heavy subagent usage |

### Critical Image Fixes

| Version | Fix |
|---------|-----|
| 2.1.39 | Fixed crash when MCP tools return image content during streaming |
| 2.1.2 | Fixed binary files in @include memory leaks |
| 2.0.x | Fixed large pasted images with "Image was too large" |
| 2.0.x | Resizes images before upload to prevent API limits |
| 2.0.x | Fixed Read tool format detection from bytes |

---

## Conclusion

Claude Code's implementation provides sophisticated mechanisms for:

### Context Management
- **Auto-compact**: Automatic summarization at ~80% threshold
- **PreCompact hooks**: Preserve critical context before compaction
- **Compaction boundaries**: Respect message groups during summarization
- **Output reservation**: Reserve space for model responses

### Large Content Handling
- **Progressive disclosure**: Three-level loading (metadata → core → references)
- **File references**: Large files saved to disk with lightweight references
- **PDF handling**: Lightweight references for >10 page documents
- **Bash output**: Large outputs saved to disk instead of truncation

### Image Processing
- **Format detection**: Bytes-based, not extension-based
- **Resizing**: Prevent API size limit errors
- **Dimension metadata**: Preserve coordinates for vision tasks
- **Binary protection**: Prevent accidental inclusion in context

### Memory Optimization
- **Session resume**: 68% reduction via stat-based loading
- **WASM cleanup**: Proper tree-sitter parse tree freeing
- **Stream resources**: Cleanup after shell commands
- **Old session cleanup**: Automatic removal after 30 days

### Token Budgeting
- **Tool deferral**: MCPSearch when tools >10% context
- **Skill budgets**: Scale with context window (2%)
- **Real-time tracking**: Status line percentage display
- **Blocking prevention**: Warn at 98% usage

These patterns enable clawd-app to implement:
- Infinite conversation length via auto-compaction
- Efficient handling of large files and images
- Memory-safe session management
- Progressive content loading for skills/docs

---

**Author**: Analysis based on Claude Code repository exploration
**Date**: 2025-02-11
**Version**: 1.2.0
**Sections Added**: Auto-Compact System, Context Management, Large Text Processing, Image/Media Processing, Memory/Session Management, Progressive Disclosure, Token Budgeting, Implementation Patterns, Key Changelog References
