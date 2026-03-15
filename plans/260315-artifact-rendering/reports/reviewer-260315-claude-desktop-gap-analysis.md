# Comparative Analysis: Claw'd Artifact Plan vs Claude Desktop

**Date:** 2026-03-15
**Reviewer:** code-reviewer
**Scope:** 7-phase artifact rendering plan vs Claude Desktop's production implementation
**Verdict:** Plan achieves ~70% feature parity. Three critical gaps identified.

---

## 1. Core Rendering Feature Parity

| Feature | Claude Desktop | Claw'd Plan | Parity |
|---------|---------------|-------------|--------|
| HTML rendering in sandbox | Yes (claudeusercontent.com) | Yes (iframe sandbox) | Partial |
| React + Babel + Tailwind | Yes | Yes (Phase 4) | Yes |
| SVG rendering | Yes | Yes (DOMPurify inline) | Yes |
| Mermaid diagrams | Yes | Already exists | Yes |
| Markdown rendering | Yes | Already exists | Yes |
| Code syntax highlighting | Yes | Phase 2 (Prism) | Yes |
| CSV/data tables | Yes | Phase 6 | Yes |
| Chart visualization | Yes | Phase 5 (Recharts) | Yes |
| Token-by-token streaming | morphdom diffing | Debounced re-render (Phase 7) | Partial |
| Version history | Yes (instant recall) | Not planned | **No** |
| Side panel display | Yes | Inline expandable card | **No** |
| Edit-in-place | Yes (targeted string replace) | Not planned | **No** |
| Share button | Yes | Not planned | No |
| Separate-origin isolation | Yes (claudeusercontent.com) | No (same-origin iframe) | **Partial** |

**Assessment:** Core rendering types are covered. The plan achieves parity on *what* can be rendered but falls short on *how* it's presented and *how* users interact with artifacts.

---

## 2. Explicitly Omitted Features & Justification

### 2a. Version History -- NOT JUSTIFIED

Claude Desktop maintains a version stack per artifact. Users click through v1, v2, v3 instantly. This is the #1 productivity feature for iterative code generation ("make the button blue", "add a footer", "undo that").

Claw'd's plan stores artifacts inline in message text. No separate artifact table, no versioning. The plan's Unresolved Question #1 acknowledges this but defers it.

**Impact:** Without versioning, users must scroll through conversation history to find earlier artifact states. For iterative workflows (the primary artifact use case), this is a severe UX regression.

**Recommendation:** Add a Phase 3.5 that introduces an `artifacts` table in `chat.db` with `(id, message_id, version, type, title, content, created_at)`. Store each artifact emission as a versioned row. ArtifactCard reads from this table and shows prev/next version controls.

### 2b. Side Panel -- PARTIALLY JUSTIFIED

Claude Desktop shows artifacts in a persistent right panel. Claw'd chooses inline expandable cards. The plan justifies this: "Inline expansion is contained to MessageList; right panel requires App.tsx layout changes."

**Assessment:** Justified for Phase 1 scope. Inline cards are acceptable for code/CSV/markdown artifacts. However, for HTML/React artifacts that benefit from a wider viewport, inline rendering at chat-column width (~600px) is cramped. The plan should note side panel as a P2 follow-up and ensure the component architecture doesn't preclude it (it currently doesn't -- ArtifactCard is standalone).

### 2c. Edit-in-Place -- JUSTIFIED

Claude Desktop allows editing artifact content directly and re-rendering. This requires a content-editable layer, targeted string replacement in the artifact source, and re-compilation for React artifacts.

For Claw'd (multi-agent platform), edit-in-place is less critical -- users prompt agents to modify artifacts. Omission is justified for initial release.

### 2d. Share Button -- JUSTIFIED

Claude Desktop's share creates a public URL. Claw'd is self-hosted; sharing semantics differ. Not critical for MVP.

---

## 3. Inline Card vs Side Panel: UX Assessment

**Is inline-card a significant downgrade?** Yes, for interactive artifacts. No, for static artifacts.

