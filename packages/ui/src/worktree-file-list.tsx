// File tree sidebar for WorktreeDialog — renders folder structure like ProjectsDialog

import { useState } from "react";

export interface FileStatus {
  path: string;
  status: "M" | "A" | "D" | "R" | "?" | "U";
  staged: boolean;
}

export function statusColor(status: string): string {
  switch (status) {
    case "A":
    case "?":
      return "#4ec94e"; // green — new/untracked files
    case "M":
      return "#e5a550"; // yellow — modified
    case "D":
      return "#e55050"; // red — deleted
    case "R":
      return "#a855f7"; // purple — renamed
    case "U":
      return "#eab308"; // amber — conflict
    default:
      return "#888";
  }
}

// ============================================================================
// Icons (same as ProjectsDialog)
// ============================================================================

function FolderIcon({ open }: { open?: boolean }) {
  if (open) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 19a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h9a2 2 0 0 1 2 2v1M5 19h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2z" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14,2 14,8 20,8" />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s ease" }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// ============================================================================
// Tree building: flat file paths → nested tree
// ============================================================================

interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  file?: FileStatus;
  children: TreeNode[];
}

function buildTree(files: FileStatus[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isFile = i === parts.length - 1;
      const nodePath = parts.slice(0, i + 1).join("/");

      let existing = current.find((n) => n.name === name);
      if (!existing) {
        existing = {
          name,
          path: nodePath,
          type: isFile ? "file" : "dir",
          file: isFile ? file : undefined,
          children: [],
        };
        current.push(existing);
      }
      current = existing.children;
    }
  }

  // Sort: dirs first, then files, alphabetically within each
  const sortTree = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sortTree(n.children);
  };
  sortTree(root);
  return root;
}

// ============================================================================
// Tree Node Renderer
// ============================================================================

/** Collect all file paths under a tree node (recursive) */
function collectFilePaths(node: TreeNode): string[] {
  if (node.type === "file" && node.file) return [node.file.path];
  return node.children.flatMap(collectFilePaths);
}

function TreeItem({
  node,
  depth,
  expanded,
  onToggle,
  selectedFile,
  onSelectFile,
  onStage,
  onUnstage,
  onDiscard,
  actionLoading,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selectedFile: FileStatus | null;
  onSelectFile: (f: FileStatus) => void;
  onStage?: (paths: string | string[]) => void;
  onUnstage?: (paths: string | string[]) => void;
  onDiscard?: (paths: string | string[]) => void;
  actionLoading: boolean;
}) {
  const isDir = node.type === "dir";
  const isExpanded = expanded.has(node.path);
  const isSelected = !isDir && selectedFile?.path === node.file?.path && selectedFile?.staged === node.file?.staged;

  return (
    <div className="projects-tree-node">
      <div
        className={`projects-tree-item ${isSelected ? "selected" : ""}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (isDir) {
            onToggle(node.path);
          } else if (node.file) {
            onSelectFile(node.file);
          }
        }}
        title={node.path}
      >
        {isDir && (
          <span className="projects-tree-chevron">
            <ChevronIcon expanded={isExpanded} />
          </span>
        )}
        <span className="projects-tree-icon">
          {isDir ? <FolderIcon open={isExpanded} /> : <FileIcon color={statusColor(node.file?.status || "M")} />}
        </span>
        <span
          className="projects-tree-name"
          style={!isDir ? { color: statusColor(node.file?.status || "M") } : undefined}
        >
          {node.name}
        </span>
        {/* Action buttons (hover) — works on files AND folders */}
        {((!isDir && node.file) || (isDir && node.children.length > 0)) && (
          <span className="worktree-file-actions">
            {onStage && (
              <button
                className="worktree-file-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onStage(isDir ? collectFilePaths(node) : node.file!.path);
                }}
                disabled={actionLoading}
                title={isDir ? "Stage all in folder" : "Stage"}
              >
                +
              </button>
            )}
            {onUnstage && (
              <button
                className="worktree-file-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnstage(isDir ? collectFilePaths(node) : node.file!.path);
                }}
                disabled={actionLoading}
                title={isDir ? "Unstage all in folder" : "Unstage"}
              >
                −
              </button>
            )}
            {onDiscard && (
              <button
                className="worktree-file-btn worktree-file-btn--danger"
                onClick={(e) => {
                  e.stopPropagation();
                  onDiscard(isDir ? collectFilePaths(node) : node.file!.path);
                }}
                disabled={actionLoading}
                title={isDir ? "Discard all in folder" : "Discard"}
              >
                ↩
              </button>
            )}
          </span>
        )}
      </div>
      {isDir && isExpanded && (
        <div className="projects-tree-children">
          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
              actionLoading={actionLoading}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// File Tree Section (CHANGES / STAGED / CONFLICTS)
// ============================================================================

function FileTreeSection({
  files,
  selectedFile,
  onSelectFile,
  onStage,
  onUnstage,
  onDiscard,
  actionLoading,
}: {
  files: FileStatus[];
  selectedFile: FileStatus | null;
  onSelectFile: (f: FileStatus) => void;
  onStage?: (paths: string | string[]) => void;
  onUnstage?: (paths: string | string[]) => void;
  onDiscard?: (paths: string | string[]) => void;
  actionLoading: boolean;
}) {
  // All dirs expanded by default
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    }
    return dirs;
  });

  const tree = buildTree(files);

  const handleToggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <>
      {tree.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          onToggle={handleToggle}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          onStage={onStage}
          onUnstage={onUnstage}
          onDiscard={onDiscard}
          actionLoading={actionLoading}
        />
      ))}
    </>
  );
}

// ============================================================================
// Main Sidebar Component
// ============================================================================

interface FileSidebarProps {
  files: FileStatus[];
  selectedFile: FileStatus | null;
  onSelectFile: (f: FileStatus) => void;
  onStage: (paths: string | string[]) => void;
  onUnstage: (paths: string | string[]) => void;
  onDiscard: (paths: string | string[]) => void;
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
      {unstagedFiles.length > 0 && (
        <FileTreeSection
          files={unstagedFiles}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          onStage={onStage}
          onDiscard={onDiscard}
          actionLoading={actionLoading}
        />
      )}

      {/* STAGED section */}
      <div className="worktree-section-header" style={{ marginTop: 8 }}>
        <span>STAGED ({stagedFiles.length})</span>
      </div>
      {stagedFiles.length === 0 && (
        <div className="projects-empty" style={{ padding: "4px 8px", fontSize: 11 }}>
          Nothing staged
        </div>
      )}
      {stagedFiles.length > 0 && (
        <FileTreeSection
          files={stagedFiles}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          onUnstage={onUnstage}
          actionLoading={actionLoading}
        />
      )}

      {/* CONFLICTS section */}
      {hasMergeConflict && conflictFiles.length > 0 && (
        <>
          <div className="worktree-section-header" style={{ color: "#eab308", marginTop: 8 }}>
            CONFLICTS ({conflictFiles.length})
          </div>
          {conflictFiles.map((f) => (
            <div key={f.path} className="worktree-conflict-row">
              <span className="projects-tree-name" title={f.path} style={{ flex: 1, fontSize: 12, color: "#eab308" }}>
                {f.path}
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
