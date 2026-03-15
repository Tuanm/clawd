---
title: "ArtifactCard Component Design"
description: "Expandable card UI for displaying artifacts in chat with type-specific rendering, actions, and error handling"
status: pending
priority: P1
effort: 3h
branch: main
tags: [ui, react, artifact, component]
created: 2026-03-15
---

# Phase 03 — ArtifactCard Component

## Context Links

- Plan overview: `plans/260315-artifact-rendering/plan.md`
- Existing card patterns: `packages/ui/src/MessageList.tsx` (ToolResultCard ~L620, HtmlPreview ~L588, IframePreviewCard ~L357)
- Styles: `packages/ui/src/styles.css` (`.message-tool-result-card` ~L1939, `.html-preview` ~L2529, `.subspace-card-*` ~L1814)
- Shared primitives source: `packages/ui/src/MessageList.tsx` (CopyIcon L151, CheckIcon L161, PreBlock L215)

## Overview

- **Priority:** P1
- **Status:** pending
- **Description:** Build `ArtifactCard` — the primary UI element for rendering artifacts inline in chat messages. Expandable card with header (type badge + title), collapsible body delegating to `artifact-renderer.tsx`, action buttons, error boundary, and streaming placeholder.

## Key Insights from Existing Codebase

1. **ToolResultCard pattern** is the closest analog: click-to-expand, role="button", tabIndex=0, Enter/Space keyboard handling. ArtifactCard should mirror this pattern exactly.
2. **CSS variables** use the `hsl(var(--name))` pattern with `--text`, `--bg`, `--bg-center`, `--accent` primitives. Derived vars: `--text-primary`, `--text-secondary`, `--text-muted`, `--accent-color`. Dark mode handled via `@media (prefers-color-scheme: dark)`.
3. **No `ui-primitives.ts` file exists yet** — CopyIcon, CheckIcon, PreBlock are defined and exported from MessageList.tsx. Extraction is needed.
4. **HtmlPreview** currently uses `window.open` with blob URL for fullscreen — spec requires modal overlay instead (security: blob URLs can be abused for phishing).
5. **Modal overlay** pattern exists in styles.css (~L987, `.modal-overlay` class).

## Requirements

### Functional
- Expandable card: collapsed by default, click header to toggle
- Type badge showing artifact type (color-coded)
- Title display (truncated with ellipsis if long)
- Action buttons: Copy, Download, Fullscreen (visible on hover/focus)
- Delegates body rendering to `artifact-renderer.tsx`
- Streaming placeholder state with pulsing skeleton
- Error boundary wrapping the renderer

### Non-functional
- Accessible: keyboard nav, ARIA attributes, screen reader labels
- Responsive: full-width on mobile
- Dark mode via existing `prefers-color-scheme`
- Smooth expand/collapse animation (max-height transition)
- Body max-height 600px with overflow scroll

## Architecture

### Component Tree

```
ArtifactCard (artifact-card.tsx)
  +-- ArtifactCardHeader
  |     +-- TypeBadge (icon + label)
  |     +-- Title (truncated)
  |     +-- ActionButtons (hover/focus visible)
  |           +-- CopyButton (from ui-primitives)
  |           +-- DownloadButton
  |           +-- FullscreenButton
  +-- ArtifactCardBody (collapsible)
  |     +-- ArtifactErrorBoundary
  |           +-- ArtifactRenderer (from artifact-renderer.tsx)
  +-- ArtifactFullscreenModal (conditional)
```

### Component API

```tsx
// packages/ui/src/artifact-card.tsx

interface ArtifactCardProps {
  type: ArtifactType;        // 'html' | 'react' | 'svg' | 'chart' | 'csv' | 'markdown' | 'code'
  title: string;
  content: string;
  isStreaming?: boolean;      // default false
  language?: string;          // for 'code' type (e.g., 'python', 'typescript')
}

type ArtifactType = 'html' | 'react' | 'svg' | 'chart' | 'csv' | 'markdown' | 'code';
```

### Shared Primitives Extraction

**New file:** `packages/ui/src/ui-primitives.ts`

