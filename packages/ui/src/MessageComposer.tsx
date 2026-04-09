import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import useSpeechToText from "./hooks/useSpeechToText";
import MicButton from "./MicButton";
import { createPortal } from "react-dom";
import { InputContextMenu } from "./InputContextMenu";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { markdownSanitizeSchema } from "./sanitize-schema";

// Context menu state
interface ComposerContextMenuState {
  x: number;
  y: number;
}

interface AttachmentFile {
  id: string;
  name: string;
  file: File;
  preview?: string;
}

// Moon icon — shown in light mode
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

// Sun icon — shown in dark mode
function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

interface Props {
  onSend: (text: string, files?: File[]) => void;
  channel: string;
  disabled?: boolean;
  thinkingBanner?: React.ReactNode;
  hibernateBanner?: React.ReactNode;
  searchButton?: React.ReactNode;
  projectsButton?: React.ReactNode;
  mcpButton?: React.ReactNode;
  skillsButton?: React.ReactNode;
  worktreeButton?: React.ReactNode;
  onPlanClick?: () => void;
  theme: "light" | "dark";
  onThemeToggle: () => void;
}

/**
 * Always-collapsed tools menu: shows only a three-dot button that opens a dropdown.
 * Used in the formatting toolbar where space is limited.
 */
function ToolsMenuButton({ children }: { children: React.ReactNode }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const openMenu = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const openAbove = rect.top > 60;
    const top = openAbove ? rect.top - 6 : rect.bottom + 6;
    setDropdownStyle({
      position: "fixed",
      ...(openAbove ? { bottom: window.innerHeight - top } : { top }),
      right: Math.max(8, window.innerWidth - rect.right),
      zIndex: 10000,
    });
    setMenuOpen((v) => !v);
  }, []);

  return (
    <>
      <button ref={btnRef} className="toolbar-btn" onClick={openMenu} title="Tools">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
      {menuOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            className="composer-overflow-dropdown"
            style={dropdownStyle}
            onClick={() => setMenuOpen(false)}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Icon button row with auto-overflow: shows buttons inline when they fit,
 * collapses hidden ones into a three-dot dropdown when container is too narrow.
 * Dropdown rendered via portal to avoid overflow clipping by parent containers.
 */
function IconButtonRow({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  // On mobile (<=480px), always collapse to three-dot dropdown
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 480;

  // Detect overflow via ResizeObserver (desktop only)
  useEffect(() => {
    if (isMobile) {
      setOverflowing(true);
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 4);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  }, [children, isMobile]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  // After dropdown renders, clamp its left edge to stay within viewport
  useEffect(() => {
    if (!menuOpen) return;
    const el = dropdownRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      if (rect.left < 8) {
        setDropdownStyle((prev) => ({ ...prev, right: undefined, left: 8 }));
      }
    });
    return () => cancelAnimationFrame(id);
  }, [menuOpen]);

  // Position the dropdown relative to the button using fixed positioning
  const openMenu = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const vw = window.innerWidth;

    // Try to open above the button; if near top of screen, open below
    const openAbove = rect.top > 60;
    const top = openAbove ? rect.top - 6 : rect.bottom + 6;

    // Align right edge to button's right edge; clamp to stay within viewport
    const right = vw - rect.right;

    setDropdownStyle({
      position: "fixed",
      ...(openAbove ? { bottom: window.innerHeight - top } : { top }),
      right: Math.max(8, right),
      zIndex: 10000,
    });
    setMenuOpen((v) => !v);
  }, []);

  return (
    <>
      <div className="composer-icon-btns" ref={containerRef} style={isMobile ? { display: "none" } : undefined}>
        {children}
      </div>
      {overflowing && (
        <>
          <button ref={btnRef} className="action-btn" onClick={openMenu} title="More" style={{ flexShrink: 0 }}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>
          {menuOpen &&
            createPortal(
              <div
                ref={dropdownRef}
                className="composer-overflow-dropdown"
                style={dropdownStyle}
                onClick={() => setMenuOpen(false)}
              >
                {children}
              </div>,
              document.body,
            )}
        </>
      )}
    </>
  );
}

