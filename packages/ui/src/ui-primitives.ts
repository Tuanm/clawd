// Shared UI primitives extracted from MessageList.tsx
// Used by artifact-card.tsx, artifact-modal.tsx, and MessageList.tsx

import React, { useState } from "react";

// Copy icon component
export function CopyIcon(): React.ReactElement {
  return React.createElement(
    "svg",
    { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" },
    React.createElement("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2", ry: "2" }),
    React.createElement("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }),
  );
}

// Check icon for copied state
export function CheckIcon(): React.ReactElement {
  return React.createElement(
    "svg",
    { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" },
    React.createElement("polyline", { points: "20 6 9 17 4 12" }),
  );
}

// Close (X) icon for modals
export function CloseIcon(): React.ReactElement {
  return React.createElement(
    "svg",
    { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" },
    React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
    React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" }),
  );
}

// Download icon
export function DownloadIcon(): React.ReactElement {
  return React.createElement(
    "svg",
    { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" },
    React.createElement("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }),
    React.createElement("polyline", { points: "7 10 12 15 17 10" }),
    React.createElement("line", { x1: "12", y1: "15", x2: "12", y2: "3" }),
  );
}

// Alert / warning icon
export function AlertIcon(): React.ReactElement {
  return React.createElement(
    "svg",
    { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" },
    React.createElement("path", { d: "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" }),
    React.createElement("line", { x1: "12", y1: "9", x2: "12", y2: "13" }),
    React.createElement("line", { x1: "12", y1: "17", x2: "12.01", y2: "17" }),
  );
}

// Pre block wrapper with copy button (button is OUTSIDE the scrollable pre)
export function PreBlock({ children }: { children: React.ReactNode }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  // Extract code text from children (pre > code > text)
  const getCodeText = (): string => {
    try {
      const codeElement = React.Children.toArray(children)[0] as React.ReactElement<{ children?: React.ReactNode; className?: string }>;
      if (codeElement?.props?.children) {
        return String(codeElement.props.children).replace(/\n$/, "");
      }
    } catch {}
    return "";
  };

  const copyCode = async () => {
    const code = getCodeText();
    if (code) {
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        // Fallback for non-HTTPS or restricted contexts
        const textarea = document.createElement("textarea");
        textarea.value = code;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Check if this contains a code block (language-*) vs just inline/plain
  const codeElement = React.Children.toArray(children)[0] as React.ReactElement<{ children?: React.ReactNode; className?: string }>;
  const hasLanguageClass = (codeElement?.props?.className as string | undefined)?.startsWith("language-");

  // If no language class, render plain pre without copy button
  if (!hasLanguageClass) {
    return React.createElement("pre", null, children);
  }

  return React.createElement(
    "div",
    { className: "code-block-wrapper" },
    React.createElement(
      "button",
      {
        className: `code-copy-btn ${copied ? "copied" : ""}`,
        onClick: copyCode,
        title: copied ? "Copied!" : "Copy code",
      },
      copied ? React.createElement(CheckIcon) : React.createElement(CopyIcon),
    ),
    React.createElement("pre", null, children),
  );
}
