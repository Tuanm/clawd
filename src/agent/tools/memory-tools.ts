/**
 * Memory Tools — memory_search, memory_summary
 *
 * Registers memory/history search tools into the shared tool registry.
 */

import { registerTool } from "./registry";

// ============================================================================
// Tool: Memory Search
// ============================================================================

registerTool(
  "memory_search",
  "Search past conversation history. Filter by time range, keywords, or role.",
  {
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "Keywords to search for (uses full-text search)",
    },
    start_time: {
      type: "number",
      description: "Search from this Unix timestamp (ms)",
    },
    end_time: {
      type: "number",
      description: "Search until this Unix timestamp (ms)",
    },
    role: {
      type: "string",
      enum: ["user", "assistant", "tool"],
      description: "Filter by message role",
    },
    session_id: {
      type: "string",
      description: "Limit to specific session",
    },
    limit: {
      type: "number",
      description: "Maximum results (default: 20)",
    },
  },
  [],
  async (args) => {
    try {
      // Use singleton to avoid database lock contention
      const { getMemoryManager } = await import("../memory/memory");
      const memory = getMemoryManager();

      const results = memory.search({
        keywords: args.keywords,
        startTime: args.start_time,
        endTime: args.end_time,
        role: args.role,
        sessionId: args.session_id,
        limit: args.limit || 20,
      });

      if (results.length === 0) {
        return { success: true, output: "No matching messages found." };
      }

      const formatted = results
        .map(
          (r) =>
            `[${new Date(r.createdAt).toISOString()}] (${r.sessionName}) ${r.role}: ${r.content?.slice(0, 200)}${r.content?.length > 200 ? "..." : ""}`,
        )
        .join("\n\n");

      return {
        success: true,
        output: `Found ${results.length} messages:\n\n${formatted}`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Memory Summary
// ============================================================================

registerTool(
  "memory_summary",
  "Get a summary of a conversation session including key topics.",
  {
    session_id: {
      type: "string",
      description: "Session ID to summarize",
    },
  },
  ["session_id"],
  async ({ session_id }) => {
    try {
      const { getMemoryManager } = await import("../memory/memory");
      const memory = getMemoryManager();

      const summary = memory.getSessionSummary(session_id);

      if (!summary) {
        return { success: false, output: "", error: "Session not found" };
      }

      const output = `Session: ${summary.sessionName}
Messages: ${summary.messageCount}
Time Range: ${new Date(summary.timeRange.start).toISOString()} - ${new Date(summary.timeRange.end).toISOString()}
Key Topics: ${summary.keyTopics.join(", ") || "None detected"}

Summary: ${summary.summary}`;

      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);
