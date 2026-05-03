import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";
import { InputContextMenu, useInputContextMenu } from "./InputContextMenu";
import { ClawdAvatar } from "./MessageList";

const API_URL = "";

// --- TypeScript Interfaces (local — NOT imported from server) ---

interface ScheduledJob {
  id: string;
  channel: string;
  created_by_agent: string;
  type: "once" | "interval" | "cron" | "reminder" | "tool_call";
  status: "active" | "paused" | "completed" | "failed" | "cancelled";
  cron_expr: string | null;
  interval_ms: number | null;
  run_at: number | null;
  next_run: number;
  title: string;
  prompt: string;
  timeout_seconds: number;
  max_runs: number | null;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  run_count: number;
  consecutive_errors: number;
  last_error: string | null;
  tool_name: string | null;
  tool_args_json: string | null;
  is_running?: boolean;
}

interface JobRun {
  id: string;
  job_id: string;
  started_at: number;
  completed_at: number | null;
  status: "running" | "success" | "error" | "timeout";
  error_message: string | null;
  output_summary: string | null;
}

interface Agent {
  channel: string;
  agent_id: string;
  project: string;
  avatar_color: string | null;
  running: boolean;
  sleeping: boolean;
}

interface SchedulerDialogProps {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
  refreshTick: number;
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

// --- Helpers ---

const isAutoPaused = (job: ScheduledJob) => job.status === "paused" && job.consecutive_errors >= 5;

const getBadgeClass = (job: ScheduledJob) => {
  if (isAutoPaused(job)) return "scheduler-status-badge scheduler-status-badge--auto-paused";
  return `scheduler-status-badge scheduler-status-badge--${job.status}`;
};

const getBadgeLabel = (job: ScheduledJob) => {
  if (isAutoPaused(job)) return "Auto-paused";
  return job.status;
};

const formatDuration = (ms: number) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

export default function SchedulerDialog({ channel, isOpen, onClose, refreshTick }: SchedulerDialogProps) {
  // --- State ---
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [cardLoading, setCardLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [selectedJob, setSelectedJob] = useState<ScheduledJob | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runs, setRuns] = useState<JobRun[]>([]);

  const [editTitle, setEditTitle] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editSchedule, setEditSchedule] = useState("");
  const [editIsReminder, setEditIsReminder] = useState(false);
  const [editMaxRuns, setEditMaxRuns] = useState("");
  const [editTimeoutSeconds, setEditTimeoutSeconds] = useState("");

  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);

  const titleInputRef = useRef<HTMLInputElement>(null);

  const anyInFlight = saving || cancelling || pausing || resuming;

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

  // --- Callbacks ---

  const loadJobs = useCallback(
    async (signal?: AbortSignal, silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await authFetch(`${API_URL}/api/app.scheduler.list?channel=${encodeURIComponent(channel)}`, {
          signal,
        });
        const data = await res.json();
        if (data.ok) {
          setJobs(data.jobs);
          setActiveCount(data.active_count ?? 0);
        }
      } catch {
        /* silent on poll / abort */
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [channel],
  );

  const closeDetailDialog = useCallback(() => {
    setDetailOpen(false);
    setSelectedJob(null);
    setRuns([]);
    setIsRunning(false);
    setIsNew(false);
    setError(null);
  }, []);

  const handleMutationResult = useCallback(
    async (res: Response) => {
      const data = await res.json();
      if (res.status === 409) {
        // Stale conflict — refresh list and close detail
        await loadJobs();
        closeDetailDialog();
        setError(data.error || "Job state changed — list refreshed");
        return false;
      }
      if (!data.ok) {
        setError(data.error || "Operation failed");
        return false;
      }
      closeDetailDialog();
      await loadJobs();
      return true;
    },
    [loadJobs, closeDetailDialog],
  );

  const handleCardClick = useCallback(
    async (job: ScheduledJob) => {
      if (cardLoading) return;
      setCardLoading(true);
      setError(null);
      setRuns([]); // Clear stale runs immediately
      try {
        const params = new URLSearchParams({ id: job.id, channel, runs_limit: "10" });
        const res = await authFetch(`${API_URL}/api/app.scheduler.get?${params}`);
        const data = await res.json();
        if (data.ok) {
          setSelectedJob(data.job);
          setRuns(data.runs || []);
          setIsRunning(data.is_running ?? false);
          setIsNew(false);
          setDetailOpen(true);
        } else {
          setError(data.error || "Failed to load job");
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setCardLoading(false);
      }
    },
    [channel, cardLoading],
  );

  const handleNewClick = useCallback(() => {
    setEditTitle("");
    setEditPrompt("");
    setEditSchedule("");
    setEditIsReminder(false);
    setEditMaxRuns("");
    setEditTimeoutSeconds("");
    setSelectedJob(null);
    setRuns([]);
    setIsRunning(false);
    setIsNew(true);
    setDetailOpen(true);
    setError(null);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!editTitle.trim() || !editPrompt.trim() || !editSchedule.trim() || !selectedAgentId) return;
    // Validate numeric fields
    if (editMaxRuns.trim()) {
      const n = Number(editMaxRuns);
      if (!Number.isInteger(n) || n <= 0) {
        setError("Max runs must be a positive integer");
        return;
      }
    }
    if (editTimeoutSeconds.trim()) {
      const n = Number(editTimeoutSeconds);
      if (!Number.isFinite(n) || n <= 0 || n > 3600) {
        setError("Timeout must be 1-3600 seconds");
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, any> = {
        channel,
        agent_id: selectedAgentId,
        title: editTitle.trim(),
        prompt: editPrompt.trim(),
        schedule: editSchedule.trim(),
      };
      if (editIsReminder) body.is_reminder = true;
      if (editMaxRuns.trim()) body.max_runs = Number(editMaxRuns);
      if (editTimeoutSeconds.trim()) body.timeout_seconds = Number(editTimeoutSeconds);
      const res = await authFetch(`${API_URL}/api/app.scheduler.create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.status === 409) {
        await loadJobs();
        closeDetailDialog();
        setError(data.error || "Job conflict — list refreshed");
      } else if (data.ok) {
        closeDetailDialog();
        await loadJobs();
      } else {
        setError(data.error || "Failed to create job");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [
    channel,
    selectedAgentId,
    editTitle,
    editPrompt,
    editSchedule,
    editIsReminder,
    editMaxRuns,
    editTimeoutSeconds,
    loadJobs,
    closeDetailDialog,
  ]);

  const handleCancel = useCallback(async () => {
    if (!selectedJob || anyInFlight) return;
    setCancelling(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/app.scheduler.cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedJob.id, channel }),
      });
      await handleMutationResult(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setCancelling(false);
    }
  }, [selectedJob, anyInFlight, channel, handleMutationResult]);

  const handlePause = useCallback(async () => {
    if (!selectedJob || anyInFlight) return;
    setPausing(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/app.scheduler.pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedJob.id, channel }),
      });
      await handleMutationResult(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setPausing(false);
    }
  }, [selectedJob, anyInFlight, channel, handleMutationResult]);

  const handleResume = useCallback(async () => {
    if (!selectedJob || anyInFlight) return;
    setResuming(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/app.scheduler.resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedJob.id, channel }),
      });
      await handleMutationResult(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setResuming(false);
    }
  }, [selectedJob, anyInFlight, channel, handleMutationResult]);

  // --- Effects ---

  // 1. Fetch agents on open
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

  // 2. Reset state on close
  useEffect(() => {
    if (!isOpen) {
      closeDetailDialog();
      setSelectedAgentId(null);
      setJobs([]);
    }
  }, [isOpen, closeDetailDialog]);

  // 3. Load jobs on agent selection
  useEffect(() => {
    if (!selectedAgentId) {
      setJobs([]);
      setDetailOpen(false);
      return;
    }
    const controller = new AbortController();
    loadJobs(controller.signal);
    return () => controller.abort();
  }, [selectedAgentId, loadJobs]);

  // 4. Autofocus title input on new job
  useEffect(() => {
    if (detailOpen && isNew) {
      const timer = setTimeout(() => titleInputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
  }, [detailOpen, isNew]);

  // 5. Escape key — two-level handling
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (anyInFlight) return;
      if (detailOpen) {
        e.stopPropagation();
        closeDetailDialog();
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, detailOpen, anyInFlight, closeDetailDialog, onClose]);

  // 6. Polling — 5s
  useEffect(() => {
    if (!isOpen || !selectedAgentId) return;
    const id = setInterval(() => {
      loadJobs(undefined, true);
    }, 5000);
    return () => clearInterval(id);
  }, [isOpen, selectedAgentId, loadJobs]);

  // 7. refreshTick watcher
  useEffect(() => {
    if (!isOpen || !selectedAgentId || refreshTick === 0) return;
    loadJobs();
  }, [isOpen, selectedAgentId, refreshTick, loadJobs]);

  // --- Client-side Filtering ---

  const filteredJobs = useMemo(() => {
    let list = jobs.filter((j) => j.status === "active");
    if (selectedAgentId) list = list.filter((j) => j.created_by_agent === selectedAgentId);
    return list;
  }, [jobs, selectedAgentId]);

  // tool_call rendering helper
  const toolArgs = useMemo(() => {
    if (!selectedJob?.tool_args_json) return null;
    try {
      return JSON.parse(selectedJob.tool_args_json);
    } catch {
      return null;
    }
  }, [selectedJob?.tool_args_json]);

  // --- New Job Disabled ---
  const newJobDisabled = !selectedAgentId || activeCount >= 25;

  // --- Render ---

  if (!isOpen) return null;

  // Block dialog close (overlay click, X button) while a mutation is in flight.
  // Escape is already guarded on `anyInFlight` in the keydown handler above.
  const guardedClose = () => {
    if (anyInFlight) return;
    onClose();
  };

  return createPortal(
    <div className="stream-dialog-overlay" onClick={guardedClose}>
      <div className="stream-dialog scheduler-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            <h3>Schedulers</h3>
            <button
              className="worktree-refresh-btn"
              onClick={() => selectedAgentId && loadJobs()}
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
          <button className="stream-dialog-close" onClick={guardedClose} disabled={anyInFlight}>
            ×
          </button>
        </div>

        {/* Agent avatar bar */}
        <div className="stream-agent-bar">
          {agents.map((a) => {
            const isActive = selectedAgentId === a.agent_id;
            const color = a.avatar_color || "#D97853";
            return (
              <button
                key={a.agent_id}
                className={`stream-agent-avatar-btn ${isActive ? "active" : ""}`}
                onClick={() => {
                  setSelectedAgentId(a.agent_id);
                  setError(null);
                }}
                title={a.agent_id}
              >
                <span className="stream-agent-avatar-wrap">
                  <ClawdAvatar color={color} standing={a.running && !a.sleeping} sleeping={a.sleeping} />
                </span>
                <span className="stream-agent-avatar-name">{a.agent_id}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="scheduler-dialog-body">
          {!selectedAgentId ? (
            <div className="stream-dialog-placeholder">
              {agents.length === 0 ? "No agents configured." : "Select an agent above to manage scheduled jobs."}
            </div>
          ) : loading && jobs.length === 0 ? (
            <div className="scheduler-list-empty">Loading...</div>
          ) : (
            <>
              {/* Job cards */}
              <div className="scheduler-cards-list">
                {filteredJobs.map((job) => (
                  <div
                    key={job.id}
                    className="message-subspace-card"
                    onClick={() => handleCardClick(job)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && handleCardClick(job)}
                    style={{
                      ...(cardLoading ? { opacity: 0.6, pointerEvents: "none" as const } : {}),
                    }}
                  >
                    <div className="subspace-card-icon">
                      <ClawdAvatar />
                    </div>
                    <div className="subspace-card-content">
                      <div className="subspace-card-title">{job.title}</div>
                      <div className="scheduler-card-meta">
                        <span>{job.type}</span>
                        {job.cron_expr && <span>{job.cron_expr}</span>}
                        {job.interval_ms && <span>every {formatDuration(job.interval_ms)}</span>}
                        <span>
                          runs: {job.run_count}
                          {job.max_runs ? `/${job.max_runs}` : ""}
                        </span>
                        {job.next_run > 0 && job.status === "active" && (
                          <span>next: {new Date(job.next_run).toLocaleString()}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {/* Add new job card */}
                <div
                  className="message-subspace-card"
                  onClick={newJobDisabled ? undefined : handleNewClick}
                  role="button"
                  tabIndex={newJobDisabled ? -1 : 0}
                  onKeyDown={(e) => !newJobDisabled && e.key === "Enter" && handleNewClick()}
                  style={{
                    borderStyle: "dashed",
                    opacity: newJobDisabled ? 0.4 : 1,
                    cursor: newJobDisabled ? "default" : "pointer",
                    pointerEvents: newJobDisabled ? "none" : undefined,
                  }}
                >
                  <div className="subspace-card-icon" style={{ color: "hsl(15 63.1% 59.6%)" }}>
                    <PlusIcon />
                  </div>
                  <div className="subspace-card-content">
                    <div className="subspace-card-title" style={{ color: "hsl(15 63.1% 59.6%)" }}>
                      New Scheduled Job
                    </div>
                    <div className="subspace-card-description">
                      {activeCount >= 25
                        ? "Max 25 active jobs reached. Cancel existing jobs first."
                        : "Schedule a recurring or one-time job"}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
          {error && !detailOpen && <div className="agent-dialog-error">{error}</div>}
        </div>
      </div>

      {/* Detail / Create sub-dialog */}
      {detailOpen && (
        <div className="stream-dialog-overlay" onClick={closeDetailDialog}>
          <div className="stream-dialog agent-file-edit-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="stream-dialog-header">
              <div className="stream-dialog-title-row">
                <h3>{isNew ? "New Scheduled Job" : selectedJob?.title || "Job Detail"}</h3>
              </div>
              <button className="stream-dialog-close" onClick={closeDetailDialog}>
                ×
              </button>
            </div>
            <div className="agent-file-edit-body">
              {isNew ? (
                <>
                  {/* Create form */}
                  <label className="skills-field-label" htmlFor="sched-title">
                    Title
                  </label>
                  <input
                    ref={titleInputRef}
                    id="sched-title"
                    className="agent-field-input"
                    placeholder="Daily deploy check"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onContextMenu={handleInputContextMenu}
                  />

                  <label className="skills-field-label" htmlFor="sched-schedule">
                    Schedule
                  </label>
                  <input
                    id="sched-schedule"
                    className="agent-field-input"
                    placeholder="every 30m, 0 9 * * *, in 2h, ..."
                    value={editSchedule}
                    onChange={(e) => setEditSchedule(e.target.value)}
                    onContextMenu={handleInputContextMenu}
                  />
                  <div className="scheduler-tz-note">
                    Supports: cron (0 9 * * *), interval (every 30m), one-time (in 2h, at 3pm)
                  </div>

                  <div className="scheduler-checkbox-row">
                    <input
                      type="checkbox"
                      id="sched-reminder"
                      checked={editIsReminder}
                      onChange={(e) => setEditIsReminder(e.target.checked)}
                    />
                    <label htmlFor="sched-reminder">Reminder (sends message instead of executing)</label>
                  </div>

                  <label className="skills-field-label" htmlFor="sched-maxruns">
                    Max runs (optional)
                  </label>
                  <input
                    id="sched-maxruns"
                    className="agent-field-input"
                    placeholder="e.g. 10"
                    value={editMaxRuns}
                    onChange={(e) => setEditMaxRuns(e.target.value)}
                    onContextMenu={handleInputContextMenu}
                  />

                  <label className="skills-field-label" htmlFor="sched-timeout">
                    Timeout seconds (optional)
                  </label>
                  <input
                    id="sched-timeout"
                    className="agent-field-input"
                    placeholder="e.g. 300 (max 3600)"
                    value={editTimeoutSeconds}
                    onChange={(e) => setEditTimeoutSeconds(e.target.value)}
                    onContextMenu={handleInputContextMenu}
                  />

                  <label className="skills-field-label" htmlFor="sched-prompt">
                    Prompt
                  </label>
                  <textarea
                    id="sched-prompt"
                    className="agent-file-editor"
                    placeholder="Check deployment status and report..."
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    onContextMenu={handleInputContextMenu}
                  />

                  {error && (
                    <div className="agent-dialog-error" style={{ marginTop: 8 }}>
                      {error}
                    </div>
                  )}
                </>
              ) : selectedJob ? (
                <>
                  {/* Detail view */}
                  <dl className="scheduler-detail-meta">
                    <dt>Status</dt>
                    <dd>
                      <span className={getBadgeClass(selectedJob)}>{getBadgeLabel(selectedJob)}</span>
                      {isRunning && (
                        <span
                          className="scheduler-status-badge scheduler-status-badge--active"
                          style={{ marginLeft: 8 }}
                        >
                          Running now
                        </span>
                      )}
                    </dd>
                    <dt>Type</dt>
                    <dd>{selectedJob.type}</dd>
                    <dt>Agent</dt>
                    <dd>{selectedJob.created_by_agent}</dd>
                    {selectedJob.cron_expr && (
                      <>
                        <dt>Cron</dt>
                        <dd>
                          <code>{selectedJob.cron_expr}</code>
                        </dd>
                      </>
                    )}
                    {selectedJob.interval_ms && (
                      <>
                        <dt>Interval</dt>
                        <dd>{formatDuration(selectedJob.interval_ms)}</dd>
                      </>
                    )}
                    {selectedJob.run_at && (
                      <>
                        <dt>Run at</dt>
                        <dd>{new Date(selectedJob.run_at).toLocaleString()}</dd>
                      </>
                    )}
                    {selectedJob.next_run > 0 && selectedJob.status === "active" && (
                      <>
                        <dt>Next run</dt>
                        <dd>{new Date(selectedJob.next_run).toLocaleString()}</dd>
                      </>
                    )}
                    <dt>Runs</dt>
                    <dd>
                      {selectedJob.run_count}
                      {selectedJob.max_runs ? ` / ${selectedJob.max_runs}` : ""}
                    </dd>
                    <dt>Timeout</dt>
                    <dd>{selectedJob.timeout_seconds}s</dd>
                    <dt>Created</dt>
                    <dd>{new Date(selectedJob.created_at).toLocaleString()}</dd>
                    {selectedJob.last_run_at && (
                      <>
                        <dt>Last run</dt>
                        <dd>{new Date(selectedJob.last_run_at).toLocaleString()}</dd>
                      </>
                    )}
                    {selectedJob.consecutive_errors > 0 && (
                      <>
                        <dt>Errors</dt>
                        <dd>{selectedJob.consecutive_errors} consecutive</dd>
                      </>
                    )}
                    {selectedJob.last_error && (
                      <>
                        <dt>Last error</dt>
                        <dd style={{ color: "hsl(0 84% 60%)" }}>{selectedJob.last_error}</dd>
                      </>
                    )}
                    {selectedJob.tool_name && (
                      <>
                        <dt>Tool</dt>
                        <dd>
                          <code>{selectedJob.tool_name}</code>
                        </dd>
                      </>
                    )}
                    {toolArgs && (
                      <>
                        <dt>Tool args</dt>
                        <dd>
                          <pre style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap" }}>
                            {JSON.stringify(toolArgs, null, 2)}
                          </pre>
                        </dd>
                      </>
                    )}
                  </dl>

                  <div style={{ marginTop: 4 }}>
                    <label className="skills-field-label" htmlFor="sched-detail-prompt">
                      Prompt
                    </label>
                    <div
                      style={{
                        fontSize: 13,
                        padding: "8px 12px",
                        background: "hsl(var(--text) / 4%)",
                        borderRadius: 6,
                        whiteSpace: "pre-wrap",
                        maxHeight: 120,
                        overflowY: "auto",
                      }}
                    >
                      {selectedJob.prompt}
                    </div>
                  </div>

                  {/* Run History */}
                  {runs.length > 0 && (
                    <div className="scheduler-runs-section">
                      <h4>Run History</h4>
                      <div className="scheduler-runs-list">
                        {runs.map((run) => (
                          <div key={run.id} className="scheduler-run-item">
                            <span className={`scheduler-run-status scheduler-run-status--${run.status}`} />
                            <span>{new Date(run.started_at).toLocaleString()}</span>
                            {run.completed_at && (
                              <span style={{ color: "hsl(var(--text) / 40%)" }}>
                                {formatDuration(run.completed_at - run.started_at)}
                              </span>
                            )}
                            {run.output_summary && (
                              <span
                                style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                              >
                                {run.output_summary}
                              </span>
                            )}
                            {run.error_message && (
                              <span
                                style={{
                                  color: "hsl(0 84% 60%)",
                                  flex: 1,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {run.error_message}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {error && (
                    <div className="agent-dialog-error" style={{ marginTop: 8 }}>
                      {error}
                    </div>
                  )}
                </>
              ) : null}
            </div>
            <div className="agent-file-edit-actions">
              {isNew ? (
                <>
                  <button
                    className="agent-action-btn agent-action-btn--accent"
                    onClick={handleCreate}
                    disabled={
                      saving || !editTitle.trim() || !editPrompt.trim() || !editSchedule.trim() || !selectedAgentId
                    }
                  >
                    {saving ? "Creating..." : "Create"}
                  </button>
                  <button className="agent-action-btn" onClick={closeDetailDialog} disabled={saving}>
                    Cancel
                  </button>
                </>
              ) : selectedJob ? (
                <>
                  {(selectedJob.status === "active" || selectedJob.status === "paused") && (
                    <>
                      {selectedJob.status === "active" && (
                        <button
                          className="agent-action-btn agent-action-btn--accent"
                          onClick={handlePause}
                          disabled={anyInFlight}
                        >
                          {pausing ? "Pausing..." : "Pause"}
                        </button>
                      )}
                      {selectedJob.status === "paused" && (
                        <button
                          className="agent-action-btn agent-action-btn--accent"
                          onClick={handleResume}
                          disabled={anyInFlight}
                        >
                          {resuming ? "Resuming..." : "Resume"}
                        </button>
                      )}
                      <button
                        className="agent-action-btn agent-action-btn--danger"
                        onClick={handleCancel}
                        disabled={anyInFlight}
                      >
                        {cancelling ? "Cancelling..." : "Cancel Job"}
                      </button>
                    </>
                  )}
                  <button className="agent-action-btn" onClick={closeDetailDialog} disabled={anyInFlight}>
                    Close
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Input context menu */}
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
