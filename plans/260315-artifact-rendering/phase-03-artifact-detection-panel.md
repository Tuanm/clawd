# Phase 3: Artifact Detection & Panel (P1)

## Context Links
- [MessageList.tsx](../../packages/ui/src/MessageList.tsx) — `MessageBlock` type (line 325), `parseMessageBlocks()` (line 415)
- [App.tsx](../../packages/ui/src/App.tsx) — layout structure, WebSocket state
- [styles.css](../../packages/ui/src/styles.css) — message block styles (line 1606)

## Overview
- **Priority:** P1
- **Status:** Pending
- **Depends on:** Phase 1 (Security Foundation)
- **Description:** Define artifact protocol for agent output, extend MessageBlock union, build artifact detection in parseMessageBlocks, and create inline expandable artifact cards with action buttons.

## Key Insights
- `MessageBlock` union (line 325) currently has 5 variants — adding `artifact` as 6th is straightforward
- `parseMessageBlocks()` (line 415) is a regex-based scanner — artifact markers need a new regex branch
- MessageList.tsx is 2244 lines — artifact rendering components MUST go in a separate file
- Inline expandable section is simpler than side panel (no App.tsx layout changes). Side panel can be a future enhancement.
- Agent output format: use XML-style markers that are easy to parse and unambiguous in markdown context

## Requirements

### Functional
- Agents can output artifacts using `<artifact type="..." title="...">content</artifact>` markers
- Supported artifact types: `html`, `react`, `svg`, `chart`, `csv`, `markdown`, `code`
- Artifact cards show: title, type badge, collapsed preview, expand/collapse toggle
- Action buttons: Copy source, Download as file, Fullscreen (opens in new tab)
- Expanded view renders content based on type (delegated to Phase 4/5 renderers; Phase 3 uses plain preview)
- Multiple artifacts per message supported

### Non-Functional
- Artifact detection must not break existing block parsing (code, mermaid, iframe, image)
- Artifact markers that fail to parse should fall through as plain text
- Type-safe: new MessageBlock variant enforced via TypeScript union

## Architecture

### Artifact Protocol

Agents output:
```
<artifact type="html" title="Interactive Dashboard">
<!DOCTYPE html>
<html>...full HTML...</html>
</artifact>
```

Supported types and their MIME equivalents:
| Type | Description | Renderer (Phase) |
|------|-------------|-----------------|
| `html` | Raw HTML document | Phase 4 (sandboxed iframe) |
| `react` | React JSX component | Phase 4 (Babel + iframe) |
| `svg` | SVG markup | Phase 4 (inline sanitized) |
| `chart` | JSON chart specification | Phase 5 (Recharts) |
| `csv` | CSV data | Phase 6 (table renderer) |
| `markdown` | Rich markdown document | Inline react-markdown |
| `code` | Source code file | Phase 2 (Prism highlighted) |

### Component Structure

```
MessageList.tsx
  |
  parseMessageBlocks() ──> { type: "artifact", ... }
  |
  v
  case "artifact": <ArtifactCard ... />   (from artifact-card.tsx)
                      |
                      ├── collapsed: title + type badge + action buttons
                      └── expanded: <ArtifactRenderer ... />  (from artifact-renderer.tsx)
                            |
                            ├── html/react/svg → Phase 4 SandboxedPreview
                            ├── chart → Phase 5 ChartRenderer
                            ├── csv → Phase 6 CsvTable
                            ├── markdown → react-markdown inline
                            └── code → Prism highlighted PreBlock
```

## Related Code Files

### Files to Modify
| File | Changes |
|------|---------|
| `packages/ui/src/MessageList.tsx` | Extend `MessageBlock` union (line 325); add artifact regex to `parseMessageBlocks()` (line 415); add `case "artifact"` to render switch (line 1947); import new components |
| `packages/ui/src/styles.css` | Add `.artifact-card`, `.artifact-card-header`, `.artifact-card-actions`, `.artifact-card-body` styles |

### Files to Create
| File | Purpose |
|------|---------|
| `packages/ui/src/artifact-card.tsx` | ArtifactCard component — collapsed/expanded card with action buttons |
| `packages/ui/src/artifact-renderer.tsx` | ArtifactRenderer — delegates to type-specific renderers |