Extract from `MessageList.tsx`:
- `CopyIcon` (L151-158)
- `CheckIcon` (L161-167)
- `PreBlock` (L215-259)

Update `MessageList.tsx` imports to use `ui-primitives.ts`. Both `MessageList` and `ArtifactCard` import from this shared file.

```tsx
// packages/ui/src/ui-primitives.ts
export function CopyIcon() { /* existing SVG */ }
export function CheckIcon() { /* existing SVG */ }
export function PreBlock({ children }: { children: React.ReactNode }) { /* existing impl */ }
```

## Related Code Files

### Files to Create
- `packages/ui/src/artifact-card.tsx` — main ArtifactCard component (~150 lines)
- `packages/ui/src/ui-primitives.ts` — extracted shared icons/components (~120 lines)

### Files to Modify
- `packages/ui/src/MessageList.tsx` — replace CopyIcon/CheckIcon/PreBlock definitions with imports from ui-primitives
- `packages/ui/src/styles.css` — add `.artifact-card-*` styles

### Files Referenced (read-only)
- `packages/ui/src/artifact-renderer.tsx` — renderer to delegate to (from phase-04)

## Implementation Steps

### Step 1: Extract Shared Primitives

1. Create `packages/ui/src/ui-primitives.ts`
2. Move `CopyIcon`, `CheckIcon`, `PreBlock` from MessageList.tsx
3. Add new icons: `DownloadIcon`, `FullscreenIcon`, `ChevronIcon`, `AlertIcon`
4. Update MessageList.tsx to import from ui-primitives
5. Verify build compiles

### Step 2: Build ArtifactCard Component

Create `packages/ui/src/artifact-card.tsx` with these sections:

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

**2b. File Extension Map (for download)**

```tsx
const EXTENSION_MAP: Record<ArtifactType, string> = {
  html: '.html',
  react: '.jsx',
  svg: '.svg',
  chart: '.json',
  csv: '.csv',
  markdown: '.md',
  code: '',  // determined by language prop
};
```

**2c. Main Component Structure**

