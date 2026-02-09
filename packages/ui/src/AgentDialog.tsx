import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClawdAvatar } from "./MessageList";

const API_URL = "";

interface Agent {
  channel: string;
  agent_id: string;
  model: string;
  project: string;
  active: boolean;
  running: boolean;
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function FolderIcon() {
  return (
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
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// Simple color hash for agents
function agentColor(agentId: string): string {
  const colors = [
    "#D97853",
    "#7A4AD9",
    "#4A9BD9",
    "#D94A7A",
    "#4AD98A",
    "#D9B34A",
    "#4AD9D9",
    "#9B4AD9",
    "#D97A4A",
    "#4A6BD9",
  ];
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export default function AgentDialog({ channel, isOpen, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add form state
  const [newName, setNewName] = useState("");
  const [newModel, setNewModel] = useState("claude-sonnet-4");
  const [newProject, setNewProject] = useState("");
  const [saving, setSaving] = useState(false);

  // Folder browser state
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [folders, setFolders] = useState<{ name: string; path: string }[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);

  // Load agents when dialog opens
  useEffect(() => {
    if (!isOpen || !channel) return;
    loadAgents();
    const interval = setInterval(loadAgents, 5000);
    return () => clearInterval(interval);
  }, [isOpen, channel]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedAgentId(null);
      setShowAddForm(false);
      setError(null);
      setNewName("");
      setNewModel("claude-sonnet-4");
      setNewProject("");
      setShowFolderBrowser(false);
    }
  }, [isOpen]);

  // Focus name input when add form shows
  useEffect(() => {
    if (showAddForm) {
      setTimeout(() => nameInputRef.current?.focus(), 100);
    }
  }, [showAddForm]);

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/app.agents.list?channel=${encodeURIComponent(channel)}`);
      const data = await res.json();
      if (data.ok) {
        setAgents(data.agents);
      }
    } catch {
      // silent
    }
  }, [channel]);

  const handleAddAgent = useCallback(async () => {
    if (!newName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/app.agents.add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          agent_id: newName.trim(),
          model: newModel.trim() || "claude-sonnet-4",
          project: newProject.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setNewName("");
        setNewModel("claude-sonnet-4");
        setNewProject("");
        setShowAddForm(false);
        setSelectedAgentId(newName.trim());
        await loadAgents();
      } else {
        setError(data.error || "Failed to add agent");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [channel, newName, newModel, newProject, loadAgents]);

  const handleRemoveAgent = useCallback(
    async (agentId: string) => {
      setError(null);
      try {
        const res = await fetch(`${API_URL}/api/app.agents.remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, agent_id: agentId }),
        });
        const data = await res.json();
        if (data.ok) {
          setSelectedAgentId(null);
          await loadAgents();
        } else {
          setError(data.error || "Failed to remove agent");
        }
      } catch (err) {
        setError(String(err));
      }
    },
    [channel, loadAgents],
  );

  const loadFolders = useCallback(async (path: string) => {
    setFolderLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/app.folders.list?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.ok) {
        setFolderPath(data.path);
        setFolders(data.folders);
      }
    } catch {
      // silent
    } finally {
      setFolderLoading(false);
    }
  }, []);

  const handleFolderSelect = useCallback((path: string) => {
    setNewProject(path);
    setShowFolderBrowser(false);
  }, []);

  const selectedAgent = agents.find((a) => a.agent_id === selectedAgentId);

  if (!isOpen) return null;

  return createPortal(
    <div className="stream-dialog-overlay" onClick={onClose}>
      <div className="stream-dialog agent-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            <h3>Agents</h3>
          </div>
          <button className="stream-dialog-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Agent avatar bar */}
        <div className="stream-agent-bar">
          {agents.map((agent) => {
            const isActive = selectedAgentId === agent.agent_id && !showAddForm;
            const color = agentColor(agent.agent_id);
            return (
              <button
                key={agent.agent_id}
                className={`stream-agent-avatar-btn ${isActive ? "active" : ""}`}
                onClick={() => {
                  setSelectedAgentId(agent.agent_id);
                  setShowAddForm(false);
                  setError(null);
                }}
                title={agent.agent_id}
              >
                <span className="stream-agent-avatar-wrap">
                  <ClawdAvatar color={color} standing={agent.running} />
                  {agent.running && <span className="stream-agent-avatar-dot" />}
                </span>
                <span className="stream-agent-avatar-name">{agent.agent_id}</span>
              </button>
            );
          })}
          {/* Plus button to add agent */}
          <button
            className={`stream-agent-avatar-btn agent-add-btn ${showAddForm ? "active" : ""}`}
            onClick={() => {
              setShowAddForm(true);
              setSelectedAgentId(null);
              setError(null);
            }}
            title="Add agent"
          >
            <span className="agent-add-icon">
              <PlusIcon />
            </span>
            <span className="stream-agent-avatar-name">Add</span>
          </button>
        </div>

        {/* Body */}
        <div className="agent-dialog-body">
          {/* No selection placeholder */}
          {!selectedAgent && !showAddForm && (
            <div className="stream-dialog-placeholder">
              {agents.length === 0
                ? "No agents configured. Click + to add one."
                : "Select an agent above to see details."}
            </div>
          )}

          {/* Selected agent details */}
          {selectedAgent && !showAddForm && (
            <div className="agent-detail">
              <div className="agent-detail-row">
                <span className="agent-detail-label">Name</span>
                <span className="agent-detail-value">{selectedAgent.agent_id}</span>
              </div>
              <div className="agent-detail-row">
                <span className="agent-detail-label">Project</span>
                <span className="agent-detail-value">
                  {selectedAgent.project || <span className="agent-detail-empty">Not set</span>}
                </span>
              </div>
              <div className="agent-detail-row">
                <span className="agent-detail-label">Model</span>
                <span className="agent-detail-value">{selectedAgent.model}</span>
              </div>
              <div className="agent-detail-row">
                <span className="agent-detail-label">Status</span>
                <span className={`agent-detail-value agent-status ${selectedAgent.running ? "running" : "stopped"}`}>
                  {selectedAgent.running ? "Running" : "Stopped"}
                </span>
              </div>
              <button className="agent-remove-btn" onClick={() => handleRemoveAgent(selectedAgent.agent_id)}>
                Remove from channel
              </button>
            </div>
          )}

          {/* Add agent form */}
          {showAddForm && (
            <div className="agent-add-form">
              <div className="agent-form-field">
                <label className="agent-form-label">Name</label>
                <input
                  ref={nameInputRef}
                  type="text"
                  className="agent-form-input"
                  placeholder="Agent ID (e.g., Claw'd)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddAgent();
                    if (e.key === "Escape") {
                      setShowAddForm(false);
                      setError(null);
                    }
                  }}
                />
              </div>
              <div className="agent-form-field">
                <label className="agent-form-label">Model</label>
                <input
                  type="text"
                  className="agent-form-input"
                  placeholder="claude-sonnet-4"
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddAgent();
                  }}
                />
              </div>
              <div className="agent-form-field">
                <label className="agent-form-label">Project</label>
                <div className="agent-form-folder-row">
                  <input
                    type="text"
                    className="agent-form-input agent-form-folder-input"
                    placeholder="/path/to/project"
                    value={newProject}
                    onChange={(e) => setNewProject(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddAgent();
                    }}
                  />
                  <button
                    className="agent-form-folder-btn"
                    onClick={() => {
                      setShowFolderBrowser(!showFolderBrowser);
                      if (!showFolderBrowser) {
                        loadFolders(newProject || "/");
                      }
                    }}
                    title="Browse folders"
                  >
                    <FolderIcon />
                  </button>
                </div>
                {/* Inline folder browser */}
                {showFolderBrowser && (
                  <div className="agent-folder-browser">
                    <div className="agent-folder-path">
                      <span className="agent-folder-current">{folderPath || "/"}</span>
                      <button className="agent-folder-select-btn" onClick={() => handleFolderSelect(folderPath)}>
                        Select
                      </button>
                    </div>
                    <div className="agent-folder-list">
                      {folderPath && folderPath !== "/" && (
                        <button
                          className="agent-folder-item"
                          onClick={() => {
                            const parent = folderPath.split("/").slice(0, -1).join("/") || "/";
                            loadFolders(parent);
                          }}
                        >
                          📁 ..
                        </button>
                      )}
                      {folderLoading ? (
                        <div className="agent-folder-loading">Loading...</div>
                      ) : (
                        folders.map((f) => (
                          <button key={f.path} className="agent-folder-item" onClick={() => loadFolders(f.path)}>
                            📁 {f.name}
                          </button>
                        ))
                      )}
                      {!folderLoading && folders.length === 0 && (
                        <div className="agent-folder-empty">No subdirectories</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <button className="agent-add-submit-btn" onClick={handleAddAgent} disabled={!newName.trim() || saving}>
                {saving ? "Adding..." : "Add"}
              </button>
            </div>
          )}

          {error && <div className="agent-dialog-error">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
