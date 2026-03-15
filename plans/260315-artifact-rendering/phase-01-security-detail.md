---
title: "Security Hardening for Artifact Rendering"
description: "Detailed security spec covering sanitization, CSP, iframe sandboxing, XSS fixes, and transpiler evaluation"
status: complete
priority: P1
effort: 6h
branch: main
tags: [security, xss, csp, sanitization, artifacts]
created: 2026-03-15
---

# Phase 1 + 4 Security Detail: Artifact Rendering Hardening

## 1. DOMPurify + rehype-sanitize Integration

### New Dependency

```bash
npm install rehype-sanitize dompurify @types/dompurify
```

### Sanitize Schema Definition

Create `packages/ui/src/sanitize-schema.ts`:

```ts
import type { Schema } from "hast-util-sanitize";
import { defaultSchema } from "hast-util-sanitize";

/**
 * rehype-sanitize operates on hast (HTML AST), which uses `class` not `className`.
 * This schema extends the default GitHub-flavored allowlist with KaTeX + GFM needs.
 */
export const markdownSanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // KaTeX elements
    "math", "semantics", "mrow", "mi", "mo", "mn", "ms", "mtext",
    "mfrac", "msqrt", "mroot", "msub", "msup", "msubsup", "munder",
    "mover", "munderover", "mtable", "mtr", "mtd", "mspace",
    "annotation",
    // GFM
    "details", "summary",
    // Code
    "pre", "code", "span",
    // Structural
    "div", "section",
    // Tables
    "table", "thead", "tbody", "tr", "th", "td",
    // Inline
    "del", "ins", "kbd", "abbr", "mark", "sup", "sub",
    // Media (controlled)
    "img",
  ],
  attributes: {
    ...defaultSchema.attributes,
    // KaTeX uses class extensively on span/div
    span: [...(defaultSchema.attributes?.span ?? []), "class", "style"],
    div: [...(defaultSchema.attributes?.div ?? []), "class", "style"],
    // Code blocks need class for language-* highlighting
    code: ["class"],
    pre: ["class"],
    // Math elements
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    // Tables
    td: ["align", "colSpan", "rowSpan"],
    th: ["align", "colSpan", "rowSpan"],
    // Images - restricted src
    img: ["src", "alt", "title", "width", "height"],
    // Links
    a: ["href", "title", "target", "rel"],
    // Task list checkboxes
    input: ["type", "checked", "disabled", "class"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https", "data"],
  },
  // Strip style attributes except on KaTeX spans/divs (handled above)
  strip: ["script", "style", "iframe", "object", "embed", "form"],
};
```

### Plugin Order (CRITICAL)

All three Markdown render sites must use this exact order:

```ts
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import { markdownSanitizeSchema } from "./sanitize-schema";

// rehypeRaw FIRST: parses raw HTML in markdown into hast nodes
// rehypeSanitize SECOND: strips disallowed nodes/attributes from hast
// rehypeKatex THIRD: transforms math nodes (safe because sanitize preserved math elements)
const rehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  rehypeKatex,
];
```

### Files to Update

| File | Current | Fix |
|------|---------|-----|
| `MessageList.tsx:1952-1953` | `[rehypeKatex, rehypeRaw]` | `[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema], rehypeKatex]` |
| `MarkdownContent.tsx:17` | `[rehypeKatex, rehypeRaw]` | Same as above |
| `MessageComposer.tsx:481` | `[rehypeKatex, rehypeRaw]` | Same as above |

**Why this order matters:** `rehypeRaw` converts raw HTML strings into hast nodes. If `rehypeKatex` runs before sanitize, an attacker could inject `<span class="katex" style="background:url(javascript:...)">` that KaTeX trusts. Sanitize must sit between raw-parse and any plugin that trusts node attributes.

---

## 2. Blob URL Fix (Critical)

### Current Vulnerability

`MessageList.tsx:591-598` — `openFullView()` opens raw unsanitized HTML in a new tab via blob URL. The blob inherits the app's origin, meaning any JS in the HTML has full access to cookies, localStorage, and can make same-origin requests.

