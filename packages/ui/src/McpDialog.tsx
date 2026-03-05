import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const API_URL = "";

interface McpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
  oauth?: { client_id: string; scopes?: string[] };
  connected: boolean;
  tools: number;
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
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

/** Simplified MCP protocol icon (two nodes connected) */
export function McpIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 9h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2z" />
      <path d="M20 9h-3a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2z" />
      <path d="M9 12h6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export default function McpDialog({ channel, isOpen, onClose }: Props) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add form state
  const [newName, setNewName] = useState("");
  const [newTransport, setNewTransport] = useState<"stdio" | "http">("stdio");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newEnv, setNewEnv] = useState("");
  const [newOAuthClientId, setNewOAuthClientId] = useState("");
  const [newOAuthScopes, setNewOAuthScopes] = useState("");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);

  // Reset state on dialog close
  useEffect(() => {
    if (!isOpen) {
      setSelectedName(null);
      setShowAddForm(false);
      setError(null);
      setNewName("");
      setNewTransport("stdio");
      setNewCommand("");
      setNewArgs("");
      setNewUrl("");
      setNewEnv("");
      setNewOAuthClientId("");
      setNewOAuthScopes("");
    }
  }, [isOpen]);

  // Load servers when dialog opens
  useEffect(() => {
    if (!isOpen || !channel) return;
    loadServers();
    const interval = setInterval(loadServers, 5000);
    return () => clearInterval(interval);
  }, [isOpen, channel]);

  // Focus name input when add form shows
  useEffect(() => {
    if (showAddForm) setTimeout(() => nameInputRef.current?.focus(), 100);
  }, [showAddForm]);

  const loadServers = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/app.mcp.list?channel=${encodeURIComponent(channel)}`);
      const data = await res.json();
      if (data.ok) setServers(data.servers);
    } catch {}
  }, [channel]);

  const handleAdd = useCallback(async () => {
    if (!newName.trim()) {
      setError("Name is required");
      return;
    }
    if (newTransport === "stdio" && !newCommand.trim()) {
      setError("Command is required for stdio");
      return;
    }
    if (newTransport === "http" && !newUrl.trim()) {
      setError("URL is required for http");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // Parse env vars (KEY=VALUE per line)
      let env: Record<string, string> | undefined;
      if (newEnv.trim()) {
        env = {};
        for (const line of newEnv.split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
      }

      // Parse args (space-separated, respecting quotes)
      let args: string[] | undefined;
      if (newArgs.trim()) {
        args = newArgs.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, ""));
      }

      const body: any = {
        channel,
        name: newName.trim(),
        transport: newTransport,
      };
      if (newTransport === "stdio") {
        body.command = newCommand.trim();
        if (args) body.args = args;
        if (env) body.env = env;
      } else {
        body.url = newUrl.trim();
        if (newOAuthClientId.trim()) {
          body.oauth = {
            client_id: newOAuthClientId.trim(),
            scopes: newOAuthScopes.trim() ? newOAuthScopes.split(",").map((s) => s.trim()) : undefined,
          };
        }
      }

      const res = await fetch(`${API_URL}/api/app.mcp.add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Failed to add server");
        return;
      }

      // Success — reset form and reload
      setNewName("");
      setNewTransport("stdio");
      setNewCommand("");
      setNewArgs("");
      setNewUrl("");
      setNewEnv("");
      setNewOAuthClientId("");
      setNewOAuthScopes("");
      setShowAddForm(false);
      await loadServers();
      setSelectedName(newName.trim());
    } catch (e: any) {
      setError(e.message || "Network error");
    } finally {
      setSaving(false);
    }
  }, [
    channel,
    newName,
    newTransport,
    newCommand,
    newArgs,
    newUrl,
    newEnv,
    newOAuthClientId,
    newOAuthScopes,
    loadServers,
  ]);

  const handleRemove = useCallback(
    async (name: string) => {
      if (!confirm(`Remove MCP server "${name}"?`)) return;
      try {
        const res = await fetch(`${API_URL}/api/app.mcp.remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, name }),
        });
        const data = await res.json();
        if (!data.ok) {
          setError(data.error || "Failed to remove server");
          return;
        }
        setSelectedName(null);
        await loadServers();
      } catch (e: any) {
        setError(e.message || "Failed to remove server");
      }
    },
    [channel, loadServers],
  );

  const handleToggle = useCallback(
    async (name: string, enabled: boolean) => {
      setToggling(true);
      try {
        const res = await fetch(`${API_URL}/api/app.mcp.toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, name, enabled }),
        });
        const data = await res.json();
        if (!data.ok) setError(data.error || "Toggle failed");
        await loadServers();
      } catch {
        setError("Network error");
      } finally {
        setToggling(false);
      }
    },
    [channel, loadServers],
  );

  const selectedServer = servers.find((s) => s.name === selectedName);

  if (!isOpen) return null;

  return createPortal(
    <div className="stream-dialog-overlay" onClick={onClose}>
      <div className="stream-dialog agent-dialog mcp-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="stream-dialog-header">
          <div className="stream-dialog-title-row">
            <h3>MCP Servers</h3>
          </div>
          <button className="stream-dialog-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Server bar */}
        <div className="stream-agent-bar">
          {servers.map((server) => {
            const isActive = selectedName === server.name && !showAddForm;
            return (
              <button
                key={server.name}
                className={`stream-agent-avatar-btn ${isActive ? "active" : ""}`}
                onClick={() => {
                  setSelectedName(server.name);
                  setShowAddForm(false);
                  setError(null);
                }}
                title={`${server.name} (${server.transport})`}
              >
                <span className="stream-agent-avatar-wrap">
                  <span className={`mcp-server-icon ${server.connected ? "connected" : "disconnected"}`}>
                    <McpIcon size={20} />
                  </span>
                  {server.connected && <span className="stream-agent-avatar-dot" />}
                </span>
                <span className="stream-agent-avatar-name">{server.name}</span>
              </button>
            );
          })}
          <button
            className={`stream-agent-avatar-btn agent-add-btn ${showAddForm ? "active" : ""}`}
            onClick={() => {
              setShowAddForm(true);
              setSelectedName(null);
              setError(null);
            }}
            title="Add MCP server"
          >
            <span className="agent-add-icon">
              <PlusIcon />
            </span>
            <span className="stream-agent-avatar-name">Add</span>
          </button>
        </div>

        {/* Body */}
        <div className="agent-dialog-body">
          {error && <div className="mcp-error">{error}</div>}

          {/* Add form */}
          {showAddForm && (
            <div className="agent-add-form">
              <div className="agent-form-field">
                <label>Name</label>
                <input
                  ref={nameInputRef}
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. slack, notion"
                />
              </div>
              <div className="agent-form-field">
                <label>Type</label>
                <select
                  value={newTransport}
                  onChange={(e) => setNewTransport(e.target.value as any)}
                  className="mcp-type-select"
                >
                  <option value="stdio">stdio (local command)</option>
                  <option value="http">http (remote URL)</option>
                </select>
              </div>

              {newTransport === "stdio" && (
                <>
                  <div className="agent-form-field">
                    <label>Command</label>
                    <input
                      type="text"
                      value={newCommand}
                      onChange={(e) => setNewCommand(e.target.value)}
                      placeholder="e.g. npx, bunx, uvx"
                    />
                  </div>
                  <div className="agent-form-field">
                    <label>Arguments</label>
                    <input
                      type="text"
                      value={newArgs}
                      onChange={(e) => setNewArgs(e.target.value)}
                      placeholder="e.g. -y @notionhq/notion-mcp-server"
                    />
                  </div>
                </>
              )}

              {newTransport === "http" && (
                <>
                  <div className="agent-form-field">
                    <label>URL</label>
                    <input
                      type="text"
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                      placeholder="https://mcp.example.com/mcp"
                    />
                  </div>
                  <div className="agent-form-field">
                    <label>
                      OAuth Client ID <span className="mcp-optional">(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={newOAuthClientId}
                      onChange={(e) => setNewOAuthClientId(e.target.value)}
                      placeholder="Leave empty if no OAuth needed"
                    />
                  </div>
                  {newOAuthClientId && (
                    <div className="agent-form-field">
                      <label>
                        OAuth Scopes <span className="mcp-optional">(comma-separated)</span>
                      </label>
                      <input
                        type="text"
                        value={newOAuthScopes}
                        onChange={(e) => setNewOAuthScopes(e.target.value)}
                        placeholder="e.g. read,write"
                      />
                    </div>
                  )}
                </>
              )}

              <div className="agent-form-field">
                <label>
                  Environment Variables <span className="mcp-optional">(optional)</span>
                </label>
                <textarea
                  value={newEnv}
                  onChange={(e) => setNewEnv(e.target.value)}
                  placeholder={"KEY=value\nANOTHER=value"}
                  rows={3}
                  className="mcp-env-textarea"
                />
              </div>

              <div className="agent-form-actions">
                <button className="agent-btn agent-btn-primary" onClick={handleAdd} disabled={saving}>
                  {saving ? "Connecting..." : "Add & Connect"}
                </button>
                <button
                  className="agent-btn agent-btn-secondary"
                  onClick={() => {
                    setShowAddForm(false);
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Selected server detail */}
          {!showAddForm && selectedServer && (
            <div className="mcp-server-detail">
              <div className="mcp-detail-row">
                <span className="mcp-detail-label">Name</span>
                <span className="mcp-detail-value">{selectedServer.name}</span>
              </div>
              <div className="mcp-detail-row">
                <span className="mcp-detail-label">Type</span>
                <span className="mcp-detail-value">{selectedServer.transport}</span>
              </div>
              {selectedServer.command && (
                <div className="mcp-detail-row">
                  <span className="mcp-detail-label">Command</span>
                  <span className="mcp-detail-value mcp-mono">
                    {selectedServer.command} {selectedServer.args?.join(" ") || ""}
                  </span>
                </div>
              )}
              {selectedServer.url && (
                <div className="mcp-detail-row">
                  <span className="mcp-detail-label">URL</span>
                  <span className="mcp-detail-value mcp-mono">{selectedServer.url}</span>
                </div>
              )}
              <div className="mcp-detail-row">
                <span className="mcp-detail-label">Status</span>
                <span className={`mcp-status ${selectedServer.connected ? "connected" : "disconnected"}`}>
                  <span className="mcp-status-dot" />
                  {selectedServer.connected ? "Connected" : "Disconnected"}
                </span>
              </div>
              {selectedServer.connected && (
                <div className="mcp-detail-row">
                  <span className="mcp-detail-label">Tools</span>
                  <span className="mcp-detail-value">{selectedServer.tools}</span>
                </div>
              )}
              {selectedServer.oauth && (
                <div className="mcp-detail-row">
                  <span className="mcp-detail-label">OAuth</span>
                  <span className="mcp-detail-value mcp-mono">{selectedServer.oauth.client_id}</span>
                </div>
              )}

              <div className="mcp-server-actions">
                <button
                  className={`agent-btn ${selectedServer.enabled ? "agent-btn-secondary" : "agent-btn-primary"}`}
                  onClick={() => handleToggle(selectedServer.name, !selectedServer.enabled)}
                  disabled={toggling}
                >
                  {toggling ? "..." : selectedServer.enabled ? "Disconnect" : "Connect"}
                </button>
                <button
                  className="agent-btn agent-btn-danger"
                  onClick={() => handleRemove(selectedServer.name)}
                  title="Remove server"
                >
                  <TrashIcon /> Remove
                </button>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!showAddForm && !selectedServer && servers.length === 0 && (
            <div className="mcp-empty">
              <McpIcon size={32} />
              <p>No MCP servers configured for this channel.</p>
              <button className="agent-btn agent-btn-primary" onClick={() => setShowAddForm(true)}>
                Add MCP Server
              </button>
            </div>
          )}

          {/* No selection but has servers */}
          {!showAddForm && !selectedServer && servers.length > 0 && (
            <div className="mcp-empty">
              <p>Select a server to view details.</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
