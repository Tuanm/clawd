# Code Review — MessageList Rendering & UX
**Files**: `packages/ui/src/MessageList.tsx`, `packages/ui/src/styles.css`  
**Commit**: `df7ca6e` (feat(ui): mermaid/iframe/img preview cards with security fixes)  
**Scope**: End-to-end rendering correctness and UX for the scanner-based block splitter

---

## Overall Assessment

The new scanner-based `parseMessageBlocks` is a significant improvement: blocks now render **in source order**, mermaid/image/iframe elements are no longer collected into append-only buckets at the end, and `MermaidDiagram` is correctly memoized. Type safety passes (`tsc --noEmit` clean). However, there are **three Medium** and **two High** issues — primarily an iframe spacing regression, a React key collision, and a streaming-mermaid error flash that wasn't fully addressed.

---

## 1. Block Separation — Demo Message ✅ Correct

The demo message produces **4 blocks in the correct source order**:

| # | Type | Content summary |
|---|------|----------------|
| 0 | `text` | `# The Future of Vault Management` |
| 1 | `image` | `/api/posts/images/1772533795514-image.png` (alt: `image.png`) |
| 2 | `text` | `**The multi-chain future is here.**...\n\nhttps://datawrapper.dwcdn.net/D0Q75/1/\n\n**OctoVault solves this.**\n\nOne account...` |
| 3 | `mermaid` | `flowchart LR …` |

The URL line, the bold paragraphs, and the heading are all in the correct blocks. Order matches the original. ✅

---

## Issues

---

### [HIGH] Issue 1 — `IframePreviewCard` missing `.message-block` wrapper causes broken spacing

**File**: `MessageList.tsx:1876–1885`, `styles.css:1591–1603, 4044–4049`

The `iframe` case renders `<IframePreviewCard>` without a `.message-block` wrapper:

```tsx
case "iframe":
  return (
    <IframePreviewCard          // ← no .message-block div!
      key={`iframe-${block.src}`}
      ...
    />
  );
```

`IframePreviewCard` returns `<div className="message-iframe-card" style={...}>` — 8px margin. But:

- `.message-block { margin: 6px 0 }` doesn't apply → **iframes get 8px margin, all other blocks get 6px**
- `.message-block:first-child { margin-top: 0 }` doesn't fire → **if the iframe is the first block, there's a stray 8px top gap**
- `.message-block:last-child { margin-bottom: 0 }` doesn't fire → **if iframe is the last block, 8px bottom gap instead of 0**

Combined gap between an iframe and surrounding text blocks = 8+6 = 14px vs. 6+6 = 12px between two text blocks. The first/last flush behaviour is broken for iframes.