```ts
// VULNERABLE — blob inherits origin, JS executes with app privileges
const blob = new Blob([html], { type: "text/html" });
const url = URL.createObjectURL(blob);
window.open(url, "_blank");
```

### Fix: Sanitized Wrapper with CSP Meta Tag

Replace `openFullView()` in `HtmlPreview` component:

```ts
const openFullView = () => {
  // Wrap user HTML in a document with restrictive CSP via meta tag.
  // The CSP blocks inline scripts, eval, and external resource loading.
  const wrapped = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">
  <style>
    body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; }
    img { max-width: 100%; }
  </style>
</head>
<body>${DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "h1","h2","h3","h4","h5","h6","p","br","hr","div","span",
      "ul","ol","li","dl","dt","dd","table","thead","tbody","tr","th","td",
      "a","img","pre","code","blockquote","em","strong","del","ins",
      "sub","sup","kbd","mark","abbr","details","summary","figure","figcaption",
      "svg","path","rect","circle","line","polyline","polygon","text","g","defs",
      "clipPath","use","symbol","title",
    ],
    ALLOWED_ATTR: [
      "href","src","alt","title","width","height","class","style","id",
      "colspan","rowspan","align","valign","target","rel",
      // SVG attributes
      "viewBox","xmlns","fill","stroke","stroke-width","d","cx","cy","r",
      "x","y","x1","y1","x2","y2","points","transform","opacity",
      "font-size","text-anchor","dominant-baseline",
    ],
    ALLOW_DATA_ATTR: false,
    ADD_TAGS: ["style"],  // Allow <style> blocks for CSS-only artifacts
    FORBID_TAGS: ["script","iframe","object","embed","form","input","textarea","select"],
  })}</body>
</html>`;
  const blob = new Blob([wrapped], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
```

**Key points:**
- `DOMPurify.sanitize()` strips all script content and event handlers (`onclick`, `onerror`, etc.)
- CSP meta tag acts as defense-in-depth: even if DOMPurify misses something, CSP blocks execution
- `default-src 'none'` prevents all resource loading except explicitly allowed types
- `style-src 'unsafe-inline'` needed for CSS-styled artifacts
- `img-src data: blob:` allows inline images only, no external fetch

### Also Fix: srcDoc iframe CSP

The inline `<iframe srcDoc={html}>` at line 608-613 should also get CSP. Add a `csp` attribute:

```tsx
<iframe
  ref={iframeRef}
  className="html-preview-frame"
  srcDoc={html}
  sandbox="allow-scripts"
  csp="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;"
  title="HTML Preview"
/>
```

Note: The `csp` attribute on iframes is Chromium-only (Chrome, Edge). For cross-browser, wrap `html` in an HTML document with CSP meta tag before passing to `srcDoc`, same pattern as the blob fix above.

---

## 3. Author-Gated Artifact Parsing

### Problem

`parseMessageBlocks()` (line 415) parses all messages identically. A human user could type `<artifact type="html">` in chat and trigger artifact rendering, enabling prompt-injection attacks where crafted content is rendered as executable HTML.

### Solution: Pass `isAgent` Flag

**Step 1:** Update the function signature:

```ts
function parseMessageBlocks(text: string, isAgent: boolean): MessageBlock[] {
```

**Step 2:** Gate artifact/HTML-preview block parsing on `isAgent`:

```ts
// Inside the while loop, only attempt artifact regex matching when isAgent is true
if (isAgent) {
  // ... iframe parsing block (lines 443-458)
  // ... future <artifact> tag parsing
}
```

**Step 3:** At call site (line 1927), pass the flag:

```ts
const blocks = parseMessageBlocks(decodedText, isAgentMessage(msg));
```

The `isAgentMessage` function already exists at line 1633:
```ts
const isAgentMessage = (msg: Message) => isAgent(msg.user) || !!msg.agent_id;
```

**Step 4:** For `<img>` blocks from human users, still allow markdown images (`![alt](url)`) but strip raw `<img>` tags:

```ts
// Raw <img> HTML tags: agent-only (human users use markdown image syntax)
if (isAgent) {
  const imgRe = /<img\b([^>]*)\/?>/i;
  // ... existing img parsing
}
// Markdown image syntax: allowed for all users (already safe — no JS execution path)
const mdImgRe = /^[ \t]*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)[ \t]*$/m;
// ... existing markdown image parsing (no change)
```

### Preventing Prompt Injection via Artifact Markers

Add a pre-processing strip for `<artifact>` tags in human messages at the `pushText` level:

```ts
const pushText = (str: string, isAgent: boolean) => {
  let cleaned = str
    .replace(/<iframe\b[\s\S]*?(?:<\/iframe>|\/>)/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "");
  // Strip artifact markers from non-agent messages
  if (!isAgent) {
    cleaned = cleaned.replace(/<\/?artifact\b[^>]*>/gi, "");
  }
  if (cleaned.trim()) blocks.push({ type: "text", content: cleaned });
};
```

---

## 4. CSP Profiles

Define CSP strings as constants in a new file `packages/ui/src/artifact-csp.ts`:

```ts
/**
 * Content Security Policy profiles for sandboxed artifact iframes.
 * Each profile is the tightest policy that still allows the artifact type to function.
 */

/** HTML artifacts: no scripts at all */
export const CSP_HTML = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
].join("; ");

