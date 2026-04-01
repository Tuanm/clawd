import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";
import { ClawdAvatar } from "./MessageList";

const API_URL = "";

interface TodoItem {
  id: string;
  agent_id: string;
  channel: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  order_index: number;
}

interface Agent {
  agent_id: string;
  avatar_color: string | null;
  running?: boolean;
  sleeping?: boolean;
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
}

function TodoCheckbox({ status }: { status: TodoItem["status"] }) {
  const checked = status === "completed";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "16px",
        height: "16px",
        border: checked ? "none" : "1.5px solid rgba(255,255,255,0.4)",
        borderRadius: "3px",
        background: checked ? "rgba(255,255,255,0.15)" : "transparent",
        fontSize: "11px",
        lineHeight: 1,
        flexShrink: 0,
        marginTop: "1px",
        cursor: "default",
      }}
    >
      {checked ? "✓" : ""}
    </span>
  );
}

export default function TodoDialog({ channel, isOpen, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [items, setItems] = useState<TodoItem[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!channel) return;
    setLoading(true);
    setError(null);
    try {
      const [todosRes, agentsRes] = await Promise.all([
        authFetch(`${API_URL}/api/todos.list?channel=${encodeURIComponent(channel)}`),
        authFetch(`${API_URL}/api/app.agents.list?channel=${encodeURIComponent(channel)}`),
      ]);
      const todosData = await todosRes.json();
      const agentsData = await agentsRes.json();

      if (todosData.ok) {
        // API returns { agents: [{agent_id, items}] } — flatten to a single items array
        const allItems = (todosData.agents ?? []).flatMap((a: { agent_id: string; items: TodoItem[] }) => a.items);
        setItems(allItems);
      }
      if (agentsData.ok && Array.isArray(agentsData.agents)) {
        setAgents(agentsData.agents);
        // Auto-select first agent that has todos, or first agent
        const todoAgentIds = new Set(
          (todosData.agents ?? [])
            .filter((a: { items: TodoItem[] }) => a.items.length > 0)
            .map((a: { agent_id: string }) => a.agent_id),
        );
        const firstWithTodos = agentsData.agents.find((a: Agent) => todoAgentIds.has(a.agent_id));
        setSelectedAgent((prev) => prev ?? (firstWithTodos?.agent_id || agentsData.agents[0]?.agent_id || null));
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [channel]);

  useEffect(() => {
    if (isOpen) {
      fetchData();
    } else {
      setSelectedAgent(null);
      setItems([]);
      setError(null);
    }
  }, [isOpen, fetchData]);

  if (!isOpen) return null;

  const agentItems = items.filter((i) => i.agent_id === selectedAgent);

  return createPortal(
    <div className="stream-dialog-overlay" onClick={onClose}>
      <div className="stream-dialog agent-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            <h3>Tasks</h3>
            <button className="worktree-refresh-btn" onClick={fetchData} title="Refresh" disabled={loading}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          </div>
          <button className="stream-dialog-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Agent avatar bar */}
        <div className="stream-agent-bar">
          {agents.map((agent) => {
            const color = agent.avatar_color || "#D97853";
            const isActive = selectedAgent === agent.agent_id;
            return (
              <button
                key={agent.agent_id}
                className={`stream-agent-avatar-btn ${isActive ? "active" : ""}`}
                onClick={() => setSelectedAgent(agent.agent_id)}
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

        {/* Body */}
        <div className="agent-dialog-body">
          {loading && <div className="stream-dialog-placeholder">Loading...</div>}
          {error && <div className="agent-dialog-error">{error}</div>}

          {!loading && !error && selectedAgent && (
            <>
              {/* Todo items */}
              <div style={{ padding: "4px 0" }}>
                {agentItems.length === 0 ? (
                  <div className="stream-dialog-placeholder">No active tasks</div>
                ) : (
                  agentItems.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "8px",
                        padding: "6px 16px",
                        opacity: item.status === "completed" ? 0.5 : 1,
                      }}
                    >
                      <TodoCheckbox status={item.status} />
                      <span
                        style={{
                          fontSize: "13px",
                          lineHeight: "1.4",
                          textDecoration: item.status === "completed" ? "line-through" : "none",
                          fontWeight: item.status === "in_progress" ? 600 : 400,
                        }}
                      >
                        {item.content}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {!loading && !error && !selectedAgent && agents.length === 0 && (
            <div className="stream-dialog-placeholder">No agents in this channel.</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
