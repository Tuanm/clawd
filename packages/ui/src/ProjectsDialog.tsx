import Prism from "prismjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";
import { ClawdAvatar } from "./MessageList";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-css";
import "prismjs/components/prism-python";
import "prismjs/components/prism-yaml";
import "prismjs/themes/prism-tomorrow.css";

const API_URL = "";

// Highlight a single line of code using Prism
function highlightCode(line: string, language: string): string {
  const grammar = Prism.languages[language];
  if (!grammar) {
    // No grammar available, escape HTML and return
    return line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  return Prism.highlight(line, grammar, language);
}

interface Agent {
  channel: string;
  agent_id: string;
  model: string;
  project: string;
  active: boolean;
  running: boolean;
  avatar_color: string | null;
  worktree_branch?: string | null;
}

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

interface TreeNode {
  name: string;
  type: "file" | "dir";
  path: string;
  size?: number;
  children?: TreeNode[];
}

interface FileContent {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  language: string;
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
  /** Pre-select this agent when dialog opens */
  initialAgentId?: string | null;
  /** Auto-open this file path when dialog opens */
  initialFile?: string | null;
  /** Scroll to this line number when auto-opening a file */
  initialLine?: number | null;
}

// Icons
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

function FileIcon({ ext }: { ext: string }) {
  // TypeScript/JavaScript
  if (["ts", "tsx", "js", "jsx"].includes(ext)) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3178c6" strokeWidth="2">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14,2 14,8 20,8" />
      </svg>
    );
  }
  // JSON
  if (ext === "json") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f5a623" strokeWidth="2">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14,2 14,8 20,8" />
      </svg>
    );
  }
  // Markdown
  if (["md", "mdx"].includes(ext)) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#519aba" strokeWidth="2">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14,2 14,8 20,8" />
      </svg>
    );
  }
  // Default file
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
      style={{
        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s ease",
      }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// Tree node component
function TreeNodeItem({
  node,
  depth,
  expanded,
  loadingDirs,
  onToggle,
  onSelect,
  selectedPath,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  loadingDirs: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  selectedPath: string | null;
}) {
  const isExpanded = expanded.has(node.path);
  const isSelected = selectedPath === node.path;
  const isLoading = loadingDirs.has(node.path);
  const ext = node.name.split(".").pop()?.toLowerCase() || "";

  return (
    <div className="projects-tree-node">
      <div
        className={`projects-tree-item ${isSelected ? "selected" : ""}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (node.type === "dir") {
            onToggle(node.path);
          } else {
            onSelect(node.path);
          }
        }}
      >
        {node.type === "dir" && (
          <span className="projects-tree-chevron">
            {isLoading ? <span className="projects-tree-spinner" /> : <ChevronIcon expanded={isExpanded} />}
          </span>
        )}
        <span className="projects-tree-icon">
          {node.type === "dir" ? <FolderIcon open={isExpanded} /> : <FileIcon ext={ext} />}
        </span>
        <span className="projects-tree-name">{node.name}</span>
        {node.type === "file" && node.size !== undefined && (
          <span className="projects-tree-size">{formatSize(node.size)}</span>
        )}
      </div>
      {node.type === "dir" && isExpanded && node.children && (
        <div className="projects-tree-children">
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              loadingDirs={loadingDirs}
              onToggle={onToggle}
              onSelect={onSelect}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default function ProjectsDialog({ channel, isOpen, onClose, initialAgentId, initialFile, initialLine }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string>("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarSize, setSidebarSize] = useState(280);
  const contentRef = useRef<HTMLDivElement>(null);

  // Load agents when dialog opens
  useEffect(() => {
    if (!isOpen || !channel) return;
    loadAgents();
  }, [isOpen, channel]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedAgentId(null);
      setTree([]);
      setExpanded(new Set());
      setLoadingDirs(new Set());
      setSelectedFile(null);
      setError(null);
      setProjectRoot("");
    }
  }, [isOpen]);

  // Load tree when agent is selected
  useEffect(() => {
    if (selectedAgentId) {
      loadProjectTree(selectedAgentId);
    }
  }, [selectedAgentId]);

  // Auto-open initial file when tree is loaded
  const initialFileRef = useRef(initialFile);
  const initialLineRef = useRef(initialLine);
  initialFileRef.current = initialFile;
  initialLineRef.current = initialLine;
  useEffect(() => {
    if (tree.length > 0 && initialFileRef.current && !selectedFile) {
      loadFileContent(initialFileRef.current);
      initialFileRef.current = null;
    }
  }, [tree]);

  // Scroll to initial line after file content loads
  useEffect(() => {
    if (selectedFile && initialLineRef.current && contentRef.current) {
      const line = initialLineRef.current;
      initialLineRef.current = null;
      // Wait for DOM render
      requestAnimationFrame(() => {
        const row = contentRef.current?.querySelector(`tr[data-line="${line}"]`);
        if (row) {
          row.scrollIntoView({ block: "center", behavior: "smooth" });
          (row as HTMLElement).style.background = "hsl(var(--accent) / 0.2)";
          setTimeout(() => {
            (row as HTMLElement).style.background = "";
          }, 2000);
        }
      });
    }
  }, [selectedFile]);

  const loadAgents = useCallback(async () => {
    try {
      const res = await authFetch(`${API_URL}/api/app.agents.list?channel=${encodeURIComponent(channel)}`);
      const data = await res.json();
      if (data.ok) {
        // Only show agents with a project configured
        const agentsWithProjects = data.agents.filter((a: Agent) => a.project);
        setAgents(agentsWithProjects);
        // Auto-select agent: prefer initialAgentId, then first agent
        if (agentsWithProjects.length > 0 && !selectedAgentId) {
          if (initialAgentId && agentsWithProjects.find((a: Agent) => a.agent_id === initialAgentId)) {
            setSelectedAgentId(initialAgentId);
          } else {
            setSelectedAgentId(agentsWithProjects[0].agent_id);
          }
        }
      }
    } catch {
      // silent
    }
  }, [channel, selectedAgentId]);

  const loadProjectTree = useCallback(
    async (agentId: string) => {
      setLoading(true);
      setError(null);
      setTree([]);
      setSelectedFile(null);
      setExpanded(new Set());

      try {
        const res = await authFetch(
          `${API_URL}/api/app.project.tree?channel=${encodeURIComponent(channel)}&agent_id=${encodeURIComponent(agentId)}`,
        );
        const data = await res.json();
        if (data.ok) {
          setTree(data.tree);
          setProjectRoot(data.root);
        } else {
          setError(data.error || "Failed to load project tree");
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [channel],
  );

  const loadFileContent = useCallback(
    async (path: string) => {
      if (!selectedAgentId) return;

      setFileLoading(true);
      try {
        const res = await authFetch(
          `${API_URL}/api/app.project.readFile?channel=${encodeURIComponent(channel)}&agent_id=${encodeURIComponent(selectedAgentId)}&path=${encodeURIComponent(path)}`,
        );
        const data = await res.json();
        if (data.ok) {
          setSelectedFile({
            path: data.path,
            content: data.content,
            size: data.size,
            truncated: data.truncated,
            language: data.language,
          });
        } else {
          setSelectedFile(null);
          setError(data.error || "Failed to load file");
        }
      } catch (err) {
        setSelectedFile(null);
        setError(String(err));
      } finally {
        setFileLoading(false);
      }
    },
    [channel, selectedAgentId],
  );

  // Helper to update tree nodes with lazy-loaded children
  const updateTreeNode = useCallback((nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] => {
    return nodes.map((node) => {
      if (node.path === path) {
        return { ...node, children };
      }
      if (node.children && path.startsWith(node.path + "/")) {
        return { ...node, children: updateTreeNode(node.children, path, children) };
      }
      return node;
    });
  }, []);

  // Find a node by path
  const findNode = useCallback((nodes: TreeNode[], path: string): TreeNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.children) {
        const found = findNode(node.children, path);
        if (found) return found;
      }
    }
    return null;
  }, []);

  // Load directory contents lazily
  const loadDirectory = useCallback(
    async (dirPath: string) => {
      if (!selectedAgentId) return;

      setLoadingDirs((prev) => new Set(prev).add(dirPath));

      try {
        const res = await authFetch(
          `${API_URL}/api/app.project.listDir?channel=${encodeURIComponent(channel)}&agent_id=${encodeURIComponent(selectedAgentId)}&path=${encodeURIComponent(dirPath)}`,
        );
        const data = await res.json();
        if (data.ok) {
          setTree((prev) => updateTreeNode(prev, dirPath, data.entries));
        }
      } catch {
        // Silent fail
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [channel, selectedAgentId, updateTreeNode],
  );

  const handleToggle = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          // Check if we need to lazy load
          const node = findNode(tree, path);
          if (node && node.type === "dir" && node.children === undefined) {
            loadDirectory(path);
          }
        }
        return next;
      });
    },
    [findNode, loadDirectory, tree],
  );

  const handleSelect = useCallback(
    (path: string) => {
      loadFileContent(path);
    },
    [loadFileContent],
  );

  // Handle keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="stream-dialog-overlay" onClick={onClose}>
      <div className="stream-dialog projects-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            <h3>Projects</h3>
            <button
              className="worktree-refresh-btn"
              onClick={() => {
                if (selectedAgentId) loadProjectTree(selectedAgentId);
              }}
              title="Refresh"
              disabled={loading}
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
                  setSelectedFile(null);
                }}
                title={`${agent.agent_id}\n${agent.project}`}
              >
                <span className="stream-agent-avatar-wrap">
                  <ClawdAvatar color={color} standing={agent.running} />
                  {agent.running && <span className="stream-agent-avatar-dot" />}
                </span>
                <span className="stream-agent-avatar-name">{agent.agent_id}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="projects-dialog-body">
          {/* No agents message */}
          {agents.length === 0 && (
            <div className="stream-dialog-placeholder">
              No agents with projects configured. Add an agent with a project path to browse files.
            </div>
          )}

          {/* Main content area */}
          {agents.length > 0 && (
            <div className="projects-main">
              {/* Left sidebar - file tree */}
              {(() => {
                const rootLabel = projectRoot;
                const isMobile = window.innerWidth <= 600;
                return (
                  <div
                    className={`projects-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}
                    style={
                      sidebarCollapsed
                        ? undefined
                        : { width: isMobile ? undefined : sidebarSize, height: isMobile ? sidebarSize : undefined }
                    }
                  >
                    {projectRoot && (
                      <div
                        className="projects-root-path"
                        title={projectRoot}
                        onClick={sidebarCollapsed ? () => setSidebarCollapsed(false) : undefined}
                      >
                        <span className="projects-root-name">{rootLabel}</span>
                        <button
                          className="projects-sidebar-toggle"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSidebarCollapsed((v) => !v);
                          }}
                          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <polyline points="15 18 9 12 15 6" />
                          </svg>
                        </button>
                      </div>
                    )}
                    {loading && <div className="projects-loading">Loading...</div>}
                    {error && <div className="projects-error">{error}</div>}
                    {!loading && !error && tree.length === 0 && selectedAgentId && (
                      <div className="projects-empty">No files found</div>
                    )}
                    <div className="projects-tree">
                      {tree.map((node) => (
                        <TreeNodeItem
                          key={node.path}
                          node={node}
                          depth={0}
                          expanded={expanded}
                          loadingDirs={loadingDirs}
                          onToggle={handleToggle}
                          onSelect={handleSelect}
                          selectedPath={selectedFile?.path || null}
                        />
                      ))}
                    </div>
                  </div>
                );
              })()}

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

              {/* Right panel - file content */}
              <div className="projects-content">
                {fileLoading && <div className="projects-content-loading">Loading file...</div>}
                {!fileLoading && !selectedFile && (
                  <div className="projects-content-empty">Select a file to view its content</div>
                )}
                {!fileLoading && selectedFile && (
                  <>
                    <div className="projects-file-header">
                      <span className="projects-file-path">{selectedFile.path}</span>
                      <span className="projects-file-meta">
                        {formatSize(selectedFile.size)}
                        {selectedFile.truncated && " (truncated)"}
                      </span>
                    </div>
                    <div className="projects-file-content" ref={contentRef}>
                      <table className="code-lines">
                        <tbody>
                          {selectedFile.content.split("\n").map((line, i) => (
                            <tr key={i} className="code-line" data-line={i + 1}>
                              <td className="line-number">{i + 1}</td>
                              <td
                                className="line-content"
                                dangerouslySetInnerHTML={{
                                  __html: highlightCode(line, selectedFile.language),
                                }}
                              />
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
