import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ClawdAvatar } from "./MessageList";

export interface ActiveSubAgent {
  id: string;
  title: string;
  description: string | null;
  agent_id: string;
  agent_color: string;
  status: "active" | "completed" | "failed" | "timed_out";
  channel: string;
  space_channel: string;
}

interface Props {
  spaces: ActiveSubAgent[];
  onClose: () => void;
}

export default function SubAgentsDialog({ spaces, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const navigate = (space: ActiveSubAgent) => {
    window.location.href = `/${space.channel}/${space.id}`;
  };

  return createPortal(
    <div className="stream-dialog-overlay" onClick={onClose}>
      <div className="stream-dialog sub-agents-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            <h3>Sub-agents</h3>
          </div>
          <button className="stream-dialog-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="sub-agents-dialog-list">
          {spaces.length === 0 ? (
            <div className="sub-agents-dialog-empty">No running sub-agents</div>
          ) : (
            spaces.map((space) => (
              <div
                key={space.id}
                className="message-subspace-card sub-agents-dialog-card"
                onClick={() => navigate(space)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && navigate(space)}
              >
                <div className="subspace-card-icon">
                  <ClawdAvatar color={space.agent_color} />
                </div>
                <div className="subspace-card-content">
                  <div className="subspace-card-title">{space.title}</div>
                  {space.description && <div className="subspace-card-description">{space.description}</div>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
