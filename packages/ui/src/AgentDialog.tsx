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
      width="14"
      height="14"
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

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="15 18 9 12 15 6" />
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

          {/* Selected agent details -- same input layout as Add, but readonly */}
          {selectedAgent && !showAddForm && (
            <div className="agent-fields">
              <input type="text" className="agent-field-input" placeholder="Name" value={selectedAgent.agent_id} readOnly />
              <input type="text" className="agent-field-input" placeholder="Model" value={selectedAgent.model} readOnly />
              <input
                type="text"
                className="agent-field-input"
                placeholder="Project"
                value={selectedAgent.project || ""}
                readOnly
              />
              <button className="agent-action-btn agent-action-btn--danger" onClick={() => handleRemoveAgent(selectedAgent.agent_id)}>
                Remove
              </button>
            </div>
          )}

          {/* Add agent form -- same input layout as details */}
          {showAddForm && (
            <div className="agent-fields">
              <input
                ref={nameInputRef}
                type="text"
                className="agent-field-input"
                placeholder="Name"
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
              <input
                type="text"
                className="agent-field-input"
                placeholder="Model"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddAgent();
                }}
              />
              <div className="agent-field-browse">
                <input
                  type="text"
                  className="agent-field-input"
                  placeholder="Project"
                  value={newProject}
                  onChange={(e) => setNewProject(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddAgent();
                  }}
                />
                <button
                  className="agent-field-browse-btn"
                  onClick={() => {
                    setShowFolderBrowser(!showFolderBrowser);
                    if (!showFolderBrowser) {
                      loadFolders(newProject || "/");
                    }
                  }}
                  title="Browse"
                >
                  <FolderIcon />
                </button>
              </div>
              {/* Minimal folder browser */}
              {showFolderBrowser && (
                <div className="agent-browser">
                  <div className="agent-browser-head">
                    {folderPath && folderPath !== "/" && (
                      <button
                        className="agent-browser-back"
                        onClick={() => {
                          const parent = folderPath.split("/").slice(0, -1).join("/") || "/";
                          loadFolders(parent);
                        }}
                      >
                        <ChevronIcon />
                      </button>
                    )}
                    <span className="agent-browser-path">{folderPath || "/"}</span>
                    <button className="agent-action-btn agent-action-btn--accent agent-browser-select" onClick={() => handleFolderSelect(folderPath)}>
                      Select
                    </button>
                  </div>
                  <div className="agent-browser-list">
                    {folderLoading ? (
                      <div className="agent-browser-empty">Loading...</div>
                    ) : folders.length === 0 ? (
                      <div className="agent-browser-empty">No subdirectories</div>
                    ) : (
                      folders.map((f) => (
                        <button key={f.path} className="agent-browser-item" onClick={() => loadFolders(f.path)}>
                          {f.name}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
              <button
                className="agent-action-btn agent-action-btn--accent"
                onClick={handleAddAgent}
                disabled={!newName.trim() || saving}
              >
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

