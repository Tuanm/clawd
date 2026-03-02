/**
 * Workspace Tool Plugin
 *
 * Registers spawn_workspace, destroy_workspace, and list_workspaces as agent tools.
 * When the agent calls spawn_workspace, the container's MCP server is
 * automatically registered with the MCPManager so browser-control tools
 * (launch_browser, click, type_text, screenshot, etc.) become available
 * in the next tool call.
 *
 * Security: image and project_path are validated against allowlists before
 * being passed to the container lifecycle manager.
 */

import type { ToolPlugin, ToolRegistration } from '../tools/plugin.js';
import type { ToolResult } from '../tools/tools.js';
import type { MCPManager } from '../mcp/client.js';
import { spawnWorkspace, destroyWorkspace, listActiveWorkspaces } from '../workspace/container.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

/** Permitted Docker images — prevents LLM from pulling arbitrary images */
const ALLOWED_IMAGES = new Set([
  'clawd-workspace:base',
  'clawd-workspace:web3',
  'clawd-workspace:devtools',
  'clawd-workspace:office',
]);

/** Allowed root directories for project_path bind mounts */
const ALLOWED_PROJECT_ROOTS: string[] = [
  `${homedir()}/projects`,
  `${homedir()}/workspace`,
  `${homedir()}/.clawd/workspaces`,
  '/tmp/clawd-workspaces',
];

/** Check if Docker is available */
async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}']);
    return true;
  } catch {
    return false;
  }
}

/** Validate project path — resolve symlinks and check allowed prefix */
function validateProjectPath(p: string): string | null {
  try {
    const resolved = realpathSync(p);
    if (ALLOWED_PROJECT_ROOTS.some(root => resolved.startsWith(root + '/') || resolved === root)) {
      return resolved;
    }
  } catch {}
  return null;
}

export class WorkspaceToolPlugin implements ToolPlugin {
  readonly name = 'workspace';

  /** Track workspace IDs owned by this plugin instance (not global) */
  private readonly ownedWorkspaceIds = new Set<string>();

  constructor(private readonly mcpManager: MCPManager) {}

  getTools(): ToolRegistration[] {
    return [
      {
        name: 'spawn_workspace',
        description: `Spawn an isolated Docker workspace for full desktop control.

The workspace is a headless Ubuntu container with Chromium, clipboard,
file system, and 19 MCP tools for browser automation and UI interaction.
After spawning, tools like launch_browser, click, type_text, screenshot,
clipboard, window_manage, etc. become available immediately.

Args:
  - image: Docker image to use (default: clawd-workspace:base)
    Allowed: clawd-workspace:base | clawd-workspace:web3 (MetaMask + Freighter)
  - project_path: Optional host directory to mount at /workspace
    Must be under ~/projects, ~/workspace, or ~/.clawd/workspaces
  - vnc_enabled: Enable VNC for visual debugging (default: false)

Returns: workspace_id, mcp_url, novnc_url, and available tools list.`,
        parameters: {
          image: {
            type: 'string',
            description: 'Docker image (clawd-workspace:base or clawd-workspace:web3)',
          },
          project_path: {
            type: 'string',
            description: 'Host path to mount at /workspace (must be in ~/projects or ~/.clawd/workspaces)',
          },
          vnc_enabled: {
            type: 'boolean',
            description: 'Enable noVNC for visual inspection (default: false)',
          },
        },
        required: [],
        handler: async (args) => this.handleSpawn(args),
      },
      {
        name: 'destroy_workspace',
        description: `Destroy a workspace container and release all resources.

Stops the Docker container, removes the per-workspace data volume,
releases port allocations, and unregisters all workspace MCP tools.

Call this when the task is complete to avoid resource leaks.

Args:
  - workspace_id: The ID returned by spawn_workspace`,
        parameters: {
          workspace_id: {
            type: 'string',
            description: 'Workspace ID returned by spawn_workspace',
          },
        },
        required: ['workspace_id'],
        handler: async (args) => this.handleDestroy(args),
      },
      {
        name: 'list_workspaces',
        description: `List workspace containers spawned in this session and their status.

Returns workspace IDs, MCP URLs, images, and status.`,
        parameters: {},
        required: [],
        handler: async () => this.handleList(),
      },
    ];
  }

