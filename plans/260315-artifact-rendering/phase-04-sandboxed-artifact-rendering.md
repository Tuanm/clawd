# Phase 4: Sandboxed Artifact Rendering (P1)

## Context Links
- [artifact-renderer.tsx](./phase-03-artifact-detection-panel.md) — created in Phase 3, has placeholders for html/react/svg
- [MessageList.tsx](../../packages/ui/src/MessageList.tsx) — HtmlPreview (line 588) and IframePreviewCard (line 357) as reference patterns
- [sanitize-config.ts](./phase-01-security-foundation.md) — DOMPurify config from Phase 1

## Overview
- **Priority:** P1
- **Status:** Pending
- **Depends on:** Phase 1 (Security), Phase 3 (Artifact Detection)
- **Description:** Replace placeholder renderers for html, react, and svg artifact types with real sandboxed rendering. HTML/React use isolated iframes; SVG uses DOMPurify-sanitized inline rendering.

## Key Insights
- Existing `HtmlPreview` (line 588) already uses `srcDoc` + `sandbox="allow-scripts"` — this is the pattern to extend
- Existing `IframePreviewCard` (line 357) already handles postMessage resize — reuse this pattern
- React artifacts need Babel standalone (~800KB) to transpile JSX in-browser inside the iframe
- SVG can render inline after DOMPurify sanitization (no iframe needed) — simpler and faster
- Tailwind CSS in sandbox: use CDN play script (`https://cdn.tailwindcss.com`) injected into iframe head

## Requirements

### Functional
- HTML artifacts render in sandboxed iframe with live preview
- React artifacts compile JSX via Babel standalone and render in iframe with React CDN
- SVG artifacts render inline with DOMPurify sanitization
- All iframes auto-resize to content height via postMessage
- Fullscreen button opens artifact in new tab (blob URL)
- Error boundary catches render failures and shows fallback

### Non-Functional
- Babel standalone loaded lazily — only fetched when first React artifact encountered
- Iframe sandbox: `allow-scripts` only (no `allow-same-origin` to prevent parent access)
- Max iframe height: 800px with scroll overflow
- CSP meta tag in all iframe documents

## Architecture

### HTML Artifact Rendering
```
artifact content (HTML string)
  |
  v
DOMPurify.sanitize(content, { WHOLE_DOCUMENT: true, ADD_TAGS: ["style"] })
  |
  v
Wrap in HTML document template with CSP meta tag
  |
  v
<iframe srcDoc={wrapped} sandbox="allow-scripts" />
  |
  postMessage("resize", { height }) ──> parent updates iframe height
```

### React Artifact Rendering
```
artifact content (JSX string)
  |
  v
Inject into iframe HTML template:
  - <script src="react.production.min.js">
  - <script src="react-dom.production.min.js">
  - <script src="babel-standalone.min.js">
  - <script src="tailwindcss CDN">
  - <script type="text/babel">{user JSX}</script>
  - Error handler catches compile/runtime errors
  |
  v
<iframe srcDoc={template} sandbox="allow-scripts" />
```

### SVG Artifact Rendering
```
artifact content (SVG string)
  |
  v
DOMPurify.sanitize(content, { USE_PROFILES: { svg: true, svgFilters: true } })
  |
  v
<div dangerouslySetInnerHTML={sanitized} className="artifact-svg" />
```

## Related Code Files

### Files to Modify
| File | Changes |
|------|---------|
| `packages/ui/src/artifact-renderer.tsx` | Replace html/react/svg placeholders with real renderers |
| `packages/ui/src/styles.css` | Add `.artifact-iframe`, `.artifact-svg`, `.artifact-error` styles |

### Files to Create
| File | Purpose |
|------|---------|
| `packages/ui/src/artifact-sandbox.tsx` | SandboxedIframe component — handles srcDoc, resize, error display |
| `packages/ui/src/artifact-templates.ts` | HTML document templates for html and react artifact iframes |

## Implementation Steps

### Step 1: Create artifact-templates.ts (~80 lines)

