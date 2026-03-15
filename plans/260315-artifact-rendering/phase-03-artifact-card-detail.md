---
title: "Artifact Preview Card & Modal"
description: "Compact preview card in-message + fullscreen modal overlay for artifact viewing, following the existing article-card UX pattern"
status: pending
priority: P1
effort: 3h
branch: main
tags: [ui, react, artifact, component, modal]
created: 2026-03-15
updated: 2026-03-15
---

# Phase 03 -- Artifact Preview Card & Modal

## Context Links

- Plan overview: `plans/260315-artifact-rendering/plan.md`
- **Reference UX pattern:** `packages/ui/src/MessageList.tsx` L2017-2036 (`.message-article-card` -- compact card, click opens detail view)
- **Reference CSS:** `packages/ui/src/styles.css` L1731-1795 (`.message-article-card` -- flex layout, 12px gap/padding, 8px border-radius, hover border highlight)
- Existing modal pattern: `packages/ui/src/styles.css` ~L987 (`.modal-overlay`)
- Shared primitives source: `packages/ui/src/MessageList.tsx` (CopyIcon L151, CheckIcon L161, PreBlock L215)

## Overview

- **Priority:** P1
- **Status:** pending
- **Description:** Build two components: (1) `ArtifactPreviewCard` -- a compact, always-fixed-height card shown inline in chat messages (type badge + title + content thumbnail), and (2) `ArtifactModal` -- a fullscreen overlay that opens on card click to show the rendered artifact at full size with a toolbar. No collapse/expand toggle. Follows the `.message-article-card` pattern already used in the codebase.

## Key Insights from Existing Codebase

1. **`.message-article-card` is the reference pattern:** compact card with `display: flex`, `gap: 12px`, `padding: 12px`, `border-radius: 8px`, `border: 1px solid hsl(var(--text) / 10%)`, hover highlights border with accent. Card has `role="button"`, `tabIndex={0}`, Enter key handler. Click opens a detail view. This is exactly the pattern we replicate.
2. **CSS variables** use `hsl(var(--name))` with `--text`, `--bg`, `--bg-center`, `--accent` primitives. Derived: `--text-primary`, `--text-secondary`, `--text-muted`, `--accent-color`.
3. **No `ui-primitives.ts` exists yet** -- CopyIcon, CheckIcon, PreBlock in MessageList.tsx need extraction.
4. **HtmlPreview** uses `window.open` with blob URL for fullscreen -- must be replaced with modal overlay (security).
5. **Existing `.modal-overlay`** in styles.css (~L987) provides a z-index/overlay precedent.

## Requirements

### Functional
- **Preview card:** always compact (fixed height ~72px), never expands inline
- Type badge/icon + title + brief content thumbnail (type-specific, see below)
- Click opens `ArtifactModal` fullscreen overlay
- Click disabled during streaming; shows "Generating..." spinner + live line count instead
- **Modal:** fullscreen overlay with backdrop blur, renders artifact at full size
- Modal toolbar: type badge, title, copy button, download button, close (X)
- Modal closes on: Escape key, backdrop click, close button
- For sandboxed artifacts (html/react): iframe fills the modal body
- For charts: full-width responsive chart
- For code/csv/markdown: scrollable rendered content
- Error boundary wrapping the renderer in both card thumbnail and modal

### Preview Thumbnails by Type
| Type | Thumbnail Content |
|------|------------------|
| `code` | First 3 lines of code in monospace, dimmed overflow |
| `chart` | Small chart icon or mini placeholder |
| `html` | "Interactive" badge |
| `react` | "Interactive" badge |
| `svg` | Tiny inline SVG preview (sanitized via DOMPurify, max 60px height) |
| `csv` | Row/column count (e.g., "12 rows x 5 cols") |
| `markdown` | First line rendered as plain text |

### Non-functional
- Accessible: `role="button"`, `tabIndex={0}`, Enter key on card; `role="dialog"` + focus trap + Escape on modal
- Responsive: full-width card on mobile; modal goes 100vw/100vh on mobile
- Dark mode via existing `prefers-color-scheme`
- No max-height constraint in modal body (full content visible)

## Architecture

### Component Tree

