/**
 * Workspace Container Lifecycle Manager
 *
 * Spawns and manages isolated Docker containers for Claw'd agents.
 * Each container has: Xvfb + fluxbox + Chrome + workspace MCP server.
 *
 * Port pools:
 *   MCP: 6000-6099 (container port 3000) — still host-bound for direct Clawd→MCP communication
 *
 * noVNC (container port 6080) is now proxied exclusively through the Caddy gateway container
 * (clawd-gateway) which joins each workspace's isolated Docker network dynamically.
 * Workspace containers no longer publish noVNC or VNC ports to the host.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import {
  ensureGatewayRunning,
  connectWorkspaceToGateway,
  disconnectWorkspaceFromGateway,
  reconcileGatewayRoutes,
} from "./gateway.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceOptions {
  /** Docker image to use. Default: 'clawd-workspace:base' */
  image?: string;
  /** Host path to mount at /workspace in container */
  projectPath?: string;
  /** Auth token for MCP server. Auto-generated if not provided. */
  authToken?: string;
  /** Container memory limit (default: '1g') */
  memory?: string;
  /** Container CPU limit (default: '1') */
  cpus?: string;
  /** Enable VNC (default: false) */
  vncEnabled?: boolean;
}

export interface WorkspaceHandle {
  id: string;
  containerId: string;
  mcpUrl: string;
  authToken: string;
  mcpPort: number;
  image: string;
  status: "starting" | "running" | "stopped" | "error";
  createdAt: Date;
}

// Port allocation tracking (MCP only; noVNC/VNC ports no longer published to host)
const allocatedPorts = new Set<number>();

/** Check if a TCP port is actually available on the host by trying to bind it */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require("node:net");
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => { server.close(); resolve(true); });
    server.listen(port, "127.0.0.1");
  });
}

async function allocatePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (!allocatedPorts.has(port) && await isPortAvailable(port)) {
      allocatedPorts.add(port);
      return port;
    }
  }
  throw new Error(`No available ports in range ${start}-${end}`);
}

function releasePort(port: number): void {
  allocatedPorts.delete(port);
}

const activeWorkspaces = new Map<string, WorkspaceHandle>();

