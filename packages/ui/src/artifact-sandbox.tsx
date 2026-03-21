import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { htmlArtifactTemplate, reactArtifactTemplate } from "./artifact-templates";
import { authFetch } from "./auth-fetch";

const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 300;

/** Max serialized JSON size for action values — 10KB */
const MAX_VALUE_BYTES = 10240;
/** Rate limit: max actions per minute per iframe instance */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

interface SandboxedIframeProps {
  type: "html" | "react";
  content: string;
  messagTs?: string;
  channel?: string;
}

export default function SandboxedIframe({ type, content, messagTs, channel }: SandboxedIframeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [error, setError] = useState<string | null>(null);

  // Rate limit state — in-component, per iframe instance
  const actionCountRef = useRef(0);
  const actionWindowStartRef = useRef(Date.now());

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
    // React — pass context when available so bridge is injected
    const context = messagTs && channel ? { messagTs, channel } : undefined;
    return reactArtifactTemplate(content, context);
  }, [type, content, messagTs, channel]);

  useEffect(() => {
    const handleMessage = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;

      const data = ev.data as {
        type?: string;
        height?: number;
        message?: string;
        line?: number;
        requestId?: string;
        actionId?: string;
        value?: unknown;
      } | null;

      if (data?.type === "artifact-resize" && typeof data.height === "number") {
        setHeight(Math.min(Math.max(data.height, 50), MAX_HEIGHT));
      }
      if (data?.type === "artifact-error" && typeof data.message === "string") {
        setError(data.message);
      }

      // Bridge action relay — only when context props are provided
      if (data?.type === "clawd-action" && messagTs && channel) {
        const { requestId, actionId, value } = data;

        // Validate fields — silent reject on any violation
        if (typeof requestId !== "string" || requestId.length > 64) return;
        if (typeof actionId !== "string" || actionId.length > 128) return;
        try {
          if (JSON.stringify(value ?? null).length > MAX_VALUE_BYTES) return;
        } catch {
          return;
        }

        // Rate limit check — reset window if expired
        const now = Date.now();
        if (now - actionWindowStartRef.current >= RATE_WINDOW_MS) {
          actionCountRef.current = 0;
          actionWindowStartRef.current = now;
        }
        if (actionCountRef.current >= RATE_LIMIT) return;
        actionCountRef.current++;

        const replyToIframe = (payload: Record<string, unknown>) => {
          iframeRef.current?.contentWindow?.postMessage({ type: "clawd-action-result", requestId, ...payload }, "*");
        };

        authFetch("/api/artifact.action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message_ts: messagTs,
            channel,
            action_id: actionId,
            values: { [actionId]: value },
          }),
        })
          .then((r) => r.json())
          .then((result: Record<string, unknown>) => replyToIframe(result))
          .catch(() => replyToIframe({ ok: false, error: "network_error" }));
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [messagTs, channel]);

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