## Implementation Steps

### Step 1: Extend MessageBlock type (MessageList.tsx line 325)

```typescript
// Add after line 330:
type ArtifactType = "html" | "react" | "svg" | "chart" | "csv" | "markdown" | "code";

type MessageBlock =
  | { type: "text"; content: string }
  | { type: "code"; lang: string; content: string }
  | { type: "mermaid"; content: string }
  | { type: "image"; src: string; alt: string }
  | { type: "iframe"; src: string; rawHtml: string; height?: string; width?: string }
  | { type: "artifact"; artifactType: ArtifactType; title: string; content: string; language?: string };
```

Export the types for use by artifact components:
```typescript
export type { MessageBlock, ArtifactType };
```

### Step 2: Add artifact regex to parseMessageBlocks() (line 415)

Add new candidate detection after the iframe regex block (~line 458), before image:

```typescript
// ── <artifact> ──────────────────────────────────────────────────
const artifactRe = /<artifact\s+type=["'](\w+)["']\s+title=["']([^"']+)["']\s*>([\s\S]*?)<\/artifact>/i;
const am = artifactRe.exec(slice);
if (am !== null) {
  const artifactType = am[1].toLowerCase() as ArtifactType;
  const validTypes: ArtifactType[] = ["html", "react", "svg", "chart", "csv", "markdown", "code"];
  if (validTypes.includes(artifactType)) {
    // Extract optional language attribute for code artifacts
    const langMatch = /<artifact[^>]+language=["'](\w+)["']/.exec(am[0]);
    candidates.push({
      index: am.index,
      end: am.index + am[0].length,
      block: {
        type: "artifact",
        artifactType,
        title: am[2],
        content: am[3].trim(),
        language: langMatch?.[1],
      },
    });
  }
}
```

Also update `pushText()` to strip artifact tags from text segments (similar to how iframes are stripped):
```typescript
const pushText = (str: string) => {
  const cleaned = str
    .replace(/<iframe\b[\s\S]*?(?:<\/iframe>|\/>)/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<artifact\b[\s\S]*?<\/artifact>/gi, "")  // NEW
    ;
  if (cleaned.trim()) blocks.push({ type: "text", content: cleaned });
};
```

### Step 3: Create artifact-card.tsx (~120 lines)

```typescript
// packages/ui/src/artifact-card.tsx
import React, { useCallback, useState } from "react";
import type { ArtifactType } from "./MessageList";
import { CopyIcon, CheckIcon } from "./MessageList";
import ArtifactRenderer from "./artifact-renderer";

const TYPE_LABELS: Record<ArtifactType, string> = {
  html: "HTML",
  react: "React",
  svg: "SVG",
  chart: "Chart",
  csv: "CSV",
  markdown: "Markdown",
  code: "Code",
};

const TYPE_COLORS: Record<ArtifactType, string> = {
  html: "#e34c26",
  react: "#61dafb",
  svg: "#ffb13b",
  chart: "#4caf50",
  csv: "#2196f3",
  markdown: "#757575",
  code: "#f0883e",
};

interface ArtifactCardProps {
  artifactType: ArtifactType;
  title: string;
  content: string;
  language?: string;
}

export default function ArtifactCard({ artifactType, title, content, language }: ArtifactCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const handleDownload = useCallback(() => {
    const ext = { html: "html", react: "jsx", svg: "svg", chart: "json", csv: "csv", markdown: "md", code: language || "txt" }[artifactType];
    const mime = { html: "text/html", react: "text/jsx", svg: "image/svg+xml", chart: "application/json", csv: "text/csv", markdown: "text/markdown", code: "text/plain" }[artifactType];
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9-_]/gi, "-").toLowerCase()}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }, [content, title, artifactType, language]);

  const handleFullscreen = useCallback(() => {
    if (artifactType === "html" || artifactType === "react" || artifactType === "svg") {
      const blob = new Blob([content], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }, [content, artifactType]);

  return (
    <div className={`artifact-card ${expanded ? "artifact-card--expanded" : ""}`}>
      <div className="artifact-card-header" onClick={() => setExpanded(!expanded)}>
        <span className="artifact-card-type-badge" style={{ backgroundColor: TYPE_COLORS[artifactType] }}>
          {TYPE_LABELS[artifactType]}
        </span>
        <span className="artifact-card-title">{title}</span>
        <div className="artifact-card-actions" onClick={(e) => e.stopPropagation()}>
          <button className="artifact-card-btn" onClick={handleCopy} title="Copy source">
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          <button className="artifact-card-btn" onClick={handleDownload} title="Download">
            <DownloadIcon />
          </button>
          {["html", "react", "svg"].includes(artifactType) && (
            <button className="artifact-card-btn" onClick={handleFullscreen} title="Open fullscreen">
              <FullscreenIcon />
            </button>
          )}
        </div>
        <span className={`artifact-card-chevron ${expanded ? "artifact-card-chevron--open" : ""}`}>
          &#9660;
        </span>
      </div>
      {expanded && (
        <div className="artifact-card-body">
          <ArtifactRenderer type={artifactType} content={content} language={language} />
        </div>
      )}
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}
```

