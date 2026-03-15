# Phase 7: Performance Optimization (P3)

## Context Links
- [MessageList.tsx](../../packages/ui/src/MessageList.tsx) — 2244 lines, renders all messages in DOM
- [App.tsx](../../packages/ui/src/App.tsx) — WebSocket streaming, state management
- [vite.config.ts](../../packages/ui/vite.config.ts) — build config

## Overview
- **Priority:** P3
- **Status:** Complete
- **Depends on:** All previous phases
- **Description:** Lazy-load heavy artifact renderers, add virtual scrolling for long conversations, and debounce rendering during streaming to reduce jank.

## Key Insights
- MessageList renders ALL messages in the DOM — 500+ messages with artifacts will be slow
- Mermaid, Recharts, and Babel are heavy — should only initialize when visible
- During streaming, every token triggers re-render of the streaming message's blocks — debouncing needed
- `MARKDOWN_COMPONENTS` is already a module-level constant (good) — no re-creation per render
- React 18's `startTransition` can defer non-urgent artifact renders during streaming
- MessageList already has `hasMoreOlder`/`hasMoreNewer` pagination — virtual scrolling can integrate with this

## Requirements

### Functional
- Mermaid diagrams, charts, and sandboxed iframes lazy-load when scrolled into view
- Long conversations (500+ messages) scroll smoothly
- Streaming messages render incrementally without blocking UI

### Non-Functional
- Time to interactive < 2s for conversations with 100+ messages
- Scroll FPS > 30fps during fast scrolling through 500+ messages
- Streaming token rendering latency < 50ms per token batch
- Bundle size: heavy components (Mermaid, Recharts) in separate chunks

## Architecture

### Lazy Loading Strategy
```
Message enters viewport (IntersectionObserver)
  |
  v
Light placeholder shown immediately
  |
  v
IntersectionObserver fires (threshold: 0.1)
  |
  v
React.lazy loads the heavy component
  |
  v
Suspense fallback → actual render
```

### Virtual Scrolling Decision

**Recommendation: Do NOT add react-virtuoso yet.**

Rationale:
- MessageList has variable-height messages (text, code blocks, mermaid, artifacts, images)
- Virtual scrolling with variable heights is notoriously buggy — scroll jumping, incorrect height estimation
- The existing pagination system (`hasMoreOlder`/`hasMoreNewer` with `loadOlder`/`loadNewer`) already limits DOM nodes
- Better approach: reduce DOM weight per message + lazy-load heavy content

If profiling shows pagination alone is insufficient, virtual scrolling can be added later as a dedicated effort.

### Streaming Optimization
```
agent_token WebSocket event (every ~50ms)
  |
  v
Buffer tokens in requestAnimationFrame batch
  |
  v
Flush batch → update message state → trigger render
  |
  v
React.startTransition for non-streaming message re-renders
```

## Related Code Files

### Files to Modify
| File | Changes |
|------|---------|
| `packages/ui/src/MessageList.tsx` | Wrap MermaidDiagram in lazy viewport observer; debounce block re-parsing during streaming |
| `packages/ui/src/artifact-renderer.tsx` | Already uses React.lazy for ChartRenderer (Phase 5); add viewport-gated loading |
| `packages/ui/src/App.tsx` | Buffer streaming tokens with rAF batching |
| `packages/ui/vite.config.ts` | Configure manual chunks for Mermaid and Recharts |

### Files to Create
| File | Purpose |
|------|---------|
| `packages/ui/src/lazy-viewport.tsx` | LazyViewport wrapper — renders children only when in viewport |

## Implementation Steps

### Step 1: Create lazy-viewport.tsx (~50 lines)

Generic wrapper that renders a placeholder until the element enters the viewport.

```typescript
// packages/ui/src/lazy-viewport.tsx
import React, { useEffect, useRef, useState } from "react";

interface LazyViewportProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  height?: number;  // estimated height for placeholder
  rootMargin?: string;
}

export default function LazyViewport({
  children,
  fallback,
  height = 100,
  rootMargin = "200px",
}: LazyViewportProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();  // once visible, stay rendered
        }
      },
      { rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin]);

  if (!visible) {
    return (
      <div ref={ref} style={{ minHeight: height }}>
        {fallback ?? <div className="lazy-viewport-placeholder" style={{ height }} />}
      </div>
    );
  }

  return <div ref={ref}>{children}</div>;
}
```

### Step 2: Wrap heavy components in LazyViewport

In MessageList.tsx, wrap MermaidDiagram renders:

```typescript
// Before (~line 1972-1975):
case "mermaid":
  return (
    <div key={`block-${i}`} className="message-block message-mermaid-card">
      <MermaidDiagram chart={block.content} />
    </div>
  );

// After:
case "mermaid":
  return (
    <div key={`block-${i}`} className="message-block message-mermaid-card">
      <LazyViewport height={200} fallback={<div className="mermaid-placeholder">Loading diagram...</div>}>
        <MermaidDiagram chart={block.content} />
      </LazyViewport>
    </div>
  );
```

Similarly for artifact cards containing heavy content:

```typescript
case "artifact":
  return (
    <div key={`block-${i}`} className="message-block">
      <LazyViewport height={60}>
        <ArtifactCard ... />
      </LazyViewport>
    </div>
  );
```

ArtifactCard is already collapsed by default (Phase 3), so the lazy wrapper primarily benefits the initial card header rendering in long conversations.

### Step 3: Vite manual chunks for code splitting

Update `vite.config.ts`:

