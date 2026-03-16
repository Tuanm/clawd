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

export default function SkillsDialog({ channel, isOpen, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  // Reset when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedAgentId(null);
      setSkills([]);
      setSelectedSkill(null);
      setIsCreating(false);
      setError(null);
      clearEditor();
    }
  }, [isOpen]);

  // Load skills when agent is selected
  useEffect(() => {
    if (!selectedAgentId) {
      setSkills([]);
      setSelectedSkill(null);
      setIsCreating(false);
      return;
    }
    loadSkills(selectedAgentId);
  }, [selectedAgentId]);

  // Focus name input when create form shows
  useEffect(() => {
    if (isCreating) {
      setTimeout(() => nameInputRef.current?.focus(), 100);
    }
  }, [isCreating]);

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
        if (data.ok) {
          setSkills(data.skills);
        } else {
          setError(data.error || "Failed to load skills");
        }
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
      // Load full skill content
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
    setError(null);
  }, []);

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
        // Keep editor open with saved skill
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

  const showEditor = isCreating || selectedSkill !== null;

  // Determine save path hint
  const getSavePath = () => {
    if (editScope === "global") {
      return `~/.clawd/skills/${editName || "<name>"}/SKILL.md`;
    }
    const agent = agents.find((a) => a.agent_id === selectedAgentId);
    const project = agent?.project || "<project>";
    return `${project}/.clawd/skills/${editName || "<name>"}/SKILL.md`;
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="stream-dialog-overlay" onClick={onClose}>
      <div className="stream-dialog skills-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            <h3>Skills</h3>
          </div>
          <button className="stream-dialog-close" onClick={onClose}>
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
                  setSelectedSkill(null);
                  setIsCreating(false);
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

        {/* Body */}
        <div className="skills-dialog-body">
          {/* No agent selected */}
          {!selectedAgentId && (
            <div className="stream-dialog-placeholder">
              {agents.length === 0 ? "No agents configured." : "Select an agent above to manage skills."}
            </div>
          )}

          {/* Agent selected — show skill list + optional editor */}
          {selectedAgentId && (
            <div className="skills-dialog-layout">
              {/* Left: skill list */}
              <div className="skills-list-col">
                <div className="skills-list-header">
                  <span className="skills-list-title">Skills</span>
                  <button className="skills-add-btn" onClick={handleCreateNew} title="New skill">
                    <PlusIcon />
                  </button>
                </div>
                {loading ? (
                  <div className="skills-list-empty">Loading...</div>
                ) : skills.length === 0 ? (
                  <div className="skills-list-empty">No skills found. Click + to create one.</div>
                ) : (
                  <div className="skills-list">
                    {skills.map((skill) => (
                      <button
                        key={skill.name}
                        className={`skills-list-item ${selectedSkill?.name === skill.name && !isCreating ? "active" : ""}`}
                        onClick={() => handleSelectSkill(skill)}
                      >
                        <span className="skills-list-item-icon">
                          <SkillIcon />
                        </span>
                        <span className="skills-list-item-info">
                          <span className="skills-list-item-name">{skill.name}</span>
                          {skill.description && <span className="skills-list-item-desc">{skill.description}</span>}
                        </span>
                        <span className={`skills-source-badge skills-source-badge--${skill.source}`}>
                          {skill.source}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Right: editor */}
              {showEditor && (
                <div className="skills-editor-col">
                  <div className="skills-editor-fields">
                    <input
                      ref={nameInputRef}
                      type="text"
                      className="agent-field-input"
                      placeholder="Skill name (kebab-case)"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      readOnly={!isCreating}
                    />
                    <input
                      type="text"
                      className="agent-field-input"
                      placeholder="Description (<200 chars)"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      maxLength={200}
                    />
                    <input
                      type="text"
                      className="agent-field-input"
                      placeholder="Triggers (comma-separated keywords)"
                      value={editTriggers}
                      onChange={(e) => setEditTriggers(e.target.value)}
                    />
                    <input
                      type="text"
                      className="agent-field-input"
                      placeholder="Argument hint (optional, e.g. [topic])"
                      value={editArgumentHint}
                      onChange={(e) => setEditArgumentHint(e.target.value)}
                    />
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
            </div>
          )}

          {error && <div className="agent-dialog-error">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
