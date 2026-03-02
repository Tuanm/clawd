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

import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

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
    '--network', 'bridge', // Use bridge for now; production: per-workspace network
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

  // Mount clawd config read-only for vision provider access
  const configPath = `${process.env.HOME}/.clawd/config.json`;
  if (existsSync(configPath)) {
    dockerArgs.push('-v', `${configPath}:/etc/clawd/config.json:ro`);
  }

  dockerArgs.push(image);

  try {
    // Create per-workspace data volume first
    await execFileAsync('docker', ['volume', 'create', volumeName]);

    // Use execFile (not exec+join) to avoid shell injection
    const { stdout } = await execFileAsync('docker', dockerArgs);
    const containerId = stdout.trim();

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

    // Wait for container to be healthy
    await waitForHealthy(containerId, 120000);
    handle.status = 'running';

    return handle;
  } catch (err: any) {
    releasePort(mcpPort);
    releasePort(novncPort);
    releasePort(vncPort);
    // Clean up the data volume if container failed to start
    execFileAsync('docker', ['volume', 'rm', volumeName]).catch(() => {});
    throw new Error(`Failed to spawn workspace: ${err.message}`);
  }
}

async function waitForHealthy(containerId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect', `--format={{.State.Health.Status}}`, containerId,
      ]);
      const health = stdout.trim();
      if (health === 'healthy') return;
      // Image has no HEALTHCHECK — fall back to brief startup delay
      if (health === '' || health === '<no value>') {
        await new Promise(r => setTimeout(r, 3000));
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Container ${containerId} did not become healthy within ${timeoutMs}ms`);
}

export async function destroyWorkspace(id: string): Promise<void> {
  const handle = activeWorkspaces.get(id);
  if (!handle) throw new Error(`Workspace not found: ${id}`);

  try {
    await execFileAsync('docker', ['stop', handle.containerId]);
    await execFileAsync('docker', ['rm', handle.containerId]);
  } catch (e: any) {
    console.warn(`[workspace] Failed to cleanly stop container: ${e.message}`);
  }

  // Remove per-workspace data volume
  execFileAsync('docker', ['volume', 'rm', `clawd-ws-data-${id}`]).catch(() => {});

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
    const { stdout } = await execAsync('docker ps -a --filter "name=clawd-ws-" --format "{{.Names}}\t{{.Status}}"');
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const [name, status] = line.split('\t');
      if (status?.includes('Exited') || status?.includes('Dead')) {
        await execFileAsync('docker', ['rm', name]).catch(() => {});
        cleaned++;
      }
    }
  } catch {}
  return cleaned;
}
