# Code Review — `parseMessageBlocks` & Message Render Loop
**File:** `packages/ui/src/MessageList.tsx`  
**Commit:** `df7ca6e` feat(ui): mermaid/iframe/img preview cards with security fixes  
**Reviewer:** Senior Engineer  
**Date:** 2025-07-25

---

## Scope
- **Primary focus:** `parseMessageBlocks()` scanner algorithm, `IframePreviewCard`, render loop, `markdownComponents as const`
- **LOC changed:** ~250 lines modified/added in the reviewed area
- **All test cases run as Node.js simulation** to verify scanner behavior empirically

---

## Overall Assessment

The new scanner-based approach is a meaningful improvement over the previous multi-pass `replace`+fence-map strategy: it correctly preserves source order, handles CRLF, and properly guards images/iframes that appear inside code fences (fence wins because it appears first, so the position sort puts it ahead of candidates inside it). TypeScript compiles clean (`tsc --noEmit` exit 0). No catastrophic-backtracking risk was found in any regex.

However, there are **three High-severity issues** (React key collisions, `markdownComponents` recreation on every render, and missing postMessage origin validation) plus several Medium bugs that need fixing before this is production-safe.

---

## Critical Issues

_None._

---

## High Priority

### H1 — React Key Collisions: `img-${src}`, `iframe-${src}`, `mermaid-${hash}` are Not Unique

**Confirmed by tests 4, 15, 16, and 20.**

All three content-derived key schemes collide when the same content appears more than once in a single message:

| Block type | Key expression | Collision scenario |
|---|---|---|
| `image` | `` `img-${block.src}` `` | Same image URL repeated twice (e.g., a comparison table) |
| `iframe` | `` `iframe-${block.src}` `` | Same embed URL appearing twice |
| `mermaid` | `` `mermaid-${djb2Hash(block.content)}` `` | Two identical diagrams + hash collision among different content |

```
// Test 4 — both items get key "img-https://ex.com/img.png"
![a](https://ex.com/img.png)
![b](https://ex.com/img.png)
```

React will warn in dev and may skip rendering the second element entirely in reconciliation.

**Also:** The mix of index-based keys (`t${i}`, `c${i}`) for text/code and content-based keys for the rest is inconsistent. During streaming, when a text block at index 0 gets *split* by an arriving image URL (e.g., text becomes `[text, image, text]`), all subsequent index-based keys shift by +2, causing React to unmount and remount those blocks unnecessarily.

**Fix:** Use position index as the canonical key for ALL block types, adding a type prefix to make them namespaced:
```tsx
// Replace all key= expressions with:
key={`block-${i}`}
// Or, for better stability across streaming splits, use a composite:
key={`${block.type}-${i}`}
```
For the mermaid case specifically — the `MermaidDiagram` component is already `React.memo` keyed on `chart` content, so the render optimisation doesn't depend on the outer div key being content-derived.

---

### H2 — `markdownComponents` Recreated on Every Render (Performance)

**Line 1783.**

`markdownComponents` is declared as an object literal *inside* the `messages.map()` callback. This means a brand-new object reference is created on every render of the parent `MessageList`, for every message. `react-markdown` uses referential equality for the `components` prop — when the reference changes, it triggers a full re-parse and re-render of the markdown tree.

During streaming (which re-renders on every token), this means every message's markdown is re-parsed from scratch on every frame for the lifetime of the stream.

```tsx
// BEFORE (inside the render loop — new object every render):
const markdownComponents = { pre: ..., code: ..., ... } as const;

// AFTER — hoist outside MessageList or useMemo at component level:
// Option A: define once at module level (no closures over component state needed)
const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <PreBlock>{children}</PreBlock>,
  code: ({ className, children }) => { ... },
  // ...
};

// Option B: if component state is needed, useMemo at MessageList level (not inside map):
const markdownComponents = useMemo(() => ({ ... }), []);
```