```tsx
export function ArtifactCard({ type, title, content, isStreaming = false, language }: ArtifactCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  const toggle = () => !isStreaming && setExpanded(prev => !prev);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  const copyContent = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadContent = (e: React.MouseEvent) => {
    e.stopPropagation();
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

  const openFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFullscreen(true);
  };

  const config = TYPE_CONFIG[type];

  return (
    <>
      <div
        className={`artifact-card ${expanded ? 'artifact-card--expanded' : ''} ${isStreaming ? 'artifact-card--streaming' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${config.label} artifact: ${title}`}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="artifact-card-header">
          <span className="artifact-card-badge" style={{ background: config.color }}>
            {config.icon}
          </span>
          <span className="artifact-card-title">{title}</span>
          <div className="artifact-card-actions" onClick={e => e.stopPropagation()}>
            <button onClick={copyContent} aria-label="Copy content" title={copied ? 'Copied!' : 'Copy'}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
            <button onClick={downloadContent} aria-label="Download file" title="Download">
              <DownloadIcon />
            </button>
            <button onClick={openFullscreen} aria-label="Open fullscreen" title="Fullscreen">
              <FullscreenIcon />
            </button>
          </div>
          <span className={`artifact-card-chevron ${expanded ? 'artifact-card-chevron--open' : ''}`}>
            <ChevronIcon />
          </span>
        </div>

        {/* Body */}
        {expanded && (
          <div className="artifact-card-body">
            {isStreaming ? (
              <div className="artifact-card-skeleton" aria-label="Loading artifact">
                <div className="artifact-card-skeleton-line" />
                <div className="artifact-card-skeleton-line artifact-card-skeleton-line--short" />
                <div className="artifact-card-skeleton-line artifact-card-skeleton-line--med" />
              </div>
            ) : (
              <ArtifactErrorBoundary content={content}>
                <ArtifactRenderer type={type} content={content} language={language} />
              </ArtifactErrorBoundary>
            )}
          </div>
        )}
      </div>

      {/* Fullscreen modal */}
      {fullscreen && (
        <ArtifactFullscreenModal
          type={type}
          title={title}
          content={content}
          language={language}
          onClose={() => setFullscreen(false)}
        />
      )}
    </>
  );
}
```

**2d. Error Boundary**

```tsx
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ArtifactErrorBoundary extends React.Component<
  { children: React.ReactNode; content: string },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ArtifactCard] Renderer crashed:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="artifact-card-error">
          <div className="artifact-card-error-msg">
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

**2e. Fullscreen Modal**

```tsx
function ArtifactFullscreenModal({
  type, title, content, language, onClose,
}: {
  type: ArtifactType; title: string; content: string; language?: string; onClose: () => void;
}) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="artifact-fullscreen-overlay" onClick={onClose} role="dialog" aria-label={`${title} fullscreen`}>
      <div className="artifact-fullscreen-content" onClick={e => e.stopPropagation()}>
        <div className="artifact-fullscreen-header">
          <span className="artifact-fullscreen-title">{title}</span>
          <button className="artifact-fullscreen-close" onClick={onClose} aria-label="Close fullscreen">
            X
          </button>
        </div>
        <div className="artifact-fullscreen-body">
          <ArtifactErrorBoundary content={content}>
            <ArtifactRenderer type={type} content={content} language={language} />
          </ArtifactErrorBoundary>
        </div>
      </div>
    </div>
  );
}
```

### Step 3: CSS Styles

Add to `packages/ui/src/styles.css`. Follow existing patterns.

```css
/* ── Artifact Card ──────────────────────────────────────────── */
.artifact-card {
  display: flex;
  flex-direction: column;
  border: 1px solid hsl(var(--text) / 10%);
  border-radius: 8px;
  overflow: hidden;
  margin: 8px 0;
  cursor: pointer;
  user-select: none;
  transition: border-color 0.15s ease;
}
.artifact-card:hover {
  border-color: hsl(var(--text) / 20%);
}
.artifact-card:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}
.artifact-card--streaming {
  opacity: 0.85;
  pointer-events: none;
}

/* Header */
.artifact-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: hsl(var(--text) / 3%);
  border-bottom: 1px solid transparent;
}
.artifact-card--expanded .artifact-card-header {
  border-bottom-color: hsl(var(--text) / 8%);
}

/* Type badge */
.artifact-card-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  color: white;
  flex-shrink: 0;
}

/* Title */
.artifact-card-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

/* Action buttons — visible on hover/focus-within */
.artifact-card-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.artifact-card:hover .artifact-card-actions,
.artifact-card:focus-within .artifact-card-actions {
  opacity: 1;
}
.artifact-card-actions button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
}
.artifact-card-actions button:hover {
  background: hsl(var(--text) / 8%);
  color: var(--text-primary);
}

/* Chevron */
.artifact-card-chevron {
  display: flex;
  transition: transform 0.2s ease;
  color: var(--text-muted);
}
.artifact-card-chevron--open {
  transform: rotate(180deg);
}

/* Body */
.artifact-card-body {
  max-height: 600px;
  overflow: auto;
  padding: 12px;
  animation: artifact-card-expand 0.2s ease;
}
@keyframes artifact-card-expand {
  from { opacity: 0; max-height: 0; }
  to   { opacity: 1; max-height: 600px; }
}

/* Skeleton loading */
.artifact-card-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0;
}
.artifact-card-skeleton-line {
  height: 12px;
  border-radius: 4px;
  background: hsl(var(--text) / 8%);
  animation: artifact-pulse 1.5s ease-in-out infinite;
  width: 100%;
}
.artifact-card-skeleton-line--short { width: 40%; }
.artifact-card-skeleton-line--med   { width: 70%; }
@keyframes artifact-pulse {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 1; }
}

