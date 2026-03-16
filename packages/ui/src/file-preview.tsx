// file-preview.tsx — File preview cards and sidebar renderers.
// FilePreviewCard: compact card shown in messages (agent + human).
// FilePreviewSidebar: full-size renderer inside the sidebar panel.

import { useEffect, useState } from "react";
import { highlightCode } from "./prism-setup";

// ── File type detection ──────────────────────────────────────────────────────

const CODE_EXTENSIONS =
  /\.(js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|h|cs|php|sh|bash|zsh|fish|ps1|swift|kt|scala|r|lua|sql|graphql|tf|hcl|dockerfile|makefile|cmake|toml|ini|env|editorconfig)$/i;
const TEXT_EXTENSIONS = /\.(txt|log|md|markdown|rst|csv|json|yaml|yml|xml|html|htm|css|scss|less|svg)$/i;

export type FileCategory = "pdf" | "csv" | "html" | "text" | "code" | "image" | "audio" | "video" | "other";

export function getFileCategory(mimetype: string, name: string): FileCategory {
  if (mimetype === "application/pdf") return "pdf";
  if (mimetype === "text/csv" || name.endsWith(".csv")) return "csv";
  if (mimetype === "text/html" || name.endsWith(".html") || name.endsWith(".htm")) return "html";
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("audio/")) return "audio";
  if (mimetype.startsWith("video/")) return "video";
  if (
    mimetype === "text/plain" ||
    mimetype === "application/json" ||
    mimetype === "text/markdown" ||
    mimetype === "text/yaml" ||
    mimetype === "application/xml" ||
    mimetype === "text/xml" ||
    TEXT_EXTENSIONS.test(name)
  ) {
    if (CODE_EXTENSIONS.test(name) || mimetype === "application/json") return "code";
    return "text";
  }
  if (CODE_EXTENSIONS.test(name)) return "code";
  return "other";
}

/** Returns true for any file that can be meaningfully previewed in sidebar */
export function isPreviewableFile(file: { mimetype?: string; name: string }): boolean {
  if (!file.mimetype) return CODE_EXTENSIONS.test(file.name) || TEXT_EXTENSIONS.test(file.name);
  const cat = getFileCategory(file.mimetype, file.name);
  return cat !== "other";
}

/**
 * Legacy helper — kept for backward compat with existing MessageList callers.
 * Returns true if the mimetype has an inline preview (PDF, audio, video).
 */
export function isPreviewableMimetype(mimetype: string): boolean {
  return mimetype === "application/pdf" || mimetype.startsWith("audio/") || mimetype.startsWith("video/");
}

// ── File icons ───────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<FileCategory, string> = {
  pdf: "#e53e3e",
  csv: "#38a169",
  html: "#e05d44",
  text: "#3182ce",
  code: "#3182ce",
  image: "#805ad5",
  audio: "#dd6b20",
  video: "#dd6b20",
  other: "#718096",
};

const CATEGORY_LABELS: Record<FileCategory, string> = {
  pdf: "PDF",
  csv: "CSV",
  html: "HTML",
  text: "TXT",
  code: "CODE",
  image: "IMG",
  audio: "AUD",
  video: "VID",
  other: "FILE",
};

function FileIcon({ category }: { category: FileCategory }) {
  const color = CATEGORY_COLORS[category];
  return (
    <div className="file-preview-badge" style={{ background: color }} aria-hidden="true">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {category === "pdf" && (
          <>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="9" y1="13" x2="15" y2="13" />
            <line x1="9" y1="17" x2="15" y2="17" />
          </>
        )}
        {category === "csv" && (
          <>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="3" y1="15" x2="21" y2="15" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </>
        )}
        {category === "html" && (
          <>
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </>
        )}
        {(category === "text" || category === "code") && (
          <>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="9" y1="13" x2="15" y2="13" />
            <line x1="9" y1="17" x2="15" y2="17" />
          </>
        )}
        {category === "image" && (
          <>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </>
        )}
        {(category === "audio" || category === "video") && (
          <>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <polygon points="10 12 16 15.5 10 19 10 12" />
          </>
        )}
        {category === "other" && (
          <>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </>
        )}
      </svg>
    </div>
  );
}

// ── FilePreviewCard ──────────────────────────────────────────────────────────

