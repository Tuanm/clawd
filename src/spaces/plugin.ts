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
          name: "complete_space",
          description: "Mark this sub-space as completed with a summary of results. Call this when your task is done.",
          parameters: {
            summary: { type: "string", description: "Summary of what was accomplished" },
          },
          required: ["summary"],
          handler: async (args: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> => {
            const summary = String(args.summary || "");
            const won = spaceManager.lockSpace(config.spaceId, "completed", summary);
            if (!won) {
              return { success: true, output: "Space already completed by another process." };
            }

            // SP26: Post result to main channel FIRST, then update card
            try {
              const truncated = summary.length > 2000 ? summary.slice(0, 2000) + "..." : summary;
              await fetch(`${config.apiUrl}/api/chat.postMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  channel: config.mainChannel,
                  text: `✅ **Sub-space completed:** ${truncated}`,
                  user: "UWORKER-SPACE",
                  agent_id: config.agentId,
                }),
              });
            } catch {}

            // Update card status
            spaceManager.updateSpaceCard(config.spaceId);

            // Resolve the completion promise and stop the worker
            config.resolve(summary);
            config.onComplete?.();

            return { success: true, output: "Space completed successfully." };
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
