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

import type { ToolPlugin, ToolRegistration } from "../tools/plugin.js";
import type { ToolResult } from "../tools/tools.js";
import type { MCPManager } from "../mcp/client.js";
import { spawnWorkspace, destroyWorkspace, listActiveWorkspaces, getWorkspace } from "../workspace/container.js";
import { getAgentContext } from "../utils/agent-context.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

/**
 * Build a deterministic workspace ID from channel + agentId.
 * Result: lowercase slug, max 48 chars, no leading/trailing hyphens.
 * E.g. "demo-agent-workspace" + "Tuan" → "demo-agent-workspace-tuan"
 */
function makeWorkspaceId(channel: string, agentId: string): string {
  const raw = `${channel}-${agentId}`.toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "default";
}

/** Permitted Docker images — prevents LLM from pulling arbitrary images */
const ALLOWED_IMAGES = new Set([
  "clawd-workspace:base",
  "clawd-workspace:web3",
  "clawd-workspace:devtools",
  "clawd-workspace:office",
]);

/** Allowed root directories for project_path bind mounts */
const ALLOWED_PROJECT_ROOTS: string[] = [
  `${homedir()}/projects`,
  `${homedir()}/workspace`,
  `${homedir()}/.clawd/workspaces`,
  "/tmp/clawd-workspaces",
];

/** Check if Docker is available */
async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"]);
    return true;
  } catch {
    return false;
  }
}

/** Validate project path — resolve symlinks and check allowed prefix */
function validateProjectPath(p: string): string | null {
  try {
    const resolved = realpathSync(p);
    if (ALLOWED_PROJECT_ROOTS.some((root) => resolved.startsWith(root + "/") || resolved === root)) {
      return resolved;
    }
  } catch {}
  return null;
}

export class WorkspaceToolPlugin implements ToolPlugin {
  readonly name = "workspace";

  /** Track workspace IDs owned by this plugin instance (not global) */
  private readonly ownedWorkspaceIds = new Set<string>();

  /**
   * Promise that resolves once existing workspaces from a prior agent run have been
   * re-registered into this MCPManager instance.  Awaited by every handler so tools
   * are available before the first user-visible action.
   */
  private readonly reconnectReady: Promise<void>;

  constructor(private readonly mcpManager: MCPManager) {
    this.reconnectReady = this.reconnectExisting();
  }

  /**
   * Re-register any workspace containers that are still running from a previous
   * agent run in the same process.  The global activeWorkspaces map (in container.ts)
   * persists across Agent instances, so we can restore MCP connectivity without
   * re-spawning.
   */
  private async reconnectExisting(): Promise<void> {
    const existing = listActiveWorkspaces();
    for (const handle of existing) {
      const serverName = `workspace-${handle.id}`;
      try {
        await this.mcpManager.addServer({
          name: serverName,
          url: handle.mcpUrl,
          transport: "http",
          token: handle.authToken,
        });
        this.ownedWorkspaceIds.add(handle.id);
      } catch {
        // Server may already be registered or container unreachable — skip
      }
    }
  }

