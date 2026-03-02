/**
 * Workspace Container Lifecycle Manager
 *
 * Spawns and manages isolated Docker containers for Claw'd agents.
 * Each container has: Xvfb + fluxbox + Chrome + workspace MCP server.
 *
 * Port pools:
 *   MCP:   6000-6099 (container port 3000)
 *   noVNC: 7000-7099 (container port 6080)
 *   VNC:   5900-5999 (container port 5900)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';

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
  novncPort: number;
  vncPort: number;
  image: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  createdAt: Date;
}

// Port allocation tracking
const allocatedPorts = new Set<number>();

function allocatePort(start: number, end: number): number {
  for (let port = start; port <= end; port++) {
    if (!allocatedPorts.has(port)) {
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
  const image = opts.image || 'clawd-workspace:base';
  const authToken = opts.authToken || randomBytes(32).toString('hex');

  // Allocate all three ports; release them all if any fails
  let mcpPort: number | undefined;
  let novncPort: number | undefined;
  let vncPort: number | undefined;
  try {
    mcpPort = allocatePort(6000, 6099);
    novncPort = allocatePort(7000, 7099);
    vncPort = allocatePort(5900, 5999);
  } catch (err: any) {
    if (mcpPort !== undefined) releasePort(mcpPort);
    if (novncPort !== undefined) releasePort(novncPort);
    throw new Error(`Failed to allocate workspace ports: ${err.message}`);
  }

  const id = randomBytes(8).toString('hex');
  const containerName = `clawd-ws-${id}`;
  // Per-workspace data volume for Chrome profile and TOTP secrets (not shared across workspaces)
  const volumeName = `clawd-ws-data-${id}`;

  // Build docker run command as an argument array (no shell — avoids injection)
  const dockerArgs = [
    'run', '-d',
    '--init',  // Required: reaps zombie processes from Playwright/subprocesses
    '--name', containerName,
    '--user', '1000:1000',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--memory', opts.memory || '1g',
    '--cpus', opts.cpus || '1',
    '--pids-limit', '200',
    '--tmpfs', '/tmp:size=500m',
    '--network', `clawd-ws-net-${id}`, // Per-workspace isolated network
    '-p', `127.0.0.1:${mcpPort}:3000`,
    '-p', `127.0.0.1:${novncPort}:6080`,
    '-p', `127.0.0.1:${vncPort}:5900`,
    '-e', `WORKSPACE_AUTH_TOKEN=${authToken}`,
    '-e', `CLAWD_VNC_ENABLED=${opts.vncEnabled ? 'true' : 'false'}`,
    '-v', `${volumeName}:/data`, // Per-workspace volume: Chrome profile + TOTP secrets
  ];

  // Mount project path if provided (path validation only — no shell expansion possible)
  if (opts.projectPath && existsSync(opts.projectPath)) {
    dockerArgs.push('-v', `${opts.projectPath}:/workspace:rw`);
  }

  // Pass only the vision/CPA provider config as env vars — never mount the full credentials file.
  // This prevents containerized code from reading other secrets (auth tokens, keys, etc.).
  const claWdConfigPath = `${process.env.HOME}/.clawd/config.json`;
  if (existsSync(claWdConfigPath)) {
    try {
      const claWdConfig = JSON.parse(readFileSync(claWdConfigPath, 'utf-8'));
      const cpa = claWdConfig?.providers?.cpa;
      if (cpa?.base_url) dockerArgs.push('-e', `CLAWD_CPA_BASE_URL=${cpa.base_url}`);
      if (cpa?.api_key) dockerArgs.push('-e', `CLAWD_CPA_API_KEY=${cpa.api_key}`);
      if (cpa?.models) dockerArgs.push('-e', `CLAWD_CPA_MODELS=${JSON.stringify(cpa.models)}`);
    } catch { /* ignore parse errors */ }
  }

  dockerArgs.push(image);

  const networkName = `clawd-ws-net-${id}`;
  let containerId: string | undefined;

  try {
    // Create per-workspace data volume first
    await execFileAsync('docker', ['volume', 'create', volumeName]);

    // Create per-workspace isolated network (prevents inter-container communication)
    await execFileAsync('docker', ['network', 'create', '--driver', 'bridge', networkName]);

    // Use execFile (not exec+join) to avoid shell injection
    const { stdout } = await execFileAsync('docker', dockerArgs);
    containerId = stdout.trim();

    const handle: WorkspaceHandle = {
      id,
      containerId,
      mcpUrl: `http://127.0.0.1:${mcpPort}`,
      authToken,
      mcpPort,
      novncPort,
      vncPort,
      image,
      status: 'starting',
      createdAt: new Date(),
    };

    activeWorkspaces.set(id, handle);

    // Wait for MCP server to be accepting connections
    await waitForHealthy(containerId, mcpPort, 120000);
    handle.status = 'running';

    return handle;
  } catch (err: any) {
    // Stop and remove the container if it was started (prevents zombie container holding ports)
    if (containerId) {
      await execFileAsync('docker', ['stop', containerId]).catch(() => {});
      await execFileAsync('docker', ['rm', containerId]).catch(() => {});
    }
    activeWorkspaces.delete(id);
    releasePort(mcpPort);
    releasePort(novncPort);
    releasePort(vncPort);
    // Clean up data volume and network AFTER container is stopped
    execFileAsync('docker', ['volume', 'rm', volumeName]).catch(() => {});
    execFileAsync('docker', ['network', 'rm', networkName]).catch(() => {});
    throw new Error(`Failed to spawn workspace: ${err.message}`);
  }
}