The existing `MermaidDiagram` is `React.memo`-wrapped specifically to avoid this problem. The same logic applies here.

---

### H3 — `postMessage` Handler Missing Origin Validation (Security)

**Lines 347–366, `IframePreviewCard`.**

The `handleMessage` listener has two branches to accept a DataWrapper resize event. The second branch — `iframeId === \`datawrapper-chart-${chartId}\`` — does **not** check `ev.origin`. This means any page in the browser (including other iframes in the same session, or a compromised third-party embed) can send:

```js
window.parent.postMessage({ 'datawrapper-height': { 'abc123': 99999 } }, '*')
```

If the rendered page contains `id="datawrapper-chart-abc123"`, the height will be set to 99999px — expanding the iframe container to an arbitrary size, potentially obscuring UI elements (a form of clickjacking/UI redressing).

The first branch (`ev.source === iframeRef.current.contentWindow`) is safe because it validates the origin implicitly via the source window reference.

**Fix:**
```tsx
// Extract expected origin from the iframe src once
const expectedOrigin = useMemo(() => {
  try { return new URL(src).origin; } catch { return null; }
}, [src]);

const handleMessage = (ev: MessageEvent) => {
  // Validate origin before trusting the ID-based branch
  if (expectedOrigin && ev.origin !== expectedOrigin &&
      ev.source !== iframeRef.current?.contentWindow) return;
  // ...rest of handler
};
```

For DataWrapper specifically, the expected origin is `https://datawrapper.dwcdn.net`.

---

## Medium Priority

### M1 — Unsafe Iframe Src Bypasses Extraction and Lands in `rehypeRaw` Text Block

**Confirmed by test 21.**

When the `iframeRe` scanner matches an `<iframe>` with an unsafe src (e.g., `javascript:alert(1)`) and `isSafeUrl` returns `false`, the iframe is NOT added to `candidates`. **But** if another candidate (e.g., a safe image further along) IS found, `pushText(slice.slice(0, earliest.index))` emits the unsafe iframe HTML verbatim into a `text` block. That text block is then rendered by:

```tsx
<Markdown rehypePlugins={[rehypeKatex, rehypeRaw]} ...>
```

`rehype-raw` passes HTML nodes through as-is with **no sanitization**. The `<iframe src="javascript:...">` gets rendered directly into the DOM. Modern browsers do block `javascript:` in iframe src, but `data:` URIs, relative paths pointing to authenticated endpoints, or `blob:` URLs are not blocked at the browser level.

```
Input:  <iframe src="javascript:alert(1)"></iframe>\n![img](https://safe.com/img.png)
Output blocks: [ text("<iframe src=...>"), image("https://safe.com/img.png") ]
          ↑ this goes through rehypeRaw unfiltered
```

Note: the previous implementation had the same behavior (unsafe iframes were re-inserted as `_` into `cleaned`). This is not a regression, but the new code's explicit `isSafeUrl` guard creates a false sense of security — the extraction pass is not the last line of defense.

**Fix:** Add `rehype-sanitize` to the plugin pipeline, OR strip raw `<iframe>`/`<script>` tags from text blocks before passing to Markdown:
```tsx
// Quick mitigation — strip orphaned iframe/script tags from text blocks:
const safeContent = block.content
  .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
```

---

### M2 — Indented Closing Fence Prematurely Terminates Code Block

**Confirmed by test 24.**

The fence regex `([\s\S]*?)` is lazy and will match the *earliest* occurrence of three backticks, including indented ones:

