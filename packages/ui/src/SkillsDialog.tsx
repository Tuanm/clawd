import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";
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

interface Skill {
  name: string;
  description: string;
  triggers: string[];
  source: "project" | "global";
  content?: string;
  argumentHint?: string;
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

function SkillIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26" />
    </svg>
  );
}

function BackIcon() {
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
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      style={{ transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// View states: "list" shows skill list, "detail" shows skill editor
type View = "list" | "detail";

export default function SkillsDialog({ channel, isOpen, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [view, setView] = useState<View>("list");
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Collapsible sections
  const [globalOpen, setGlobalOpen] = useState(true);
  const [projectOpen, setProjectOpen] = useState(true);

  // Editor state
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTriggers, setEditTriggers] = useState("");
  const [editArgumentHint, setEditArgumentHint] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editScope, setEditScope] = useState<"project" | "global">("project");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (!isOpen) {
      setSelectedAgentId(null);
      setSkills([]);
      setView("list");
      setSelectedSkill(null);
      setIsCreating(false);
      setError(null);
      clearEditor();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!selectedAgentId) {
      setSkills([]);
      setView("list");
      setSelectedSkill(null);
      setIsCreating(false);
      return;
    }
    loadSkills(selectedAgentId);
    setView("list");
    setSelectedSkill(null);
    setIsCreating(false);
  }, [selectedAgentId]);

  useEffect(() => {
    if (view === "detail" && isCreating) {
      setTimeout(() => nameInputRef.current?.focus(), 100);
    }
  }, [view, isCreating]);

  const clearEditor = () => {
    setEditName("");
    setEditDescription("");
    setEditTriggers("");
    setEditArgumentHint("");
    setEditContent("");
    setEditScope("project");
  };

  const loadSkills = useCallback(
    async (agentId: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(
          `${API_URL}/api/app.skills.list?channel=${encodeURIComponent(channel)}&agent_id=${encodeURIComponent(agentId)}`,
        );
        const data = await res.json();
        if (data.ok) setSkills(data.skills);
        else setError(data.error || "Failed to load skills");
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [channel],
  );

  const handleSelectSkill = useCallback(
    async (skill: Skill) => {
      setIsCreating(false);
      setError(null);
      try {
        const params = new URLSearchParams({ name: skill.name });
        if (selectedAgentId) {
          params.set("channel", channel);
          params.set("agent_id", selectedAgentId);
        }
        const res = await authFetch(`${API_URL}/api/app.skills.get?${params}`);
        const data = await res.json();
        if (data.ok && data.skill) {
          const s: Skill = data.skill;
          setSelectedSkill(s);
          setEditName(s.name);
          setEditDescription(s.description || "");
          setEditTriggers(Array.isArray(s.triggers) ? s.triggers.join(", ") : "");
          setEditArgumentHint(s.argumentHint || "");
          setEditContent(s.content || "");
          setEditScope(s.source === "global" ? "global" : "project");
          setView("detail");
        }
      } catch (err) {
        setError(String(err));
      }
    },
    [channel, selectedAgentId],
  );

  const handleCreateNew = useCallback(() => {
    setSelectedSkill(null);
    clearEditor();
    setIsCreating(true);
    setView("detail");
    setError(null);
  }, []);

  const handleBack = () => {
    setView("list");
    setSelectedSkill(null);
    setIsCreating(false);
    setError(null);
  };

  const handleSave = useCallback(async () => {
    if (!editName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, any> = {
        name: editName.trim(),
        description: editDescription.trim(),
        triggers: editTriggers,
        content: editContent,
        scope: editScope,
      };
      if (editArgumentHint.trim()) body.argument_hint = editArgumentHint.trim();
      if (selectedAgentId) {
        body.channel = channel;
        body.agent_id = selectedAgentId;
      }
      const res = await authFetch(`${API_URL}/api/app.skills.save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setIsCreating(false);
        if (selectedAgentId) await loadSkills(selectedAgentId);
        setSelectedSkill({
          name: editName.trim(),
          description: editDescription.trim(),
          triggers: editTriggers
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
          source: editScope,
          content: editContent,
          argumentHint: editArgumentHint.trim() || undefined,
        });
      } else {
        setError(data.error || "Failed to save skill");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [
    channel,
    selectedAgentId,
    editName,
    editDescription,
    editTriggers,
    editArgumentHint,
    editContent,
    editScope,
    loadSkills,
  ]);

  const handleDelete = useCallback(async () => {
    if (!selectedSkill) return;
    setDeleting(true);
    setError(null);
    try {
      const params = new URLSearchParams({ name: selectedSkill.name });
      if (selectedAgentId) {
        params.set("channel", channel);
        params.set("agent_id", selectedAgentId);
      }
      const res = await authFetch(`${API_URL}/api/app.skills.delete?${params}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setSelectedSkill(null);
        clearEditor();
        setView("list");
        if (selectedAgentId) await loadSkills(selectedAgentId);
      } else {
        setError(data.error || "Failed to delete skill");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setDeleting(false);
    }
  }, [channel, selectedAgentId, selectedSkill, loadSkills]);

  const getSavePath = () => {
    if (editScope === "global") return `~/.clawd/skills/${editName || "<name>"}/SKILL.md`;
    const agent = agents.find((a) => a.agent_id === selectedAgentId);
    const project = agent?.project || "<project>";
    return `${project}/.clawd/skills/${editName || "<name>"}/SKILL.md`;
  };

  const globalSkills = skills.filter((s) => s.source === "global");
  const projectSkills = skills.filter((s) => s.source === "project");

  if (!isOpen) return null;

  return createPortal(
    <div className="stream-dialog-overlay" onClick={onClose}>
      <div className="stream-dialog skills-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            {view === "detail" && (
              <button className="skills-back-btn" onClick={handleBack} title="Back to skill list">
                <BackIcon />
              </button>
            )}
            <h3>{view === "detail" ? (isCreating ? "New Skill" : selectedSkill?.name || "Skill") : "Skills"}</h3>
          </div>
          <button className="stream-dialog-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Agent avatar bar + plus button */}
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
          {/* Plus button in the avatar bar */}
          {selectedAgentId && (
            <button
              className={`stream-agent-avatar-btn agent-add-btn ${isCreating ? "active" : ""}`}
              onClick={handleCreateNew}
              title="Create new skill"
            >
              <span className="stream-agent-avatar-wrap">
                <PlusIcon />
              </span>
            </button>
          )}
        </div>

        {/* Body */}
        <div className="skills-dialog-body">
          {!selectedAgentId && (
            <div className="stream-dialog-placeholder">
              {agents.length === 0 ? "No agents configured." : "Select an agent above to manage skills."}
            </div>
          )}

          {selectedAgentId && view === "list" && (
            <div className="skills-list-view">
              {loading ? (
                <div className="skills-list-empty">Loading...</div>
              ) : skills.length === 0 ? (
                <div className="skills-list-empty">No skills found. Click + to create one.</div>
              ) : (
                <>
                  {/* PROJECT section */}
                  {projectSkills.length > 0 && (
                    <div className="skills-section">
                      <button className="skills-section-header" onClick={() => setProjectOpen(!projectOpen)}>
                        <ChevronIcon open={projectOpen} />
                        <span>PROJECT</span>
                        <span className="skills-section-count">{projectSkills.length}</span>
                      </button>
                      {projectOpen && (
                        <div className="skills-section-items">
                          {projectSkills.map((skill) => (
                            <button
                              key={skill.name}
                              className="skills-list-item"
                              onClick={() => handleSelectSkill(skill)}
                            >
                              <span className="skills-list-item-icon">
                                <SkillIcon />
                              </span>
                              <span className="skills-list-item-info">
                                <span className="skills-list-item-name">{skill.name}</span>
                                {skill.description && (
                                  <span className="skills-list-item-desc">{skill.description}</span>
                                )}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* GLOBAL section */}
                  {globalSkills.length > 0 && (
                    <div className="skills-section">
                      <button className="skills-section-header" onClick={() => setGlobalOpen(!globalOpen)}>
                        <ChevronIcon open={globalOpen} />
                        <span>GLOBAL</span>
                        <span className="skills-section-count">{globalSkills.length}</span>
                      </button>
                      {globalOpen && (
                        <div className="skills-section-items">
                          {globalSkills.map((skill) => (
                            <button
                              key={skill.name}
                              className="skills-list-item"
                              onClick={() => handleSelectSkill(skill)}
                            >
                              <span className="skills-list-item-icon">
                                <SkillIcon />
                              </span>
                              <span className="skills-list-item-info">
                                <span className="skills-list-item-name">{skill.name}</span>
                                {skill.description && (
                                  <span className="skills-list-item-desc">{skill.description}</span>
                                )}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {selectedAgentId && view === "detail" && (
            <div className="skills-detail-view">
              <div className="skills-editor-fields">
                <label className="skills-field-label">Skill Name</label>
                <input
                  ref={nameInputRef}
                  type="text"
                  className="agent-field-input"
                  placeholder="kebab-case-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  readOnly={!isCreating}
                />
                <label className="skills-field-label">Description</label>
                <input
                  type="text"
                  className="agent-field-input"
                  placeholder="Brief description (<200 chars)"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  maxLength={200}
                />
                <label className="skills-field-label">Triggers / Argument Hints</label>
                <input
                  type="text"
                  className="agent-field-input"
                  placeholder="keyword1, keyword2, [arg-hint]"
                  value={editTriggers}
                  onChange={(e) => setEditTriggers(e.target.value)}
                />
                <label className="skills-field-label">Content</label>
                <textarea
                  className="agent-field-input skills-content-input"
                  placeholder="Skill instructions (markdown)..."
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
                <div className="skills-scope-row">
                  <label className="skills-scope-label">
                    <input
                      type="radio"
                      name="skills-scope"
                      value="project"
                      checked={editScope === "project"}
                      onChange={() => setEditScope("project")}
                    />
                    <span>Project</span>
                  </label>
                  <label className="skills-scope-label">
                    <input
                      type="radio"
                      name="skills-scope"
                      value="global"
                      checked={editScope === "global"}
                      onChange={() => setEditScope("global")}
                    />
                    <span>Global</span>
                  </label>
                </div>
                <div className="skills-save-path">{getSavePath()}</div>
                <div className="agent-buttons">
                  <button
                    className="agent-action-btn agent-action-btn--accent"
                    onClick={handleSave}
                    disabled={!editName.trim() || saving}
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                  {!isCreating && selectedSkill && (
                    <button
                      className="agent-action-btn agent-action-btn--danger"
                      onClick={handleDelete}
                      disabled={deleting}
                    >
                      {deleting ? "Deleting..." : "Delete"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {error && <div className="agent-dialog-error">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
