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
import { loadOAuthToken, removeOAuthToken, startOAuthFlow } from "../mcp-oauth";

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
        const { channel, name, transport, command, args, env, url: serverUrl, oauth } = body;

        if (!channel || !name) return json({ ok: false, error: "channel and name required" }, 400);
        if (!transport) return json({ ok: false, error: "transport required (stdio or http)" }, 400);

        if (transport === "stdio" && !command) return json({ ok: false, error: "command required for stdio" }, 400);
        if (transport === "http" && !serverUrl) return json({ ok: false, error: "url required for http" }, 400);

        // Check for existing
        const existing = getChannelMCPServers(channel);
        if (existing[name]) return json({ ok: false, error: `Server "${name}" already exists in channel` }, 409);

        // For OAuth servers, load token if available
        let token: string | undefined;
        if (oauth?.client_id) {
          const stored = loadOAuthToken(channel, name);
          token = stored?.access_token;
        }

        // Try connecting first
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

        try {
          const { auth_url } = startOAuthFlow(
            channel,
            name,
            config.oauth,
            body.callback_base_url || `http://localhost:${process.env.PORT || 3117}`,
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