export async function spawnWorkspace(opts: WorkspaceOptions = {}): Promise<WorkspaceHandle> {
  const image = opts.image || "clawd-workspace:base";
  const authToken = opts.authToken || randomBytes(32).toString("hex");

  // Allocate only MCP port (noVNC/VNC handled by gateway via Docker network DNS)
  let mcpPort: number | undefined;
  try {
    mcpPort = await allocatePort(6000, 6099);
  } catch (err: any) {
    throw new Error(`Failed to allocate workspace port: ${err.message}`);
  }

  const id = randomBytes(8).toString("hex");
  const containerName = `clawd-ws-${id}`;
  // Per-workspace data volume for Chrome profile and TOTP secrets (not shared across workspaces)
  const volumeName = `clawd-ws-data-${id}`;

  // Build docker run command as an argument array (no shell — avoids injection)
  const dockerArgs = [
    "run",
    "-d",
    "--init", // Required: reaps zombie processes from Playwright/subprocesses
    "--name",
    containerName,
    "--user",
    "1000:1000",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--memory",
    opts.memory || "2g",
    "--cpus",
    opts.cpus || "2",
    "--pids-limit",
    // Chrome/Playwright spawns 100+ processes; 200 is insufficient and causes EAGAIN crashes
    "500",
    "--tmpfs",
    "/tmp:size=500m",
    "--network",
    `clawd-ws-net-${id}`, // Per-workspace isolated network
    "-p",
    `127.0.0.1:${mcpPort}:3000`, // MCP: host-bound for direct Clawd→MCP communication
    // noVNC (6080) and VNC (5900) ports are NOT published — accessed via Caddy gateway
    "-e",
    `WORKSPACE_AUTH_TOKEN=${authToken}`,
    "-e",
    `CLAWD_VNC_ENABLED=${opts.vncEnabled ? "true" : "false"}`,
    "-v",
    `${volumeName}:/data`, // Per-workspace volume: Chrome profile + TOTP secrets
  ];

  // Mount project path if provided (path validation only — no shell expansion possible)
  if (opts.projectPath && existsSync(opts.projectPath)) {
    dockerArgs.push("-v", `${opts.projectPath}:/workspace:rw`);
  }

  // Pass only the vision/CPA provider config as env vars — never mount the full credentials file.
  // This prevents containerized code from reading other secrets (auth tokens, keys, etc.).
  const claWdConfigPath = `${process.env.HOME}/.clawd/config.json`;
  if (existsSync(claWdConfigPath)) {
    try {
      const claWdConfig = JSON.parse(readFileSync(claWdConfigPath, "utf-8"));
      const cpa = claWdConfig?.providers?.cpa;
      if (cpa?.base_url) dockerArgs.push("-e", `CLAWD_CPA_BASE_URL=${cpa.base_url}`);
      if (cpa?.api_key) dockerArgs.push("-e", `CLAWD_CPA_API_KEY=${cpa.api_key}`);
      if (cpa?.models) dockerArgs.push("-e", `CLAWD_CPA_MODELS=${JSON.stringify(cpa.models)}`);
    } catch {
      /* ignore parse errors */
    }
  }

  // Pass the chat server URL (reachable from inside Docker via the bridge gateway IP)
  // so workspace-mcp can upload screenshots/files directly to the chat server.
  const chatServerPort = process.env.PORT || "3456";
  // Docker bridge gateway is the host as seen from inside the container.
  // host.docker.internal resolves to host on Docker Desktop; on Linux use the bridge gateway.
  dockerArgs.push("-e", `CLAWD_CHAT_URL=http://host.docker.internal:${chatServerPort}`);
  dockerArgs.push("--add-host", "host.docker.internal:host-gateway");

  dockerArgs.push(image);

  const networkName = `clawd-ws-net-${id}`;
  let containerId: string | undefined;

  try {
    // Ensure gateway is running before spawning the workspace
    await ensureGatewayRunning();

    // Create per-workspace data volume first
    await execFileAsync("docker", ["volume", "create", volumeName]);

    // Create per-workspace isolated network (prevents inter-container communication)
    await execFileAsync("docker", ["network", "create", "--driver", "bridge", networkName]);

    // Use execFile (not exec+join) to avoid shell injection
    const { stdout } = await execFileAsync("docker", dockerArgs);
    containerId = stdout.trim();

    const handle: WorkspaceHandle = {
      id,
      containerId,
      mcpUrl: `http://127.0.0.1:${mcpPort}`,
      authToken,
      mcpPort,
      image,
      status: "starting",
      createdAt: new Date(),
    };

    activeWorkspaces.set(id, handle);

    // Wait for MCP server to be accepting connections
    await waitForHealthy(containerId, mcpPort, 120000);
    handle.status = "running";

    // Connect gateway to this workspace's Docker network and register Caddy route
    // (non-fatal: workspace is functional for MCP even if gateway connect fails)
    await connectWorkspaceToGateway(id).catch((err) =>
      console.warn(`[workspace] Gateway connect failed for ${id}:`, err.message),
    );

    return handle;
  } catch (err: any) {
    // Stop and remove the container if it was started (prevents zombie container holding ports)
    if (containerId) {
      await execFileAsync("docker", ["stop", "--time=5", containerId]).catch(() => {});
      await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => {});
    }
    activeWorkspaces.delete(id);
    releasePort(mcpPort);
    // Clean up data volume and network AFTER container is stopped
    execFileAsync("docker", ["volume", "rm", volumeName]).catch(() => {});
    execFileAsync("docker", ["network", "rm", networkName]).catch(() => {});
    throw new Error(`Failed to spawn workspace: ${err.message}`);
  }
}

