# Artifact Rendering Plan -- Completeness Review

**Reviewer:** code-reviewer
**Date:** 2026-03-15
**Scope:** All 7 phase files + plan.md
**Verdict:** Plan is solid and well-structured. 10 gaps identified, 3 critical.

---

## Overall Assessment

The plan is thorough for the **UI rendering layer**. Phase decomposition is logical, dependency graph is sound, security-first approach is correct. Implementation details are unusually precise (line numbers, code snippets, regex patterns).

However, the plan is **UI-only** -- it covers how the frontend detects and renders artifacts but does not address the full stack. Several important cross-cutting concerns are missing.

---

## Gap Analysis

### GAP 1: Agent-Side Changes -- No System Prompt Guidance (CRITICAL)

**Problem:** The plan defines `<artifact>` XML markers but never addresses how agents will *know* to output them. Agents need system prompt instructions explaining the artifact protocol, supported types, and when to use artifacts vs plain code blocks.

**Impact:** Without agent-side changes, no artifacts will ever appear. The feature ships dead.

**Recommendation:**
- Add Phase 0 (or Phase 3 prerequisite): update agent system prompt template in `src/agent/src/agent/agent.ts` or the plugin system (`getSystemContext()`) to inject artifact protocol instructions.
- Define clear guidelines: "Use `<artifact>` for self-contained renderable content. Use fenced code blocks for code snippets in explanations."
- Consider an artifact-output tool (like Claude Desktop's `create_artifact` tool) as alternative to XML markers -- tool-based output is more structured and harder to accidentally trigger.

### GAP 2: Artifact Persistence & Database Schema (HIGH)

**Problem:** Plan.md line 99 lists this as an unresolved question but no phase addresses it. Currently artifacts live inline in `messages.text` (TEXT column). This works for v1 but:
- Cannot query "show me all artifacts in this channel"
- Cannot edit/update an artifact without editing the entire message
- Cannot reference an artifact from another message

**Impact:** Acceptable for MVP. Becomes blocking for future features (artifact gallery, artifact editing, agent iteration on artifacts).

**Recommendation:**
- For v1, document the decision: "Artifacts are inline in message text. No separate table." Add this to plan.md as a decision record, not an open question.
- Add to Phase 7 or a future Phase 8: schema migration plan for an `artifacts` table with `(id, message_ts, type, title, content, version, created_at)` when versioning is needed.

### GAP 3: Artifact Versioning -- Not Addressed (MEDIUM)

**Problem:** Plan.md line 99 mentions this as unresolved. No phase implements it.

**Impact:** Low for v1. Claude Desktop's versioning is useful for iterative editing ("make the background blue") -- without it, agents must re-output the entire artifact.

**Recommendation:**
- Defer explicitly: "v1 does not support artifact versioning. Each `<artifact>` tag is a standalone instance. Versioning requires a separate artifacts table (see GAP 2)."
- Remove from "Unresolved Questions" and add to "Future Work" section.

### GAP 4: Mobile/Responsive Layout (HIGH)

**Problem:** No phase addresses artifact rendering on small screens. The artifact card CSS uses `max-height: 600px` and fixed padding but no responsive breakpoints. Sandboxed iframes at `width: 100%` may work but charts and CSV tables will be cramped.

**Impact:** Users on mobile or narrow windows will have degraded experience. Artifact cards may overflow.

**Recommendation:**
- Add responsive rules to Phase 3 and Phase 5 CSS:
  - Artifact card actions should be always-visible on touch devices (hover opacity trick fails on mobile)
  - Chart height should reduce to 250px on `max-width: 768px`
  - CSV table needs horizontal scroll (already has `overflow: auto` -- good)
  - Fullscreen button becomes more important on mobile -- consider making it primary action

### GAP 5: Error Handling for Render Failures (MEDIUM)

**Problem:** Phase 4 has error forwarding from iframe via postMessage, but:
- No React Error Boundary wrapping ArtifactCard or ArtifactRenderer
- If Recharts throws (malformed data), the entire message renders broken
- If Prism.highlight throws on unexpected input, the code block disappears
- SVG DOMPurify output could be empty string (malformed SVG) -- renders blank div

**Impact:** One bad artifact kills the message it's in. Users see white space or React crash.

**Recommendation:**
- Add a React Error Boundary component wrapping each `ArtifactRenderer` call in `artifact-card.tsx`
- On error: show "Failed to render [type] artifact" with a "View source" button showing raw content
- `highlightCode` in Phase 2 already returns null on unknown language (good). But `Prism.highlight()` can throw on malformed grammar objects -- wrap in try/catch.
- For SVG: check if DOMPurify output is empty; if so, fall back to code view.

### GAP 6: Accessibility (HIGH)

**Problem:** No phase mentions keyboard navigation, ARIA attributes, or screen reader support.

Specific issues:
- Artifact card expand/collapse is a `<div onClick>` -- not keyboard accessible, no `role="button"`, no `aria-expanded`
- Action buttons lack `aria-label` (only have `title`)
- Iframe content is invisible to screen readers (sandbox isolation)
- Chart artifacts via Recharts SVG lack `aria-label` or data table fallback
- Copy/download confirmation (`setCopied(true)`) has no live region announcement

**Impact:** Accessibility violations. May be a compliance issue depending on deployment context.

**Recommendation:**
- Phase 3: make card header `role="button" tabIndex={0} aria-expanded={expanded}` with `onKeyDown` for Enter/Space
- Phase 3: add `aria-label` to all action buttons
- Phase 4: add `title` attribute on iframes (already present -- good)
- Phase 5: add `<table>` data fallback below chart for screen readers (hidden visually, visible to assistive tech)
- Add `aria-live="polite"` region for copy/download confirmations

### GAP 7: Testing Strategy (CRITICAL)

**Problem:** Each phase has a todo list with "Test: ..." items but:
- No test framework exists in `packages/ui/` (no vitest, jest, or testing-library in package.json)
- No mention of setting up a test environment
- No visual regression testing strategy
- "Test" items are manual testing checklists, not automated tests

**Impact:** Without automated tests, regressions are guaranteed as phases layer on each other. The regex-based `parseMessageBlocks` is particularly fragile.

**Recommendation:**
- Add a Phase 0 or pre-requisite: set up vitest + @testing-library/react in packages/ui/
- Priority automated tests:
  1. `parseMessageBlocks()` unit tests -- artifact regex, edge cases (nested tags, malformed attributes, empty content)
  2. `parseCsv()` unit tests -- quoted fields, empty rows, Unicode
  3. `sanitize-config.ts` integration tests -- verify KaTeX elements pass, script tags blocked
  4. `ArtifactCard` component tests -- expand/collapse, copy, download
- Visual regression: consider Chromatic or Percy for artifact rendering, or at minimum screenshot tests

### GAP 8: Migration / Backward Compatibility with Existing Messages (LOW)

**Problem:** The plan does not address what happens with existing messages. This is fine because:
- Existing messages don't contain `<artifact>` tags
- `parseMessageBlocks` changes are additive (new regex branch)
- rehype-sanitize may change rendering of existing HTML-heavy messages (Phase 1)

**Impact:** Low for artifact feature. Medium for Phase 1 -- sanitization may break existing messages with raw HTML.

**Recommendation:**
- Phase 1 should include a test: "Verify 10 representative existing messages still render identically after adding rehype-sanitize"
- Document: "Messages created before this feature will render as before. The `<artifact>` tag protocol only applies to new agent output."

### GAP 9: Documentation for Agent Authors (MEDIUM)

**Problem:** No phase includes documentation for developers creating custom agents or skills. The artifact protocol (XML tags, supported types, JSON chart spec) is only documented in the plan itself.

**Impact:** Agent authors won't know how to create artifacts. Third-party agents/skills won't adopt the format.

**Recommendation:**
- Add to Phase 3 or final phase: create `docs/artifacts.md` documenting:
  - Artifact protocol (tag syntax, attributes, supported types)
  - Chart JSON specification with examples
  - Best practices (when to use artifacts vs code blocks)
  - Limitations (size limits, CSP restrictions)

### GAP 10: Unresolved Questions Need Resolution Before Implementation (MEDIUM)

**Problem:** plan.md has 4 unresolved questions. The phases implicitly answer some but don't close them explicitly:
1. Persistence: implicitly inline (Phase 3 approach) -- needs explicit decision
2. Panel vs inline: implicitly inline expandable (Phase 3) -- needs explicit decision
3. Max artifact size: not addressed anywhere
4. Explicit markers vs auto-detection: implicitly explicit markers -- needs explicit decision

**Impact:** Ambiguity during implementation. Developer may make different assumptions.

**Recommendation:**
- Resolve all 4 in plan.md with decisions:
  1. "Decision: v1 uses inline storage. Separate table deferred."
  2. "Decision: v1 uses inline expandable cards. Side panel deferred."
  3. "Decision: max artifact content = 500KB. Larger artifacts show 'too large' with download-only option." (add to Phase 3)
  4. "Decision: v1 uses explicit `<artifact>` markers. Auto-detection is a future enhancement."

---

## Edge Cases Found by Scouting

1. **Nested artifact tags:** Agent outputs `<artifact>...<artifact>...</artifact>...</artifact>`. The non-greedy `[\s\S]*?` regex will match the inner closing tag first, breaking parsing. Recommendation: use a stack-based parser or require that inner content not contain `</artifact>`.

2. **Artifact inside code fence:** Agent puts artifact tags inside a triple-backtick code block. `parseMessageBlocks` processes code fences before artifacts, so this should be safe. But verify the regex priority order.

3. **Streaming artifact:** During streaming, partial `<artifact type="html" title="Dashboard">` may appear before the closing `</artifact>`. The regex won't match, so partial artifacts appear as raw text. When complete, re-parsing picks it up. This causes a visual jump. Consider: show a "generating artifact..." placeholder when an opening tag without closing tag is detected.

4. **XSS via artifact title:** The `title` attribute from the regex is rendered directly in JSX: `<span>{title}</span>`. React auto-escapes JSX expressions, so this is safe. But the download filename uses `title.replace(/[^a-z0-9-_]/gi, "-")` -- verify no path traversal possible. (Blob URL download is safe regardless.)

5. **Theme detection uses `prefers-color-scheme` media query** but the app has no manual dark mode toggle visible in the codebase. If a toggle is added later, `@media (prefers-color-scheme: dark)` won't respond to it. Consider using a CSS class-based theme (`.dark .artifact-card`) instead.

6. **`handleFullscreen` opens blob URL for SVG artifacts** but wraps SVG content in `text/html` blob without a proper HTML document wrapper. The SVG may not render correctly in a new tab without `<html><body>` wrapping.

7. **CSV parser splits on `\n` only** -- does not handle `\r\n` (Windows line endings). Add `.replace(/\r\n/g, "\n")` before parsing. Also does not handle multi-line quoted fields (acknowledged in risk assessment).

8. **Recharts `ResponsiveContainer` requires a parent with explicit dimensions.** Inside the artifact card body with `max-height: 600px; overflow: auto`, the container may get zero height. Test carefully.

---

## Positive Observations

- Security-first phasing (Phase 1 as P0 before any rendering) is correct
- Decision to use rehype-sanitize in the rehype pipeline (not wrapping DOMPurify around react-markdown output) is architecturally clean
- Collapsing artifacts by default mitigates performance concerns elegantly
- No virtual scrolling decision is pragmatic -- the plan correctly identifies variable-height virtualization as high-risk
- File size awareness (extracting components from 2244-line MessageList.tsx) shows good engineering judgment
- Phase 2 reuses existing Prism dependency instead of adding Shiki -- YAGNI applied correctly
- LazyViewport with IntersectionObserver is the right pattern for deferred rendering

---

## Summary of Recommendations (Prioritized)

| Priority | Gap | Action |
|----------|-----|--------|
| CRITICAL | #1 Agent system prompt | Add Phase 0: agent-side artifact protocol injection |
| CRITICAL | #7 Testing | Add test infrastructure setup; automated tests for parsers and components |
| HIGH | #6 Accessibility | Add ARIA attributes, keyboard nav, screen reader fallbacks across phases |
| HIGH | #4 Mobile/responsive | Add responsive CSS breakpoints and touch-friendly actions |
| HIGH | #10 Unresolved questions | Close all 4 with explicit decisions in plan.md |
| MEDIUM | #5 Error handling | Add React Error Boundary wrapping each ArtifactRenderer |
| MEDIUM | #9 Documentation | Create `docs/artifacts.md` with protocol spec and examples |
| MEDIUM | #3 Versioning | Defer explicitly in plan.md, move to Future Work |
| MEDIUM | #2 Persistence | Document v1 inline decision, sketch future migration |
| LOW | #8 Migration | Add Phase 1 test for existing message backward compatibility |

---

## Unresolved Questions

1. Does the app use `prefers-color-scheme` exclusively for dark mode, or is a class-based toggle planned? This affects all theme CSS in the plan.
2. Is there an existing CI pipeline for UI builds? If so, artifact rendering adds significant build-time dependencies (Recharts, DOMPurify) that should be accounted for.
3. The plan references Prismjs v1.30 as installed. Prism is effectively unmaintained -- should this be the moment to evaluate Shiki instead, given the broader rendering overhaul?
