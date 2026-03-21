// Management content for /skills channel — renders inside App's message area
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";
import { ClawdAvatar } from "./MessageList";

const API_URL = "";

interface SkillSummary {
  name: string;
  description: string;
  triggers: string[];
  source: "project" | "global";
  editable?: boolean;
}

/** Copilot avatar for the System message sender (same size as human UserAvatar) */
function CopilotAvatar() {
  return (
    <svg
      width="28"
      height="22"
      viewBox="0 0 512 416"
      fill="hsl(15 63.1% 59.6%)"
      fillRule="evenodd"
      clipRule="evenodd"
      strokeLinejoin="round"
      strokeMiterlimit={2}
    >
      <path
        d="M181.33 266.143c0-11.497 9.32-20.818 20.818-20.818 11.498 0 20.819 9.321 20.819 20.818v38.373c0 11.497-9.321 20.818-20.819 20.818-11.497 0-20.818-9.32-20.818-20.818v-38.373zM308.807 245.325c-11.477 0-20.798 9.321-20.798 20.818v38.373c0 11.497 9.32 20.818 20.798 20.818 11.497 0 20.818-9.32 20.818-20.818v-38.373c0-11.497-9.32-20.818-20.818-20.818z"
        fillRule="nonzero"
      />
      <path d="M512.002 246.393v57.384c-.02 7.411-3.696 14.638-9.67 19.011C431.767 374.444 344.695 416 256 416c-98.138 0-196.379-56.542-246.33-93.21-5.975-4.374-9.65-11.6-9.671-19.012v-57.384a35.347 35.347 0 016.857-20.922l15.583-21.085c8.336-11.312 20.757-14.31 33.98-14.31 4.988-56.953 16.794-97.604 45.024-127.354C155.194 5.77 226.56 0 256 0c29.441 0 100.807 5.77 154.557 62.722 28.19 29.75 40.036 70.401 45.025 127.354 13.263 0 25.602 2.936 33.958 14.31l15.583 21.127c4.476 6.077 6.878 13.345 6.878 20.88zm-97.666-26.075c-.677-13.058-11.292-18.19-22.338-21.824-11.64 7.309-25.848 10.183-39.46 10.183-14.454 0-41.432-3.47-63.872-25.869-5.667-5.625-9.527-14.454-12.155-24.247a212.902 212.902 0 00-20.469-1.088c-6.098 0-13.099.349-20.551 1.088-2.628 9.793-6.509 18.622-12.155 24.247-22.4 22.4-49.418 25.87-63.872 25.87-13.612 0-27.86-2.855-39.501-10.184-11.005 3.613-21.558 8.828-22.277 21.824-1.17 24.555-1.272 49.11-1.375 73.645-.041 12.318-.082 24.658-.288 36.976.062 7.166 4.374 13.818 10.882 16.774 52.97 24.124 103.045 36.278 149.137 36.278 46.01 0 96.085-12.154 149.014-36.278 6.508-2.956 10.84-9.608 10.881-16.774.637-36.832.124-73.809-1.642-110.62h.041zM107.521 168.97c8.643 8.623 24.966 14.392 42.56 14.392 13.448 0 39.03-2.874 60.156-24.329 9.28-8.951 15.05-31.35 14.413-54.079-.657-18.231-5.769-33.28-13.448-39.665-8.315-7.371-27.203-10.574-48.33-8.644-22.399 2.238-41.267 9.588-50.875 19.833-20.798 22.728-16.323 80.317-4.476 92.492zm130.556-56.008c.637 3.51.965 7.35 1.273 11.517 0 2.875 0 5.77-.308 8.952 6.406-.636 11.847-.636 16.959-.636s10.553 0 16.959.636c-.329-3.182-.329-6.077-.329-8.952.329-4.167.657-8.007 1.294-11.517-6.735-.637-12.812-.965-17.924-.965s-11.21.328-17.924.965zm49.275-8.008c-.637 22.728 5.133 45.128 14.413 54.08 21.105 21.454 46.708 24.328 60.155 24.328 17.596 0 33.918-5.769 42.561-14.392 11.847-12.175 16.322-69.764-4.476-92.492-9.608-10.245-28.476-17.595-50.875-19.833-21.127-1.93-40.015 1.273-48.33 8.644-7.679 6.385-12.791 21.434-13.448 39.665z" />
    </svg>
  );
}

/** Claude AI icon for claude-sourced skills */
function ClaudeIcon() {
  return (
    <svg width="32" height="26" viewBox="0 0 16 16" fill="hsl(25 80% 55%)">
      <path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z" />
    </svg>
  );
}

/** Card icon based on skill editability (claude = read-only) */
function SkillCardIcon({ editable }: { editable?: boolean }) {
  if (editable === false) return <ClaudeIcon />;
  return <ClawdAvatar />;
}

