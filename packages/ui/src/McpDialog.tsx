import DOMPurify from "dompurify";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";

const API_URL = "";

interface McpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  logo?: string;
  oauth?: { client_id: string; scopes?: string[] };
  connected: boolean;
  tools: number;
}

interface Props {
  channel: string;
  isOpen: boolean;
  onClose: () => void;
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

/** Render a server logo: URL, base64, SVG code, or fallback to McpIcon */
function ServerLogo({ logo, size = 20 }: { logo?: string; size?: number }) {
  if (!logo) return <McpIcon size={size} />;
  // SVG code (starts with < or <svg)
  if (logo.trimStart().startsWith("<")) {
    const clean = DOMPurify.sanitize(logo, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: [],
      ADD_ATTR: [],
    });
    return (
      <span dangerouslySetInnerHTML={{ __html: clean }} style={{ width: size, height: size, display: "inline-flex" }} />
    );
  }
  // URL or base64
  return <img src={logo} alt="" width={size} height={size} style={{ borderRadius: 4, objectFit: "contain" }} />;
}

export default function McpDialog({ channel, isOpen, onClose }: Props) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Reset state on dialog close
  useEffect(() => {
    if (!isOpen) {
      setSelectedName(null);
      setError(null);
    }
  }, [isOpen]);

  // Load servers when dialog opens
  useEffect(() => {
    if (!isOpen || !channel) return;
    loadServers();
    const interval = setInterval(loadServers, 5000);
    return () => clearInterval(interval);
  }, [isOpen, channel]);

  const loadServers = useCallback(async () => {
    try {
      const res = await authFetch(`${API_URL}/api/app.mcp.list?channel=${encodeURIComponent(channel)}`);
      const data = await res.json();
      if (data.ok) setServers(data.servers);
    } catch {}
  }, [channel]);

  const handleConnect = useCallback(
    async (name: string) => {
      setConnecting(true);
      setError(null);
      try {
        // Pre-configured servers: backend looks up config by channel + name
        const res = await authFetch(`${API_URL}/api/app.mcp.add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, name }),
        });
        const data = await res.json();

        if (data.needs_oauth && data.auth_url) {
          window.open(data.auth_url, "_blank");
          await loadServers();
          return;
        }
        if (data.needs_client_id) {
          setError(data.error || "Please configure OAuth Client ID in config.");
          return;
        }
        if (!data.ok) {
          setError(data.error || "Connection failed");
          return;
        }
        await loadServers();
      } catch (e: any) {
        setError(e.message || "Network error");
      } finally {
        setConnecting(false);
      }
    },
    [channel, loadServers],
  );

  const handleDisconnect = useCallback(
    async (name: string) => {
      setToggling(true);
      try {
        const res = await authFetch(`${API_URL}/api/app.mcp.toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, name, enabled: false }),
        });
        const data = await res.json();
        if (!data.ok) setError(data.error || "Disconnect failed");
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
            const isActive = selectedName === server.name;
            return (
              <button
                key={server.name}
                className={`stream-agent-avatar-btn ${isActive ? "active" : ""}`}
                onClick={() => {
                  setSelectedName(server.name);
                  setError(null);
                }}
                title={`${server.name} (${server.transport})`}
              >
                <span className="stream-agent-avatar-wrap">
                  <span className={`mcp-server-icon ${server.connected ? "connected" : "disconnected"}`}>
                    <ServerLogo logo={server.logo} size={20} />
                  </span>
                  {server.connected && <span className="stream-agent-avatar-dot" />}
                </span>
                <span className="stream-agent-avatar-name">{server.name}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="agent-dialog-body">
          {error && <div className="mcp-error">{error}</div>}

          {/* Selected server detail */}
          {selectedServer && (
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
              <div className="agent-buttons">
                {selectedServer.connected ? (
                  <button
                    className="agent-action-btn agent-action-btn--warning"
                    onClick={() => handleDisconnect(selectedServer.name)}
                    disabled={toggling}
                  >
                    {toggling ? "..." : "Disconnect"}
                  </button>
                ) : (
                  <button
                    className="agent-action-btn agent-action-btn--accent"
                    onClick={() => handleConnect(selectedServer.name)}
                    disabled={connecting}
                  >
                    {connecting ? "Connecting..." : "Connect"}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Empty state */}
          {!selectedServer && servers.length === 0 && (
            <div className="mcp-empty">
              <McpIcon size={32} />
              <p>No MCP servers configured for this channel.</p>
              <p style={{ fontSize: "0.85em", opacity: 0.7 }}>Configure servers in ~/.clawd/config.json</p>
            </div>
          )}

          {/* No selection but has servers */}
          {!selectedServer && servers.length > 0 && (
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
