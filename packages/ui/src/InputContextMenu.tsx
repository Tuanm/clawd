import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ─── Icons ────────────────────────────────────────────────────────────────────

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="6" cy="20" r="2" />
      <circle cx="6" cy="4" r="2" />
      <line x1="8.12" y1="5.17" x2="19" y2="10.5" />
      <line x1="8.12" y1="18.83" x2="19" y2="13.5" />
      <line x1="19" y1="10.5" x2="19" y2="13.5" />
    </svg>
  );
}

function PasteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  );
}

function SelectAllIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M8 12h8M12 8v8" />
    </svg>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface InputContextMenuProps {
  menu: { x: number; y: number };
  onClose: () => void;
  hasSelection: boolean;
  /** When false, Cut is hidden (e.g. read-only fields) */
  isEditable?: boolean;
  onCopy: () => void;
  onCut: () => void;
  onSelectAll: () => void;
  /** If provided, a Paste item is shown (composer-specific) */
  onPaste?: () => void;
  /** Set to false to hide the Select All item (default: true) */
  showSelectAll?: boolean;
}

export function InputContextMenu({
  menu,
  onClose,
  hasSelection,
  isEditable = true,
  onCopy,
  onCut,
  onSelectAll,
  onPaste,
  showSelectAll = true,
}: InputContextMenuProps) {
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
    const menuHeight = 200; // generous estimate
    let x = menu.x;
    let y = menu.y;
    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8;
    return { x, y };
  }, [menu.x, menu.y]);

  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const copyShortcut = isMac ? "⌘C" : "Ctrl+C";
  const cutShortcut = isMac ? "⌘X" : "Ctrl+X";
  const pasteShortcut = isMac ? "⌘V" : "Ctrl+V";
  const selectAllShortcut = isMac ? "⌘A" : "Ctrl+A";

  return createPortal(
    <div
      ref={menuRef}
      className="message-context-menu"
      style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Copy */}
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

      {/* Cut — only for editable inputs */}
      {isEditable && (
        <button
          className={`context-menu-item${!hasSelection ? " disabled" : ""}`}
          onClick={() => {
            if (hasSelection) {
              onCut();
              onClose();
            }
          }}
          disabled={!hasSelection}
        >
          <CutIcon />
          <span>Cut</span>
          <span className="context-menu-shortcut">{cutShortcut}</span>
        </button>
      )}

      {/* Paste — optional, composer-specific */}
      {onPaste && (
        <button
          className="context-menu-item"
          onClick={() => {
            onPaste!();
            onClose();
          }}
        >
          <PasteIcon />
          <span>Paste</span>
          <span className="context-menu-shortcut">{pasteShortcut}</span>
        </button>
      )}

      {/* Select All */}
      {showSelectAll && (
        <button
          className="context-menu-item"
          onClick={() => {
            onSelectAll();
            onClose();
          }}
        >
          <SelectAllIcon />
          <span>Select all</span>
          <span className="context-menu-shortcut">{selectAllShortcut}</span>
        </button>
      )}
    </div>,
    document.body,
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseInputContextMenuResult {
  menu: { x: number; y: number } | null;
  hasSelection: boolean;
  isEditable: boolean;
  handleContextMenu: (e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  closeMenu: () => void;
  handleCopy: () => void;
  handleCut: () => void;
  handleSelectAll: () => void;
}

/**
 * Generic context menu hook for any text <input> or <textarea>.
 * Uses document.execCommand for copy/cut (works with controlled React inputs).
 * The right-clicked element is captured automatically via event.currentTarget.
 */
export function useInputContextMenu(): UseInputContextMenuResult {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [isEditable, setIsEditable] = useState(true);
  const activeEl = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    activeEl.current = el;
    setHasSelection(el.selectionStart !== el.selectionEnd);
    setIsEditable(!(el as HTMLInputElement).readOnly);
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const handleCopy = useCallback(() => {
    const el = activeEl.current;
    if (!el) return;
    el.focus();
    document.execCommand("copy");
  }, []);

  const handleCut = useCallback(() => {
    const el = activeEl.current;
    if (!el) return;
    el.focus();
    document.execCommand("cut");
  }, []);

  const handleSelectAll = useCallback(() => {
    const el = activeEl.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, el.value.length);
    setHasSelection(el.value.length > 0);
  }, []);

  return { menu, hasSelection, isEditable, handleContextMenu, closeMenu, handleCopy, handleCut, handleSelectAll };
}
