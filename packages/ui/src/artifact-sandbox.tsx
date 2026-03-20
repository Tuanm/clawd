import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { htmlArtifactTemplate, reactArtifactTemplate } from "./artifact-templates";

const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 300;

interface SandboxedIframeProps {
  type: "html" | "react";
  content: string;
}

export default function SandboxedIframe({ type, content }: SandboxedIframeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [error, setError] = useState<string | null>(null);

  const srcDoc = useMemo(() => {
    if (type === "html") {
      const sanitized = DOMPurify.sanitize(content, {
        WHOLE_DOCUMENT: true,
        ADD_TAGS: ["style", "link"],
        ADD_ATTR: ["target"],
        ALLOW_DATA_ATTR: false,
      });
      return htmlArtifactTemplate(sanitized);
    }
    // React — security comes from iframe sandbox isolation (no allow-same-origin)
    return reactArtifactTemplate(content);
  }, [type, content]);

  useEffect(() => {
    const handleMessage = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const data = ev.data as { type?: string; height?: number; message?: string } | null;
      if (data?.type === "artifact-resize" && typeof data.height === "number") {
        setHeight(Math.min(Math.max(data.height, 50), MAX_HEIGHT));
      }
      if (data?.type === "artifact-error" && typeof data.message === "string") {
        setError(data.message);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return (
    <div className="artifact-iframe-container">
      {error && <div className="artifact-error-banner">Runtime error: {error}</div>}
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        title={`${type} artifact preview`}
        style={{ width: "100%", height: `${height}px`, border: "none", display: "block" }}
      />
    </div>
  );
}
