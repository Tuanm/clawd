import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Agent avatar component (small Clawd icon)
function AgentAvatar({ color = "#D97853" }: { color?: string }) {
  return (
    <svg width="14" height="11" viewBox="0 0 66 52" fill="none" style={{ flexShrink: 0 }}>
      <rect x="0" y="13" width="6" height="13" fill={color} />
      <rect x="60" y="13" width="6" height="13" fill={color} />
      <rect x="6" y="39" width="6" height="13" fill={color} />
      <rect x="18" y="39" width="6" height="13" fill={color} />
      <rect x="42" y="39" width="6" height="13" fill={color} />
      <rect x="54" y="39" width="6" height="13" fill={color} />
      <rect x="6" width="54" height="39" fill={color} />
      <rect x="12" y="13" width="6" height="6.5" fill="#000" />
      <rect x="48" y="13" width="6" height="6.5" fill="#000" />
    </svg>
  );
}

// Human avatar (Copilot logo, small)
function HumanAvatar() {
  return (
    <svg width="14" height="11" viewBox="0 0 512 416" fill="#D97853" style={{ flexShrink: 0 }}>
      <path
        d="M181.33 266.143c0-11.497 9.32-20.818 20.818-20.818 11.498 0 20.819 9.321 20.819 20.818v38.373c0 11.497-9.321 20.818-20.819 20.818-11.497 0-20.818-9.32-20.818-20.818v-38.373zM308.807 245.325c-11.477 0-20.798 9.321-20.798 20.818v38.373c0 11.497 9.32 20.818 20.798 20.818 11.497 0 20.818-9.32 20.818-20.818v-38.373c0-11.497-9.32-20.818-20.818-20.818z"
        fillRule="nonzero"
      />
      <path d="M512.002 246.393v57.384c-.02 7.411-3.696 14.638-9.67 19.011C431.767 374.444 344.695 416 256 416c-98.138 0-196.379-56.542-246.33-93.21-5.975-4.374-9.65-11.6-9.671-19.012v-57.384a35.347 35.347 0 016.857-20.922l15.583-21.085c8.336-11.312 20.757-14.31 33.98-14.31 4.988-56.953 16.794-97.604 45.024-127.354C155.194 5.77 226.56 0 256 0c29.441 0 100.807 5.77 154.557 62.722 28.19 29.75 40.036 70.401 45.025 127.354 13.263 0 25.602 2.936 33.958 14.31l15.583 21.127c4.476 6.077 6.878 13.345 6.878 20.88zm-97.666-26.075c-.677-13.058-11.292-18.19-22.338-21.824-11.64 7.309-25.848 10.183-39.46 10.183-14.454 0-41.432-3.47-63.872-25.869-5.667-5.625-9.527-14.454-12.155-24.247a212.902 212.902 0 00-20.469-1.088c-6.098 0-13.099.349-20.551 1.088-2.628 9.793-6.509 18.622-12.155 24.247-22.4 22.4-49.418 25.87-63.872 25.87-13.612 0-27.86-2.855-39.501-10.184-11.005 3.613-21.558 8.828-22.277 21.824-1.17 24.555-1.272 49.11-1.375 73.645-.041 12.318-.082 24.658-.288 36.976.062 7.166 4.374 13.818 10.882 16.774 52.97 24.124 103.045 36.278 149.137 36.278 46.01 0 96.085-12.154 149.014-36.278 6.508-2.956 10.84-9.608 10.881-16.774.637-36.832.124-73.809-1.642-110.62h.041zM107.521 168.97c8.643 8.623 24.966 14.392 42.56 14.392 13.448 0 39.03-2.874 60.156-24.329 9.28-8.951 15.05-31.35 14.413-54.079-.657-18.231-5.769-33.28-13.448-39.665-8.315-7.371-27.203-10.574-48.33-8.644-22.399 2.238-41.267 9.588-50.875 19.833-20.798 22.728-16.323 80.317-4.476 92.492zm130.556-56.008c.637 3.51.965 7.35 1.273 11.517 0 2.875 0 5.77-.308 8.952 6.406-.636 11.847-.636 16.959-.636s10.553 0 16.959.636c-.329-3.182-.329-6.077-.329-8.952.329-4.167.657-8.007 1.294-11.517-6.735-.637-12.812-.965-17.924-.965s-11.21.328-17.924.965zm49.275-8.008c-.637 22.728 5.133 45.128 14.413 54.08 21.105 21.454 46.708 24.328 60.155 24.328 17.596 0 33.918-5.769 42.561-14.392 11.847-12.175 16.322-69.764-4.476-92.492-9.608-10.245-28.476-17.595-50.875-19.833-21.127-1.93-40.015 1.273-48.33 8.644-7.679 6.385-12.791 21.434-13.448 39.665z" />
    </svg>
  );
}

