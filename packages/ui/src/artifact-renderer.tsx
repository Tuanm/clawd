import DOMPurify from "dompurify";
import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import SandboxedIframe from "./artifact-sandbox";
import type { ArtifactType } from "./artifact-types";
import CsvTable from "./csv-table";
import { highlightCode } from "./prism-setup";

export type { ArtifactType };

export interface ArtifactRendererProps {
  artifactType: ArtifactType;
  content: string;
  language?: string;
}

// Lazy-load ChartRenderer so Recharts (~50KB gz) is not in the initial bundle.
const ChartRenderer = React.lazy(() => import("./chart-renderer"));

export default function ArtifactRenderer({ artifactType, content, language }: ArtifactRendererProps) {
  switch (artifactType) {
    case "html":
      return <SandboxedIframe type="html" content={content} />;

    case "react":
      return <SandboxedIframe type="react" content={content} />;

    case "svg": {
      const sanitized = DOMPurify.sanitize(content, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ["use"],
      });
      return <div className="artifact-renderer-svg" dangerouslySetInnerHTML={{ __html: sanitized }} />;
    }

    case "chart":
      return (
        <React.Suspense fallback={<div className="artifact-renderer-placeholder">Loading chart...</div>}>
          <ChartRenderer content={content} />
        </React.Suspense>
      );

    case "markdown":
      return (
        <div className="artifact-renderer-markdown">
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      );

    case "csv":
      return <CsvTable content={content} maxRows={500} />;

    case "code": {
      const lang = language || "text";
      const highlighted = highlightCode(content, lang);
      if (highlighted) {
        return (
          <pre className={`language-${lang}`}>
            <code dangerouslySetInnerHTML={{ __html: highlighted }} />
          </pre>
        );
      }
      return (
        <pre>
          <code>{content}</code>
        </pre>
      );
    }

    default:
      return <pre className="artifact-renderer-placeholder">{content}</pre>;
  }
}