| Artifact Type | Inline OK? | Why |
|---------------|-----------|-----|
| Code | Yes | Syntax highlighting works at any width |
| Markdown | Yes | Flows naturally in chat |
| CSV | Mostly | Horizontal scroll needed for wide tables |
| SVG | Mostly | Depends on intrinsic dimensions |
| Chart | Partial | 350px Recharts height is tight; tooltips may clip |
| HTML | **No** | Dashboards, forms, layouts need width |
| React | **No** | Interactive components cramped at ~600px |

**Recommendation:** The plan should add a "pop-out to panel" button on HTML/React artifacts (separate from fullscreen-in-new-tab). This is a lightweight compromise: keep inline as default, allow panel view for complex artifacts. Architecture change: ArtifactCard emits `onPopOut` callback; App.tsx renders a right-side `<ArtifactPanel>` overlay when active.

---

## 4. Streaming Approach: Debounced Re-render vs morphdom

### Claude Desktop's Approach
- Streams tokens into a virtual DOM representation
- Uses morphdom to diff the rendered HTML and apply minimal DOM patches
- Result: smooth, flicker-free incremental rendering even mid-tag

### Claw'd Plan's Approach (Phase 7)
- Buffers tokens in `requestAnimationFrame` batches (~16ms)
- Re-parses full message blocks every 500 characters during streaming
- React reconciliation handles DOM diffing

**Comparison:**

| Aspect | Claude (morphdom) | Claw'd (rAF + React) |
|--------|-------------------|---------------------|
| DOM diffing efficiency | morphdom: minimal patches | React VDOM: full reconcile |
| Markdown mid-stream | Handles partial tags gracefully | `parseMessageBlocks` re-runs on partial input -- may produce transient parse artifacts |
| Artifact mid-stream | Incrementally renders partial artifact | Artifact won't render until closing `</artifact>` tag detected |
| Perceived smoothness | Token-by-token visible | 500-char batch jumps |

**Assessment:** Claw'd's approach is **adequate but noticeably inferior** for long streaming outputs. The 500-char batching will produce visible "chunk jumps" rather than smooth token flow. More critically, `parseMessageBlocks` regex won't match `<artifact>` until the closing tag arrives, meaning users see raw XML during streaming.

**Recommendations:**
1. Reduce batch threshold from 500 chars to 100 chars for text blocks (keep 500 for code blocks where partial re-parse is expensive)
2. Add a "streaming artifact" state: when `<artifact type=... title=...>` is detected without closing tag, show a placeholder card with "Generating..." status and a live code preview of content received so far
3. Consider `morphdom` as a Phase 8 enhancement if users report jank -- it's 3KB and would slot in cleanly

---

## 5. Security Model Comparison

### Claude Desktop: 5-Layer Model
1. **Separate origin** -- `claudeusercontent.com` domain
2. **iframe sandbox** -- `allow-scripts` only
3. **Content Security Policy** -- strict CSP headers
4. **DOMPurify** -- HTML sanitization
5. **Process isolation** -- Electron renderer process separation

### Claw'd Plan: 4-Layer Model
1. **iframe sandbox** -- `allow-scripts` only (Phase 1/4)
2. **CSP meta tag** -- in iframe document head (Phase 1/4)
3. **DOMPurify/rehype-sanitize** -- HTML sanitization (Phase 1)
4. **Mermaid strict mode** -- Phase 1

### Gap Analysis

| Security Layer | Claude Desktop | Claw'd Plan | Risk |
|----------------|---------------|-------------|------|
| Origin isolation | Separate domain | Same-origin iframe | **HIGH** |
| sandbox attribute | allow-scripts | allow-scripts | Equivalent |
| CSP | HTTP header from server | `<meta>` tag in srcDoc | **MEDIUM** |
| HTML sanitization | DOMPurify | DOMPurify + rehype-sanitize | Equivalent |
| Process isolation | Electron process | None (web app) | N/A (different architecture) |

**Critical finding: same-origin risk.** Claw'd's plan correctly omits `allow-same-origin` from sandbox (Phase 4 notes this), which means the iframe gets an opaque origin. This is correct and provides good isolation. However:

