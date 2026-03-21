// ArtifactModal — fullscreen overlay for viewing artifact content.
// Opens when user clicks an ArtifactPreviewCard. Toolbar has copy, download, close.
// Error boundary wraps renderer so crashes show raw content fallback.

import React, { useEffect, useRef, useState } from "react";
import FullArtifactRenderer from "./artifact-renderer";
import SandboxedIframe from "./artifact-sandbox";
import { ARTIFACT_EXTENSION_MAP, type ArtifactType, TYPE_CONFIG } from "./artifact-types";
import { AlertIcon, CheckIcon, CloseIcon, CopyIcon, DownloadIcon, PreBlock } from "./ui-primitives";

// Renders artifact content at full size inside the modal body.
// html/react types use SandboxedIframe directly to thread messagTs/channel for the bridge.
function ArtifactRenderer({
  type,
  content,
  language,
  messagTs,
  channel,
}: {
  type: ArtifactType;
  content: string;
  language?: string;
  messagTs?: string;
  channel?: string;
}) {
  if (type === "html" || type === "react") {
    return <SandboxedIframe type={type} content={content} messagTs={messagTs} channel={channel} />;
  }
  return <FullArtifactRenderer artifactType={type} content={content} language={language} />;
}

// Error boundary wrapping the renderer — shows raw content if renderer crashes
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  content: string;
}

class ArtifactErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[Artifact] Renderer crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="artifact-error">
          <div className="artifact-error-msg">
            <AlertIcon />
            <span>Render failed: {this.state.error?.message ?? "Unknown error"}</span>
          </div>
          <PreBlock>
            <code className="language-text">{this.props.content}</code>
          </PreBlock>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface ArtifactModalProps {
  type: ArtifactType;
  title: string;
  content: string;
  language?: string;
  /** Slack message timestamp — forwarded to SandboxedIframe for bridge actions */
  messagTs?: string;
  /** Slack channel ID — forwarded to SandboxedIframe for bridge actions */
  channel?: string;
  onClose: () => void;
}

export function ArtifactModal({ type, title, content, language, messagTs, channel, onClose }: ArtifactModalProps) {
  // Interactive artifacts render inline in the message — no modal needed
  if (type === "interactive") return null;

  const [copied, setCopied] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const config = TYPE_CONFIG[type] ?? TYPE_CONFIG.code;

  // Close on Escape key + focus trap
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable && focusable.length > 0) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Focus modal container on mount for keyboard navigation
  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  // Lock body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const copyContent = async () => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      // Fallback for non-HTTPS or restricted contexts
      const textarea = document.createElement("textarea");
      textarea.value = content;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadContent = () => {
    const ext =
      type === "code" && language
        ? `.${language === "typescript" ? "ts" : language === "python" ? "py" : language === "javascript" ? "js" : language}`
        : ARTIFACT_EXTENSION_MAP[type];
    const slug = title.replace(/[^a-z0-9]/gi, "-").toLowerCase();
    const filename = `${slug}${ext}`;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="artifact-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${title} artifact`}
    >
      <div className="artifact-modal-content" onClick={(e) => e.stopPropagation()} ref={modalRef} tabIndex={-1}>
        {/* Toolbar */}
        <div className="artifact-modal-toolbar">
          <span className="artifact-modal-badge" style={{ background: config.color }}>
            {config.icon}
          </span>
          <span className="artifact-modal-title">{title}</span>
          <div className="artifact-modal-actions">
            <button onClick={copyContent} aria-label="Copy content" title={copied ? "Copied!" : "Copy"}>
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

        {/* Body — scrollable, no max-height constraint */}
        <div className="artifact-modal-body">
          {/* key=content resets error boundary if content changes */}
          <ArtifactErrorBoundary key={content} content={content}>
            <ArtifactRenderer type={type} content={content} language={language} messagTs={messagTs} channel={channel} />
          </ArtifactErrorBoundary>
        </div>
      </div>
    </div>
  );
}