**Fix**:
```tsx
case "iframe":
  return (
    <div key={`iframe-${block.src}`} className="message-block">
      <IframePreviewCard
        src={block.src}
        rawHtml={block.rawHtml}
        height={block.height}
        width={block.width}
      />
    </div>
  );
```
Then remove `margin: 8px 0` from `.message-iframe-card` (it's owned by `.message-block` now, like mermaid and image cards).

---

### [HIGH] Issue 2 — React key collision for repeated image or iframe URLs

**File**: `MessageList.tsx:1869, 1879`

```tsx
key={`img-${block.src}`}      // image
key={`iframe-${block.src}`}   // iframe
```

If a message contains two images (or two iframes) with the **same src**, both elements get the same React key. React silently drops one and produces a console warning. Example:

```markdown
![chart](/api/img/chart.png)

Here's the same chart again for reference:

![chart](/api/img/chart.png)
```

Both blocks become `key="img-/api/img/chart.png"` → only the first is rendered.

**Fix** — append the block index as a tiebreaker:
```tsx
key={`img-${i}-${block.src}`}
key={`iframe-${i}-${block.src}`}
```

This is safe because `i` is the position in the `blocks` array which doesn't change between streaming ticks for a settled message.

---

### [MEDIUM] Issue 3 — Empty-lang fenced code block loses the copy button

**File**: `MessageList.tsx:1847–1856`, `PreBlock` (line 231–236)

```tsx
case "code":
  return (
    <div key={`c${i}`} className="message-block">
      <PreBlock>
        <code className={block.lang ? `language-${block.lang}` : ""}>  // ← className=""
          {block.content}
        </code>
      </PreBlock>
    </div>
  );
```

`PreBlock` checks:
```tsx
const hasLanguageClass = codeElement?.props?.className?.startsWith("language-");
if (!hasLanguageClass) return <pre>{children}</pre>;  // no copy button
```

When `block.lang` is `""` (from ` ```\n...``` ` with no language tag), `className=""` → `startsWith("language-")` is `false` → plain `<pre>`, no copy button. Users writing ` ```\n...``` ` to share a command or snippet get no copy affordance.

The intent of `hasLanguageClass` was to avoid adding a copy button to *inline* code elements passing through the Markdown `code` handler without a `<pre>` parent. For the explicit `case "code"` path in the switch, the element is **always a fenced block** and should always get the copy button.

**Fix** — use a fallback language class, or pass an explicit boolean to `PreBlock`:

```tsx
// Option A: always "language-text" for untagged fences
<code className={block.lang ? `language-${block.lang}` : "language-text"}>

// Option B: add a prop to PreBlock to force the copy button
export function PreBlock({ children, forceCopy = false }: { children: React.ReactNode; forceCopy?: boolean }) {
  const hasLanguageClass = forceCopy || codeElement?.props?.className?.startsWith("language-");
  ...
}
```

---

### [MEDIUM] Issue 4 — Double CSS margin on mermaid/image cards (`.message-block` + card class)

**File**: `styles.css:1591, 4018, 4027`

Mermaid and image blocks are rendered with **both** `.message-block` and the card class:

```tsx
<div className="message-block message-mermaid-card">
<div className="message-block message-image-card">
```

Both `.message-mermaid-card` and `.message-image-card` independently declare `margin: 8px 0`. Since these rules appear **after** `.message-block { margin: 6px 0 }` in the stylesheet and have equal specificity (0,1,0), the **8px wins** — overriding the intended 6px from `.message-block`.

The `:first-child` / `:last-child` overrides work correctly because `.message-block:first-child` has specificity (0,2,0) which beats either card class alone. But it means `.message-block`'s margin value is unreachable for these elements — the card class always wins, defeating the purpose of the unified spacing rule.

**Fix** — Remove `margin` from `.message-mermaid-card` and `.message-image-card` since `.message-block` now owns spacing:

```css
/* Remove: */
.message-mermaid-card { margin: 8px 0; }
.message-image-card   { margin: 8px 0; }
```

If extra breathing room is wanted around diagrams/images, adjust `.message-block` or use a modifier.

---

### [MEDIUM] Issue 5 — `postMessage` handler missing `ev.origin` check on the chart-ID branch

**File**: `MessageList.tsx:353–358`

```ts
if (
  ev.source === iframeRef.current.contentWindow ||   // ✅ source check
  iframeId === `datawrapper-chart-${chartId}`         // ❌ no origin check
) {
  setHeight(next);
}
```

The `ev.source` branch is correctly validated. But the `iframeId` branch fires for **any window** that sends a well-crafted `datawrapper-height` message containing a chartId that matches a known `iframeId`. A malicious embedded page in a *different* iframe on the same page could send a spoofed message and force the height to 99,999px, pushing content offscreen.

The impact is limited (layout disruption only — no script execution), but it violates the principle of origin validation.

**Fix**:
```ts
const DATAWRAPPER_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?datawrapper\.de$/;

const handleMessage = (ev: MessageEvent) => {
  if (!iframeRef.current) return;
  // Only accept messages from the actual iframe or from datawrapper.de
  const fromOurIframe = ev.source === iframeRef.current.contentWindow;
  const fromDatawrapper = typeof ev.origin === 'string' && DATAWRAPPER_ORIGIN.test(ev.origin);
  if (!fromOurIframe && !fromDatawrapper) return;
  ...
};
```

---

### [LOW] Issue 6 — `markdownComponents` object recreated on every render

**File**: `MessageList.tsx:1783–1827`

`markdownComponents` is defined inside the per-message render closure and recreated on every re-render of the message list (including during streaming). All functions close over module-level components (`PreBlock`, `MermaidDiagram`, `Callout`) — nothing from local scope. react-markdown does not deep-compare `components`, so every new object reference will trigger a re-render of all `<Markdown>` instances in the current viewport.

For a channel with 100 messages streaming at 30 fps, this creates 3000 ephemeral objects per second.

**Fix** — hoist to module scope (all deps are module-level):
```tsx
// Place near PreBlock/MermaidDiagram at module level, outside any component
const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <PreBlock>{children}</PreBlock>,
  code: ({ className, children }) => { ... },
  blockquote: ({ children }) => { ... },
  table: ({ children }) => ( ... ),
  a: ({ href, children }) => ( ... ),
  input: ({ type, checked, ...props }) => { ... },
};
```

---

### [LOW] Issue 7 — `as const` produces a narrowly typed object — ✅ Currently safe, fragile long-term

**File**: `MessageList.tsx:1827`

```tsx
} as const;
```

`as const` on a function-property object produces `{ readonly pre: (...) => JSX.Element; readonly code: (...) => JSX.Element; ... }`. react-markdown's `Components` type accepts readonly objects, and `tsc --noEmit` passes clean.

The fragility: if a future react-markdown upgrade narrows its `Components` type to require specific props (e.g., adds required `node?: Element` params), the `as const` narrowing could produce a type error that's harder to debug. Removing `as const` (or using an explicit `satisfies Components` annotation) would be clearer:

```tsx
const markdownComponents = { ... } satisfies Partial<Components>;
```

Not a current issue — noting for future robustness.

---

### [LOW] Issue 8 — Streaming mermaid: partial diagram flashes error state

**File**: `MessageList.tsx:261–307`

Once the closing ` ``` ` arrives and the mermaid block is extracted by `parseMessageBlocks`, subsequent streaming tokens change `block.content`, causing `MermaidDiagram` to receive updated `chart` props on each tick. Each tick calls `mermaid.render()` with incrementally growing but potentially-invalid diagram syntax. When `mermaid.render()` throws, `setError(...)` fires and the error div replaces the previous SVG.

The memoization (`React.memo`) prevents re-renders when `chart` is identical between parent renders — it does **not** prevent the error flash during streaming where `chart` is changing.

The pre-existing comment says "Keeps the previous SVG visible while a new render is in progress" — this is only true when the async render succeeds. When it throws, the error state *does* replace the SVG.

**Fix** — preserve the previous SVG on error during streaming:
```tsx
const [svg, setSvg] = useState<string>("");
const [error, setError] = useState<string | null>(null);
const prevSvg = useRef<string>("");

// In renderChart:
const result = await mermaid.render(id, chart.trim());
if (!cancelled) {
  prevSvg.current = result.svg;
  setSvg(result.svg);
  setError(null);
}
// In catch:
if (!cancelled) {
  // Only show error if we have no prior valid SVG (final state, not streaming)
  if (!prevSvg.current) setError(firstLine);
  // else: silently keep the last valid SVG visible
}
```

---

### [LOW] Issue 9 — Plain URL lines stay as `<a>` links — acceptable

**File**: `MessageList.tsx:1836–1845` (text block → Markdown renderer)

The URL `https://datawrapper.dwcdn.net/D0Q75/1/` in block 2 is rendered by `<Markdown>` with `remarkGfm` as a plain `<a>` link (GFM autolinks). This is **correct and acceptable** — it matches standard Markdown behaviour. The `a` component overrides `target="_blank" rel="noopener noreferrer"`, so it opens safely in a new tab.

A richer "link preview card" is a product decision, not a correctness issue.

---

### [INFO] Consecutive same-type blocks — correct, minor visual gap

Two consecutive markdown images with no text between them produce two separate `image` `MessageBlock` objects, each in their own `.message-block` div. With Issue 4 fixed (removing the 8px override from `.message-image-card`), the gap between them would be `6 + 6 = 12px`. This is intentional and acceptable — images are separate content units.

---

## Summary Table

| # | Severity | Issue |
|---|----------|-------|
| 1 | **High** | `IframePreviewCard` not wrapped in `.message-block` — first/last margin reset broken, 8px vs 6px inconsistency |
| 2 | **High** | React key collision for same-src images/iframes — one copy silently dropped |
| 3 | Medium | Empty-lang code fence loses copy button |
| 4 | Medium | Double CSS margin on mermaid/image blocks — `.message-block` always overridden by card class |
| 5 | Medium | `postMessage` handler: `iframeId` branch lacks `ev.origin` validation |
| 6 | Low | `markdownComponents` recreated per render — should be module-level constant |
| 7 | Low | `as const` — currently fine, `satisfies Components` is more future-proof |
| 8 | Low | Streaming mermaid: partial content flashes error state while streaming |
| 9 | Low/Info | Plain URLs render as links (acceptable, no action required) |

---

## Positive Observations

- ✅ **Scanner correctly preserves source order** — the old "extract into buckets, append at end" anti-pattern is gone
- ✅ `React.memo` on `MermaidDiagram` prevents unnecessary re-renders when chart content is unchanged
- ✅ Stable `djb2Hash` ID for mermaid avoids DOM element leaks from changing IDs on every stream tick
- ✅ `isSafeUrl` correctly guards both absolute and relative `/api/` image URLs
- ✅ DataWrapper postMessage resize listener is a nice UX touch; the `ev.source` check on the first branch is correct
- ✅ `rehypeRaw` allows HTML entities decoded by `processMessageText` to be re-parsed as HTML blocks
- ✅ TypeScript strict mode passes cleanly
