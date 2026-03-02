/**
 * Caddy Gateway Manager
 *
 * Manages a long-lived `clawd-gateway` container running Caddy as a reverse proxy.
 * The gateway is dynamically connected to each workspace's isolated Docker network
 * so it can reach workspace containers via Docker DNS (clawd-ws-{id}:6080).
 *
 * Routes:
 *   /{workspaceId}/*         → clawd-ws-{workspaceId}:6080/{path}
 *   /{workspaceId}/websockify → WebSocket tunnel to clawd-ws-{workspaceId}:6080/websockify
 *
 * The chat server proxies /workspace/{id}/novnc/* to this gateway at 127.0.0.1:7777.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GATEWAY_CONTAINER_NAME = "clawd-gateway";
export const GATEWAY_PROXY_PORT = 7777;
export const GATEWAY_ADMIN_PORT = 2019;

const GATEWAY_ADMIN_URL = `http://127.0.0.1:${GATEWAY_ADMIN_PORT}`;
const GATEWAY_IMAGE = "caddy:alpine";

// Singleton promise to prevent concurrent ensureGatewayHttpServer() calls
let gatewayConfigurePromise: Promise<void> | null = null;
let gatewayConfigured = false;

const WORKSPACE_ID_RE = /^[a-f0-9]{16}$/;
function assertValidWorkspaceId(id: string): void {
  if (!WORKSPACE_ID_RE.test(id)) throw new Error(`Invalid workspace ID: "${id}"`);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Ensure the Caddy gateway container is running and the HTTP server is configured.
 * Safe to call multiple times — idempotent.
 */
export async function ensureGatewayRunning(): Promise<void> {
  // Check if container already exists and handle all possible states
  try {
    const { stdout } = await execFileAsync("docker", ["inspect", "--format={{.State.Status}}", GATEWAY_CONTAINER_NAME]);
    const status = stdout.trim();
    if (status === "running") {
      // Container is running; ensure HTTP server is configured
      await ensureGatewayHttpServer();
      return;
    }
    if (status === "exited" || status === "stopped") {
      // Restart existing container
      await execFileAsync("docker", ["start", GATEWAY_CONTAINER_NAME]);
      await waitForAdminApi();
      await ensureGatewayHttpServer();
      return;
    }
    // Any other state (created, paused, restarting, dead) — remove and recreate
    console.log(`[Gateway] Container in unexpected state "${status}", removing and recreating...`);
    await execFileAsync("docker", ["rm", "-f", GATEWAY_CONTAINER_NAME]);
  } catch {
    // Container doesn't exist — create it
  }

  // Create and start the gateway container
  try {
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      GATEWAY_CONTAINER_NAME,
      "--restart",
      "unless-stopped",
      "-p",
      `127.0.0.1:${GATEWAY_PROXY_PORT}:${GATEWAY_PROXY_PORT}`,
      "-p",
      `127.0.0.1:${GATEWAY_ADMIN_PORT}:${GATEWAY_ADMIN_PORT}`,
      GATEWAY_IMAGE,
      "caddy",
      "run", // Start with no config; admin API enabled by default on :2019
    ]);
  } catch (runErr: any) {
    // Race condition: concurrent call already created the container — start it instead
    if (runErr.message?.includes("Conflict") || runErr.message?.includes("already in use")) {
      await execFileAsync("docker", ["start", GATEWAY_CONTAINER_NAME]);
    } else {
      throw runErr;
    }
  }

  await waitForAdminApi();
  await ensureGatewayHttpServer();
}

/** Wait for Caddy admin API to become responsive (up to 30s) */
async function waitForAdminApi(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${GATEWAY_ADMIN_URL}/config/`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok || resp.status === 404) return; // API is responding
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Caddy gateway admin API did not become ready within 30s");
}

/** Ensure the HTTP server block (listening on GATEWAY_PROXY_PORT) exists in Caddy config.
 *  Uses a singleton promise to prevent concurrent initialization races. */
async function ensureGatewayHttpServer(): Promise<void> {
  if (gatewayConfigured) return;
  if (!gatewayConfigurePromise) {
    gatewayConfigurePromise = doEnsureGatewayHttpServer().then(
      () => {
        gatewayConfigured = true;
      },
      (err) => {
        gatewayConfigurePromise = null;
        throw err;
      },
    );
  }
  return gatewayConfigurePromise;
}

async function doEnsureGatewayHttpServer(): Promise<void> {
  // Check if HTTP server already configured
  try {
    const resp = await fetch(`${GATEWAY_ADMIN_URL}/config/apps/http/servers/srv0`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) return; // Already configured
  } catch {
    /* not configured */
  }

  // Configure HTTP server on proxy port with empty routes array
  const config = {
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [`:${GATEWAY_PROXY_PORT}`],
            routes: [],
          },
        },
      },
    },
  };

  const resp = await fetch(`${GATEWAY_ADMIN_URL}/config/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new Error(`Failed to configure gateway HTTP server: ${resp.status} ${await resp.text()}`);
  }
}

