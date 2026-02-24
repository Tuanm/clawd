import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Prism from "prismjs";
import "prismjs/components/prism-markdown";

// Highlight markdown syntax
function highlightMarkdown(text: string): string {
  if (!text) return "";
  const grammar = Prism.languages.markdown || Prism.languages.md;
  if (!grammar) return text;
  return Prism.highlight(text, grammar, "markdown");
}

// Copy icon for context menu
function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

// Paste icon for context menu
function PasteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  );
}

// Context menu state
interface ComposerContextMenuState {
  x: number;
  y: number;
}

// Context menu component for composer
function ComposerContextMenu({
  menu,
  onClose,
  onCopy,
  onPaste,
  hasSelection,
}: {
  menu: ComposerContextMenuState;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  hasSelection: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside or Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Position menu so it doesn't overflow viewport
  const adjustedPosition = useMemo(() => {
    const menuWidth = 200;
    const menuHeight = 88; // 2 items
    let x = menu.x;
    let y = menu.y;
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 8;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 8;
    }
    return { x, y };
  }, [menu.x, menu.y]);

  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const copyShortcut = isMac ? "\u2318C" : "Ctrl+C";
  const pasteShortcut = isMac ? "\u2318V" : "Ctrl+V";

  return createPortal(
    <div ref={menuRef} className="message-context-menu" style={{ left: adjustedPosition.x, top: adjustedPosition.y }}>
      <button
        className={`context-menu-item${!hasSelection ? " disabled" : ""}`}
        onClick={() => {
          if (hasSelection) {
            onCopy();
            onClose();
          }
        }}
        disabled={!hasSelection}
      >
        <CopyIcon />
        <span>Copy</span>
        <span className="context-menu-shortcut">{copyShortcut}</span>
      </button>
      <button
        className="context-menu-item"
        onClick={() => {
          onPaste();
          onClose();
        }}
      >
        <PasteIcon />
        <span>Paste</span>
        <span className="context-menu-shortcut">{pasteShortcut}</span>
      </button>
    </div>,
    document.body,
  );
}

interface AttachmentFile {
  id: string;
  name: string;
  file: File;
  preview?: string;
}

interface Props {
  onSend: (text: string, files?: File[]) => void;
  channel: string;
  disabled?: boolean;
  thinkingBanner?: React.ReactNode;
  hibernateBanner?: React.ReactNode;
  planButton?: React.ReactNode;
  searchButton?: React.ReactNode;
  projectsButton?: React.ReactNode;
}