### Step 4: Create artifact-renderer.tsx (~80 lines)

Phase 3 provides placeholder renderers. Phases 4/5/6 will fill in real implementations.

```typescript
// packages/ui/src/artifact-renderer.tsx
import React from "react";
import Markdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { sanitizeSchema } from "./sanitize-config";
import { highlightCode } from "./prism-setup";
import { PreBlock } from "./MessageList";
import type { ArtifactType } from "./MessageList";

interface ArtifactRendererProps {
  type: ArtifactType;
  content: string;
  language?: string;
}

export default function ArtifactRenderer({ type, content, language }: ArtifactRendererProps) {
  switch (type) {
    case "markdown":
      return (
        <div className="artifact-renderer-markdown">
          <Markdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
          >
            {content}
          </Markdown>
        </div>
      );

    case "code": {
      const lang = language || "text";
      const highlighted = highlightCode(content, lang);
      return (
        <div className="artifact-renderer-code">
          <PreBlock>
            <code
              className={`language-${lang}`}
              {...(highlighted ? { dangerouslySetInnerHTML: { __html: highlighted } } : { children: content })}
            />
          </PreBlock>
        </div>
      );
    }

    case "svg":
      // Phase 4 will add DOMPurify-sanitized inline SVG rendering
      // Fallback: render as code
      return (
        <div className="artifact-renderer-svg">
          <PreBlock>
            <code className="language-xml">{content}</code>
          </PreBlock>
        </div>
      );

    case "html":
    case "react":
      // Phase 4 will add sandboxed iframe rendering
      // Fallback: render as code
      return (
        <div className="artifact-renderer-preview">
          <div className="artifact-renderer-placeholder">
            Sandboxed preview not yet available. Use fullscreen button to view.
          </div>
          <details>
            <summary>View source</summary>
            <PreBlock>
              <code className="language-html">{content}</code>
            </PreBlock>
          </details>
        </div>
      );

    case "chart":
      // Phase 5 will add Recharts rendering
      return (
        <div className="artifact-renderer-preview">
          <div className="artifact-renderer-placeholder">Chart rendering coming soon.</div>
          <details>
            <summary>View data</summary>
            <PreBlock>
              <code className="language-json">{content}</code>
            </PreBlock>
          </details>
        </div>
      );

    case "csv":
      // Phase 6 will add table rendering
      return (
        <div className="artifact-renderer-preview">
          <PreBlock>
            <code className="language-text">{content}</code>
          </PreBlock>
        </div>
      );

    default:
      return (
        <PreBlock>
          <code>{content}</code>
        </PreBlock>
      );
  }
}
```

### Step 5: Add render case in MessageList.tsx (line 1947)

After the `case "iframe":` block (~line 1984-1994), add:

```typescript
case "artifact":
  return (
    <div key={`block-${i}`} className="message-block">
      <ArtifactCard
        artifactType={block.artifactType}
        title={block.title}
        content={block.content}
        language={block.language}
      />
    </div>
  );
```

Add import at top:
```typescript
import ArtifactCard from "./artifact-card";
```

### Step 6: Add CSS styles to styles.css (~80 lines)

