import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "./auth-fetch";

interface Message {
  ts: string;
  user: string;
  text: string;
  agent_id?: string;
}

interface Props {
  messages: Message[];
  isOpen: boolean;
  onClose: () => void;
  onJumpToMessage: (ts: string) => void;
  channel: string;
}

const API_URL = "";

// Highlight matching text
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="search-highlight">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

// Get preview text around the match
function getPreview(text: string, query: string, maxLength = 120): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  if (matchIndex === -1) return text.slice(0, maxLength) + (text.length > maxLength ? "..." : "");

  const contextBefore = 30;
  const start = Math.max(0, matchIndex - contextBefore);
  let end = Math.min(text.length, start + maxLength);

  if (start === 0) {
    end = Math.min(text.length, maxLength);
  }

  let preview = text.slice(start, end);

  if (start > 0) preview = `...${preview}`;
  if (end < text.length) preview = `${preview}...`;

  return preview;
}

// Format timestamp
function formatTime(ts: string): string {
  const date = new Date(parseFloat(ts) * 1000);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return (
    date.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}

function SearchIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export default function SearchModal({ messages, isOpen, onClose, onJumpToMessage, channel }: Props) {
  const [query, setQuery] = useState("");
  const [serverResults, setServerResults] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [beforeTs, setBeforeTs] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<number | null>(null);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Clear state when closed
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setServerResults([]);
      setBeforeTs(null);
      setHasMore(false);
      setActiveIndex(-1);
    }
  }, [isOpen]);

  // Search API call
  const searchMessages = useCallback(
    async (searchQuery: string, before?: string | null) => {
      if (!searchQuery.trim()) {
        setServerResults([]);
        setHasMore(false);
        return;
      }

      setLoading(true);
      try {
        const params = new URLSearchParams({
          channel,
          search: searchQuery,
          limit: "50",
        });
        if (before) params.append("before_ts", before);

        const res = await authFetch(`${API_URL}/api/conversations.search?${params}`);
        const data = await res.json();

        if (data.ok) {
          const newMessages = data.messages || [];
          if (before) {
            setServerResults((prev) => [...prev, ...newMessages]);
          } else {
            setServerResults(newMessages);
          }
          setHasMore(data.has_more || false);
          if (newMessages.length > 0) {
            setBeforeTs(newMessages[newMessages.length - 1].ts);
          }
        }
      } catch (err) {
        console.error("Search error:", err);
      } finally {
        setLoading(false);
      }
    },
    [channel],
  );

  // Debounced search on query change
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (!query.trim()) {
      setServerResults([]);
      setHasMore(false);
      setBeforeTs(null);
      setActiveIndex(-1);
      return;
    }

    searchTimeoutRef.current = window.setTimeout(() => {
      setBeforeTs(null);
      setActiveIndex(-1);
      searchMessages(query);
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [query, searchMessages]);

  // Infinite scroll in dropdown
  const handleScroll = useCallback(() => {
    const container = dropdownRef.current;
    if (!container || loading || !hasMore) return;

    const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (scrollBottom < 100) {
      searchMessages(query, beforeTs);
    }
  }, [loading, hasMore, query, beforeTs, searchMessages]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onClose]);

  // Combine local and server results
  const results = useMemo(() => {
    if (!query.trim()) return [];

    if (serverResults.length > 0) {
      return serverResults;
    }

    // Local fallback while waiting for server
    const lowerQuery = query.toLowerCase();
    return messages.filter((msg) => msg.text.toLowerCase().includes(lowerQuery)).slice(0, 20);
  }, [messages, query, serverResults]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => (prev < results.length - 1 ? prev + 1 : prev));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => (prev > 0 ? prev - 1 : -1));
      } else if (e.key === "Enter" && activeIndex >= 0 && results[activeIndex]) {
        e.preventDefault();
        onJumpToMessage(results[activeIndex].ts);
      }
    },
    [onClose, results, activeIndex, onJumpToMessage],
  );

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0 || !dropdownRef.current) return;
    const items = dropdownRef.current.querySelectorAll(".search-dropdown-item");
    items[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!isOpen) return null;

  const hasQuery = query.trim().length > 0;
  const showDropdown = hasQuery && (results.length > 0 || loading);
  const showEmpty = hasQuery && results.length === 0 && !loading;

  return (
    <div className="search-overlay">
      <div className="search-wrapper" ref={wrapperRef} role="dialog" aria-modal="true" aria-label="Search messages">
        <div className="search-input-box">
          <span className="search-input-icon">
            <SearchIcon />
          </span>
          <input
            ref={inputRef}
            type="text"
            className="search-field"
            placeholder="Search messages..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="search-kbd">Esc</kbd>
        </div>

        {(showDropdown || showEmpty) && (
          <div className="search-dropdown" ref={dropdownRef} onScroll={handleScroll}>
            {showEmpty && <div className="search-dropdown-empty">No messages found</div>}

            {results.map((msg, i) => (
              <div
                key={msg.ts}
                className={`search-dropdown-item${i === activeIndex ? " active" : ""}`}
                onClick={() => onJumpToMessage(msg.ts)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <div className="search-dropdown-item-header">
                  <span className="search-dropdown-item-author">
                    {msg.agent_id || (msg.user === "UHUMAN" ? "You" : msg.user)}
                  </span>
                  <span className="search-dropdown-item-time">{formatTime(msg.ts)}</span>
                </div>
                <div className="search-dropdown-item-text">
                  <HighlightedText text={getPreview(msg.text, query)} query={query} />
                </div>
              </div>
            ))}

            {loading && <div className="search-dropdown-status">Searching...</div>}
            {hasMore && !loading && <div className="search-dropdown-status">Scroll for more</div>}
          </div>
        )}
      </div>
    </div>
  );
}
