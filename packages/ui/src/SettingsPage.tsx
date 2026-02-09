import { useCallback, useEffect, useState } from "react";

const API_URL = "";

interface Model {
  id: string;
  name: string;
  description: string;
}

interface Agent {
  channel: string;
  agent_id: string;
  model: string;
  active: boolean;
  running: boolean;
}

export default function SettingsPage() {
  // Get all channels from stored channels in localStorage (same as App.tsx pattern)
  const [channels, setChannels] = useState<string[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string>("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newAgentId, setNewAgentId] = useState("");
  const [newAgentModel, setNewAgentModel] = useState("claude-sonnet-4");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load channels from localStorage (same key as App.tsx: "clawd-open-channels")
  useEffect(() => {
    const stored = localStorage.getItem("clawd-open-channels");
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setChannels(parsed);
          setSelectedChannel(parsed[0]);
        }
      } catch {}
    }
  }, []);

  // Load models on mount
  useEffect(() => {
    fetch(`${API_URL}/api/app.models.list`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && data.models) {
          setModels(data.models);
          if (data.models.length > 0) {
            setNewAgentModel(data.models[0].id);
          }
        }
      })
      .catch((err) => console.error("Failed to load models:", err));
  }, []);

  // Load agents when channel changes
  const fetchAgents = useCallback(async () => {
    if (!selectedChannel) {
      setAgents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/app.agents.list?channel=${encodeURIComponent(selectedChannel)}`);
      const data = await res.json();
      if (data.ok) {
        setAgents(data.agents || []);
      }
    } catch (err) {
      console.error("Failed to load agents:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedChannel]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Poll agent status every 5 seconds
  useEffect(() => {
    if (!selectedChannel) return;
    const interval = setInterval(fetchAgents, 5000);
    return () => clearInterval(interval);
  }, [selectedChannel, fetchAgents]);

  // Add agent
  const handleAddAgent = async () => {
    if (!newAgentId.trim() || !selectedChannel) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/app.agents.add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: selectedChannel,
          agent_id: newAgentId.trim(),
          model: newAgentModel,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setNewAgentId("");
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
  };

  // Remove agent
  const handleRemoveAgent = async (agentId: string) => {
    if (!confirm(`Remove agent "${agentId}" from ${selectedChannel}?`)) return;
    try {
      await fetch(`${API_URL}/api/app.agents.remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: selectedChannel, agent_id: agentId }),
      });
      fetchAgents();
    } catch (err) {
      console.error("Failed to remove agent:", err);
    }
  };

  // Toggle agent active state
  const handleToggleAgent = async (agent: Agent) => {
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
  };

  // Update agent model
  const handleUpdateModel = async (agent: Agent, newModel: string) => {
    try {
      await fetch(`${API_URL}/api/app.agents.update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: agent.channel,
          agent_id: agent.agent_id,
          model: newModel,
        }),
      });
      fetchAgents();
    } catch (err) {
      console.error("Failed to update model:", err);
    }
  };

  // Navigate back
  const goBack = () => {
    if (selectedChannel) {
      window.location.href = `/${selectedChannel}`;
    } else {
      window.location.href = "/";
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-container">
        {/* Header */}
        <div className="settings-header">
          <button className="settings-back-btn" onClick={goBack} title="Go back">
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
              <path d="M19 12H5" />
              <path d="M12 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="settings-title">Settings</h1>
        </div>

        {/* Channel selector */}
        <div className="settings-section">
          <label className="settings-label">Channel</label>
          {channels.length > 0 ? (
            <select
              className="settings-select"
              value={selectedChannel}
              onChange={(e) => setSelectedChannel(e.target.value)}
            >
              {channels.map((ch) => (
                <option key={ch} value={ch}>
                  {ch}
                </option>
              ))}
            </select>
          ) : (
            <p className="settings-hint">No channels found. Open a channel first, then return here.</p>
          )}
        </div>

        {/* Agents section */}
        {selectedChannel && (
          <div className="settings-section">
            <div className="settings-section-header">
              <h2 className="settings-section-title">Agents</h2>
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
                  <select
                    className="settings-select"
                    value={newAgentModel}
                    onChange={(e) => setNewAgentModel(e.target.value)}
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} -- {m.description}
                      </option>
                    ))}
                  </select>
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
                  <button
                    className="settings-save-btn"
                    onClick={handleAddAgent}
                    disabled={!newAgentId.trim() || saving}
                  >
                    {saving ? "Adding..." : "Add"}
                  </button>
                </div>
              </div>
            )}

            {/* Agent list */}
            {loading ? (
              <div className="settings-loading">Loading agents...</div>
            ) : agents.length === 0 ? (
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
                          <select
                            className="settings-model-select"
                            value={agent.model}
                            onChange={(e) => handleUpdateModel(agent, e.target.value)}
                          >
                            {models.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                            {/* In case the agent has a model not in the list */}
                            {!models.find((m) => m.id === agent.model) && (
                              <option value={agent.model}>{agent.model}</option>
                            )}
                          </select>
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
        )}
      </div>
    </div>
  );
}
