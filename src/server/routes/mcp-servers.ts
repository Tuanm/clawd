/**
 * MCP Server API Routes
 *
 * CRUD operations for channel-scoped MCP servers.
 * Follows the same pattern as agents.ts.
 */

import { homedir } from "node:os";
import { convertCCFormatToInternal, validateServerConfig } from "../../agent/api/mcp-validation";
import {
  getChannelMCPServers,
  removeChannelMCPServer as removeFromConfig,
  saveChannelMCPServer,
  setChannelMCPServerEnabled,
} from "../../agent/api/provider-config";
import type { CCMcpServerConfig, MCPServerConfig } from "../../agent/api/providers";
import { getCatalogEntry, listCategories, resolveArgs, searchCatalog } from "../../agent/mcp/catalog";
import type { WorkerManager } from "../../worker-manager";
import { json } from "../http-helpers";
import { discoverOAuthMetadata, loadOAuthToken, removeOAuthToken, startOAuthFlow } from "../mcp/oauth";

/** Resolve public-facing origin, respecting reverse proxy headers.
 *  Non-local hosts always use https (proxies may forward x-forwarded-proto: http
 *  from the internal connection, but the public endpoint is always TLS). */
export function getPublicOrigin(req: Request, url: URL): string {
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host).split(",")[0].trim();
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(host);
  const proto = isLocal ? req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || "http" : "https";
  return `${proto}://${host}`;
}

