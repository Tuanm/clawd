import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";
import { ClawdAvatar } from "./MessageList";
import WorktreeDiffViewer from "./worktree-diff-viewer";
import { type FileStatus, WorktreeFileSidebar } from "./worktree-file-list";

function ResizeDivider({
  onResize,
  direction,
}: {
  onResize: (delta: number) => void;
  direction: "horizontal" | "vertical";
}) {
  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    let lastPos = direction === "horizontal" ? e.clientX : e.clientY;

    const handleMove = (me: PointerEvent) => {
      const pos = direction === "horizontal" ? me.clientX : me.clientY;
      const delta = pos - lastPos;
      lastPos = pos;
      if (delta !== 0) onResize(delta);
    };

    const handleUp = () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
  };

  return <div className={`resize-divider resize-divider--${direction}`} onPointerDown={handlePointerDown} />;
}

const API_URL = "";

interface WorktreeAgent {
  agent_id: string;
  avatar_color: string | null;
  running: boolean;
  branch: string;
  worktree_path: string;
  original_project: string;
  clean: boolean;
  has_conflicts: boolean;
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
  onOpenInProjects?: (agentId: string, filePath: string, line?: number) => void;
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

export default function WorktreeDialog({ channel, isOpen, onClose, onOpenInProjects }: Props) {
  const [agents, setAgents] = useState<WorktreeAgent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarSize, setSidebarSize] = useState(280);
  const [diffKey, setDiffKey] = useState(0);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  const selectedAgent = agents.find((a) => a.agent_id === selectedAgentId) ?? null;
  const stagedFiles = files.filter((f) => f.staged);
  const hasStaged = stagedFiles.length > 0;
  const isRunning = selectedAgent?.running ?? false;
  const hasMergeConflict = selectedAgent?.has_conflicts ?? false;
  const canCommit = hasStaged && commitMsg.trim().length > 0 && !isRunning;

  // Close more menu on outside click
  useEffect(() => {
    if (!showMoreMenu) return;
    const handler = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMoreMenu]);

  // Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const loadStatus = useCallback(async () => {
    if (!channel) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/app.worktree.status?channel=${encodeURIComponent(channel)}`);
      const data = await res.json();
      if (data.ok) {
        const list: WorktreeAgent[] = (data.agents ?? []).map((a: any) => ({
          agent_id: a.agent_id,
          avatar_color: a.avatar_color || null,
          running: a.running ?? false,
          branch: a.branch || "",
          worktree_path: a.worktree_path || "",
          original_project: a.original_project || "",
          clean: a.clean ?? true,
          has_conflicts: a.has_conflicts ?? false,
        }));
        setAgents(list);
        if (list.length > 0) {
          setSelectedAgentId((prev) => {
            if (prev && list.find((a) => a.agent_id === prev)) return prev;
            return list[0].agent_id;
          });
        }
      } else {
        setError(data.error || "Failed to load worktree status");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [channel]);

  const fetchFiles = useCallback(
    async (agentId: string): Promise<FileStatus[]> => {
      try {
        const res = await authFetch(
          `${API_URL}/api/app.worktree.status?channel=${encodeURIComponent(channel)}&agent_id=${encodeURIComponent(agentId)}`,
        );
        const data = await res.json();
        if (data.ok) {
          const agent = (data.agents ?? []).find((a: any) => a.agent_id === agentId);
          if (agent?.files) {
            const fileList: FileStatus[] = [];
            for (const p of agent.files.staged ?? []) fileList.push({ path: p, status: "M", staged: true });
            for (const p of agent.files.modified ?? []) fileList.push({ path: p, status: "M", staged: false });
            for (const p of agent.files.untracked ?? []) fileList.push({ path: p, status: "?", staged: false });
            for (const p of agent.files.deleted ?? []) fileList.push({ path: p, status: "D", staged: false });
            for (const p of agent.files.conflicted ?? []) fileList.push({ path: p, status: "U", staged: false });
            return fileList;
          }
        }
      } catch {
        /* silent */
      }
      return [];
    },
    [channel],
  );

  // Initial load: clears selection
  const loadFiles = useCallback(
    async (agentId: string) => {
      setFiles([]);
      setSelectedFile(null);
      const fileList = await fetchFiles(agentId);
      setFiles(fileList);
    },
    [fetchFiles],
  );

  // Refresh: keeps current selection, only updates file list
  const reloadFiles = useCallback(
    async (agentId: string) => {
      const fileList = await fetchFiles(agentId);
      setFiles(fileList);
    },
    [fetchFiles],
  );

  useEffect(() => {
    if (isOpen && channel) loadStatus();
  }, [isOpen, channel]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedAgentId(null);
      setFiles([]);
      setSelectedFile(null);
      setCommitMsg("");
      setError(null);
      setShowMoreMenu(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!selectedAgentId) return;
    loadFiles(selectedAgentId);
  }, [selectedAgentId]);

  // Full refresh: reload status + files + remount diff viewer
  const refresh = useCallback(async () => {
    await loadStatus();
    if (selectedAgentId) await loadFiles(selectedAgentId);
    setDiffKey((k) => k + 1);
  }, [loadStatus, loadFiles, selectedAgentId]);

  // Light refresh: reload only files sidebar (keeps diff viewer + selection intact)
  const refreshFiles = useCallback(async () => {
    if (selectedAgentId) await reloadFiles(selectedAgentId);
  }, [reloadFiles, selectedAgentId]);

  const postAction = useCallback(
    async (endpoint: string, body: Record<string, unknown>) => {
      setActionLoading(true);
      setError(null);
      try {
        const res = await authFetch(`${API_URL}/api/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, agent_id: selectedAgentId, ...body }),
        });
        const data = await res.json();
        if (!data.ok) setError(data.error || `Failed: ${endpoint}`);
        else await refresh();
      } catch (err) {
        setError(String(err));
      } finally {
        setActionLoading(false);
      }
    },
    [channel, selectedAgentId, refresh],
  );

  const handleStageFile = (paths: string | string[]) => {
    const arr = Array.isArray(paths) ? paths : [paths];
    postAction("app.worktree.stage", { paths: arr });
  };
  const handleUnstageFile = (paths: string | string[]) => {
    const arr = Array.isArray(paths) ? paths : [paths];
    postAction("app.worktree.unstage", { paths: arr });
  };
  const handleDiscardFile = (paths: string | string[]) => {
    const arr = Array.isArray(paths) ? paths : [paths];
    const label = arr.length === 1 ? `"${arr[0]}"` : `${arr.length} files`;
    if (!confirm(`Discard changes to ${label}?`)) return;
    postAction("app.worktree.discard", { paths: arr, confirm: true });
  };
  const handleStageAll = () => {
    const unstaged = files.filter((f) => !f.staged).map((f) => f.path);
    postAction("app.worktree.stage", { paths: unstaged });
  };
  const handleCommit = () => {
    if (!commitMsg.trim() || !hasStaged) return;
    postAction("app.worktree.commit", { message: commitMsg }).then(() => setCommitMsg(""));
  };
  const handleApply = () => postAction("app.worktree.apply", {});
  const handleResolve = (path: string, resolution: "ours" | "theirs" | "both") =>
    postAction("app.worktree.resolve", { path, resolution });

  if (!isOpen) return null;

  const diffSource: "unstaged" | "staged" = selectedFile?.staged ? "staged" : "unstaged";

  return createPortal(
    <div className="stream-dialog-overlay" onClick={onClose}>
      <div className="stream-dialog projects-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header — same as ProjectsDialog */}
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            <h3>Git</h3>
            <button className="worktree-refresh-btn" onClick={refresh} title="Refresh" disabled={loading}>
              <RefreshIcon />
            </button>
          </div>
          <button className="stream-dialog-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Agent avatar bar — same as ProjectsDialog */}
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
                  setSelectedFile(null);
                }}
                title={`${agent.agent_id}\n${agent.branch}`}
              >
                <span className="stream-agent-avatar-wrap">
                  <ClawdAvatar color={color} standing={agent.running} />
                  {!agent.clean && <span className="stream-agent-avatar-dot" />}
                </span>
                <span className="stream-agent-avatar-name">{agent.agent_id}</span>
              </button>
            );
          })}
        </div>

        {/* Body — same structure as ProjectsDialog */}
        <div className="projects-dialog-body">
          {/* No agents message */}
          {agents.length === 0 && !loading && (
            <div className="stream-dialog-placeholder">No agents with git repositories in this channel.</div>
          )}
          {loading && agents.length === 0 && <div className="stream-dialog-placeholder">Loading...</div>}

          {/* Main content area */}
          {agents.length > 0 && selectedAgent && (
            <div className="projects-main">
              {/* Left sidebar — collapsible, same styles as ProjectsDialog */}
              <div
                className={`projects-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}
                style={
                  sidebarCollapsed
                    ? undefined
                    : {
                        width: window.innerWidth <= 600 ? undefined : sidebarSize,
                        height: window.innerWidth <= 600 ? sidebarSize : undefined,
                      }
                }
              >
                <div
                  className="projects-root-path"
                  title={selectedAgent.worktree_path || selectedAgent.original_project}
                  onClick={sidebarCollapsed ? () => setSidebarCollapsed(false) : undefined}
                >
                  <span className="projects-root-name">
                    {selectedAgent.worktree_path || selectedAgent.original_project || selectedAgent.agent_id}
                  </span>
                  <button
                    className="projects-sidebar-toggle"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSidebarCollapsed((v) => !v);
                    }}
                    title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                  </button>
                </div>
                {/* File tree using same project-tree styles */}
                <div className="projects-tree">
                  <WorktreeFileSidebar
                    files={files}
                    selectedFile={selectedFile}
                    onSelectFile={(f) => {
                      setSelectedFile(f);
                      setDiffKey((k) => k + 1);
                    }}
                    onStage={handleStageFile}
                    onUnstage={handleUnstageFile}
                    onDiscard={handleDiscardFile}
                    onStageAll={handleStageAll}
                    onResolve={handleResolve}
                    actionLoading={actionLoading}
                    hasMergeConflict={hasMergeConflict}
                  />
                </div>
              </div>

              {/* Resize divider */}
              {!sidebarCollapsed && (
                <ResizeDivider
                  direction={window.innerWidth <= 600 ? "vertical" : "horizontal"}
                  onResize={(delta) => {
                    const isMobile = window.innerWidth <= 600;
                    setSidebarSize((prev) => {
                      const next = prev + delta;
                      const collapseThreshold = isMobile ? 60 : 80;
                      if (next < collapseThreshold) {
                        setSidebarCollapsed(true);
                        return prev;
                      }
                      return Math.max(120, Math.min(600, next));
                    });
                  }}
                />
              )}

              {/* Right panel — diff content, same style as projects-content */}
              <div className="projects-content">
                <WorktreeDiffViewer
                  key={`${selectedAgentId}-${selectedFile?.path ?? ""}-${diffKey}`}
                  channel={channel}
                  agentId={selectedAgentId!}
                  file={selectedFile?.path ?? null}
                  source={diffSource}
                  onRefresh={refreshFiles}
                  onOpenInProjects={selectedFile?.status !== "D" ? onOpenInProjects : undefined}
                />
              </div>
            </div>
          )}

          {/* Error banner */}
          {error && <div className="agent-dialog-error">{error}</div>}
        </div>

        {/* Bottom action bar */}
        {selectedAgent && (
          <div className="agent-buttons" style={{ borderTop: "1px solid hsl(var(--text) / 8%)", padding: "10px 20px" }}>
            <input
              type="text"
              className="agent-field-input"
              placeholder="Commit message..."
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCommit();
              }}
              disabled={isRunning || actionLoading}
              style={{ flex: 1, width: "auto", padding: "6px 10px", fontSize: 13 }}
            />
            {/* Combined Commit / Options button with dropdown */}
            <div className="worktree-commit-group" ref={moreMenuRef}>
              <button
                className="agent-action-btn agent-action-btn--accent"
                onClick={canCommit ? handleCommit : () => setShowMoreMenu((v) => !v)}
                disabled={actionLoading}
                style={{ borderRadius: "8px 0 0 8px", paddingRight: 12 }}
              >
                {actionLoading ? "..." : canCommit ? "Commit" : "Options"}
              </button>
              <button
                className="agent-action-btn agent-action-btn--accent"
                onClick={() => setShowMoreMenu((v) => !v)}
                disabled={actionLoading}
                style={{
                  borderRadius: "0 8px 8px 0",
                  padding: "8px 6px",
                  borderLeft: "1px solid rgba(255,255,255,0.2)",
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {showMoreMenu && (
                <div className="worktree-dropdown worktree-dropdown--up">
                  <button
                    onClick={() => {
                      setShowMoreMenu(false);
                      handleApply();
                    }}
                    disabled={isRunning || actionLoading}
                  >
                    Apply to main
                  </button>
                  <button
                    onClick={() => {
                      setShowMoreMenu(false);
                      postAction("app.worktree.push", {});
                    }}
                    disabled={actionLoading}
                  >
                    Push to remote
                  </button>
                  <button disabled>Merge from...</button>
                  <button
                    onClick={() => {
                      setShowMoreMenu(false);
                      postAction("app.worktree.stash", {});
                    }}
                    disabled={actionLoading}
                  >
                    Stash
                  </button>
                  <button
                    onClick={() => {
                      setShowMoreMenu(false);
                      postAction("app.worktree.stash_pop", {});
                    }}
                    disabled={actionLoading}
                  >
                    Stash Pop
                  </button>
                  {hasMergeConflict && (
                    <button
                      onClick={() => {
                        setShowMoreMenu(false);
                        postAction("app.worktree.abort", {});
                      }}
                      disabled={actionLoading}
                      className="worktree-dropdown-danger"
                    >
                      Abort Merge
                    </button>
                  )}
                </div>
              )}
            </div>

            {isRunning && <span style={{ fontSize: "11px", color: "#888", marginLeft: 8 }}>Agent is working</span>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