export interface FilePreviewCardProps {
  file: { id: string; name: string; url_private: string; mimetype?: string; size?: number };
  onClick: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePreviewCard({ file, onClick }: FilePreviewCardProps) {
  const mimetype = file.mimetype ?? "";
  const category = getFileCategory(mimetype, file.name);
  const label = CATEGORY_LABELS[category];
  const subtitle = file.size ? `${label} · ${formatBytes(file.size)}` : label;

  return (
    <div
      className="artifact-preview-card file-preview-card"
      role="button"
      tabIndex={0}
      aria-label={`${file.name} — click to open in sidebar`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <FileIcon category={category} />
      <div className="artifact-preview-content">
        <div className="artifact-preview-title">{file.name}</div>
        <div className="artifact-preview-meta">{subtitle}</div>
      </div>
    </div>
  );
}

// ── FilePreviewSidebar ───────────────────────────────────────────────────────

interface CsvTableProps {
  content: string;
}

function CsvTable({ content }: CsvTableProps) {
  const lines = content.trim().split("\n");
  if (lines.length === 0) return <p>Empty CSV</p>;
  const headers = (lines[0] ?? "").split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
  return (
    <div className="csv-table-wrapper">
      <table className="csv-table">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HighlightedCode({ content, filename }: { content: string; filename: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    const ext = filename.split(".").pop() ?? "txt";
    const langMap: Record<string, string> = {
      js: "javascript",
      jsx: "jsx",
      ts: "typescript",
      tsx: "tsx",
      py: "python",
      rb: "ruby",
      go: "go",
      rs: "rust",
      java: "java",
      c: "c",
      cpp: "cpp",
      cs: "csharp",
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      json: "json",
      yaml: "yaml",
      yml: "yaml",
      xml: "xml",
      html: "html",
      htm: "html",
      css: "css",
      scss: "scss",
      md: "markdown",
      sql: "sql",
    };
    const lang = langMap[ext] ?? "plaintext";
    const result = highlightCode(content, lang);
    setHtml(result);
  }, [content, filename]);

  if (!html) {
    return (
      <pre className="sidebar-code-pre">
        <code>{content}</code>
      </pre>
    );
  }
  return (
    <pre className="sidebar-code-pre">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

export interface FilePreviewSidebarProps {
  url: string;
  name: string;
  mimetype: string;
}

export function FilePreviewSidebar({ url, name, mimetype }: FilePreviewSidebarProps) {
  const category = getFileCategory(mimetype, name);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch text-based content
  useEffect(() => {
    if (category !== "text" && category !== "code" && category !== "csv") return;
    setLoading(true);
    setFetchError(null);
    setTextContent(null);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => setTextContent(t))
      .catch((e: unknown) => setFetchError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [url, category]);

  if (category === "pdf") {
    return (
      <div className="sidebar-file-pdf">
        <object data={url} type="application/pdf" className="sidebar-pdf-object">
          <p className="sidebar-pdf-fallback">
            PDF preview unavailable.{" "}
            <a href={url} target="_blank" rel="noopener noreferrer">
              Download PDF
            </a>
          </p>
        </object>
      </div>
    );
  }

  if (category === "html") {
    return (
      <div className="sidebar-file-html">
        <iframe src={url} title={name} className="sidebar-html-iframe" sandbox="allow-scripts" />
      </div>
    );
  }

  if (category === "image") {
    return (
      <div className="sidebar-file-image">
        <img src={url} alt={name} className="sidebar-image-full" />
      </div>
    );
  }

  if (category === "audio") {
    return (
      <div className="sidebar-file-media">
        <div className="sidebar-file-media-label">{name}</div>
        <audio controls preload="metadata" style={{ width: "100%" }}>
          <source src={url} type={mimetype} />
          Your browser does not support audio playback.
        </audio>
      </div>
    );
  }

  if (category === "video") {
    return (
      <div className="sidebar-file-media">
        <div className="sidebar-file-media-label">{name}</div>
        <video controls preload="metadata" style={{ maxWidth: "100%", maxHeight: "60vh" }}>
          <source src={url} type={mimetype} />
          Your browser does not support video playback.
        </video>
      </div>
    );
  }

  if (category === "csv") {
    if (loading) return <div className="sidebar-file-loading">Loading...</div>;
    if (fetchError) return <div className="sidebar-file-error">Failed to load: {fetchError}</div>;
    if (textContent !== null) return <CsvTable content={textContent} />;
    return null;
  }

  if (category === "text" || category === "code") {
    if (loading) return <div className="sidebar-file-loading">Loading...</div>;
    if (fetchError) return <div className="sidebar-file-error">Failed to load: {fetchError}</div>;
    if (textContent !== null) {
      return <HighlightedCode content={textContent} filename={name} />;
    }
    return null;
  }

  // Fallback for unknown types — try iframe
  return (
    <iframe
      src={url}
      title={name}
      className="sidebar-panel-iframe"
      sandbox="allow-scripts allow-same-origin allow-popups"
    />
  );
}

// Legacy default export kept for backward compat (audio/video inline use)
interface FilePreviewProps {
  url: string;
  name: string;
  mimetype: string;
}

export default function FilePreview({ url, name, mimetype }: FilePreviewProps) {
  if (mimetype.startsWith("audio/")) {
    return (
      <div className="file-audio-player">
        <div className="file-preview-label">{name}</div>
        <audio controls preload="metadata" style={{ width: "100%" }}>
          <source src={url} type={mimetype} />
          Your browser does not support audio playback.
        </audio>
      </div>
    );
  }
  if (mimetype.startsWith("video/")) {
    return (
      <div className="file-video-player">
        <div className="file-preview-label">{name}</div>
        <video controls preload="metadata" style={{ maxWidth: "100%", maxHeight: "400px" }}>
          <source src={url} type={mimetype} />
          Your browser does not support video playback.
        </video>
      </div>
    );
  }
  return null;
}