- **CSP via meta tag is weaker than HTTP header.** A `<meta http-equiv="Content-Security-Policy">` can be bypassed if injected HTML contains another `<meta>` tag that overrides it, or if the browser processes the injected `<meta>` before the CSP one. For `srcDoc` iframes, this is largely mitigated since the entire document is controlled, but it's still a defense-in-depth gap.

- **React artifacts are unsanitized by design.** Phase 4 explicitly notes: "React -- don't sanitize JSX (it needs script execution). Security comes from iframe sandbox isolation." This is the correct tradeoff, but it means a malicious React artifact can:
  - Exfiltrate data via `fetch()` if CSP is bypassed
  - Mine crypto in the background
  - Render phishing UI inside the artifact

  Claude Desktop mitigates this with separate-origin isolation at the domain level. Claw'd relies solely on the iframe sandbox.

**Recommendations:**
1. Add `connect-src 'none'` to the CSP (already present in Phase 4 template -- good)
2. Consider serving artifact iframes from a subdomain (e.g., `sandbox.localhost:3457`) via a minimal static server. This adds origin isolation without needing a separate domain. The plan's architecture supports this -- just change `srcDoc` to `src` pointing at the sandbox origin.
3. Add a trust indicator on artifact cards: "This artifact runs JavaScript in a sandboxed environment" -- user awareness

---

## 6. Single Most Impactful Missing Feature

**Artifact Version History.**

Rationale:
- Iterative refinement is the #1 artifact use case ("make it red", "add a sidebar", "go back to v2")
- Without versions, users re-scroll or re-prompt, losing context and wasting tokens
- Claude Desktop users specifically cite version switching as the feature that makes artifacts usable for real work
- Implementation cost is moderate: one new DB table + version nav UI on ArtifactCard
- Versioning also enables future features: diff view between versions, branching, fork-to-edit

**Proposed addition to plan:**

### Phase 3.5: Artifact Versioning (P1, 4h)

**Schema:**
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

**Behavior:**
- `parseMessageBlocks` detects `<artifact identifier="dashboard-v1" ...>` with optional `identifier` attribute
- Same identifier across messages = new version of same artifact
- ArtifactCard shows `v1 / v2 / v3` selector when versions > 1
- Server API: `GET /api/artifacts/:id/versions` returns version list
- No identifier = standalone artifact (no versioning)

---

## Summary of Recommendations (Priority Order)

1. **[Critical]** Add artifact versioning (Phase 3.5) -- single highest-impact missing feature
2. **[High]** Add streaming artifact placeholder -- show "Generating..." card when opening `<artifact>` tag detected but closing tag not yet received
3. **[High]** Reduce streaming batch from 500 chars to 100 chars for text blocks to improve perceived smoothness
4. **[Medium]** Add "pop-out to panel" for HTML/React artifacts -- inline is too narrow for interactive content
5. **[Medium]** Consider subdomain sandbox server for origin isolation -- strengthens security model significantly
6. **[Low]** Plan for CSP-via-HTTP-header if/when subdomain sandbox is implemented
7. **[Low]** Add morphdom as optional Phase 8 for smoother streaming rendering

### What the Plan Does Well

- Security-first sequencing (Phase 1 before any rendering)
- Correct decision to omit `allow-same-origin` from iframe sandbox
- Proper lazy loading strategy (IntersectionObserver, React.lazy, manual Vite chunks)
- Decision NOT to add virtual scrolling (correct -- pagination is sufficient)
- DOMPurify + rehype-sanitize dual approach (belt and suspenders)
- File size awareness (extracting components from 2244-line MessageList.tsx)
- Zero-dependency approach for CSV/PDF/audio/video (Phase 6)
- Collapsed-by-default artifact cards (good perf default)

### Unresolved Questions

1. How will agents be instructed to use the `<artifact>` protocol? Need system prompt injection or tool definition. Plan assumes agents output the right format but doesn't specify how this is enforced.
2. What happens when two agents in the same channel emit artifacts with the same identifier? Versioning conflict resolution needed.
3. The plan's artifact regex `/<artifact\s+type=["'](\w+)["']\s+title=["']([^"']+)["']>` will fail if attributes are in different order (e.g., `title` before `type`). Consider a more flexible attribute parser.