/** React/JSX artifacts: needs eval for Sucrase/Babel transpilation */
export const CSP_REACT = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",  // Required for runtime JSX transpile
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
].join("; ");

/** SVG artifacts: inline styles only, no scripts */
export const CSP_SVG = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  // No script-src — SVG <script> tags are blocked
].join("; ");

/** Map artifact type to CSP profile */
export function getCspForArtifact(type: "html" | "react" | "svg"): string {
  switch (type) {
    case "html": return CSP_HTML;
    case "react": return CSP_REACT;
    case "svg": return CSP_SVG;
    default: return CSP_HTML; // Most restrictive as fallback
  }
}
```

**Usage:** Inject CSP via `<meta>` tag in the srcdoc wrapper document (browser-compatible), not via iframe `csp` attribute (Chromium-only).

---

## 5. iframe Sandbox Attributes

### Per-Artifact-Type Sandbox Values

| Artifact Type | sandbox | Rationale |
|---------------|---------|-----------|
| HTML (static) | `"allow-same-origin"` | No scripts. `allow-same-origin` needed only if CSS references blob URLs. If not needed, use empty string `""` for maximum lockdown. |
| React/JSX | `"allow-scripts"` | Scripts needed for transpile+execute. **Do NOT combine with `allow-same-origin`** — that combination lets the iframe escape sandbox. |
| SVG | `""` (empty) | No scripts, no same-origin. Pure render. |
| External iframe | `"allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"` | Current value at line 407, acceptable for external embeds. |

**Critical rule:** Never use `allow-scripts allow-same-origin` together. That combination allows the iframe to remove its own sandbox attribute via `frameElement.removeAttribute("sandbox")`.

### postMessage Origin Validation

Current code (line 376-381) validates by checking `ev.source === iframeRef.current.contentWindow`. This is correct for srcdoc iframes (origin is `null`). For artifact iframes, enforce stricter:

```ts
useEffect(() => {
  const handleMessage = (ev: MessageEvent) => {
    if (!iframeRef.current) return;
    // Only accept messages from our own iframe
    if (ev.source !== iframeRef.current.contentWindow) return;
    // For srcdoc iframes, origin is "null" (string). Accept only that.
    if (ev.origin !== "null") return;
    // Parse height message
    const data = ev.data;
    if (typeof data === "object" && data?.type === "resize" && typeof data.height === "number") {
      const h = Math.max(100, Math.min(data.height, MAX_IFRAME_HEIGHT));
      setHeight(h);
    }
  };
  window.addEventListener("message", handleMessage);
  return () => window.removeEventListener("message", handleMessage);
}, []);
```

### Height Communication Protocol

Inject a resize observer script into the artifact srcdoc wrapper:

```html
<script>
  // Report document height to parent on load and resize
  const report = () => {
    const h = document.documentElement.scrollHeight;
    parent.postMessage({ type: "resize", height: h }, "*");
  };
  // Use ResizeObserver for dynamic content
  new ResizeObserver(report).observe(document.documentElement);
  // Initial report after load
  window.addEventListener("load", report);