// ─── Route Management ─────────────────────────────────────────────────────────

/**
 * Connect the gateway to the workspace's Docker network and register a Caddy route.
 * Called after the workspace container is healthy and running.
 */
export async function connectWorkspaceToGateway(workspaceId: string): Promise<void> {
  assertValidWorkspaceId(workspaceId);
  const networkName = `clawd-ws-net-${workspaceId}`;
  const containerName = `clawd-ws-${workspaceId}`;

  // Connect gateway to workspace's isolated network so it can resolve the container's DNS name
  try {
    await execFileAsync("docker", ["network", "connect", networkName, GATEWAY_CONTAINER_NAME]);
  } catch (err: any) {
    // "already connected" is not an error
    if (!err.message?.includes("already exists")) throw err;
  }

  // Register route in Caddy: /{workspaceId}/* → clawd-ws-{workspaceId}:6080
  await registerWorkspaceRoute(workspaceId, containerName);
}

/**
 * Remove the workspace route from Caddy and disconnect the gateway from its network.
 * Called during workspace destruction.
 */
export async function disconnectWorkspaceFromGateway(workspaceId: string): Promise<void> {
  assertValidWorkspaceId(workspaceId);
  const networkName = `clawd-ws-net-${workspaceId}`;

  // Both operations are best-effort — workspace may already be stopped
  await Promise.allSettled([
    deregisterWorkspaceRoute(workspaceId).catch((err) =>
      console.warn(`[gateway] route deregister failed for ${workspaceId}:`, err.message),
    ),
    execFileAsync("docker", ["network", "disconnect", networkName, GATEWAY_CONTAINER_NAME]).catch(() => {}),
  ]);
}

/** Register a Caddy reverse-proxy route for a workspace container (idempotent: deletes first) */
async function registerWorkspaceRoute(workspaceId: string, containerName: string): Promise<void> {
  // Delete any pre-existing route first to ensure idempotency (e.g., after Caddy restart reconcile)
  await deregisterWorkspaceRoute(workspaceId).catch(() => {});
  const route = {
    "@id": `ws-${workspaceId}`,
    match: [{ path: [`/${workspaceId}/*`, `/${workspaceId}`] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            handle: [
              {
                handler: "strip_path_prefix",
                prefix: `/${workspaceId}`,
              },
              {
                handler: "reverse_proxy",
                upstreams: [{ dial: `${containerName}:6080` }],
                headers: {
                  request: { set: { Host: [`${containerName}:6080`] } },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  const resp = await fetch(`${GATEWAY_ADMIN_URL}/config/apps/http/servers/srv0/routes/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(route),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new Error(`Failed to register gateway route for ${workspaceId}: ${resp.status} ${await resp.text()}`);
  }
}

/** Remove a Caddy route by its @id */
async function deregisterWorkspaceRoute(workspaceId: string): Promise<void> {
  const resp = await fetch(`${GATEWAY_ADMIN_URL}/id/ws-${workspaceId}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(5000),
  });
  // 404 is fine — route may already be gone
  if (!resp.ok && resp.status !== 404) {
    console.warn(`[gateway] Failed to deregister route for ${workspaceId}: ${resp.status}`);
  }
}

/**
 * Re-register all active workspace routes in Caddy.
 * Call after Caddy restarts to restore routes that were in-memory only.
 */
export async function reconcileGatewayRoutes(workspaceIds: string[]): Promise<void> {
  const valid = workspaceIds.filter((id) => WORKSPACE_ID_RE.test(id));
  if (valid.length === 0) return;
  for (const id of valid) {
    await registerWorkspaceRoute(id, `clawd-ws-${id}`).catch((err) =>
      console.warn(`[gateway] Failed to reconcile route for ${id}:`, err.message),
    );
  }
}