```
Input:   ```python\ncode\n  ```\nmore code\n```
Output:  [ code("code"), text("more code\n```") ]
```

The CommonMark spec requires the closing fence to have no more than 3 spaces of indent *and* at least as many backticks as the opening. The regex doesn't enforce either condition. In practice, AI-generated code blocks rarely include indented closing fences, but code examples demonstrating Markdown syntax (meta-documentation) can trigger this.

**Fix:**
```tsx
// Replace lazy interior with explicit non-fence-line matcher:
const fenceRe = /^(`{3,})(\w*)\r?\n([\s\S]*?)\n\1`*[ \t]*$/m;
// Or simpler: require closing ``` to be at start of line
const fenceRe = /```(\w*)\r?\n([\s\S]*?)\n```[ \t]*(?:\r?\n|$)/;
```

---

### M3 — `initHeight = "0"` Silently Maps to 400px

**Lines 340, confirmed by test 25.**

```tsx
const defaultH = initHeight ? Math.max(100, parseInt(initHeight, 10) || 400) : 400;
//                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//  parseInt("0") = 0 → falsy → uses 400.  Then Math.max(100, 400) = 400.
```

The `|| 400` guard was intended to handle `NaN` (non-numeric strings like `"auto"`), but it also incorrectly catches the perfectly valid `height="0"`. Any embed that starts at height 0 (waiting for a postMessage resize) will be initialized at 400px instead of collapsing.

**Fix:**
```tsx
const parsed = parseInt(initHeight ?? "", 10);
const defaultH = Number.isNaN(parsed) ? 400 : Math.max(0, parsed);
// Also consider allowing height=0 for headless embeds before first resize event
```

---

### M4 — Scanner is O(n²) Per Message (Relevant for Long Streaming Messages)

Each iteration of the `while` loop calls `text.slice(pos)` (a string copy) then runs **4 separate regex searches** from the start of the slice. For a 50KB message with 20 special blocks, this means ~20 × (slice + 4 × regex) = up to 80 full-text regex scans. Each scan starts from position 0 of the remaining slice.

For typical AI message lengths (< 10KB) this is imperceptible (test 13: 0ms for 10KB). But as message sizes grow (code-heavy responses with multiple diagrams), the cost accumulates across all re-renders during streaming.

**Improvement:** Use `regex.lastIndex` with sticky (`/y`) or explicit `\G`-equivalent patterns, or a single linear pass with interleaved pattern tracking. Alternatively, cache `parseMessageBlocks` result per message content hash.

---

## Low Priority

### L1 — Unnecessary `/g` Flag on `fenceRe`

**Line 399.**

`fenceRe = /```(\w*)\r?\n([\s\S]*?)```/g` — only one `exec()` call is made per regex instance, and the regex is freshly created each loop iteration (so `lastIndex` always starts at 0). The `/g` flag is harmless but confusing: it implies multiple matches are expected. Drop it.

```tsx
const fenceRe = /```(\w*)\r?\n([\s\S]*?)```/;  // no /g needed
```

---

### L2 — `width` Prop Accepted but Silently Discarded

**Lines 330–380.**

`IframePreviewCard` declares `width?: string` in both the prop interface and the function signature, and it's populated from the parsed block:
```tsx
block: { type: "iframe", ..., width: wM?.[1] }
// ...
<IframePreviewCard ... width={block.width} />
```

But the component always renders `style={{ width: "100%" }}`. The `width` prop is never read. Either use it:
```tsx
style={{ width: block.width ? `${block.width}px` : "100%", height: "100%" }}
```
Or remove it from the `MessageBlock` type, the parser, and the component signature to avoid confusion.

---

### L3 — `pushText` Trims Strips Meaningful Blank Lines

**Line 390.**

```tsx
const pushText = (str: string) => {
  const trimmed = str.trim();
  if (trimmed) blocks.push({ type: "text", content: trimmed });
};
```

Markdown requires a blank line between certain constructs (e.g., a paragraph before a list, or a paragraph before a heading in some renderers). If text like `"para1\n\n# Heading"` is split by a special block and the trailing `\n\n` is trimmed away, the next segment's markdown may parse differently.

In practice, `remark-gfm` is lenient about blank lines, so this is unlikely to cause visible issues. But it could affect edge cases with nested lists or tight/loose list detection.

**Fix:** Use `str.trim()` only for the "is this empty?" check, but preserve the content as-is (or at minimum, normalize to a single leading/trailing newline):
```tsx
const pushText = (str: string) => {
  if (str.trim()) blocks.push({ type: "text", content: str });
};
```

---

### L4 — `as const` on `markdownComponents` — Cosmetic but Confusing

**Line 1827.**

`as const` makes the object's properties readonly. The `Components` type from `react-markdown` expects mutable function values. TypeScript accepts the assignment because a readonly subtype is assignable to a mutable supertype. This compiles without error but is non-idiomatic — `as const` is typically used for literal config objects, not component maps with function values. Consider `satisfies Components` instead (TS 4.9+) for better error messages, or simply remove `as const`.

---

## Positive Observations

1. **Scanner correctness (the core ask):** Images and iframes inside code fences are correctly *not* extracted — the fence match wins because it appears at an earlier index than the `<img>`/`<iframe>` match inside it. Tests 1 and 9 confirm this.

2. **CRLF handling:** The `\r?\n` in `fenceRe` properly handles Windows line endings. Test 5 confirmed.

3. **Ordering:** The 7-block ordering scenario (text → image → text → code → text → mermaid → text) produces exactly the expected sequence. Test 3 confirmed.

4. **Unclosed fence graceful degradation:** Streaming partial content with an unclosed fence falls through cleanly to a text block (fm is null because lazy regex requires a closing fence). No infinite loop or crash. Tests 2 and 12 confirmed.

5. **`MermaidDiagram` memoization:** Wrapping in `React.memo` is correct — it prevents re-renders when chart content hasn't changed, solving the SVG flash issue.

6. **`djb2Hash` for stable mermaid IDs:** Using content-derived IDs for the mermaid `render()` call is much better than `Date.now() + Math.random()`, which caused remount on every re-render.

7. **`isSafeUrl` extended for `/api/`** — allowlisting relative `/api/` paths is a reasonable addition for application-served images.

8. **`allow-same-origin` intentionally absent:** The sandbox lacks `allow-same-origin`, which is correct — allowing same-origin in a sandboxed iframe without `allow-scripts` would be pointless, and with `allow-scripts` it would allow the iframe to escape the sandbox entirely. The current sandbox (`allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox`) is appropriate for third-party embeds.

---

## Recommended Actions (Prioritized)

1. **[H1]** Fix React key collisions — use `block-${i}` for all block types
2. **[H2]** Hoist `markdownComponents` outside the render loop — move to module scope or wrap in `useMemo`
3. **[H3]** Add `ev.origin` validation to the DataWrapper `postMessage` handler
4. **[M1]** Strip orphaned unsafe HTML tags from text blocks before passing to `rehypeRaw`, or add `rehype-sanitize`
5. **[M2]** Fix closing fence regex to require line-start alignment
6. **[M3]** Fix `initHeight = "0"` height calculation using `Number.isNaN`
7. **[L1]** Remove `/g` flag from `fenceRe`
8. **[L2]** Either use `width` prop in `IframePreviewCard` or remove it from the type chain
9. **[L3]** Pass untrimmed content to text blocks (only use `.trim()` for the empty check)

---

## Metrics

| | Value |
|---|---|
| TypeScript errors | 0 (clean) |
| Linting issues | Not run separately |
| Test coverage | 0 automated tests for `parseMessageBlocks` — all verification done ad-hoc |
| Scanner correctness (tested) | 24 test cases, algorithm correct for all core scenarios |
| Collision bugs confirmed | 4 (Tests 4, 15, 16, 20) |

---

## Unresolved Questions

1. Is `rehype-sanitize` on the roadmap, or is `processMessageText` + `isSafeUrl` considered sufficient for the threat model?
2. Should `markdownComponents` eventually be extracted to a shared module given it's recreated per-message?
3. Is the DataWrapper postMessage integration used in production, or is it speculative? If speculative, consider gating it with a feature flag until the origin validation is added.