</script>
```

The parent's `handleMessage` validates `ev.source` to ensure only our iframe can set height, preventing cross-frame spoofing.

---

## 6. Pre-existing XSS Vectors

### 6a. McpDialog.tsx SVG Injection (Line 53)

**Vulnerability:** `ServerLogo` renders server-provided `logo` string directly via `dangerouslySetInnerHTML` when it starts with `<`. A malicious MCP server could return:

```
<svg onload="fetch('/api/...', {headers:{'Cookie':document.cookie}})">
```

**Fix:** Sanitize with DOMPurify, restricting to SVG elements only:

```ts
import DOMPurify from "dompurify";

function ServerLogo({ logo, size = 20 }: { logo?: string; size?: number }) {
  if (!logo) return <McpIcon size={size} />;
  if (logo.trimStart().startsWith("<")) {
    const clean = DOMPurify.sanitize(logo, {
      USE_PROFILES: { svg: true, svgFilters: true },
      // Strip all non-SVG content; removes event handlers automatically
      ADD_TAGS: [],
      ADD_ATTR: [],
    });
    return (
      <span
        dangerouslySetInnerHTML={{ __html: clean }}
        style={{ width: size, height: size, display: "inline-flex" }}
      />
    );
  }
  return <img src={logo} alt="" width={size} height={size} style={{ borderRadius: 4, objectFit: "contain" }} />;
}
```

### 6b. MessageComposer.tsx Missing Sanitization

**Vulnerability:** The Markdown preview at line 479-517 uses `rehypeRaw` without `rehypeSanitize`. A user composing a message with embedded HTML gets it rendered unsanitized in their own preview. While self-XSS has lower severity, it is still a vector if the composer content is pre-populated from external data (e.g., templates, URL params, paste events).

**Fix:** Add `rehypeSanitize` to the plugin chain, same as Section 1:

```ts
rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema], rehypeKatex]}
```

### 6c. ProjectsDialog.tsx highlightCode (Line 540-542)

**Assessment:** `Prism.highlight()` returns HTML with syntax tokens. Prism itself escapes `<`, `>`, `&` in the source code before wrapping tokens in `<span>` tags. The fallback at line 24 also escapes manually. **Low risk** — Prism's output is safe by design. However, for defense-in-depth, the `selectedFile.content` comes from API. If the content contained a pre-crafted string that exploits a Prism grammar regex, it could theoretically produce unescaped output.

**Recommendation:** Wrap Prism output in DOMPurify as belt-and-suspenders:

```ts
dangerouslySetInnerHTML={{
  __html: DOMPurify.sanitize(highlightCode(line, selectedFile.language), {
    ALLOWED_TAGS: ["span"],
    ALLOWED_ATTR: ["class"],
  }),
}}
```

### 6d. Mermaid securityLevel (Line 17)

**Current:** `securityLevel: "loose"` — allows click events, HTML labels, and `javascript:` links in diagrams.

**Fix:** Change to `"strict"`:

```ts
mermaid.initialize({
  startOnLoad: false,
  theme: prefersDark ? "dark" : "neutral",
  securityLevel: "strict",  // was "loose" — prevents click handlers + JS URIs in diagrams
  fontFamily: "Lato, sans-serif",
});
```

This disables `click` callbacks and `javascript:` hrefs in flowchart nodes. Impact: agents can no longer make clickable diagram nodes (rarely used, acceptable tradeoff).

### 6e. MermaidDiagram dangerouslySetInnerHTML (Line 321)

**Current:** Renders mermaid SVG output directly. Mermaid's own sanitization with `securityLevel: "strict"` handles this, but as defense-in-depth:

```ts
import DOMPurify from "dompurify";

