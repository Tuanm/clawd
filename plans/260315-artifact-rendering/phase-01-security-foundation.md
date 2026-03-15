# Phase 1: Security Foundation (P0)

## Context Links
- [MessageList.tsx](../../packages/ui/src/MessageList.tsx) — current rendering pipeline
- [MarkdownContent.tsx](../../packages/ui/src/MarkdownContent.tsx) — standalone markdown renderer
- [styles.css](../../packages/ui/src/styles.css) — all UI styles

## Overview
- **Priority:** P0 — must ship before any artifact rendering
- **Status:** Pending
- **Description:** Add DOMPurify HTML sanitization to all user/agent-generated HTML content. Tighten existing iframe sandboxes. Fix mermaid securityLevel.

## Key Insights
- `rehype-raw` currently passes raw HTML through without sanitization — any `<script>`, `onload`, `onerror` attributes render as-is
- `HtmlPreview` uses `srcDoc={html}` with only `sandbox="allow-scripts"` — no sanitization before injection
- `MermaidDiagram` uses `dangerouslySetInnerHTML` for SVG output (line 321) — mermaid's own sanitization applies but `securityLevel: "loose"` weakens it
- `IframePreviewCard` trusts `src` after URL validation but has no CSP

## Requirements

### Functional
- All markdown-rendered HTML sanitized via DOMPurify before DOM insertion
- `HtmlPreview` content sanitized before `srcDoc` injection
- Mermaid `securityLevel` changed from `"loose"` to `"strict"`
- Iframe sandboxes include `allow-same-origin` only when strictly needed

### Non-Functional
- DOMPurify adds ~12KB gzipped — acceptable
- No visible rendering regressions for existing content (tables, KaTeX, GFM, callouts)
- Sanitization must preserve: `<details>`, `<summary>`, `<kbd>`, `<mark>`, `<abbr>`, `<sub>`, `<sup>`, math elements

## Architecture

```
Agent message text
  |
  v
parseMessageBlocks() ─── splits into text/code/mermaid/image/iframe blocks
  |
  v
text blocks ──> Markdown (react-markdown)
                  |
                  v
                rehype-raw ──> rehype-sanitize (NEW) ──> rehype-katex ──> DOM
                                     |
                                     uses DOMPurify config
```

**Decision:** Use `rehype-sanitize` (hast-util-sanitize) instead of wrapping DOMPurify around react-markdown output. This integrates cleanly into the rehype pipeline and avoids double-parsing. For non-markdown HTML (HtmlPreview), use DOMPurify directly.

## Related Code Files

### Files to Modify
| File | Changes |
|------|---------|
| `packages/ui/src/MessageList.tsx` | Add rehype-sanitize to MARKDOWN_COMPONENTS pipeline (lines 547-585); tighten mermaid init (line 18); add DOMPurify to HtmlPreview (line 611) |
| `packages/ui/src/MarkdownContent.tsx` | Add rehype-sanitize to plugin chain (line 16-17) |
| `packages/ui/package.json` | Add `dompurify`, `@types/dompurify`, `rehype-sanitize` dependencies |

### Files to Create
| File | Purpose |
|------|---------|
| `packages/ui/src/sanitize-config.ts` | Shared DOMPurify + rehype-sanitize configuration |

## Implementation Steps

### Step 1: Install dependencies
```bash
cd packages/ui && bun add dompurify rehype-sanitize && bun add -D @types/dompurify
```

### Step 2: Create sanitize-config.ts (~30 lines)
```typescript
// packages/ui/src/sanitize-config.ts
import { defaultSchema } from "rehype-sanitize";
import type { Schema } from "rehype-sanitize";

// Extend default GitHub-style schema to allow KaTeX, details, and GFM elements
export const sanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // KaTeX elements
    "math", "semantics", "mrow", "mi", "mo", "mn", "msup", "msub",
    "mfrac", "mover", "munder", "msqrt", "mroot", "mtable", "mtr", "mtd",
    "annotation", "span",
    // GitHub-flavored extras
    "details", "summary", "kbd", "mark", "abbr", "sub", "sup",
    // Tables (should already be in default)
    "table", "thead", "tbody", "tr", "th", "td",
    // Task lists
    "input",
  ],
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), "className", "style", "aria-hidden"],
    input: ["type", "checked", "disabled", "className"],
    math: ["xmlns"],
    annotation: ["encoding"],
    td: [...(defaultSchema.attributes?.td ?? []), "align", "style"],
    th: [...(defaultSchema.attributes?.th ?? []), "align", "style"],
    code: ["className"],
    div: ["className", "style"],
    pre: ["className"],
  },
};
```

