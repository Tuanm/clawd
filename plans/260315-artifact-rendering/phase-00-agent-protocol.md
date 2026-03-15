---
title: "Phase 0: Agent-Side Artifact Protocol"
description: "Specification for artifact XML markers, chart JSON schema, system prompt additions, and plugin context injection"
status: pending
priority: P0
effort: 2h
branch: main
tags: [artifacts, protocol, agent, system-prompt]
created: 2026-03-15
---

# Phase 0: Agent-Side Artifact Protocol

## Context Links

- [Parent plan](./plan.md)
- [Phase 3: Artifact Detection](./phase-03-artifact-detection-panel.md) (UI consumer of this protocol)
- Agent system prompt: `src/agent/src/agent/agent.ts` (line 100-194)
- Chat plugin context: `src/agent/plugins/clawd-chat/agent.ts` (line 490-569)

## Overview

Defines the protocol agents use to emit structured `<artifact>` markers in their output. The UI (Phase 3+) parses these markers to render rich content. This phase is purely agent-side — no UI changes.

**Dependency:** This phase MUST land before Phase 3 (Artifact Detection & Panel).

---

## 1. Artifact Protocol Specification

### Syntax

```xml
<artifact type="TYPE" title="TITLE">
CONTENT
</artifact>
```

### Attributes

| Attribute | Required | Description |
|-----------|----------|-------------|
| `type` | Yes | One of the supported content types (see below) |
| `title` | Yes | Human-readable label shown in the artifact card header |

### Supported Types

| Type | Content Format | UI Rendering |
|------|---------------|--------------|
| `html` | Raw HTML markup | Sandboxed iframe with DOMPurify pre-processing |
| `react` | JSX/React component code | Babel + Tailwind compilation in sandboxed iframe |
| `svg` | SVG markup (`<svg>...</svg>`) | Inline rendering with DOMPurify sanitization |
| `chart` | JSON spec (see Section 2) | Interactive Recharts component |
| `csv` | Raw CSV text with header row | Sortable, filterable data table |
| `markdown` | Markdown content | Full markdown pipeline (remark-gfm, rehype-katex, etc.) |
| `code` | Source code with optional `language` attr | Prism syntax-highlighted block |

### Additional Attributes (Type-Specific)

| Type | Extra Attribute | Required | Description |
|------|----------------|----------|-------------|
| `code` | `language` | No | Language hint for Prism (e.g., `typescript`, `python`). Default: `plaintext` |
| `react` | `dependencies` | No | Comma-separated package names available in sandbox (future use) |

### Examples

**HTML artifact:**
```xml
<artifact type="html" title="Sales Dashboard">
<div style="font-family: sans-serif; padding: 20px;">
  <h1>Q1 Sales</h1>
  <table border="1" cellpadding="8">
    <tr><th>Region</th><th>Revenue</th></tr>
    <tr><td>North</td><td>$1.2M</td></tr>
    <tr><td>South</td><td>$890K</td></tr>
  </table>
</div>
</artifact>
```

**React artifact:**
```xml
<artifact type="react" title="Interactive Counter">
function App() {
  const [count, setCount] = React.useState(0);
  return (
    <div className="flex flex-col items-center gap-4 p-8">
      <h1 className="text-2xl font-bold">Count: {count}</h1>
      <button
        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        onClick={() => setCount(c => c + 1)}
      >
        Increment
      </button>
    </div>
  );
}
</artifact>
```

**Chart artifact:**
```xml
<artifact type="chart" title="Monthly Revenue">
{
  "type": "bar",
  "data": [
    {"name": "Jan", "revenue": 4000, "profit": 2400},
    {"name": "Feb", "revenue": 3000, "profit": 1398},
    {"name": "Mar", "revenue": 2000, "profit": 9800}
  ],
  "xKey": "name",
  "series": [
    {"key": "revenue", "color": "#8884d8"},
    {"key": "profit", "color": "#82ca9d"}
  ],
  "title": "Monthly Revenue vs Profit"
}
</artifact>
```