```typescript
// packages/ui/src/artifact-templates.ts

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://unpkg.com; style-src 'unsafe-inline' https://cdn.tailwindcss.com; img-src data: https: blob:; font-src https:; connect-src 'none';">`;

const RESIZE_SCRIPT = `
<script>
(function() {
  var lastH = 0;
  function notifyHeight() {
    var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    if (h !== lastH) { lastH = h; parent.postMessage({ type: "artifact-resize", height: h }, "*"); }
  }
  new MutationObserver(notifyHeight).observe(document.body, { childList: true, subtree: true, attributes: true });
  window.addEventListener("load", notifyHeight);
  notifyHeight();
  // Catch errors and forward to parent
  window.onerror = function(msg, src, line, col, err) {
    parent.postMessage({ type: "artifact-error", message: String(msg), line: line }, "*");
  };
})();
</script>`;

export function htmlArtifactTemplate(sanitizedHtml: string): string {
  return `<!DOCTYPE html>
<html><head>
${CSP}
<style>body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }</style>
</head><body>
${sanitizedHtml}
${RESIZE_SCRIPT}
</body></html>`;
}

export function reactArtifactTemplate(jsxCode: string): string {
  return `<!DOCTYPE html>
<html><head>
${CSP}
<script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<style>body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }</style>
</head><body>
<div id="root"></div>
${RESIZE_SCRIPT}
<script type="text/babel" data-type="module">
try {
  ${jsxCode}

  // Auto-detect default export or App component
  const Component = typeof App !== 'undefined' ? App
    : typeof Default !== 'undefined' ? Default
    : null;

  if (Component) {
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Component));
  }
} catch(e) {
  document.getElementById('root').innerHTML = '<pre style="color:red;padding:16px">' + e.message + '</pre>';
  parent.postMessage({ type: "artifact-error", message: e.message }, "*");
}
</script>
</body></html>`;
}
```

### Step 2: Create artifact-sandbox.tsx (~100 lines)

```typescript
// packages/ui/src/artifact-sandbox.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { htmlArtifactTemplate, reactArtifactTemplate } from "./artifact-templates";

const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 300;

interface SandboxedIframeProps {
  type: "html" | "react";
  content: string;
}

