# Architecture Review: Artifact Rendering Plan

**Reviewer:** code-reviewer
**Date:** 2026-03-15
**Scope:** All 7 phases in `plans/260315-artifact-rendering/`
**Verdict:** Architecture is sound with several improvements recommended

---

## Overall Assessment

The plan is well-structured, security-first, and demonstrates strong knowledge of the existing codebase. The phase decomposition is logical, dependencies are mostly correct, and the incremental approach (placeholders in Phase 3, real renderers in 4/5/6) is pragmatic. Seven specific findings below, ordered by the review questions.

---

## 1. Inline Expandable Cards vs Side Panel

**Recommendation: Inline cards are the right call for v1.**

| Factor | Inline Cards | Side Panel |
|--------|-------------|------------|
| Implementation cost | Low — contained to MessageList | High — App.tsx layout refactor, state sync |
| Multi-artifact context | Good — artifacts appear in conversation flow | Poor — only one artifact visible at a time |
| Mobile friendliness | Good — natural scroll | Poor — panel takes full width on small screens |
| Code/artifact comparison | Poor — hard to see two artifacts | Good — code in chat, preview in panel |
| Streaming interaction | Simple — card appears when block parsed | Complex — need to decide when to open panel |

The plan correctly identifies this tradeoff (Unresolved Question #2) and chooses inline for simplicity. The only concern: if artifacts are large (full-page HTML apps), an inline card maxing out at 600px height (Phase 3 CSS) may feel cramped. The 800px max in Phase 4's SandboxedIframe is better. **Suggestion:** Unify to a single MAX_HEIGHT constant shared between card body and iframe, defaulting to 600px with the fullscreen escape hatch.

---

## 2. Artifact Marker Protocol

**Finding: Well-defined but has two edge-case gaps.**

The `<artifact type="..." title="...">content</artifact>` protocol is clear and unambiguous. However:

### Critical: Streaming partial artifacts

The regex `/<artifact\s+type=["'](\w+)["']\s+title=["']([^"']+)["']\s*>([\s\S]*?)<\/artifact>/i` requires the **closing tag** to match. During streaming, the agent will emit the opening tag first, then content tokens, then the closing tag. Until `</artifact>` arrives:

- The partial `<artifact ...>content...` will NOT match the regex
- `pushText()` strips `<artifact...>...</artifact>` but will NOT strip an unclosed `<artifact>` tag
- The user will see raw `<artifact type="html" title="Dashboard">` text flickering in the message, then it suddenly transforms into a card when the closing tag arrives

**Severity: High.** This produces a jarring UX during streaming.

**Fix options:**
1. Add a "pending artifact" detection: if `<artifact` is found without closing tag AND message is streaming, render a skeleton card with "Generating artifact..." placeholder
2. Suppress artifact opening tags in `pushText()` during streaming — strip `<artifact\b[^>]*>[\s\S]*$` when the message is marked `is_streaming`
3. Both (recommended): suppress the raw tag AND show a skeleton

### Minor: Attribute order sensitivity

The regex requires `type` before `title`. If an agent outputs `<artifact title="..." type="...">`, it will not match. The regex should be order-independent, using two separate attribute captures:

```typescript
const artifactRe = /<artifact\b(?=[^>]*\btype=["'](\w+)["'])(?=[^>]*\btitle=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/artifact>/i;
```

This uses lookaheads to match both attributes in any order.

---

## 3. Streaming Interaction

**Finding: Plan does not address streaming artifacts at all.**

Phase 7 covers streaming optimization (rAF batching, debounced block parsing) but never discusses what happens when an artifact is being streamed. The `parseMessageBlocks()` scanner runs on each token batch, and as noted above, partial artifacts will not match.

Beyond the regex issue, there is a deeper question: should artifact content stream incrementally? For HTML artifacts, showing a progressively building preview would be impressive but technically difficult (iframe srcDoc replacement causes flicker). For code artifacts, incremental Prism highlighting is feasible.

**Recommendation:** Add a note to Phase 3 explicitly addressing streaming behavior. Minimum viable: suppress raw tags during streaming, show skeleton. Ideal: stream code/markdown artifact content, show skeleton for html/react/chart/csv until complete.

---

## 4. New File Count Assessment

**Plan creates 9 new files:**

| File | Phase | Lines | Verdict |
|------|-------|-------|---------|
| `sanitize-config.ts` | 1 | ~30 | Justified — shared config |
| `prism-setup.ts` | 2 | ~40 | Justified — central import |
| `artifact-card.tsx` | 3 | ~120 | Justified — complex component |
| `artifact-renderer.tsx` | 3 | ~80 | Justified — routing switch |
| `artifact-sandbox.tsx` | 4 | ~100 | Justified — iframe lifecycle |
| `artifact-templates.ts` | 4 | ~80 | Justified — HTML templates |
| `chart-renderer.tsx` | 5 | ~150 | Justified — chart-specific logic |
| `csv-table.tsx` | 6 | ~60 | Justified — self-contained |
| `file-preview.tsx` | 6 | ~70 | Justified — PDF/audio/video |
| `lazy-viewport.tsx` | 7 | ~50 | Justified — reusable utility |

**Verdict: 9 files (technically 10 with lazy-viewport) is reasonable.** Each file is under 150 lines, single-responsibility, and avoids further bloating the 2244-line MessageList.tsx. No merges recommended. If anything, `artifact-sandbox.tsx` and `artifact-templates.ts` could be one file, but keeping them separate is fine for clarity.

---

## 5. Phase Dependencies & Parallelization

Current dependency graph:
```
Phase 1 (Security) --> Phase 3 (Detection) --> Phase 4 (Sandbox)
Phase 2 (Syntax) is independent                Phase 5 (Charts) depends on 3
                                                Phase 6 (Files) depends on 3
Phase 7 (Performance) last
```

**This is correct.** Additional parallelization opportunities:

- **Phase 1 and Phase 2 can run in parallel** (plan already states this)
- **Phase 4, 5, and 6 can run in parallel** after Phase 3 completes (they modify different cases in artifact-renderer.tsx, but the switch statement cases are independent). Needs minor coordination to avoid merge conflicts in artifact-renderer.tsx — one agent should own that file, others PR into it.
- **Phase 7 should NOT start until 4/5/6 are done** — it optimizes rendering paths that don't exist yet

Optimal schedule with 2 agents:
```
Week 1:  Agent A: Phase 1 (3h) -> Phase 3 (6h)    Agent B: Phase 2 (4h) -> Phase 6 (3h)
Week 2:  Agent A: Phase 4 (6h) -> Phase 7 (2h)     Agent B: Phase 5 (4h)
```

Total elapsed: ~14h with 2 agents (vs 28h sequential).

---

## 6. Effort Estimate Realism

| Phase | Estimated | My Assessment | Notes |
|-------|-----------|---------------|-------|
| 1. Security | 3h | 2-3h | Straightforward — clear steps, low risk |
| 2. Syntax | 4h | 3h | Prism already installed. CSS is the main work. |
| 3. Detection | 6h | 6-8h | Regex edge cases, streaming handling (if addressed), CSS, testing |
| 4. Sandbox | 6h | 6-8h | React/Babel template is finicky. Cross-origin issues. CDN testing. |
| 5. Charts | 4h | 4h | Recharts is well-documented. JSON spec is clear. |
| 6. Files | 3h | 2-3h | No dependencies, native browser APIs |
| 7. Performance | 2h | 3-4h | rAF batching requires reading the actual streaming code in App.tsx first; Vite chunk config needs testing |

**Total: 28h estimated vs ~26-33h realistic.**

The estimate is reasonable for a senior developer. The main risk is Phase 3+4 taking longer due to streaming edge cases and cross-origin iframe debugging. Phase 7's rAF batching is described as a "pattern recommendation" that depends on reading the actual App.tsx code — this is honest but means the 2h estimate might be optimistic.

---

## 7. Agent Awareness of the Artifact System

**Finding: The plan does NOT address how agents learn to use `<artifact>` markers.**

This is a significant gap. The plan focuses entirely on the UI rendering pipeline but never discusses:

1. **System prompt additions** — Agents need instructions like "When producing HTML pages, SVG diagrams, React components, charts, or CSV data, wrap them in `<artifact type='...' title='...'>` markers."
2. **Tool definitions** — If using tool_use, should there be a `create_artifact` tool? Or is raw text output sufficient?
3. **Format documentation** — The chart JSON spec (Phase 5) is detailed in the plan but agents need it in their context to produce valid output.
4. **Backward compatibility** — What happens to existing agent output that uses plain code blocks for HTML/SVG? Does it continue to render as code, or should auto-detection be added?

The agent's system prompt lives in `src/agent/plugins/clawd-chat/agent.ts` (around line 514). The `<worker_identity>` block would need artifact-related instructions.

**Recommendation:** Add a "Phase 0" or include in Phase 3:
- Update the agent system prompt with artifact usage instructions
- Include the chart JSON spec format
- Document which artifact types are available and when to use them vs plain code blocks
- Decide on Unresolved Question #4 (explicit markers vs auto-detection) — the plan assumes explicit, which is correct for reliability

---

## Additional Findings

### Security: React artifact CSP is too permissive

Phase 4's CSP includes `'unsafe-eval'` (needed for Babel) and `script-src` allowing CDN sources. This is acceptable given sandbox isolation, but the `connect-src 'none'` is good — it prevents data exfiltration. However, the CSP also allows `img-src https:` which means a malicious React artifact could load tracking pixels. Consider restricting to `img-src data: blob:` only for React artifacts.

### Architecture: `PreBlock` export from MessageList.tsx

Phase 3 imports `PreBlock` and icon components from MessageList.tsx. This 2244-line file should not be an export source for small utilities. **Suggestion:** Extract `PreBlock`, `CopyIcon`, `CheckIcon` into a shared `ui-primitives.ts` file as part of Phase 3. This reduces coupling and makes MessageList.tsx easier to split later.

### CSV parser edge case

Phase 6's CSV parser splits on `\n` first, then handles quotes per line. This fails for CSV fields containing embedded newlines within quotes (RFC 4180 allows this). The plan acknowledges this: "Simple parser handles 95% of cases." Acceptable for v1, but worth noting.

### Dark mode: hardcoded colors in artifact-card.tsx

`TYPE_COLORS` (Phase 3) are hardcoded hex values used as `backgroundColor` on badges. These will look fine in both themes since they are bright colors on white text. No issue, but worth verifying contrast ratios.

---

## Summary of Recommendations

| Priority | Issue | Action |
|----------|-------|--------|
| **Critical** | Streaming partial artifacts show raw tags | Add partial-artifact suppression + skeleton in Phase 3 |
| **High** | Agents don't know about artifact protocol | Add system prompt update to Phase 3 or create Phase 0 |
| **High** | Artifact regex is attribute-order-dependent | Use lookahead regex pattern |
| **Medium** | React CSP allows `img-src https:` (tracking pixels) | Restrict to `img-src data: blob:` for React artifacts |
| **Medium** | PreBlock/icons exported from 2244-line file | Extract to `ui-primitives.ts` in Phase 3 |
| **Low** | MAX_HEIGHT inconsistency (600px card body vs 800px iframe) | Unify to shared constant |
| **Low** | Phase 7 effort underestimated | Budget 3-4h instead of 2h |

---

## Verdict

**Architecture is sound.** The security-first approach, incremental phase design, and file decomposition are well-thought-out. The two critical gaps are (1) streaming artifact handling and (2) agent system prompt awareness. Both are addressable within the existing phase structure without rearchitecting. Proceed with implementation after addressing the critical and high-priority items above.