**SVG artifact:**
```xml
<artifact type="svg" title="Architecture Diagram">
<svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="120" height="60" rx="8" fill="#4A90D9" />
  <text x="70" y="45" text-anchor="middle" fill="white" font-size="14">Client</text>
  <rect x="270" y="10" width="120" height="60" rx="8" fill="#7B68EE" />
  <text x="330" y="45" text-anchor="middle" fill="white" font-size="14">Server</text>
  <line x1="130" y1="40" x2="270" y2="40" stroke="#666" stroke-width="2" marker-end="url(#arrow)" />
</svg>
</artifact>
```

**CSV artifact:**
```xml
<artifact type="csv" title="User Export">
name,email,role,created
Alice,alice@example.com,admin,2026-01-15
Bob,bob@example.com,editor,2026-02-20
Carol,carol@example.com,viewer,2026-03-01
</artifact>
```

**Code artifact:**
```xml
<artifact type="code" language="typescript" title="API Client">
import { fetcher } from './utils';

interface User {
  id: string;
  name: string;
  email: string;
}

export async function getUser(id: string): Promise<User> {
  return fetcher(`/api/users/${id}`);
}
</artifact>
```

**Markdown artifact:**
```xml
<artifact type="markdown" title="Meeting Notes">
## Sprint Retro - March 15

### What went well
- Shipped artifact rendering MVP
- Zero P0 incidents this sprint

### Action items
- [ ] Migrate chart library to Recharts
- [ ] Add CSV export to data tables
</artifact>
```

### Escaping Rules

1. Content inside `<artifact>` MUST NOT contain the literal string `</artifact>`. If the content naturally includes it (e.g., documentation about artifacts), the agent must use HTML entities: `&lt;/artifact&gt;`.
2. For `chart` type, content MUST be valid JSON.
3. For `react` type, the content is a JSX component body. The top-level function should be named `App` (convention, not enforced).
4. For `html` type, content should be a complete HTML fragment (no `<html>`, `<head>`, or `<body>` wrappers needed — the iframe provides those).

---

## 2. Chart JSON Specification

```typescript
interface ChartSpec {
  /** Chart type */
  type: "line" | "bar" | "pie" | "area" | "scatter";

  /** Data array — each object is one data point */
  data: Record<string, string | number>[];

  /** Key in data objects to use for X-axis labels (or pie slice names) */
  xKey: string;

  /** Data series to render */
  series: ChartSeries[];

  /** Optional chart title (overrides artifact title if set) */
  title?: string;
}

interface ChartSeries {
  /** Key in data objects for this series' values */
  key: string;

  /** Hex color for this series */
  color?: string;

  /** Display name in legend (defaults to key) */
  name?: string;
}
```

### Defaults & Constraints

| Field | Default | Constraint |
|-------|---------|------------|
| `series[].color` | Auto-assigned from palette `["#8884d8", "#82ca9d", "#ffc658", "#ff7c43", "#a4de6c"]` | Must be valid CSS color |
| `data` length | N/A | Max 1000 data points (UI truncates with warning) |
| `series` length | N/A | Max 10 series (UI ignores extras) |

### Pie Chart Special Case

For `type: "pie"`, `xKey` is the slice label and only the first series' `key` is used for values:

```json
{
  "type": "pie",
  "data": [
    {"name": "Chrome", "share": 65},
    {"name": "Firefox", "share": 15},
    {"name": "Safari", "share": 12},
    {"name": "Other", "share": 8}
  ],
  "xKey": "name",
  "series": [{"key": "share"}]
}
```

---

## 3. System Prompt Addition

Add the following block to `DEFAULT_SYSTEM_PROMPT` in `src/agent/src/agent/agent.ts`, after the `## Workspace Tools` section (line ~176) and before `## Chat Tools`:

```
## Artifacts
When you need to present rich visual content — dashboards, charts, interactive UIs, data tables, diagrams, or formatted documents — wrap the content in artifact tags:

<artifact type="TYPE" title="TITLE">
CONTENT
</artifact>

Supported types:
- html: Raw HTML (rendered in sandboxed iframe)
- react: JSX/React component with Tailwind CSS (rendered in sandboxed iframe)
- svg: SVG markup (rendered inline, sanitized)
- chart: Recharts JSON spec with type, data, xKey, series fields (rendered as interactive chart)
- csv: CSV data with header row (rendered as sortable table)
- markdown: Rich markdown content (rendered with full pipeline)
- code: Source code with optional language attribute (rendered with syntax highlighting)

Guidelines:
- Artifacts render as expandable cards with copy, download, and fullscreen controls
- Use artifacts when content benefits from rich rendering — dashboards, charts, diagrams, interactive UIs, data tables, formatted documents
- Do NOT use artifacts for: simple text responses, short inline code snippets, or regular conversational messages
- Content inside artifacts must NOT contain literal </artifact> tags (use &lt;/artifact&gt; if needed)
- For chart type, content must be valid JSON matching: {"type":"line|bar|pie|area|scatter","data":[...],"xKey":"...","series":[{"key":"...","color":"#hex"}]}
- For react type, export a top-level App function component; React and Tailwind are available in the sandbox
- Keep artifacts focused — one concept per artifact; use multiple artifacts for distinct pieces
```