async function waitForHealthy(containerId: string, mcpPort: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // First, wait for Docker health check if the image has one
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect', `--format={{.State.Health.Status}}`, containerId,
      ]);
      const health = stdout.trim();
      if (health === 'healthy') return;
      if (health === 'unhealthy') throw new Error('Container reported unhealthy');
      // 'starting' or unknown — fall through to poll
      if (health === '' || health === '<no value>') break; // No HEALTHCHECK — skip to TCP poll
    } catch (e: any) {
      if (e.message.includes('unhealthy')) throw e;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // TCP probe: poll until the MCP server responds (with or without auth)
  while (Date.now() < deadline) {
    const isOpen = await probeTcp('127.0.0.1', mcpPort, 1000);
    if (isOpen) {
      // Verify the MCP HTTP server is responding (401 = listening, auth enforced)
      try {
        const resp = await fetch(`http://127.0.0.1:${mcpPort}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"jsonrpc":"2.0","id":0,"method":"ping"}',
          signal: AbortSignal.timeout(2000),
        });
        if (resp.status === 401 || resp.ok) return; // Server is up
      } catch {
        // Not ready yet
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`MCP server on port ${mcpPort} did not respond within ${timeoutMs}ms`);
}

export function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

export async function destroyWorkspace(id: string): Promise<void> {
  const handle = activeWorkspaces.get(id);
  if (!handle) throw new Error(`Workspace not found: ${id}`);

  // Stop and remove — throw on failure so ports/tracking aren't freed prematurely
  await execFileAsync('docker', ['stop', handle.containerId]);
  await execFileAsync('docker', ['rm', handle.containerId]);

  // Remove per-workspace data volume and network AFTER container is confirmed gone
  execFileAsync('docker', ['volume', 'rm', `clawd-ws-data-${id}`]).catch(() => {});
  execFileAsync('docker', ['network', 'rm', `clawd-ws-net-${id}`]).catch(() => {});

  releasePort(handle.mcpPort);
  releasePort(handle.novncPort);
  releasePort(handle.vncPort);
  handle.status = 'stopped';
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
    const { stdout } = await execFileAsync('docker', [
      'ps', '-a', '--filter', 'name=clawd-ws-',
      '--format', '{{.Names}}\t{{.Status}}',
    ]);
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const [name, status] = line.split('\t');
      if (status?.includes('Exited') || status?.includes('Dead')) {
        // Extract id from container name (clawd-ws-<id>)
        const id = name?.replace(/^clawd-ws-/, '');
        await execFileAsync('docker', ['rm', name]).catch(() => {});
        // Also clean up associated volume and network
        if (id) {
          execFileAsync('docker', ['volume', 'rm', `clawd-ws-data-${id}`]).catch(() => {});
          execFileAsync('docker', ['network', 'rm', `clawd-ws-net-${id}`]).catch(() => {});
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
 */
export async function reconcilePortsFromDocker(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'ps', '--filter', 'name=clawd-ws-',
      '--format', '{{.Ports}}',
    ]);
    for (const portLine of stdout.trim().split('\n').filter(Boolean)) {
      for (const match of portLine.matchAll(/127\.0\.0\.1:(\d+)->/g)) {
        allocatedPorts.add(Number(match[1]));
      }
    }
  } catch {
    // Docker not available or no containers — not an error
  }
}
