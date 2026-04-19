/**
 * Cloudflare Quick Tunnel Plugin — thin adapter over TmuxTunnelManager.
 *
 * Behavior changes from the pre-tmux implementation:
 *   - Tunnels are tmux-backed and survive Claw'd restart.
 *   - `tunnel_create` dedupes by localUrl (global pool). If another tunnel is
 *     already exposing the same local URL, the existing tunnel is returned
 *     with `reused: true` instead of spawning a second cloudflared process.
 *   - `tunnel_destroy` works across agents (global-pool semantics).
 *   - New `tunnel_prune` tool sweeps dead / old / owner-scoped tunnels.
 *
 * Ownership context: when instantiated by worker-loop the `channel` and
 * `agentId` passed to the constructor are recorded in meta.json so
 * tunnel_list / tunnel_prune can filter by owner. The MCP HTTP handler for
 * CC agents constructs the plugin with the request's channel+agent too.
 *
 * Tools:
 *   - tunnel_create  — start a quick tunnel for a local URL (idempotent)
 *   - tunnel_destroy — stop a running tunnel by id
 *   - tunnel_list    — enumerate tunnels (optionally filtered)
 *   - tunnel_prune   — bulk-destroy by owner / age / status
 */

import type { ToolResult } from "../tools/definitions";
import type { ToolPlugin, ToolRegistration } from "../tools/plugin";
import { type PruneFilter, type TunnelStatus, tunnelManager } from "./tunnel-manager";

const VALID_STATUSES: readonly TunnelStatus[] = ["running", "reconnecting", "dead"];

// ============================================================================
// Plugin
// ============================================================================

export class TunnelPlugin implements ToolPlugin {
  readonly name = "tunnel";
  private readonly channel?: string;
  private readonly agentId?: string;

  /** Constructor takes optional owner context. Non-CC worker-loop passes it
   *  via `createTunnelPlugin(channel, agentId)` below; CC MCP handler does
   *  the same on each request. */
  constructor(channel?: string, agentId?: string) {
    this.channel = channel;
    this.agentId = agentId;
  }