### Exact Insertion Point

In `src/agent/src/agent/agent.ts`, insert after the Workspace Tools section and before `## Chat Tools`:

```typescript
// Line ~177 (after "- Only use workspace_id from the...")
// Insert the Artifacts section here
```

The block is ~18 lines, adding ~450 tokens to the system prompt. Well within the 15% budget cap.

---

## 4. Plugin Context Injection

The `clawd-chat` plugin's `getSystemContext()` in `src/agent/plugins/clawd-chat/agent.ts` already injects chat-specific instructions. Artifact awareness should be injected here so agents in chat channels know artifacts are rendered visually.

### Where to Add

In `getSystemContext()` (line 490), inside the `<chat_instructions>` block (line 524-557), add after the `COPYABLE CONTENT RULE` section:

```typescript
// After line 547 ("Even single-line commands or short values should use code blocks...")
// Add:
`
ARTIFACT RENDERING:
- The chat UI renders <artifact> tags as interactive visual cards
- Use artifacts for rich content: HTML pages, React components, SVG diagrams, charts, CSV tables, code files, markdown documents
- Artifacts display with copy/download/fullscreen controls
- Chart artifacts use Recharts — provide JSON with type, data, xKey, series
- React artifacts have Tailwind CSS available
- Do NOT nest artifacts inside other artifacts
`
```

For space agents / workers (the `<worker_identity>` block starting line 501), add a shorter version:

```typescript
// After line 518 ("If memo_* tools are available...")
// Add:
`The chat UI renders <artifact> tags as visual cards. Use them for rich content (HTML, charts, tables, code, diagrams).
`
```

### Why Plugin Context (Not Just System Prompt)

The system prompt section (Section 3) teaches agents the protocol syntax. The plugin context section tells agents that the current chat channel supports rendering. This separation matters because:

1. Agents not connected to a chat channel (e.g., CLI mode) still know the syntax but won't be told the UI renders it.
2. The chat plugin context is channel-aware and can be conditionally toggled.
3. Keeps the base system prompt generic; chat-specific behavior stays in the chat plugin.

---

## 5. Documentation: `docs/artifacts.md`

Create `docs/artifacts.md` with the following content:

```markdown
# Artifact Protocol

Agents can output structured content using `<artifact>` tags. The chat UI detects these
markers and renders them as interactive visual cards with copy, download, and fullscreen controls.

## Syntax

    <artifact type="TYPE" title="TITLE">
    CONTENT
    </artifact>

## Supported Types

| Type | Content | Rendering |
|------|---------|-----------|
| `html` | HTML markup | Sandboxed iframe, DOMPurify-sanitized |
| `react` | JSX component (function App) | Babel + Tailwind in sandboxed iframe |
| `svg` | SVG markup | Inline, DOMPurify-sanitized |
| `chart` | JSON spec | Interactive Recharts component |
| `csv` | CSV with header row | Sortable data table |
| `markdown` | Markdown text | Full markdown pipeline |
| `code` | Source code | Prism syntax highlighting |

## Chart JSON Format

```json
{
  "type": "line",
  "data": [{"month": "Jan", "sales": 100}, {"month": "Feb", "sales": 150}],
  "xKey": "month",
  "series": [{"key": "sales", "color": "#8884d8", "name": "Sales"}],
  "title": "Monthly Sales"
}
```

Chart types: `line`, `bar`, `pie`, `area`, `scatter`. Max 1000 data points, 10 series.

## When to Use Artifacts

**Use artifacts for:**
- Interactive HTML pages, dashboards
- React components (prototypes, UI demos)
- SVG diagrams (architecture, flowcharts)
- Charts and data visualizations
- CSV/tabular data exploration
- Formatted documents (reports, meeting notes)
- Code files with syntax highlighting

**Do NOT use artifacts for:**
- Simple text replies
- Short inline code (use markdown code blocks)
- Regular conversational messages

## Code Artifact Extras

The `code` type accepts an optional `language` attribute:

    <artifact type="code" language="python" title="Data Processor">
    def process(items):
        return [transform(i) for i in items]
    </artifact>

## React Artifact Environment

React artifacts run in a sandboxed iframe with:
- React 18 (available as global `React`)
- Tailwind CSS v3
- Top-level function should be named `App`

No imports needed — React and ReactDOM are pre-loaded.

## Escaping

Content must NOT contain literal `</artifact>`. Use `&lt;/artifact&gt;` if documenting the protocol itself.

## Security

- HTML/SVG content is sanitized with DOMPurify before rendering
- HTML and React artifacts run in sandboxed iframes (`sandbox="allow-scripts"`)
- No network access from artifact iframes
- No access to parent page DOM or cookies
```

