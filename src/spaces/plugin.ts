import type { ToolPlugin, ToolRegistration } from "../agent/tools/plugin";
import { timedFetch } from "../utils/timed-fetch";
import type { SpaceManager } from "./manager";
import { MAX_RESULT_LENGTH } from "../agent/constants/spaces";

interface SpacePluginConfig {
  spaceId: string;
  spaceChannel: string;
  mainChannel: string;
  apiUrl: string;
  agentId: string;
  resolve: (summary: string) => void;
  onComplete?: () => void;
}

export function createSpaceToolPlugin(config: SpacePluginConfig, spaceManager: SpaceManager): ToolPlugin {
  return {
    name: "space-tools",
    getTools(): ToolRegistration[] {
      return [
        {
          name: "complete_task",
          description:
            "Send your final result back to the parent channel and complete this sub-space. The sub-space will be locked immediately after calling this tool. Call this once your task is fully done.",
          parameters: {
            result: { type: "string", description: "The final result to send back to the parent channel" },
          },
          required: ["result"],
          handler: async (
            args: Record<string, unknown>,
          ): Promise<{ success: boolean; output: string; error?: string }> => {
            // Accept common LLM parameter name variants (result, response, text, output)
            const result = String(args.result || args.response || args.text || args.output || "");
            if (!result) {
              return {
                success: false,
                output: "",
                error: "Missing result content. Call complete_task(result='your result text here').",
              };
            }
            const won = spaceManager.lockSpace(config.spaceId, "completed", result);
            if (!won) {
              return { success: true, output: "Space already completed by another process." };
            }

            // Post result to parent channel
            try {
              const truncated =
                result.length > MAX_RESULT_LENGTH
                  ? result.slice(0, MAX_RESULT_LENGTH) + "\n\n[Result truncated — full result available in sub-space]"
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
      ];
    },
  };
}