export default function MessageComposer({
  onSend,
  channel: _channel,
  disabled,
  thinkingBanner,
  hibernateBanner,
  searchButton,
  projectsButton,
  mcpButton,
  skillsButton,
  worktreeButton,
  onPlanClick,
  theme,
  onThemeToggle,
}: Props) {
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [text, setText] = useState("");

  // Voice input state
  const [hasUsedVoice, setHasUsedVoice] = useState(false);

  const handleSpeechError = useCallback((errorCode: string) => {
    console.warn("[Voice] Speech recognition error:", errorCode);
  }, []);

  const {
    isListening,
    isSupported: isSpeechSupported,
    transcript: interimTranscript,
    finalizedText: sessionFinalText,
    toggleListening: rawToggleListening,
    abortListening,
    error: speechError,
  } = useSpeechToText({
    continuous: true,
    interimResults: true,
    onError: handleSpeechError,
  });

  // Commit accumulated voice text to textarea when user stops listening
  const prevIsListening = useRef(false);
  useEffect(() => {
    if (prevIsListening.current && !isListening && sessionFinalText) {
      setText((prev) => prev + (prev ? "\n" : "") + sessionFinalText);
    }
    prevIsListening.current = isListening;
  }, [isListening, sessionFinalText]);

  const toggleListening = useCallback(() => {
    if (!hasUsedVoice) setHasUsedVoice(true);
    rawToggleListening();
  }, [hasUsedVoice, rawToggleListening]);
  const [composerContextMenu, setComposerContextMenu] = useState<ComposerContextMenuState | null>(null);
  const [contextMenuHasSelection, setContextMenuHasSelection] = useState(false);
  const [showToolbar, setShowToolbar] = useState(() => {
    const stored = localStorage.getItem("chat-composer-toolbar");
    return stored === "true";
  });
  const [showPreview] = useState(false);
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
    if (isListening) {
      abortListening();
    }
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
  }, [text, isListening, abortListening]);

  // Handle select all from context menu
  const handleContextMenuSelectAll = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(0, textarea.value.length);
    setContextMenuHasSelection(textarea.value.length > 0);
  }, []);

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

  // Handle cut from context menu: copy selection to clipboard + remove from state
  const handleContextMenuCut = useCallback(async () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) return;
    const selectedText = text.substring(start, end);
    try {
      await navigator.clipboard.writeText(selectedText);
    } catch {
      textarea.focus();
      document.execCommand("copy");
    }
    setText(text.substring(0, start) + text.substring(end));
    // Restore cursor position after state update
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.setSelectionRange(start, start);
      }
    });
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
      if (isListening) return;
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
    [text, isListening],
  );

  // Insert markdown link
  const insertLink = useCallback(() => {
    if (isListening) return;
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
  }, [text, isListening]);

  const handleSend = useCallback(() => {
    // Build final text: committed text + any voice session text
    const voicePart = isListening ? sessionFinalText : "";
    if (isListening) abortListening();
    const fullText = voicePart ? text + (text ? "\n" : "") + voicePart : text;
    if (!fullText.trim() && attachments.length === 0) return;

    const files = attachments.map((a) => a.file);
    onSend(fullText.trim(), files.length > 0 ? files : undefined);

    // Clear
    setText("");
    attachments.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
    setAttachments([]);
  }, [text, attachments, onSend, isListening, abortListening, sessionFinalText]);

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

  // Show: existing text + accumulated finals this session + current interim
  const voiceText = isListening ? [sessionFinalText, interimTranscript].filter(Boolean).join(" ") : "";
  const displayText = voiceText ? text + (text ? "\n" : "") + voiceText : text;

  const hasContent =
    text.trim().length > 0 ||
    attachments.length > 0 ||
    (isListening && (sessionFinalText.length > 0 || interimTranscript.length > 0));

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
            {(searchButton || projectsButton || worktreeButton || mcpButton || skillsButton || onPlanClick) && (
              <>
                <div className="toolbar-divider" />
                <ToolsMenuButton>
                  {searchButton}
                  {projectsButton}
                  {worktreeButton}
                  {mcpButton}
                  {skillsButton}
                  {onPlanClick && (
                    <button className="plan-btn" onClick={onPlanClick} title="Tasks">
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
                        <path d="M9 11l3 3L22 4" />
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                      </svg>
                    </button>
                  )}
                </ToolsMenuButton>
              </>
            )}
          </div>
        )}

        {/* Textarea or preview - only when toolbar is enabled */}
        {showToolbar && showPreview ? (
          <div className="composer-preview">
            {text ? (
              <Markdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema], rehypeKatex]}
                components={{
                  // Code blocks and inline code
                  code: ({ className, children }) => {
                    const match = /language-(\w+)/.exec(className || "");
                    const isBlock = match || String(children).includes("\n");
                    return isBlock ? (
                      <code className={`code-block ${className || ""}`}>{children}</code>
                    ) : (
                      <code className="code-inline">{children}</code>
                    );
                  },
                  // Tables with proper styling
                  table: ({ children }) => (
                    <div className="table-wrapper">
                      <table>{children}</table>
                    </div>
                  ),
                  // Links
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                  // Task lists
                  input: ({ type, checked, ...props }) => {
                    if (type === "checkbox") {
                      return <input type="checkbox" checked={checked} disabled className="task-checkbox" />;
                    }
                    return <input type={type} {...props} />;
                  },
                  // Blockquotes
                  blockquote: ({ children }) => <blockquote>{children}</blockquote>,
                }}
              >
                {text}
              </Markdown>
            ) : (
              <span className="composer-preview-empty">Nothing to preview</span>
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className="composer-raw-textarea"
            value={displayText}
            onChange={(e) => {
              if (!isListening) setText(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onContextMenu={handleTextareaContextMenu}
            placeholder={isListening ? "Listening..." : "Reply..."}
            readOnly={isListening}
            aria-describedby={isListening ? "voice-status" : undefined}
          />
        )}

        {/* Character counter for large messages */}
        {text.length >= 4000 && (
          <div
            role="status"
            aria-live="polite"
            aria-label="Message length counter"
            style={{
              padding: "2px 8px",
              fontSize: "11px",
              color: text.length > 30000 ? "#e67700" : "#888",
              textAlign: "right",
            }}
          >
            {text.length > 30000
              ? `Very large (${text.length.toLocaleString()} chars) — content beyond ~30K chars will be summarized`
              : `${text.length.toLocaleString()} characters (~${Math.ceil(text.length / 4).toLocaleString()} tokens, ~${((Math.ceil(text.length / 4) / 200000) * 100).toFixed(1)}% of context)`}
          </div>
        )}

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
                    style={{
                      width: 40,
                      height: 40,
                      objectFit: "cover",
                      borderRadius: 4,
                    }}
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
            {/* Theme toggle — always visible, outside !showToolbar guard */}
            <button
              className="action-btn theme-toggle"
              onClick={onThemeToggle}
              aria-label="Dark mode"
              aria-pressed={theme === "dark"}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
            <MicButton
              isListening={isListening}
              isSupported={isSpeechSupported}
              onClick={toggleListening}
              error={speechError}
            />
            {/* Icon buttons — auto-collapses into ⋮ when container overflows */}
            {!showToolbar &&
              (searchButton || projectsButton || mcpButton || skillsButton || worktreeButton || onPlanClick) && (
                <IconButtonRow>
                  {searchButton}
                  {projectsButton}
                  {worktreeButton}
                  {mcpButton}
                  {skillsButton}
                  {onPlanClick && (
                    <button className="plan-btn" onClick={onPlanClick} title="Tasks">
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
                        <path d="M9 11l3 3L22 4" />
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                      </svg>
                    </button>
                  )}
                </IconButtonRow>
              )}
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
      {hasUsedVoice && (
        <div id="voice-status" className="sr-only" aria-live="polite" aria-atomic="true">
          {isListening ? "Voice input active. Speak now." : "Voice input stopped."}
        </div>
      )}
      <div className="composer-disclaimer">Claw'd can make mistakes. You too.</div>

      {/* Composer context menu */}
      {composerContextMenu && (
        <InputContextMenu
          menu={composerContextMenu}
          onClose={closeComposerContextMenu}
          onCopy={handleContextMenuCopy}
          onCut={handleContextMenuCut}
          onPaste={handleContextMenuPaste}
          onSelectAll={handleContextMenuSelectAll}
          hasSelection={contextMenuHasSelection}
          isEditable={!isListening}
        />
      )}
    </div>
  );
}
