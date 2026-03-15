// ArtifactPreviewCard — compact inline card shown in chat messages for artifact blocks.
// StreamingArtifactCard — live streaming state card shown during agent artifact generation.
// Both follow the .message-article-card UX pattern from MessageList.tsx.

import DOMPurify from "dompurify";
import React, { useEffect, useRef, useState } from "react";
import { ArtifactModal } from "./artifact-modal";

export type ArtifactType = "html" | "react" | "svg" | "chart" | "csv" | "markdown" | "code";

const TYPE_CONFIG: Record<ArtifactType, { label: string; icon: string; color: string }> = {
  html:     { label: "HTML",     icon: "</>", color: "hsl(15 80% 55%)" },
  react:    { label: "React",    icon: "R",   color: "hsl(200 80% 55%)" },
  svg:      { label: "SVG",      icon: "S",   color: "hsl(45 80% 50%)" },
  chart:    { label: "Chart",    icon: "C",   color: "hsl(160 60% 45%)" },
  csv:      { label: "CSV",      icon: "T",   color: "hsl(280 50% 55%)" },
  markdown: { label: "Markdown", icon: "M",   color: "hsl(220 15% 50%)" },
  code:     { label: "Code",     icon: "#",   color: "hsl(35 80% 50%)" },
};

// Extension map for download filenames
export const ARTIFACT_EXTENSION_MAP: Record<ArtifactType, string> = {
  html:     ".html",
  react:    ".tsx",
  svg:      ".svg",
  chart:    ".json",
  csv:      ".csv",
  markdown: ".md",
  code:     ".txt",
};

// Type-specific thumbnail preview shown in the compact card
function ArtifactThumbnail({
  type,
  content,
}: {
  type: ArtifactType;
  content: string;
}) {
  switch (type) {
    case "code":
      return (
        <pre className="artifact-preview-code">
          <code>{content.split("\n").slice(0, 3).join("\n")}</code>
        </pre>
      );
    case "chart":
      return <span className="artifact-preview-meta">Chart</span>;
    case "html":
    case "react":
      return <span className="artifact-preview-badge-interactive">Interactive</span>;
    case "svg": {
      const safe = DOMPurify.sanitize(content, { USE_PROFILES: { svg: true } });
      return (
        <div
          className="artifact-preview-svg"
          dangerouslySetInnerHTML={{ __html: safe }}
        />
      );
    }
    case "csv": {
      const lines = content.trim().split("\n");
      const cols = (lines[0] || "").split(",").length;
      return (
        <span className="artifact-preview-meta">
          {lines.length} rows x {cols} cols
        </span>
      );
    }
    case "markdown":
      return (
        <span className="artifact-preview-meta">
          {content.split("\n")[0]}
        </span>
      );
    default:
      return null;
  }
}

// Props for the completed-artifact preview card
export interface ArtifactPreviewCardProps {
  type: ArtifactType;
  title: string;
  content: string;
  isStreaming?: boolean;
  lineCount?: number;
  language?: string;
}

// Compact card always shown in-message; click opens ArtifactModal overlay
export function ArtifactPreviewCard({
  type,
  title,
  content,
  isStreaming = false,
  lineCount,
  language,
}: ArtifactPreviewCardProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const config = TYPE_CONFIG[type] ?? TYPE_CONFIG.code;

  const handleClick = () => {
    if (!isStreaming) setModalOpen(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <>
      <div
        className={`artifact-preview-card${isStreaming ? " artifact-preview-card--streaming" : ""}`}
        role="button"
        tabIndex={isStreaming ? -1 : 0}
        aria-label={`${config.label} artifact: ${title}. ${isStreaming ? "Generating..." : "Click to open"}`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <div className="artifact-preview-badge" style={{ background: config.color }}>
          {config.icon}
        </div>
        <div className="artifact-preview-content">
          <div className="artifact-preview-title">{title}</div>
          {isStreaming ? (
            <div className="artifact-preview-streaming">
              <div className="loading-spinner" />
              <span>Generating...{lineCount != null ? ` (${lineCount} lines)` : ""}</span>
            </div>
          ) : (
            <div className="artifact-preview-thumbnail">
              <ArtifactThumbnail type={type} content={content} />
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

// Props for the streaming state card
export interface StreamingArtifactCardProps {
  artifactType: ArtifactType;
  title: string;
  partialContent: string;
}

// Live preview card shown while artifact is still streaming in
const PREVIEW_TAIL_LIMIT = 5000;

export function StreamingArtifactCard({
  artifactType,
  title,
  partialContent,
}: StreamingArtifactCardProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const config = TYPE_CONFIG[artifactType] ?? TYPE_CONFIG.code;

  // Auto-scroll preview to bottom as content streams in
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [partialContent]);

  const displayContent =
    partialContent.length > PREVIEW_TAIL_LIMIT
      ? `... (${Math.round(partialContent.length / 1024)}KB generated)\n\n${partialContent.slice(-PREVIEW_TAIL_LIMIT)}`
      : partialContent;

  return (
    <div className="artifact-card artifact-card--streaming">
      <div className="artifact-card-header artifact-card-header--streaming">
        <span
          className="artifact-card-type-badge"
          style={{ backgroundColor: config.color }}
        >
          {config.label}
        </span>
        <span className="artifact-card-title">{title}</span>
        <span className="artifact-card-streaming-indicator">
          <span className="artifact-card-spinner" />
          Generating...
        </span>
      </div>
      <div className="artifact-card-body artifact-card-body--streaming">
        <pre className="artifact-card-preview">
          <code>{displayContent}</code>
        </pre>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