```typescript
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          mermaid: ["mermaid"],
          recharts: ["recharts"],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3456",
      "/ws": { target: "ws://localhost:3456", ws: true },
    },
  },
});
```

This separates Mermaid (~300KB) and Recharts (~50KB) into their own chunks, loaded on demand.

### Step 4: Buffer streaming tokens with rAF batching

In App.tsx, find the `agent_token` WebSocket handler. Currently each token likely triggers a state update. Add batching:

```typescript
// Add near WebSocket handler setup:
const tokenBufferRef = useRef<Map<string, string>>(new Map());
const rafIdRef = useRef<number>(0);

function flushTokenBuffer() {
  const buffer = tokenBufferRef.current;
  if (buffer.size === 0) return;
  // Apply all buffered tokens in a single state update
  const updates = new Map(buffer);
  buffer.clear();
  // Batch update streaming state
  setStreamingMessages((prev) => {
    const next = { ...prev };
    for (const [agentId, tokens] of updates) {
      next[agentId] = (next[agentId] || "") + tokens;
    }
    return next;
  });
}

// In the agent_token handler:
case "agent_token": {
  const { agent_id, token } = data;
  const buf = tokenBufferRef.current;
  buf.set(agent_id, (buf.get(agent_id) || "") + token);
  // Schedule flush on next animation frame (coalesces rapid tokens)
  if (!rafIdRef.current) {
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = 0;
      flushTokenBuffer();
    });
  }
  break;
}
```

**Note:** This is a pattern recommendation. The actual implementation depends on the current state shape in App.tsx. Read the actual WebSocket handler before implementing.

### Step 5: Debounce block re-parsing for streaming messages

In MessageList.tsx, `parseMessageBlocks` runs on every render for every visible message. For the actively streaming message, this re-runs on every token batch. Memoize:

```typescript
// Add useMemo for block parsing (already in the render function):
// The key insight: parseMessageBlocks is pure — same input = same output.
// React will skip re-computation if decodedText hasn't changed.
const blocks = useMemo(() => parseMessageBlocks(decodedText), [decodedText]);
```

This is already effectively what happens since `decodedText` changes with each token batch. But we can additionally skip re-parsing during streaming by using a coarser memo key:

```typescript
// For streaming messages, only re-parse every 500 chars of new content
const blocksMemoKey = msg.is_streaming
  ? `${msg.ts}-${Math.floor(decodedText.length / 500)}`
  : `${msg.ts}-${decodedText.length}`;

const blocks = useMemo(() => parseMessageBlocks(decodedText), [blocksMemoKey]);
```

This reduces parse frequency from every-token to every-500-chars during streaming, while still updating immediately for non-streaming messages.

### Step 6: Add placeholder CSS

```css
/* ── Lazy viewport ─────────────────────────────────────────────── */
.lazy-viewport-placeholder {
  background: var(--card-header-bg, #f6f8fa);
  border-radius: 6px;
  animation: lazy-pulse 1.5s ease-in-out infinite;
}

@keyframes lazy-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.7; }
}

.mermaid-placeholder {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary, #586069);
  font-style: italic;
}
```

## Todo List

- [x] Create `lazy-viewport.tsx` with IntersectionObserver wrapper
- [x] Wrap MermaidDiagram in LazyViewport in MessageList.tsx
- [x] Wrap ArtifactCard in LazyViewport in MessageList.tsx
- [ ] Add rAF token batching to App.tsx WebSocket handler (skipped — App.tsx already accumulates to ref, not state; per-token re-renders are not happening)
- [x] Add coarse memoization for block parsing during streaming (blockParseCacheRef in MessageList.tsx)
- [x] Configure Vite manual chunks for mermaid and recharts
- [x] Add lazy placeholder CSS with pulse animation
- [x] Test: Mermaid diagrams load when scrolled into view (not on page load)
- [ ] Test: Scroll through 200+ messages at > 30fps (manual test required)
- [ ] Test: Streaming renders without visible jank (manual test required)
- [x] Test: Build produces separate mermaid/recharts chunks (confirmed in build output)
- [x] Run `bun run build` — recharts=140KB, mermaid=540KB as separate chunks

## Success Criteria
- Mermaid and charts only load when scrolled into view
- Vite build output shows separate chunks for mermaid (~300KB) and recharts (~50KB)
- Streaming messages update smoothly without freezing UI
- No rendering regressions from lazy loading
- Conversation with 200+ messages scrolls without jank

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| IntersectionObserver not supported in target browsers | Very Low | High | IO is supported in all modern browsers (98%+ coverage). Fallback: render immediately if IO unavailable. |
| LazyViewport causes content shift when placeholder replaced | Medium | Low | Set accurate `height` estimate; placeholder has same height as typical content |
| rAF batching introduces visible token delay | Low | Medium | rAF runs every ~16ms — imperceptible to users vs current per-token rendering |
| Coarse block memo key causes stale rendering | Low | Medium | Only affects streaming messages; non-streaming messages always get exact memo key |
| Manual chunks break dynamic import paths | Low | Medium | Test build output; Vite handles this well with default config |

## Security Considerations
- No security implications — all changes are rendering performance optimizations
- LazyViewport does not alter sanitization or sandboxing behavior

## Next Steps
- If scroll performance is still insufficient after these optimizations, consider:
  - React-window or react-virtuoso with measured variable heights (complex but effective)
  - Web Worker for parseMessageBlocks (offload regex from main thread)
  - Service Worker caching for Babel standalone CDN
- Profile with Chrome DevTools Performance tab to identify remaining bottlenecks