async function parseBody(req: Request): Promise<any> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return {};
  try {
    return await req.json();
  } catch {
    throw new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export function registerMcpServerRoutes(
  workerManager: WorkerManager,
): (req: Request, url: URL, path: string) => Response | Promise<Response> | null {
  return (req, url, path) => {
    // =========================================================================
    // LIST — GET /api/app.mcp.list?channel=X
    // =========================================================================
    if (path === "/api/app.mcp.list" && req.method === "GET") {
      const channel = url.searchParams.get("channel");
      if (!channel) return json({ ok: false, error: "channel required" }, 400);

      // Merge config with runtime status
      const configServers = getChannelMCPServers(channel);
      const runtimeStatuses = workerManager.getChannelMcpStatus(channel);
      const statusMap = new Map(runtimeStatuses.map((s) => [s.name, s]));

      const servers = Object.entries(configServers).map(([name, config]) => {
        const runtime = statusMap.get(name);
        return {
          name,
          transport: config.transport || (config.command ? "stdio" : "http"),
          command: config.command,
          args: config.args,
          env: config.env ? Object.fromEntries(Object.entries(config.env).map(([k]) => [k, "••••"])) : undefined,
          url: config.url,
          enabled: config.enabled !== false,
          logo: config.logo,
          oauth: config.oauth ? { client_id: config.oauth.client_id, scopes: config.oauth.scopes } : undefined,
          connected: runtime?.connected || false,
          tools: runtime?.tools || 0,
        };
      });

      return json({ ok: true, servers });
    }

    // =========================================================================
    // TOOLS — GET /api/app.mcp.tools?channel=X
    // Returns tool names and schemas from all connected MCP servers
    // =========================================================================
    if (path === "/api/app.mcp.tools" && req.method === "GET") {
      const channel = url.searchParams.get("channel");
      if (!channel) return json({ ok: false, error: "channel required" }, 400);

      const mcp = workerManager.getChannelMcpManager(channel);
      if (!mcp) return json({ ok: false, error: "No MCP manager for channel" }, 400);

      const allTools = mcp.getAllTools();
      const statuses = mcp.getServerStatuses();
      const statusMap = new Map(statuses.map((s) => [s.name, s]));
      const serverToolMap = new Map<string, { name: string; description: string }[]>();
      for (const { server, tool } of allTools) {
        if (!serverToolMap.has(server)) serverToolMap.set(server, []);
        serverToolMap.get(server)!.push({ name: tool.name, description: tool.description });
      }
      return json({
        ok: true,
        servers: mcp.listServers().map((name) => {
          const status = statusMap.get(name);
          return {
            name,
            connected: status?.connected || false,
            tools: serverToolMap.get(name) || [],
          };
        }),
      });
    }

    // =========================================================================
    // ADD — POST /api/app.mcp.add
    // =========================================================================
    if (path === "/api/app.mcp.add" && req.method === "POST") {
      return (async () => {
        const body = await parseBody(req);
        const { channel, name } = body;
        let { oauth } = body;

        if (!channel || !name) return json({ ok: false, error: "channel and name required" }, 400);

        console.log(`[mcp-servers] Add: channel=${channel}, name=${name}, body_transport=${body.transport || "none"}`);

        // Look up pre-configured server from config
        const existing = getChannelMCPServers(channel);
        const existingCfg = existing[name];

        // Resolve transport/url/command from body OR stored config
        const transport =
          body.transport ||
          existingCfg?.transport ||
          (existingCfg?.command ? "stdio" : existingCfg?.url ? "http" : undefined);
        const command = body.command || existingCfg?.command;
        const args = body.args || existingCfg?.args;
        const env = body.env || existingCfg?.env;
        const serverUrl = body.url || existingCfg?.url;
        const customHeaders = body.headers || existingCfg?.headers;

        if (!transport) return json({ ok: false, error: "transport required (stdio or http)" }, 400);
        if (transport === "stdio" && !command) return json({ ok: false, error: "command required for stdio" }, 400);
        if (transport === "http" && !serverUrl) return json({ ok: false, error: "url required for http" }, 400);

        // Merge stored OAuth credentials — user-provided fields take precedence
        if (transport === "http" && existingCfg?.oauth?.client_id && !oauth?.client_id) {
          oauth = {
            client_id: existingCfg.oauth.client_id,
            client_secret: existingCfg.oauth.client_secret,
            authorize_url: existingCfg.oauth.authorize_url,
            token_url: existingCfg.oauth.token_url,
            scopes: existingCfg.oauth.scopes,
          };
        }

        // For OAuth servers, load token if available
        let token: string | undefined;
        if (oauth?.client_id) {
          const stored = loadOAuthToken(channel, name);
          token = stored?.access_token;
          console.log(
            `[mcp-servers] OAuth creds: has_client_id=${!!oauth.client_id}, has_secret=${!!oauth.client_secret}, stored_token=${token ? "yes" : "no"}`,
          );
        }

        // For HTTP+OAuth servers with no valid token, skip connection attempt
        // and go straight to OAuth flow to avoid a pointless 400/401 error
        if (transport === "http" && oauth?.client_id && !token) {
          const callbackBaseUrl = getPublicOrigin(req, url);

          const oauthConfig: Record<string, any> = {
            client_id: oauth.client_id,
            client_secret: oauth.client_secret || existingCfg?.oauth?.client_secret,
            authorize_url: oauth.authorize_url || existingCfg?.oauth?.authorize_url,
            token_url: oauth.token_url || existingCfg?.oauth?.token_url,
            scopes: oauth.scopes || existingCfg?.oauth?.scopes,
            registration_endpoint: existingCfg?.oauth?.registration_endpoint,
          };

          // Discover endpoints/scopes if missing
          if (!oauthConfig.authorize_url || !oauthConfig.token_url || !oauthConfig.scopes?.length) {
            const callbackUrl = `${callbackBaseUrl}/api/mcp/oauth/callback`;
            const discovered = await discoverOAuthMetadata(serverUrl, callbackUrl);
            if (discovered) {
              if (!oauthConfig.authorize_url) oauthConfig.authorize_url = discovered.authorization_endpoint;
              if (!oauthConfig.token_url) oauthConfig.token_url = discovered.token_endpoint;
              oauthConfig.scopes ??= discovered.scopes_supported;
              if (discovered.client_secret) oauthConfig.client_secret ??= discovered.client_secret;
              if (!oauthConfig.registration_endpoint)
                oauthConfig.registration_endpoint = discovered.registration_endpoint;
            }
          }

          if (!oauthConfig.authorize_url || !oauthConfig.token_url) {
            return json({ ok: false, error: "OAuth authorize_url and token_url are required" }, 400);
          }

          // Save/update config
          const configToSave: MCPServerConfig = {
            transport: "http",
            url: serverUrl,
            oauth: oauthConfig as MCPServerConfig["oauth"],
          };
          if (existingCfg?.logo) configToSave.logo = existingCfg.logo;
          saveChannelMCPServer(channel, name, configToSave);

          const { auth_url } = startOAuthFlow(channel, name, oauthConfig as any, callbackBaseUrl);
          return json({
            ok: true,
            needs_oauth: true,
            auth_url,
            server: { name, transport: "http", connected: false, tools: 0 },
          });
        }

        // For HTTP servers with no OAuth credentials at all, try OAuth discovery first.
        // This avoids a pointless direct HTTP connect (which returns HTML from e.g. Atlassian)
        // before falling back to the OAuth flow.
        if (transport === "http" && !oauth?.client_id && !token) {
          const callbackBaseUrl = getPublicOrigin(req, url);
          const callbackUrl = `${callbackBaseUrl}/api/mcp/oauth/callback`;
          const discovered = await discoverOAuthMetadata(serverUrl, callbackUrl);
          if (discovered) {
            const oauthConfig: MCPServerConfig["oauth"] = {
              client_id: discovered.client_id || "",
              client_secret: discovered.client_secret,
              authorize_url: discovered.authorization_endpoint,
              token_url: discovered.token_endpoint,
              scopes: discovered.scopes_supported,
            };
            // If discovery found endpoints but no client_id, this server requires manual
            // client registration. Return needs_client_id so the UI shows a clear message.
            if (!oauthConfig.client_id) {
              return json({
                ok: false,
                error: "This server requires OAuth client credentials. Install from the catalog for automatic setup.",
              });
            }
            const configToSave: MCPServerConfig = { transport: "http", url: serverUrl, oauth: oauthConfig };
            if (existingCfg?.logo) configToSave.logo = existingCfg.logo;
            saveChannelMCPServer(channel, name, configToSave);
            const { auth_url } = startOAuthFlow(channel, name, oauthConfig, callbackBaseUrl);
            return json({
              ok: true,
              needs_oauth: true,
              auth_url,
              server: { name, transport: "http", connected: false, tools: 0 },
            });
          }
        }

        // Try connecting
        const connectConfig: any = { transport };
        if (transport === "stdio") {
          connectConfig.command = command;
          connectConfig.args = args || [];
          connectConfig.env = env || {};
        } else {
          connectConfig.url = serverUrl;
          if (token) connectConfig.token = token;
          if (customHeaders) connectConfig.headers = customHeaders;
        }

        const result = await workerManager.addChannelMcpServer(channel, name, connectConfig);

        // If HTTP connection failed, try OAuth auto-discovery
        if (!result.success && transport === "http" && !oauth?.client_id) {
          const callbackBaseUrl = getPublicOrigin(req, url);
          const callbackUrl = `${callbackBaseUrl}/api/mcp/oauth/callback`;

          console.log(`[mcp-servers] Connection failed for ${name}, attempting OAuth auto-discovery...`);
          const discovered = await discoverOAuthMetadata(serverUrl, callbackUrl);

          if (discovered) {
            // Save config with discovered OAuth metadata (including client_secret for re-auth)
            const configToSave: MCPServerConfig = {
              transport: "http",
              url: serverUrl,
              oauth: {
                client_id: discovered.client_id || "",
                client_secret: discovered.client_secret,
                authorize_url: discovered.authorization_endpoint,
                token_url: discovered.token_endpoint,
                registration_endpoint: discovered.registration_endpoint,
                scopes: discovered.scopes_supported, // Save discovered scopes for the OAuth flow
              },
            };

            if (!discovered.client_id) {
              // DCR failed — check if existing config has stored credentials
              const storedCfg = existing[name];
              if (storedCfg?.oauth?.client_id) {
                // Use stored credentials + discovered endpoints
                console.log(`[mcp-servers] Using stored OAuth credentials for ${name}`);
                const mergedOauth = {
                  client_id: storedCfg.oauth.client_id,
                  client_secret: storedCfg.oauth.client_secret,
                  authorize_url: discovered.authorization_endpoint,
                  token_url: discovered.token_endpoint,
                  registration_endpoint: discovered.registration_endpoint,
                  scopes: storedCfg.oauth.scopes || discovered.scopes_supported,
                };
                configToSave.oauth = mergedOauth;
                saveChannelMCPServer(channel, name, configToSave);

                const { auth_url } = startOAuthFlow(channel, name, mergedOauth, callbackBaseUrl);
                return json({
                  ok: true,
                  needs_oauth: true,
                  auth_url,
                  server: { name, transport: "http", connected: false, tools: 0 },
                });
              }

              // No stored credentials — save partial config and ask user
              configToSave.oauth!.client_id = "";
              saveChannelMCPServer(channel, name, configToSave);
              // Check if provider requires client_secret
              const authMethods = discovered.token_endpoint_auth_methods_supported || [];
              const needsSecret =
                authMethods.includes("client_secret_post") || authMethods.includes("client_secret_basic");
              const secretHint = needsSecret
                ? " Client Secret is also required by this provider."
                : " Client Secret is optional if your provider supports PKCE.";
              return json(
                {
                  ok: false,
                  error: `OAuth server discovered but auto-registration not available. Please provide your OAuth Client ID.${secretHint}`,
                  needs_client_id: true,
                  discovered: {
                    authorization_endpoint: discovered.authorization_endpoint,
                    token_endpoint: discovered.token_endpoint,
                    scopes_available: discovered.scopes_supported,
                  },
                },
                401,
              );
            }

            // Save config and start OAuth flow
            saveChannelMCPServer(channel, name, configToSave);

            const { auth_url } = startOAuthFlow(
              channel,
              name,
              {
                client_id: discovered.client_id,
                client_secret: discovered.client_secret,
                authorize_url: discovered.authorization_endpoint,
                token_url: discovered.token_endpoint,
                scopes: discovered.scopes_supported,
              },
              callbackBaseUrl,
            );

            return json({
              ok: true,
              needs_oauth: true,
              auth_url,
              server: { name, transport: "http", connected: false, tools: 0 },
            });
          }

          // No discovery available — return original connection error
          return json({ ok: false, error: `Connection failed: ${result.error}` }, 502);
        }

        if (!result.success) {
          return json({ ok: false, error: `Connection failed: ${result.error}` }, 502);
        }

        // Save/update config on success
        if (!existingCfg) {
          const configToSave: MCPServerConfig = { transport };
          if (transport === "stdio") {
            configToSave.command = command;
            configToSave.args = args;
            if (env && Object.keys(env).length > 0) configToSave.env = env;
          } else {
            configToSave.url = serverUrl;
            if (oauth) configToSave.oauth = oauth;
            if (customHeaders) configToSave.headers = customHeaders;
          }
          saveChannelMCPServer(channel, name, configToSave);
        } else if (existingCfg.enabled === false) {
          // Re-enable the server if it was disabled
          setChannelMCPServerEnabled(channel, name, true);
        }

        return json({ ok: true, server: { name, transport, connected: true, tools: result.tools } });
      })().catch((e) => (e instanceof Response ? e : json({ ok: false, error: "Internal server error" }, 500)));
    }

    // =========================================================================
    // REMOVE — POST /api/app.mcp.remove
    // =========================================================================
    if (path === "/api/app.mcp.remove" && req.method === "POST") {
      return (async () => {
        const body = await parseBody(req);
        const { channel, name } = body;

        if (!channel || !name) return json({ ok: false, error: "channel and name required" }, 400);

        try {
          await workerManager.removeChannelMcpServer(channel, name);
        } catch (err: unknown) {
          console.error(`[mcp-servers] Error disconnecting ${name}:`, err);
        }
        removeFromConfig(channel, name);
        removeOAuthToken(channel, name);

        return json({ ok: true });
      })().catch((e) => (e instanceof Response ? e : json({ ok: false, error: "Internal server error" }, 500)));
    }

    // =========================================================================
    // TOGGLE — POST /api/app.mcp.toggle
    // =========================================================================
    if (path === "/api/app.mcp.toggle" && req.method === "POST") {
      return (async () => {
        const body = await parseBody(req);
        const { channel, name, enabled } = body;

        if (!channel || !name || enabled === undefined) {
          return json({ ok: false, error: "channel, name, and enabled required" }, 400);
        }

        const configs = getChannelMCPServers(channel);
        const config = configs[name];
        if (!config) return json({ ok: false, error: `Server "${name}" not found` }, 404);

        if (enabled) {
          // Reconnect
          let token: string | undefined;
          if (config.oauth?.client_id) {
            const stored = loadOAuthToken(channel, name);
            token = stored?.access_token;
          }
          const connectConfig: any = {
            transport: config.transport,
            command: config.command,
            args: config.args,
            env: config.env,
            url: config.url,
            headers: config.headers,
            token,
          };
          const result = await workerManager.addChannelMcpServer(channel, name, connectConfig);
          if (!result.success) {
            return json({ ok: false, error: `Reconnection failed: ${result.error}` }, 502);
          }
          setChannelMCPServerEnabled(channel, name, true);
          return json({ ok: true, connected: true, tools: result.tools });
        } else {
          // Disconnect
          await workerManager.removeChannelMcpServer(channel, name);
          setChannelMCPServerEnabled(channel, name, false);
          return json({ ok: true, connected: false, tools: 0 });
        }
      })().catch((e) => (e instanceof Response ? e : json({ ok: false, error: "Internal server error" }, 500)));
    }

    // =========================================================================
    // IMPORT — POST /api/app.mcp.import
    // Accepts a CC / Claude Desktop mcpServers JSON blob, validates each entry,
    // and saves to mcp_servers[channel] (additive-only — no clobber).
    // =========================================================================
    if (path === "/api/app.mcp.import" && req.method === "POST") {
      return (async () => {
        const body = await parseBody(req);
        const { channel, json: rawJson } = body as { channel?: string; json?: string };

        if (!channel) return json({ ok: false, error: "channel required" }, 400);
        if (!rawJson || typeof rawJson !== "string") {
          return json({ ok: false, error: "json (string) required" }, 400);
        }

        let ccServers: Record<string, CCMcpServerConfig>;
        try {
          const parsed = JSON.parse(rawJson);
          // Accept either the raw mcpServers object or a wrapper { mcpServers: {...} }
          ccServers = parsed.mcpServers ?? parsed;
          if (typeof ccServers !== "object" || Array.isArray(ccServers)) {
            throw new Error("Expected an object");
          }
        } catch (err: unknown) {
          return json({ ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }, 400);
        }

        const converted = convertCCFormatToInternal(ccServers);

        const MAX_IMPORT = 100;
        if (Object.keys(converted).length > MAX_IMPORT) {
          return json({ ok: false, error: `Import exceeds ${MAX_IMPORT} server limit` }, 400);
        }

        const existing = getChannelMCPServers(channel);
        const skipped: Array<{ name: string; reason: string }> = [];
        let imported = 0;

        for (const [name, cfg] of Object.entries(converted)) {
          // No clobber — skip if already present in channel config
          if (existing[name] !== undefined) {
            skipped.push({ name, reason: "already exists" });
            continue;
          }

          // Full async validation (includes DNS rebinding check)
          try {
            await validateServerConfig(name, cfg);
          } catch (err: unknown) {
            skipped.push({ name, reason: err instanceof Error ? err.message : String(err) });
            continue;
          }

          saveChannelMCPServer(channel, name, cfg);
          imported++;
        }

        return json({ ok: true, imported, skipped });
      })().catch((e) => (e instanceof Response ? e : json({ ok: false, error: "Internal server error" }, 500)));
    }

    // =========================================================================
    // EXPORT — GET /api/app.mcp.export?channel=X&format=claude-desktop
    // Returns channel MCP servers in CC / Claude Desktop mcpServers format.
    // Credentials are scrubbed: env values masked, client_secret omitted.
    // =========================================================================
    if (path === "/api/app.mcp.export" && req.method === "GET") {
      const channel = url.searchParams.get("channel");
      // format param reserved for future formats; currently only claude-desktop
      if (!channel) return json({ ok: false, error: "channel required" }, 400);

      const configServers = getChannelMCPServers(channel);
      const mcpServers: Record<string, CCMcpServerConfig> = {};

      for (const [name, cfg] of Object.entries(configServers)) {
        const entry: CCMcpServerConfig = {};

        if (cfg.transport === "http" || (!cfg.command && cfg.url)) {
          entry.type = "http";
          if (cfg.url) entry.url = cfg.url;
          // Scrub headers that may contain auth tokens — omit them entirely
          // (headers often contain Bearer tokens; export without secrets)
        } else {
          if (cfg.command) entry.command = cfg.command;
          if (cfg.args?.length) entry.args = cfg.args;
        }

        // env and headers stripped entirely — re-importing masked values would corrupt config
        // (scrubbed_fields tells consumers which fields were removed)

        // oauth: omit client_secret (match app.mcp.list scrubbing pattern)
        // CC format has no oauth field — skip entirely (user must re-auth)

        mcpServers[name] = entry;
      }

      return json({ ok: true, config: { mcpServers }, scrubbed_fields: ["env", "headers"] });
    }

    // =========================================================================
    // OAUTH START — POST /api/app.mcp.oauth.start
    // =========================================================================
    if (path === "/api/app.mcp.oauth.start" && req.method === "POST") {
      return (async () => {
        const body = await parseBody(req);
        const { channel, name } = body;

        if (!channel || !name) return json({ ok: false, error: "channel and name required" }, 400);

        const configs = getChannelMCPServers(channel);
        const config = configs[name];
        if (!config?.oauth) return json({ ok: false, error: `Server "${name}" has no OAuth config` }, 400);

        // If authorize_url/token_url are empty (catalog OAuth stub), attempt auto-discovery
        if (!config.oauth.authorize_url || !config.oauth.token_url) {
          const callbackBaseUrl = getPublicOrigin(req, url);
          const callbackUrl = `${callbackBaseUrl}/api/mcp/oauth/callback`;
          const discovered = await discoverOAuthMetadata(config.url!, callbackUrl);
          if (discovered) {
            config.oauth.authorize_url = discovered.authorization_endpoint;
            config.oauth.token_url = discovered.token_endpoint;
            config.oauth.scopes ??= discovered.scopes_supported;
            if (discovered.client_secret) config.oauth.client_secret ??= discovered.client_secret;
            // Persist discovered endpoints so subsequent calls don't need re-discovery
            saveChannelMCPServer(channel, name, config);
          } else if (!config.oauth.authorize_url || !config.oauth.token_url) {
            return json({ ok: false, error: "OAuth authorize_url and token_url are required" }, 400);
          }
        }

        try {
          const callbackBaseUrl = getPublicOrigin(req, url);
          const { auth_url } = startOAuthFlow(
            channel,
            name,
            {
              client_id: config.oauth.client_id,
              client_secret: config.oauth.client_secret,
              authorize_url: config.oauth.authorize_url,
              token_url: config.oauth.token_url,
              scopes: config.oauth.scopes,
            },
            callbackBaseUrl,
          );
          return json({ ok: true, auth_url });
        } catch (err: unknown) {
          return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
        }
      })().catch((e) => (e instanceof Response ? e : json({ ok: false, error: "Internal server error" }, 500)));
    }

    // =========================================================================
    // CATALOG — GET /api/app.mcp.catalog?search=&category=
    // Returns catalog entries with optional search/filter.
    // =========================================================================
    if (path === "/api/app.mcp.catalog" && req.method === "GET") {
      const search = url.searchParams.get("search") || undefined;
      const category = url.searchParams.get("category") || undefined;
      const entries = searchCatalog(search, category);
      const categories = listCategories();
      return json({ ok: true, entries, categories });
    }

    // =========================================================================
    // INSTALL — POST /api/app.mcp.install
    // Install a server from the built-in catalog into a channel config.
    // Body: { channel, serverId, env?, projectRoot? }
    // Returns: { ok, name, tools?, skipped, needs_oauth? }
    // =========================================================================
    if (path === "/api/app.mcp.install" && req.method === "POST") {
      return (async () => {
        const body = await parseBody(req);
        const { channel, serverId, env, projectRoot } = body as {
          channel?: string;
          serverId?: string;
          env?: Record<string, string>;
          projectRoot?: string;
        };

        if (!channel) return json({ ok: false, error: "channel required" }, 400);
        if (!serverId) return json({ ok: false, error: "serverId required" }, 400);

        const entry = getCatalogEntry(serverId);
        if (!entry) return json({ ok: false, error: `Unknown catalog server: ${serverId}` }, 404);

        // Require projectRoot when server args contain {PROJECT_ROOT}
        const hasProjectRootTemplate = entry.args?.some((a) => a.includes("{PROJECT_ROOT}"));
        if (hasProjectRootTemplate && !projectRoot) {
          return json({ ok: false, error: "projectRoot required for this server" }, 400);
        }

        // Resolve template vars in args — PROJECT_ROOT, HOME, CHANNEL, and env.
        let resolvedArgs: string[];
        try {
          resolvedArgs = resolveArgs(entry.args || [], {
            ...(projectRoot ? { PROJECT_ROOT: projectRoot } : {}),
            HOME: homedir(),
            CHANNEL: channel,
            ...(env || {}),
          });
        } catch (err: unknown) {
          return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
        }

        // No-clobber: skip if server already exists in channel
        const existing = getChannelMCPServers(channel);
        if (existing[entry.id] !== undefined) {
          return json({ ok: true, name: entry.id, skipped: true });
        }

        // Build config
        const mcpConfig: any = {
          transport: entry.transport,
          autoProvisioned: true,
          autoProvisionedBy: "catalog",
          ...(entry.logo ? { logo: entry.logo } : {}),
        };
        if (entry.transport === "stdio") {
          mcpConfig.command = entry.command;
          mcpConfig.args = resolvedArgs;
          if (env && Object.keys(env).length > 0) mcpConfig.env = env;
        } else {
          mcpConfig.url = entry.url;
        }

        // Validate
        try {
          await validateServerConfig(entry.id, mcpConfig);
        } catch (err: unknown) {
          return json(
            { ok: false, error: `Validation failed: ${err instanceof Error ? err.message : String(err)}` },
            400,
          );
        }

        // OAuth servers: attempt auto-discovery so we can start the flow immediately
        if (entry.requiresOAuth && entry.transport === "http") {
          try {
            await validateServerConfig(entry.id, { transport: "http", url: entry.url });
          } catch (err: unknown) {
            return json(
              { ok: false, error: `Validation failed: ${err instanceof Error ? err.message : String(err)}` },
              400,
            );
          }
          const callbackBaseUrl = getPublicOrigin(req, url);
          const callbackUrl = `${callbackBaseUrl}/api/mcp/oauth/callback`;
          const discovered = await discoverOAuthMetadata(entry.url!, callbackUrl);

          if (discovered && discovered.client_id) {
            // Full discovery succeeded — save config and start OAuth flow now
            const oauthConfig: MCPServerConfig["oauth"] = {
              client_id: discovered.client_id || "",
              client_secret: discovered.client_secret ?? "",
              authorize_url: discovered.authorization_endpoint,
              token_url: discovered.token_endpoint,
              scopes: discovered.scopes_supported,
            };
            const oauthMcpConfig: any = {
              transport: "http",
              url: entry.url!,
              oauth: oauthConfig,
              autoProvisioned: true,
              autoProvisionedBy: "catalog",
              ...(entry.logo ? { logo: entry.logo } : {}),
            };
            saveChannelMCPServer(channel, entry.id, oauthMcpConfig);
            const { auth_url } = startOAuthFlow(channel, entry.id, oauthConfig as any, callbackBaseUrl);
            return json({ ok: true, name: entry.id, skipped: false, needs_oauth: true, auth_url });
          }

          // Discovery failed or DCR not supported — save stub so /oauth.start can retry discovery
          const oauthConfig: MCPServerConfig["oauth"] = {
            client_id: "",
            authorize_url: "",
            token_url: "",
            scopes: discovered?.scopes_supported || [],
          };
          const oauthMcpConfig: any = {
            transport: "http",
            url: entry.url!,
            oauth: oauthConfig,
            autoProvisioned: true,
            autoProvisionedBy: "catalog",
            ...(entry.logo ? { logo: entry.logo } : {}),
          };
          saveChannelMCPServer(channel, entry.id, oauthMcpConfig);
          return json({ ok: true, name: entry.id, skipped: false, needs_oauth: true });
        }

        // Save stdio config (non-OAuth)
        saveChannelMCPServer(channel, entry.id, mcpConfig);

        // Non-OAuth: attempt immediate connection
        let tools = 0;
        try {
          const result = await workerManager.addChannelMcpServer(channel, entry.id, {
            transport: entry.transport as "stdio" | "http",
            command: mcpConfig.command,
            args: mcpConfig.args,
            env: mcpConfig.env,
            url: mcpConfig.url,
          });
          if (result.success) tools = result.tools;
        } catch {
          // Non-fatal: server is saved; user can connect manually via the UI
        }

        return json({ ok: true, name: entry.id, tools, skipped: false });
      })().catch((e) => (e instanceof Response ? e : json({ ok: false, error: "Internal server error" }, 500)));
    }

    return null;
  };
}
