/**
 * Copilot Analytics Plugin — Built-in MCP-style tools for viewing Copilot API analytics
 *
 * Provides analytics tools to all agents without requiring MCP server configuration.
 * Tools query the copilot_calls table in chat.db for usage stats, cost tracking, etc.
 */

import {
  type CallsQueryOptions,
  queryCalls,
  queryCallsCount,
  queryKeyStats,
  queryModelStats,
  queryRecentStats,
  querySummary,
} from "../../analytics";
import type { ToolPlugin, ToolRegistration } from "../tools/plugin";
import type { ToolResult } from "../tools/tools";

// ── GitHub Copilot SVG Logo ──────────────────────────────────────────

export const COPILOT_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="22" viewBox="0 0 512 416" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" stroke-linejoin="round" stroke-miterlimit="2"><path d="M181.33 266.143c0-11.497 9.32-20.818 20.818-20.818 11.498 0 20.819 9.321 20.819 20.818v38.373c0 11.497-9.321 20.818-20.819 20.818-11.497 0-20.818-9.32-20.818-20.818v-38.373zM308.807 245.325c-11.477 0-20.798 9.321-20.798 20.818v38.373c0 11.497 9.32 20.818 20.798 20.818 11.497 0 20.818-9.32 20.818-20.818v-38.373c0-11.497-9.32-20.818-20.818-20.818z" fill-rule="nonzero"/><path d="M512.002 246.393v57.384c-.02 7.411-3.696 14.638-9.67 19.011C431.767 374.444 344.695 416 256 416c-98.138 0-196.379-56.542-246.33-93.21-5.975-4.374-9.65-11.6-9.671-19.012v-57.384a35.347 35.347 0 016.857-20.922l15.583-21.085c8.336-11.312 20.757-14.31 33.98-14.31 4.988-56.953 16.794-97.604 45.024-127.354C155.194 5.77 226.56 0 256 0c29.441 0 100.807 5.77 154.557 62.722 28.19 29.75 40.036 70.401 45.025 127.354 13.263 0 25.602 2.936 33.958 14.31l15.583 21.127c4.476 6.077 6.878 13.345 6.878 20.88zm-97.666-26.075c-.677-13.058-11.292-18.19-22.338-21.824-11.64 7.309-25.848 10.183-39.46 10.183-14.454 0-41.432-3.47-63.872-25.869-5.667-5.625-9.527-14.454-12.155-24.247a212.902 212.902 0 00-20.469-1.088c-6.098 0-13.099.349-20.551 1.088-2.628 9.793-6.509 18.622-12.155 24.247-22.4 22.4-49.418 25.87-63.872 25.87-13.612 0-27.86-2.855-39.501-10.184-11.005 3.613-21.558 8.828-22.277 21.824-1.17 24.555-1.272 49.11-1.375 73.645-.041 12.318-.082 24.658-.288 36.976.062 7.166 4.374 13.818 10.882 16.774 52.97 24.124 103.045 36.278 149.137 36.278 46.01 0 96.085-12.154 149.014-36.278 6.508-2.956 10.84-9.608 10.881-16.774.637-36.832.124-73.809-1.642-110.62h.041zM107.521 168.97c8.643 8.623 24.966 14.392 42.56 14.392 13.448 0 39.03-2.874 60.156-24.329 9.28-8.951 15.05-31.35 14.413-54.079-.657-18.231-5.769-33.28-13.448-39.665-8.315-7.371-27.203-10.574-48.33-8.644-22.399 2.238-41.267 9.588-50.875 19.833-20.798 22.728-16.323 80.317-4.476 92.492zm130.556-56.008c.637 3.51.965 7.35 1.273 11.517 0 2.875 0 5.77-.308 8.952 6.406-.636 11.847-.636 16.959-.636s10.553 0 16.959.636c-.329-3.182-.329-6.077-.329-8.952.329-4.167.657-8.007 1.294-11.517-6.735-.637-12.812-.965-17.924-.965s-11.21.328-17.924.965zm49.275-8.008c-.637 22.728 5.133 45.128 14.413 54.08 21.105 21.454 46.708 24.328 60.155 24.328 17.596 0 33.918-5.769 42.561-14.392 11.847-12.175 16.322-69.764-4.476-92.492-9.608-10.245-28.476-17.595-50.875-19.833-21.127-1.93-40.015 1.273-48.33 8.644-7.679 6.385-12.791 21.434-13.448 39.665z"/></svg>`;

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
        return `${row.period}: ${row.total_calls} calls (${row.ok_calls} ok, ${row.error_calls} errors), ${tokens} tokens, ${row.total_premium_requests.toFixed(1)} premium reqs, ${row.avg_latency_ms ? Math.round(row.avg_latency_ms) + "ms avg" : "n/a"}${row.p95_latency_ms ? ` / ${Math.round(row.p95_latency_ms)}ms p95` : ""}`;
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
        return `${row.model}: ${row.total_calls} calls (${row.ok_calls} ok), ${tokens} tokens, ${row.total_premium_requests.toFixed(1)} premium reqs, ${row.avg_latency_ms ? Math.round(row.avg_latency_ms) + "ms avg" : "n/a"}`;
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
        return `${row.key_fingerprint}: ${row.total_calls} calls (${row.ok_calls} ok, ${row.error_calls} errors), ${row.total_premium_requests.toFixed(1)} premium reqs, last used ${lastUsed}`;
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
          `Copilot Usage (last ${window} minutes):\n` +
          `Calls: ${stats.calls}\n` +
          `Errors: ${stats.errors}\n` +
          `Premium Requests: ${stats.premiumRequests.toFixed(1)}\n` +
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
        return `${ts} ${c.status.padEnd(5)} ${c.model} ${tokens}tok ${c.latency_ms ? c.latency_ms + "ms" : "n/a"} ${c.premium_cost ? c.premium_cost.toFixed(1) + " pr" : ""} ${c.channel || ""} ${c.agent_id || ""}`;
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
