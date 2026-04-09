import DOMPurify from "dompurify";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./auth-fetch";
import { useInputContextMenu, InputContextMenu } from "./InputContextMenu";

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
  /** Catalog entry ID if this server comes from the catalog (undefined = pre-configured channel server) */
  catalogId?: string;
  /** True for catalog servers that are available but not yet installed */
  catalogOnly?: boolean;
}

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  logo?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  requiresOAuth?: boolean;
  envRequired?: string[];
  envOptional?: string[];
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
  const [catalogEntries, setCatalogEntries] = useState<CatalogEntry[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // Install form state (for catalog servers)
  const [installEnv, setInstallEnv] = useState<Record<string, string>>({});
  const [installProjectRoot, setInstallProjectRoot] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // Context menu for text inputs
  const {
    menu: inputMenu,
    hasSelection: inputHasSelection,
    isEditable: inputIsEditable,
    handleContextMenu: handleInputContextMenu,
    closeMenu: closeInputMenu,
    handleCopy: handleInputCopy,
    handleCut: handleInputCut,
    handleSelectAll: handleInputSelectAll,
  } = useInputContextMenu();

  // Reset state on dialog close
  useEffect(() => {
    if (!isOpen) {
      setSelectedName(null);
      setError(null);
      setInstallEnv({});
      setInstallProjectRoot("");
      setInstallError(null);
    }
  }, [isOpen]);

  // Load servers when dialog opens
  useEffect(() => {
    if (!isOpen || !channel) return;
    loadServers();
    const interval = setInterval(loadServers, 5000);
    return () => clearInterval(interval);
  }, [isOpen, channel]);

  const loadServers = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoading(true);
      try {
        // Fetch channel servers and catalog in parallel
        const [channelRes, catalogRes] = await Promise.all([
          authFetch(`${API_URL}/api/app.mcp.list?channel=${encodeURIComponent(channel)}`),
          authFetch(`${API_URL}/api/app.mcp.catalog`),
        ]);
        const channelData = await channelRes.json();
        const catalogData = await catalogRes.json();

        const channelServers: McpServer[] = channelData.ok ? channelData.servers : [];
        const catalog: CatalogEntry[] = catalogData.ok ? catalogData.entries : [];

        // Track which catalog IDs are already installed (by name match)
        const installedNames = new Set(channelServers.map((s) => s.name));

        // Merge: channel servers first, then catalog servers not yet installed
        const merged: McpServer[] = [
          ...channelServers.map((s) => ({ ...s, catalogOnly: false })),
          ...catalog
            .filter((c) => !installedNames.has(c.id))
            .map((c) => ({
              name: c.id,
              transport: c.transport,
              command: c.command,
              args: c.args,
              url: c.url,
              enabled: false,
              logo: c.logo,
              oauth: c.requiresOAuth ? { client_id: "", scopes: [] } : undefined,
              connected: false,
              tools: 0,
              catalogId: c.id,
              catalogOnly: true,
            })),
        ];

        setServers(merged);
        setCatalogEntries(catalog);
      } catch {
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [channel],
  );

  const handleConnect = useCallback(
    async (name: string) => {
      setConnecting(true);
      setError(null);
      try {
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

  const handleInstall = useCallback(async () => {
    const server = servers.find((s) => s.name === selectedName && s.catalogOnly);
    if (!server?.catalogId) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const env = Object.fromEntries(Object.entries(installEnv).filter(([, v]) => v !== ""));
      const res = await authFetch(`${API_URL}/api/app.mcp.install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          serverId: server.catalogId,
          env: Object.keys(env).length > 0 ? env : undefined,
          projectRoot: installProjectRoot || undefined,
        }),
      });
      const data = await res.json();

      if (!data.ok) {
        setInstallError(data.error || "Install failed");
        return;
      }

      // OAuth: redirect to auth, then refresh
      if (data.needs_oauth && data.auth_url) {
        window.open(data.auth_url, "_blank");
        await loadServers();
        return;
      }

      setInstallEnv({});
      setInstallProjectRoot("");
      await loadServers();
    } catch (e: any) {
      setInstallError(e.message || "Network error");
    } finally {
      setInstalling(false);
    }
  }, [servers, selectedName, installEnv, installProjectRoot, channel, loadServers]);

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

  const handleUninstall = useCallback(
    async (name: string) => {
      if (!confirm(`Remove "${name}" from this channel? This cannot be undone.`)) return;
      setToggling(true);
      try {
        const res = await authFetch(`${API_URL}/api/app.mcp.remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, name }),
        });
        const data = await res.json();
        if (!data.ok) setError(data.error || "Uninstall failed");
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
            <button
              className="worktree-refresh-btn"
              onClick={() => loadServers(true)}
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
                  setInstallError(null);
                  // Pre-fill env vars when selecting a catalog server
                  if (server.catalogOnly) {
                    const entry = catalogEntries.find((c) => c.id === server.catalogId);
                    if (entry) {
                      setInstallEnv(
                        Object.fromEntries(
                          [...(entry.envRequired || []), ...(entry.envOptional || [])].map((k) => [k, ""]),
                        ),
                      );
                    }
                  } else {
                    setInstallEnv({});
                  }
                }}
                title={`${server.name} (${server.transport})${server.catalogOnly ? " — catalog" : ""}`}
              >
                <span className="stream-agent-avatar-wrap">
                  <span
                    className={`mcp-server-icon ${server.connected ? "connected" : "disconnected"} ${server.catalogOnly ? "catalog" : ""}`}
                  >
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
              <label className="skills-field-label">Server Name</label>
              <input
                type="text"
                className="agent-field-input"
                placeholder="Name"
                value={selectedServer.name}
                readOnly
                onContextMenu={handleInputContextMenu}
              />
              <label className="skills-field-label">Transport</label>
              <input
                type="text"
                className="agent-field-input"
                placeholder="Type"
                value={selectedServer.transport}
                readOnly
                onContextMenu={handleInputContextMenu}
              />
              {selectedServer.command && (
                <>
                  <label className="skills-field-label">Command</label>
                  <input
                    type="text"
                    className="agent-field-input"
                    placeholder="Command"
                    value={`${selectedServer.command} ${selectedServer.args?.join(" ") || ""}`}
                    readOnly
                    onContextMenu={handleInputContextMenu}
                  />
                </>
              )}
              {selectedServer.url && (
                <>
                  <label className="skills-field-label">URL</label>
                  <input
                    type="text"
                    className="agent-field-input"
                    placeholder="URL"
                    value={selectedServer.url}
                    readOnly
                    onContextMenu={handleInputContextMenu}
                  />
                </>
              )}
              <label className="skills-field-label">Status</label>
              <input
                type="text"
                className="agent-field-input"
                placeholder="Status"
                value={
                  selectedServer.catalogOnly
                    ? "Available (not installed)"
                    : selectedServer.connected
                      ? `Connected (${selectedServer.tools} tools)`
                      : "Disconnected"
                }
                readOnly
                onContextMenu={handleInputContextMenu}
              />

              {/* Install form for catalog-only servers */}
              {selectedServer.catalogOnly && (
                <>
                  {(() => {
                    const entry = catalogEntries.find((c) => c.id === selectedServer.catalogId);
                    const hasProjectRoot = entry?.args?.some((a) => a.includes("{PROJECT_ROOT}"));
                    return (
                      <>
                        {entry?.envRequired?.map((key) => (
                          <div key={key}>
                            <label className="skills-field-label">{key}</label>
                            <input
                              type="text"
                              className="agent-field-input"
                              placeholder={`${key} (required)`}
                              value={installEnv[key] ?? ""}
                              onContextMenu={handleInputContextMenu}
                              onChange={(e) => setInstallEnv((prev) => ({ ...prev, [key]: e.target.value }))}
                            />
                          </div>
                        ))}
                        {entry?.envOptional?.map((key) => (
                          <div key={key}>
                            <label className="skills-field-label">
                              {key} <span style={{ opacity: 0.5 }}>(optional)</span>
                            </label>
                            <input
                              type="text"
                              className="agent-field-input"
                              placeholder={key}
                              value={installEnv[key] ?? ""}
                              onContextMenu={handleInputContextMenu}
                              onChange={(e) => setInstallEnv((prev) => ({ ...prev, [key]: e.target.value }))}
                            />
                          </div>
                        ))}
                        {hasProjectRoot && (
                          <div>
                            <label className="skills-field-label">Project Root</label>
                            <input
                              type="text"
                              className="agent-field-input"
                              placeholder="/path/to/project"
                              value={installProjectRoot}
                              onContextMenu={handleInputContextMenu}
                              onChange={(e) => setInstallProjectRoot(e.target.value)}
                            />
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {installError && <div className="mcp-error">{installError}</div>}
                  <div className="agent-buttons">
                    <button
                      className="agent-action-btn agent-action-btn--accent"
                      onClick={handleInstall}
                      disabled={installing}
                    >
                      {installing ? "Installing..." : "Install"}
                    </button>
                  </div>
                </>
              )}

              {/* Connect / Disconnect / Uninstall for installed channel servers */}
              {!selectedServer.catalogOnly && (
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
                    <>
                      <button
                        className="agent-action-btn agent-action-btn--accent"
                        onClick={() => handleConnect(selectedServer.name)}
                        disabled={connecting}
                      >
                        {connecting ? "Connecting..." : "Connect"}
                      </button>
                      <button
                        className="agent-action-btn agent-action-btn--danger"
                        onClick={() => handleUninstall(selectedServer.name)}
                        disabled={toggling}
                      >
                        {toggling ? "..." : "Uninstall"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {!selectedServer && servers.length === 0 && (
            <div className="mcp-empty">
              <McpIcon size={32} />
              <p>No MCP servers. Browse the catalog above to add one.</p>
            </div>
          )}

          {/* No selection but has servers */}
          {!selectedServer && servers.length > 0 && (
            <div className="mcp-empty">
              <p>Select a server to view details.</p>
              {catalogEntries.length > 0 && servers.filter((s) => s.catalogOnly).length === 0 && (
                <p style={{ fontSize: "0.85em", opacity: 0.7 }}>All catalog servers are already installed.</p>
              )}
            </div>
          )}
        </div>
      </div>
      {inputMenu && (
        <InputContextMenu
          menu={inputMenu}
          onClose={closeInputMenu}
          hasSelection={inputHasSelection}
          isEditable={inputIsEditable}
          onCopy={handleInputCopy}
          onCut={handleInputCut}
          onSelectAll={handleInputSelectAll}
        />
      )}
    </div>,
    document.body,
  );
}