export default function SkillFilesChannel() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [cardLoading, setCardLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTriggers, setEditTriggers] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editEditable, setEditEditable] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadSkills = useCallback(async () => {
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/app.skills.list`);
      const data = await res.json();
      if (data.ok) setSkills(data.skills);
      else setError(data.error || "Failed to load skills");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (!dialogOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) {
        setDialogOpen(false);
        setError(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [dialogOpen, saving]);

  const handleCardClick = useCallback(
    async (name: string) => {
      if (cardLoading) return;
      setError(null);
      setCardLoading(true);
      try {
        const res = await authFetch(`${API_URL}/api/app.skills.get?name=${encodeURIComponent(name)}`);
        const data = await res.json();
        if (data.ok && data.skill) {
          const s = data.skill;
          setEditName(s.name);
          setEditDescription(s.description || "");
          setEditTriggers(Array.isArray(s.triggers) ? s.triggers.join(", ") : "");
          setEditContent(s.content || "");
          setEditEditable(s.editable !== false);
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
    [cardLoading],
  );

  const handleNewClick = useCallback(() => {
    setEditName("");
    setEditDescription("");
    setEditTriggers("");
    setEditContent("# Instructions\n\nSkill instructions here...\n");

    setEditEditable(true);
    setIsNew(true);
    setDialogOpen(true);
    setError(null);
  }, []);

  const handleSave = useCallback(async () => {
    const name = editName.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/app.skills.save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: editDescription.trim(),
          triggers: editTriggers,
          content: editContent,
          scope: "global",
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setDialogOpen(false);
        await loadSkills();
      } else {
        setError(data.error || "Failed to save");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [editName, editDescription, editTriggers, editContent, loadSkills]);

  const handleDelete = useCallback(async () => {
    if (!editName || !confirm(`Delete skill "${editName}"?`)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/app.skills.delete?name=${encodeURIComponent(editName)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.ok) {
        setDialogOpen(false);
        await loadSkills();
      } else {
        setError(data.error || "Failed to delete");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [editName, loadSkills]);

  const closeDialog = useCallback(() => {
    if (saving) return;
    setDialogOpen(false);
    setError(null);
  }, [saving]);

  const editable = editEditable;

  return (
    <>
      <div className="message">
        <div className="message-avatar">
          <CopilotAvatar />
        </div>
        <div className="message-content">
          <div className="message-header">
            <span className="message-sender">System</span>
          </div>
          <div className="message-text">
            <p>Manage your global skills. Click a card to view or edit.</p>
          </div>
          {loading ? (
            <div className="subspace-card-description" style={{ padding: "8px 0" }}>
              Loading...
            </div>
          ) : (
            <>
              {skills.length === 0 && (
                <div className="subspace-card-description" style={{ padding: "8px 0" }}>
                  No skills found. Click below to create one.
                </div>
              )}
              {skills.map((s) => (
                <div
                  key={s.name}
                  className="message-subspace-card"
                  onClick={() => handleCardClick(s.name)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && handleCardClick(s.name)}
                  style={cardLoading ? { opacity: 0.6, pointerEvents: "none" } : undefined}
                >
                  <div className="subspace-card-icon">
                    <SkillCardIcon editable={s.editable} />
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
              <div
                className="message-subspace-card"
                onClick={handleNewClick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleNewClick()}
                style={{ borderStyle: "dashed", borderColor: "hsl(15 63.1% 59.6% / 50%)" }}
              >
                <div className="subspace-card-icon" style={{ color: "hsl(15 63.1% 59.6%)" }}>
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
                </div>
                <div className="subspace-card-content">
                  <div className="subspace-card-title" style={{ color: "hsl(15 63.1% 59.6%)" }}>
                    New Skill
                  </div>
                  <div className="subspace-card-description">Create a new global skill</div>
                </div>
              </div>
            </>
          )}
          {error && !dialogOpen && <div className="agent-dialog-error">{error}</div>}
        </div>
      </div>

      {dialogOpen &&
        createPortal(
          <div className="stream-dialog-overlay" onClick={closeDialog}>
            <div className="stream-dialog agent-file-edit-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="stream-dialog-header">
                <div className="stream-dialog-title-row">
                  <h3>{isNew ? "New Skill" : editName}</h3>
                </div>
                <button className="stream-dialog-close" onClick={closeDialog}>
                  &times;
                </button>
              </div>
              <div className="agent-file-edit-body">
                {isNew && (
                  <>
                    <label className="skills-field-label">Name</label>
                    <input
                      className="agent-field-input"
                      placeholder="skill-name (kebab-case)"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                    />
                  </>
                )}
                <label className="skills-field-label">Description</label>
                <input
                  className="agent-field-input"
                  placeholder="Brief description"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  readOnly={!editable}
                  maxLength={200}
                />
                <label className="skills-field-label">Triggers</label>
                <input
                  className="agent-field-input"
                  placeholder="keyword1, keyword2, ..."
                  value={editTriggers}
                  onChange={(e) => setEditTriggers(e.target.value)}
                  readOnly={!editable}
                />
                <label className="skills-field-label">Content</label>
                <textarea
                  className="agent-file-editor"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  readOnly={!editable}
                  placeholder="Skill instructions (markdown)..."
                />
                {error && <div className="agent-dialog-error">{error}</div>}
              </div>
              <div className="agent-file-edit-actions">
                {editable && (
                  <button
                    className="agent-action-btn agent-action-btn--accent"
                    onClick={handleSave}
                    disabled={!editName.trim() || saving}
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                )}
                {editable && !isNew && (
                  <button
                    className="agent-action-btn agent-action-btn--danger"
                    onClick={handleDelete}
                    disabled={saving}
                  >
                    Delete
                  </button>
                )}
                <button className="agent-action-btn" onClick={closeDialog}>
                  Cancel
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
