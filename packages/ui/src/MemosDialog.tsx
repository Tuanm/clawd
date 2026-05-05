import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";
import { useFocusTrap } from "./hooks/useFocusTrap";
import { InputContextMenu, useInputContextMenu } from "./InputContextMenu";
import { ClawdAvatar } from "./MessageList";

const API_URL = "";

interface Agent {
  channel: string;
  agent_id: string;
  project: string;
  avatar_color: string | null;
  running: boolean;
  sleeping: boolean;
}

type MemoCategory = "fact" | "preference" | "decision" | "lesson" | "correction";

interface Memo {
  id: number;
  category: MemoCategory;
  content: string;
  priority: number;
  pinned: boolean;
  tags: string;
  access_count: number;
  last_accessed: number;
  created_at: number;
  updated_at: number;
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
}

const CATEGORY_LABEL: Record<MemoCategory, string> = {
  fact: "fact",
  preference: "pref",
  decision: "decision",
  lesson: "lesson",
  correction: "correction",
};

function formatRelativeTime(unixSec: number): string {
  if (!unixSec) return "—";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

export default function MemosDialog({ channel, isOpen, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(isOpen, dialogRef);

  const {
    menu: inputMenu,
    hasSelection: inputHasSelection,
    isEditable: inputIsEditable,
    handleContextMenu: handleInputContextMenu,
    closeMenu: closeInputMenu,
    handleCopy: handleInputCopy,
    handleCut: handleInputCut,
    handlePaste: handleInputPaste,
    handleSelectAll: handleInputSelectAll,
  } = useInputContextMenu();

  // Load agents when dialog opens
  useEffect(() => {
    if (!isOpen || !channel) return;
    const controller = new AbortController();
    authFetch(`${API_URL}/api/app.agents.list?channel=${encodeURIComponent(channel)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setAgents(data.agents);
      })
      .catch((err) => {
        if (err.name !== "AbortError") console.error(err);
      });
    return () => controller.abort();
  }, [isOpen, channel]);

  // Reset state on close
  useEffect(() => {
    if (!isOpen) {
      setSelectedAgentId(null);
      setMemos([]);
      setError(null);
      setSearchInput("");
      setSearchQuery("");
    }
  }, [isOpen]);

  const loadMemos = useCallback(
    async (agentId: string, query: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ channel, agent_id: agentId });
        if (query.trim()) params.set("query", query.trim());
        const res = await authFetch(`${API_URL}/api/app.memos.list?${params}`);
        const data = await res.json();
        if (data.ok) {
          setMemos(data.memos as Memo[]);
        } else {
          setError(data.error || "Failed to load memos");
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [channel],
  );

  // Reload memos when agent or search query changes
  useEffect(() => {
    if (!selectedAgentId) {
      setMemos([]);
      return;
    }
    loadMemos(selectedAgentId, searchQuery);
  }, [selectedAgentId, searchQuery, loadMemos]);

  // Debounce search input → searchQuery
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  if (!isOpen) return null;

  return createPortal(
    <div className="stream-dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="stream-dialog memos-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memos-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            <h3 id="memos-dialog-title">Memos</h3>
            <button
              className="worktree-refresh-btn"
              onClick={() => selectedAgentId && loadMemos(selectedAgentId, searchQuery)}
              title="Refresh"
              disabled={loading || !selectedAgentId}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          </div>
          <button className="stream-dialog-close" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </div>

        {/* Agent avatar bar */}
        <div className="stream-agent-bar">
          {agents.map((agent) => {
            const isActive = selectedAgentId === agent.agent_id;
            const color = agent.avatar_color || "#D97853";
            return (
              <button
                key={agent.agent_id}
                className={`stream-agent-avatar-btn ${isActive ? "active" : ""}`}
                onClick={() => {
                  setSelectedAgentId(agent.agent_id);
                  setError(null);
                }}
                title={agent.agent_id}
              >
                <span className="stream-agent-avatar-wrap">
                  <ClawdAvatar color={color} standing={agent.running && !agent.sleeping} sleeping={agent.sleeping} />
                </span>
                <span className="stream-agent-avatar-name">{agent.agent_id}</span>
              </button>
            );
          })}
        </div>

        {/* Search */}
        {selectedAgentId && (
          <div className="memos-dialog-search">
            <input
              className="agent-field-input"
              placeholder="Search memos..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onContextMenu={handleInputContextMenu}
            />
          </div>
        )}

        {/* Body */}
        <div className="memos-dialog-body">
          {!selectedAgentId ? (
            <div className="stream-dialog-placeholder">
              {agents.length === 0 ? "No agents in this channel." : "Select an agent above to view memos."}
            </div>
          ) : loading ? (
            <div className="skills-list-empty">Loading...</div>
          ) : memos.length === 0 ? (
            <div className="stream-dialog-placeholder">
              {searchQuery ? `No memos matching "${searchQuery}".` : "No memos yet for this agent."}
            </div>
          ) : (
            <div className="memos-cards-list">
              {memos.map((m) => (
                <div key={m.id} className="memo-card">
                  <div className="memo-card-header">
                    <span className={`memo-category memo-category--${m.category}`}>{CATEGORY_LABEL[m.category]}</span>
                    {m.pinned && (
                      <span className="memo-pin" title="Pinned">
                        ★
                      </span>
                    )}
                    <span className="memo-meta">
                      {formatRelativeTime(m.updated_at)} · {m.access_count}×
                    </span>
                  </div>
                  <div className="memo-card-content">{m.content}</div>
                  {m.tags && (
                    <div className="memo-card-tags">
                      {m.tags
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean)
                        .slice(0, 6)
                        .map((t) => (
                          <span key={t} className="memo-tag">
                            {t}
                          </span>
                        ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {error && <div className="agent-dialog-error">{error}</div>}
        </div>
      </div>

      {inputMenu && (
        <InputContextMenu
          menu={inputMenu}
          onClose={closeInputMenu}
          hasSelection={inputHasSelection}
          isEditable={inputIsEditable}
          onCopy={handleInputCopy}
          onCut={handleInputCut}
          onPaste={handleInputPaste}
          onSelectAll={handleInputSelectAll}
        />
      )}
    </div>,
    document.body,
  );
}
