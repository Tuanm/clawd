import type { ToolPlugin, ToolRegistration } from "../agent/tools/plugin";
import { timedFetch } from "../utils/timed-fetch";
import type { SpaceManager } from "./manager";

interface SpacePluginConfig {
  spaceId: string;
  spaceChannel: string;
  mainChannel: string;
  apiUrl: string;
  agentId: string;
  resolve: (summary: string) => void;
  onComplete?: () => void;
}

// Rate limit progress reports (minimum 10s between posts per space)
const PROGRESS_MIN_INTERVAL_MS = 10_000;

export function createSpaceToolPlugin(config: SpacePluginConfig, spaceManager: SpaceManager): ToolPlugin {
  let lastProgressTs = 0;
  return {
    name: "space-tools",
    getTools(): ToolRegistration[] {
      return [
        {
          name: "respond_to_parent",
          description:
            "Send your final result back to the parent channel and complete this sub-space. The sub-space will be locked immediately after calling this tool. Call this once your task is fully done.",
          parameters: {
            result: { type: "string", description: "The final result to send back to the parent channel" },
          },
          required: ["result"],
          handler: async (
            args: Record<string, unknown>,
          ): Promise<{ success: boolean; output: string; error?: string }> => {
            const result = String(args.result || "");
            const won = spaceManager.lockSpace(config.spaceId, "completed", result);
            if (!won) {
              return { success: true, output: "Space already completed by another process." };
            }

            // Post result to parent channel
            try {
              const truncated =
                result.length > 10000
                  ? result.slice(0, 10000) + "\n\n[Result truncated — full result available in sub-space]"
                  : result;
              await timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  channel: config.mainChannel,
                  text: truncated,
                  user: config.agentId,
                  agent_id: config.agentId,
                }),
              });
            } catch {}

            // Update card status
            spaceManager.updateSpaceCard(config.spaceId);

            // Resolve the completion promise and stop the worker
            config.resolve(result);
            config.onComplete?.();

            return { success: true, output: "Result sent to parent channel. Sub-space locked." };
          },
        },
        {
          name: "report_progress",
          description:
            "Report progress on the current task to the parent channel. Non-terminal — does NOT complete the sub-space. Use this to keep the parent informed about your progress.",
          parameters: {
            percent: {
              type: "number",
              description: "Progress percentage (0-100)",
            },
            status: {
              type: "string",
              description: "Brief status message (e.g., 'Running tests', 'Analyzing 3/5 files')",
            },
          },
          required: ["status"],
          handler: async (args: Record<string, unknown>): Promise<{ success: boolean; output: string }> => {
            // Guard: don't report progress on locked/completed spaces
            const space = spaceManager.getSpace(config.spaceId);
            if (space && space.status !== "active") {
              return { success: true, output: "Space already completed. Progress not reported." };
            }

            // Rate limit: minimum 10s between progress posts
            const now = Date.now();
            if (now - lastProgressTs < PROGRESS_MIN_INTERVAL_MS) {
              return { success: true, output: "Progress throttled. Try again in a few seconds." };
            }
            lastProgressTs = now;

            // Clamp and validate percent
            const rawPercent = typeof args.percent === "number" && Number.isFinite(args.percent) ? args.percent : null;
            const percent = rawPercent !== null ? Math.round(Math.min(100, Math.max(0, rawPercent))) : null;
            const status = String(args.status || "Working...");
            const progressText = percent !== null ? `[${percent}%] ${status}` : status;

            // Post progress update to parent channel (non-terminal, best-effort)
            try {
              await timedFetch(`${config.apiUrl}/api/chat.postMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  channel: config.mainChannel,
                  text: `[Progress: ${config.agentId}] ${progressText}`,
                  user: config.agentId,
                  agent_id: config.agentId,
                  subtype: "progress",
                }),
              });
            } catch {
              /* best-effort */
            }

            return { success: true, output: `Progress reported: ${progressText}` };
          },
        },
        {
          name: "get_space_info",
          description: "Get information about this sub-space (title, description, parent channel, status).",
          parameters: {},
          required: [],
          handler: async (): Promise<{ success: boolean; output: string }> => {
            const space = spaceManager.getSpace(config.spaceId);
            if (!space) {
              return { success: false, output: "Space not found." };
            }
            return {
              success: true,
              output: JSON.stringify({
                title: space.title,
                description: space.description,
                parentChannel: config.mainChannel,
                status: space.status,
              }),
            };
          },
        },
      ];
    },
  };
}