async function waitForHealthy(containerId: string, mcpPort: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // First, wait for Docker health check if the image has one
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync("docker", ["inspect", `--format={{.State.Health.Status}}`, containerId]);
      const health = stdout.trim();
      if (health === "healthy") return;
      if (health === "unhealthy") throw new Error("Container reported unhealthy");
      // 'starting' or unknown — fall through to poll
      if (health === "" || health === "<no value>") break; // No HEALTHCHECK — skip to TCP poll
    } catch (e: any) {
      if (e.message.includes("unhealthy")) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // TCP probe: poll until the MCP server responds (with or without auth)
  while (Date.now() < deadline) {
    const isOpen = await probeTcp("127.0.0.1", mcpPort, 1000);
    if (isOpen) {
      // Verify the MCP HTTP server is responding (401 = listening, auth enforced)
      try {
        const resp = await fetch(`http://127.0.0.1:${mcpPort}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"jsonrpc":"2.0","id":0,"method":"ping"}',
          signal: AbortSignal.timeout(2000),
        });
        if (resp.status === 401 || resp.ok) return; // Server is up
      } catch {
        // Not ready yet
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`MCP server on port ${mcpPort} did not respond within ${timeoutMs}ms`);
}

export function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function destroyWorkspace(id: string): Promise<void> {
  const handle = activeWorkspaces.get(id);
  if (!handle) throw new Error(`Workspace not found: ${id}`);

  // Deregister route and disconnect gateway from workspace network
  await disconnectWorkspaceFromGateway(id).catch(() => {});

  // Stop and remove — use rm -f directly to handle containers that can't be stopped gracefully
  try {
    await execFileAsync("docker", ["stop", "--time=5", handle.containerId]);
  } catch {
    // If stop fails (e.g., kernel restrictions), force remove
  }
  await execFileAsync("docker", ["rm", "-f", handle.containerId]);

  // Remove per-workspace data volume and network AFTER container is confirmed gone
  execFileAsync("docker", ["volume", "rm", `clawd-ws-data-${id}`]).catch(() => {});
  execFileAsync("docker", ["network", "rm", `clawd-ws-net-${id}`]).catch(() => {});

  releasePort(handle.mcpPort);
  handle.status = "stopped";
  activeWorkspaces.delete(id);
}

export function getWorkspace(id: string): WorkspaceHandle | undefined {
  return activeWorkspaces.get(id);
}

export function listActiveWorkspaces(): WorkspaceHandle[] {
  return Array.from(activeWorkspaces.values());
}

export async function cleanupOrphanedWorkspaces(): Promise<number> {
  let cleaned = 0;
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      "name=clawd-ws-",
      "--format",
      "{{.Names}}\t{{.Status}}",
    ]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const [name, status] = line.split("\t");
      if (status?.includes("Exited") || status?.includes("Dead")) {
        // Extract id from container name (clawd-ws-<id>)
        const id = name?.replace(/^clawd-ws-/, "");
        await execFileAsync("docker", ["rm", name]).catch(() => {});
        // Also clean up associated volume and network
        if (id) {
          execFileAsync("docker", ["volume", "rm", `clawd-ws-data-${id}`]).catch(() => {});
          execFileAsync("docker", ["network", "rm", `clawd-ws-net-${id}`]).catch(() => {});
        }
        cleaned++;
      }
    }
  } catch {}
  return cleaned;
}

/**
 * Reconcile allocated port set with actually-running clawd containers.
 * Call once at startup to prevent port collisions after process restart.
 * Also re-registers workspace routes in the Caddy gateway (in case it restarted).
 */
export async function reconcilePortsFromDocker(): Promise<void> {
  const discoveredIds: string[] = [];
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "--filter",
      "name=clawd-ws-",
      "--format",
      "{{.Names}}\t{{.Ports}}",
    ]);
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const [name, ports] = line.split("\t");
      // Re-register MCP ports
      if (ports) {
        for (const match of ports.matchAll(/127\.0\.0\.1:(\d+)->/g)) {
          allocatedPorts.add(Number(match[1]));
        }
      }
      // Collect workspace IDs for gateway route reconciliation
      const id = name?.replace(/^clawd-ws-/, "");
      if (id && /^[a-f0-9]{16}$/.test(id)) {
        discoveredIds.push(id);
      }
    }
  } catch {
    // Docker not available or no containers — not an error
  }

  // Re-register routes for discovered workspaces (handles Caddy restart)
  if (discoveredIds.length > 0) {
    await ensureGatewayRunning().catch(() => {});
    await reconcileGatewayRoutes(discoveredIds);
  }
}