```css
/* ── Artifact cards ─────────────────────────────────────────────── */
.artifact-card {
  border: 1px solid var(--border-color, #e1e4e8);
  border-radius: 8px;
  overflow: hidden;
  margin: 8px 0;
  background: var(--card-bg, #fff);
}

.artifact-card--expanded {
  border-color: var(--accent-color, #0366d6);
}

.artifact-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  user-select: none;
  background: var(--card-header-bg, #f6f8fa);
}

.artifact-card-header:hover {
  background: var(--card-header-hover-bg, #eef0f2);
}

.artifact-card-type-badge {
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  padding: 2px 8px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.artifact-card-title {
  flex: 1;
  font-weight: 500;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-card-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.artifact-card-header:hover .artifact-card-actions {
  opacity: 1;
}

.artifact-card-btn {
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
  color: var(--text-secondary, #586069);
  border-radius: 4px;
}

.artifact-card-btn:hover {
  background: var(--btn-hover-bg, #dfe2e5);
}

.artifact-card-chevron {
  font-size: 10px;
  color: var(--text-secondary, #586069);
  transition: transform 0.2s;
}

.artifact-card-chevron--open {
  transform: rotate(180deg);
}

.artifact-card-body {
  border-top: 1px solid var(--border-color, #e1e4e8);
  padding: 12px;
  max-height: 600px;
  overflow: auto;
}

.artifact-renderer-placeholder {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary, #586069);
  font-style: italic;
}

/* Dark theme overrides */
@media (prefers-color-scheme: dark) {
  .artifact-card {
    border-color: var(--border-color, #30363d);
    background: var(--card-bg, #0d1117);
  }
  .artifact-card-header {
    background: var(--card-header-bg, #161b22);
  }
  .artifact-card-header:hover {
    background: var(--card-header-hover-bg, #1c2128);
  }
}
```

## Todo List

- [ ] Add `artifact` variant to `MessageBlock` union type
- [ ] Export `MessageBlock` and `ArtifactType` types from MessageList.tsx
- [ ] Add artifact regex to `parseMessageBlocks()`
- [ ] Strip artifact tags from text segments in `pushText()`
- [ ] Create `artifact-card.tsx` with ArtifactCard component
- [ ] Create `artifact-renderer.tsx` with type-based routing
- [ ] Add `case "artifact"` to render switch in MessageList.tsx
- [ ] Import ArtifactCard in MessageList.tsx
- [ ] Add artifact card CSS styles to styles.css
- [ ] Test: `<artifact type="html" title="Test">...</artifact>` renders as card
- [ ] Test: Multiple artifacts in single message render correctly
- [ ] Test: Malformed artifact tags fall through as plain text
- [ ] Test: Copy, Download, Fullscreen buttons work
- [ ] Test: Existing code/mermaid/iframe blocks unaffected
- [ ] Run `bun run build:ui` to verify no compile errors

## Success Criteria
- Agent messages with `<artifact>` tags render as collapsible cards
- Cards show type badge, title, and action buttons
- Expanding a card shows type-appropriate content (fallback for types not yet implemented)
- Copy copies raw source content
- Download creates correct file with extension matching artifact type
- Existing message rendering unbroken

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Artifact regex conflicts with legitimate HTML in messages | Low | Medium | Regex requires both `type` and `title` attributes — unlikely to appear in natural content |
| rehype-raw in text blocks may parse artifact tags before scanner | Medium | High | `pushText()` strips artifact tags; scanner runs first and extracts them as candidates with lower index |
| Large artifact content (>100KB) causes rendering lag | Medium | Medium | Phase 7 addresses lazy loading; for now, collapsed-by-default mitigates |
| Export of MessageBlock type creates circular dependency | Low | Medium | Only export types (not runtime values) — TypeScript handles this via type-only imports |

## Security Considerations
- Artifact content goes through DOMPurify/rehype-sanitize (Phase 1) before rendering
- Fullscreen button opens in blob URL (separate origin isolation)
- HTML artifacts will use sandboxed iframes (Phase 4)
- Download uses Blob API — no server round-trip, no path traversal risk

## Next Steps
- Phase 4 replaces placeholder renderers for html/react/svg with real sandboxed iframes
- Phase 5 replaces chart placeholder with Recharts integration
- Phase 6 replaces csv placeholder with table renderer