  getTools(): ToolRegistration[] {
    return [
      {
        name: "tunnel_create",
        description:
          "Create a Cloudflare Quick Tunnel to expose a local endpoint to the internet. " +
          "Returns a public *.trycloudflare.com URL. No Cloudflare account required. " +
          "Tunnels survive Claw'd server restart (tmux-backed). " +
          "If a tunnel already exists for the same local URL, it is returned (reused=true) " +
          "instead of creating a second cloudflared process.",
        parameters: {
          url: {
            type: "string",
            description: 'Local URL to expose, e.g. "http://localhost:3000" or "http://127.0.0.1:8080"',
          },
        },
        required: ["url"],
        handler: async (args) => this.handleCreate(args),
      },
      {
        name: "tunnel_destroy",
        description:
          "Stop and remove a running Cloudflare Quick Tunnel by its id. " +
          "Works across agents — any agent can destroy any tunnel.",
        parameters: {
          id: {
            type: "string",
            description: "Tunnel id returned by tunnel_create",
          },
        },
        required: ["id"],
        handler: async (args) => this.handleDestroy(args),
      },
      {
        name: "tunnel_list",
        description:
          "List Cloudflare Quick Tunnels with their public/local URLs, status (running/reconnecting/dead), " +
          "uptime, and owner (channel + agent). Optional filters narrow the result.",
        parameters: {
          mine: {
            type: "boolean",
            description: "If true, return only tunnels this agent created (default: false — show all).",
          },
          channel: {
            type: "string",
            description: "Filter by owner channel.",
          },
          local_url: {
            type: "string",
            description: "Filter by local URL (exact match).",
          },
          status: {
            type: "string",
            description: "Filter by status: running | reconnecting | dead",
          },
        },
        required: [],
        handler: async (args) => this.handleList(args),
      },
      {
        name: "tunnel_prune",
        description:
          "Bulk-destroy tunnels matching a filter. Useful to reap dead tunnels or clean up after a channel. " +
          "At least one filter is required to prevent accidental wipes.",
        parameters: {
          dead_only: {
            type: "boolean",
            description: "Only destroy tunnels whose tmux session is gone (dead status).",
          },
          older_than_seconds: {
            type: "number",
            description: "Only destroy tunnels older than this many seconds since creation.",
          },
          local_url: {
            type: "string",
            description: "Only destroy tunnels for this local URL.",
          },
          channel: {
            type: "string",
            description: "Only destroy tunnels owned by this channel.",
          },
          agent_id: {
            type: "string",
            description: "Only destroy tunnels owned by this agent.",
          },
        },
        required: [],
        handler: async (args) => this.handlePrune(args),
      },
    ];
  }

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private async handleCreate(args: Record<string, any>): Promise<ToolResult> {
    const localUrl = args.url as string;
    if (!localUrl) return { success: false, output: "", error: "url is required" };

    try {
      const parsed = new URL(localUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { success: false, output: "", error: "URL must use http:// or https:// protocol" };
      }
    } catch {
      return { success: false, output: "", error: `Invalid URL: ${localUrl}` };
    }

    try {
      const result = await tunnelManager.create({
        localUrl,
        channel: this.channel,
        agentId: this.agentId,
      });
      return {
        success: true,
        output: JSON.stringify({
          id: result.id,
          public_url: result.publicUrl,
          local_url: result.localUrl,
          reused: result.reused,
          owner: result.owner,
          message: result.reused
            ? `Tunnel reused (already exposing ${result.localUrl} at ${result.publicUrl})`
            : `Tunnel created. Public URL: ${result.publicUrl}`,
        }),
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async handleDestroy(args: Record<string, any>): Promise<ToolResult> {
    const id = args.id as string;
    if (!id) return { success: false, output: "", error: "id is required" };

    const existing = tunnelManager.get(id);
    if (!existing) {
      const available = tunnelManager.list().map((t) => t.id);
      return {
        success: false,
        output: "",
        error: `Tunnel "${id}" not found. Active tunnels: ${available.length > 0 ? available.join(", ") : "none"}`,
      };
    }

    tunnelManager.destroy(id);
    return {
      success: true,
      output: JSON.stringify({
        id,
        message: `Tunnel "${id}" destroyed (was exposing ${existing.localUrl} at ${existing.publicUrl ?? "(url not captured)"}).`,
      }),
    };
  }

  private async handleList(args: Record<string, any>): Promise<ToolResult> {
    const filter: { channel?: string; agentId?: string; status?: TunnelStatus; localUrl?: string } = {};

    // mine=true requires an agentId on the plugin instance — otherwise we'd
    // silently ignore the filter and surprise the caller with unscoped results.
    if (args.mine === true) {
      if (!this.agentId) {
        return {
          success: false,
          output: "",
          error:
            "Cannot use mine=true: this plugin instance has no agent context. Pass channel/agent_id explicitly instead.",
        };
      }
      filter.agentId = this.agentId;
    }
    if (args.channel) filter.channel = args.channel as string;
    if (args.local_url) filter.localUrl = args.local_url as string;
    if (args.status !== undefined) {
      if (!VALID_STATUSES.includes(args.status as TunnelStatus)) {
        return {
          success: false,
          output: "",
          error: `Invalid status filter "${args.status}". Must be one of: ${VALID_STATUSES.join(", ")}.`,
        };
      }
      filter.status = args.status as TunnelStatus;
    }

    const rows = tunnelManager.list(filter);
    return {
      success: true,
      output: JSON.stringify({
        count: rows.length,
        tunnels: rows.map((r) => ({
          id: r.id,
          public_url: r.publicUrl,
          local_url: r.localUrl,
          status: r.status,
          uptime_seconds: r.uptimeSeconds,
          channel: r.channel,
          agent_id: r.agentId,
        })),
      }),
    };
  }

  private async handlePrune(args: Record<string, any>): Promise<ToolResult> {
    const filter: PruneFilter = {};
    if (args.dead_only === true) filter.deadOnly = true;
    if (typeof args.older_than_seconds === "number") {
      if (args.older_than_seconds < 0 || !Number.isFinite(args.older_than_seconds)) {
        return {
          success: false,
          output: "",
          error: `older_than_seconds must be a non-negative finite number; got ${args.older_than_seconds}.`,
        };
      }
      filter.olderThanMs = args.older_than_seconds * 1000;
    }
    if (args.local_url) filter.localUrl = args.local_url as string;
    if (args.channel) filter.channel = args.channel as string;
    if (args.agent_id) filter.agentId = args.agent_id as string;

    // The guard rejects "trivial" filters that match everything:
    //   - empty filter                       → {} matches all
    //   - {older_than_seconds: 0}            → olderThanMs=0, matches all
    //   - {dead_only: false}                 → NOT set (not true), doesn't matter
    // Any non-zero older_than_seconds, or ANY of the string/boolean filters
    // set to a meaningful value, counts as non-trivial.
    const hasNonTrivialFilter =
      filter.deadOnly === true ||
      (filter.olderThanMs !== undefined && filter.olderThanMs > 0) ||
      !!filter.localUrl ||
      !!filter.channel ||
      !!filter.agentId;
    if (!hasNonTrivialFilter) {
      return {
        success: false,
        output: "",
        error:
          "tunnel_prune requires at least one non-trivial filter " +
          "(dead_only=true, older_than_seconds>0, local_url, channel, or agent_id) " +
          "to prevent accidentally wiping all tunnels.",
      };
    }

    const removed = tunnelManager.prune(filter);
    return {
      success: true,
      output: JSON.stringify({
        removed_count: removed.length,
        removed_ids: removed,
      }),
    };
  }

  // --------------------------------------------------------------------------
  // Plugin lifecycle — tunnels are intentionally persistent.
  // --------------------------------------------------------------------------

  async destroy(): Promise<void> {
    // No-op: tunnels are tmux-backed and survive plugin/worker/process exit.
    // Use TunnelPlugin.destroyAll() below to reap them on graceful shutdown,
    // OR invoke `tunnel_prune` / `tunnel_destroy` explicitly.
  }

  /**
   * Legacy no-op kept for backwards compatibility with worker-loop.ts which
   * calls `TunnelPlugin.destroyAll()` on stop. The prior implementation
   * SIGTERM'd all in-process cloudflared children; with tmux-backed tunnels
   * that would defeat the whole point (persistence across restart), so this
   * is deliberately a noop now.
   *
   * Callers who want to kill tunnels on shutdown should use
   * `tunnelManager.prune({ ... })` with whatever filter is appropriate
   * (usually `deadOnly: true` to just reap already-dead entries).
   */
  static destroyAll(): void {
    // Intentional noop — see docstring.
  }
}
