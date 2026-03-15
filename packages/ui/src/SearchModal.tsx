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

// Highlight matching text with yellow background
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
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
function getPreview(text: string, query: string, maxLength = 100): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  if (matchIndex === -1) return text.slice(0, maxLength) + (text.length > maxLength ? "..." : "");

  // Calculate start position to center the match
  const contextBefore = 30;
  const start = Math.max(0, matchIndex - contextBefore);
  let end = Math.min(text.length, start + maxLength);

  // Adjust if we're at the beginning
  if (start === 0) {
    end = Math.min(text.length, maxLength);
  }

  let preview = text.slice(start, end);

  // Add ellipsis
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

export default function SearchModal({ messages, isOpen, onClose, onJumpToMessage, channel }: Props) {
  const [query, setQuery] = useState("");
  const [serverResults, setServerResults] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [beforeTs, setBeforeTs] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<number | null>(null);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Clear state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setServerResults([]);
      setBeforeTs(null);
      setHasMore(false);
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
      return;
    }

    searchTimeoutRef.current = window.setTimeout(() => {
      setBeforeTs(null);
      searchMessages(query);
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [query, searchMessages]);

  // Infinite scroll
  const handleScroll = useCallback(() => {
    const container = resultsRef.current;
    if (!container || loading || !hasMore) return;

    const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (scrollBottom < 100) {
      searchMessages(query, beforeTs);
    }
  }, [loading, hasMore, query, beforeTs, searchMessages]);

  // Handle keyboard
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [isOpen, onClose]);

  // Combine local and server results (prefer server when searching)
  const results = useMemo(() => {
    if (!query.trim()) return [];

    // Use server results if available, otherwise fall back to local filtering
    if (serverResults.length > 0) {
      return serverResults;
    }

    // Local fallback while waiting for server
    const lowerQuery = query.toLowerCase();
    return messages.filter((msg) => msg.text.toLowerCase().includes(lowerQuery)).slice(0, 20);
  }, [messages, query, serverResults]);

  if (!isOpen) return null;

  const hasQuery = query.trim().length > 0;

  return (
    <div className="search-modal-overlay" onClick={onClose}>
      <div className={`search-modal ${hasQuery ? "has-results" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="search-modal-header">
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="Search messages..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="search-close" onClick={onClose}>
            ×
          </button>
        </div>

        {hasQuery && (
          <div className="search-results" ref={resultsRef} onScroll={handleScroll}>
            {results.length === 0 && !loading && <div className="search-empty">No messages found</div>}

            {results.map((msg) => (
              <div key={msg.ts} className="search-result-item" onClick={() => onJumpToMessage(msg.ts)}>
                <div className="search-result-meta">
                  <span className="search-result-author">
                    {msg.agent_id || (msg.user === "UHUMAN" ? "You" : msg.user)}
                  </span>
                  <span className="search-result-time">{formatTime(msg.ts)}</span>
                </div>
                <div className="search-result-text">
                  <HighlightedText text={getPreview(msg.text, query)} query={query} />
                </div>
              </div>
            ))}

            {loading && <div className="search-loading">Searching...</div>}

            {hasMore && !loading && <div className="search-more">Scroll for more results</div>}
          </div>
        )}
      </div>
    </div>
  );
}
