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

/** MCP protocol icon */
export function McpIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M3.49994 11.7501L11.6717 3.57855C12.7762 2.47398 14.5672 2.47398 15.6717 3.57855C16.7762 4.68312 16.7762 6.47398 15.6717 7.57855M15.6717 7.57855L9.49994 13.7501M15.6717 7.57855C16.7762 6.47398 18.5672 6.47398 19.6717 7.57855C20.7762 8.68312 20.7762 10.474 19.6717 11.5785L12.7072 18.543C12.3167 18.9335 12.3167 19.5667 12.7072 19.9572L13.9999 21.2499"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17.4999 9.74921L11.3282 15.921C10.2237 17.0255 8.43272 17.0255 7.32823 15.921C6.22373 14.8164 6.22373 13.0255 7.32823 11.921L13.4999 5.74939"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
  const [newTransport, setNewTransport] = useState("stdio");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newEnv, setNewEnv] = useState("");
  const [newOAuthClientId, setNewOAuthClientId] = useState("");
  const [newOAuthClientSecret, setNewOAuthClientSecret] = useState("");
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
      setNewOAuthClientSecret("");
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
    const effectiveTransport = newTransport.trim().toLowerCase() === "http" ? "http" : "stdio";
    if (effectiveTransport === "stdio" && !newCommand.trim()) {
      setError("Command is required for stdio");
      return;
    }
    if (effectiveTransport === "http" && !newUrl.trim()) {
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
        // Parse env vars (KEY=val pairs, space or newline separated)
        for (const pair of newEnv.split(/[\s]+/)) {
          const eq = pair.indexOf("=");
          if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
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
        transport: effectiveTransport,
      };
      if (effectiveTransport === "stdio") {
        body.command = newCommand.trim();
        if (args) body.args = args;
        if (env) body.env = env;
      } else {
        body.url = newUrl.trim();
        if (newOAuthClientId.trim()) {
          body.oauth = {
            client_id: newOAuthClientId.trim(),
            client_secret: newOAuthClientSecret.trim() || undefined,
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

      // OAuth auto-discovery: server needs authentication
      if (data.needs_oauth && data.auth_url) {
        window.open(data.auth_url, "_blank");
        setError(null);
        // Reset form state
        const savedName = newName.trim();
        setNewName("");
        setNewTransport("stdio");
        setNewCommand("");
        setNewArgs("");
        setNewUrl("");
        setNewEnv("");
        setNewOAuthClientId("");
        setNewOAuthClientSecret("");
        setNewOAuthScopes("");
        setShowAddForm(false);
        await loadServers();
        setSelectedName(savedName);
        return;
      }

      // Discovery succeeded but needs manual client_id — keep form open
      if (data.needs_client_id) {
        setError(data.error || "Please provide your OAuth Client ID.");
        return;
      }

      if (!data.ok) {
        setError(data.error || "Failed to add server");
        return;
      }

      // Success — reset form and reload
      const savedName = newName.trim();
      setNewName("");
      setNewTransport("stdio");
      setNewCommand("");
      setNewArgs("");
      setNewUrl("");
      setNewEnv("");
      setNewOAuthClientId("");
      setNewOAuthClientSecret("");
      setNewOAuthScopes("");
      setShowAddForm(false);
      await loadServers();
      setSelectedName(savedName);
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
    newOAuthClientSecret,
    newOAuthScopes,
    loadServers,
  ]);

  const handleRemove = useCallback(
    async (name: string) => {
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
            <div className="agent-fields">
              <input
                ref={nameInputRef}
                type="text"
                className="agent-field-input"
                placeholder="Name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                  if (e.key === "Escape") {
                    setShowAddForm(false);
                    setError(null);
                  }
                }}
              />
              <input
                type="text"
                className="agent-field-input"
                placeholder="Type (stdio/http)"
                value={newTransport}
                onChange={(e) => setNewTransport(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                  if (e.key === "Escape") {
                    setShowAddForm(false);
                    setError(null);
                  }
                }}
              />

              {newTransport.trim().toLowerCase() !== "http" && (
                <>
                  <input
                    type="text"
                    className="agent-field-input"
                    placeholder="Command (e.g. npx, bunx, uvx)"
                    value={newCommand}
                    onChange={(e) => setNewCommand(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAdd();
                    }}
                  />
                  <input
                    type="text"
                    className="agent-field-input"
                    placeholder="Arguments (e.g. -y @notionhq/notion-mcp-server)"
                    value={newArgs}
                    onChange={(e) => setNewArgs(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAdd();
                    }}
                  />
                </>
              )}

              {newTransport.trim().toLowerCase() === "http" && (
                <>
                  <input
                    type="text"
                    className="agent-field-input"
                    placeholder="URL (e.g. https://mcp.slack.com/mcp)"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAdd();
                    }}
                  />
                  <input
                    type="text"
                    className="agent-field-input"
                    placeholder="OAuth Client ID (optional)"
                    value={newOAuthClientId}
                    onChange={(e) => setNewOAuthClientId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAdd();
                    }}
                  />
                  {newOAuthClientId && (
                    <>
                      <input
                        type="password"
                        className="agent-field-input"
                        placeholder="OAuth Client Secret (optional)"
                        value={newOAuthClientSecret}
                        onChange={(e) => setNewOAuthClientSecret(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAdd();
                        }}
                      />
                      <input
                        type="text"
                        className="agent-field-input"
                        placeholder="OAuth Scopes (comma-separated, optional)"
                        value={newOAuthScopes}
                        onChange={(e) => setNewOAuthScopes(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAdd();
                        }}
                      />
                    </>
                  )}
                </>
              )}

              <input
                type="text"
                className="agent-field-input"
                placeholder="Environment (KEY=val KEY2=val2, optional)"
                value={newEnv}
                onChange={(e) => setNewEnv(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                }}
              />

              <button
                className="agent-action-btn agent-action-btn--accent"
                onClick={handleAdd}
                disabled={!newName.trim() || saving}
              >
                {saving ? "Connecting..." : "Add & Connect"}
              </button>
            </div>
          )}

          {/* Selected server detail */}
          {!showAddForm && selectedServer && (
            <div className="agent-fields">
              <input
                type="text"
                className="agent-field-input"
                placeholder="Name"
                value={selectedServer.name}
                readOnly
              />
              <input
                type="text"
                className="agent-field-input"
                placeholder="Type"
                value={selectedServer.transport}
                readOnly
              />
              {selectedServer.command && (
                <input
                  type="text"
                  className="agent-field-input"
                  placeholder="Command"
                  value={`${selectedServer.command} ${selectedServer.args?.join(" ") || ""}`}
                  readOnly
                />
              )}
              {selectedServer.url && (
                <input
                  type="text"
                  className="agent-field-input"
                  placeholder="URL"
                  value={selectedServer.url}
                  readOnly
                />
              )}
              <input
                type="text"
                className="agent-field-input"
                placeholder="Status"
                value={selectedServer.connected ? `Connected (${selectedServer.tools} tools)` : "Disconnected"}
                readOnly
              />
              {selectedServer.oauth && (
                <input
                  type="text"
                  className="agent-field-input"
                  placeholder="OAuth"
                  value={selectedServer.oauth.client_id}
                  readOnly
                />
              )}
              <div className="agent-buttons">
                <button
                  className={`agent-action-btn ${selectedServer.enabled ? "agent-action-btn--warning" : "agent-action-btn--accent"}`}
                  onClick={() => handleToggle(selectedServer.name, !selectedServer.enabled)}
                  disabled={toggling}
                >
                  {toggling ? "..." : selectedServer.enabled ? "Disconnect" : "Connect"}
                </button>
                <button
                  className="agent-action-btn agent-action-btn--danger"
                  onClick={() => handleRemove(selectedServer.name)}
                >
                  Remove
                </button>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!showAddForm && !selectedServer && servers.length === 0 && (
            <div className="mcp-empty">
              <McpIcon size={32} />
              <p>No MCP servers configured for this channel.</p>
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