```
ArtifactPreviewCard (artifact-card.tsx)
  +-- TypeBadge (icon + label)
  +-- CardContent
  |     +-- Title (truncated)
  |     +-- Thumbnail (type-specific preview, see table above)
  +-- StreamingOverlay (conditional: spinner + line count)

ArtifactModal (artifact-modal.tsx)      <-- NEW FILE
  +-- Backdrop (blur, click-to-close)
  +-- ModalContent
        +-- ModalToolbar
        |     +-- TypeBadge
        |     +-- Title
        |     +-- CopyButton
        |     +-- DownloadButton
        |     +-- CloseButton (X)
        +-- ModalBody
              +-- ArtifactErrorBoundary
                    +-- ArtifactRenderer (from artifact-renderer.tsx)
```

### Component API

```tsx
// packages/ui/src/artifact-card.tsx

interface ArtifactPreviewCardProps {
  type: ArtifactType;
  title: string;
  content: string;
  isStreaming?: boolean;      // default false
  lineCount?: number;         // live line count during streaming
  language?: string;          // for 'code' type
}

type ArtifactType = 'html' | 'react' | 'svg' | 'chart' | 'csv' | 'markdown' | 'code';
```

```tsx
// packages/ui/src/artifact-modal.tsx

interface ArtifactModalProps {
  type: ArtifactType;
  title: string;
  content: string;
  language?: string;
  onClose: () => void;
}
```

### Shared Primitives Extraction

**New file:** `packages/ui/src/ui-primitives.ts`

Extract from `MessageList.tsx`:
- `CopyIcon` (L151-158)
- `CheckIcon` (L161-167)
- `PreBlock` (L215-259)

Add new: `DownloadIcon`, `CloseIcon`, `AlertIcon`

No `ChevronIcon` or `FullscreenIcon` needed -- no expand toggle, no separate fullscreen button (card click itself opens modal).

```tsx
// packages/ui/src/ui-primitives.ts
export function CopyIcon() { /* existing SVG */ }
export function CheckIcon() { /* existing SVG */ }
export function PreBlock({ children }: { children: React.ReactNode }) { /* existing impl */ }
export function DownloadIcon() { /* new SVG */ }
export function CloseIcon() { /* new X SVG */ }
export function AlertIcon() { /* new SVG */ }
```

## Related Code Files

### Files to Create
- `packages/ui/src/artifact-card.tsx` -- ArtifactPreviewCard component (~100 lines)
- `packages/ui/src/artifact-modal.tsx` -- ArtifactModal fullscreen overlay (~120 lines)
- `packages/ui/src/ui-primitives.ts` -- extracted shared icons/components (~100 lines)

### Files to Modify
- `packages/ui/src/MessageList.tsx` -- replace CopyIcon/CheckIcon/PreBlock defs with imports from ui-primitives; render `<ArtifactPreviewCard>` for artifact blocks
- `packages/ui/src/styles.css` -- add `.artifact-preview-card-*` and `.artifact-modal-*` styles

### Files Referenced (read-only)
- `packages/ui/src/artifact-renderer.tsx` -- renderer to delegate to (from phase-04)

## Implementation Steps

### Step 1: Extract Shared Primitives

1. Create `packages/ui/src/ui-primitives.ts`
2. Move `CopyIcon`, `CheckIcon`, `PreBlock` from MessageList.tsx
3. Add new icons: `DownloadIcon`, `CloseIcon`, `AlertIcon`
4. Update MessageList.tsx to import from ui-primitives
5. Verify build compiles

### Step 2: Build ArtifactPreviewCard

Create `packages/ui/src/artifact-card.tsx`:

**2a. Type Badge Map**

```tsx
const TYPE_CONFIG: Record<ArtifactType, { label: string; icon: string; color: string }> = {
  html:     { label: 'HTML',     icon: '</>',  color: 'hsl(15 80% 55%)' },
  react:    { label: 'React',    icon: 'R',    color: 'hsl(200 80% 55%)' },
  svg:      { label: 'SVG',      icon: 'S',    color: 'hsl(45 80% 50%)' },
  chart:    { label: 'Chart',    icon: 'C',    color: 'hsl(160 60% 45%)' },
  csv:      { label: 'CSV',      icon: 'T',    color: 'hsl(280 50% 55%)' },
  markdown: { label: 'Markdown', icon: 'M',    color: 'hsl(220 15% 50%)' },
  code:     { label: 'Code',     icon: '#',    color: 'hsl(35 80% 50%)' },
};
```