return (
  <div
    className="mermaid-diagram"
    dangerouslySetInnerHTML={{
      __html: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }),
    }}
  />
);
```

---

## 7. Sucrase vs Babel Evaluation

### Bundle Size

| Library | Minified | Gzipped | Note |
|---------|----------|---------|------|
| Sucrase | ~12 KB | ~4 KB | JSX + TS transforms only |
| @babel/standalone | ~800 KB | ~250 KB | Full compiler with all plugins |

### Feature Comparison

| Feature | Sucrase | Babel |
|---------|---------|-------|
| JSX transform | Yes | Yes |
| TypeScript strip | Yes | Yes |
| Class properties | Yes (via `transforms: ["typescript", "jsx"]`) | Yes |
| Optional chaining | Pass-through (modern browsers handle it) | Yes (polyfill) |
| Decorators | No | Yes (with plugin) |
| Dynamic import | Pass-through | Yes |
| Async generators | Pass-through | Yes |
| Custom plugins | No | Yes |

### Security Implications

Both require `unsafe-eval` in CSP (they generate code strings and execute them). The security difference is attack surface:

- **Sucrase:** ~3,000 lines of transform code. Small surface. No plugin system = no plugin-injection vector.
- **Babel:** ~200,000+ lines. Massive surface. Plugin system could theoretically be exploited if an attacker can influence plugin config (not applicable in our sandboxed iframe, but still more surface).

### Recommendation: **Sucrase**

**Rationale:**
1. **66x smaller** bundle — critical for a chat UI where artifact panels should load instantly
2. **Sufficient features** — our artifacts only need JSX + TS transforms; optional chaining/nullish coalescing work natively in all modern browsers
3. **Smaller attack surface** — less code in the sandbox = fewer potential exploits
4. **Faster transpilation** — Sucrase is 4-20x faster than Babel; noticeable when transpiling on each keystroke during live preview
5. **Same security model** — both need `unsafe-eval`; Sucrase doesn't make this worse

**The only reason to choose Babel:** if artifacts need decorators or pre-ES2020 browser support. Neither applies here.

**Implementation:**

```bash
npm install sucrase
# No need for @babel/standalone
```

In the React artifact sandbox wrapper:

```ts
import { transform } from "sucrase";

function transpileJSX(code: string): string {
  const result = transform(code, {
    transforms: ["typescript", "jsx"],
    jsxRuntime: "automatic",   // Uses React 18 JSX transform
    production: true,
  });
  return result.code;
}
```

---

## Implementation Priority Order

1. **rehype-sanitize schema + plugin order** (all 3 Markdown sites) — highest impact, easiest fix
2. **Blob URL fix** — critical active vulnerability
3. **Mermaid securityLevel: "strict"** — one-line fix, eliminates a class of attacks
4. **McpDialog SVG sanitization** — moderate risk, straightforward
5. **Author-gated artifact parsing** — needed before artifact feature ships
6. **CSP profiles + iframe sandbox** — needed before artifact feature ships
7. **Sucrase integration** — needed for React artifact type

---

## Unresolved Questions

1. **KaTeX style attribute scope:** The sanitize schema allows `style` on `span` and `div` for KaTeX. Should we further restrict to only KaTeX-specific CSS properties (e.g., `width`, `height`, `margin-left`, `vertical-align`)? This would require a custom handler. Tradeoff: complexity vs tighter lockdown.

2. **`allow-same-origin` for HTML artifacts:** If HTML artifacts use blob URLs for inline images (from `<canvas>` or generated content), they need `allow-same-origin` on the sandbox. Need to verify whether any planned artifact types require this.

3. **MessageComposer pre-population:** Is composer content ever injected from external sources (URL params, template systems)? If strictly user-typed, the self-XSS risk is negligible and rehype-sanitize in the composer is nice-to-have rather than critical.

4. **Prism grammar trust:** Has the project pinned a specific Prism version? Grammar bugs that produce unescaped HTML are rare but documented. The DOMPurify wrapper is low-cost insurance.
