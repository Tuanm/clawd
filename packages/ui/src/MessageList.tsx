import DOMPurify from "dompurify";
import mermaid from "mermaid";
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { authFetch } from "./auth-fetch";
import "katex/dist/katex.min.css";
import { ArtifactPreviewCard, type ArtifactType, StreamingArtifactCard } from "./artifact-card";
import { FilePreviewCard, isPreviewableFile } from "./file-preview";
import LazyViewport from "./lazy-viewport";
import { highlightCode } from "./prism-setup";
import { markdownSanitizeSchema } from "./sanitize-schema";
import { UnreadSeparator } from "./UnreadSeparator";
import { CheckIcon, CopyIcon, PreBlock } from "./ui-primitives";

// Lazy-load ChartRenderer (Recharts) for inline chart rendering in messages
const LazyChartRenderer = React.lazy(() => import("./chart-renderer"));

// Initialize mermaid with dark-aware theme
const prefersDark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({
  startOnLoad: false,
  theme: prefersDark ? "dark" : "neutral",
  securityLevel: "strict",
  fontFamily: "Lato, sans-serif",
});

interface Message {
  ts: string;
  user: string;
  text: string;
  subtype?: string;
  html_preview?: string;
  code_preview?: {
    filename: string;
    language: string;
    content: string;
    start_line?: number;
    highlight_lines?: number[];
  };
  files?: { id: string; name: string; url_private: string; mimetype?: string }[];
  reactions?: { name: string; count: number }[];
  // Multi-agent support fields
  agent_id?: string;
  avatar_color?: string;
  is_sleeping?: boolean;
  is_streaming?: boolean;
  thinking_text?: string; // Streamed thinking tokens (separate from content)
  mentions_json?: string;
  seen_by?: { agent_id: string; avatar_color: string; is_sleeping?: boolean }[];
  // Article attachment
  article?: {
    id: string;
    title: string;
    description: string;
    author: string;
    thumbnail_url: string;
  };
  // Sub-space attachment
  subspace?: {
    id: string;
    title: string;
    description?: string;
    agent_id: string;
    agent_color: string;
    status: "active" | "completed" | "failed" | "timed_out";
    channel: string;
  };
  workspace?: {
    workspace_id: string;
    title: string;
    description?: string;
    status: "running" | "waiting" | "completed";
  };
  tool_result?: {
    tool_name: string;
    description: string;
    status: "running" | "succeeded" | "failed";
    args: Record<string, any>;
    result?: any;
    error?: string;
    job_id?: string;
  };
}

// Pending message type
interface PendingMessage {
  id: string;
  text: string;
  files?: File[];
  status: "sending" | "sent" | "failed";
  error?: string;
}

// Import streaming types from App
import type { StreamEntry, StreamingAgentInfo } from "./App";

interface Props {
  messages: Message[];
  pendingMessages?: PendingMessage[];
  agentLastSeenTs: string | null;
  userLastSeenTs: string | null;
  channel: string;
  agentSleeping?: boolean;
  streamingAgentIds?: string[];
  hasMoreOlder?: boolean;
  hasMoreNewer?: boolean;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  isAtLatest?: boolean;
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
  onJumpToMessage?: (ts: string) => Promise<boolean>;
  onJumpToLatest?: () => void;
  onRetryMessage?: (msg: PendingMessage) => void;
  onMarkSeen?: (ts: string) => void;
  channelKey?: string; // Trigger scroll to bottom when this changes
  jumpToMessageTs?: string | null; // Scroll to this message timestamp
  onJumpComplete?: () => void; // Called after jumping to a message
  onScrollAtBottomChange?: (atBottom: boolean) => void; // Notifies parent when scroll position changes relative to bottom
  hasActiveChannelUnread?: boolean; // Whether the active channel has unread messages (for scroll button red dot)
  // Sidebar integration — open rich content in the sidebar panel
  onOpenSidebar?: (content: import("./SidebarPanel").SidebarPanelContent) => void;
}

// Link icon component (for message reference)
function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

// Share icon component
function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}

// Edit icon for retrying failed messages
function EditIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

// Re-export for backward compat (ArticlePage imports CopyIcon from here)
export { CheckIcon, CopyIcon } from "./ui-primitives";

// Arrow down icon
function ArrowDownIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// Chevron down icon (for tool call expand/collapse)
function ChevronDownIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// Chevron up icon (for tool call expand/collapse)
function ChevronUpIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

// PreBlock imported from ui-primitives and re-exported for backward compat
export { PreBlock };

// Mermaid diagram component — memoized to avoid re-rendering when chart content unchanged.
// Keeps the previous SVG visible while a new render is in progress (prevents flash).
// Uses per-instance render ID (useId) so two identical diagrams never stomp each other's DOM.
export const MermaidDiagram = React.memo(function MermaidDiagram({
  chart,
  onZoom,
}: {
  chart: string;
  onZoom?: (svg: string) => void;
}) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  // Per-instance stable ID — prevents two equal charts from clobbering each other's SVG node
  const instanceId = useId();
  // Debounced chart to avoid queuing hundreds of render calls during streaming
  const [debouncedChart, setDebouncedChart] = useState(chart);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedChart(chart), 300);
    return () => clearTimeout(t);
  }, [chart]);

  useEffect(() => {
    let cancelled = false;
    const renderChart = async () => {
      if (!debouncedChart.trim()) return;
      // Instance-scoped ID: each component mount gets a unique slot — no cross-instance DOM conflicts
      const id = `m${instanceId.replace(/:/g, "")}`;
      try {
        const result = await mermaid.render(id, debouncedChart.trim());
        if (!cancelled) {
          setSvg(result.svg);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : "";
          const firstLine = msg.split("\n").find((l) => l.trim()) ?? "Failed to render diagram";
          // Only show error if we have no prior good render (don't flash error during streaming)
          if (!svg) setError(firstLine);
        }
      } finally {
        // mermaid does NOT call removeTempElements() before throwing parseEncounteredException,
        // so we must clean up the orphan #d{id} div ourselves.
        document.getElementById(`d${id}`)?.remove();
      }
    };
    renderChart();
    return () => {
      cancelled = true;
    };
  }, [debouncedChart, instanceId, retryCount]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-header">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>Diagram preview unavailable</span>
          <button
            className="mermaid-retry-btn"
            title="Retry rendering"
            onClick={() => {
              setError(null);
              setSvg("");
              setRetryCount((c) => c + 1);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 4v6h6" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
        </div>
        <details className="mermaid-error-details">
          <summary>View source</summary>
          <pre className="mermaid-error-code">{chart}</pre>
        </details>
      </div>
    );
  }

  if (!svg) return null;

  return (
    <div
      className={`mermaid-diagram${onZoom ? " mermaid-diagram--zoomable" : ""}`}
      dangerouslySetInnerHTML={{ __html: svg }}
      onClick={onZoom ? () => onZoom(svg) : undefined}
      style={onZoom ? { cursor: "zoom-in" } : undefined}
    />
  );
});

// ── Message block types ───────────────────────────────────────────────────────
type MessageBlock =
  | { type: "text"; content: string }
  | { type: "code"; lang: string; content: string }
  | { type: "mermaid"; content: string }
  | { type: "image"; src: string; alt: string }
  | { type: "iframe"; src: string; rawHtml: string; height?: string; width?: string }
  | { type: "artifact"; artifactType: ArtifactType; title: string; content: string; language?: string }
  | { type: "streaming-artifact"; artifactType: ArtifactType; title: string; partialContent: string }
  | { type: "embed"; title: string; url: string };

// YouTube embed hostnames allowed in iframes
const YOUTUBE_EMBED_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
]);

// Validates that a URL is safe (http/https or relative /api/ path) to prevent XSS
function isSafeUrl(url: string): boolean {
  if (url.startsWith("/api/")) {
    // Normalise the path to catch path-traversal attempts like /api/../../admin
    try {
      const normalised = new URL(url, "https://x").pathname;
      return normalised.startsWith("/api/");
    } catch {
      return false;
    }
  }
  try {
    const p = new URL(url);
    return p.protocol === "https:" || p.protocol === "http:";
  } catch {
    return false;
  }
}

// Returns true if the URL is a YouTube embed (needs allow-same-origin in sandbox)
function isYouTubeEmbedUrl(url: string): boolean {
  try {
    const p = new URL(url);
    if (!YOUTUBE_EMBED_HOSTS.has(p.hostname)) return false;
    return p.pathname.startsWith("/embed/");
  } catch {
    return false;
  }
}

// Allowed origins for postMessage resize events (extend if supporting more embed providers)
const IFRAME_RESIZE_ORIGINS = /^https:\/\/([a-z0-9-]+\.)?datawrapper\.(de|dwcdn\.net)$/i;
const MAX_IFRAME_HEIGHT = 8000; // px — sane ceiling against malicious/buggy embeds