// Check if added_by is a human or agent
function isHuman(addedBy: string): boolean {
  const lower = addedBy.toLowerCase();
  return lower === "human" || lower === "user" || lower === "you";
}

// Check if file is an image
function isImage(mimetype?: string, name?: string): boolean {
  if (mimetype?.startsWith("image/")) return true;
  if (name) {
    const ext = name.split(".").pop()?.toLowerCase();
    return ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext || "");
  }
  return false;
}

// Generate consistent color from agent name
function getAgentColor(agentId: string): string {
  const colors = ["#D97853", "#5B8DEF", "#7C5BC2", "#4CAF50", "#FF9800", "#E91E63", "#00BCD4", "#9C27B0"];
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// Types
interface TaskAttachment {
  id: string;
  name: string;
  url?: string;
  file_id?: string;
  mimetype?: string;
  size?: number;
  added_by: string;
  added_at: number;
}

interface TaskComment {
  id: string;
  author: string;
  text: string;
  created_at: number;
}

interface Task {
  id: string;
  title: string;
  description?: string;
  status: "todo" | "doing" | "done" | "blocked";
  priority: "P0" | "P1" | "P2" | "P3";
  tags?: string[];
  created_at: number;
  started_at?: number;
  completed_at?: number;
  due_at?: number;
  agent_id: string;
  attachments?: TaskAttachment[];
  comments?: TaskComment[];
}

interface Phase {
  id: string;
  plan_id: string;
  name: string;
  description?: string;
  order_index: number;
  status: "pending" | "active" | "completed" | "blocked" | "skipped";
  agent_in_charge?: string;
  started_at?: number;
  completed_at?: number;
  created_at: number;
}

interface Plan {
  id: string;
  channel: string;
  title: string;
  description?: string;
  status: "draft" | "active" | "completed" | "cancelled";
  created_by: string;
  created_at: number;
  updated_at: number;
  agent_in_charge?: string;
  phases?: Phase[];
  progress?: {
    total_phases: number;
    completed_phases: number;
    total_tasks: number;
    completed_tasks: number;
  };
}

interface PhaseWithTasks {
  phase: Phase;
  tasks: Task[];
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
}

const API_URL = "";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export default function PlanModal({ channel, isOpen, onClose }: Props) {
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [phasesWithTasks, setPhasesWithTasks] = useState<PhaseWithTasks[]>([]);
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch active plan for channel
  const fetchActivePlan = useCallback(async () => {
    if (!channel) return;

    setLoading(true);
    setError(null);

    try {
      // Get all plans for channel
      const res = await fetch(`${API_URL}/api/plans.list?channel=${encodeURIComponent(channel)}`);
      const data = await res.json();

      if (!data.ok) {
        setError(data.error);
        return;
      }

      // Find active plan (or most recent draft)
      const plans: Plan[] = data.plans;
      const active = plans.find((p) => p.status === "active") || plans.find((p) => p.status === "draft");

      if (!active) {
        setActivePlan(null);
        setPhasesWithTasks([]);
        return;
      }

      // Get full plan details
      const planRes = await fetch(`${API_URL}/api/plans.get?plan_id=${active.id}`);
      const planData = await planRes.json();

      if (!planData.ok) {
        setError(planData.error);
        return;
      }

      setActivePlan(planData.plan);

      // Expand active phases by default
      const activePhaseIds = new Set<string>(
        (planData.plan.phases || [])
          .filter((p: Phase) => p.status === "active" || p.status === "pending")
          .map((p: Phase) => p.id),
      );
      setExpandedPhases(activePhaseIds);

      // Get tasks for plan
      const tasksRes = await fetch(`${API_URL}/api/plans.getTasks?plan_id=${active.id}`);
      const tasksData = await tasksRes.json();

      if (tasksData.ok) {
        setPhasesWithTasks(tasksData.phases);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [channel]);

  useEffect(() => {
    if (isOpen) {
      fetchActivePlan();
    }
  }, [isOpen, fetchActivePlan]);

  const togglePhase = (phaseId: string) => {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phaseId)) {
        next.delete(phaseId);
      } else {
        next.add(phaseId);
      }
      return next;
    });
  };

  const handleTaskClick = async (taskId: string) => {
    try {
      const res = await fetch(`${API_URL}/api/tasks.get?task_id=${taskId}`);
      const data = await res.json();
      if (data.ok) {
        setSelectedTask(data.task);
      }
    } catch (err) {
      console.error("Failed to fetch task:", err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="plan-modal-overlay" onClick={onClose}>
      <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="plan-modal-header">
          <h2>
            {selectedTask ? (
              <button className="back-btn" onClick={() => setSelectedTask(null)}>
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
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </button>
            ) : (
              activePlan?.title || "Active Plan"
            )}
          </h2>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Content */}
        <div className="plan-modal-content">
          {loading && <div className="plan-loading">Loading...</div>}

          {error && <div className="plan-error">{error}</div>}

          {!loading && !error && !activePlan && (
            <div className="plan-empty">
              <p>No active plan for this channel.</p>
              <p className="hint">
                Create a plan with the <code>plan_create</code> tool.
              </p>
            </div>
          )}

          {!loading && !error && activePlan && !selectedTask && (
            <PlanView
              plan={activePlan}
              phasesWithTasks={phasesWithTasks}
              expandedPhases={expandedPhases}
              onTogglePhase={togglePhase}
              onTaskClick={handleTaskClick}
            />
          )}

          {selectedTask && <TaskDetailView task={selectedTask} />}
        </div>
      </div>
    </div>
  );
}

// Plan tree view
function PlanView({
  plan,
  phasesWithTasks,
  expandedPhases,
  onTogglePhase,
  onTaskClick,
}: {
  plan: Plan;
  phasesWithTasks: PhaseWithTasks[];
  expandedPhases: Set<string>;
  onTogglePhase: (id: string) => void;
  onTaskClick: (id: string) => void;
}) {
  return (
    <div className="plan-view">
      {/* Plan description only */}
      {plan.description && (
        <div className="plan-info">
          <p className="plan-description">{plan.description}</p>
        </div>
      )}

      {/* Phases tree */}
      <div className="phases-tree">
        {phasesWithTasks.map(({ phase, tasks }) => (
          <div key={phase.id} className={`phase-item phase-${phase.status}`}>
            <div className="phase-header" onClick={() => onTogglePhase(phase.id)}>
              <span className="expand-icon">{expandedPhases.has(phase.id) ? "▼" : "▶"}</span>
              <span className="phase-name">{phase.name}</span>
              {phase.agent_in_charge && (
                <span className="phase-agent" title={phase.agent_in_charge}>
                  <AgentAvatar color={getAgentColor(phase.agent_in_charge)} />
                </span>
              )}
            </div>

            {expandedPhases.has(phase.id) && (
              <div className="phase-tasks">
                {tasks.length === 0 ? (
                  <div className="no-tasks">No tasks in this phase</div>
                ) : (
                  tasks.map((task) => (
                    <div key={task.id} className={`task-item task-${task.status}`} onClick={() => onTaskClick(task.id)}>
                      <span className={`task-title ${task.status === "done" ? "completed" : ""}`}>{task.title}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Task detail view
function TaskDetailView({ task }: { task: Task }) {
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);

  return (
    <div className="task-detail">
      {/* Task header */}
      <div className="task-detail-header">
        <div className="task-id">{task.id}</div>
        <h3 className={task.status === "done" ? "completed" : ""}>{task.title}</h3>
      </div>

      {/* Status bar */}
      <div className="task-status-bar">
        <span className={`status-badge status-${task.status}`}>{task.status}</span>
        {task.tags?.map((tag) => (
          <span key={tag} className="tag-badge">
            #{tag}
          </span>
        ))}
      </div>

      {/* Meta info */}
      <div className="task-meta-grid">
        <div className="meta-item">
          <label>Created</label>
          <span>{formatDate(task.created_at)}</span>
        </div>
        {task.started_at && (
          <div className="meta-item">
            <label>Started</label>
            <span>{formatDate(task.started_at)}</span>
          </div>
        )}
        {task.completed_at && (
          <div className="meta-item">
            <label>Completed</label>
            <span>{formatDate(task.completed_at)}</span>
          </div>
        )}
        {task.due_at && (
          <div className="meta-item">
            <label>Due</label>
            <span>{formatDate(task.due_at)}</span>
          </div>
        )}
        <div className="meta-item">
          <label>Assignee</label>
          <span className="assignee-value">
            <AgentAvatar color={getAgentColor(task.agent_id)} />
            {task.agent_id}
          </span>
        </div>
      </div>

      {/* Description */}
      {task.description && (
        <div className="task-section">
          <h4>Description</h4>
          <div className="task-description">{task.description}</div>
        </div>
      )}

      {/* Attachments */}
      {task.attachments && task.attachments.length > 0 && (
        <div className="task-section">
          <h4>Attachments ({task.attachments.length})</h4>
          <div className="attachments-list">
            {task.attachments.map((att) => (
              <div key={att.id} className="attachment-item">
                <div className="attachment-row">
                  <a href={att.url} target="_blank" rel="noopener noreferrer" className="attachment-name">
                    {att.name}
                  </a>
                  <span className="attachment-meta">
                    {isHuman(att.added_by) ? <HumanAvatar /> : <AgentAvatar color={getAgentColor(att.added_by)} />}
                    {formatRelativeTime(att.added_at)}
                  </span>
                </div>
                {isImage(att.mimetype, att.name) && att.url && (
                  <img
                    src={att.url}
                    alt={att.name}
                    className="attachment-preview-img"
                    onClick={() => setLightboxImage({ src: att.url!, alt: att.name })}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Comments */}
      {task.comments && task.comments.length > 0 && (
        <div className="task-section">
          <h4>Comments ({task.comments.length})</h4>
          <div className="comments-list">
            {task.comments.map((cmt) => (
              <div key={cmt.id} className="comment-item">
                <div className="comment-header">
                  {isHuman(cmt.author) ? <HumanAvatar /> : <AgentAvatar color={getAgentColor(cmt.author)} />}
                  <span className="comment-author">{cmt.author}</span>
                  <span className="comment-time">{formatRelativeTime(cmt.created_at)}</span>
                </div>
                <div className="comment-text">{cmt.text}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightboxImage &&
        createPortal(
          <div
            className="lightbox-overlay"
            onClick={() => setLightboxImage(null)}
            onKeyDown={(e) => e.key === "Escape" && setLightboxImage(null)}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
          >
            <button className="lightbox-close" onClick={() => setLightboxImage(null)} aria-label="Close">
              ×
            </button>
            <img
              src={lightboxImage.src}
              alt={lightboxImage.alt}
              className="lightbox-image"
              onClick={(e) => e.stopPropagation()}
            />
            <a
              href={lightboxImage.src}
              target="_blank"
              rel="noopener noreferrer"
              className="lightbox-open-new"
              onClick={(e) => e.stopPropagation()}
            >
              Open in new tab ↗
            </a>
          </div>,
          document.body,
        )}
    </div>
  );
}
