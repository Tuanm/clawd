/**
 * Copilot Analytics Plugin — Built-in MCP-style tools for viewing Copilot API analytics
 *
 * Provides analytics tools to all agents without requiring MCP server configuration.
 * Tools query the copilot_calls table in chat.db for usage stats, cost tracking, etc.
 */

import type { ToolPlugin, ToolRegistration } from "../agent/src/tools/plugin";
import type { ToolResult } from "../agent/src/tools/tools";
import {
  queryCalls,
  queryCallsCount,
  querySummary,
  queryModelStats,
  queryKeyStats,
  queryRecentStats,
  type CallsQueryOptions,
} from "../../analytics";

// ── Copilot SVG Logo (base64 data URI) ─────────────────────────────

export const COPILOT_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.236 2.636 7.855 6.356 9.312-.088-.791-.167-2.005.035-2.868.181-.78 1.172-4.97 1.172-4.97s-.299-.598-.299-1.482c0-1.39.806-2.428 1.81-2.428.852 0 1.264.64 1.264 1.408 0 .858-.546 2.14-.828 3.33-.236.995.499 1.806 1.48 1.806 1.778 0 3.144-1.874 3.144-4.58 0-2.393-1.72-4.068-4.177-4.068-2.845 0-4.515 2.134-4.515 4.34 0 .859.331 1.781.745 2.282a.3.3 0 0 1 .069.288l-.278 1.133c-.044.183-.146.222-.337.134-1.249-.581-2.03-2.407-2.03-3.874 0-3.154 2.292-6.052 6.608-6.052 3.469 0 6.165 2.473 6.165 5.776 0 3.447-2.173 6.22-5.19 6.22-1.013 0-1.965-.527-2.291-1.148l-.623 2.378c-.226.869-.835 1.958-1.244 2.621.937.29 1.929.446 2.958.446 5.523 0 10-4.477 10-10S17.523 2 12 2Z" fill="currentColor"/></svg>`;

// ── Per-channel enabled state (enabled by default) ──────────────────

const _disabledChannels = new Set<string>();

export function isCopilotEnabled(channel: string): boolean {
  return !_disabledChannels.has(channel);
}

export function setCopilotEnabled(channel: string, enabled: boolean): void {
  if (enabled) _disabledChannels.delete(channel);
  else _disabledChannels.add(channel);
}

// ── Tool Plugin ─────────────────────────────────────────────────────