**2b. Thumbnail Generator**

```tsx
function ArtifactThumbnail({ type, content, language }: { type: ArtifactType; content: string; language?: string }) {
  switch (type) {
    case 'code':
      return (
        <pre className="artifact-preview-code">
          <code>{content.split('\n').slice(0, 3).join('\n')}</code>
        </pre>
      );
    case 'chart':
      return <span className="artifact-preview-meta">Chart</span>;
    case 'html':
    case 'react':
      return <span className="artifact-preview-badge-interactive">Interactive</span>;
    case 'svg':
      // Sanitized via DOMPurify before rendering (Phase 1 dependency)
      return (
        <div
          className="artifact-preview-svg"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content, { USE_PROFILES: { svg: true } }) }}
        />
      );
    case 'csv': {
      const lines = content.trim().split('\n');
      const cols = (lines[0] || '').split(',').length;
      return <span className="artifact-preview-meta">{lines.length} rows x {cols} cols</span>;
    }
    case 'markdown':
      return <span className="artifact-preview-meta">{content.split('\n')[0]}</span>;
    default:
      return null;
  }
}
```

**2c. Main Preview Card**

```tsx
export function ArtifactPreviewCard({
  type, title, content, isStreaming = false, lineCount, language,
}: ArtifactPreviewCardProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const config = TYPE_CONFIG[type];

  const handleClick = () => {
    if (!isStreaming) setModalOpen(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <>
      <div
        className={`artifact-preview-card ${isStreaming ? 'artifact-preview-card--streaming' : ''}`}
        role="button"
        tabIndex={isStreaming ? -1 : 0}
        aria-label={`${config.label} artifact: ${title}. ${isStreaming ? 'Generating...' : 'Click to open'}`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {/* Type badge (thumbnail area, mirrors .article-card-thumbnail position) */}
        <div className="artifact-preview-badge" style={{ background: config.color }}>
          {config.icon}
        </div>

        {/* Content area (mirrors .article-card-content) */}
        <div className="artifact-preview-content">
          <div className="artifact-preview-title">{title}</div>
          {isStreaming ? (
            <div className="artifact-preview-streaming">
              <div className="loading-spinner" />
              <span>Generating...{lineCount != null ? ` (${lineCount} lines)` : ''}</span>
            </div>
          ) : (
            <div className="artifact-preview-thumbnail">
              <ArtifactThumbnail type={type} content={content} language={language} />
            </div>
          )}
        </div>
      </div>

      {modalOpen && (
        <ArtifactModal
          type={type}
          title={title}
          content={content}
          language={language}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}
```

### Step 3: Build ArtifactModal

Create `packages/ui/src/artifact-modal.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { CopyIcon, CheckIcon, DownloadIcon, CloseIcon, AlertIcon, PreBlock } from './ui-primitives';

export function ArtifactModal({ type, title, content, language, onClose }: ArtifactModalProps) {
  const [copied, setCopied] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Focus trap: focus modal on mount
  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  // Prevent body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const config = TYPE_CONFIG[type];

  const copyContent = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadContent = () => {
    const ext = type === 'code' && language
      ? `.${language === 'typescript' ? 'ts' : language === 'python' ? 'py' : language}`
      : EXTENSION_MAP[type];
    const filename = `${title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}${ext}`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="artifact-modal-overlay" onClick={onClose} role="dialog" aria-label={`${title} artifact`}>
      <div
        className="artifact-modal-content"
        onClick={e => e.stopPropagation()}
        ref={modalRef}
        tabIndex={-1}
      >
        {/* Toolbar */}
        <div className="artifact-modal-toolbar">
          <span className="artifact-modal-badge" style={{ background: config.color }}>
            {config.icon}
          </span>
          <span className="artifact-modal-title">{title}</span>
          <div className="artifact-modal-actions">
            <button onClick={copyContent} aria-label="Copy content" title={copied ? 'Copied!' : 'Copy'}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
            <button onClick={downloadContent} aria-label="Download file" title="Download">
              <DownloadIcon />
            </button>
            <button onClick={onClose} aria-label="Close" title="Close" className="artifact-modal-close">
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Body -- no max-height constraint, scrolls naturally */}
        <div className="artifact-modal-body">
          <ArtifactErrorBoundary content={content}>
            <ArtifactRenderer type={type} content={content} language={language} />
          </ArtifactErrorBoundary>
        </div>
      </div>
    </div>
  );
}
```