---

## 6. Implementation Steps

### Step 1: Update System Prompt (agent.ts)

**File:** `src/agent/src/agent/agent.ts`
**Location:** Line ~177, after `## Workspace Tools` section, before `## Chat Tools`

**Action:** Insert the artifact instructions block from Section 3 into `DEFAULT_SYSTEM_PROMPT`.

**Token impact:** ~450 tokens added to base system prompt.

### Step 2: Update Chat Plugin Context (clawd-chat/agent.ts)

**File:** `src/agent/plugins/clawd-chat/agent.ts`
**Location 1:** Inside `<chat_instructions>` block (after COPYABLE CONTENT RULE, ~line 547)
**Location 2:** Inside `<worker_identity>` block (after memo instructions, ~line 518)

**Action:** Add artifact rendering awareness strings per Section 4.

### Step 3: Create Documentation

**File:** `docs/artifacts.md`
**Action:** Create new file with content from Section 5.

### Step 4: Update Parent Plan

**File:** `plans/260315-artifact-rendering/plan.md`
**Action:** Add Phase 0 row to the phase table and update dependency graph to show Phase 0 feeds Phase 3.

---

## Todo List

- [ ] Insert artifact instructions into `DEFAULT_SYSTEM_PROMPT` in `agent.ts`
- [ ] Add artifact awareness to `<chat_instructions>` in `clawd-chat/agent.ts`
- [ ] Add short artifact note to `<worker_identity>` in `clawd-chat/agent.ts`
- [ ] Create `docs/artifacts.md`
- [ ] Update `plans/260315-artifact-rendering/plan.md` phase table
- [ ] Verify system prompt stays within 15% budget cap after addition
- [ ] Test: agent outputs an artifact tag, confirm it appears verbatim in message text (UI parsing is Phase 3)

## Success Criteria

1. Agents emit `<artifact>` markers when producing rich content
2. System prompt includes artifact protocol docs (~450 tokens)
3. Chat plugin context tells agents the UI renders artifacts
4. `docs/artifacts.md` exists as reference for agent authors
5. No regression — existing agent behavior unchanged for non-artifact responses

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| System prompt bloat — 450 tokens added | Low | Well within 15% cap; artifact section is lower priority than base prompt in truncation order |
| Agents overuse artifacts for simple text | Medium | "Do NOT use artifacts for simple text" instruction + iterative prompt tuning |
| LLMs may not reliably produce valid XML markers | Medium | Use permissive regex parser in Phase 3 (`<artifact[^>]*>[\s\S]*?<\/artifact>`); don't require strict XML |
| Chart JSON malformed by LLM | Medium | Phase 5 UI uses try/catch on JSON.parse with fallback to raw display |

## Security Considerations

- This phase is agent-output only — no code execution, no DOM manipulation
- Security enforcement happens in Phase 1 (DOMPurify) and Phase 4 (iframe sandbox)
- The protocol documents escaping rules so agents don't accidentally inject `</artifact>` closers

## Next Steps

- Phase 1: Security Foundation (DOMPurify setup)
- Phase 3: Artifact Detection & Panel (UI parser for `<artifact>` tags)
- Phase 5: Chart Visualization (Recharts renderer for chart type)