  getTools(): ToolRegistration[] {
    return [
      {
        name: "spawn_workspace",
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

Returns: workspace_id and available tools list.
After spawning, immediately send a workspace card to the user with chat_send_message using the workspace_json parameter (include workspace_id). Do NOT include any URLs or paths in messages — the workspace card handles navigation.`,
        parameters: {
          image: {
            type: "string",
            description: "Docker image (clawd-workspace:base or clawd-workspace:web3)",
          },
          project_path: {
            type: "string",
            description: "Host path to mount at /workspace (must be in ~/projects or ~/.clawd/workspaces)",
          },
          vnc_enabled: {
            type: "boolean",
            description: "Enable noVNC for visual inspection (default: false)",
          },
        },
        required: [],
        handler: async (args) => this.handleSpawn(args),
      },
      {
        name: "destroy_workspace",
        description: `Destroy a workspace container and release all resources.

Stops the Docker container, removes the per-workspace data volume,
releases port allocations, and unregisters all workspace MCP tools.

Call this when the task is complete to avoid resource leaks.

Args:
  - workspace_id: The ID returned by spawn_workspace`,
        parameters: {
          workspace_id: {
            type: "string",
            description: "Workspace ID returned by spawn_workspace",
          },
        },
        required: ["workspace_id"],
        handler: async (args) => this.handleDestroy(args),
      },
      {
        name: "list_workspaces",
        description: `List workspace containers spawned in this session and their status.

Returns workspace IDs, images, status, and creation time.`,
        parameters: {},
        required: [],
        handler: async () => this.handleList(),
      },
    ];
  }

  private async handleSpawn(args: Record<string, any>): Promise<ToolResult> {
    await this.reconnectReady;

    // Compute deterministic workspace ID from channel + agentId context
    const ctx = getAgentContext();
    const workspaceId = makeWorkspaceId(ctx?.channel || "default", ctx?.agentId || "agent");

    // Idempotent: if the workspace for this agent already exists, reconnect and return it
    if (this.ownedWorkspaceIds.has(workspaceId)) {
      const existing = getWorkspace(workspaceId);
      if (existing && existing.status === "running") {
        const serverName = `workspace-${workspaceId}`;
        const tools = this.mcpManager
          .getAllTools()
          .filter((t) => t.server === serverName)
          .map((t) => t.tool.name);
        return {
          success: true,
          output: JSON.stringify({
            ok: true,
            workspace_id: workspaceId,
            image: existing.image,
            workspace_tools: tools,
            message: `Existing workspace restored. ${tools.length} tools available: ${tools.join(", ")}.`,
          }),
        };
      }
    }

    const dockerOk = await isDockerAvailable();
    if (!dockerOk) {
      return {
        success: false,
        output: "",
        error: "Docker is not available on this host. Install Docker and ensure the daemon is running.",
      };
    }

    // Validate image against allowlist
    const image = (args.image as string) || "clawd-workspace:base";
    if (!ALLOWED_IMAGES.has(image)) {
      return {
        success: false,
        output: "",
        error: `Image not permitted: "${image}". Allowed images: ${[...ALLOWED_IMAGES].join(", ")}`,
      };
    }

    // Validate project_path if provided
    let projectPath: string | undefined;
    if (args.project_path) {
      const validated = validateProjectPath(args.project_path as string);
      if (!validated) {
        return {
          success: false,
          output: "",
          error:
            `project_path resolved outside allowed roots: ${ALLOWED_PROJECT_ROOTS.join(", ")}. ` +
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
        id: workspaceId,
      });
    } catch (spawnErr: any) {
      return {
        success: false,
        output: "",
        error: `Failed to spawn workspace: ${spawnErr.message}`,
      };
    }

    // Register workspace MCP server so its 19 tools become available
    const serverName = `workspace-${handle.id}`;
    try {
      await this.mcpManager.addServer({
        name: serverName,
        url: handle.mcpUrl,
        transport: "http",
        token: handle.authToken,
      });
    } catch (mcpErr: any) {
      // MCP registration failed — destroy the container to avoid leaking resources
      await destroyWorkspace(handle.id).catch(() => {});
      return {
        success: false,
        output: "",
        error: `Workspace spawned but MCP registration failed: ${mcpErr.message}. Container destroyed. Try again.`,
      };
    }

    // Track this workspace as owned by this plugin instance
    this.ownedWorkspaceIds.add(handle.id);

    // Get the list of registered workspace tools
    const tools = this.mcpManager
      .getAllTools()
      .filter((t) => t.server === serverName)
      .map((t) => t.tool.name);

    return {
      success: true,
      output: JSON.stringify({
        ok: true,
        workspace_id: handle.id,
        image: handle.image,
        workspace_tools: tools,
        message: `Workspace ready. ${tools.length} tools available: ${tools.join(", ")}. Send a workspace card to the user using chat_send_message with workspace_json parameter.`,
      }),
    };
  }

  private async handleDestroy(args: Record<string, any>): Promise<ToolResult> {
    await this.reconnectReady;
    const workspaceId = args.workspace_id as string;

    // Only allow destroying workspaces owned by this plugin instance
    if (!this.ownedWorkspaceIds.has(workspaceId)) {
      return {
        success: false,
        output: "",
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
        output: "",
        error: `Failed to destroy workspace ${workspaceId}: ${err.message}`,
      };
    }
  }

  private async handleList(): Promise<ToolResult> {
    await this.reconnectReady;
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
          created_at: h.createdAt.toISOString(),
        })),
        count: workspaces.length,
      }),
    };
  }

  async destroy(): Promise<void> {
    // Do NOT destroy workspace containers here — they must persist across agent runs
    // so the user can keep using the noVNC desktop between messages.
    // Containers are only destroyed via explicit destroy_workspace tool calls
    // or when the worker process exits.
    // Just disconnect MCP servers so this plugin instance can be garbage-collected.
    for (const id of this.ownedWorkspaceIds) {
      await this.mcpManager.removeServer(`workspace-${id}`).catch(() => {});
    }
    this.ownedWorkspaceIds.clear();
  }
}
