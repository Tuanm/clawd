import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";
import { ClawdAvatar } from "./MessageList";
import { useInputContextMenu, InputContextMenu } from "./InputContextMenu";

const API_URL = "";

interface Agent {
  channel: string;
  agent_id: string;
  provider: string;
  model: string;
  project: string;
  active: boolean;
  sleeping: boolean;
  running: boolean;
  avatar_color: string | null;
  heartbeat_interval: number;
  agent_type: string | null;
  worker_token: string | null;
}

interface ProviderOption {
  name: string;
  type: string;
  is_custom: boolean;
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
}

/** Custom dropdown — same style as homepage channel dropdown */
function CustomSelect({
  value,
  options,
  onChange,
  placeholder = "Select...",
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selectedLabel = options.find((o) => o.value === value)?.label || placeholder;

  return (
    <div className="custom-select" ref={ref}>
      <button type="button" className="agent-field-input custom-select-trigger" onClick={() => setOpen(!open)}>
        <span className={`custom-select-value ${!value ? "custom-select-placeholder" : ""}`}>{selectedLabel}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className={`custom-select-arrow ${open ? "open" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="custom-select-dropdown">
          {options.map((o) => (
            <div
              key={o.value}
              className={`custom-select-option ${o.value === value ? "selected" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
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

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export default function AgentDialog({ channel, isOpen, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add form state
  const [newName, setNewName] = useState("");
  const [newProvider, setNewProvider] = useState("copilot");
  const [newModel, setNewModel] = useState("default");
  const [newProject, setNewProject] = useState("");
  const [newWorkerToken, setNewWorkerToken] = useState("");
  const [newHeartbeat, setNewHeartbeat] = useState(0);
  const [newAgentType, setNewAgentType] = useState("");
  const [saving, setSaving] = useState(false);

  // Context menu for text inputs
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

  // Edit state for existing agent fields
  const [editProvider, setEditProvider] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editProject, setEditProject] = useState("");
  const [editHeartbeat, setEditHeartbeat] = useState(0);
  const [savedEditProvider, setSavedEditProvider] = useState("");
  const [savedEditModel, setSavedEditModel] = useState("");
  const [savedEditProject, setSavedEditProject] = useState("");
  const [savedEditHeartbeat, setSavedEditHeartbeat] = useState(0);
  const [editAgentType, setEditAgentType] = useState("");
  const [savedEditAgentType, setSavedEditAgentType] = useState("");
  const [editWorkerToken, setEditWorkerToken] = useState("");
  const [clearWorkerToken, setClearWorkerToken] = useState(false);
  const [savedWorkerTokenMask, setSavedWorkerTokenMask] = useState<string | null>(null);
  const [fieldsDirty, setFieldsDirty] = useState(false);
  const [fieldsSaving, setFieldsSaving] = useState(false);

  // Identity state
  const [identity, setIdentity] = useState("");
  const [savedIdentity, setSavedIdentity] = useState("");
  const [identityDirty, setIdentityDirty] = useState(false);
  const [identitySaving, setIdentitySaving] = useState(false);

  // Providers list state
  const [providers, setProviders] = useState<ProviderOption[]>([]);

  // Agent files list (for Type dropdown)
  const [agentFiles, setAgentFiles] = useState<{ name: string; description: string }[]>([]);

  // Folder browser state (shared between Add and Edit modes)
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [showEditFolderBrowser, setShowEditFolderBrowser] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [folders, setFolders] = useState<{ name: string; path: string }[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);

  // Load agents when dialog opens
  useEffect(() => {
    if (!isOpen || !channel) return;
    loadAgents();
    const interval = setInterval(loadAgents, 15000);
    return () => clearInterval(interval);
  }, [isOpen, channel]);

  // Load providers when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    authFetch(`${API_URL}/api/app.providers.list`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.providers) && data.providers.length > 0) {
          setProviders(data.providers);
          setNewProvider((prev) => {
            const names = data.providers.map((p: ProviderOption) => p.name);
            return names.includes(prev) ? prev : (data.providers[0].name as string);
          });
        }
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        // fallback: all built-in providers
        setProviders([
          { name: "copilot", type: "copilot", is_custom: false },
          { name: "openai", type: "openai", is_custom: false },
          { name: "anthropic", type: "anthropic", is_custom: false },
          { name: "ollama", type: "ollama", is_custom: false },
          { name: "minimax", type: "minimax", is_custom: false },
        ]);
      });
    return () => controller.abort();
  }, [isOpen]);

  // Load agent files list for Type dropdown
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    authFetch(`${API_URL}/api/app.agent-files.list`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.agents)) {
          setAgentFiles(data.agents.map((a: any) => ({ name: a.name, description: a.description })));
        }
      })
      .catch((err) => {
        if (err.name !== "AbortError") console.error(err);
      });
    return () => controller.abort();
  }, [isOpen]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedAgentId(null);
      setShowAddForm(false);
      setError(null);
      setNewName("");
      setNewAgentType("");
      setNewProvider(() => {
        // Reset to "copilot" if available, else first in list
        if (providers.length === 0) return "copilot";
        const names = providers.map((p) => p.name);
        return names.includes("copilot") ? "copilot" : (providers[0].name ?? "copilot");
      });
      setNewModel("default");
      setNewProject("");
      setNewHeartbeat(0);
      setShowFolderBrowser(false);
      setShowEditFolderBrowser(false);
      setIdentity("");
      setSavedIdentity("");
      setIdentityDirty(false);
    }
  }, [isOpen]);

  // Load identity when agent is selected
  useEffect(() => {
    if (!selectedAgentId || showAddForm) {
      setIdentity("");
      setSavedIdentity("");
      setIdentityDirty(false);
      return;
    }
    const controller = new AbortController();
    authFetch(
      `${API_URL}/api/app.agents.identity?channel=${encodeURIComponent(channel)}&agent_id=${encodeURIComponent(selectedAgentId)}`,
      { signal: controller.signal },
    )
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setIdentity(data.identity || "");
          setSavedIdentity(data.identity || "");
          setIdentityDirty(false);
        }
      })
      .catch((err) => {
        if (err.name !== "AbortError") console.error(err);
      });
    return () => controller.abort();
  }, [selectedAgentId, showAddForm, channel]);

  // Populate edit state when selected agent changes
  useEffect(() => {
    if (!selectedAgentId || showAddForm) {
      setEditProvider("");
      setEditModel("");
      setEditProject("");
      setEditHeartbeat(0);
      setShowEditFolderBrowser(false);
      setSavedEditProvider("");
      setSavedEditModel("");
      setSavedEditProject("");
      setSavedEditHeartbeat(0);
      setEditWorkerToken("");
      setClearWorkerToken(false);
      setSavedWorkerTokenMask(null);
      setFieldsDirty(false);
      return;
    }
    const agent = agents.find((a) => a.agent_id === selectedAgentId);
    if (!agent) return;
    setEditProvider(agent.provider || "");
    setEditModel(agent.model || "");
    setEditProject(agent.project || "");
    setEditHeartbeat(agent.heartbeat_interval ?? 0);
    setSavedEditProvider(agent.provider || "");
    setSavedEditModel(agent.model || "");
    setSavedEditProject(agent.project || "");
    setSavedEditHeartbeat(agent.heartbeat_interval ?? 0);
    setEditAgentType(agent.agent_type || "");
    setSavedEditAgentType(agent.agent_type || "");
    setEditWorkerToken("");
    setClearWorkerToken(false);
    setSavedWorkerTokenMask(agent.worker_token || null);
    setFieldsDirty(false);
  }, [selectedAgentId, showAddForm]);

  // Update project default when channel changes
  useEffect(() => {
    if (channel) {
      setNewProject("");
    }
  }, [channel]);

  // Focus name input when add form shows
  useEffect(() => {
    if (showAddForm) {
      setTimeout(() => nameInputRef.current?.focus(), 100);
    }
  }, [showAddForm]);

  const checkFieldsDirty = (
    provider: string,
    model: string,
    project: string,
    heartbeat: number,
    agentType?: string,
    workerToken?: string,
    clearToken?: boolean,
  ) => {
    return (
      provider !== savedEditProvider ||
      model !== savedEditModel ||
      project !== savedEditProject ||
      heartbeat !== savedEditHeartbeat ||
      (agentType !== undefined && agentType !== savedEditAgentType) ||
      (workerToken !== undefined && workerToken !== "") ||
      (clearToken !== undefined && clearToken)
    );
  };

  const loadAgents = useCallback(async () => {
    try {
      const res = await authFetch(`${API_URL}/api/app.agents.list?channel=${encodeURIComponent(channel)}`);
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
      const res = await authFetch(`${API_URL}/api/app.agents.add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          agent_id: newName.trim(),
          provider: newProvider.trim().toLowerCase(),
          model: newModel.trim() || "default",
          project: newProject.trim(),
          worker_token: newWorkerToken.trim() || undefined,
          heartbeat_interval: newHeartbeat,
          agent_type: newAgentType || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setNewName("");
        setNewAgentType("");
        setNewProvider(() => {
          if (providers.length === 0) return "copilot";
          const names = providers.map((p) => p.name);
          return names.includes("copilot") ? "copilot" : (providers[0].name ?? "copilot");
        });
        setNewModel("default");
        setNewProject("");
        setNewWorkerToken("");
        setNewHeartbeat(0);
        setShowAddForm(false);
        await loadAgents();
        setSelectedAgentId(newName.trim());
      } else {
        setError(data.error || "Failed to add agent");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [channel, newName, newProvider, newModel, newProject, newWorkerToken, newHeartbeat, newAgentType, loadAgents]);

  const handleSaveAgent = useCallback(
    async (agentId: string) => {
      setFieldsSaving(true);
      setError(null);
      try {
        const res = await authFetch(`${API_URL}/api/app.agents.update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel,
            agent_id: agentId,
            provider: editProvider.trim().toLowerCase(),
            model: editModel.trim() || "default",
            project: editProject.trim(),
            heartbeat_interval: editHeartbeat,
            // Only send agent_type when it changed (avoids unnecessary restart)
            ...(editAgentType !== savedEditAgentType ? { agent_type: editAgentType || null } : {}),
            // Only send worker_token when explicitly changed or cleared
            ...(clearWorkerToken
              ? { worker_token: "" }
              : editWorkerToken.trim()
                ? { worker_token: editWorkerToken.trim() }
                : {}),
          }),
        });
        const data = await res.json();
        if (data.ok) {
          setSavedEditProvider(editProvider);
          setSavedEditAgentType(editAgentType);
          setSavedEditModel(editModel);
          setSavedEditProject(editProject);
          setSavedEditHeartbeat(editHeartbeat);
          if (clearWorkerToken) {
            setSavedWorkerTokenMask(null);
            setClearWorkerToken(false);
          } else if (editWorkerToken.trim()) {
            // Mask locally until next reload
            const t = editWorkerToken.trim();
            setSavedWorkerTokenMask(t.length > 7 ? `${t.slice(0, 4)}***${t.slice(-3)}` : `${t.slice(0, 2)}***`);
          }
          setEditWorkerToken("");
          setFieldsDirty(false);
          await loadAgents();
        } else {
          setError(data.error || "Failed to save agent settings");
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setFieldsSaving(false);
      }
    },
    [
      channel,
      editProvider,
      editModel,
      editProject,
      editHeartbeat,
      editAgentType,
      editWorkerToken,
      clearWorkerToken,
      loadAgents,
    ],
  );

  const handleRemoveAgent = useCallback(
    async (agentId: string) => {
      setError(null);
      try {
        const res = await authFetch(`${API_URL}/api/app.agents.remove`, {
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

  const handleToggleSleep = useCallback(
    async (agentId: string, currentlySleeping: boolean) => {
      setError(null);
      try {
        const res = await authFetch(`${API_URL}/api/app.agents.update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, agent_id: agentId, sleeping: !currentlySleeping }),
        });
        const data = await res.json();
        if (data.ok) {
          await loadAgents();
        } else {
          setError(data.error || "Failed to toggle sleep");
        }
      } catch (err) {
        setError(String(err));
      }
    },
    [channel, loadAgents],
  );

  const handleSaveIdentity = useCallback(
    async (agentId: string) => {
      setIdentitySaving(true);
      setError(null);
      try {
        const res = await authFetch(`${API_URL}/api/app.agents.identity`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, agent_id: agentId, identity }),
        });
        const data = await res.json();
        if (data.ok) {
          setSavedIdentity(identity);
          setIdentityDirty(false);
        } else {
          setError(data.error || "Failed to save identity");
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setIdentitySaving(false);
      }
    },
    [channel, identity],
  );

  const loadFolders = useCallback(async (path: string) => {
    setFolderLoading(true);
    try {
      const res = await authFetch(`${API_URL}/api/app.folders.list?path=${encodeURIComponent(path)}`);
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

  const handleFolderSelect = useCallback((path: string, forEdit = false) => {
    if (forEdit) {
      setEditProject(path);
      setShowEditFolderBrowser(false);
      setFieldsDirty(true);
    } else {
      setNewProject(path);
      setShowFolderBrowser(false);
    }
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
            const color = agent.avatar_color || "#D97853";
            const hasHeartbeat = (agent.heartbeat_interval ?? 0) > 0;
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
                  <ClawdAvatar color={color} standing={agent.running && !agent.sleeping} sleeping={agent.sleeping} />
                  {hasHeartbeat && <span className="stream-agent-avatar-dot heartbeat-pulse" />}
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

          {/* Selected agent details -- editable fields */}
          {selectedAgent && !showAddForm && (
            <div className="agent-fields">
              <label className="skills-field-label">Name</label>
              <input
                type="text"
                className="agent-field-input"
                placeholder="Name"
                value={selectedAgent.agent_id}
                readOnly
                onContextMenu={handleInputContextMenu}
              />
              <label className="skills-field-label">Type</label>
              <CustomSelect
                value={editAgentType}
                options={[
                  { value: "", label: "(none)" },
                  ...agentFiles.map((af) => ({ value: af.name, label: af.name })),
                ]}
                onChange={(v) => {
                  setEditAgentType(v);
                  setFieldsDirty(checkFieldsDirty(editProvider, editModel, editProject, editHeartbeat, v));
                }}
                placeholder="(none)"
              />
              <label className="skills-field-label">Provider</label>
              <CustomSelect
                value={editProvider}
                options={providers.map((p) => ({ value: p.name, label: p.name }))}
                onChange={(v) => {
                  setEditProvider(v);
                  setFieldsDirty(checkFieldsDirty(v, editModel, editProject, editHeartbeat, editAgentType));
                }}
                placeholder="Select provider"
              />
              <label className="skills-field-label">Model</label>
              <input
                type="text"
                className="agent-field-input"
                placeholder="Model"
                value={editModel}
                onContextMenu={handleInputContextMenu}
                onChange={(e) => {
                  setEditModel(e.target.value);
                  setFieldsDirty(
                    checkFieldsDirty(editProvider, e.target.value, editProject, editHeartbeat, editAgentType),
                  );
                }}
              />
              <label className="skills-field-label">Project</label>
              <div className="agent-field-browse">
                <input
                  type="text"
                  className="agent-field-input"
                  placeholder={`~/.clawd/projects/${channel}`}
                  value={editProject}
                  onContextMenu={handleInputContextMenu}
                  onChange={(e) => {
                    setEditProject(e.target.value);
                    setFieldsDirty(
                      checkFieldsDirty(editProvider, editModel, e.target.value, editHeartbeat, editAgentType),
                    );
                  }}
                />
                <button
                  className="agent-field-browse-btn"
                  onClick={() => {
                    setShowEditFolderBrowser(!showEditFolderBrowser);
                    if (!showEditFolderBrowser) {
                      loadFolders(editProject || "/");
                    }
                  }}
                  title="Browse"
                >
                  <FolderIcon />
                </button>
              </div>
              {showEditFolderBrowser && (
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
                    <button
                      className="agent-browser-check"
                      onClick={() => handleFolderSelect(folderPath, true)}
                      title="Select this folder"
                    >
                      <CheckIcon />
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
              <label className="skills-field-label">Heartbeat Interval</label>
              <input
                type="number"
                className="agent-field-input"
                placeholder="Heartbeat interval (seconds, 0=disabled)"
                value={editHeartbeat}
                min={0}
                step={1}
                onChange={(e) => {
                  const val = Math.max(0, parseInt(e.target.value) || 0);
                  setEditHeartbeat(val);
                  setFieldsDirty(checkFieldsDirty(editProvider, editModel, editProject, val, editAgentType));
                }}
              />
              <label className="skills-field-label">
                Worker Token
                {savedWorkerTokenMask && !clearWorkerToken && (
                  <span style={{ fontWeight: 400, marginLeft: 6, opacity: 0.6 }}>({savedWorkerTokenMask})</span>
                )}
                {savedWorkerTokenMask && !clearWorkerToken && (
                  <button
                    type="button"
                    style={{
                      marginLeft: 8,
                      fontSize: "0.75rem",
                      opacity: 0.7,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "inherit",
                      textDecoration: "underline",
                    }}
                    onClick={() => {
                      setClearWorkerToken(true);
                      setEditWorkerToken("");
                      setFieldsDirty(true);
                    }}
                  >
                    Clear
                  </button>
                )}
                {clearWorkerToken && (
                  <span style={{ marginLeft: 8, fontSize: "0.75rem", color: "var(--color-danger, #e55)" }}>
                    will be cleared
                    <button
                      type="button"
                      style={{
                        marginLeft: 6,
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "inherit",
                        textDecoration: "underline",
                        fontSize: "inherit",
                      }}
                      onClick={() => {
                        setClearWorkerToken(false);
                        setFieldsDirty(
                          checkFieldsDirty(
                            editProvider,
                            editModel,
                            editProject,
                            editHeartbeat,
                            editAgentType,
                            "",
                            false,
                          ),
                        );
                      }}
                    >
                      undo
                    </button>
                  </span>
                )}
              </label>
              <input
                type="password"
                className="agent-field-input"
                placeholder={
                  savedWorkerTokenMask && !clearWorkerToken ? "Enter new token to replace" : "Worker token (optional)"
                }
                value={editWorkerToken}
                disabled={clearWorkerToken}
                onContextMenu={handleInputContextMenu}
                onChange={(e) => {
                  setEditWorkerToken(e.target.value);
                  setFieldsDirty(
                    checkFieldsDirty(
                      editProvider,
                      editModel,
                      editProject,
                      editHeartbeat,
                      editAgentType,
                      e.target.value,
                      false,
                    ),
                  );
                }}
              />
              <label className="skills-field-label">Identity</label>
              <textarea
                className="agent-field-input agent-identity-input"
                placeholder="Identity — describe this agent's role, personality, and responsibilities"
                value={identity}
                onContextMenu={handleInputContextMenu}
                onChange={(e) => {
                  setIdentity(e.target.value);
                  setIdentityDirty(e.target.value !== savedIdentity);
                }}
              />
              <div className="agent-buttons">
                {fieldsDirty && (
                  <button
                    className="agent-action-btn agent-action-btn--accent"
                    onClick={() => handleSaveAgent(selectedAgent.agent_id)}
                    disabled={fieldsSaving}
                  >
                    {fieldsSaving ? "Saving..." : "Save"}
                  </button>
                )}
                {identityDirty && (
                  <button
                    className="agent-action-btn agent-action-btn--accent"
                    onClick={() => handleSaveIdentity(selectedAgent.agent_id)}
                    disabled={identitySaving}
                  >
                    {identitySaving ? "Applying..." : "Apply"}
                  </button>
                )}
                <button
                  className={`agent-action-btn ${selectedAgent.sleeping ? "agent-action-btn--accent" : "agent-action-btn--warning"}`}
                  onClick={() => handleToggleSleep(selectedAgent.agent_id, selectedAgent.sleeping)}
                >
                  {selectedAgent.sleeping ? "Awake" : "Sleep"}
                </button>
                <button
                  className="agent-action-btn agent-action-btn--danger"
                  onClick={() => handleRemoveAgent(selectedAgent.agent_id)}
                >
                  Kill
                </button>
              </div>
            </div>
          )}

          {/* Add agent form -- same input layout as details */}
          {showAddForm && (
            <div className="agent-fields">
              <label className="skills-field-label">Name</label>
              <input
                ref={nameInputRef}
                type="text"
                className="agent-field-input"
                placeholder="Name"
                value={newName}
                pattern="[^:]+"
                onContextMenu={handleInputContextMenu}
                title="Agent name cannot contain colons"
                onChange={(e) => setNewName(e.target.value.replace(/:/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddAgent();
                  if (e.key === "Escape") {
                    setShowAddForm(false);
                    setError(null);
                  }
                }}
              />
              <label className="skills-field-label">Type</label>
              <CustomSelect
                value={newAgentType}
                options={[
                  { value: "", label: "(none)" },
                  ...agentFiles.map((af) => ({ value: af.name, label: af.name })),
                ]}
                onChange={(v) => setNewAgentType(v)}
                placeholder="(none)"
              />
              <label className="skills-field-label">Provider</label>
              <CustomSelect
                value={newProvider}
                options={providers.map((p) => ({ value: p.name, label: p.name }))}
                onChange={(v) => setNewProvider(v)}
                placeholder="Select provider"
              />
              <label className="skills-field-label">Model</label>
              <input
                type="text"
                className="agent-field-input"
                placeholder="Model"
                value={newModel}
                onContextMenu={handleInputContextMenu}
                onChange={(e) => setNewModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddAgent();
                }}
              />
              <label className="skills-field-label">Project</label>
              <div className="agent-field-browse">
                <input
                  type="text"
                  className="agent-field-input"
                  placeholder={`~/.clawd/projects/${channel}`}
                  value={newProject}
                  onContextMenu={handleInputContextMenu}
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
                    <button
                      className="agent-browser-check"
                      onClick={() => handleFolderSelect(folderPath)}
                      title="Select this folder"
                    >
                      <CheckIcon />
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
              <label className="skills-field-label">Heartbeat Interval</label>
              <input
                type="number"
                className="agent-field-input"
                placeholder="Heartbeat interval (seconds, 0=disabled)"
                value={newHeartbeat}
                min={0}
                step={1}
                onChange={(e) => setNewHeartbeat(Math.max(0, parseInt(e.target.value) || 0))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddAgent();
                }}
              />
              <label className="skills-field-label">Worker Token</label>
              <input
                className="agent-field-input"
                type="password"
                placeholder="Worker token (optional)"
                value={newWorkerToken}
                onContextMenu={handleInputContextMenu}
                onChange={(e) => setNewWorkerToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddAgent();
                }}
              />
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
