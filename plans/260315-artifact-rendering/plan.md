---
title: "Claude-style Artifact Rendering for Claw'd Chat UI"
description: "Add sandboxed artifact rendering with security, syntax highlighting, charts, and file previews to the chat interface"
status: pending
priority: P1
effort: 37h
branch: main
tags: [ui, artifacts, security, rendering, chat]
created: 2026-03-15
updated: 2026-03-15
---

# Artifact Rendering -- Implementation Plan

## Current State

The Claw'd chat UI (`packages/ui/`) already has:
- `MessageBlock` union type with 5 variants: text, code, mermaid, image, iframe
- `parseMessageBlocks()` scanner that extracts blocks from message text
- `react-markdown` v9 with rehype-raw, rehype-katex, remark-gfm, remark-math
- `MermaidDiagram` component (mermaid v11.12, dark/light theme)
- `HtmlPreview` component (sandboxed iframe with `allow-scripts`)
- `IframePreviewCard` with postMessage resize handling
- `PreBlock` with copy-to-clipboard
- Prismjs v1.30 installed but unused
- `MARKDOWN_COMPONENTS` config object (module-level constant for perf)

Key files (line counts):
- `MessageList.tsx` -- 2244 lines (needs splitting)
- `App.tsx` -- 2041 lines
- `styles.css` -- 5772 lines
- `MarkdownContent.tsx` -- 65 lines (standalone markdown renderer)
- `MessageComposer.tsx` -- uses rehype-raw (needs sanitization)

## Resolved Questions

> All 4 original "Unresolved Questions" are now resolved.

1. **Persistence:** v1 uses inline storage in `messages.text`. No separate table. Future migration sketch in Phase 3.5.
2. **Panel vs inline:** v1 uses inline expandable cards. Side panel deferred to future work. Component architecture (standalone `ArtifactCard`) does not preclude it.
3. **Max artifact size:** 500KB content limit. Larger artifacts show "Too large to preview" with download-only fallback. Enforced in Phase 3 parser.
4. **Explicit markers vs auto-detection:** v1 uses explicit `<artifact>` markers. Agents are instructed via system prompt (Phase 0). Auto-detection is a future enhancement.

## Phases

