/**
 * Cloudflare Quick Tunnel Plugin
 *
 * Provides tools to expose local endpoints to the internet via
 * `cloudflared tunnel --url <local-url>`. Tunnels are tracked in-memory
 * and cleaned up on plugin destroy.
 *
 * Tools:
 *   - tunnel_create  — start a quick tunnel for a local URL
 *   - tunnel_destroy — stop a running tunnel
 *   - tunnel_list    — list all active tunnels
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { ToolPlugin, ToolRegistration } from "../tools/plugin.js";
import type { ToolResult } from "../tools/tools.js";

// ============================================================================
// Types
// ============================================================================

interface TunnelRecord {
  id: string;
  localUrl: string;
  publicUrl: string;
  pid: number;
  process: ChildProcess;
  createdAt: number;
  metricsPort?: number;
}

// ============================================================================
// Plugin
// ============================================================================

export class TunnelPlugin implements ToolPlugin {
  readonly name = "tunnel";
  private tunnels = new Map<string, TunnelRecord>();
  private idCounter = 0;

  getTools(): ToolRegistration[] {
    return [
      {
        name: "tunnel_create",
        description:
          "Create a Cloudflare Quick Tunnel to expose a local endpoint to the internet. " +
          "Returns a public *.trycloudflare.com URL. No Cloudflare account required. " +
          "The tunnel stays alive until explicitly destroyed or the agent session ends.",
        parameters: {
          url: {
            type: "string",
            description: 'Local URL to expose, e.g. "http://localhost:3000" or "http://127.0.0.1:8080"',
          },
          label: {
            type: "string",
            description: "Optional human-readable label for this tunnel",
          },
        },
        required: ["url"],
        handler: async (args) => this.handleCreate(args),
      },
      {
        name: "tunnel_destroy",
        description: "Stop and remove a running Cloudflare Quick Tunnel by its ID.",
        parameters: {
          id: {
            type: "string",
            description: "Tunnel ID returned by tunnel_create (e.g. tunnel-1)",
          },
        },
        required: ["id"],
        handler: async (args) => this.handleDestroy(args),
      },
      {
        name: "tunnel_list",
        description: "List all active Cloudflare Quick Tunnels with their public URLs, local URLs, and uptime.",
        parameters: {},
        required: [],
        handler: async () => this.handleList(),
      },
    ];
  }

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private async handleCreate(args: Record<string, any>): Promise<ToolResult> {
    const localUrl = args.url as string;
    if (!localUrl) {
      return { success: false, output: "", error: "url is required" };
    }

    // Validate URL format
    try {
      const parsed = new URL(localUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { success: false, output: "", error: "URL must use http:// or https:// protocol" };
      }
    } catch {
      return { success: false, output: "", error: `Invalid URL: ${localUrl}` };
    }

    // Check cloudflared availability
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("cloudflared", ["--version"], { timeout: 5000 });
    } catch {
      return {
        success: false,
        output: "",
        error:
          "cloudflared is not installed. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
      };
    }

    const id = args.label ? `tunnel-${this.slugify(args.label)}` : `tunnel-${++this.idCounter}`;
    if (this.tunnels.has(id)) {
      return {
        success: false,
        output: "",
        error: `Tunnel "${id}" already exists. Destroy it first or use a different label.`,
      };
    }

    try {
      const publicUrl = await this.startTunnel(id, localUrl);
      const record = this.tunnels.get(id)!;
      return {
        success: true,
        output: JSON.stringify({
          id,
          public_url: publicUrl,
          local_url: localUrl,
          pid: record.pid,
          message: `Tunnel created. Public URL: ${publicUrl}`,
        }),
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Failed to create tunnel: ${err?.message || err}`,
      };
    }
  }

  private async handleDestroy(args: Record<string, any>): Promise<ToolResult> {
    const id = args.id as string;
    if (!id) {
      return { success: false, output: "", error: "id is required" };
    }

    const record = this.tunnels.get(id);
    if (!record) {
      const available = [...this.tunnels.keys()];
      return {
        success: false,
        output: "",
        error: `Tunnel "${id}" not found. Active tunnels: ${available.length > 0 ? available.join(", ") : "none"}`,
      };
    }

    this.killTunnel(record);
    this.tunnels.delete(id);

    return {
      success: true,
      output: JSON.stringify({
        id,
        message: `Tunnel "${id}" destroyed (was exposing ${record.localUrl} at ${record.publicUrl})`,
      }),
    };
  }

  private async handleList(): Promise<ToolResult> {
    const now = Date.now();
    const list = [...this.tunnels.values()].map((t) => ({
      id: t.id,
      public_url: t.publicUrl,
      local_url: t.localUrl,
      pid: t.pid,
      uptime_seconds: Math.round((now - t.createdAt) / 1000),
    }));

    return {
      success: true,
      output: JSON.stringify({
        count: list.length,
        tunnels: list,
      }),
    };
  }

  // --------------------------------------------------------------------------
  // Tunnel lifecycle
  // --------------------------------------------------------------------------

  private startTunnel(id: string, localUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("cloudflared", ["tunnel", "--url", localUrl, "--no-autoupdate"], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      let stderr = "";
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.killTunnel({ process: proc } as TunnelRecord);
          reject(new Error("Tunnel creation timed out after 30s. cloudflared stderr:\n" + stderr));
        }
      }, 30_000);

      // cloudflared prints the URL to stderr
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = stderr.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timeout);

          const metricsMatch = stderr.match(/metrics server on ([\d.:]+)\/metrics/);
          const record: TunnelRecord = {
            id,
            localUrl,
            publicUrl: match[0],
            pid: proc.pid!,
            process: proc,
            createdAt: Date.now(),
            metricsPort: metricsMatch ? parseInt(metricsMatch[1].split(":").pop()!) : undefined,
          };
          this.tunnels.set(id, record);

          // Auto-cleanup if process exits unexpectedly
          proc.on("exit", () => {
            this.tunnels.delete(id);
          });

          // Unref so the tunnel doesn't prevent agent from exiting
          proc.unref();

          resolve(match[0]);
        }
      });

      proc.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      });

      proc.on("exit", (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`cloudflared exited with code ${code}. stderr:\n${stderr}`));
        }
      });
    });
  }

  private killTunnel(record: TunnelRecord): void {
    try {
      // Kill the process group (detached process)
      if (record.process.pid) {
        process.kill(-record.process.pid, "SIGTERM");
      }
    } catch {
      // Process may already be dead
      try {
        record.process.kill("SIGTERM");
      } catch {
        // Ignore
      }
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  async destroy(): Promise<void> {
    for (const record of this.tunnels.values()) {
      this.killTunnel(record);
    }
    this.tunnels.clear();
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private slugify(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32);
  }
}