export default function SandboxedIframe({ type, content }: SandboxedIframeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [error, setError] = useState<string | null>(null);

  const srcDoc = useMemo(() => {
    if (type === "html") {
      const sanitized = DOMPurify.sanitize(content, {
        WHOLE_DOCUMENT: true,
        ADD_TAGS: ["style", "link"],
        ADD_ATTR: ["target"],
        ALLOW_DATA_ATTR: false,
      });
      return htmlArtifactTemplate(sanitized);
    }
    // React — don't sanitize JSX (it needs script execution)
    // Security comes from iframe sandbox isolation
    return reactArtifactTemplate(content);
  }, [type, content]);

  useEffect(() => {
    const handleMessage = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const data = ev.data;
      if (data?.type === "artifact-resize" && typeof data.height === "number") {
        setHeight(Math.min(Math.max(data.height, 50), MAX_HEIGHT));
      }
      if (data?.type === "artifact-error" && typeof data.message === "string") {
        setError(data.message);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return (
    <div className="artifact-iframe-container">
      {error && (
        <div className="artifact-error-banner">
          Runtime error: {error}
        </div>
      )}
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        title={`${type} artifact preview`}
        style={{ width: "100%", height: `${height}px`, border: "none", display: "block" }}
      />
    </div>
  );
}
```

### Step 3: Update artifact-renderer.tsx

Replace the html, react, and svg cases:

```typescript
import SandboxedIframe from "./artifact-sandbox";
import DOMPurify from "dompurify";

// In the switch statement:

case "html":
  return <SandboxedIframe type="html" content={content} />;

case "react":
  return <SandboxedIframe type="react" content={content} />;

case "svg": {
  const sanitizedSvg = DOMPurify.sanitize(content, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["use"],
  });
  return (
    <div
      className="artifact-renderer-svg"
      dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
    />
  );
}
```

### Step 4: Add CSS styles

```css
/* ── Artifact iframe ───────────────────────────────────────────── */
.artifact-iframe-container {
  position: relative;
  border-radius: 4px;
  overflow: hidden;
  background: #fff;
}

@media (prefers-color-scheme: dark) {
  .artifact-iframe-container {
    background: #1a1a2e;
  }
}

.artifact-error-banner {
  padding: 8px 12px;
  background: #ffeef0;
  color: #b31d28;
  font-size: 12px;
  font-family: monospace;
  border-bottom: 1px solid #fdaeb7;
}

@media (prefers-color-scheme: dark) {
  .artifact-error-banner {
    background: #3d1f28;
    color: #ffa198;
    border-color: #5a2030;
  }
}

.artifact-renderer-svg {
  display: flex;
  justify-content: center;
  padding: 12px;
}

.artifact-renderer-svg svg {
  max-width: 100%;
  height: auto;
}
```

## Todo List

- [ ] Create `artifact-templates.ts` with HTML and React document templates
- [ ] Create `artifact-sandbox.tsx` with SandboxedIframe component
- [ ] Update `artifact-renderer.tsx` — replace html/react/svg placeholders
- [ ] Add postMessage resize handler with MAX_HEIGHT cap
- [ ] Add error forwarding from iframe to parent
- [ ] Add CSP meta tag to all iframe templates
- [ ] Add CSS for iframe container, error banner, SVG renderer
- [ ] Test: HTML artifact renders in sandboxed iframe
- [ ] Test: React artifact compiles JSX and renders component
- [ ] Test: SVG artifact renders inline with sanitized markup
- [ ] Test: Iframe auto-resizes to content height
- [ ] Test: Runtime errors display in error banner
- [ ] Test: Fullscreen button (from ArtifactCard) opens artifact in new tab
- [ ] Test: `<script>` in HTML artifact is stripped by DOMPurify
- [ ] Test: React artifact with Tailwind classes renders correctly
- [ ] Run `bun run build:ui` to verify no compile errors

## Success Criteria
- HTML artifacts render as live previews in sandboxed iframes
- React artifacts compile and render with Babel standalone + React CDN
- SVG artifacts render inline with XSS-safe sanitization
- Iframes auto-resize (up to 800px, then scroll)
- Runtime errors shown as banner above iframe
- No parent page access from iframe (`allow-same-origin` NOT used)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Babel standalone CDN (~800KB) slow to load | Medium | Medium | Only loaded for React artifacts; consider bundling or preloading after first use |
| CDN unavailable offline | Low | High | Add fallback message: "React preview requires internet connection" |
| React artifact code accesses parent via postMessage spam | Low | Low | Only accept `artifact-resize` and `artifact-error` message types; ignore all others |
| CSP blocks legitimate artifact resources (fonts, images) | Medium | Medium | CSP allows `img-src https:` and `font-src https:` — covers most cases |
| DOMPurify strips CSS-in-JS or inline styles needed by HTML artifacts | Medium | Medium | `ADD_TAGS: ["style"]` preserves `<style>` blocks; inline `style` attributes allowed by default |

## Security Considerations
- **Origin isolation:** `sandbox="allow-scripts"` without `allow-same-origin` means iframe gets opaque origin — cannot access parent DOM, cookies, or storage
- **CSP in iframe:** Restricts script sources to specific CDNs; no `connect-src` prevents data exfiltration
- **HTML sanitization:** DOMPurify strips `<script>`, event handlers, `javascript:` URIs before iframe injection
- **React unsanitized by design:** JSX must execute — security comes entirely from iframe sandbox isolation. The artifact code runs in a throwaway opaque-origin context with no access to the parent.
- **SVG sanitization:** DOMPurify with SVG profile strips `<script>`, `onload`, `<foreignObject>` with scripts
- **postMessage validation:** Only accept messages from the specific iframe's contentWindow

## Next Steps
- Phase 5 adds chart rendering (Recharts) inside the artifact framework
- Future enhancement: cache Babel standalone in service worker for faster React artifact loads
- Future enhancement: add `allow-same-origin` opt-in for artifacts that need localStorage (with user confirmation dialog)
