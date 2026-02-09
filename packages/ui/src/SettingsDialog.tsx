import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

const API_URL = "";

interface Agent {
  channel: string;
  agent_id: string;
  model: string;
  active: boolean;
  running: boolean;
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsDialog({ channel, isOpen, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newAgentId, setNewAgentId] = useState("");
  const [newAgentModel, setNewAgentModel] = useState("claude-sonnet-4");
  const [saving, setSaving] = useState(false);

  // Track local model edits per agent (keyed by agent_id)
  const [modelEdits, setModelEdits] = useState<Record<string, string>>({});

  // Fetch agents for current channel
  const fetchAgents = useCallback(async () => {
    if (!channel) return;
    try {
      const res = await fetch(`${API_URL}/api/app.agents.list?channel=${encodeURIComponent(channel)}`);
      const data = await res.json();
      if (data.ok) {
        setAgents(data.agents || []);
      }
    } catch (err) {
      console.error("Failed to load agents:", err);
    }
  }, [channel]);

  // Fetch on open + poll every 5 seconds
  useEffect(() => {
    if (!isOpen) return;
    fetchAgents();
    const interval = setInterval(fetchAgents, 5000);
    return () => clearInterval(interval);
  }, [isOpen, fetchAgents]);

  // Reset form state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setShowAddForm(false);
      setNewAgentId("");
      setNewAgentModel("claude-sonnet-4");
      setError(null);
      setModelEdits({});
    }
  }, [isOpen]);

  // Add agent
  const handleAddAgent = useCallback(async () => {
    if (!newAgentId.trim() || !channel) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/app.agents.add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          agent_id: newAgentId.trim(),
          model: newAgentModel,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setNewAgentId("");
        setNewAgentModel("claude-sonnet-4");
        setShowAddForm(false);
        fetchAgents();
      } else {
        setError(data.error || "Failed to add agent");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [channel, newAgentId, newAgentModel, fetchAgents]);

  // Remove agent
  const handleRemoveAgent = useCallback(
    async (agentId: string) => {
      try {
        await fetch(`${API_URL}/api/app.agents.remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, agent_id: agentId }),
        });
        fetchAgents();
      } catch (err) {
        console.error("Failed to remove agent:", err);
      }
    },
    [channel, fetchAgents],
  );

  // Toggle agent active state
  const handleToggleAgent = useCallback(
    async (agent: Agent) => {
      try {
        await fetch(`${API_URL}/api/app.agents.update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: agent.channel,
            agent_id: agent.agent_id,
            active: !agent.active,
          }),
        });
        fetchAgents();
      } catch (err) {
        console.error("Failed to toggle agent:", err);
      }
    },
    [fetchAgents],
  );

  // Update agent model
  const handleUpdateModel = useCallback(
    async (agent: Agent, newModel: string) => {
      const trimmed = newModel.trim();
      if (!trimmed || trimmed === agent.model) {
        // Reset to original if empty or unchanged
        setModelEdits((prev) => {
          const next = { ...prev };
          delete next[agent.agent_id];
          return next;
        });
        return;
      }
      try {
        await fetch(`${API_URL}/api/app.agents.update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: agent.channel,
            agent_id: agent.agent_id,
            model: trimmed,
          }),
        });
        setModelEdits((prev) => {
          const next = { ...prev };
          delete next[agent.agent_id];
          return next;
        });
        fetchAgents();
      } catch (err) {
        console.error("Failed to update model:", err);
      }
    },
    [fetchAgents],
  );

  // Handle model input change (local edit)
  const handleModelInputChange = useCallback((agentId: string, value: string) => {
    setModelEdits((prev) => ({ ...prev, [agentId]: value }));
  }, []);

  // Handle model input commit (blur or Enter)
  const handleModelInputCommit = useCallback(
    (agent: Agent) => {
      const editedValue = modelEdits[agent.agent_id];
      if (editedValue !== undefined) {
        handleUpdateModel(agent, editedValue);
      }
    },
    [modelEdits, handleUpdateModel],
  );

  if (!isOpen) return null;

  return createPortal(
    <div className="modal-overlay channel-dialog-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-dialog-header">
          <h2 className="settings-dialog-title">Settings</h2>
          <button className="settings-dialog-close-btn" onClick={onClose}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="settings-dialog-content">
          {/* Section header with Add button */}
          <div className="settings-section-header">
            <h3 className="settings-section-title">Agents</h3>
            {!showAddForm && (
              <button className="settings-add-btn" onClick={() => setShowAddForm(true)}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Add Agent
              </button>
            )}
          </div>

          {/* Add agent form */}
          {showAddForm && (
            <div className="settings-add-form">
              <div className="settings-form-row">
                <label className="settings-form-label">Agent ID</label>
                <input
                  type="text"
                  className="settings-input"
                  value={newAgentId}
                  onChange={(e) => setNewAgentId(e.target.value)}
                  placeholder="e.g. Claw'd"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddAgent();
                    if (e.key === "Escape") setShowAddForm(false);
                  }}
                />
              </div>
              <div className="settings-form-row">
                <label className="settings-form-label">Model</label>
                <input
                  type="text"
                  className="settings-input"
                  value={newAgentModel}
                  onChange={(e) => setNewAgentModel(e.target.value)}
                  placeholder="claude-sonnet-4"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddAgent();
                    if (e.key === "Escape") setShowAddForm(false);
                  }}
                />
              </div>
              {error && <div className="settings-error">{error}</div>}
              <div className="settings-form-actions">
                <button
                  className="settings-cancel-btn"
                  onClick={() => {
                    setShowAddForm(false);
                    setError(null);
                  }}
                >
                  Cancel
                </button>
                <button className="settings-save-btn" onClick={handleAddAgent} disabled={!newAgentId.trim() || saving}>
                  {saving ? "Adding..." : "Add"}
                </button>
              </div>
            </div>
          )}

          {/* Agent list */}
          {agents.length === 0 ? (
            <div className="settings-empty">No agents in this channel yet. Click "Add Agent" to get started.</div>
          ) : (
            <div className="settings-agent-list">
              {agents.map((agent) => (
                <div key={agent.agent_id} className={`settings-agent-row ${!agent.active ? "inactive" : ""}`}>
                  <div className="settings-agent-info">
                    <div className="settings-agent-avatar">
                      <svg width="18" height="14" viewBox="0 0 66 52" fill="none">
                        <rect
                          x="0"
                          y="13"
                          width="6"
                          height="13"
                          fill={agent.active ? "hsl(15 63.1% 59.6%)" : "hsl(0 0% 60%)"}
                        />
                        <rect
                          x="60"
                          y="13"
                          width="6"
                          height="13"
                          fill={agent.active ? "hsl(15 63.1% 59.6%)" : "hsl(0 0% 60%)"}
                        />
                        <rect
                          x="6"
                          y="39"
                          width="6"
                          height="13"
                          fill={agent.active ? "hsl(15 63.1% 59.6%)" : "hsl(0 0% 60%)"}
                        />
                        <rect
                          x="18"
                          y="39"
                          width="6"
                          height="13"
                          fill={agent.active ? "hsl(15 63.1% 59.6%)" : "hsl(0 0% 60%)"}
                        />
                        <rect
                          x="42"
                          y="39"
                          width="6"
                          height="13"
                          fill={agent.active ? "hsl(15 63.1% 59.6%)" : "hsl(0 0% 60%)"}
                        />
                        <rect
                          x="54"
                          y="39"
                          width="6"
                          height="13"
                          fill={agent.active ? "hsl(15 63.1% 59.6%)" : "hsl(0 0% 60%)"}
                        />
                        <rect
                          x="6"
                          width="54"
                          height="39"
                          fill={agent.active ? "hsl(15 63.1% 59.6%)" : "hsl(0 0% 60%)"}
                        />
                        <rect
                          x="12"
                          y={agent.active ? "13" : "16"}
                          width="6"
                          height={agent.active ? "6.5" : "2"}
                          fill="#000"
                        />
                        <rect
                          x="48"
                          y={agent.active ? "13" : "16"}
                          width="6"
                          height={agent.active ? "6.5" : "2"}
                          fill="#000"
                        />
                      </svg>
                    </div>
                    <div className="settings-agent-details">
                      <span className="settings-agent-name">{agent.agent_id}</span>
                      <div className="settings-agent-meta">
                        <input
                          type="text"
                          className="settings-input settings-model-input"
                          value={modelEdits[agent.agent_id] !== undefined ? modelEdits[agent.agent_id] : agent.model}
                          onChange={(e) => handleModelInputChange(agent.agent_id, e.target.value)}
                          onBlur={() => handleModelInputCommit(agent)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              (e.target as HTMLInputElement).blur();
                            }
                          }}
                          placeholder="Model name"
                        />
                        <span className={`settings-agent-status ${agent.running ? "running" : "stopped"}`}>
                          {agent.running ? "Running" : agent.active ? "Stopped" : "Disabled"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="settings-agent-actions">
                    {/* Toggle active/inactive */}
                    <button
                      className={`settings-toggle-btn ${agent.active ? "active" : ""}`}
                      onClick={() => handleToggleAgent(agent)}
                      title={agent.active ? "Disable agent" : "Enable agent"}
                    >
                      <div className="settings-toggle-track">
                        <div className="settings-toggle-thumb" />
                      </div>
                    </button>
                    {/* Remove */}
                    <button
                      className="settings-remove-btn"
                      onClick={() => handleRemoveAgent(agent.agent_id)}
                      title="Remove agent"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                        <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