  private async handleSpawn(args: Record<string, any>): Promise<ToolResult> {
    // Enforce single-workspace constraint per agent session.
    // Multiple workspaces cannot be independently addressed (tool names would collide).
    // Destroy the existing workspace first, then spawn a new one.
    if (this.ownedWorkspaceIds.size > 0) {
      return {
        success: false,
        output: '',
        error: `Only one workspace allowed per agent session. Active workspaces: [${[...this.ownedWorkspaceIds].join(', ')}]. ` +
               `Destroy the existing workspace first with destroy_workspace.`,
      };
    }

    const dockerOk = await isDockerAvailable();
    if (!dockerOk) {
      return {
        success: false,
        output: '',
        error: 'Docker is not available on this host. Install Docker and ensure the daemon is running.',
      };
    }

    // Validate image against allowlist
    const image = (args.image as string) || 'clawd-workspace:base';
    if (!ALLOWED_IMAGES.has(image)) {
      return {
        success: false,
        output: '',
        error: `Image not permitted: "${image}". Allowed images: ${[...ALLOWED_IMAGES].join(', ')}`,
      };
    }

    // Validate project_path if provided
    let projectPath: string | undefined;
    if (args.project_path) {
      const validated = validateProjectPath(args.project_path as string);
      if (!validated) {
        return {
          success: false,
          output: '',
          error: `project_path resolved outside allowed roots: ${ALLOWED_PROJECT_ROOTS.join(', ')}. ` +
                 `Symlinks are resolved before checking. Got: ${args.project_path}`,
        };
      }
      projectPath = validated;
    }

    let handle;
    try {
      handle = await spawnWorkspace({
        image,
        projectPath,
        vncEnabled: (args.vnc_enabled as boolean) ?? false,
      });
    } catch (spawnErr: any) {
      return {
        success: false,
        output: '',
        error: `Failed to spawn workspace: ${spawnErr.message}`,
      };
    }

    // Register workspace MCP server so its 19 tools become available
    const serverName = `workspace-${handle.id}`;
    try {
      await this.mcpManager.addServer({
        name: serverName,
        url: handle.mcpUrl,
        transport: 'http',
        token: handle.authToken,
      });
    } catch (mcpErr: any) {
      // MCP registration failed — destroy the container to avoid leaking resources
      await destroyWorkspace(handle.id).catch(() => {});
      return {
        success: false,
        output: '',
        error: `Workspace spawned but MCP registration failed: ${mcpErr.message}. Container destroyed. Try again.`,
      };
    }

    // Track this workspace as owned by this plugin instance
    this.ownedWorkspaceIds.add(handle.id);

    // Get the list of registered workspace tools
    const tools = this.mcpManager.getAllTools()
      .filter((t) => t.server === serverName)
      .map((t) => t.tool.name);

    return {
      success: true,
      output: JSON.stringify({
        ok: true,
        workspace_id: handle.id,
        mcp_url: handle.mcpUrl,
        novnc_url: `/workspace/${handle.id}/novnc/`,
        image: handle.image,
        workspace_tools: tools,
        message: `Workspace ready. ${tools.length} tools available: ${tools.join(', ')}`,
      }),
    };
  }

  private async handleDestroy(args: Record<string, any>): Promise<ToolResult> {
    const workspaceId = args.workspace_id as string;

    // Only allow destroying workspaces owned by this plugin instance
    if (!this.ownedWorkspaceIds.has(workspaceId)) {
      return {
        success: false,
        output: '',
        error: `Workspace ${workspaceId} was not created by this session. Cannot destroy.`,
      };
    }

    const serverName = `workspace-${workspaceId}`;

    try {
      // Destroy container first — only remove MCP server after container is confirmed gone
      await destroyWorkspace(workspaceId);
      this.ownedWorkspaceIds.delete(workspaceId);
      await this.mcpManager.removeServer(serverName).catch(() => {});
      return {
        success: true,
        output: JSON.stringify({
          ok: true,
          message: `Workspace ${workspaceId} destroyed and resources freed.`,
        }),
      };
    } catch (err: any) {
      return {
        success: false,
        output: '',
        error: `Failed to destroy workspace ${workspaceId}: ${err.message}`,
      };
    }
  }

  private async handleList(): Promise<ToolResult> {
    // Only list workspaces owned by this plugin instance (not global)
    const ownedIds = this.ownedWorkspaceIds;
    const workspaces = listActiveWorkspaces().filter((h) => ownedIds.has(h.id));
    return {
      success: true,
      output: JSON.stringify({
        ok: true,
        workspaces: workspaces.map((h) => ({
          id: h.id,
          image: h.image,
          status: h.status,
          mcp_url: h.mcpUrl,
          novnc_url: `/workspace/${h.id}/novnc/`,
          created_at: h.createdAt.toISOString(),
        })),
        count: workspaces.length,
      }),
    };
  }

  async destroy(): Promise<void> {
    // Only destroy workspaces this plugin instance created
    await Promise.allSettled(
      Array.from(this.ownedWorkspaceIds).map(async (id) => {
        const serverName = `workspace-${id}`;
        await destroyWorkspace(id).catch(() => {});
        await this.mcpManager.removeServer(serverName).catch(() => {});
      }),
    );
    this.ownedWorkspaceIds.clear();
  }
}