export function createCopilotAnalyticsPlugin(channel: string): ToolPlugin {
  function parseFilters(args: Record<string, any>): CallsQueryOptions {
    const opts: CallsQueryOptions = {};
    if (args.from) opts.from = Number(args.from);
    if (args.to) opts.to = Number(args.to);
    if (args.model) opts.model = String(args.model);
    if (args.channel) opts.channel = String(args.channel);
    if (args.agent_id) opts.agentId = String(args.agent_id);
    if (args.status) opts.status = String(args.status);
    return opts;
  }

  async function handleAnalyticsSummary(args: Record<string, any>): Promise<ToolResult> {
    try {
      const opts = parseFilters(args);
      const granularity = (args.granularity as "hour" | "day" | "week") || "day";
      const summary = querySummary({ ...opts, granularity });

      if (summary.length === 0) {
        return { success: true, output: "No analytics data found for the specified period." };
      }

      const lines = summary.map((row) => {
        const tokens = row.total_prompt_tokens + row.total_completion_tokens;
        return `${row.period}: ${row.total_calls} calls (${row.ok_calls} ok, ${row.error_calls} errors), ${tokens} tokens, $${row.total_premium_cost.toFixed(4)} premium, ${row.avg_latency_ms ? Math.round(row.avg_latency_ms) + "ms avg" : "n/a"}${row.p95_latency_ms ? ` / ${Math.round(row.p95_latency_ms)}ms p95` : ""}`;
      });

      return { success: true, output: `Copilot Usage Summary (${granularity}):\n${lines.join("\n")}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  async function handleAnalyticsModels(args: Record<string, any>): Promise<ToolResult> {
    try {
      const opts = parseFilters(args);
      const models = queryModelStats(opts);

      if (models.length === 0) {
        return { success: true, output: "No model usage data found." };
      }

      const lines = models.map((row) => {
        const tokens = row.total_prompt_tokens + row.total_completion_tokens;
        return `${row.model}: ${row.total_calls} calls (${row.ok_calls} ok), ${tokens} tokens, $${row.total_premium_cost.toFixed(4)} premium, ${row.avg_latency_ms ? Math.round(row.avg_latency_ms) + "ms avg" : "n/a"}`;
      });

      return { success: true, output: `Model Usage:\n${lines.join("\n")}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  async function handleAnalyticsKeys(args: Record<string, any>): Promise<ToolResult> {
    try {
      const opts = parseFilters(args);
      const keys = queryKeyStats(opts);

      if (keys.length === 0) {
        return { success: true, output: "No API key usage data found." };
      }

      const lines = keys.map((row) => {
        const lastUsed = new Date(row.last_used_ts).toISOString().slice(0, 19);
        return `${row.key_fingerprint}: ${row.total_calls} calls (${row.ok_calls} ok, ${row.error_calls} errors), $${row.total_premium_cost.toFixed(4)} premium, last used ${lastUsed}`;
      });

      return { success: true, output: `API Key Usage:\n${lines.join("\n")}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  async function handleAnalyticsRecent(args: Record<string, any>): Promise<ToolResult> {
    try {
      const window = Number(args.window) || 60;
      const stats = queryRecentStats(window);

      return {
        success: true,
        output:
          `Copilot Usage (last ${stats.windowMinutes} minutes):\n` +
          `Calls: ${stats.calls}\n` +
          `Errors: ${stats.errors}\n` +
          `Premium Cost: $${stats.premiumCost.toFixed(4)}\n` +
          `Avg Latency: ${stats.avgLatencyMs ? Math.round(stats.avgLatencyMs) + "ms" : "n/a"}`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  async function handleAnalyticsCalls(args: Record<string, any>): Promise<ToolResult> {
    try {
      const opts = parseFilters(args);
      opts.limit = Math.min(Number(args.limit) || 20, 100);
      opts.offset = Number(args.offset) || 0;

      const total = queryCallsCount(opts);
      const calls = queryCalls(opts) as any[];

      if (calls.length === 0) {
        return { success: true, output: "No calls found for the specified filters." };
      }

      const lines = calls.map((c: any) => {
        const ts = new Date(c.ts).toISOString().slice(0, 19);
        const tokens = (c.prompt_tokens || 0) + (c.completion_tokens || 0);
        return `${ts} ${c.status.padEnd(5)} ${c.model} ${tokens}tok ${c.latency_ms ? c.latency_ms + "ms" : "n/a"} ${c.premium_cost ? "$" + c.premium_cost.toFixed(4) : ""} ${c.channel || ""} ${c.agent_id || ""}`;
      });

      return {
        success: true,
        output: `Copilot Calls (${opts.offset + 1}-${opts.offset + calls.length} of ${total}):\n${lines.join("\n")}`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  return {
    name: "copilot",
    getTools(): ToolRegistration[] {
      if (!isCopilotEnabled(channel)) return [];
      return [
        {
          name: "copilot_analytics_summary",
          description:
            "[MCP:copilot] View Copilot API usage summary with time-bucketed stats (calls, tokens, cost, latency).",
          parameters: {
            granularity: {
              type: "string",
              description: 'Time bucket: "hour", "day" (default), or "week"',
              enum: ["hour", "day", "week"],
              default: "day",
            },
            from: { type: "number", description: "Start timestamp (epoch ms)" },
            to: { type: "number", description: "End timestamp (epoch ms)" },
            model: { type: "string", description: "Filter by model name" },
            channel: { type: "string", description: "Filter by channel" },
            agent_id: { type: "string", description: "Filter by agent ID" },
          },
          required: [],
          handler: handleAnalyticsSummary,
        },
        {
          name: "copilot_analytics_models",
          description: "[MCP:copilot] View per-model Copilot API usage breakdown (calls, tokens, cost, latency).",
          parameters: {
            from: { type: "number", description: "Start timestamp (epoch ms)" },
            to: { type: "number", description: "End timestamp (epoch ms)" },
            channel: { type: "string", description: "Filter by channel" },
            agent_id: { type: "string", description: "Filter by agent ID" },
          },
          required: [],
          handler: handleAnalyticsModels,
        },
        {
          name: "copilot_analytics_keys",
          description: "[MCP:copilot] View per-API-key usage breakdown (calls, errors, cost, last used).",
          parameters: {
            from: { type: "number", description: "Start timestamp (epoch ms)" },
            to: { type: "number", description: "End timestamp (epoch ms)" },
          },
          required: [],
          handler: handleAnalyticsKeys,
        },
        {
          name: "copilot_analytics_recent",
          description:
            "[MCP:copilot] View real-time Copilot usage stats for a rolling time window (calls, errors, cost, latency).",
          parameters: {
            window: {
              type: "number",
              description: "Rolling window in minutes (default: 60)",
              default: 60,
            },
          },
          required: [],
          handler: handleAnalyticsRecent,
        },
        {
          name: "copilot_analytics_calls",
          description: "[MCP:copilot] View individual Copilot API call log with filtering and pagination.",
          parameters: {
            limit: { type: "number", description: "Max results (default: 20, max: 100)", default: 20 },
            offset: { type: "number", description: "Offset for pagination", default: 0 },
            from: { type: "number", description: "Start timestamp (epoch ms)" },
            to: { type: "number", description: "End timestamp (epoch ms)" },
            model: { type: "string", description: "Filter by model name" },
            status: { type: "string", description: 'Filter by status: "ok", "429", "403", "error"' },
            channel: { type: "string", description: "Filter by channel" },
            agent_id: { type: "string", description: "Filter by agent ID" },
          },
          required: [],
          handler: handleAnalyticsCalls,
        },
      ];
    },
  };
}
