// SidebarPanel — slide-out panel on the right side for rich/external content.
// Supports two display modes:
//   "iframe" — sandboxed iframe for external URLs (Google Docs, Figma, Atlassian, etc.)
//   "artifact" — ArtifactRenderer for html/react/csv/markdown/code content

import { useEffect, useRef, Fragment } from "react";
import { createPortal } from "react-dom";
import FullArtifactRenderer from "./artifact-renderer";
import { type ArtifactType, TYPE_CONFIG } from "./artifact-types";

export interface SidebarPanelContent {
  title: string;
  type: "iframe" | "artifact";
  url?: string;
  content?: string;
  artifactType?: ArtifactType;
  language?: string;
}

interface SidebarPanelProps extends SidebarPanelContent {
  isOpen: boolean;
  onClose: () => void;
}

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default function SidebarPanel({
  isOpen,
  onClose,
  title,
  type,
  url,
  content,
  artifactType,
  language,
}: SidebarPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape key closes panel
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // Focus panel on open for keyboard accessibility
  useEffect(() => {
    if (isOpen) {
      panelRef.current?.focus();
    }
  }, [isOpen]);

  const config = artifactType ? (TYPE_CONFIG[artifactType] ?? TYPE_CONFIG.code) : null;

  return (
    <Fragment>
      {isOpen && createPortal(<div className="sidebar-backdrop" onClick={onClose} aria-hidden="true" />, document.body)}
      <div
        ref={panelRef}
        className={`sidebar-panel${isOpen ? " open" : ""}`}
        role="complementary"
        aria-label={`${title} panel`}
        tabIndex={-1}
      >
        <div className="sidebar-panel-header">
          <div className="sidebar-panel-header-left">
            {config && (
              <span className="sidebar-panel-type-badge" style={{ background: config.color }}>
                {config.icon}
              </span>
            )}
            {type === "iframe" && !config && (
              <span className="sidebar-panel-type-badge sidebar-panel-type-badge--embed">{"</>"}</span>
            )}
            <span className="sidebar-panel-title">{title}</span>
          </div>
          <button className="sidebar-panel-close-btn" onClick={onClose} aria-label="Close sidebar" title="Close (Esc)">
            <CloseIcon />
          </button>
        </div>
        <div className="sidebar-panel-body">
          {isOpen && type === "iframe" && url && (
            <iframe
              src={url}
              title={title}
              className="sidebar-panel-iframe"
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin"
            />
          )}
          {isOpen && type === "artifact" && content !== undefined && artifactType && (
            <div className="sidebar-panel-artifact">
              <FullArtifactRenderer artifactType={artifactType} content={content} language={language} />
            </div>
          )}
        </div>
      </div>
    </Fragment>
  );
}
