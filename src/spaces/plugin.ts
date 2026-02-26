import type { ToolPlugin, ToolRegistration } from "../agent/src/tools/plugin";
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

export function createSpaceToolPlugin(config: SpacePluginConfig, spaceManager: SpaceManager): ToolPlugin {
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
              const truncated = result.length > 2000 ? result.slice(0, 2000) + "..." : result;
              await fetch(`${config.apiUrl}/api/chat.postMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  channel: config.mainChannel,
                  text: truncated,
                  user: "UWORKER-SPACE",
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
