import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";
import { ClawdAvatar } from "./MessageList";
import { useInputContextMenu, InputContextMenu } from "./InputContextMenu";

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
      width="20"
      height="20"
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

export default function SkillsDialog({ channel, isOpen, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [cardLoading, setCardLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Skill detail dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTriggers, setEditTriggers] = useState("");
  const [editArgumentHint, setEditArgumentHint] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);

  // Context menu for text inputs
  const {
    menu: inputMenu,
    hasSelection: inputHasSelection,
    isEditable: inputIsEditable,
    handleContextMenu: handleInputContextMenu,
    closeMenu: closeInputMenu,
    handleCopy: handleInputCopy,
    handleCut: handleInputCut,
    handleSelectAll: handleInputSelectAll,
  } = useInputContextMenu();

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
      setDialogOpen(false);
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!selectedAgentId) {
      setSkills([]);
      setDialogOpen(false);
      return;
    }
    loadSkills(selectedAgentId);
  }, [selectedAgentId]);

  useEffect(() => {
    if (dialogOpen && isNew) {
      setTimeout(() => nameInputRef.current?.focus(), 100);
    }
  }, [dialogOpen, isNew]);

  // Close detail dialog on Escape
  useEffect(() => {
    if (!dialogOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving && !deleting) closeDetailDialog();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [dialogOpen, saving, deleting]);

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
          // Only show project-scoped skills in this dialog
          setSkills((data.skills as Skill[]).filter((s) => s.source === "project"));
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

  const handleCardClick = useCallback(
    async (skill: Skill) => {
      if (cardLoading) return;
      setError(null);
      setCardLoading(true);
      try {
        const params = new URLSearchParams({ name: skill.name, channel, agent_id: selectedAgentId! });
        const res = await authFetch(`${API_URL}/api/app.skills.get?${params}`);
        const data = await res.json();
        if (data.ok && data.skill) {
          const s: Skill = data.skill;
          setEditName(s.name);
          setEditDescription(s.description || "");
          setEditTriggers(Array.isArray(s.triggers) ? s.triggers.join(", ") : "");
          setEditArgumentHint(s.argumentHint || "");
          setEditContent(s.content || "");
          setIsNew(false);
          setDialogOpen(true);
        } else {
          setError(data.error || "Failed to load skill");
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setCardLoading(false);
      }
    },
    [channel, selectedAgentId, cardLoading],
  );

  const handleNewClick = useCallback(() => {
    setEditName("");
    setEditDescription("");
    setEditTriggers("");
    setEditArgumentHint("");
    setEditContent("# Instructions\n\nSkill instructions here...\n");
    setIsNew(true);
    setDialogOpen(true);
    setError(null);
  }, []);

  const closeDetailDialog = useCallback(() => {
    if (saving || deleting) return;
    setDialogOpen(false);
    setError(null);
  }, [saving, deleting]);

  const handleSave = useCallback(async () => {
    if (!editName.trim() || !selectedAgentId) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, any> = {
        name: editName.trim(),
        description: editDescription.trim(),
        triggers: editTriggers,
        content: editContent,
        scope: "project",
        channel,
        agent_id: selectedAgentId,
      };
      if (editArgumentHint.trim()) body.argument_hint = editArgumentHint.trim();
      const res = await authFetch(`${API_URL}/api/app.skills.save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setDialogOpen(false);
        await loadSkills(selectedAgentId);
      } else {
        setError(data.error || "Failed to save skill");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [channel, selectedAgentId, editName, editDescription, editTriggers, editArgumentHint, editContent, loadSkills]);

  const handleDelete = useCallback(async () => {
    if (!editName || !selectedAgentId || !confirm(`Delete skill "${editName}"?`)) return;
    setDeleting(true);
    setError(null);
    try {
      const params = new URLSearchParams({ name: editName, channel, agent_id: selectedAgentId });
      const res = await authFetch(`${API_URL}/api/app.skills.delete?${params}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setDialogOpen(false);
        await loadSkills(selectedAgentId);
      } else {
        setError(data.error || "Failed to delete skill");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setDeleting(false);
    }
  }, [channel, selectedAgentId, editName, loadSkills]);

  if (!isOpen) return null;

  return createPortal(
    <div className="stream-dialog-overlay" onClick={onClose}>
      <div className="stream-dialog skills-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            <h3>Skills</h3>
            <button
              className="worktree-refresh-btn"
              onClick={() => selectedAgentId && loadSkills(selectedAgentId)}
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

        {/* Body — skill cards */}
        <div className="skills-dialog-body">
          {!selectedAgentId ? (
            <div className="stream-dialog-placeholder">
              {agents.length === 0 ? "No agents configured." : "Select an agent above to manage skills."}
            </div>
          ) : loading ? (
            <div className="skills-list-empty">Loading...</div>
          ) : (
            <div className="skills-cards-list">
              {skills.map((s) => (
                <div
                  key={s.name}
                  className="message-subspace-card"
                  onClick={() => handleCardClick(s)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && handleCardClick(s)}
                  style={cardLoading ? { opacity: 0.6, pointerEvents: "none" } : undefined}
                >
                  <div className="subspace-card-icon">
                    <ClawdAvatar />
                  </div>
                  <div className="subspace-card-content">
                    <div className="subspace-card-title">{s.name}</div>
                    {s.description && <div className="subspace-card-description">{s.description}</div>}
                    {s.triggers && s.triggers.length > 0 && (
                      <div className="skill-file-triggers" style={{ marginTop: 4 }}>
                        {s.triggers.slice(0, 5).map((t) => (
                          <span key={t} className="skill-file-trigger">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Add new skill card */}
              <div
                className="message-subspace-card"
                onClick={handleNewClick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleNewClick()}
                style={{ borderStyle: "dashed", borderColor: "hsl(15 63.1% 59.6% / 50%)" }}
              >
                <div className="subspace-card-icon" style={{ color: "hsl(15 63.1% 59.6%)" }}>
                  <PlusIcon />
                </div>
                <div className="subspace-card-content">
                  <div className="subspace-card-title" style={{ color: "hsl(15 63.1% 59.6%)" }}>
                    New Skill
                  </div>
                  <div className="subspace-card-description">Add a project skill for this agent</div>
                </div>
              </div>
            </div>
          )}
          {error && !dialogOpen && <div className="agent-dialog-error">{error}</div>}
        </div>
      </div>

      {/* Skill detail / edit dialog */}
      {dialogOpen && (
        <div className="stream-dialog-overlay" onClick={closeDetailDialog}>
          <div className="stream-dialog agent-file-edit-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="stream-dialog-header">
              <div className="stream-dialog-title-row">
                <h3>{isNew ? "New Skill" : editName}</h3>
              </div>
              <button className="stream-dialog-close" onClick={closeDetailDialog}>
                ×
              </button>
            </div>
            <div className="agent-file-edit-body">
              {isNew && (
                <>
                  <label className="skills-field-label">Name</label>
                  <input
                    ref={nameInputRef}
                    className="agent-field-input"
                    placeholder="skill-name (kebab-case)"
                    value={editName}
                    onContextMenu={handleInputContextMenu}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </>
              )}
              <label className="skills-field-label">Description</label>
              <input
                className="agent-field-input"
                placeholder="Brief description"
                value={editDescription}
                onContextMenu={handleInputContextMenu}
                onChange={(e) => setEditDescription(e.target.value)}
                maxLength={200}
              />
              <label className="skills-field-label">Triggers</label>
              <input
                className="agent-field-input"
                placeholder="keyword1, keyword2, ..."
                value={editTriggers}
                onContextMenu={handleInputContextMenu}
                onChange={(e) => setEditTriggers(e.target.value)}
              />
              <label className="skills-field-label">Argument Hint</label>
              <input
                className="agent-field-input"
                placeholder="[optional arg hint]"
                value={editArgumentHint}
                onContextMenu={handleInputContextMenu}
                onChange={(e) => setEditArgumentHint(e.target.value)}
              />
              <label className="skills-field-label">Content</label>
              <textarea
                className="agent-file-editor"
                value={editContent}
                onContextMenu={handleInputContextMenu}
                onChange={(e) => setEditContent(e.target.value)}
                placeholder="Skill instructions (markdown)..."
              />
              {error && <div className="agent-dialog-error">{error}</div>}
            </div>
            <div className="agent-file-edit-actions">
              <button
                className="agent-action-btn agent-action-btn--accent"
                onClick={handleSave}
                disabled={!editName.trim() || saving || deleting}
              >
                {saving ? "Saving..." : "Save"}
              </button>
              {!isNew && (
                <button
                  className="agent-action-btn agent-action-btn--danger"
                  onClick={handleDelete}
                  disabled={saving || deleting}
                >
                  {deleting ? "Deleting..." : "Delete"}
                </button>
              )}
              <button className="agent-action-btn" onClick={closeDetailDialog}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {inputMenu && (
        <InputContextMenu
          menu={inputMenu}
          onClose={closeInputMenu}
          hasSelection={inputHasSelection}
          isEditable={inputIsEditable}
          onCopy={handleInputCopy}
          onCut={handleInputCut}
          onSelectAll={handleInputSelectAll}
        />
      )}
    </div>,
    document.body,
  );
}