### Step 3: Integrate rehype-sanitize into MessageList.tsx

In the `Markdown` component used for text blocks (line 1951-1957), add `rehype-sanitize` **before** `rehype-katex` in the rehype plugins array:

```typescript
// Before (line 1952-1953):
rehypePlugins={[rehypeKatex, rehypeRaw]}

// After:
import rehypeSanitize from "rehype-sanitize";
import { sanitizeSchema } from "./sanitize-config";
// ...
rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
```

**Order matters:** rehype-raw parses raw HTML into hast nodes, rehype-sanitize strips dangerous nodes, rehype-katex renders math. The current order has rehypeKatex first — that must also change.

Update `MARKDOWN_COMPONENTS` definition area (near line 547) to import sanitize:
```typescript
import rehypeSanitize from "rehype-sanitize";
import { sanitizeSchema } from "./sanitize-config";
```

### Step 4: Integrate into MarkdownContent.tsx

Same plugin order change:
```typescript
// Before (line 16):
rehypePlugins={[rehypeKatex, rehypeRaw]}

// After:
rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
```

### Step 5: Sanitize HtmlPreview with DOMPurify

In `HtmlPreview` (MessageList.tsx ~line 588-617), sanitize before injection:
```typescript
import DOMPurify from "dompurify";

function HtmlPreview({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sanitizedHtml = useMemo(() => DOMPurify.sanitize(html, {
    ADD_TAGS: ["style", "link"],
    ADD_ATTR: ["target", "rel"],
    ALLOW_DATA_ATTR: false,
    WHOLE_DOCUMENT: true,
  }), [html]);
  // ... use sanitizedHtml instead of html in srcDoc and blob
```

### Step 6: Tighten mermaid securityLevel

In MessageList.tsx line 18:
```typescript
// Before:
securityLevel: "loose",

// After:
securityLevel: "strict",
```

**Impact:** `"strict"` disables click events on mermaid nodes. Acceptable tradeoff — mermaid diagrams in chat don't need interactivity.

### Step 7: Add CSP meta tag to HtmlPreview iframe

Wrap the sanitized HTML with a CSP header:
```typescript
const wrappedHtml = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:;">
</head><body>${sanitizedHtml}</body></html>`;
```

## Todo List

- [ ] Install dompurify, @types/dompurify, rehype-sanitize
- [ ] Create `sanitize-config.ts` with extended schema
- [ ] Add rehype-sanitize to MessageList.tsx markdown pipeline
- [ ] Add rehype-sanitize to MarkdownContent.tsx markdown pipeline
- [ ] Fix rehype plugin order (raw -> sanitize -> katex)
- [ ] Add DOMPurify sanitization to HtmlPreview
- [ ] Change mermaid securityLevel to "strict"
- [ ] Add CSP meta tag to HtmlPreview iframe srcDoc
- [ ] Test: KaTeX math expressions still render
- [ ] Test: GFM tables, task lists, callouts still render
- [ ] Test: `<script>` and `onerror` attributes are stripped
- [ ] Test: Mermaid diagrams still render with strict mode
- [ ] Run `bun run build:ui` to verify no compile errors

## Success Criteria
- No `<script>` tags or event handler attributes (`onload`, `onerror`, `onclick`) pass through to DOM
- KaTeX, GFM tables, task lists, mermaid diagrams render correctly
- HtmlPreview sanitizes before iframe injection
- `bun run build:ui` passes

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| rehype-sanitize strips KaTeX elements | Medium | High | Custom schema includes all KaTeX tag names; test with complex equations |
| rehype plugin order breaks existing rendering | Low | High | Test thoroughly; the correct order is raw -> sanitize -> katex |
| DOMPurify strips legitimate HTML preview content (CSS, styles) | Medium | Medium | Allow `<style>` and `<link>` tags in HtmlPreview DOMPurify config |
| Mermaid strict mode breaks some diagram types | Low | Low | Monitor; can selectively re-enable "sandbox" level if needed |

## Security Considerations
- This phase is entirely about security. Every step reduces XSS attack surface.
- `rehype-sanitize` uses allowlist approach — only explicitly listed tags/attributes pass through.
- DOMPurify is the industry standard for HTML sanitization (~12KB, battle-tested).
- CSP in iframe prevents any script execution even if sanitization is bypassed.

## Next Steps
- Phase 3 (Artifact Detection) depends on this — artifacts will go through the same sanitization pipeline.
- Phase 4 (Sandboxed Rendering) builds on the CSP and DOMPurify patterns established here.
