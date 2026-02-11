import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ClawdAvatar } from "./MessageList";

const API_URL = "";

interface Agent {
  channel: string;
  agent_id: string;
  model: string;
  project: string;
  active: boolean;
  running: boolean;
  avatar_color: string | null;
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
  onToggle,
  onSelect,
  selectedPath,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  selectedPath: string | null;
}) {
  const isExpanded = expanded.has(node.path);
  const isSelected = selectedPath === node.path;
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
            <ChevronIcon expanded={isExpanded} />
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

export default function ProjectsDialog({ channel, isOpen, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string>("");

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

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/app.agents.list?channel=${encodeURIComponent(channel)}`);
      const data = await res.json();
      if (data.ok) {
        // Only show agents with a project configured
        const agentsWithProjects = data.agents.filter((a: Agent) => a.project);
        setAgents(agentsWithProjects);
        // Auto-select first agent with project
        if (agentsWithProjects.length > 0 && !selectedAgentId) {
          setSelectedAgentId(agentsWithProjects[0].agent_id);
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
        const res = await fetch(
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
        const res = await fetch(
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

  const handleToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

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
              <div className="projects-sidebar">
                {projectRoot && (
                  <div className="projects-root-path" title={projectRoot}>
                    {projectRoot.split("/").pop() || projectRoot}
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
                      onToggle={handleToggle}
                      onSelect={handleSelect}
                      selectedPath={selectedFile?.path || null}
                    />
                  ))}
                </div>
              </div>

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
                    <pre className="projects-file-content">
                      <code className={`language-${selectedFile.language}`}>{selectedFile.content}</code>
                    </pre>
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
