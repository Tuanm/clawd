/**
 * MCP Server API Routes
 *
 * CRUD operations for channel-scoped MCP servers.
 * Follows the same pattern as agents.ts.
 */

import type { WorkerManager } from "../worker-manager";
import {
  getChannelMCPServers,
  saveChannelMCPServer,
  removeChannelMCPServer as removeFromConfig,
  setChannelMCPServerEnabled,
} from "../agent/src/api/provider-config";
import type { MCPServerConfig } from "../agent/src/api/providers";
import { loadOAuthToken, removeOAuthToken, startOAuthFlow, discoverOAuthMetadata } from "../mcp-oauth";

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Resolve public-facing origin, respecting reverse proxy headers. */
function getPublicOrigin(req: Request, url: URL): string {
  const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

async function parseBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export function registerMcpServerRoutes(
  workerManager: WorkerManager,
): (req: Request, url: URL, path: string) => Response | Promise<Response> | null {
  return (req, url, path) => {
    // =========================================================================
    // LIST — GET /api/app.mcp.list?channel=X
    // =========================================================================
    if (path === "/api/app.mcp.list") {
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
          oauth: config.oauth ? { client_id: config.oauth.client_id, scopes: config.oauth.scopes } : undefined,
          connected: runtime?.connected || false,
          tools: runtime?.tools || 0,
        };
      });

      return json({ ok: true, servers });
    }

    // =========================================================================
    // ADD — POST /api/app.mcp.add
    // =========================================================================
    if (path === "/api/app.mcp.add" && req.method === "POST") {
      return (async () => {
        const body = await parseBody(req);
        const { channel, name, transport, command, args, env, url: serverUrl } = body;
        let { oauth } = body;

        if (!channel || !name) return json({ ok: false, error: "channel and name required" }, 400);
        if (!transport) return json({ ok: false, error: "transport required (stdio or http)" }, 400);

        if (transport === "stdio" && !command) return json({ ok: false, error: "command required for stdio" }, 400);
        if (transport === "http" && !serverUrl) return json({ ok: false, error: "url required for http" }, 400);

        // Check for existing — allow re-submission for OAuth retry or HTTP reconnect
        const existing = getChannelMCPServers(channel);
        const existingCfg = existing[name];
        if (existingCfg) {
          const isOAuthRetry =
            transport === "http" && oauth?.client_id && existingCfg.oauth && existingCfg.oauth?.client_id === "";
          const isHttpReconnect = transport === "http" && existingCfg.transport === "http";
          if (!isOAuthRetry && !isHttpReconnect) {
            return json({ ok: false, error: `Server "${name}" already exists in channel` }, 409);
          }
        }

        // For HTTP servers, merge stored OAuth credentials from config
        // User-provided oauth fields take precedence over stored values
        if (transport === "http" && existingCfg?.oauth?.client_id && !oauth?.client_id) {
          // Use stored credentials automatically
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

        // If HTTP connection failed and user provided OAuth client_id, start OAuth flow
        if (!result.success && transport === "http" && oauth?.client_id) {
          const callbackBaseUrl = getPublicOrigin(req, url);

          // Check if we have saved config with discovered endpoints (from previous attempt)
          const existingConfigs = getChannelMCPServers(channel);
          const existingConfig = existingConfigs[name];
          const oauthConfig: Record<string, any> = {
            client_id: oauth.client_id,
            client_secret: oauth.client_secret || existingConfig?.oauth?.client_secret,
            authorize_url: oauth.authorize_url || existingConfig?.oauth?.authorize_url,
            token_url: oauth.token_url || existingConfig?.oauth?.token_url,
            scopes: oauth.scopes || existingConfig?.oauth?.scopes,
            registration_endpoint: existingConfig?.oauth?.registration_endpoint,
          };

          // If we still don't have endpoints or scopes, try discovery
          if (!oauthConfig.authorize_url || !oauthConfig.token_url || !oauthConfig.scopes?.length) {
            const callbackUrl = `${callbackBaseUrl}/api/mcp/oauth/callback`;
            const discovered = await discoverOAuthMetadata(serverUrl, callbackUrl);
            if (discovered) {
              if (!oauthConfig.authorize_url) oauthConfig.authorize_url = discovered.authorization_endpoint;
              if (!oauthConfig.token_url) oauthConfig.token_url = discovered.token_endpoint;
              if (!oauthConfig.scopes?.length) oauthConfig.scopes = discovered.scopes_supported;
              if (!oauthConfig.client_secret) oauthConfig.client_secret = discovered.client_secret;
              if (!oauthConfig.registration_endpoint)
                oauthConfig.registration_endpoint = discovered.registration_endpoint;
            }
          }

          if (!oauthConfig.authorize_url || !oauthConfig.token_url) {
            return json({ ok: false, error: "OAuth authorize_url and token_url are required" }, 400);
          }

          // Save/update config with user's client_id + discovered endpoints
          const configToSave: MCPServerConfig = {
            transport: "http",
            url: serverUrl,
            oauth: oauthConfig as MCPServerConfig["oauth"],
          };
          saveChannelMCPServer(channel, name, configToSave);

          const { auth_url } = startOAuthFlow(
            channel,
            name,
            oauthConfig as {
              client_id: string;
              client_secret?: string;
              authorize_url?: string;
              token_url?: string;
              scopes?: string[];
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

        if (!result.success) {
          return json({ ok: false, error: `Connection failed: ${result.error}` }, 502);
        }

        // Save to config on success
        const configToSave: MCPServerConfig = { transport };
        if (transport === "stdio") {
          configToSave.command = command;
          configToSave.args = args;
          if (env && Object.keys(env).length > 0) configToSave.env = env;
        } else {
          configToSave.url = serverUrl;
          if (oauth) configToSave.oauth = oauth;
        }
        saveChannelMCPServer(channel, name, configToSave);

        return json({ ok: true, server: { name, transport, connected: true, tools: result.tools } });
      })();
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
        } catch (err: any) {
          console.error(`[mcp-servers] Error disconnecting ${name}:`, err);
        }
        removeFromConfig(channel, name);
        removeOAuthToken(channel, name);

        return json({ ok: true });
      })();
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
      })();
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
        if (!config.oauth.authorize_url) return json({ ok: false, error: "authorize_url is required" }, 400);
        if (!config.oauth.token_url) return json({ ok: false, error: "token_url is required" }, 400);

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
        } catch (err: any) {
          return json({ ok: false, error: err.message }, 500);
        }
      })();
    }

    return null;
  };
}
