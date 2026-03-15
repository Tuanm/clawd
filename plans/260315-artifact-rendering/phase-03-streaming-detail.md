# Phase 3 Addendum: Streaming Artifact Detection & Rendering

## Context Links
- [MessageList.tsx](../../packages/ui/src/MessageList.tsx) — `parseMessageBlocks()` (line 415), `MessageBlock` type (line 325), render switch (line 1947), `isStreaming` (line 1842)
- [phase-03-artifact-detection-panel.md](./phase-03-artifact-detection-panel.md) — base artifact detection spec
- [plan.md](./plan.md) — overall plan

## Overview
- **Priority:** P1
- **Status:** Pending
- **Depends on:** Phase 3 (Artifact Detection & Panel)
- **Description:** During streaming, artifact tags arrive incrementally. The current `parseMessageBlocks()` regex requires a closing `</artifact>` tag to match, causing raw XML text to flash onscreen for seconds until the artifact completes. This addendum specifies a streaming-aware partial detection system with placeholder rendering and smooth transition.

## Problem Statement

When an agent streams a message containing an artifact:

1. **T=0s** — Opening `<artifact type="html" title="Dashboard">` appears. No regex match. Raw XML tag visible.
2. **T=0.1s-5s** — Body tokens stream in. All content appears as raw text/code.
3. **T=5s** — Closing `</artifact>` arrives. Regex matches. Sudden jump from wall-of-text to rendered card.

This creates a jarring UX: seconds of raw XML followed by a layout jump. Large artifacts (React dashboards, long SVGs) are especially bad — 50KB+ of raw JSX onscreen.

## Key Insights

- `isStreaming` boolean is already in scope at the render site (line 1842), and can be threaded into `parseMessageBlocks()` as a second parameter
- `parseMessageBlocks()` is called on every streaming tick (each token append triggers re-render via state update on `msg.text`)
- `MARKDOWN_COMPONENTS` is already a module-level constant to avoid re-render churn (line 544-546) — same pattern should apply to streaming artifact detection
- The scanner loop (line 428-507) processes candidates earliest-first, so a partial artifact candidate just needs to be added with its correct `index` position

## Architecture

### Approach: Two-Phase Detection

**Phase A — Partial match (streaming only):**
When `isStreaming === true`, after all existing candidate checks, attempt a partial artifact opening tag match. If we find `<artifact` with at least `type` and `title` attributes but NO closing `</artifact>`, emit a `streaming-artifact` block.

