import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const API_URL = "";

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function AgentDialog({ channel, isOpen, onClose }: Props) {
  const [model, setModel] = useState("claude-opus-4.6");
  const [project, setProject] = useState("");
  const [identity, setIdentity] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identityInputRef = useRef<HTMLInputElement>(null);

  // Reset form on close
  useEffect(() => {
    if (!isOpen) {
      setModel("claude-opus-4.6");
      setProject("");
      setIdentity("");
      setError(null);
    }
  }, [isOpen]);

  // Focus identity input when dialog opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => identityInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleAddAgent = useCallback(async () => {
    if (!identity.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/app.agents.add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          agent_id: identity.trim(),
          model: model.trim() || "claude-opus-4.6",
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setIdentity("");
        onClose();
      } else {
        setError(data.error || "Failed to add agent");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [channel, identity, model, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="modal-overlay channel-dialog-overlay" onClick={onClose}>
      <div className="channel-dialog agent-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="channel-dialog-header">
          <span className="channel-dialog-title">Agent</span>
        </div>
        <div className="agent-dialog-body">
          <div className="agent-dialog-input-row home-space-input">
            <input
              type="text"
              className="home-space-field"
              placeholder="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div className="agent-dialog-input-row home-space-input">
            <input
              type="text"
              className="home-space-field"
              placeholder="Project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            />
          </div>
          <div className="agent-dialog-input-row home-space-input">
            <input
              ref={identityInputRef}
              type="text"
              className="home-space-field"
              placeholder="Identity"
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddAgent();
                if (e.key === "Escape") onClose();
              }}
            />
            <button
              className={`home-space-send ${identity.trim() ? "has-content" : ""}`}
              onClick={handleAddAgent}
              disabled={!identity.trim() || saving}
            >
              <SendIcon />
            </button>
          </div>
          {error && <div className="agent-dialog-error">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

