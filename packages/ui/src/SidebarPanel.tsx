// SidebarPanel — slide-out panel on the right side for rich/external content.
// Supports three display modes:
//   "iframe"    — sandboxed iframe for external URLs (Google Docs, Figma, etc.)
//   "artifact"  — ArtifactRenderer for html/react/csv/markdown/code content
//   "file"      — FilePreviewSidebar for PDF/CSV/text/code/image/audio/video files

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import FullArtifactRenderer from "./artifact-renderer";
import { type ArtifactType, TYPE_CONFIG } from "./artifact-types";
import { FilePreviewSidebar } from "./file-preview";

export interface SidebarPanelContent {
  title: string;
  type: "iframe" | "artifact" | "file";
  url?: string;
  content?: string;
  artifactType?: ArtifactType;
  language?: string;
  /** mimetype for type === "file" */
  fileType?: string;
  /** URL to navigate to when the expand button is clicked (full-page navigation) */
  navigateUrl?: string;
  /** True when the iframe is a subspace — shows Claw'd logo in the sidebar header badge */
  isSubspace?: boolean;
}

interface SidebarPanelProps extends SidebarPanelContent {
  isOpen: boolean;
  onClose: () => void;
}

function ClawdLogoSmall() {
  return (
    <svg width="22" height="17" viewBox="0 0 66 52" fill="none">
      <rect x="0" y="13" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="60" y="13" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="6" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="18" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="42" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="54" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="6" width="54" height="39" fill="hsl(15 63.1% 59.6%)" />
      <rect x="12" y="13" width="6" height="6.5" fill="#000" />
      <rect x="48" y="13" width="6" height="6.5" fill="#000" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
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
  fileType,
  navigateUrl,
  isSubspace,
}: SidebarPanelProps) {
  const expandUrl = navigateUrl ?? (type === "iframe" ? url : undefined);
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

  // Portal the overlay+dialog to document.body for correct z-index stacking.
  return createPortal(
    <div className={`sidebar-panel${isOpen ? " open" : ""}`} onClick={onClose} aria-hidden={!isOpen}>
      <div
        ref={panelRef}
        className="sidebar-panel-box"
        role="dialog"
        aria-modal="true"
        aria-label={`${title} panel`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sidebar-panel-header">
          <div className="sidebar-panel-header-left">
            {config && (
              <span className="sidebar-panel-type-badge" style={{ background: config.color }}>
                {config.icon}
              </span>
            )}
            {type === "iframe" && !config && isSubspace && (
              <span className="sidebar-panel-type-badge sidebar-panel-type-badge--subspace">
                <ClawdLogoSmall />
              </span>
            )}
            {type === "iframe" && !config && !isSubspace && (
              <span className="sidebar-panel-type-badge sidebar-panel-type-badge--embed">{"</>"}</span>
            )}
            <span className="sidebar-panel-title">{title}</span>
          </div>
          <div className="sidebar-panel-header-actions">
            {type === "file" && url && (
              <>
                <a
                  href={url}
                  download={title}
                  className="sidebar-panel-action-icon"
                  title="Download file"
                  aria-label="Download"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </a>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sidebar-panel-action-icon"
                  title="Open in new tab"
                  aria-label="Open in new tab"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              </>
            )}
            {expandUrl && (
              <button
                type="button"
                className="sidebar-panel-action-icon sidebar-panel-expand-btn"
                onClick={() => (window.location.href = expandUrl)}
                aria-label="Open full page"
                title="Open full page"
              >
                <ExpandIcon />
              </button>
            )}
            <button
              type="button"
              className="sidebar-panel-close-btn"
              onClick={onClose}
              aria-label="Close sidebar"
              title="Close (Esc)"
            >
              <CloseIcon />
            </button>
          </div>
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
          {isOpen && type === "artifact" && content !== undefined && artifactType && artifactType !== "interactive" && (
            <div className="sidebar-panel-artifact">
              <FullArtifactRenderer artifactType={artifactType} content={content} language={language} />
            </div>
          )}
          {isOpen && type === "file" && url && (
            <div className="sidebar-panel-file">
              <FilePreviewSidebar url={url} name={title} mimetype={fileType ?? ""} />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