| # | Phase | Priority | Effort | Status |
|---|-------|----------|--------|--------|
| 0 | [Agent Protocol](#phase-0) | P0 | 2h | Pending |
| 1 | [Security Foundation](#phase-1) | P0 | 4h | Pending |
| 2 | [Syntax Highlighting](#phase-2) | P1 | 4h | Pending |
| 3 | [Artifact Detection & Panel](#phase-3) | P1 | 7h | Pending |
| 3.5 | [Version History (deferred)](#phase-3-5) | P2 | 4h | Deferred |
| 4 | [Sandboxed Artifact Rendering](#phase-4) | P1 | 6h | Pending |
| 5 | [Chart & Data Visualization](#phase-5) | P2 | 4h | Pending |
| 6 | [File Preview Enhancement](#phase-6) | P2 | 3h | Pending |
| 7 | [Performance Optimization](#phase-7) | P3 | 3h | Pending |

**Total: 37h** (33h active + 4h deferred)

## Dependencies

```
Phase 0 (Agent Protocol) ──> Phase 3 (Artifact Detection)
Phase 1 (Security) ──────> Phase 3 (Artifact Detection) ──> Phase 4 (Sandboxed Rendering)
Phase 2 (Syntax Highlighting) is independent
Phase 3.5 (Versioning) deferred -- depends on Phase 3
Phase 5 (Charts) depends on Phase 3
Phase 6 (File Previews) depends on Phase 3
Phase 7 (Performance) runs last
```

**Parallelization (2 agents):**
```
Week 1:  Agent A: Phase 0 (2h) -> Phase 1 (4h) -> Phase 3 (7h)
         Agent B: Phase 2 (4h) -> Phase 6 (3h)
Week 2:  Agent A: Phase 4 (6h) -> Phase 7 (3h)
         Agent B: Phase 5 (4h)
```

---

## Phase 0: Agent Protocol (P0, 2h) {#phase-0}

See [phase-00-agent-protocol.md](./phase-00-agent-protocol.md)

**Summary:** System prompt update + plugin injection so agents know about `<artifact>` markers. Without this, no artifacts will ever appear -- the feature ships dead.

**Key deliverables:**
- Update agent system prompt in `src/agent/src/agent/agent.ts` (or plugin `getSystemContext()`) with artifact usage instructions
- Define supported types: `html`, `react`, `svg`, `code`, `markdown`, `chart`, `csv`
- Include chart JSON spec format in agent context
- Guidelines: when to use `<artifact>` vs plain code blocks
- Document `</artifact>` nesting restriction: nesting is NOT supported. Inner `</artifact>` terminates the outer artifact.
- Create `docs/artifacts.md` for agent/skill authors documenting protocol, types, chart spec, limitations

## Phase 1: Security Foundation (P0, 4h) {#phase-1}

See [phase-01-security-foundation.md](./phase-01-security-foundation.md)

**Expanded scope from reviews:**
- **Fix `openFullView()` blob URL** (CRITICAL): Wrap blob content in sanitized + CSP HTML. Current code at MessageList.tsx:591-598 uses unsanitized `html` prop -- blob URLs inherit parent origin, giving full same-origin access.
- **Fix `className` -> `class`** in DOMPurify/rehype-sanitize schema: sanitizer must allow `class` (HTML attribute name), not `className` (React prop name).
- **Add `MessageComposer.tsx`** to rehype-sanitize scope: it uses `rehype-raw` without sanitization (line 4-5).
- **Note McpDialog.tsx SVG injection** as out-of-scope follow-up task (dangerouslySetInnerHTML at line 53).
- Test: verify 10 representative existing messages still render identically after adding rehype-sanitize.

## Phase 2: Syntax Highlighting (P1, 4h) {#phase-2}

See [phase-02-syntax-highlighting.md](./phase-02-syntax-highlighting.md)

**No changes from reviews.** Prism reuse over Shiki is correct (YAGNI). Wrap `Prism.highlight()` in try/catch for malformed grammar objects.

## Phase 3: Artifact Detection & Panel (P1, 7h) {#phase-3}

See [phase-03-artifact-detection-panel.md](./phase-03-artifact-detection-panel.md)

**Expanded scope from reviews (+1h):**
- **Fix regex to be attribute-order-independent** using lookahead pattern:
  ```typescript
  const artifactRe = /<artifact\b(?=[^>]*\btype=["'](\w+)["'])(?=[^>]*\btitle=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/artifact>/i;
  ```
- **Gate `<artifact>` parsing on message author**: only parse in bot/agent messages. User messages escape or strip artifact tags. Use `subtype` field or `user` field check in `parseMessageBlocks()`.
- **Add streaming placeholder**: detect opening `<artifact>` tag without closing tag when `is_streaming` is true. Show skeleton card with "Generating artifact..." text. Suppress raw `<artifact>` tag from text output during streaming.
- **Add a11y attributes**: card header gets `role="button" tabIndex={0} aria-expanded={expanded}` with `onKeyDown` for Enter/Space. All action buttons get `aria-label`. Copy/download confirmation uses `aria-live="polite"` region.
- **Add React Error Boundary** wrapping each `ArtifactRenderer` call. On error: show "Failed to render [type] artifact" with "View source" button.
- **Extract `PreBlock`, `CopyIcon`, `CheckIcon`** from MessageList.tsx into `ui-primitives.ts` to reduce coupling.
- **Enforce 500KB size limit** before DOMPurify processing. Artifacts over limit get "Too large to preview" with download-only.
- **Use existing CSS variable pattern** `hsl(var(--bg))` instead of new fallback-based variables for theme colors.
- **Add responsive CSS**: artifact card actions always-visible on touch devices; fullscreen button primary on mobile.
- **Unify MAX_HEIGHT** to a single shared constant (600px default, fullscreen escape hatch).

## Phase 3.5: Version History (P2, 4h -- DEFERRED) {#phase-3-5}

**Decision:** v1 does not support artifact versioning. Each `<artifact>` tag is a standalone instance. This phase is explicitly deferred.

**Migration sketch for future implementation:**

Schema:
```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  language TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(id, version)
);
```

Behavior:
- `<artifact identifier="dashboard-v1" ...>` with optional `identifier` attribute
- Same identifier across messages = new version
- ArtifactCard shows `v1 / v2 / v3` selector when versions > 1
- Server API: `GET /api/artifacts/:id/versions`
- No identifier = standalone artifact (no versioning)

**Why deferred:** Requires DB schema change, server API, and conflict resolution for multi-agent channels. Inline storage is sufficient for v1 rendering.

## Phase 4: Sandboxed Artifact Rendering (P1, 6h) {#phase-4}

See [phase-04-sandboxed-artifact-rendering.md](./phase-04-sandboxed-artifact-rendering.md)

**Changes from reviews:**
- **Restrict CSP `img-src`** to `data: blob:` for React artifacts (remove `https:`). Prevents tracking pixel exfiltration. HTML artifacts get `img-src data: blob:` as well.
- **Evaluate Sucrase vs Babel** as design decision: Sucrase is ~6x faster and ~200KB vs Babel's ~800KB, but only handles JSX/TS transform (no polyfills, no proposals). For artifact use case (modern browser, JSX only), Sucrase is likely sufficient. Decision: **try Sucrase first**, fall back to Babel if edge cases arise. Document in phase file.
- **Separate CSP profiles**: HTML artifacts do NOT need `'unsafe-eval'`; only React artifacts do. Use two template functions.
- Fullscreen blob URL must use sanitized + CSP-wrapped HTML (same fix as Phase 1).

## Phase 5: Chart & Data Visualization (P2, 4h) {#phase-5}

See [phase-05-chart-visualization.md](./phase-05-chart-visualization.md)

**Minor changes:**
- Chart height reduces to 250px on `max-width: 768px`.
- Recharts `ResponsiveContainer` needs explicit parent dimensions -- test inside artifact card body with `max-height: 600px; overflow: auto`.
- Add `<table>` data fallback below chart (visually hidden, accessible to screen readers).

## Phase 6: File Preview Enhancement (P2, 3h) {#phase-6}

See [phase-06-file-preview.md](./phase-06-file-preview.md)

**Minor changes:**
- **Handle `\r\n`** in CSV parser: add `.replace(/\r\n/g, "\n")` before splitting.
- Document: multi-line quoted fields (RFC 4180) not supported in v1 simple parser. Acceptable for 95% of cases.

## Phase 7: Performance Optimization (P3, 3h) {#phase-7}

See [phase-07-performance.md](./phase-07-performance.md)

**Effort increased from 2h to 3h** per architecture review. rAF batching requires reading the actual streaming code in App.tsx. Vite chunk config needs testing.

---

## Risk Assessment (Global)

| Risk | Impact | Mitigation |
|------|--------|------------|
| MessageList.tsx is 2244 lines -- adding artifact logic bloats it further | High | Extract artifact components into dedicated files from the start; extract PreBlock/icons to ui-primitives.ts |
| DOMPurify + rehype-raw interaction -- double-sanitization may strip valid markup | Medium | Test with real agent output; configure DOMPurify ALLOWED_TAGS to match rehype-raw expectations |
| Babel standalone in iframe is ~800KB | Medium | Evaluate Sucrase first (~200KB). Lazy load only when React artifact detected; cache in service worker |
| Mermaid securityLevel is "loose" -- already a risk | High | Phase 1 tightens this to "strict" |
| styles.css is 5772 lines -- adding artifact styles | Low | Use scoped class prefix `.artifact-` for all new styles; use existing `hsl(var(--bg))` pattern |
| User-injected `<artifact>` tags cause spoofing | High | Gate parsing on message author (bot/agent only) |
| Streaming partial artifacts show raw XML | High | Streaming placeholder + tag suppression in Phase 3 |
| `openFullView()` blob URL inherits parent origin | Critical | Phase 1 wraps in sanitized + CSP HTML |
| No test infrastructure in packages/ui/ | High | Manual testing for v1; automated test setup as follow-up |

## Future Work (not in scope)

- **Side panel display** for HTML/React artifacts (pop-out to panel button)
- **Artifact versioning** (Phase 3.5 when DB schema migration is justified)
- **Edit-in-place** (less critical for multi-agent platform)
- **Share button** (self-hosted semantics differ from Claude Desktop)
- **Subdomain sandbox server** for origin isolation (e.g., `sandbox.localhost:3457`)
- **morphdom** for smoother streaming rendering (Phase 8 candidate)
- **Automated test infrastructure** (vitest + @testing-library/react for packages/ui/)
- **CSP via HTTP header** if/when subdomain sandbox is implemented

---

## Review Findings Incorporated

Summary of all findings from 4 review reports and how each was addressed.

### Critical Fixes

| # | Finding | Source | Action |
|---|---------|--------|--------|
| 1 | Agents don't know about `<artifact>` protocol -- feature ships dead | Architecture, Completeness, Gap Analysis | **Added Phase 0** (agent system prompt + plugin injection + docs/artifacts.md) |
| 2 | `openFullView()` blob URL uses unsanitized HTML, inherits parent origin | Security Review #1 | **Phase 1 expanded** -- blob must use sanitized + CSP-wrapped HTML |
| 3 | `<artifact>` tags parseable from user messages -- spoofing/phishing vector | Security Review #3 | **Phase 3 expanded** -- gate parsing on message author (bot/agent only) |
| 4 | `className` vs `class` in sanitize schema | Security Review | **Phase 1 expanded** -- use `class` (HTML attr) not `className` (React prop) |
| 5 | Streaming partial artifacts show raw XML tags | Architecture #2, #3; Gap Analysis edge case #3 | **Phase 3 expanded** -- streaming placeholder + tag suppression |

### High Fixes

| # | Finding | Source | Action |
|---|---------|--------|--------|
| 6 | Artifact regex is attribute-order-dependent | Architecture #2 | **Phase 3 expanded** -- lookahead regex pattern |
| 7 | CSP `img-src https:` allows tracking pixel exfiltration | Architecture additional; Security #6 | **Phase 4 updated** -- restrict to `data: blob:` |
| 8 | Babel standalone is ~800KB | Risk assessment | **Phase 4 updated** -- evaluate Sucrase first (~200KB, 6x faster) |
| 9 | MessageComposer.tsx uses rehype-raw without sanitization | Security Review #5d | **Phase 1 expanded** -- add to rehype-sanitize scope |
| 10 | No a11y: keyboard nav, ARIA, screen reader support | Completeness Gap #6 | **Phase 3 expanded** -- role, tabIndex, aria-expanded, keyboard handlers, aria-live |
| 11 | No Error Boundary around artifact renderers | Completeness Gap #5 | **Phase 3 expanded** -- React Error Boundary with "View source" fallback |
| 12 | 4 unresolved questions left ambiguous | Completeness Gap #10 | **Resolved all 4** in "Resolved Questions" section above |

### Medium Fixes

| # | Finding | Source | Action |
|---|---------|--------|--------|
| 13 | Hardcoded CSS variables vs existing `hsl(var(--bg))` pattern | Completeness edge case #5 | **Phase 3 updated** -- use existing CSS variable pattern |
| 14 | `</artifact>` nesting not documented | Security edge case #2; Completeness edge case #1 | **Phase 0** -- document nesting restriction in protocol spec |
| 15 | PreBlock/icons exported from 2244-line file | Architecture additional | **Phase 3 updated** -- extract to `ui-primitives.ts` |
| 16 | CSV parser doesn't handle `\r\n` | Completeness edge case #7 | **Phase 6 updated** -- add `.replace(/\r\n/g, "\n")` |
| 17 | No documentation for agent authors | Completeness Gap #9 | **Phase 0** -- create `docs/artifacts.md` |

### Acknowledged but Deferred

| Finding | Source | Decision |
|---------|--------|----------|
| Artifact versioning (most impactful missing feature) | Gap Analysis #6; Completeness Gap #3 | Deferred to Phase 3.5 with migration sketch |
| Side panel display for HTML/React | Gap Analysis #3 | Future work -- component architecture supports it |
| No test infrastructure in packages/ui/ | Completeness Gap #7 | Future work -- manual testing for v1 |
| McpDialog.tsx SVG injection | Security #5a | Out of scope -- noted as follow-up |
| Subdomain sandbox for origin isolation | Gap Analysis #5; Security | Future work |
| morphdom for smoother streaming | Gap Analysis #4 | Future work (Phase 8 candidate) |
| Separate CSP for HTML vs React artifacts | Security unresolved #3 | **Phase 4** -- two template functions |
| Mobile/responsive layout | Completeness Gap #4 | Incorporated into Phase 3 and Phase 5 CSS |
| Recharts ResponsiveContainer zero-height risk | Completeness edge case #8 | Noted in Phase 5 -- test carefully |
| Phase 7 effort underestimated | Architecture #6 | **Increased to 3h** |
