// SidebarPanel — slide-out panel on the right side for rich/external content.
// Supports three display modes:
//   "iframe"    — sandboxed iframe for external URLs (Google Docs, Figma, etc.)
//   "artifact"  — ArtifactRenderer for html/react/csv/markdown/code content
//   "file"      — FilePreviewSidebar for PDF/CSV/text/code/image/audio/video files

import { Fragment, useEffect, useRef } from "react";
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
  fileType,
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

  // Portal both backdrop and panel to document.body to ensure correct z-index stacking.
  // Backdrop (z-index 199) must come BEFORE panel (z-index 200) in DOM order.
  return createPortal(
    <Fragment>
      {isOpen && <div className="sidebar-backdrop" onClick={onClose} aria-hidden="true" />}
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
            <button
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
          {isOpen && type === "artifact" && content !== undefined && artifactType && (
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
    </Fragment>,
    document.body,
  );
}