**Phase B — Complete match (always):**
Existing full artifact regex from Phase 3. When closing tag arrives, this match wins (it's earlier or same index as the partial match and has a concrete `end`).

The transition from Phase A to Phase B happens naturally: on the streaming tick where `</artifact>` arrives, the full regex matches and the partial regex is never reached (full match has same start index but is a proper candidate with known end).

### Modified `parseMessageBlocks()` Signature

```typescript
function parseMessageBlocks(text: string, isStreaming?: boolean): MessageBlock[]
```

Single optional boolean parameter. No breaking changes to existing call site.

### New MessageBlock Variant

```typescript
type MessageBlock =
  | { type: "text"; content: string }
  | { type: "code"; lang: string; content: string }
  | { type: "mermaid"; content: string }
  | { type: "image"; src: string; alt: string }
  | { type: "iframe"; src: string; rawHtml: string; height?: string; width?: string }
  | { type: "artifact"; artifactType: ArtifactType; title: string; content: string; language?: string }
  | { type: "streaming-artifact"; artifactType: ArtifactType; title: string; partialContent: string };
```

The `streaming-artifact` variant carries `partialContent` (raw text received so far) instead of final `content`.

## Implementation Steps

### Step 1: Add Partial Tag Regex to `parseMessageBlocks()` (line ~460)

After the full artifact regex candidate block (added by Phase 3), add a streaming-only fallback.

```typescript
// ── <artifact> (partial, streaming only) ────────────────────────
// Only active during streaming. Detects opening tag without closing tag.
if (isStreaming) {
  const partialArtifactRe = /<artifact\s+type=["'](\w+)["']\s+title=["']([^"']+)["'][^>]*>/i;
  const pm = partialArtifactRe.exec(slice);
  if (pm !== null) {
    // Only use partial match if no full artifact match was found at the same position
    const fullAlreadyFound = candidates.some(
      c => c.block.type === "artifact" && c.index <= pm.index
    );
    if (!fullAlreadyFound) {
      const afterTag = slice.slice(pm.index + pm[0].length);
      // Verify no closing tag exists — if it does, the full regex should have caught it
      if (!/<\/artifact>/i.test(afterTag)) {
        const artifactType = pm[1].toLowerCase() as ArtifactType;
        const validTypes: ArtifactType[] = ["html", "react", "svg", "chart", "csv", "markdown", "code"];
        if (validTypes.includes(artifactType)) {
          candidates.push({
            index: pm.index,
            end: text.length,  // consume everything to end — it's all artifact content
            block: {
              type: "streaming-artifact",
              artifactType,
              title: pm[2],
              partialContent: afterTag.trimStart(),
            },
          });
        }
      }
    }
  }
}
```

**Key details:**
- `end: text.length` — consumes all remaining text. During streaming, everything after the opening tag is artifact content. No text block will be pushed for the tail.
- Guard `fullAlreadyFound` prevents emitting a partial match when a full match already exists at a lower or equal index (handles the tick where closing tag arrives).
- The `!/<\/artifact>/i.test(afterTag)` double-check handles edge cases where the full regex failed for unexpected reasons.

### Step 2: Update `pushText()` to Strip Partial Opening Tags During Streaming

```typescript
const pushText = (str: string) => {
  let cleaned = str
    .replace(/<iframe\b[\s\S]*?(?:<\/iframe>|\/>)/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<artifact\b[\s\S]*?<\/artifact>/gi, "");
  // During streaming, also strip orphaned opening tags that haven't been picked up as candidates
  if (isStreaming) {
    cleaned = cleaned.replace(/<artifact\b[^>]*>[\s\S]*$/i, "");
  }
  if (cleaned.trim()) blocks.push({ type: "text", content: cleaned });
};
```

### Step 3: Pass `isStreaming` at Call Site (line 1927)

```typescript
// Before (line 1927):
const blocks = parseMessageBlocks(decodedText);

// After:
const blocks = parseMessageBlocks(decodedText, isStreaming);
```

`isStreaming` is already defined at line 1842 in the same scope.

### Step 4: Add Render Case for `streaming-artifact` (line ~1995)

After the `case "artifact":` block, add:

```typescript
case "streaming-artifact":
  return (
    <div key={`block-${i}`} className="message-block">
      <StreamingArtifactCard
        artifactType={block.artifactType}
        title={block.title}
        partialContent={block.partialContent}
      />
    </div>
  );
```

### Step 5: Create `StreamingArtifactCard` Component

Add to `artifact-card.tsx` (or a new `streaming-artifact-card.tsx` if file size demands).

```typescript
interface StreamingArtifactCardProps {
  artifactType: ArtifactType;
  title: string;
  partialContent: string;
}

export function StreamingArtifactCard({ artifactType, title, partialContent }: StreamingArtifactCardProps) {
  return (
    <div className="artifact-card artifact-card--streaming">
      <div className="artifact-card-header artifact-card-header--streaming">
        <span
          className="artifact-card-type-badge"
          style={{ backgroundColor: TYPE_COLORS[artifactType] }}
        >
          {TYPE_LABELS[artifactType]}
        </span>
        <span className="artifact-card-title">{title}</span>
        <span className="artifact-card-streaming-indicator">
          <span className="artifact-card-spinner" />
          Generating...
        </span>
      </div>
      <div className="artifact-card-body artifact-card-body--streaming">
        <pre className="artifact-card-preview">
          <code>{partialContent}</code>
        </pre>
      </div>
    </div>
  );
}
```

**Design decisions:**
- Card is always expanded during streaming (no collapse toggle — user wants to see progress)
- No action buttons during streaming (content is incomplete — Copy/Download would give partial data)
- Live code preview shows raw content as it streams in
- Preview area auto-scrolls to bottom via CSS `overflow-anchor`

### Step 6: CSS for Streaming State

```css
/* ── Streaming artifact ──────────────────────────────────────── */
.artifact-card--streaming {
  border-color: var(--accent-color, #0366d6);
  border-style: dashed;
}

.artifact-card-header--streaming {
  background: var(--card-header-bg, #f6f8fa);
}

.artifact-card-streaming-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary, #586069);
  margin-left: auto;
}

.artifact-card-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-color, #e1e4e8);
  border-top-color: var(--accent-color, #0366d6);
  border-radius: 50%;
  animation: artifact-spin 0.8s linear infinite;
}

@keyframes artifact-spin {
  to { transform: rotate(360deg); }
}

.artifact-card-body--streaming {
  max-height: 200px;
  overflow-y: auto;
  overflow-anchor: auto;
  scroll-behavior: smooth;
}

.artifact-card-body--streaming .artifact-card-preview {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary, #586069);
}

/* Transition animation: streaming -> complete */
.artifact-card--streaming {
  animation: artifact-pulse 2s ease-in-out infinite;
}

@keyframes artifact-pulse {
  0%, 100% { border-color: var(--accent-color, #0366d6); }
  50% { border-color: var(--border-color, #e1e4e8); }
}

/* When streaming ends, the card switches from streaming-artifact to artifact.
   The artifact-card gets a one-shot entrance animation: */
.artifact-card:not(.artifact-card--streaming) {
  animation: artifact-appear 0.3s ease-out;
}

@keyframes artifact-appear {
  from {
    opacity: 0.7;
    transform: scale(0.98);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
```

### Step 7: Auto-Scroll Preview to Bottom

The preview area uses `overflow-anchor: auto` which keeps scroll pinned to bottom as new content arrives. For browsers that don't support `overflow-anchor`, add a sentinel div:

```typescript
export function StreamingArtifactCard({ artifactType, title, partialContent }: StreamingArtifactCardProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [partialContent]);

  return (
    <div className="artifact-card artifact-card--streaming">
      {/* ...header... */}
      <div className="artifact-card-body artifact-card-body--streaming">
        <pre className="artifact-card-preview">
          <code>{partialContent}</code>
        </pre>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
```

## Transition Behavior

The transition from streaming to complete is automatic and requires no special logic:

1. **During streaming:** `parseMessageBlocks(text, true)` — partial regex matches, emits `streaming-artifact` block. React renders `StreamingArtifactCard`.
2. **Closing tag arrives:** On the next tick, `parseMessageBlocks(text, true)` — full artifact regex now matches (has both opening and closing tags). Full match is at same or lower index than partial. `streaming-artifact` candidate is never added (guarded by `fullAlreadyFound`). Block type is `artifact`. React renders `ArtifactCard`.
3. **Streaming ends:** `isStreaming` flips to `false`. `parseMessageBlocks(text, false)` — partial regex skipped entirely. Full regex matches. Stable state.

The visual transition is handled by CSS: `artifact-card--streaming` has dashed border + pulse animation. When the block type switches to `artifact`, React unmounts `StreamingArtifactCard` and mounts `ArtifactCard`. The `artifact-appear` animation provides a subtle scale+fade entrance.

**No layout jump** — both cards have the same outer container structure (`.artifact-card` class), same width, same header layout. The body changes from raw preview to collapsed state, which is actually a *reduction* in height — a gentle collapse rather than an expansion.

## Edge Cases

### Multiple artifacts in one message (some complete, some streaming)

Handled naturally. The scanner loop processes candidates earliest-first. Complete artifacts earlier in the text match the full regex. The last (still-streaming) artifact matches the partial regex. Each produces its own block in order.

Example mid-stream text:
```
Here's the header:
<artifact type="svg" title="Logo">...</artifact>
And here's the dashboard:
<artifact type="html" title="Dashboard">
<div>partial content so far
```

Produces blocks: `[text, artifact(svg), text, streaming-artifact(html)]`

### Very large artifact content (>50KB streaming JSX)

- Preview area is capped at `max-height: 200px` with `overflow-y: auto` — DOM size stays constant regardless of content size
- `parseMessageBlocks()` runs on full text each tick, but the partial regex is a single linear scan — O(n) where n is message length. For 50KB this is ~microseconds
- React reconciliation: `partialContent` prop changes each tick, but it's a single `<code>` text node update — no VDOM diff explosion
- **Optimization for extreme cases (>100KB):** Truncate `partialContent` to last 5000 chars in the component. User doesn't need to see the beginning of a 100KB file while it's still streaming.

```typescript
const PREVIEW_TAIL_LIMIT = 5000;
const displayContent = partialContent.length > PREVIEW_TAIL_LIMIT
  ? `... (${Math.round(partialContent.length / 1024)}KB generated)\n\n${partialContent.slice(-PREVIEW_TAIL_LIMIT)}`
  : partialContent;
```

### Stream error mid-artifact

If the WebSocket connection drops or the agent errors mid-artifact:
- `msg.is_streaming` flips to `false`
- On next render, `isStreaming` is `false`, partial regex is skipped
- Full artifact regex doesn't match (no closing tag)
- The incomplete `<artifact ...>content...` falls through to `pushText()`, which strips orphaned opening tags (Step 2 cleanup regex). Remaining content renders as plain text.
- **Net effect:** Partial artifact gracefully degrades to text. No stuck spinner.

### Agent abandons artifact mid-stream

Same as stream error — agent sends more text after the opening tag but never closes it. When streaming ends:
- `isStreaming` → `false`
- No closing tag → full regex fails
- `pushText()` strips the opening tag
- Content after the tag renders as normal text

### Artifact opening tag split across streaming chunks

The opening tag `<artifact type="html" title="Dashboard">` might arrive as:
- Tick 1: `<artifact type="html" tit`
- Tick 2: `<artifact type="html" title="Dashboard">`

The partial regex requires both `type` and `title` attributes to fully match. On Tick 1, the regex doesn't match — text renders as-is (brief flash of `<artifact type="html" tit`). On Tick 2, partial regex matches and the card appears. This is a ~100ms window at typical streaming speeds. Acceptable.

### Artifact tag inside a fenced code block

```
Here's how to use artifacts:
\`\`\`
<artifact type="html" title="Example">
...
</artifact>
\`\`\`
```

The fenced code block regex (line 434) matches first (lower index in candidates). The artifact text is consumed as code block content. The artifact regex never sees it. Correct behavior — no false positive.

### Interaction with 500-char / VDOM Re-parse Concern

Line 544-546 comment notes that `MARKDOWN_COMPONENTS` is module-level to avoid re-parse on streaming ticks. The same concern applies:

- `parseMessageBlocks()` is pure function — no hooks, no state. Safe to call every tick.
- `StreamingArtifactCard` is a lightweight component. `partialContent` prop changes cause a single text node update.
- The heavy VDOM work is in `<Markdown>` for text blocks. Text blocks before the streaming artifact are stable (their content doesn't change between ticks). React's keyed reconciliation (`key={block-${i}}`) ensures only the streaming artifact block re-renders.
- **One concern:** If the streaming artifact is NOT the last block (e.g., agent writes text after abandoning an artifact), block indices could shift and invalidate keys. Mitigation: use content-based keys for artifact blocks: `key={artifact-${block.title}}`.

## Related Code Files

### Files to Modify
| File | Changes |
|------|---------|
| `packages/ui/src/MessageList.tsx` | Add `streaming-artifact` to `MessageBlock` union (line 325); add partial regex to `parseMessageBlocks()` (line ~460); update `pushText()` streaming cleanup; pass `isStreaming` to `parseMessageBlocks()` (line 1927); add `case "streaming-artifact"` to render switch |
| `packages/ui/src/artifact-card.tsx` | Add `StreamingArtifactCard` component export |
| `packages/ui/src/styles.css` | Add streaming artifact CSS (spinner, pulse, transition, preview area) |

### Files to Create
None — all changes fit in existing/planned files.

## Todo List

- [ ] Add `streaming-artifact` variant to `MessageBlock` union type
- [ ] Add `isStreaming?: boolean` parameter to `parseMessageBlocks()`
- [ ] Add partial artifact opening tag regex (streaming-only branch)
- [ ] Add guard: skip partial match if full match already found at same/lower index
- [ ] Update `pushText()` to strip orphaned opening tags during streaming
- [ ] Pass `isStreaming` at call site (line 1927)
- [ ] Create `StreamingArtifactCard` component in `artifact-card.tsx`
- [ ] Add auto-scroll with `bottomRef` + `useEffect`
- [ ] Add `PREVIEW_TAIL_LIMIT` truncation for >100KB content
- [ ] Add `case "streaming-artifact"` to render switch
- [ ] Add streaming CSS: dashed border, spinner, pulse animation, preview area
- [ ] Add `artifact-appear` transition CSS for complete artifact entrance
- [ ] Test: Opening tag mid-stream shows skeleton card with spinner
- [ ] Test: Content streams into preview area with auto-scroll
- [ ] Test: Closing tag transitions to full ArtifactCard (no layout jump)
- [ ] Test: Stream error mid-artifact degrades to plain text
- [ ] Test: Multiple artifacts (mix of complete + streaming) render correctly
- [ ] Test: Artifact inside fenced code block not falsely detected
- [ ] Test: Very large artifact (>50KB) stays performant (truncated preview)
- [ ] Run `bun run build:ui` to verify no compile errors

## Success Criteria

1. During streaming, the moment `<artifact type="..." title="...">` tag is fully received, a skeleton card appears with title, type badge, and "Generating..." spinner
2. Artifact content streams into a scrolling preview pane inside the card
3. When `</artifact>` arrives, card smoothly transitions to full ArtifactCard (collapsed state with action buttons)
4. If stream ends without closing tag, card disappears and content renders as plain text
5. No raw `<artifact>` XML visible to user at any point during streaming
6. No layout jump or content flash during transition
7. Performance: <5ms per `parseMessageBlocks()` call even with 50KB+ streaming artifact

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Partial regex matches non-artifact text that starts with `<artifact` | Very Low | Medium | Requires both `type` and `title` attributes in specific format. Natural text extremely unlikely to match. |
| Key instability when block count changes between ticks | Medium | Low | Use content-based keys (`artifact-${title}`) instead of index-based for artifact blocks |
| Brief flash of raw opening tag while it's still incomplete (~100ms) | Medium | Low | Acceptable at streaming speeds. Alternative: buffer detection with 200ms debounce, but adds complexity for marginal gain |
| `useEffect` scroll on every tick causes jank | Low | Medium | `scrollIntoView({ block: "end" })` is lightweight. `overflow-anchor` handles most cases natively. |

## Security Considerations

- Partial content is rendered inside `<pre><code>` — no HTML interpretation, no XSS risk
- No action buttons during streaming — user cannot copy/download/fullscreen incomplete content
- `pushText()` cleanup strips orphaned tags to prevent rehype-raw from interpreting them
- Transition to complete artifact goes through same DOMPurify/sanitize pipeline as Phase 3

## Unresolved Questions

1. **Debounce the partial detection?** Currently runs on every streaming tick. For most cases this is fine (<1ms), but for extremely fast token rates + large messages, a 100-200ms debounce on re-parsing could help. Trade-off: adds latency to card appearance. Recommendation: ship without debounce, add if profiling shows issues.
2. **Should the preview show syntax-highlighted code during streaming?** Current spec uses plain `<code>` for simplicity. Prism highlighting on every tick would be expensive for large content. Could highlight only the visible tail (last 200 lines). Recommendation: plain text for v1.
3. **Content-based key format?** `artifact-${title}` assumes titles are unique within a message. If an agent produces two artifacts with the same title, keys collide. Could append index: `artifact-${title}-${i}`. Low risk but worth noting.
