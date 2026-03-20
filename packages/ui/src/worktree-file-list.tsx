// File list sidebar for WorktreeDialog — uses projects-tree styles for consistency

export interface FileStatus {
  path: string;
  status: "M" | "A" | "D" | "R" | "?" | "U";
  staged: boolean;
}

export function statusColor(status: string): string {
  switch (status) {
    case "A":
      return "#4ec94e";
    case "M":
      return "#e5a550";
    case "D":
      return "#e55050";
    case "R":
      return "#a855f7";
    case "U":
      return "#eab308";
    default:
      return "#888";
  }
}

function FileIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14,2 14,8 20,8" />
    </svg>
  );
}

interface FileRowProps {
  file: FileStatus;
  selected: boolean;
  onSelect: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  actionLoading: boolean;
}

function FileRow({ file, selected, onSelect, onStage, onUnstage, onDiscard, actionLoading }: FileRowProps) {
  const name = file.path.split("/").pop() || file.path;
  return (
    <div className="projects-tree-node">
      <div
        className={`projects-tree-item ${selected ? "selected" : ""}`}
        style={{ paddingLeft: "8px" }}
        onClick={onSelect}
        title={file.path}
      >
        <span className="projects-tree-icon">
          <FileIcon color={statusColor(file.status)} />
        </span>
        <span className="projects-tree-name" style={{ color: statusColor(file.status) }}>
          {name}
        </span>
        <span className="worktree-file-actions">
          {onStage && (
            <button
              className="worktree-file-btn"
              onClick={(e) => {
                e.stopPropagation();
                onStage();
              }}
              disabled={actionLoading}
              title="Stage"
            >
              +
            </button>
          )}
          {onUnstage && (
            <button
              className="worktree-file-btn"
              onClick={(e) => {
                e.stopPropagation();
                onUnstage();
              }}
              disabled={actionLoading}
              title="Unstage"
            >
              −
            </button>
          )}
          {onDiscard && (
            <button
              className="worktree-file-btn worktree-file-btn--danger"
              onClick={(e) => {
                e.stopPropagation();
                onDiscard();
              }}
              disabled={actionLoading}
              title="Discard"
            >
              ↩
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

interface FileSidebarProps {
  files: FileStatus[];
  selectedFile: FileStatus | null;
  onSelectFile: (f: FileStatus) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onDiscard: (path: string) => void;
  onStageAll: () => void;
  onResolve: (path: string, resolution: "ours" | "theirs" | "both") => void;
  actionLoading: boolean;
  hasMergeConflict: boolean;
}

export function WorktreeFileSidebar({
  files,
  selectedFile,
  onSelectFile,
  onStage,
  onUnstage,
  onDiscard,
  onStageAll,
  onResolve,
  actionLoading,
  hasMergeConflict,
}: FileSidebarProps) {
  const unstagedFiles = files.filter((f) => !f.staged && f.status !== "U");
  const stagedFiles = files.filter((f) => f.staged);
  const conflictFiles = files.filter((f) => f.status === "U");

  return (
    <>
      {/* CHANGES section */}
      <div className="worktree-section-header">
        <span>CHANGES ({unstagedFiles.length})</span>
        {unstagedFiles.length > 0 && (
          <button className="worktree-section-btn" onClick={onStageAll} disabled={actionLoading} title="Stage all">
            +
          </button>
        )}
      </div>
      {unstagedFiles.length === 0 && (
        <div className="projects-empty" style={{ padding: "4px 8px", fontSize: 11 }}>
          No unstaged changes
        </div>
      )}
      {unstagedFiles.map((f) => (
        <FileRow
          key={`u-${f.path}`}
          file={f}
          selected={selectedFile?.path === f.path && !selectedFile?.staged}
          onSelect={() => onSelectFile(f)}
          onStage={() => onStage(f.path)}
          onDiscard={() => onDiscard(f.path)}
          actionLoading={actionLoading}
        />
      ))}

      {/* STAGED section */}
      <div className="worktree-section-header" style={{ marginTop: 8 }}>
        <span>STAGED ({stagedFiles.length})</span>
      </div>
      {stagedFiles.length === 0 && (
        <div className="projects-empty" style={{ padding: "4px 8px", fontSize: 11 }}>
          Nothing staged
        </div>
      )}
      {stagedFiles.map((f) => (
        <FileRow
          key={`s-${f.path}`}
          file={f}
          selected={selectedFile?.path === f.path && selectedFile?.staged}
          onSelect={() => onSelectFile(f)}
          onUnstage={() => onUnstage(f.path)}
          actionLoading={actionLoading}
        />
      ))}

      {/* CONFLICTS section */}
      {hasMergeConflict && conflictFiles.length > 0 && (
        <>
          <div className="worktree-section-header" style={{ color: "#eab308", marginTop: 8 }}>
            CONFLICTS ({conflictFiles.length})
          </div>
          {conflictFiles.map((f) => (
            <div key={f.path} className="worktree-conflict-row">
              <span className="projects-tree-name" title={f.path} style={{ flex: 1, fontSize: 12, color: "#eab308" }}>
                {f.path.split("/").pop()}
              </span>
              <div className="worktree-conflict-actions">
                <button onClick={() => onResolve(f.path, "ours")} disabled={actionLoading}>
                  Ours
                </button>
                <button onClick={() => onResolve(f.path, "theirs")} disabled={actionLoading}>
                  Theirs
                </button>
                <button onClick={() => onResolve(f.path, "both")} disabled={actionLoading}>
                  Both
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