// Iframe card — no header, just a bordered container sized to the iframe's native dimensions.
// Listens for DataWrapper-style postMessage resize events so the card height tracks the embed.
function IframePreviewCard({
  src,
  rawHtml,
  height: initHeight,
}: {
  src: string;
  rawHtml: string;
  height?: string;
  width?: string;
}) {
  const parsed = parseInt(initHeight ?? "", 10);
  const defaultH = Number.isFinite(parsed) && parsed > 0 ? Math.max(100, parsed) : 400;
  const [height, setHeight] = useState(defaultH);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Extract iframe id attribute (needed for DataWrapper chart matching)
  const iframeId = useMemo(() => /\bid=["']([^"']*)["']/.exec(rawHtml)?.[1] ?? "", [rawHtml]);

  useEffect(() => {
    const handleMessage = (ev: MessageEvent) => {
      if (!iframeRef.current) return;
      // Validate origin: only accept messages from our iframe's window or known resize providers
      const fromThisFrame = ev.source === iframeRef.current.contentWindow;
      const fromTrustedOrigin = IFRAME_RESIZE_ORIGINS.test(ev.origin ?? "");
      if (!fromThisFrame && !fromTrustedOrigin) return;
      // DataWrapper sends { 'datawrapper-height': { [chartId]: heightPx } }
      const dw = (ev.data as any)?.["datawrapper-height"];
      if (dw && typeof dw === "object") {
        for (const [chartId, h] of Object.entries(dw)) {
          // Match by chart ID (most specific); break after first match to avoid batched-message confusion
          if (iframeId === `datawrapper-chart-${chartId}`) {
            const next = parseInt(String(h), 10);
            if (!Number.isNaN(next) && next > 0) setHeight(Math.min(next, MAX_IFRAME_HEIGHT));
            break;
          }
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [iframeId]);

  const sandboxAttr = isYouTubeEmbedUrl(src)
    ? "allow-scripts allow-same-origin allow-popups"
    : "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

  return (
    <div className="message-iframe-card" style={{ height: `${height}px` }}>
      <iframe
        ref={iframeRef}
        src={src}
        id={iframeId || undefined}
        title="Embedded content"
        style={{ width: "100%", height: "100%", border: "none", display: "block" }}
        sandbox={sandboxAttr}
      />
    </div>
  );
}

const ARTIFACT_VALID_TYPES: ArtifactType[] = ["html", "react", "svg", "chart", "csv", "markdown", "code"];
// embed is a special pseudo-type that opens a URL in the sidebar (not an ArtifactType)
const ARTIFACT_EMBED_TYPE = "embed";

// ── Scanner-based block splitter ──────────────────────────────────────────────
// Returns blocks in source order so the rendered output mirrors original document flow.
// isStreaming: enables partial artifact detection (streaming-artifact blocks).
// isAgent: artifact tags are only parsed in agent messages.
function parseMessageBlocks(text: string, isStreaming?: boolean, isAgent?: boolean): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let pos = 0;

  // Strip unsafe tags using index-based search (avoids regex [\s\S]*? flagged by CodeQL).
  const unsafeTags = ["iframe", "script", "object", "embed", "form", "base", "meta", "link", "style"];
  const stripUnsafeTags = (input: string): string => {
    let result = input;
    for (const tag of unsafeTags) {
      const openRe = new RegExp(`<${tag}\\b`, "i");
      const closeTag = `</${tag}>`;
      let safety = 50;
      while (safety-- > 0) {
        const m = openRe.exec(result);
        if (!m) break;
        const closeIdx = result.toLowerCase().indexOf(closeTag.toLowerCase(), m.index);
        if (closeIdx !== -1) {
          result = result.slice(0, m.index) + result.slice(closeIdx + closeTag.length);
        } else {
          // Self-closing or orphan open — find end of tag
          const endIdx = result.indexOf(">", m.index);
          result = result.slice(0, m.index) + (endIdx !== -1 ? result.slice(endIdx + 1) : "");
        }
      }
    }
    return result;
  };

  // Strip unsafe tags from every text segment before passing to rehypeRaw.
  // Covers both the textBefore slices and the final tail when candidates.length === 0.
  const pushText = (str: string) => {
    let cleaned = stripUnsafeTags(str).replace(/<artifact\b[\s\S]*?<\/artifact>/gi, "");
    // During streaming, strip orphaned opening tags so raw XML stays off screen
    if (isStreaming) {
      cleaned = cleaned.replace(/<artifact\b[^>]*>[\s\S]*$/i, "");
    }
    if (cleaned.trim()) blocks.push({ type: "text", content: cleaned });
  };

  while (pos < text.length) {
    const slice = text.slice(pos);
    const candidates: Array<{ index: number; end: number; block: MessageBlock }> = [];

    // ── Fenced code block (mermaid or regular) ────────────────────────────────
    // Closing ``` must be on its own line (CommonMark: closing fence at line start)
    const fenceRe = /```(\w*)\r?\n([\s\S]*?)\n```(?:\r?\n|$)/;
    const fm = fenceRe.exec(slice);
    if (fm !== null) {
      const lang = fm[1].toLowerCase();
      const content = fm[2].trim();
      const block: MessageBlock = lang === "mermaid" ? { type: "mermaid", content } : { type: "code", lang, content };
      candidates.push({ index: fm.index, end: fm.index + fm[0].length, block });
    }

    // ── <iframe> ──────────────────────────────────────────────────────────────
    const iframeRe = /<iframe\b([^>]*)(?:\s*\/>|\s*>(?:[\s\S]*?)<\/iframe>)/i;
    const im = iframeRe.exec(slice);
    if (im !== null) {
      const attrs = im[1];
      const srcM = /\bsrc=["']([^"']*)["']/.exec(attrs);
      if (srcM && isSafeUrl(srcM[1])) {
        const hM = /\bheight=["']?(\d+)["']?/.exec(attrs);
        const wM = /\bwidth=["']?(\d+%?)["']?/.exec(attrs);
        candidates.push({
          index: im.index,
          end: im.index + im[0].length,
          block: { type: "iframe", src: srcM[1], rawHtml: im[0], height: hM?.[1], width: wM?.[1] },
        });
      }
    }

    // ── <img> ─────────────────────────────────────────────────────────────────
    const imgRe = /<img\b([^>]*)\/?>/i;
    const imgm = imgRe.exec(slice);
    if (imgm !== null) {
      const attrs = imgm[1];
      const srcM = /\bsrc=["']([^"']*)["']/.exec(attrs);
      const altM = /\balt=["']([^"']*)["']/.exec(attrs);
      if (srcM && (isSafeUrl(srcM[1]) || srcM[1].startsWith("data:image/"))) {
        candidates.push({
          index: imgm.index,
          end: imgm.index + imgm[0].length,
          block: { type: "image", src: srcM[1], alt: altM?.[1] ?? "" },
        });
      }
    }

    // ── Standalone markdown image on its own line ─────────────────────────────
    const mdImgRe = /^[ \t]*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)[ \t]*$/m;
    const mim = mdImgRe.exec(slice);
    if (mim !== null) {
      const src = mim[2];
      if (isSafeUrl(src) || src.startsWith("data:image/")) {
        candidates.push({
          index: mim.index,
          end: mim.index + mim[0].length,
          block: { type: "image", src, alt: mim[1] },
        });
      }
    }

    // ── <artifact> — complete and streaming artifact tags ─────────────────────
    if (isAgent) {
      const artifactRe = /<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/i;
      const am = artifactRe.exec(slice);
      if (am !== null) {
        const attrs = am[1];
        const typeM = /\btype=["']([^"']*)["']/.exec(attrs);
        const titleM = /\btitle=["']([^"']*)["']/.exec(attrs);
        const langM = /\blanguage=["']([^"']*)["']/.exec(attrs);
        const urlM = /\burl=["']([^"']*)["']/.exec(attrs);
        const rawType = typeM?.[1] ?? "code";
        // embed type: opens external URL in sidebar
        if (rawType === ARTIFACT_EMBED_TYPE && urlM && isSafeUrl(urlM[1])) {
          candidates.push({
            index: am.index,
            end: am.index + am[0].length,
            block: {
              type: "embed",
              title: titleM?.[1] ?? "Embed",
              url: urlM[1],
            },
          });
        } else {
          const artifactType = (ARTIFACT_VALID_TYPES as string[]).includes(rawType)
            ? (rawType as ArtifactType)
            : "code";
          candidates.push({
            index: am.index,
            end: am.index + am[0].length,
            block: {
              type: "artifact",
              artifactType,
              title: titleM?.[1] ?? "Artifact",
              content: am[2].trim(),
              language: langM?.[1],
            },
          });
        }
      }

      // Partial/streaming artifact — opening tag without closing tag
      if (isStreaming) {
        const openRe = /<artifact\b([^>]*)>([\s\S]*)$/i;
        const om = openRe.exec(slice);
        if (om !== null && !/<\/artifact>/i.test(om[0])) {
          const attrs = om[1];
          const typeM = /\btype=["']([^"']*)["']/.exec(attrs);
          const titleM = /\btitle=["']([^"']*)["']/.exec(attrs);
          const rawType = typeM?.[1] ?? "code";
          const artifactType = (ARTIFACT_VALID_TYPES as string[]).includes(rawType)
            ? (rawType as ArtifactType)
            : "code";
          candidates.push({
            index: om.index,
            end: om.index + om[0].length,
            block: {
              type: "streaming-artifact",
              artifactType,
              title: titleM?.[1] ?? "Artifact",
              partialContent: om[2],
            },
          });
        }
      }
    }

    if (candidates.length === 0) {
      pushText(slice);
      break;
    }

    // Take the earliest candidate; at a tie prefer mermaid > artifact > plain code
    candidates.sort((a, b) => {
      if (a.index !== b.index) return a.index - b.index;
      if (a.block.type === "mermaid") return -1;
      if (b.block.type === "mermaid") return 1;
      if (a.block.type === "artifact") return -1;
      if (b.block.type === "artifact") return 1;
      return 0;
    });
    const earliest = candidates[0];
    const textBefore = slice.slice(0, earliest.index);
    pushText(textBefore);
    blocks.push(earliest.block);
    pos += earliest.end;
  }

  return blocks;
}

// Callout/Admonition component (GitHub-style)
export function Callout({ type, children }: { type: string; children: React.ReactNode }) {
  const icons: Record<string, string> = {
    note: "📝",
    tip: "💡",
    important: "❗",
    warning: "⚠️",
    caution: "🔴",
  };

  return (
    <div className={`callout callout-${type}`}>
      <div className="callout-title">
        <span className="callout-icon">{icons[type] || "📌"}</span>
        <span className="callout-type">{type.toUpperCase()}</span>
      </div>
      <div className="callout-content">{children}</div>
    </div>
  );
}

// External link icon
function ExternalLinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

// Shared Markdown component config — module-level constant to avoid recreating on every render.
// react-markdown uses referential equality for `components`; a new object each render
// causes full re-parse and VDOM rebuild for every message on every streaming tick.
const MARKDOWN_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => <PreBlock>{children}</PreBlock>,
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    const match = /language-(\w+)/.exec(className || "");
    const lang = match ? match[1] : "";
    const code = String(children).replace(/\n$/, "");
    if (lang === "mermaid") return <MermaidDiagram chart={code} />;
    const highlighted = lang ? highlightCode(code, lang) : null;
    if (highlighted) {
      return <code className={className} dangerouslySetInnerHTML={{ __html: highlighted }} />;
    }
    return <code className={className}>{children}</code>;
  },
  blockquote: ({ children }: { children?: React.ReactNode }) => {
    const firstChild = (children as any)?.[0];
    if (firstChild?.props?.children) {
      const text = String(firstChild.props.children);
      const calloutMatch = text.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
      if (calloutMatch) {
        const type = calloutMatch[1].toLowerCase();
        const content = text.replace(calloutMatch[0], "");
        return <Callout type={type}>{content}</Callout>;
      }
    }
    return <blockquote>{children}</blockquote>;
  },
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="table-wrapper">
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  input: ({ type, checked, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => {
    if (type === "checkbox") {
      return <input type="checkbox" checked={checked} disabled className="task-checkbox" />;
    }
    return <input type={type} {...props} />;
  },
};

// HTML Preview component - sandboxed to prevent JS from affecting main UI
function HtmlPreview({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "p",
        "br",
        "hr",
        "div",
        "span",
        "ul",
        "ol",
        "li",
        "dl",
        "dt",
        "dd",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "a",
        "img",
        "pre",
        "code",
        "blockquote",
        "em",
        "strong",
        "del",
        "ins",
        "sub",
        "sup",
        "kbd",
        "mark",
        "abbr",
        "details",
        "summary",
        "figure",
        "figcaption",
        "svg",
        "path",
        "rect",
        "circle",
        "line",
        "polyline",
        "polygon",
        "text",
        "g",
        "defs",
        "clipPath",
        "use",
        "symbol",
        "title",
      ],
      ALLOWED_ATTR: [
        "href",
        "src",
        "alt",
        "title",
        "width",
        "height",
        "class",
        "style",
        "id",
        "colspan",
        "rowspan",
        "align",
        "valign",
        "target",
        "rel",
        // SVG attributes
        "viewBox",
        "xmlns",
        "fill",
        "stroke",
        "stroke-width",
        "d",
        "cx",
        "cy",
        "r",
        "x",
        "y",
        "x1",
        "y1",
        "x2",
        "y2",
        "points",
        "transform",
        "opacity",
        "font-size",
        "text-anchor",
        "dominant-baseline",
      ],
      ALLOW_DATA_ATTR: false,
      ADD_TAGS: ["style"],
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "textarea", "select"],
    })}</body>
</html>`;
    const blob = new Blob([wrapped], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <div className="html-preview">
      <div className="html-preview-toolbar">
        <span className="html-preview-label">Preview</span>
        <button className="html-preview-fullscreen" onClick={openFullView} title="Open in new tab">
          <ExternalLinkIcon />
        </button>
      </div>
      <iframe
        ref={iframeRef}
        className="html-preview-frame"
        srcDoc={DOMPurify.sanitize(html, { ADD_TAGS: ["style"], WHOLE_DOCUMENT: true })}
        sandbox="allow-scripts"
        title="HTML Preview"
      />
    </div>
  );
}

// Tool Result Card — expandable preview card for scheduled tool call results
function ToolResultCard({
  toolResult,
}: {
  toolResult: {
    tool_name: string;
    description: string;
    status: "running" | "succeeded" | "failed";
    args: Record<string, any>;
    result?: any;
    error?: string;
    job_id?: string;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const statusClass =
    toolResult.status === "succeeded"
      ? "tool-result-card-succeeded"
      : toolResult.status === "failed"
        ? "tool-result-card-failed"
        : "tool-result-card-running";

  return (
    <div
      className={`message-tool-result-card ${statusClass}`}
      onClick={() => setExpanded(!expanded)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setExpanded(!expanded)}
    >
      <div className="tool-result-card-header">
        <div className="tool-result-card-content">
          <div className="tool-result-card-title">{toolResult.tool_name}</div>
          <div className="tool-result-card-description">{toolResult.description}</div>
        </div>
      </div>
      {expanded && (
        <div className="tool-result-card-details">
          <div className="tool-result-card-section">
            <div className="tool-result-card-section-label">Arguments</div>
            <pre className="tool-result-card-json">{JSON.stringify(toolResult.args, null, 2)}</pre>
          </div>
          <div className="tool-result-card-section">
            <div className="tool-result-card-section-label">{toolResult.status === "failed" ? "Error" : "Result"}</div>
            <pre className="tool-result-card-json">
              {toolResult.error
                ? toolResult.error
                : toolResult.result
                  ? typeof toolResult.result === "string"
                    ? toolResult.result
                    : JSON.stringify(toolResult.result, null, 2)
                  : toolResult.status === "running"
                    ? "Running..."
                    : "No output"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// Code Preview component - simple raw file display with line numbers
function CodePreview({
  filename,
  content,
  startLine = 1,
}: {
  filename: string;
  language: string;
  content: string;
  startLine?: number;
  highlightLines?: number[];
}) {
  const lines = content.split("\n");

  const openRaw = () => {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    // Clean up blob URL after a short delay
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="code-preview">
      <div className="html-preview-toolbar">
        <span className="code-preview-label">{filename}</span>
        <button className="html-preview-fullscreen" onClick={openRaw} title="Open raw file in new tab">
          <ExternalLinkIcon />
        </button>
      </div>
      <div className="code-preview-body">
        <pre className="code-preview-raw">
          {lines.map((line, i) => (
            <div key={i} className="code-preview-line">
              <span className="code-preview-line-num">{startLine + i}</span>
              <span className="code-preview-line-text">{line}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

// Clawd SVG avatar component
export function ClawdAvatar({
  sleeping = false,
  streaming = false,
  standing = false,
  color: customColor,
  title,
}: {
  sleeping?: boolean;
  streaming?: boolean;
  standing?: boolean;
  color?: string;
  title?: string;
}) {
  // Default color is orange, but can be overridden by agent's avatar color
  const defaultColor = "hsl(15 63.1% 59.6%)";
  const color = sleeping ? "hsl(0 0% 60%)" : customColor || defaultColor;
  const eyeHeight = sleeping ? "2" : "6.5";
  const eyeY = sleeping ? "16" : "13";

  // When streaming, add bounce animation class; when standing, legs only
  const wrapperClass = streaming ? "clawd-avatar-streaming" : standing ? "clawd-avatar-standing" : "";

  return (
    <div className={wrapperClass} title={title}>
      <svg width="32" height="26" viewBox="0 0 66 52" fill="none" className="clawd-avatar-svg">
        {/* Left arm */}
        <rect x="0" y="13" width="6" height="13" fill={color} className="clawd-arm" />
        {/* Right arm */}
        <rect x="60" y="13" width="6" height="13" fill={color} className="clawd-arm" />
        {/* Legs - animated when streaming */}
        <rect x="6" y="39" width="6" height="13" fill={color} className="clawd-leg clawd-leg-1" />
        <rect x="18" y="39" width="6" height="13" fill={color} className="clawd-leg clawd-leg-2" />
        <rect x="42" y="39" width="6" height="13" fill={color} className="clawd-leg clawd-leg-1" />
        <rect x="54" y="39" width="6" height="13" fill={color} className="clawd-leg clawd-leg-2" />
        {/* Body */}
        <rect x="6" width="54" height="39" fill={color} className="clawd-body" />
        {/* Eyes */}
        <rect x="12" y={eyeY} width="6" height={eyeHeight} fill="#000" className="clawd-eye" />
        <rect x="48" y={eyeY} width="6" height={eyeHeight} fill="#000" className="clawd-eye" />
      </svg>
    </div>
  );
}

// Small Clawd icon for seen indicators (12px)
function ClawdSeenIcon({ color: customColor, isSleeping }: { color?: string; isSleeping?: boolean }) {
  const defaultColor = "hsl(15 63.1% 59.6%)";
  const grayColor = "hsl(0 0% 60%)";
  const color = isSleeping ? grayColor : customColor || defaultColor;
  return (
    <svg width="12" height="10" viewBox="0 0 66 52" fill="none">
      <rect x="0" y="13" width="6" height="13" fill={color} />
      <rect x="60" y="13" width="6" height="13" fill={color} />
      <rect x="6" y="39" width="6" height="13" fill={color} />
      <rect x="18" y="39" width="6" height="13" fill={color} />
      <rect x="42" y="39" width="6" height="13" fill={color} />
      <rect x="54" y="39" width="6" height="13" fill={color} />
      <rect x="6" width="54" height="39" fill={color} />
      <rect x="12" y="13" width="6" height="6.5" fill="#000" />
      <rect x="48" y="13" width="6" height="6.5" fill="#000" />
    </svg>
  );
}

// Worker Clawd SVG avatar (black/white version)
function WorkerClawdAvatar() {
  return (
    <svg width="32" height="26" viewBox="0 0 66 52" fill="none">
      <rect x="0" y="13" width="6" height="13" fill="#333" />
      <rect x="60" y="13" width="6" height="13" fill="#333" />
      <rect x="6" y="39" width="6" height="13" fill="#333" />
      <rect x="18" y="39" width="6" height="13" fill="#333" />
      <rect x="42" y="39" width="6" height="13" fill="#333" />
      <rect x="54" y="39" width="6" height="13" fill="#333" />
      <rect x="6" width="54" height="39" fill="#333" />
      <rect x="12" y="13" width="6" height="6.5" fill="#fff" className="clawd-eye" />
      <rect x="48" y="13" width="6" height="6.5" fill="#fff" className="clawd-eye" />
    </svg>
  );
}

// Pilot (User) avatar - GitHub Copilot icon
function UserAvatar() {
  return (
    <svg
      width="28"
      height="22"
      viewBox="0 0 512 416"
      fill="hsl(15 63.1% 59.6%)"
      fillRule="evenodd"
      clipRule="evenodd"
      strokeLinejoin="round"
      strokeMiterlimit={2}
    >
      <path
        d="M181.33 266.143c0-11.497 9.32-20.818 20.818-20.818 11.498 0 20.819 9.321 20.819 20.818v38.373c0 11.497-9.321 20.818-20.819 20.818-11.497 0-20.818-9.32-20.818-20.818v-38.373zM308.807 245.325c-11.477 0-20.798 9.321-20.798 20.818v38.373c0 11.497 9.32 20.818 20.798 20.818 11.497 0 20.818-9.32 20.818-20.818v-38.373c0-11.497-9.32-20.818-20.818-20.818z"
        fillRule="nonzero"
      />
      <path d="M512.002 246.393v57.384c-.02 7.411-3.696 14.638-9.67 19.011C431.767 374.444 344.695 416 256 416c-98.138 0-196.379-56.542-246.33-93.21-5.975-4.374-9.65-11.6-9.671-19.012v-57.384a35.347 35.347 0 016.857-20.922l15.583-21.085c8.336-11.312 20.757-14.31 33.98-14.31 4.988-56.953 16.794-97.604 45.024-127.354C155.194 5.77 226.56 0 256 0c29.441 0 100.807 5.77 154.557 62.722 28.19 29.75 40.036 70.401 45.025 127.354 13.263 0 25.602 2.936 33.958 14.31l15.583 21.127c4.476 6.077 6.878 13.345 6.878 20.88zm-97.666-26.075c-.677-13.058-11.292-18.19-22.338-21.824-11.64 7.309-25.848 10.183-39.46 10.183-14.454 0-41.432-3.47-63.872-25.869-5.667-5.625-9.527-14.454-12.155-24.247a212.902 212.902 0 00-20.469-1.088c-6.098 0-13.099.349-20.551 1.088-2.628 9.793-6.509 18.622-12.155 24.247-22.4 22.4-49.418 25.87-63.872 25.87-13.612 0-27.86-2.855-39.501-10.184-11.005 3.613-21.558 8.828-22.277 21.824-1.17 24.555-1.272 49.11-1.375 73.645-.041 12.318-.082 24.658-.288 36.976.062 7.166 4.374 13.818 10.882 16.774 52.97 24.124 103.045 36.278 149.137 36.278 46.01 0 96.085-12.154 149.014-36.278 6.508-2.956 10.84-9.608 10.881-16.774.637-36.832.124-73.809-1.642-110.62h.041zM107.521 168.97c8.643 8.623 24.966 14.392 42.56 14.392 13.448 0 39.03-2.874 60.156-24.329 9.28-8.951 15.05-31.35 14.413-54.079-.657-18.231-5.769-33.28-13.448-39.665-8.315-7.371-27.203-10.574-48.33-8.644-22.399 2.238-41.267 9.588-50.875 19.833-20.798 22.728-16.323 80.317-4.476 92.492zm130.556-56.008c.637 3.51.965 7.35 1.273 11.517 0 2.875 0 5.77-.308 8.952 6.406-.636 11.847-.636 16.959-.636s10.553 0 16.959.636c-.329-3.182-.329-6.077-.329-8.952.329-4.167.657-8.007 1.294-11.517-6.735-.637-12.812-.965-17.924-.965s-11.21.328-17.924.965zm49.275-8.008c-.637 22.728 5.133 45.128 14.413 54.08 21.105 21.454 46.708 24.328 60.155 24.328 17.596 0 33.918-5.769 42.561-14.392 11.847-12.175 16.322-69.764-4.476-92.492-9.608-10.245-28.476-17.595-50.875-19.833-21.127-1.93-40.015 1.273-48.33 8.644-7.679 6.385-12.791 21.434-13.448 39.665z" />
    </svg>
  );
}

// Context menu state type
interface ContextMenuState {
  x: number;
  y: number;
  ts: string;
  text: string;
  channel?: string; // Channel for sharing as article
  content?: string; // Message content for sharing as article
}

// Context menu component
function MessageContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Position menu so it doesn't overflow viewport
  const adjustedPosition = useMemo(() => {
    const menuWidth = 180;
    const menuHeight = 120;
    let x = menu.x;
    let y = menu.y;
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 8;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 8;
    }
    return { x, y };
  }, [menu.x, menu.y]);

  const copyReference = () => {
    navigator.clipboard.writeText(`@msg:${menu.ts}`);
    onClose();
  };

  const copyMessage = () => {
    navigator.clipboard.writeText(menu.text);
    onClose();
  };

  const shareAsArticle = async () => {
    if (!menu.content || !menu.channel) {
      onClose();
      return;
    }
    try {
      // Extract title from content (first line or first 50 chars)
      const title = menu.content.split("\n")[0].slice(0, 50) || "Shared message";
      // Create article
      const res = await authFetch("/api/articles.create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          content: menu.content,
          channel: menu.channel,
          published: true,
        }),
      });
      const data = await res.json();
      if (data.ok && data.article) {
        // Copy article URL to clipboard and open in new tab
        const articleUrl = `${window.location.origin}/articles/${data.article.id}`;
        await navigator.clipboard.writeText(articleUrl);
        window.open(articleUrl, "_blank");
      }
    } catch (err) {
      console.error("Failed to share article:", err);
    }
    onClose();
  };

  return createPortal(
    <div ref={menuRef} className="message-context-menu" style={{ left: adjustedPosition.x, top: adjustedPosition.y }}>
      <button className="context-menu-item" onClick={copyReference}>
        <LinkIcon />
        <span>Copy reference</span>
      </button>
      <button className="context-menu-item" onClick={copyMessage}>
        <CopyIcon />
        <span>Copy message</span>
      </button>
      <button className="context-menu-item" onClick={shareAsArticle}>
        <ShareIcon />
        <span>Share</span>
      </button>
    </div>,
    document.body,
  );
}

// ===== Streaming Output Dialog =====
// Shows real-time agent output (thinking, content, tool calls)
// Exported for use from App.tsx
export function StreamOutputDialog({
  open,
  onClose,
  getStreamingOutput,
  streamingVersion,
  streamingAgents,
  initialAgentId,
}: {
  open: boolean;
  onClose: () => void;
  getStreamingOutput: () => StreamingAgentInfo[];
  streamingVersion: React.MutableRefObject<number>;
  streamingAgents: { agentId: string; avatarColor: string }[];
  initialAgentId?: string | null;
}) {
  const [, forceUpdate] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastVersionRef = useRef(0);
  const autoScrollRef = useRef(true);
  // Cache last non-empty output so dialog content persists after streaming ends
  const cachedOutputRef = useRef<StreamingAgentInfo[]>([]);
  // No agent selected by default -- user must click an avatar
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // Poll for updates while dialog is open using requestAnimationFrame
  // (rAF fires every ~16ms vs previous 100ms setInterval, so tool_start/tool_end
  // events for fast MCP/chat tools no longer appear simultaneously)
  useEffect(() => {
    if (!open) return;
    let rafId: number;
    const poll = () => {
      if (streamingVersion.current !== lastVersionRef.current) {
        lastVersionRef.current = streamingVersion.current;
        forceUpdate((n) => n + 1);
      }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [open, streamingVersion]);

  // Clear cache and reset selection when dialog closes
  useEffect(() => {
    if (!open) {
      cachedOutputRef.current = [];
      setSelectedAgentId(null);
    }
  }, [open]);

  // Pre-select agent when dialog opens with initialAgentId
  useEffect(() => {
    if (open && initialAgentId) {
      setSelectedAgentId(initialAgentId);
    }
  }, [open, initialAgentId]);

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (open && autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  // Track if user has scrolled up (disable auto-scroll)
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  if (!open) return null;

  const allAgents = getStreamingOutput();
  // Merge per-agent: update cache with fresh data, but keep agents that are no longer in the ref
  if (allAgents.length > 0) {
    const mergedMap = new Map<string, StreamingAgentInfo>();
    for (const agent of cachedOutputRef.current) {
      mergedMap.set(agent.agentId, agent);
    }
    for (const agent of allAgents) {
      mergedMap.set(agent.agentId, agent);
    }
    cachedOutputRef.current = Array.from(mergedMap.values());
  }
  const displayAgents = cachedOutputRef.current;

  // Build the list of all known agents (streaming + cached) for the avatar bar
  const allKnownAgents = new Map<string, string>();
  for (const a of streamingAgents) allKnownAgents.set(a.agentId, a.avatarColor);
  for (const a of displayAgents) allKnownAgents.set(a.agentId, a.avatarColor);

  // Auto-select if only one agent exists
  const effectiveSelectedId = allKnownAgents.size === 1 ? Array.from(allKnownAgents.keys())[0] : selectedAgentId;

  // Filter to selected agent if specified
  const agents = effectiveSelectedId ? displayAgents.filter((a) => a.agentId === effectiveSelectedId) : [];
  const isStillStreaming = streamingAgents.length > 0;

  return createPortal(
    <div className="stream-dialog-overlay" onClick={onClose}>
      <div className="stream-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            <h3>Thoughts</h3>
          </div>
          <button className="stream-dialog-close" onClick={onClose}>
            ×
          </button>
        </div>
        {/* Agent avatar bar -- shown when multiple agents */}
        {allKnownAgents.size > 1 && (
          <div className="stream-agent-bar">
            {Array.from(allKnownAgents.entries()).map(([agentId, avatarColor]) => {
              const isActive = effectiveSelectedId === agentId;
              const isAgentStreaming = streamingAgents.some((a) => a.agentId === agentId);
              return (
                <button
                  key={agentId}
                  className={`stream-agent-avatar-btn ${isActive ? "active" : ""}`}
                  onClick={() => {
                    setSelectedAgentId(agentId);
                    autoScrollRef.current = true;
                  }}
                  title={agentId}
                >
                  <span className="stream-agent-avatar-wrap">
                    <ClawdAvatar color={avatarColor} standing={isAgentStreaming && isActive} />
                    {isAgentStreaming && <span className="stream-agent-avatar-dot" />}
                  </span>
                  <span className="stream-agent-avatar-name">{agentId}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="stream-dialog-body" ref={scrollRef} onScroll={handleScroll}>
          {/* No agent selected -- show placeholder */}
          {!effectiveSelectedId && allKnownAgents.size > 1 && (
            <div className="stream-dialog-placeholder">Select an agent above to see their thoughts</div>
          )}
          {/* Agent selected but no output yet */}
          {effectiveSelectedId && agents.length === 0 && isStillStreaming && (
            <div className="stream-dialog-waiting">
              <span>Waiting for output from {effectiveSelectedId}...</span>
            </div>
          )}
          {/* Agent selected, streaming ended, no output */}
          {effectiveSelectedId && agents.length === 0 && !isStillStreaming && (
            <div className="stream-dialog-empty">Streaming has ended. No output was captured.</div>
          )}
          {agents.map((agent) => (
            <div key={agent.agentId} className="stream-agent-section">
              {agent.entries.length === 0 && isStillStreaming && (
                <div className="stream-dialog-waiting">
                  <span>Waiting for output...</span>
                </div>
              )}
              {groupToolEntries(agent.entries).map((item, i) =>
                item.kind === "tool_group" ? (
                  <ToolCallCombinedView key={i} start={item.start} result={item.result} />
                ) : (
                  <StreamEntryView key={i} entry={item.entry} />
                ),
              )}
              {agent.completed &&
                agent.entries.length > 0 &&
                (() => {
                  const firstTs = agent.entries[0].timestamp;
                  const lastTs = agent.entries[agent.entries.length - 1].timestamp;
                  const durationMs = lastTs - firstTs;
                  const durationSec = Math.round(durationMs / 1000);
                  let durationStr: string;
                  if (durationSec < 60) {
                    durationStr = `${durationSec}s`;
                  } else {
                    const min = Math.floor(durationSec / 60);
                    const sec = durationSec % 60;
                    durationStr = sec > 0 ? `${min}m ${sec}s` : `${min}m`;
                  }
                  return (
                    <div className="stream-entry stream-thought-duration">
                      <span>Thought for {durationStr}</span>
                    </div>
                  );
                })()}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Groups tool_start entries with their matching tool_end/tool_error into combined items
type GroupedItem =
  | { kind: "entry"; entry: StreamEntry }
  | { kind: "tool_group"; start: StreamEntry; result: StreamEntry | null };

function groupToolEntries(entries: StreamEntry[]): GroupedItem[] {
  const items: GroupedItem[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    if (consumed.has(i)) continue;
    const entry = entries[i];

    if (entry.type === "tool_start") {
      // Look ahead for matching tool_end or tool_error with same toolName
      let matchIdx = -1;
      for (let j = i + 1; j < entries.length; j++) {
        if (consumed.has(j)) continue;
        const candidate = entries[j];
        if (
          (candidate.type === "tool_end" || candidate.type === "tool_error") &&
          candidate.toolName === entry.toolName
        ) {
          matchIdx = j;
          break;
        }
      }
      if (matchIdx >= 0) {
        consumed.add(matchIdx);
        items.push({ kind: "tool_group", start: entry, result: entries[matchIdx] });
      } else {
        // No result yet -- pending
        items.push({ kind: "tool_group", start: entry, result: null });
      }
    } else if (entry.type === "tool_end" || entry.type === "tool_error") {
      // Orphan result (no matching start) -- render as standalone group
      items.push({ kind: "tool_group", start: entry, result: null });
    } else {
      items.push({ kind: "entry", entry });
    }
  }
  return items;
}

// Extract file_id from a JSON tool result string
function extractFileId(text: string): string | null {
  try {
    const parsed = JSON.parse(text);
    return parsed?.file_id || null;
  } catch {
    // Try regex fallback for truncated JSON
    const match = text.match(/"file_id"\s*:\s*"([^"]+)"/);
    return match?.[1] || null;
  }
}

// Render diff from tool args (client-side only, no backend changes)
function ArgsDiffView({ toolName, args }: { toolName: string; args: any }) {
  const isEdit = ["edit", "Edit", "edit_file"].includes(toolName);
  const isCreate = ["create", "Create", "create_file", "write", "Write"].includes(toolName);

  if (isEdit && args.old_str && args.new_str) {
    const oldLines = String(args.old_str).split("\n");
    const newLines = String(args.new_str).split("\n");
    return (
      <pre className="stream-tool-block-content stream-tool-diff">
        {oldLines.map((line: string, i: number) => (
          <span key={`d${i}`} className="stream-diff-del">{`- ${line}\n`}</span>
        ))}
        {newLines.map((line: string, i: number) => (
          <span key={`a${i}`} className="stream-diff-add">{`+ ${line}\n`}</span>
        ))}
      </pre>
    );
  }

  if (isCreate && args.content) {
    const lines = String(args.content).split("\n");
    return (
      <pre className="stream-tool-block-content stream-tool-diff">
        {lines.map((line: string, i: number) => (
          <span key={i} className="stream-diff-add">{`+ ${line}\n`}</span>
        ))}
      </pre>
    );
  }

  return null;
}

// Tools that produce image output (file_id in result)
const IMAGE_OUTPUT_TOOLS = new Set(["browser_screenshot", "create_image", "edit_image"]);
// Tools that take image input (file_id in args)
const IMAGE_INPUT_TOOLS = new Set(["read_image", "edit_image"]);
// Tools that should render a diff view from their args
const DIFF_TOOLS = new Set(["edit", "Edit", "edit_file", "create", "Create", "create_file", "write", "Write"]);

// Combined tool call: same visual style as original (blue/green/red header) but input+output in one accordion
function ToolCallCombinedView({ start, result }: { start: StreamEntry; result: StreamEntry | null }) {
  const isError = result?.type === "tool_error";

  const hasInput = !!(start.toolArgs && Object.keys(start.toolArgs).length > 0);
  const hasOutput = !!result?.text;
  const hasContent = hasInput || hasOutput;

  const [collapsed, setCollapsed] = useState(false);

  // Calculate duration
  let durationStr: string | null = null;
  if (result && start.timestamp && result.timestamp) {
    const ms = result.timestamp - start.timestamp;
    if (ms >= 0) {
      if (ms < 1000) {
        durationStr = `${ms}ms`;
      } else {
        const sec = Math.round(ms / 1000);
        if (sec < 60) {
          durationStr = `${sec}s`;
        } else {
          const min = Math.floor(sec / 60);
          const s = sec % 60;
          durationStr = s > 0 ? `${min}m ${s}s` : `${min}m`;
        }
      }
    }
  }

  const toolName = start.toolName || result?.toolName || "Unknown";
  const statusClass = !result ? "stream-tool-start" : isError ? "stream-tool-error" : "stream-tool-end";

  // Image preview in input (read_image, edit_image)
  const inputImageId = IMAGE_INPUT_TOOLS.has(toolName) && start.toolArgs?.file_id ? start.toolArgs.file_id : null;
  // Image preview in output (browser_screenshot, create_image, edit_image)
  const outputImageId = IMAGE_OUTPUT_TOOLS.has(toolName) && result?.text ? extractFileId(result.text) : null;
  // Diff view from args (edit, create, write tools)
  const showDiff = !isError && DIFF_TOOLS.has(toolName) && start.toolArgs;

  return (
    <div
      className={`stream-entry ${statusClass}${hasContent && collapsed ? " stream-tool-collapsed" : ""}${!hasContent ? " stream-tool-no-content" : ""}`}
    >
      <div
        className={`stream-tool-header${hasContent ? " stream-tool-header-clickable" : ""}`}
        onClick={hasContent ? () => setCollapsed(!collapsed) : undefined}
      >
        <span className="stream-tool-name">{toolName}</span>
        {hasContent && <span className="stream-tool-arrow">{collapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}</span>}
      </div>
      {!collapsed && hasContent && (
        <>
          {hasInput && !showDiff && (
            <div className="stream-tool-block">
              <div className="stream-tool-block-label">Input</div>
              <pre className="stream-tool-block-content">{JSON.stringify(start.toolArgs, null, 2)}</pre>
              {inputImageId && (
                <div className="stream-tool-image-preview">
                  <img
                    src={`/api/files/${inputImageId}/optimized?maxWidth=400&maxHeight=300&quality=70`}
                    alt="Input image"
                    loading="lazy"
                  />
                </div>
              )}
            </div>
          )}
          {showDiff && (
            <div className="stream-tool-block">
              <div className="stream-tool-block-label">Changes</div>
              <ArgsDiffView toolName={toolName} args={start.toolArgs} />
            </div>
          )}
          {hasOutput && (
            <div className="stream-tool-block">
              <div className="stream-tool-block-label">{isError ? "Error" : "Output"}</div>
              <pre className="stream-tool-block-content">{result!.text}</pre>
              {outputImageId && (
                <div className="stream-tool-image-preview">
                  <img
                    src={`/api/files/${outputImageId}/optimized?maxWidth=400&maxHeight=300&quality=70`}
                    alt="Output image"
                    loading="lazy"
                  />
                </div>
              )}
            </div>
          )}
          {durationStr && (
            <div className="stream-tool-duration">
              <span>{durationStr}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StreamEntryView({ entry }: { entry: StreamEntry }) {
  if (entry.type === "thinking") {
    return (
      <div className="stream-entry stream-thinking">
        <pre>{entry.text}</pre>
      </div>
    );
  }
  if (entry.type === "content") {
    return (
      <div className="stream-entry stream-content">
        <pre>{entry.text}</pre>
      </div>
    );
  }
  if (entry.type === "event") {
    return (
      <div className="stream-entry stream-event">
        <span>{entry.text}</span>
      </div>
    );
  }
  if (entry.type === "session_divider") {
    return (
      <div className="stream-entry stream-session-divider">
        <hr />
        <span>New session</span>
        <hr />
      </div>
    );
  }
  return null;
}

// Small copy button with icon + transient "copied" feedback for inline artifact headers
function InlineArtifactCopyBtn({ content, title = "Copy" }: { content: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      // Fallback for non-HTTPS or restricted contexts
      const ta = document.createElement("textarea");
      ta.value = content;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button className="message-inline-artifact-action-btn" title={copied ? "Copied!" : title} onClick={handleCopy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

export default function MessageList({
  messages,
  pendingMessages = [],
  agentLastSeenTs,
  userLastSeenTs,
  agentSleeping = false,
  streamingAgentIds = [],
  hasMoreOlder = false,
  hasMoreNewer = false,
  channel,
  loadingOlder = false,
  loadingNewer = false,
  isAtLatest = true,
  onLoadOlder,
  onLoadNewer,
  onJumpToMessage,
  onJumpToLatest,
  onRetryMessage,
  onMarkSeen,
  channelKey,
  jumpToMessageTs,
  onJumpComplete,
  onScrollAtBottomChange,
  hasActiveChannelUnread = false,
  onOpenSidebar,
}: Props) {
  // agentSleeping: when all agents are sleeping, override per-message is_sleeping

  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
  const scrollHeightBeforeLoadRef = useRef<{ height: number; direction: "older" | "newer" } | null>(null);
  const initialScrollDone = useRef(false);
  const pendingScrollToTs = useRef<string | null>(null);
  // Cache for parsed message blocks — throttles re-parsing during streaming.
  // Streaming messages re-parse every 500 chars; non-streaming on every char change.
  const blockParseCacheRef = useRef<Map<string, { key: string; blocks: MessageBlock[] }>>(new Map());

  // Intersection observer for marking messages as seen
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pendingMarkRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const wasAtBottomRef = useRef(true); // Track previous "at bottom" state for change detection
  const onScrollAtBottomChangeRef = useRef(onScrollAtBottomChange);
  onScrollAtBottomChangeRef.current = onScrollAtBottomChange;

  // Lightbox state for image preview
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);

  // Mermaid zoom modal state
  const [mermaidZoom, setMermaidZoom] = useState<string | null>(null); // stores rendered SVG content

  // Shared zoom level for lightbox (image + mermaid)
  const [lightboxZoom, setLightboxZoom] = useState(1);
  // Drag-to-pan state for mermaid zoom (supports high zoom levels)
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Streaming output dialog state - moved to App.tsx for thinking banner integration

  // Long press tracking for mobile
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);

  // Handle right-click on message
  const handleMessageContextMenu = useCallback(
    (e: React.MouseEvent, msg: Message) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        ts: msg.ts,
        text: msg.text,
        channel, // Channel for sharing
        content: msg.text, // Use text content for sharing
      });
    },
    [channel],
  );

  // Handle touch start for long press (mobile)
  const handleTouchStart = useCallback((e: React.TouchEvent, msg: Message) => {
    const touch = e.touches[0];
    longPressStartRef.current = { x: touch.clientX, y: touch.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      if (longPressStartRef.current) {
        setContextMenu({
          x: longPressStartRef.current.x,
          y: longPressStartRef.current.y,
          ts: msg.ts,
          text: msg.text,
        });
        longPressStartRef.current = null;
      }
    }, 500); // 500ms long press
  }, []);

  // Handle touch move - cancel long press if moved too far
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (longPressTimerRef.current && longPressStartRef.current) {
      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - longPressStartRef.current.x);
      const dy = Math.abs(touch.clientY - longPressStartRef.current.y);
      if (dx > 10 || dy > 10) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
        longPressStartRef.current = null;
      }
    }
  }, []);

  // Handle touch end - cancel long press timer
  const handleTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  }, []);

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Character threshold for collapsing messages
  const MESSAGE_COLLAPSE_THRESHOLD = 1500;

  // Toggle message expansion
  const toggleExpanded = useCallback((ts: string) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(ts)) {
        next.delete(ts);
      } else {
        next.add(ts);
      }
      return next;
    });
  }, []);

  // Setup Intersection Observer - store onMarkSeen in ref to avoid recreating observer
  const onMarkSeenRef = useRef(onMarkSeen);
  onMarkSeenRef.current = onMarkSeen;

  // Track message count to avoid recreating observer on every message change
  const messagesLengthRef = useRef(0);

  // Setup observer when container is ready and messages exist
  useEffect(() => {
    if (!containerRef.current || messages.length === 0) return;

    // Only recreate observer when message count changes significantly (new messages added)
    // Skip if just streaming updates (same count but different content)
    const prevLength = messagesLengthRef.current;
    messagesLengthRef.current = messages.length;

    // Skip recreation if count hasn't changed (streaming update)
    if (prevLength === messages.length && observerRef.current) {
      return;
    }

    const handleIntersect = (entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const ts = entry.target.getAttribute("data-ts");
          const isUserMsg = entry.target.getAttribute("data-user") === "UHUMAN";
          if (ts && !isUserMsg && (!pendingMarkRef.current || ts > pendingMarkRef.current)) {
            pendingMarkRef.current = ts;
          }
        }
      }

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = window.setTimeout(() => {
        if (pendingMarkRef.current && onMarkSeenRef.current) {
          console.log("[MarkSeen] Calling API for ts:", pendingMarkRef.current);
          onMarkSeenRef.current(pendingMarkRef.current);
          pendingMarkRef.current = null;
        }
      }, 300);
    };

    // Disconnect old observer
    observerRef.current?.disconnect();

    observerRef.current = new IntersectionObserver(handleIntersect, {
      root: containerRef.current,
      threshold: 0.1, // 10% visibility is enough
    });

    // Observe all messages
    const elements = containerRef.current.querySelectorAll("[data-ts]");
    elements.forEach((el) => observerRef.current?.observe(el));
    console.log("[MarkSeen] Observer watching", elements.length, "messages");

    return () => {
      observerRef.current?.disconnect();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [messages.length]); // Only re-setup when message COUNT changes, not on streaming updates

  // Reset scroll state when channel changes
  useEffect(() => {
    initialScrollDone.current = false;
  }, []);

  // Initial scroll to first unread or bottom on first render (page refresh)
  useEffect(() => {
    if (messages.length > 0 && !initialScrollDone.current) {
      initialScrollDone.current = true;
      // Use setTimeout to ensure DOM is fully rendered
      setTimeout(() => {
        // Find first unread message
        if (userLastSeenTs) {
          const firstUnread = messages.find((m) => m.ts > userLastSeenTs && m.user !== "UHUMAN");
          if (firstUnread) {
            const element = document.querySelector(`[data-ts="${firstUnread.ts}"]`);
            element?.scrollIntoView({ behavior: "instant", block: "center" });
            return;
          }
        }
        // No unread - scroll to bottom
        endRef.current?.scrollIntoView({ behavior: "instant" });
      }, 0);
    }
  }, [messages.length, userLastSeenTs, messages]);

  // Jump to message from search
  useEffect(() => {
    if (jumpToMessageTs) {
      const messageEl = document.querySelector(`[data-ts="${jumpToMessageTs}"]`);
      if (messageEl) {
        messageEl.scrollIntoView({ behavior: "smooth", block: "center" });
        // Highlight the message briefly
        messageEl.classList.add("search-highlight-message");
        setTimeout(() => {
          messageEl.classList.remove("search-highlight-message");
        }, 2000);
        onJumpComplete?.();
      }
    }
  }, [jumpToMessageTs, onJumpComplete]);

  // Auto-scroll to bottom on new messages (only if at latest and user is at bottom)
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !initialScrollDone.current || !isAtLatest) return;

    // Check if user was at the bottom before new messages
    const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (scrollBottom < 100) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [isAtLatest]);

  // Helper to check if scroll button should show (not at bottom)
  const checkScrollButtonVisibility = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = scrollBottom <= 100;
    setShowScrollButton(!atBottom);
    // Notify parent when scroll-at-bottom state changes
    if (atBottom !== wasAtBottomRef.current) {
      wasAtBottomRef.current = atBottom;
      onScrollAtBottomChangeRef.current?.(atBottom);
    }
  }, []);

  // Detect scroll position and trigger load more (bidirectional)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      checkScrollButtonVisibility();

      // Load older when scrolled near top
      if (container.scrollTop < 100 && hasMoreOlder && !loadingOlder && onLoadOlder) {
        scrollHeightBeforeLoadRef.current = { height: container.scrollHeight, direction: "older" };
        onLoadOlder();
      }

      // Load newer when scrolled near bottom (only when not at latest)
      const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (scrollBottom < 100 && hasMoreNewer && !loadingNewer && onLoadNewer && !isAtLatest) {
        scrollHeightBeforeLoadRef.current = { height: container.scrollHeight, direction: "newer" };
        onLoadNewer();
      }
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [
    hasMoreOlder,
    hasMoreNewer,
    loadingOlder,
    loadingNewer,
    onLoadOlder,
    onLoadNewer,
    isAtLatest,
    checkScrollButtonVisibility,
  ]);

  // Also check scroll button visibility when messages change (new messages might push scroll position away from bottom)
  useEffect(() => {
    checkScrollButtonVisibility();
  }, [checkScrollButtonVisibility]);

  // Maintain scroll position after loading more messages
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !scrollHeightBeforeLoadRef.current) return;

    const { height: oldHeight, direction } = scrollHeightBeforeLoadRef.current;
    const newScrollHeight = container.scrollHeight;
    const diff = newScrollHeight - oldHeight;

    if (diff > 0) {
      if (direction === "older") {
        // When loading older messages, keep scroll position relative to old content
        container.scrollTop = diff;
      }
      // For newer messages, no adjustment needed - content is appended below
    }
    scrollHeightBeforeLoadRef.current = null;
  }, []);

  // Handle pending scroll after message jump
  useEffect(() => {
    if (pendingScrollToTs.current && messages.length > 0) {
      const ts = pendingScrollToTs.current;
      pendingScrollToTs.current = null;

      setTimeout(() => {
        const el = document.getElementById(`msg-${ts}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("highlight");
          setTimeout(() => el.classList.remove("highlight"), 2000);
        }
      }, 100);
    }
  }, [messages]);

  const scrollToBottom = useCallback(() => {
    // Clear URL hash to prevent accidental re-scroll on page reload
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }

    // Try to scroll to first unread message if there is one
    if (userLastSeenTs && isAtLatest) {
      const firstUnread = messages.find((m) => m.ts > userLastSeenTs && m.user !== "UHUMAN");
      if (firstUnread) {
        const element = document.querySelector(`[data-ts="${firstUnread.ts}"]`);
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
      }
    }

    // No unread or not at latest - scroll to bottom / jump to latest
    if (isAtLatest) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    } else if (onJumpToLatest) {
      onJumpToLatest();
      setTimeout(() => {
        endRef.current?.scrollIntoView({ behavior: "instant" });
      }, 100);
    }
  }, [isAtLatest, onJumpToLatest, userLastSeenTs, messages]);

  // Track previous channelKey to detect actual channel switches
  const prevChannelKeyRef = useRef<string | undefined>(undefined);
  const scrolledForChannelRef = useRef<Set<string>>(new Set());

  // Scroll to bottom when channel changes or when messages first load for new channel
  useEffect(() => {
    if (!channelKey || messages.length === 0) return;

    const isNewChannel = channelKey !== prevChannelKeyRef.current;
    const hasNotScrolledForThisChannel = !scrolledForChannelRef.current.has(channelKey);

    if (isNewChannel || hasNotScrolledForThisChannel) {
      prevChannelKeyRef.current = channelKey;
      scrolledForChannelRef.current.add(channelKey);

      // Longer delay on first load to ensure DOM is fully rendered
      const timer = setTimeout(() => {
        endRef.current?.scrollIntoView({ behavior: "instant" });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [channelKey, messages.length]);

  // Check if a user is an agent - support both legacy UBOT/UWORKER patterns and new agent_id field
  const isAgent = (user: string) => user === "UBOT" || user.startsWith("UWORKER-");

  // Enhanced check that considers message's agent_id field
  const isAgentMessage = (msg: Message) => isAgent(msg.user) || !!msg.agent_id;

  const getLabel = (user: string, agentId?: string) => {
    // Show agent ID variant if available (e.g., "Claw'd:clawd-2" -> just show agent id)
    if (agentId) return agentId; // Show full agent ID for differentiation
    if (user === "UBOT") return "Claw'd"; // Legacy: generic Claw'd
    if (user.startsWith("UWORKER-")) return user.slice(8); // Just the worker ID
    return "Pilot";
  };
  const formatTime = (ts: string) => {
    const date = new Date(parseFloat(ts) * 1000);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    if (isToday) {
      return time;
    } else if (isYesterday) {
      return `Yesterday`;
    } else {
      // Show just date for older messages (no time)
      return date.toLocaleDateString([], { month: "short", day: "numeric" });
    }
  };

  // Full datetime for tooltip
  const formatFullTime = (ts: string) => {
    const date = new Date(parseFloat(ts) * 1000);
    return date.toLocaleString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Get role label for user
  const getRole = (user: string, agentId?: string) => {
    if (agentId) return "Agent"; // New style agent
    if (user === "UBOT") return "Agent";
    if (user.startsWith("UWORKER-")) return "Worker";
    return "Human";
  };

  const isImageFile = (file: { mimetype?: string; name: string }) => {
    if (file.mimetype) return file.mimetype.startsWith("image/");
    return /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.name);
  };

  // Check if message is a continuation (same author, within 5 minutes)
  const isContinuation = (msg: Message, prevMsg?: Message): boolean => {
    if (!prevMsg) return false;
    if (msg.user !== prevMsg.user) return false;
    // Multi-agent support: different agents should not be combined
    if (msg.agent_id !== prevMsg.agent_id) return false;
    // Streaming/thinking messages are never continuations
    if (msg.is_streaming || msg.ts.startsWith("thinking_")) return false;
    const currentTime = parseFloat(msg.ts) * 1000;
    const prevTime = parseFloat(prevMsg.ts) * 1000;
    // Handle non-numeric timestamps gracefully
    if (Number.isNaN(currentTime) || Number.isNaN(prevTime)) return false;
    const FIVE_MINUTES = 5 * 60 * 1000;
    return currentTime - prevTime < FIVE_MINUTES;
  };

  // Note: lastSeenUserTs was used for single-agent seen indicator
  // Now using seen_by array from API for multi-agent support
  // Keeping agentLastSeenTs prop for backwards compatibility but not using it
  void agentLastSeenTs;

  // Copy message reference to clipboard
  const copyReference = useCallback((ts: string, event: React.MouseEvent<HTMLButtonElement>) => {
    const ref = `@msg:${ts}`;
    navigator.clipboard.writeText(ref);

    // Add animation class
    const btn = event.currentTarget;
    btn.classList.add("copied");
    setTimeout(() => btn.classList.remove("copied"), 400);
  }, []);

  // Copy agent ID to clipboard when clicking avatar
  const copyMention = useCallback((agentId: string | undefined, event: React.MouseEvent<HTMLDivElement>) => {
    // Just copy the plain agent_id
    const textToCopy = agentId || "Clawd";
    navigator.clipboard.writeText(textToCopy);

    // Add animation class to avatar container
    const el = event.currentTarget;
    el.classList.add("copied");
    setTimeout(() => el.classList.remove("copied"), 400);
  }, []);

  // Scroll to a specific message (with fetch if needed)
  const scrollToMessage = useCallback(
    async (ts: string) => {
      const el = document.getElementById(`msg-${ts}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        // Highlight briefly
        el.classList.add("highlight");
        setTimeout(() => el.classList.remove("highlight"), 2000);
      } else if (onJumpToMessage) {
        // Message not in DOM - need to fetch it
        pendingScrollToTs.current = ts;
        await onJumpToMessage(ts);
      }
    },
    [onJumpToMessage],
  );

  // Handle URL hash navigation on mount
  useEffect(() => {
    const hash = window.location.hash;
    if (hash?.startsWith("#")) {
      const ts = hash.slice(1);
      // Delay to ensure messages are rendered
      setTimeout(() => scrollToMessage(ts), 500);
    }
  }, [scrollToMessage]);

  // Process message text to convert @msg:ts references to clickable links
  const processMessageText = useCallback((text: string) => {
    // Decode HTML entities in a single pass to avoid double-decode issues
    const entityMap: Record<string, string> = {
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&#39;": "'",
      "&nbsp;": " ",
      "&amp;": "&",
    };
    let processed = text.replace(/&(?:lt|gt|quot|nbsp|amp|#39);/g, (m) => entityMap[m] ?? m);

    // Convert HTML <a> tags to markdown links
    processed = processed.replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, (_, href, linkText) => {
      return `[${linkText}](${href})`;
    });
    // Convert @msg: references to markdown links
    processed = processed.replace(/@msg:(\d+\.\d+)/g, (_, ts) => {
      return `[@msg:${ts}](#${ts})`;
    });
    return processed;
  }, []);

  // Handle clicks on message reference links
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "A" && target.getAttribute("href")?.startsWith("#")) {
        e.preventDefault();
        const ts = target.getAttribute("href")?.slice(1);
        if (ts) {
          scrollToMessage(ts);
          // Update URL without reloading
          window.history.pushState(null, "", `#${ts}`);
        }
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [scrollToMessage]);

  // Find the index of the first unread message (only one separator should show)
  // Memoize to avoid O(n) search on every render
  const firstUnreadIndex = useMemo(() => {
    if (!userLastSeenTs || messages.length === 0) return -1;
    return messages.findIndex((m) => m.ts > userLastSeenTs && m.user !== "UHUMAN");
  }, [messages, userLastSeenTs]);

  // This should not be reached as App redirects empty spaces to home
  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="messages" ref={containerRef}>
      {loadingOlder && (
        <div className="loading-more">
          <div className="loading-spinner"></div>
          <span>Loading older messages...</span>
        </div>
      )}
      {messages.map((msg, index) => {
        const prevMsg = index > 0 ? messages[index - 1] : undefined;
        const continuation = isContinuation(msg, prevMsg);
        const isSystemMessage = msg.subtype === "channel_join" || msg.subtype === "bot_message";

        // Show separator only before the first unread message
        const showUnreadSeparator = index === firstUnreadIndex;

        // System messages (join, notifications) render differently
        if (isSystemMessage) {
          return (
            <React.Fragment key={msg.ts}>
              {showUnreadSeparator && <UnreadSeparator />}
              <div className="message-system" data-ts={msg.ts} data-user={msg.user}>
                <span className="message-system-text">{msg.text}</span>
              </div>
            </React.Fragment>
          );
        }

        // Check if this is a streaming message (agent is actively typing)
        // Exclude article messages from streaming state
        const isStreaming = isAgentMessage(msg) && msg.is_streaming === true && !msg.article && !msg.subspace;
        const isThinkingPlaceholder = msg.ts.startsWith("thinking_");

        return (
          <React.Fragment key={msg.ts}>
            {showUnreadSeparator && <UnreadSeparator />}
            <div
              id={`msg-${msg.ts}`}
              data-ts={msg.ts}
              data-user={msg.user}
              className={`message ${isAgentMessage(msg) ? "agent" : "user"} ${continuation ? "continuation" : ""} ${isStreaming ? "thinking" : ""}`}
              title={continuation ? formatFullTime(msg.ts) : undefined}
              data-time={continuation ? formatTime(msg.ts) : undefined}
              onContextMenu={(e) => handleMessageContextMenu(e, msg)}
              onTouchStart={(e) => handleTouchStart(e, msg)}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchEnd}
            >
              {!isThinkingPlaceholder && (
                <button
                  className="message-link-btn"
                  onClick={(e) => copyReference(msg.ts, e)}
                  title="Copy message link"
                >
                  <LinkIcon />
                </button>
              )}
              <div
                className={`message-avatar ${!continuation && isAgentMessage(msg) ? "clickable" : ""}`}
                title={
                  continuation
                    ? undefined
                    : isAgentMessage(msg)
                      ? "Click to copy agent ID"
                      : getRole(msg.user, msg.agent_id)
                }
                onClick={!continuation && isAgentMessage(msg) ? (e) => copyMention(msg.agent_id, e) : undefined}
              >
                {continuation ? null : // Render avatar based on agent type - support both legacy and new patterns
                isAgentMessage(msg) ? (
                  msg.user.startsWith("UWORKER-") && !msg.avatar_color ? (
                    <WorkerClawdAvatar />
                  ) : (
                    <ClawdAvatar
                      sleeping={(agentSleeping || msg.is_sleeping || false) && !isStreaming}
                      streaming={isStreaming}
                      color={msg.avatar_color}
                    />
                  )
                ) : (
                  <UserAvatar />
                )}
              </div>
              <div className="message-body">
                {!continuation && (
                  <div className="message-header">
                    <span className="message-sender">{getLabel(msg.user, msg.agent_id)}</span>
                    <span
                      className="message-time"
                      title={isStreaming && !msg.article ? undefined : formatFullTime(msg.ts)}
                    >
                      {isStreaming && !msg.article ? "Thinking..." : formatTime(msg.ts)}
                    </span>
                  </div>
                )}
                {/* Thinking tokens section - collapsible for streaming messages */}
                {msg.thinking_text && (
                  <details className="thinking-section" open={isStreaming}>
                    <summary className="thinking-summary">
                      <span className="thinking-label">Thinking</span>
                      <span className="thinking-length">{msg.thinking_text.length} chars</span>
                    </summary>
                    <div className="thinking-content">
                      <pre>{msg.thinking_text}</pre>
                    </div>
                  </details>
                )}
                {(() => {
                  const isExpanded = expandedMessages.has(msg.ts);
                  const isArticleMessage = msg.subtype === "article";
                  const isSubspaceMessage = !!msg.subspace;
                  // Always parse blocks from FULL text — slicing before parsing breaks fenced blocks
                  // whose closing ``` falls outside the slice window.
                  const decodedText = processMessageText(msg.text);
                  // Coarse memo: streaming messages re-parse every 500 chars to reduce parse frequency.
                  // Non-streaming messages re-parse on every char change (exact key).
                  const blockCacheKey = msg.is_streaming
                    ? `${msg.ts}-${Math.floor(decodedText.length / 500)}`
                    : `${msg.ts}-${decodedText.length}`;
                  const cachedEntry = blockParseCacheRef.current.get(msg.ts);
                  const blocks: MessageBlock[] =
                    cachedEntry && cachedEntry.key === blockCacheKey
                      ? cachedEntry.blocks
                      : (() => {
                          const parsed = parseMessageBlocks(decodedText, isStreaming, isAgentMessage(msg));
                          blockParseCacheRef.current.set(msg.ts, { key: blockCacheKey, blocks: parsed });
                          if (blockParseCacheRef.current.size > 500) {
                            const firstKey = blockParseCacheRef.current.keys().next().value;
                            if (firstKey) blockParseCacheRef.current.delete(firstKey);
                          }
                          return parsed;
                        })();
                  // For multi-block messages: no collapsing needed — each block is already compact.
                  // For single long-text messages: truncate the text content when collapsed.
                  const singleTextBlock = blocks.length === 1 && blocks[0].type === "text";
                  // Use decoded content length (not raw msg.text) to match the actual truncation boundary.
                  // blocks[0].type === "text" repeats singleTextBlock for TypeScript union narrowing.
                  const isLong =
                    singleTextBlock &&
                    blocks[0].type === "text" &&
                    blocks[0].content.length > MESSAGE_COLLAPSE_THRESHOLD;
                  const visibleBlocks: MessageBlock[] =
                    isLong && !isExpanded && blocks[0].type === "text"
                      ? [{ type: "text", content: `${blocks[0].content.slice(0, MESSAGE_COLLAPSE_THRESHOLD)}...` }]
                      : blocks;

                  return (
                    <>
                      {isArticleMessage || isSubspaceMessage ? null : (
                        <div className="message-content">
                          {visibleBlocks.map((block, i) => {
                            switch (block.type) {
                              case "text":
                                return (
                                  <div key={`block-${i}`} className="message-block">
                                    <Markdown
                                      remarkPlugins={[remarkGfm, remarkMath]}
                                      rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema], rehypeKatex]}
                                      components={MARKDOWN_COMPONENTS}
                                    >
                                      {block.content}
                                    </Markdown>
                                  </div>
                                );
                              case "code": {
                                const hl = block.lang ? highlightCode(block.content, block.lang) : null;
                                return (
                                  <div key={`block-${i}`} className="message-block">
                                    <PreBlock>
                                      {hl ? (
                                        <code
                                          className={`language-${block.lang}`}
                                          dangerouslySetInnerHTML={{ __html: hl }}
                                        />
                                      ) : (
                                        <code className={block.lang ? `language-${block.lang}` : "language-text"}>
                                          {block.content}
                                        </code>
                                      )}
                                    </PreBlock>
                                  </div>
                                );
                              }
                              case "mermaid":
                                return (
                                  <div key={`block-${i}`} className="message-block message-mermaid-card">
                                    <LazyViewport
                                      height={200}
                                      fallback={<div className="mermaid-placeholder">Loading diagram...</div>}
                                    >
                                      <MermaidDiagram chart={block.content} onZoom={(svg) => setMermaidZoom(svg)} />
                                    </LazyViewport>
                                  </div>
                                );
                              case "image":
                                return (
                                  <div
                                    key={`block-${i}`}
                                    className="message-block message-image-card"
                                    onClick={() => setLightboxImage({ src: block.src, alt: block.alt || "" })}
                                    onKeyDown={(e) =>
                                      e.key === "Enter" && setLightboxImage({ src: block.src, alt: block.alt || "" })
                                    }
                                    role="button"
                                    tabIndex={0}
                                    style={{ cursor: "pointer" }}
                                  >
                                    <img src={block.src} alt={block.alt} />
                                    {block.alt && <p className="image-card-alt">{block.alt}</p>}
                                  </div>
                                );
                              case "iframe":
                                return (
                                  <div key={`block-${i}`} className="message-block">
                                    <IframePreviewCard
                                      src={block.src}
                                      rawHtml={block.rawHtml}
                                      height={block.height}
                                      width={block.width}
                                    />
                                  </div>
                                );
                              case "embed":
                                return (
                                  <div key={`block-${i}`} className="message-block">
                                    <div
                                      className="artifact-preview-card artifact-preview-card--embed"
                                      role="button"
                                      tabIndex={0}
                                      aria-label={`Embedded content: ${block.title}. Click to open`}
                                      onClick={() =>
                                        onOpenSidebar?.({
                                          title: block.title,
                                          type: "iframe",
                                          url: block.url,
                                        })
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          onOpenSidebar?.({
                                            title: block.title,
                                            type: "iframe",
                                            url: block.url,
                                          });
                                        }
                                      }}
                                    >
                                      <div
                                        className="artifact-preview-badge"
                                        style={{ background: "hsl(220 70% 55%)" }}
                                      >
                                        {"<>"}
                                      </div>
                                      <div className="artifact-preview-content">
                                        <div className="artifact-preview-title">{block.title}</div>
                                        <div className="artifact-preview-thumbnail">
                                          <span className="artifact-preview-meta">{block.url}</span>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              case "artifact":
                                // chart and svg render inline; all other types use preview card + modal
                                if (block.artifactType === "chart") {
                                  return (
                                    <div key={`block-${i}`} className="message-block">
                                      <div className="message-inline-artifact">
                                        <div className="message-inline-artifact-header">
                                          <span className="message-inline-artifact-title">{block.title}</span>
                                          <div className="message-inline-artifact-actions">
                                            <InlineArtifactCopyBtn content={block.content} />
                                          </div>
                                        </div>
                                        <div className="message-inline-artifact-body">
                                          <React.Suspense
                                            fallback={
                                              <div className="message-inline-artifact-loading">Loading chart...</div>
                                            }
                                          >
                                            <LazyChartRenderer content={block.content} />
                                          </React.Suspense>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                }
                                if (block.artifactType === "svg") {
                                  const sanitizedSvg = DOMPurify.sanitize(block.content, {
                                    USE_PROFILES: { svg: true, svgFilters: true },
                                    ADD_TAGS: ["use"],
                                  });
                                  return (
                                    <div key={`block-${i}`} className="message-block">
                                      <div className="message-inline-artifact">
                                        <div className="message-inline-artifact-header">
                                          <span className="message-inline-artifact-title">{block.title}</span>
                                          <div className="message-inline-artifact-actions">
                                            <InlineArtifactCopyBtn content={block.content} title="Copy SVG" />
                                          </div>
                                        </div>
                                        <div
                                          className="message-inline-artifact-body artifact-renderer-svg"
                                          dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
                                        />
                                      </div>
                                    </div>
                                  );
                                }
                                // Code artifacts render inline like code fences (not sidebar)
                                if (block.artifactType === "code") {
                                  const codeHl = block.language ? highlightCode(block.content, block.language) : null;
                                  return (
                                    <div key={`block-${i}`} className="message-block">
                                      <PreBlock>
                                        {codeHl ? (
                                          <code
                                            className={`language-${block.language}`}
                                            dangerouslySetInnerHTML={{ __html: codeHl }}
                                          />
                                        ) : (
                                          <code
                                            className={block.language ? `language-${block.language}` : "language-text"}
                                          >
                                            {block.content}
                                          </code>
                                        )}
                                      </PreBlock>
                                    </div>
                                  );
                                }
                                return (
                                  <div key={`block-${i}`} className="message-block">
                                    <LazyViewport height={60}>
                                      <ArtifactPreviewCard
                                        type={block.artifactType}
                                        title={block.title}
                                        content={block.content}
                                        language={block.language}
                                        onOpenSidebar={
                                          onOpenSidebar
                                            ? (t, at, c, lang) =>
                                                onOpenSidebar({
                                                  title: t,
                                                  type: "artifact",
                                                  artifactType: at,
                                                  content: c,
                                                  language: lang,
                                                })
                                            : undefined
                                        }
                                      />
                                    </LazyViewport>
                                  </div>
                                );
                              case "streaming-artifact":
                                // chart and svg streaming: show skeleton header + animated body
                                if (block.artifactType === "chart" || block.artifactType === "svg") {
                                  return (
                                    <div key={`block-${i}`} className="message-block">
                                      <div className="message-inline-artifact message-inline-artifact--streaming">
                                        <div className="message-inline-artifact-header">
                                          <span className="message-inline-artifact-title">
                                            {block.title || "Generating..."}
                                          </span>
                                        </div>
                                        <div className="message-inline-artifact-body" />
                                      </div>
                                    </div>
                                  );
                                }
                                return (
                                  <div key={`block-${i}`} className="message-block">
                                    <StreamingArtifactCard
                                      artifactType={block.artifactType}
                                      title={block.title}
                                      partialContent={block.partialContent}
                                    />
                                  </div>
                                );
                            }
                          })}
                        </div>
                      )}
                      {isLong && !isArticleMessage && !isSubspaceMessage && (
                        <span className="message-expand-toggle" onClick={() => toggleExpanded(msg.ts)}>
                          {isExpanded ? "Less" : "More"}
                        </span>
                      )}
                    </>
                  );
                })()}
                {msg.html_preview && <HtmlPreview html={msg.html_preview} />}
                {msg.code_preview && (
                  <CodePreview
                    filename={msg.code_preview.filename}
                    language={msg.code_preview.language}
                    content={msg.code_preview.content}
                    startLine={msg.code_preview.start_line}
                    highlightLines={msg.code_preview.highlight_lines}
                  />
                )}
                {msg.article && (
                  <div
                    className="message-article-card"
                    onClick={() => window.open(`/articles/${msg.article!.id}`, "_blank")}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && window.open(`/articles/${msg.article!.id}`, "_blank")}
                  >
                    {msg.article.thumbnail_url && (
                      <div className="article-card-thumbnail">
                        <img src={msg.article.thumbnail_url} alt={msg.article.title} />
                      </div>
                    )}
                    <div className="article-card-content">
                      <div className="article-card-title">{msg.article.title}</div>
                      {msg.article.description && (
                        <div className="article-card-description">{msg.article.description}</div>
                      )}
                    </div>
                  </div>
                )}
                {msg.subspace && (
                  <div
                    className={`message-subspace-card ${msg.subspace.status === "failed" || msg.subspace.status === "timed_out" ? "subspace-card-failed" : msg.subspace.status === "completed" ? "subspace-card-completed" : ""}`}
                    onClick={() => (window.location.href = `/${msg.subspace!.channel}/${msg.subspace!.id}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) =>
                      e.key === "Enter" && (window.location.href = `/${msg.subspace!.channel}/${msg.subspace!.id}`)
                    }
                  >
                    <div className="subspace-card-icon">
                      <ClawdAvatar />
                    </div>
                    <div className="subspace-card-content">
                      <div className="subspace-card-title">{msg.subspace.title}</div>
                      {msg.subspace.description && (
                        <div className="subspace-card-description">{msg.subspace.description}</div>
                      )}
                    </div>
                  </div>
                )}
                {msg.workspace &&
                  (() => {
                    const openWorkspaceDesktop = () => {
                      const rawId = msg.workspace!.workspace_id;
                      const wsId = encodeURIComponent(rawId);
                      window.open(
                        `/workspace/${wsId}/novnc/vnc.html?autoconnect=1&reconnect=1&reconnect_delay=2000&resize=scale&path=${encodeURIComponent(`workspace/${rawId}/novnc/websockify`)}`,
                        "_blank",
                      );
                    };
                    return (
                      <div
                        className={`message-workspace-card ${msg.workspace.status === "completed" ? "workspace-card-completed" : msg.workspace.status === "waiting" ? "workspace-card-waiting" : "workspace-card-running"}`}
                        onClick={openWorkspaceDesktop}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") openWorkspaceDesktop();
                        }}
                      >
                        <div className="workspace-card-content">
                          <div className="workspace-card-title">{msg.workspace.title}</div>
                          {msg.workspace.description && (
                            <div className="workspace-card-description">{msg.workspace.description}</div>
                          )}
                          <div className="workspace-card-action">Open Desktop →</div>
                        </div>
                      </div>
                    );
                  })()}
                {msg.tool_result && <ToolResultCard toolResult={msg.tool_result} />}
                {msg.files && msg.files.length > 0 && (
                  <div className="message-files">
                    {msg.files.map((file) => {
                      if (isImageFile(file)) {
                        // Images: inline preview only, click opens lightbox (no duplicate preview card)
                        return (
                          <div
                            key={file.id}
                            className="message-image-link"
                            onClick={() => setLightboxImage({ src: file.url_private, alt: file.name })}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) =>
                              e.key === "Enter" && setLightboxImage({ src: file.url_private, alt: file.name })
                            }
                          >
                            <img src={file.url_private} alt={file.name} className="message-image" />
                          </div>
                        );
                      }
                      if (isPreviewableFile(file)) {
                        return (
                          <FilePreviewCard
                            key={file.id}
                            file={file}
                            onClick={() =>
                              onOpenSidebar?.({
                                title: file.name,
                                type: "file",
                                url: file.url_private,
                                fileType: file.mimetype ?? "",
                              })
                            }
                          />
                        );
                      }
                      return (
                        <a
                          key={file.id}
                          href={file.url_private}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="message-file"
                        >
                          {file.name}
                        </a>
                      );
                    })}
                  </div>
                )}
                {/* Reactions hidden for now - uncomment when emoji conversion is implemented
              {msg.reactions && msg.reactions.length > 0 && (
                <div className="message-reactions">
                  {msg.reactions.map((r) => (
                    <span key={r.name} className="reaction">
                      :{r.name}: {r.count}
                    </span>
                  ))}
                </div>
              )}
              */}
                {/* Seen indicator - shows small Claw'd icons for agents whose LAST read message is this one */}
                {/* Shows on any message (user or other agents) - an agent's indicator appears on the last non-self message they've seen */}
                {msg.seen_by && msg.seen_by.length > 0 && (
                  <div className="message-seen">
                    {[...msg.seen_by]
                      .sort((a, b) => a.agent_id.localeCompare(b.agent_id))
                      .map((agent) => {
                        const isAgentStreaming = streamingAgentIds.includes(agent.agent_id);
                        const effectivelySleeping = agent.is_sleeping && !isAgentStreaming;
                        return (
                          <span
                            key={agent.agent_id}
                            className={`seen-icon ${effectivelySleeping ? "sleeping" : ""}`}
                            title={`Seen by ${agent.agent_id}${effectivelySleeping ? " (sleeping)" : ""}`}
                          >
                            <ClawdSeenIcon color={agent.avatar_color} isSleeping={effectivelySleeping} />
                          </span>
                        );
                      })}
                  </div>
                )}
              </div>
            </div>
          </React.Fragment>
        );
      })}

      {/* Pending messages (optimistic UI) */}
      {pendingMessages.map((pendingMsg) => (
        <div key={pendingMsg.id} className={`message user pending ${pendingMsg.status}`}>
          {pendingMsg.status === "failed" && onRetryMessage && (
            <button className="message-retry-btn" onClick={() => onRetryMessage(pendingMsg)} title="Edit and retry">
              <EditIcon />
            </button>
          )}
          <div className="message-avatar">
            <UserAvatar />
          </div>
          <div className="message-body">
            <div className="message-header">
              <span className="message-sender">Pilot</span>
              <span className="message-time">{pendingMsg.status === "sending" ? "Sending..." : "Failed"}</span>
            </div>
            <div className="message-content">
              <p>{pendingMsg.text}</p>
            </div>
            {pendingMsg.files && pendingMsg.files.length > 0 && (
              <div className="message-files pending-files">
                {pendingMsg.files.map((file, idx) => (
                  <span key={idx} className="pending-file">
                    {file.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
      {loadingNewer && (
        <div className="loading-more loading-newer">
          <div className="loading-spinner"></div>
          <span>Loading newer messages...</span>
        </div>
      )}
      <div ref={endRef} />
      {showScrollButton &&
        createPortal(
          <button
            className={`scroll-to-bottom${hasActiveChannelUnread ? " has-unread" : ""}`}
            onClick={scrollToBottom}
            title={isAtLatest ? "Scroll to latest" : "Jump to latest"}
          >
            <ArrowDownIcon />
          </button>,
          document.querySelector(".messages-wrapper") || document.body,
        )}
      {/* Image lightbox modal */}
      {lightboxImage &&
        createPortal(
          <div
            className="lightbox-overlay"
            onClick={() => {
              setLightboxImage(null);
              setLightboxZoom(1);
            }}
            onKeyDown={(e) => e.key === "Escape" && (setLightboxImage(null), setLightboxZoom(1))}
            onWheel={(e) => {
              e.preventDefault();
              setLightboxZoom((z) => Math.min(4, Math.max(0.25, z + (e.deltaY > 0 ? -0.1 : 0.1))));
            }}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
          >
            <button
              className="lightbox-close"
              onClick={() => {
                setLightboxImage(null);
                setLightboxZoom(1);
              }}
              aria-label="Close"
            >
              ×
            </button>
            <div
              style={{
                transform: `scale(${lightboxZoom})`,
                transformOrigin: "center center",
                transition: "transform 0.2s",
              }}
            >
              <img
                src={lightboxImage.src}
                alt={lightboxImage.alt}
                className="lightbox-image"
                onClick={(e) => e.stopPropagation()}
              />
            </div>
            <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
              <button
                className="lightbox-btn"
                onClick={() => setLightboxZoom((z) => Math.max(0.25, z - 0.25))}
                title="Zoom out"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="7" y1="11" x2="15" y2="11" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
              <span className="lightbox-zoom-level">{Math.round(lightboxZoom * 100)}%</span>
              <button
                className="lightbox-btn"
                onClick={() => setLightboxZoom((z) => Math.min(4, z + 0.25))}
                title="Zoom in"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="11" y1="7" x2="11" y2="15" />
                  <line x1="7" y1="11" x2="15" y2="11" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
              <button className="lightbox-btn" onClick={() => setLightboxZoom(1)} title="Reset zoom">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 4v6h6M23 20v-6h-6" />
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
                </svg>
              </button>
            </div>
            <a
              href={lightboxImage.src}
              target="_blank"
              rel="noopener noreferrer"
              className="lightbox-open-new"
              onClick={(e) => e.stopPropagation()}
            >
              Open in new tab ↗
            </a>
          </div>,
          document.body,
        )}
      {/* Mermaid zoom modal — supports 20x zoom + drag-to-pan */}
      {mermaidZoom &&
        createPortal(
          <div
            className="lightbox-overlay"
            onClick={() => {
              if (!isDragging) {
                setMermaidZoom(null);
                setLightboxZoom(1);
                setDragOffset({ x: 0, y: 0 });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setMermaidZoom(null);
                setLightboxZoom(1);
                setDragOffset({ x: 0, y: 0 });
              }
            }}
            onWheel={(e) => {
              e.preventDefault();
              setLightboxZoom((z) => Math.min(20, Math.max(0.25, z + (e.deltaY > 0 ? -0.25 : 0.25))));
            }}
            onMouseDown={(e) => {
              if (lightboxZoom > 1 && e.button === 0) {
                setIsDragging(true);
                dragStart.current = { x: e.clientX, y: e.clientY, ox: dragOffset.x, oy: dragOffset.y };
                e.preventDefault();
              }
            }}
            onMouseMove={(e) => {
              if (isDragging) {
                setDragOffset({
                  x: dragStart.current.ox + (e.clientX - dragStart.current.x),
                  y: dragStart.current.oy + (e.clientY - dragStart.current.y),
                });
              }
            }}
            onMouseUp={() => setIsDragging(false)}
            onMouseLeave={() => setIsDragging(false)}
            role="dialog"
            aria-modal="true"
            aria-label="Diagram zoom"
            tabIndex={-1}
            style={{ cursor: lightboxZoom > 1 ? (isDragging ? "grabbing" : "grab") : "default" }}
          >
            <button
              className="lightbox-close"
              onClick={(e) => {
                e.stopPropagation();
                setMermaidZoom(null);
                setLightboxZoom(1);
                setDragOffset({ x: 0, y: 0 });
              }}
              aria-label="Close"
            >
              ×
            </button>
            <div
              style={{
                transform: `scale(${lightboxZoom}) translate(${dragOffset.x / lightboxZoom}px, ${dragOffset.y / lightboxZoom}px)`,
                transformOrigin: "center center",
                transition: isDragging ? "none" : "transform 0.2s",
              }}
            >
              <div
                className="lightbox-mermaid"
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(mermaidZoom, {
                    USE_PROFILES: { svg: true, svgFilters: true },
                    ADD_TAGS: ["use"],
                  }),
                }}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
            <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
              <button
                className="lightbox-btn"
                onClick={() => setLightboxZoom((z) => Math.max(0.25, z - 0.5))}
                title="Zoom out"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="7" y1="11" x2="15" y2="11" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
              <span className="lightbox-zoom-level">{Math.round(lightboxZoom * 100)}%</span>
              <button
                className="lightbox-btn"
                onClick={() => setLightboxZoom((z) => Math.min(20, z + 0.5))}
                title="Zoom in"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="11" y1="7" x2="11" y2="15" />
                  <line x1="7" y1="11" x2="15" y2="11" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
              <button
                className="lightbox-btn"
                onClick={() => {
                  setLightboxZoom(1);
                  setDragOffset({ x: 0, y: 0 });
                }}
                title="Reset zoom & position"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 4v6h6M23 20v-6h-6" />
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
                </svg>
              </button>
            </div>
          </div>,
          document.body,
        )}
      {/* Context menu */}
      {contextMenu && <MessageContextMenu menu={contextMenu} onClose={closeContextMenu} />}
    </div>
  );
}