**Error Boundary** (shared between card thumbnail fallback and modal):

```tsx
class ArtifactErrorBoundary extends React.Component<
  { children: React.ReactNode; content: string },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Artifact] Renderer crashed:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="artifact-error">
          <div className="artifact-error-msg">
            <AlertIcon /> Render failed: {this.state.error?.message ?? 'Unknown error'}
          </div>
          <PreBlock>
            <code>{this.props.content}</code>
          </PreBlock>
        </div>
      );
    }
    return this.props.children;
  }
}
```

### Step 4: CSS Styles

Add to `packages/ui/src/styles.css`. Follows `.message-article-card` pattern.

```css
/* -- Artifact Preview Card (mirrors .message-article-card) ---------- */
.artifact-preview-card {
  display: flex;
  gap: 12px;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid hsl(var(--text) / 10%);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  user-select: none;
}
.artifact-preview-card:hover {
  border-color: hsl(var(--accent) / 30%);
}
.artifact-preview-card:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}
.artifact-preview-card--streaming {
  opacity: 0.7;
  cursor: default;
}

/* Badge (type icon, replaces thumbnail position) */
.artifact-preview-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 700;
  color: white;
  flex-shrink: 0;
}

/* Content area */
.artifact-preview-content {
  flex: 1;
  min-width: 0;
}
.artifact-preview-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
}

/* Thumbnail variants */
.artifact-preview-thumbnail {
  font-size: 12px;
  color: var(--text-muted);
  max-height: 48px;
  overflow: hidden;
}
.artifact-preview-code {
  margin: 0;
  font-family: Monaco, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-secondary);
  white-space: pre;
  overflow: hidden;
  max-height: 44px;
}
.artifact-preview-meta {
  font-size: 12px;
  color: var(--text-muted);
}
.artifact-preview-badge-interactive {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  background: hsl(var(--accent) / 12%);
  color: var(--accent-color);
}
.artifact-preview-svg {
  max-height: 60px;
  overflow: hidden;
}
.artifact-preview-svg svg {
  max-height: 60px;
  width: auto;
}

/* Streaming state */
.artifact-preview-streaming {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}
.artifact-preview-streaming .loading-spinner {
  width: 14px;
  height: 14px;
}

/* -- Artifact Modal (fullscreen overlay) ---------------------------- */
.artifact-modal-overlay {
  position: fixed;
  inset: 0;
  background: hsl(var(--text) / 40%);
  backdrop-filter: blur(4px);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
}
.artifact-modal-content {
  width: 90vw;
  max-width: 1200px;
  height: 85vh;
  background: hsl(var(--bg-center));
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px hsl(var(--text) / 20%);
}
.artifact-modal-content:focus {
  outline: none;
}

/* Toolbar */
.artifact-modal-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid hsl(var(--text) / 10%);
  flex-shrink: 0;
}
.artifact-modal-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 700;
  color: white;
  flex-shrink: 0;
}
.artifact-modal-title {
  flex: 1;
  min-width: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.artifact-modal-actions {
  display: flex;
  gap: 4px;
}
.artifact-modal-actions button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
}
.artifact-modal-actions button:hover {
  background: hsl(var(--text) / 8%);
  color: var(--text-primary);
}
.artifact-modal-close {
  margin-left: 4px;
}

/* Body -- no max-height, scrolls naturally */
.artifact-modal-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
}

/* Sandboxed artifacts fill modal body */
.artifact-modal-body iframe {
  width: 100%;
  height: 100%;
  border: none;
  min-height: 400px;
}

/* Error state (shared) */
.artifact-error {
  padding: 8px 0;
}
.artifact-error-msg {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  margin-bottom: 8px;
  border-radius: 4px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: hsl(0 65% 50%);
  font-size: 13px;
}

/* Mobile */
@media (max-width: 640px) {
  .artifact-modal-content {
    width: 100vw;
    height: 100vh;
    border-radius: 0;
  }
}
```

### Step 5: Wire Into MessageList

After `ArtifactPreviewCard` and `artifact-renderer.tsx` (phase-04) are both ready, add artifact block detection to `parseMessageBlocks()` in MessageList.tsx, and render `<ArtifactPreviewCard>` for artifact blocks.