export default function MessageComposer({
  onSend,
  channel: _channel,
  disabled,
  thinkingBanner,
  hibernateBanner,
  planButton,
  searchButton,
  projectsButton,
}: Props) {
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [text, setText] = useState("");
  const [composerContextMenu, setComposerContextMenu] = useState<ComposerContextMenuState | null>(null);
  const [contextMenuHasSelection, setContextMenuHasSelection] = useState(false);
  const [showToolbar, setShowToolbar] = useState(() => {
    const stored = localStorage.getItem("chat-composer-toolbar");
    return stored === "true";
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCounterRef = useRef(0);

  // Handle right-click on textarea
  const handleTextareaContextMenu = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const textarea = e.currentTarget;
    setContextMenuHasSelection(textarea.selectionStart !== textarea.selectionEnd);
    setComposerContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // Handle paste from context menu
  const handleContextMenuPaste = useCallback(async () => {
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (clipboardText) {
        const textarea = textareaRef.current;
        if (textarea) {
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          const newText = text.substring(0, start) + clipboardText + text.substring(end);
          setText(newText);
          // Set cursor after pasted text
          setTimeout(() => {
            textarea.focus();
            const newPos = start + clipboardText.length;
            textarea.setSelectionRange(newPos, newPos);
          }, 0);
        } else {
          setText((prev) => prev + clipboardText);
        }
      }
    } catch {
      // Fallback: use document.execCommand for browsers that don't support clipboard API
      textareaRef.current?.focus();
      document.execCommand("paste");
    }
  }, [text]);

  // Handle copy from context menu
  const handleContextMenuCopy = useCallback(async () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) return; // Nothing selected
    const selectedText = text.substring(start, end);
    try {
      await navigator.clipboard.writeText(selectedText);
    } catch {
      // Fallback
      textarea.focus();
      document.execCommand("copy");
    }
  }, [text]);

  const closeComposerContextMenu = useCallback(() => {
    setComposerContextMenu(null);
  }, []);

  // Toggle toolbar visibility
  const toggleToolbar = useCallback(() => {
    const newState = !showToolbar;
    setShowToolbar(newState);
    localStorage.setItem("chat-composer-toolbar", String(newState));
  }, [showToolbar]);

  // Apply markdown format to selected text
  const applyFormat = useCallback(
    (prefix: string, suffix: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selectedText = text.substring(start, end);

      const newText = text.substring(0, start) + prefix + selectedText + suffix + text.substring(end);
      setText(newText);

      // Focus and set cursor position after the formatted text
      setTimeout(() => {
        textarea.focus();
        const newPos = end + prefix.length + suffix.length;
        textarea.setSelectionRange(newPos, newPos);
      }, 0);
    },
    [text],
  );

  // Insert markdown link
  const insertLink = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = text.substring(start, end);

    const url = window.prompt("Enter URL:");
    if (!url) return;

    const linkText = selectedText || window.prompt("Enter link text:") || url;
    const markdownLink = `[${linkText}](${url})`;

    const newText = text.substring(0, start) + markdownLink + text.substring(end);
    setText(newText);

    setTimeout(() => {
      textarea.focus();
      const newPos = start + markdownLink.length;
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  }, [text]);

  const handleSend = useCallback(() => {
    if (!text.trim() && attachments.length === 0) return;

    const files = attachments.map((a) => a.file);
    onSend(text.trim(), files.length > 0 ? files : undefined);

    // Clear
    setText("");
    attachments.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
    setAttachments([]);
  }, [text, attachments, onSend]);

  // Handle textarea keydown (Enter to send, Ctrl+Enter for newline)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    fileArray.forEach((file) => {
      const isImage = file.type.startsWith("image/");
      const url = isImage ? URL.createObjectURL(file) : undefined;

      setAttachments((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          file,
          preview: url,
        },
      ]);
    });
  }, []);

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(e.target.files);
      e.target.value = "";
    }
  };

  // Handle paste for images
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const ext = file.type.split("/")[1] || "png";
          const namedFile = new File([file], `pasted-image-${timestamp}.${ext}`, { type: file.type });
          const url = URL.createObjectURL(namedFile);

          setAttachments((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              name: namedFile.name,
              file: namedFile,
              preview: url,
            },
          ]);
          return;
        }
      }
    }
  }, []);

  // Drag and drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  const hasContent = text.trim().length > 0 || attachments.length > 0;

  if (disabled) {
    return null;
  }

  return (
    <div
      className={`composer-wrapper ${isDragging ? "dragging" : ""}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="drop-overlay">
          <span>Drop files here</span>
        </div>
      )}
      {thinkingBanner}
      {hibernateBanner}
      <div className="composer-box">
        {/* Markdown formatting toolbar - only shown when enabled */}
        {showToolbar && (
          <div className="composer-toolbar">
            <button className="toolbar-btn" title="Bold (**text**)" onClick={() => applyFormat("**", "**")}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z" />
              </svg>
            </button>
            <button className="toolbar-btn" title="Italic (*text*)" onClick={() => applyFormat("*", "*")}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z" />
              </svg>
            </button>
            <button className="toolbar-btn" title="Strikethrough (~~text~~)" onClick={() => applyFormat("~~", "~~")}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 19h4v-3h-4v3zM5 4v3h5v3h4V7h5V4H5zM3 14h18v-2H3v2z" />
              </svg>
            </button>
            <div className="toolbar-divider" />
            <button className="toolbar-btn" title="Link [text](url)" onClick={insertLink}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z" />
              </svg>
            </button>
            <div className="toolbar-divider" />
            <button className="toolbar-btn" title="Bullet list" onClick={() => applyFormat("- ", "")}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z" />
              </svg>
            </button>
            <div className="toolbar-divider" />
            <button className="toolbar-btn" title="Inline code (\`code\`)" onClick={() => applyFormat("`", "`")}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" />
              </svg>
            </button>
            <button className="toolbar-btn" title="Code block (\`\`\`)" onClick={() => applyFormat("```\n", "\n```")}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 3h16c.55 0 1 .45 1 1v16c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1V4c0-.55.45-1 1-1zm1 2v14h14V5H5zm3.4 10.6L4.8 12l3.6-3.6L9.8 7l-5 5 5 5-1.4-1.4zm7.2 0l3.6-3.6-3.6-3.6L14.2 7l5 5-5 5 1.4-1.4z" />
              </svg>
            </button>
            {planButton && (
              <>
                <div className="toolbar-divider" />
                {planButton}
              </>
            )}
            {searchButton && (
              <>
                <div className="toolbar-divider" />
                {searchButton}
              </>
            )}
            {projectsButton && (
              <>
                <div className="toolbar-divider" />
                {projectsButton}
              </>
            )}
          </div>
        )}

        {/* Textarea with optional markdown highlighting */}
        <div className={`composer-textarea-wrap ${showToolbar ? "show-highlight" : ""}`}>
          {/* Highlighted markdown layer (behind textarea) */}
          {showToolbar && (
            <pre className="composer-highlight-layer">
              <code dangerouslySetInnerHTML={{ __html: highlightMarkdown(text) + "\n" }} />
            </pre>
          )}
          {/* Actual textarea (on top) */}
          <textarea
            ref={textareaRef}
            className="composer-raw-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onContextMenu={handleTextareaContextMenu}
            placeholder={showToolbar ? "Write with markdown..." : "Reply..."}
            style={showToolbar ? { color: "transparent", caretColor: "var(--text)" } : undefined}
          />
        </div>

        {/* File attachments preview */}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="composer-attachment-item">
                {attachment.preview && (
                  <img
                    src={attachment.preview}
                    alt={attachment.name}
                    className="attachment-thumbnail"
                    style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4 }}
                  />
                )}
                <span className="attachment-name">{attachment.name}</span>
                <button
                  className="attachment-remove"
                  onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))}
                  title="Remove"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Bottom actions */}
        <div className="composer-bottom">
          <div className="composer-actions">
            <button className="action-btn" onClick={() => fileInputRef.current?.click()} title="Attach file">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
              </svg>
            </button>
            {/* Format toggle button */}
            <button
              className={`action-btn format-toggle ${showToolbar ? "active" : ""}`}
              onClick={toggleToolbar}
              title={showToolbar ? "Hide formatting toolbar" : "Show formatting toolbar"}
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M5 17v2h14v-2H5zm4.5-4.2h5l.9 2.2h2.1L12.75 4h-1.5L6.5 15h2.1l.9-2.2zM12 5.98L13.87 11h-3.74L12 5.98z" />
              </svg>
            </button>
            {/* Plan and Search buttons - show when toolbar is hidden */}
            {!showToolbar && planButton && planButton}
            {!showToolbar && searchButton && searchButton}
            {!showToolbar && projectsButton && projectsButton}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/*,text/*"
            onChange={handleFileSelect}
            className="file-input-hidden"
          />
          <button onClick={handleSend} className={`composer-send ${hasContent ? "has-content" : ""}`} title="Send">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
      <div className="composer-disclaimer">Claw'd can make mistakes. You too.</div>

      {/* Composer context menu */}
      {composerContextMenu && (
        <ComposerContextMenu
          menu={composerContextMenu}
          onClose={closeComposerContextMenu}
          onCopy={handleContextMenuCopy}
          onPaste={handleContextMenuPaste}
          hasSelection={contextMenuHasSelection}
        />
      )}
    </div>
  );
}