/* Error state */
.artifact-card-error {
  padding: 8px 0;
}
.artifact-card-error-msg {
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

/* Fullscreen modal */
.artifact-fullscreen-overlay {
  position: fixed;
  inset: 0;
  background: hsl(var(--text) / 40%);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
}
.artifact-fullscreen-content {
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
.artifact-fullscreen-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid hsl(var(--text) / 10%);
}
.artifact-fullscreen-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}
.artifact-fullscreen-close {
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
  font-size: 16px;
}
.artifact-fullscreen-close:hover {
  background: hsl(var(--text) / 8%);
  color: var(--text-primary);
}
.artifact-fullscreen-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
}

/* Mobile responsive */
@media (max-width: 640px) {
  .artifact-card-actions { opacity: 1; }
  .artifact-fullscreen-content {
    width: 100vw;
    height: 100vh;
    border-radius: 0;
  }
}
```

### Step 4: Wire Into MessageList

After `ArtifactCard` and `artifact-renderer.tsx` (phase-04) are both ready, add artifact block detection to `parseMessageBlocks()` in MessageList.tsx, and render `<ArtifactCard>` for artifact blocks.

This step depends on phase-02 (artifact detection) completing first.

## Todo List

- [ ] Create `packages/ui/src/ui-primitives.ts` with CopyIcon, CheckIcon, PreBlock + new DownloadIcon, FullscreenIcon, ChevronIcon, AlertIcon
- [ ] Update `MessageList.tsx` to import CopyIcon/CheckIcon/PreBlock from ui-primitives
- [ ] Verify build still compiles after extraction
- [ ] Create `packages/ui/src/artifact-card.tsx` with ArtifactCard component
- [ ] Implement ArtifactErrorBoundary class component
- [ ] Implement ArtifactFullscreenModal with Escape-to-close
- [ ] Add `.artifact-card-*` styles to styles.css
- [ ] Add `.artifact-fullscreen-*` styles to styles.css
- [ ] Add mobile responsive overrides
- [ ] Test keyboard navigation (Tab, Enter, Space, Escape)
- [ ] Test screen reader announcements (role, aria-expanded, aria-label)
- [ ] Test streaming skeleton state
- [ ] Test error boundary with intentionally broken content
- [ ] Test copy/download/fullscreen actions
- [ ] Verify dark mode appearance

## Success Criteria

1. ArtifactCard renders collapsed by default; click/Enter/Space toggles body
2. Type badge displays correct icon and color for each ArtifactType
3. Copy button writes raw content to clipboard; shows check icon for 2s
4. Download produces correctly-named file with correct extension
5. Fullscreen opens modal overlay (not blob URL tab); Escape/click-outside closes
6. Error boundary catches renderer crash; displays error + raw content fallback
7. Streaming state shows pulsing skeleton; card is non-interactive
8. Action buttons visible only on hover/focus (always visible on mobile)
9. Passes keyboard-only navigation test (no mouse required)
10. Dark mode renders correctly via existing CSS variable system

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| `artifact-renderer.tsx` not ready | Body renders nothing | Error boundary shows raw content as fallback; can stub renderer initially |
| CSS variable naming collisions | Broken styles | Prefix all classes with `artifact-card-` / `artifact-fullscreen-` |
| Error boundary doesn't reset on new content | Stale error shown | Add `key={content}` on ErrorBoundary to force remount on content change |
| Download blob URL memory leak | Browser memory | Immediate `revokeObjectURL` after click |
| Fullscreen modal z-index conflict | Overlay hidden | Use z-index 300 (above existing modal-overlay at 200) |

## Security Considerations

- **No blob URL window.open** — fullscreen uses modal overlay to prevent phishing via blob URLs
- **Download uses programmatic anchor click** — no persistent blob URLs
- **iframe sandbox** in artifact-renderer (phase-04 concern, not this phase)
- **Content is copied/downloaded as-is** — no XSS vector since it goes to clipboard/file, not DOM
- **Error boundary prevents renderer crash from breaking entire chat UI**

## Next Steps

- **Depends on:** phase-02 (artifact detection/parsing) for integration into MessageList
- **Depends on:** phase-04 (artifact-renderer.tsx) for body rendering — but can stub with `<PreBlock>` initially
- **Leads to:** phase-05 (chart visualization) which provides a specific renderer
- **Leads to:** phase-06 (file preview) which provides CSV/markdown renderers