This step depends on phase-02 (artifact detection) completing first.

## Todo List

- [ ] Create `packages/ui/src/ui-primitives.ts` with CopyIcon, CheckIcon, PreBlock + new DownloadIcon, CloseIcon, AlertIcon
- [ ] Update `MessageList.tsx` to import CopyIcon/CheckIcon/PreBlock from ui-primitives
- [ ] Verify build compiles after extraction
- [ ] Create `packages/ui/src/artifact-card.tsx` with ArtifactPreviewCard + ArtifactThumbnail
- [ ] Create `packages/ui/src/artifact-modal.tsx` with ArtifactModal + ArtifactErrorBoundary
- [ ] Add `.artifact-preview-card-*` styles to styles.css (follow `.message-article-card` pattern)
- [ ] Add `.artifact-modal-*` styles to styles.css (overlay + toolbar + body)
- [ ] Add mobile responsive overrides
- [ ] Test: card click opens modal; modal Escape/backdrop-click closes
- [ ] Test: keyboard navigation (Tab to card, Enter opens modal, Escape closes)
- [ ] Test: screen reader announces role="button" on card, role="dialog" on modal
- [ ] Test: streaming state shows spinner + line count, card click disabled
- [ ] Test: error boundary in modal with intentionally broken content
- [ ] Test: copy/download actions in modal toolbar
- [ ] Test: SVG thumbnail renders sanitized, max 60px
- [ ] Test: code thumbnail shows first 3 lines only
- [ ] Verify dark mode appearance

## Success Criteria

1. Preview card is always compact (~72px height) -- no expand/collapse toggle
2. Card shows type badge + title + type-specific thumbnail
3. Click on card opens fullscreen modal overlay (not blob URL, not inline expansion)
4. Modal has toolbar with type badge, title, copy, download, close buttons
5. Modal body renders artifact at full size via ArtifactRenderer (no max-height)
6. For html/react: iframe fills modal body; for code/csv/markdown: scrollable content
7. Modal closes on Escape, backdrop click, or close button
8. Error boundary catches renderer crash; shows error + raw content fallback
9. Streaming: card shows "Generating..." spinner + live line count; click disabled
10. Copy writes raw content to clipboard; download produces correctly-named file
11. Dark mode works via existing CSS variable system
12. Mobile: modal goes full-viewport (100vw x 100vh, no border-radius)

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| `artifact-renderer.tsx` not ready | Modal body renders nothing | Error boundary shows raw content fallback; can stub renderer initially |
| CSS naming collisions | Broken styles | Prefix: `.artifact-preview-*` for card, `.artifact-modal-*` for modal |
| Error boundary doesn't reset on new content | Stale error shown | Add `key={content}` on ErrorBoundary to force remount |
| Download blob URL memory leak | Browser memory | Immediate `revokeObjectURL` after click |
| Modal z-index conflict | Overlay hidden | z-index 300 (above existing modal-overlay at 200) |
| SVG thumbnail XSS | Security | DOMPurify.sanitize with SVG profile before dangerouslySetInnerHTML |
| Body scroll while modal open | UX | Set `document.body.style.overflow = 'hidden'` on mount, restore on unmount |
| Focus escapes modal | Accessibility | Focus modal container on mount; Escape listener on document |

## Security Considerations

- **No blob URL window.open** -- fullscreen uses modal overlay, no phishing via blob URLs
- **SVG thumbnail sanitized** via DOMPurify with `USE_PROFILES: { svg: true }` before `dangerouslySetInnerHTML`
- **Download uses programmatic anchor click** -- no persistent blob URLs
- **iframe sandbox** in artifact-renderer (phase-04 concern, not this phase)
- **Content copied/downloaded as-is** -- no XSS since it goes to clipboard/file, not DOM
- **Error boundary prevents renderer crash from breaking entire chat UI**

## Next Steps

- **Depends on:** phase-02 (artifact detection/parsing) for integration into MessageList
- **Depends on:** phase-04 (artifact-renderer.tsx) for modal body rendering -- can stub with `<PreBlock>` initially
- **Leads to:** phase-05 (chart visualization) which provides chart renderer for modal body
- **Leads to:** phase-06 (file preview) which provides CSV/markdown renderers for modal body
