/**
 * MCP handler for main channel agents.
 * Auto-injects channel and agent_id into every tool call.
 * Route: /mcp/agent/{channel}/{agentId}
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getProjectAgentsDir } from "../../agent/tools/registry";
import { db, getAgent } from "../database";
import { postMessage } from "../routes/messages";
import { broadcastUpdate } from "../websocket";
import { executeToolCall } from "./execute";
import { _scheduler, _workerManager } from "./shared";
import { MCP_TOOLS } from "./tool-defs";

/** Minimal MCP tool definition shape used when building the tools/list response. */
interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    enum?: string[];
  };
}

export async function handleAgentMcpRequest(req: Request, channel: string, agentId: string): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as {
      jsonrpc: string;
      id: number | string;
      method: string;
      params?: Record<string, unknown>;
    };
    const { id, method, params = {} } = body;

    if (method === "initialize") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "clawd-agent-mcp", version: "1.0.0" },
            capabilities: { tools: {} },
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (method === "notifications/initialized") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (method === "tools/list") {
      // Return all chat tools + agent management tools + browser tools
      const { AGENT_MCP_TOOLS } = await import("../../spaces/agent-mcp-tools");

      // Get plugin tool definitions dynamically (browser, tunnel)
      const pluginToolDefs: McpToolSchema[] = [];
      const pluginToRegister = [
        async () => {
          const { BrowserPlugin } = await import("../../agent/plugins/browser-plugin");
          return new BrowserPlugin(channel, agentId).getTools();
        },
        async () => {
          const { TunnelPlugin } = await import("../../agent/plugins/tunnel-plugin");
          return new TunnelPlugin().getTools();
        },
        async () => {
          const { CustomToolPlugin } = await import("../../agent/plugins/custom-tool-plugin");
          return new CustomToolPlugin(channel, agentId).getTools();
        },
      ];
      for (const getTools of pluginToRegister) {
        try {
          const tools = await getTools();
          for (const t of tools) {
            pluginToolDefs.push({
              name: t.name,
              description: t.description || t.name,
              inputSchema: {
                type: "object",
                properties: Object.fromEntries(Object.entries(t.parameters || {}).map(([k, v]) => [k, v])),
                required: t.required || [],
              },
            });
          }
        } catch {
          // Intentionally swallowed — plugin tool registration is best-effort; tools/list continues
        }
      }

      // Add job tools if tmux is available
      const jobToolDefs: McpToolSchema[] = [];
      try {
        const { hasTmux } = await import("../../claude-code/utils");
        if (hasTmux()) {
          jobToolDefs.push(
            {
              name: "job_submit",
              description:
                "Submit a background command that persists via tmux (survives agent restarts). Returns a job ID.",
              inputSchema: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Short name for the job" },
                  command: { type: "string", description: "Bash command to execute" },
                },
                required: ["name", "command"],
              },
            },
            {
              name: "job_status",
              description: "Get status of background jobs. Omit job_id to list all jobs.",
              inputSchema: {
                type: "object",
                properties: {
                  job_id: { type: "string", description: "Specific job ID (optional)" },
                  status_filter: {
                    type: "string",
                    enum: ["pending", "running", "completed", "failed", "cancelled"],
                    description: "Filter by status",
                  },
                },
              },
            },
            {
              name: "job_cancel",
              description: "Cancel a background job.",
              inputSchema: {
                type: "object",
                properties: { job_id: { type: "string", description: "Job ID to cancel" } },
                required: ["job_id"],
              },
            },
            {
              name: "job_wait",
              description: "Wait for a background job to complete and return its output.",
              inputSchema: {
                type: "object",
                properties: {
                  job_id: { type: "string", description: "Job ID to wait for" },
                  timeout_ms: { type: "number", description: "Max wait time in ms (default: 60000)" },
                },
                required: ["job_id"],
              },
            },
            {
              name: "job_logs",
              description: "Get output logs of a background job.",
              inputSchema: {
                type: "object",
                properties: {
                  job_id: { type: "string", description: "Job ID" },
                  tail: { type: "number", description: "Only get last N lines" },
                },
                required: ["job_id"],
              },
            },
          );
        }
      } catch {
        // Intentionally swallowed — tmux detection is best-effort; job tools omitted if unavailable
      }

      // Memo tools (agent long-term memory)
      const memoToolDefs = [
        {
          name: "memo_save",
          description:
            "Save important information to your long-term memory. Memories persist across sessions and are scoped to you. Use categories: fact, preference, decision, lesson, correction.",
          inputSchema: {
            type: "object",
            properties: {
              content: { type: "string", description: "The information to remember (one fact per save)" },
              category: {
                type: "string",
                enum: ["fact", "preference", "decision", "lesson", "correction"],
                description: "Memory category (default: fact)",
              },
              scope: {
                type: "string",
                enum: ["channel", "agent"],
                description: '"channel" (default) = this channel only, "agent" = across all channels',
              },
            },
            required: ["content"],
          },
        },
        {
          name: "memo_recall",
          description: "Search your long-term memories. Without a query, returns recent memories.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search keywords (optional)" },
              category: {
                type: "string",
                enum: ["fact", "preference", "decision", "lesson", "correction"],
                description: "Filter by category",
              },
              limit: { type: "number", description: "Max results (default: 20)" },
              offset: { type: "number", description: "Offset for pagination (default: 0)" },
            },
            required: [],
          },
        },
        {
          name: "memo_delete",
          description: "Delete a memory by its ID. Use memo_recall to find IDs.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "number", description: "Memory ID to delete" },
            },
            required: ["id"],
          },
        },
        {
          name: "memo_pin",
          description: "Pin a memory so it is ALWAYS loaded into your context.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "number", description: "Memory ID to pin" },
            },
            required: ["id"],
          },
        },
        {
          name: "memo_unpin",
          description: "Unpin a previously pinned memory.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "number", description: "Memory ID to unpin" },
            },
            required: ["id"],
          },
        },
      ];

      // Task tools (channel kanban board)
      const taskToolDefs = [
        {
          name: "task_add",
          description: "Add a new task to the channel kanban board.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Task title (brief, actionable)" },
              description: { type: "string", description: "Detailed description (optional)" },
              priority: { type: "string", description: "P0 (critical), P1 (high), P2 (medium), P3 (low). Default: P2" },
              tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
              due_at: { type: "number", description: "Due date as Unix timestamp (optional)" },
            },
            required: ["title"],
          },
        },
        {
          name: "task_batch_add",
          description: "Create multiple tasks at once (max 20). Preferred for 3+ related tasks.",
          inputSchema: {
            type: "object",
            properties: {
              tasks: {
                type: "array",
                description: "Array of task objects with title (required), description, priority (P0-P3), tags",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    description: { type: "string" },
                    priority: { type: "string" },
                    tags: { type: "array", items: { type: "string" } },
                  },
                  required: ["title"],
                },
              },
            },
            required: ["tasks"],
          },
        },
        {
          name: "task_list",
          description: "View the kanban board. Shows all tasks organized by status.",
          inputSchema: {
            type: "object",
            properties: {
              status: { type: "string", description: "Filter by status: todo, doing, done, blocked" },
              limit: { type: "number", description: "Max tasks to return" },
            },
            required: [],
          },
        },
        {
          name: "task_get",
          description: "Get detailed view of a task including attachments and comments.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string", description: "Task ID (or partial ID)" },
            },
            required: ["task_id"],
          },
        },
        {
          name: "task_update",
          description:
            "Update a task (status, priority, title). Use claimer when setting status to 'doing' for atomic claim protection.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string", description: "Task ID" },
              status: { type: "string", description: "New status: todo, doing, done, blocked" },
              priority: { type: "string", description: "New priority: P0, P1, P2, P3" },
              title: { type: "string", description: "New title" },
              claimer: {
                type: "string",
                description: "Agent ID claiming the task (required when setting status to 'doing')",
              },
            },
            required: ["task_id"],
          },
        },
        {
          name: "task_complete",
          description: "Mark a task as done.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string", description: "Task ID" },
            },
            required: ["task_id"],
          },
        },
        {
          name: "task_delete",
          description: "Delete a task from the board.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string", description: "Task ID" },
            },
            required: ["task_id"],
          },
        },
        {
          name: "task_comment",
          description: "Add a comment to a task.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string", description: "Task ID" },
              text: { type: "string", description: "Comment text" },
            },
            required: ["task_id", "text"],
          },
        },
      ];

      // Schedule tools (pause, resume, reminder, tool — complements existing scheduler_* tools)
      const scheduleToolDefs = [
        {
          name: "schedule_pause",
          description:
            "Pause an active recurring scheduled job/reminder. It can be resumed later with schedule_resume.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "The full schedule ID (from scheduler_list output)" },
            },
            required: ["id"],
          },
        },
        {
          name: "schedule_resume",
          description: "Resume a paused recurring scheduled job/reminder.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "The full schedule ID (from scheduler_list output)" },
            },
            required: ["id"],
          },
        },
        {
          name: "schedule_reminder",
          description:
            'Schedule a simple reminder message. Unlike jobs, reminders just post a message — no agent is spawned. Schedule formats: "in 30 minutes", "every day", cron "0 9 * * 1" (UTC), ISO 8601.',
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short title for the reminder (max 200 chars)" },
              message: { type: "string", description: "The reminder message to post (max 5000 chars)" },
              schedule: {
                type: "string",
                description: 'When to fire: "in 30 minutes", "every day", cron expression, or ISO 8601',
              },
              max_runs: {
                type: "number",
                description: "Maximum number of times to fire (optional, for recurring reminders)",
              },
            },
            required: ["title", "message", "schedule"],
          },
        },
        {
          name: "schedule_tool",
          description:
            'Schedule a tool call to run at a specific time or recurring interval. The tool is executed directly by the scheduler. Schedule formats: "in 5 minutes", "every 2 hours", cron "0 9 * * *" (UTC), ISO 8601.',
          inputSchema: {
            type: "object",
            properties: {
              tool_name: { type: "string", description: "Name of the tool to execute (e.g. exec_command, read_file)" },
              tool_args: { type: "object", description: "Arguments to pass to the tool (JSON object)" },
              description: {
                type: "string",
                description: "Short description of what this scheduled tool call does (max 200 chars)",
              },
              schedule: {
                type: "string",
                description: 'When to run: "in 5 minutes", "every 2 hours", cron "0 9 * * *", or ISO 8601',
              },
              max_runs: {
                type: "number",
                description: "Maximum number of runs before auto-completing (optional)",
              },
              timeout_seconds: {
                type: "number",
                description: "Max execution time per run in seconds (default: 300, max: 3600)",
              },
            },
            required: ["tool_name", "tool_args", "description", "schedule"],
          },
        },
      ];

      // Tmux tools (gated on tmux availability)
      const tmuxToolDefs: McpToolSchema[] = [];
      try {
        const { hasTmux: hasTmuxCheck } = await import("../../claude-code/utils");
        if (hasTmuxCheck()) {
          tmuxToolDefs.push(
            {
              name: "tmux_send_command",
              description:
                "Send a command to a tmux session. Creates the session if it does not exist. Use for long-running processes, servers, or interactive programs.",
              inputSchema: {
                type: "object",
                properties: {
                  session: { type: "string", description: "Session name (alphanumeric, no spaces)" },
                  command: { type: "string", description: "Command to run" },
                  cwd: { type: "string", description: "Working directory (defaults to project root)" },
                },
                required: ["session", "command"],
              },
            },
            {
              name: "tmux_kill",
              description: "Kill a tmux session. Terminates the session and all processes running in it.",
              inputSchema: {
                type: "object",
                properties: {
                  session: { type: "string", description: "Session name to kill" },
                },
                required: ["session"],
              },
            },
            {
              name: "tmux_kill_window",
              description: "Kill a specific window in a tmux session.",
              inputSchema: {
                type: "object",
                properties: {
                  session: { type: "string", description: "Session name" },
                  window: { type: "string", description: "Window name or index (e.g., 0, 1, or window name)" },
                },
                required: ["session", "window"],
              },
            },
            {
              name: "tmux_list",
              description: "List all tmux sessions for this project. Shows session names and their current state.",
              inputSchema: { type: "object", properties: {}, required: [] },
            },
            {
              name: "tmux_new_window",
              description: "Create a new window in an existing tmux session.",
              inputSchema: {
                type: "object",
                properties: {
                  session: { type: "string", description: "Session name" },
                  window: { type: "string", description: "Window name (optional)" },
                  command: { type: "string", description: "Command to run in window (optional)" },
                },
                required: ["session"],
              },
            },
            {
              name: "tmux_send_input",
              description:
                "Send raw keystrokes to a tmux session. Use to interact with interactive programs. Special keys: C-m=Enter, C-i=Tab, C-[=Esc.",
              inputSchema: {
                type: "object",
                properties: {
                  session: { type: "string", description: "Session name" },
                  keys: {
                    type: "string",
                    description: "Keys to send (supports special keys: C-m=Enter, C-i=Tab, C-[=Esc, etc.)",
                  },
                },
                required: ["session", "keys"],
              },
            },
            {
              name: "tmux_capture",
              description:
                "Capture the visible output from a tmux session pane. Useful for seeing output of long-running programs.",
              inputSchema: {
                type: "object",
                properties: {
                  session: { type: "string", description: "Session name" },
                  clear: { type: "boolean", description: "Clear the pane history after capturing" },
                },
                required: ["session"],
              },
            },
          );
        }
      } catch {
        // Intentionally swallowed — tmux pane tool registration is best-effort
      }

      // Skill tools
      const skillToolDefs = [
        {
          name: "skill_activate",
          description: "Load and activate a skill by name. Returns the full skill content to guide your actions.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Name of the skill to activate" },
            },
            required: ["name"],
          },
        },
        {
          name: "skill_create",
          description:
            'Create or update a skill. Saved as {projectRoot}/.clawd/skills/{name}/SKILL.md. Use scope="global" to save to ~/.clawd/skills/ instead.',
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Skill name (lowercase a-z, 0-9, hyphens, underscores, max 64 chars)",
              },
              description: { type: "string", description: "Brief description of what the skill does (<200 chars)" },
              triggers: {
                type: "array",
                items: { type: "string" },
                description: "Keywords that should trigger this skill",
              },
              content: {
                type: "string",
                description: "Full skill content in markdown format (instructions for the agent)",
              },
              scope: {
                type: "string",
                enum: ["project", "global"],
                description: 'Where to save: "project" (default) or "global"',
              },
            },
            required: ["name", "description", "triggers", "content"],
          },
        },
        {
          name: "skill_delete",
          description: "Delete a skill by name. Removes the skill folder and its index entry.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Name of the skill to delete" },
            },
            required: ["name"],
          },
        },
        {
          name: "skill_list",
          description:
            "List all available skills (project-scoped + global). Use this to discover what skills are available.",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "skill_search",
          description: "Search for relevant skills by keywords. Returns matching skills ranked by relevance.",
          inputSchema: {
            type: "object",
            properties: {
              keywords: { type: "array", items: { type: "string" }, description: "Keywords to search for" },
            },
            required: ["keywords"],
          },
        },
        {
          name: "skill_cleanup",
          description:
            "Delete auto-generated skills that have not been used within max_age_days (default: 30). Returns count of deleted skills.",
          inputSchema: {
            type: "object",
            properties: {
              max_age_days: {
                type: "number",
                description: "Maximum age in days before an unused auto-generated skill is deleted (default: 30)",
              },
            },
            required: [],
          },
        },
      ];

      // Article tools
      const articleToolDefs = [
        {
          name: "article_create",
          description:
            "Create a new article (blog post, documentation, etc.). The article is stored and can be published to the channel. Provide content via one of: 'content' (raw markdown), 'file_id' (uploaded file from upload_file), or 'message_ts' (existing chat message timestamp).",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Article title" },
              content: {
                type: "string",
                description: "Article content in markdown format (mutually exclusive with file_id and message_ts)",
              },
              file_id: {
                type: "string",
                description:
                  "File ID from upload_file — file content is used as article body (mutually exclusive with content and message_ts)",
              },
              message_ts: {
                type: "string",
                description:
                  "Timestamp of an existing chat message — its text is used as article body (mutually exclusive with content and file_id)",
              },
              description: { type: "string", description: "Short description/summary (optional)" },
              thumbnail_url: { type: "string", description: "URL for thumbnail image (optional)" },
              tags: { type: "array", items: { type: "string" }, description: "Array of tags (optional)" },
              published: { type: "boolean", description: "Whether to publish immediately (default: false)" },
            },
            required: ["title"],
          },
        },
        {
          name: "article_delete",
          description: "Delete an article.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Article ID to delete" },
            },
            required: ["id"],
          },
        },
        {
          name: "article_get",
          description: "Get a specific article by ID. Returns full content and metadata.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Article ID" },
            },
            required: ["id"],
          },
        },
        {
          name: "article_list",
          description: "List articles in a channel. Shows recent articles with metadata.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Max articles to return (default: 10)" },
              offset: { type: "number", description: "Pagination offset (default: 0)" },
              published_only: { type: "boolean", description: "Only show published articles (default: true)" },
            },
            required: [],
          },
        },
        {
          name: "article_update",
          description: "Update an existing article.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Article ID" },
              title: { type: "string", description: "New title (optional)" },
              content: { type: "string", description: "New content (optional)" },
              description: { type: "string", description: "New description (optional)" },
              thumbnail_url: { type: "string", description: "New thumbnail URL (optional)" },
              tags: { type: "array", items: { type: "string" }, description: "New tags (optional)" },
              published: { type: "boolean", description: "Publish/unpublish (optional)" },
            },
            required: ["id"],
          },
        },
        {
          name: "send_article",
          description:
            "Send an article as a message to the chat. Posts an article card to the channel that links to the full article page.",
          inputSchema: {
            type: "object",
            properties: {
              article_id: { type: "string", description: "Article ID to send to chat" },
            },
            required: ["article_id"],
          },
        },
      ];

      // Memory tools
      const memoryToolDefs = [
        {
          name: "memory_search",
          description:
            "Search past conversation history in the current channel. Filter by time range, keywords, or role.",
          inputSchema: {
            type: "object",
            properties: {
              keywords: {
                type: "array",
                items: { type: "string" },
                description: "Keywords to search for (full-text search)",
              },
              start_time: { type: "number", description: "Search from this Unix timestamp (ms)" },
              end_time: { type: "number", description: "Search until this Unix timestamp (ms)" },
              role: {
                type: "string",
                enum: ["user", "assistant", "tool"],
                description: "Filter by message role",
              },
              session_id: { type: "string", description: "Limit to specific session" },
              limit: { type: "number", description: "Maximum results (default: 20)" },
            },
            required: [],
          },
        },
        {
          name: "memory_summary",
          description: "Get a summary of a conversation session including key topics.",
          inputSchema: {
            type: "object",
            properties: {
              session_id: { type: "string", description: "Session ID to summarize" },
            },
            required: ["session_id"],
          },
        },
        // Agent memory tools (same as non-CC agents — per-agent, per-channel long-term memory)
        {
          name: "memo_save",
          description:
            "Save important information to your long-term memory. Memories persist across sessions and are scoped to you. Use categories: fact, preference, decision, lesson, correction. Use memo_pin to ensure critical memories are always loaded.",
          inputSchema: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "The information to remember (be specific and atomic — one fact per save)",
              },
              category: {
                type: "string",
                description: "Memory category",
                enum: ["fact", "preference", "decision", "lesson", "correction"],
                default: "fact",
              },
              scope: {
                type: "string",
                description: '"channel" (default) = this channel only, "agent" = remember across all channels',
                enum: ["channel", "agent"],
                default: "channel",
              },
            },
            required: ["content"],
          },
        },
        {
          name: "memo_recall",
          description:
            "Search your long-term memories. Without a query, returns recent memories. Use to recall previously saved facts, decisions, preferences, and lessons.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search keywords (optional — omit to see recent memories)" },
              category: {
                type: "string",
                description: "Filter by category",
                enum: ["fact", "preference", "decision", "lesson", "correction"],
              },
              limit: { type: "number", description: "Max results (default: 20, max: 50)", default: 20 },
              offset: { type: "number", description: "Offset for pagination (default: 0)", default: 0 },
            },
            required: [],
          },
        },
        {
          name: "memo_delete",
          description: "Delete a memory by its ID. Use memo_recall to find IDs first.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "number", description: "Memory ID to delete" },
            },
            required: ["id"],
          },
        },
        {
          name: "memo_pin",
          description:
            "Pin a memory so it is ALWAYS loaded into your context. Use for critical rules, important decisions, and must-remember facts.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "number", description: "Memory ID to pin" },
            },
            required: ["id"],
          },
        },
        {
          name: "memo_unpin",
          description: "Unpin a previously pinned memory. It will still exist but only loaded when relevant.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "number", description: "Memory ID to unpin" },
            },
            required: ["id"],
          },
        },
      ];

      // Utility tools
      const utilityToolDefs = [
        {
          name: "today",
          description:
            "Get today's date and current time. Use this when you need to know what day it is, the current time, or calculate relative dates.",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "convert_to_markdown",
          description:
            "Convert a document file to markdown. Supports: PDF, DOCX, XLSX, PPTX, HTML, EPUB, CSV. Returns the saved path and content size.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path to the file to convert" },
            },
            required: ["path"],
          },
        },
        {
          name: "get_agent_logs",
          description:
            "Get the output logs of a sub-agent by its ID. Use this to check what a sub-agent is doing or has done.\n\nDO NOT POLL: sub-agents report their results back to the chat when complete — you don't need to read their logs to know when they're done. Only call this tool when you specifically need to debug a failed agent or inspect intermediate output; NEVER call it in a loop waiting for the agent to finish. Polling wastes tokens and time.",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string", description: "The ID of the sub-agent" },
              tail: { type: "number", description: "Only get last N lines (default: 100)" },
            },
            required: ["agent_id"],
          },
        },
        {
          name: "bash",
          description:
            "Execute a shell command on the host machine. Runs outside the CC sandbox — use this instead of the built-in Bash tool. Use run_in_background=true for long-running commands (returns job ID). Prefer dedicated tools when available: use file_grep instead of grep/rg, file_glob instead of find, file_view instead of cat, file_edit instead of sed.",
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", description: "The shell command to execute" },
              timeout: {
                type: "number",
                description: "Timeout in milliseconds (default: 30000, max: 600000)",
              },
              cwd: { type: "string", description: "Working directory for the command" },
              description: {
                type: "string",
                description: "Brief description of what this command does (for logging/audit)",
              },
              run_in_background: {
                type: "boolean",
                description:
                  "Run command in background (returns immediately with job ID). Use job_status to check output later.",
              },
            },
            required: ["command"],
          },
        },
      ];

      const { getMcpFileToolDefs } = await import("../mcp-file-tools");
      const fileToolDefs = getMcpFileToolDefs().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      const webToolDefs = [
        {
          name: "web_search",
          description: "Search the web. Returns results with titles, URLs, and snippets.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "The search query" },
              max_results: { type: "number", description: "Maximum number of results (default: 5)" },
              allowed_domains: {
                type: "array",
                items: { type: "string" },
                description: "Only include results from these domains",
              },
              blocked_domains: {
                type: "array",
                items: { type: "string" },
                description: "Exclude results from these domains",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "web_fetch",
          description: "Fetch a URL and return its content as markdown.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "The URL to fetch" },
              raw: { type: "boolean", description: "Return raw HTML instead of markdown (default: false)" },
              max_length: { type: "number", description: "Maximum characters to return (default: 10000)" },
            },
            required: ["url"],
          },
        },
      ];

      const allTools = [
        ...MCP_TOOLS,
        ...AGENT_MCP_TOOLS,
        ...pluginToolDefs,
        ...jobToolDefs,
        ...memoToolDefs,
        ...taskToolDefs,
        ...scheduleToolDefs,
        ...tmuxToolDefs,
        ...skillToolDefs,
        ...articleToolDefs,
        ...memoryToolDefs,
        ...utilityToolDefs,
        ...fileToolDefs,
        ...webToolDefs,
      ];

      // Append connected channel MCP server tools (convert from OpenAI → MCP format)
      try {
        const mcpManager = _workerManager?.getChannelMcpManager(channel);
        if (mcpManager) {
          const mcpDefs = mcpManager.getToolDefinitions?.() ?? [];
          for (const def of mcpDefs) {
            if (def.type === "function" && def.function) {
              // Convert OpenAI format → MCP format
              allTools.push({
                name: def.function.name,
                description: def.function.description,
                inputSchema: def.function.parameters,
              });
            } else if (def.name) {
              // Already MCP format
              allTools.push(def);
            }
          }
        }
      } catch {
        // Intentionally swallowed — channel MCP tool merging is best-effort; base tools still returned
      }

      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: allTools } }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (method === "tools/call") {
      const { name, arguments: toolArgs } = params as {
        name: string;
        arguments: Record<string, unknown>;
      };

      // Handle file tools (MCP file operations — project-root scoped)
      if (name.startsWith("file_")) {
        try {
          const { getAgentProjectRoot } = await import("../routes/agents");
          const projectRoot = getAgentProjectRoot(db, channel, agentId);
          if (!projectRoot) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ ok: false, error: "Agent not found or no project configured" }),
                    },
                  ],
                },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          const { executeMcpFileTool } = await import("../mcp-file-tools");
          const result = await executeMcpFileTool(name, (toolArgs || {}) as Record<string, unknown>, projectRoot);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: errMsg }) }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle custom_script tool
      if (name === "custom_script") {
        try {
          const { getAgentProjectRoot } = await import("../routes/agents");
          const projectRoot = getAgentProjectRoot(db, channel, agentId);
          if (!projectRoot) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ ok: false, error: "No project configured for this agent" }),
                    },
                  ],
                },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          const { executeCustomScriptMcp } = await import("../../agent/plugins/custom-tool-plugin");
          const result = await executeCustomScriptMcp(projectRoot, (toolArgs || {}) as Record<string, unknown>);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: errMsg }) }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle job tools (tmux-based background jobs)
      if (name.startsWith("job_")) {
        try {
          const { tmuxJobManager } = await import("../../agent/jobs/tmux-manager");
          const args = toolArgs || {};
          let text = "";

          switch (name) {
            case "job_submit": {
              const jobId = tmuxJobManager.submit(args.name as string, args.command as string);
              text = JSON.stringify({
                ok: true,
                job_id: jobId,
                message: `Job submitted. Use job_status("${jobId}") to check progress.`,
              });
              break;
            }
            case "job_status": {
              if (args.job_id) {
                const job = tmuxJobManager.get(args.job_id as string);
                if (!job) {
                  text = JSON.stringify({ ok: false, error: "Job not found" });
                  break;
                }
                const logs = tmuxJobManager.getLogs(args.job_id as string, 50);
                text = JSON.stringify(job, null, 2) + "\n--- Last 50 lines ---\n" + (logs || "(no output)");
              } else {
                const jobs = tmuxJobManager.list({ status: args.status_filter as any, limit: 20 });
                text =
                  jobs.length === 0
                    ? "No jobs found."
                    : jobs.map((j: any) => `[${j.status.toUpperCase()}] ${j.id.slice(0, 8)} - ${j.name}`).join("\n");
              }
              break;
            }
            case "job_cancel": {
              const ok = tmuxJobManager.cancel(args.job_id as string);
              text = ok ? `Job ${args.job_id} cancelled.` : `Could not cancel job ${args.job_id}`;
              break;
            }
            case "job_wait": {
              const job = await tmuxJobManager.waitFor(args.job_id as string, (args.timeout_ms as number) || 60000);
              const logs = tmuxJobManager.getLogs(args.job_id as string);
              text = `Job ${job.status} (exit: ${job.exitCode}):\n${logs || "(no output)"}`;
              break;
            }
            case "job_logs": {
              const logs = tmuxJobManager.getLogs(args.job_id as string, args.tail as number);
              text = logs || "(no output)";
              break;
            }
            default:
              text = JSON.stringify({ ok: false, error: `Unknown job tool: ${name}` });
          }

          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Job error: ${err instanceof Error ? err.message : String(err)}` }],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle memo tools (agent long-term memory)
      if (name.startsWith("memo_")) {
        try {
          const { getAgentMemoryStore } = await import("../../agent/memory/agent-memory");
          const store = getAgentMemoryStore();
          const args = toolArgs || {};
          const VALID_CATEGORIES = ["fact", "preference", "decision", "lesson", "correction"] as const;
          let text = "";

          switch (name) {
            case "memo_save": {
              const content = args.content as string;
              if (!content || !content.trim()) {
                text = "Error: content is required";
                break;
              }
              const category = args.category as string | undefined;
              if (category && !VALID_CATEGORIES.includes(category as any)) {
                text = `Error: Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`;
                break;
              }
              const memChannel = args.scope === "agent" ? null : channel;
              const result = store.save({
                agentId,
                channel: memChannel,
                content: content.trim(),
                category: category as any,
                source: "explicit",
              });
              text =
                result.id === null
                  ? `Error: ${result.warning || "Failed to save memory"}`
                  : result.warning
                    ? `Memory #${result.id} saved (${result.warning})`
                    : `Memory #${result.id} saved successfully`;
              break;
            }
            case "memo_recall": {
              const results = store.recall({
                agentId,
                channel,
                query: args.query as string | undefined,
                category: args.category as any,
                limit: args.limit as number | undefined,
                offset: args.offset as number | undefined,
                includeGlobal: true,
              });
              if (results.length === 0) {
                text = args.query ? `No memories found matching "${args.query}"` : "No memories saved yet";
              } else {
                const now = Math.floor(Date.now() / 1000);
                const lines = results.map((m: any) => {
                  const diff = now - m.createdAt;
                  const age =
                    diff < 60
                      ? "just now"
                      : diff < 3600
                        ? `${Math.floor(diff / 60)}m ago`
                        : diff < 86400
                          ? `${Math.floor(diff / 3600)}h ago`
                          : `${Math.floor(diff / 86400)}d ago`;
                  const scope = m.channel ? "" : " [agent-wide]";
                  const pin = m.priority >= 80 ? " [pinned]" : "";
                  return `#${m.id} [${m.category}] (${age}${scope}${pin}): ${m.content}`;
                });
                const header = args.query
                  ? `Found ${results.length} memories matching "${args.query}":`
                  : `Recent ${results.length} memories:`;
                text = `${header}\n${lines.join("\n")}`;
              }
              break;
            }
            case "memo_delete": {
              const memId = Number(args.id);
              if (!memId || isNaN(memId)) {
                text = "Error: Valid memory ID required";
                break;
              }
              const deleted = store.delete(memId, agentId);
              text = deleted ? `Memory #${memId} deleted` : `Error: Memory #${memId} not found or not owned by you`;
              break;
            }
            case "memo_pin": {
              const memId = Number(args.id);
              if (!memId || isNaN(memId)) {
                text = "Error: Valid memory ID required";
                break;
              }
              const result = store.pin(memId, agentId);
              text = result.success
                ? `Memory #${memId} pinned — it will always be loaded into your context.`
                : `Error: ${result.error || "Failed to pin"}`;
              break;
            }
            case "memo_unpin": {
              const memId = Number(args.id);
              if (!memId || isNaN(memId)) {
                text = "Error: Valid memory ID required";
                break;
              }
              const result = store.unpin(memId, agentId);
              text = result.success
                ? `Memory #${memId} unpinned — it will only be loaded when relevant.`
                : `Error: ${result.error || "Failed to unpin"}`;
              break;
            }
            default:
              text = `Error: Unknown memo tool: ${name}`;
          }

          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Memo error: ${err instanceof Error ? err.message : String(err)}` }],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle task tools (channel kanban board)
      if (name.startsWith("task_")) {
        try {
          const { listTasks, getTask, createTask, createTasksBatch, updateTask, deleteTask, addTaskComment } =
            await import("../routes/tasks");
          const args = toolArgs || {};
          let text = "";

          switch (name) {
            case "task_add": {
              const title = args.title as string;
              if (!title) {
                text = "Error: title is required";
                break;
              }
              const task = createTask({
                title,
                description: args.description as string | undefined,
                priority: args.priority as string | undefined,
                tags: args.tags as string[] | undefined,
                due_at: args.due_at as number | undefined,
                agent_id: agentId,
                channel,
              });
              text = `Created: [${task.priority}] ${task.title} (${task.id})`;
              break;
            }
            case "task_batch_add": {
              const tasks = args.tasks as Array<{
                title: string;
                description?: string;
                priority?: string;
                tags?: string[];
              }>;
              if (!Array.isArray(tasks) || tasks.length === 0) {
                text = "Error: tasks must be a non-empty array";
                break;
              }
              const created = createTasksBatch(tasks, agentId, channel);
              text =
                `Created ${created.length} task(s):\n` +
                created.map((t) => `- [${t.priority}] ${t.title} (${t.id})`).join("\n");
              break;
            }
            case "task_list": {
              const tasks = listTasks({
                status: args.status as string | undefined,
                limit: args.limit as number | undefined,
                channel,
              });
              if (!tasks.length) {
                text = "Kanban board is empty. Add tasks with task_add.";
                break;
              }
              const byStatus: Record<string, any[]> = { todo: [], doing: [], blocked: [], done: [] };
              for (const t of tasks) (byStatus[t.status] || []).push(t);
              text = "KANBAN BOARD\n" + "=".repeat(50) + "\n";
              for (const [s, list] of Object.entries(byStatus)) {
                if (list.length === 0) continue;
                text += `\n## ${s.toUpperCase()} (${list.length})\n`;
                for (const t of list) text += `- [${t.priority}] ${t.title} (${t.id.slice(-8)})\n`;
              }
              break;
            }
            case "task_get": {
              const task = getTask(args.task_id as string);
              if (!task) {
                text = `Error: Task not found: ${args.task_id}`;
                break;
              }
              text = `${task.title}\n${"=".repeat(50)}\n`;
              text += `ID: ${task.id} | Status: ${task.status} | Priority: ${task.priority}\n`;
              if (task.tags?.length) text += `Tags: #${task.tags.join(" #")}\n`;
              if (task.description) text += `\nDescription:\n${task.description}\n`;
              if (task.attachments?.length) {
                text += `\nAttachments (${task.attachments.length}):\n`;
                for (const a of task.attachments) text += `  ${a.name}${a.url ? ` - ${a.url}` : ""}\n`;
              }
              if (task.comments?.length) {
                text += `\nComments (${task.comments.length}):\n`;
                for (const c of task.comments) text += `  [${c.author}] ${c.text}\n`;
              }
              break;
            }
            case "task_update": {
              const task_id = args.task_id as string;
              if (!task_id) {
                text = "Error: task_id is required";
                break;
              }
              const result = updateTask(task_id, {
                status: args.status as any,
                priority: args.priority as any,
                title: args.title as string | undefined,
                claimer: args.claimer as string | undefined,
              });
              if (!result.success) {
                const failResult = result as { success: false; error: string; claimed_by?: string };
                text =
                  failResult.error === "already_claimed"
                    ? `Error: Task already claimed by ${failResult.claimed_by}. Pick another task.`
                    : `Error: Task not found: ${task_id}`;
              } else {
                const t = result.task;
                text = `Updated: [${t.status}] [${t.priority}] ${t.title}`;
                if (t.claimed_by) text += ` (claimed by: ${t.claimed_by})`;
              }
              break;
            }
            case "task_complete": {
              const task_id = args.task_id as string;
              if (!task_id) {
                text = "Error: task_id is required";
                break;
              }
              const result = updateTask(task_id, { status: "done" });
              text = result.success ? `Completed: ${result.task.title}` : `Error: Task not found: ${task_id}`;
              break;
            }
            case "task_delete": {
              const task_id = args.task_id as string;
              if (!task_id) {
                text = "Error: task_id is required";
                break;
              }
              const deleted = deleteTask(task_id);
              text = deleted ? "Task deleted" : `Error: Task not found: ${task_id}`;
              break;
            }
            case "task_comment": {
              const task_id = args.task_id as string;
              const commentText = args.text as string;
              if (!task_id || !commentText) {
                text = "Error: task_id and text are required";
                break;
              }
              const task = addTaskComment(task_id, agentId, commentText);
              text = task ? "Comment added" : `Error: Task not found: ${task_id}`;
              break;
            }
            default:
              text = `Error: Unknown task tool: ${name}`;
          }

          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Task error: ${err instanceof Error ? err.message : String(err)}` }],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle schedule tools (pause/resume/reminder/tool — supplement scheduler_* tools)
      if (
        name === "schedule_pause" ||
        name === "schedule_resume" ||
        name === "schedule_reminder" ||
        name === "schedule_tool"
      ) {
        try {
          if (!_scheduler) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Scheduler not available" }) }],
                },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          const args = toolArgs || {};
          let text = "";
          switch (name) {
            case "schedule_pause": {
              const r = _scheduler.pauseJobFromTool(args.id as string, agentId, channel);
              text = JSON.stringify(r.success ? { ok: true, title: r.title } : { ok: false, error: r.error });
              break;
            }
            case "schedule_resume": {
              const r = _scheduler.resumeJobFromTool(args.id as string, agentId, channel);
              text = JSON.stringify(r.success ? { ok: true, title: r.title } : { ok: false, error: r.error });
              break;
            }
            case "schedule_reminder": {
              const maxRuns = args.max_runs as number | undefined;
              if (maxRuns !== undefined && (!Number.isFinite(maxRuns) || maxRuns <= 0 || !Number.isInteger(maxRuns))) {
                text = JSON.stringify({ ok: false, error: "max_runs must be a positive integer" });
                break;
              }
              const r = _scheduler.createJobFromTool({
                channel,
                agentId,
                title: args.title as string,
                prompt: args.message as string,
                schedule: args.schedule as string,
                maxRuns,
                isReminder: true,
              });
              text = JSON.stringify(r.success ? { ok: true, job: r.job } : { ok: false, error: r.error });
              break;
            }
            case "schedule_tool": {
              const maxRuns = args.max_runs as number | undefined;
              const timeoutSeconds = args.timeout_seconds as number | undefined;
              if (maxRuns !== undefined && (!Number.isFinite(maxRuns) || maxRuns <= 0 || !Number.isInteger(maxRuns))) {
                text = JSON.stringify({ ok: false, error: "max_runs must be a positive integer" });
                break;
              }
              if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
                text = JSON.stringify({ ok: false, error: "timeout_seconds must be a positive number" });
                break;
              }
              const desc = args.description as string;
              const r = _scheduler.createJobFromTool({
                channel,
                agentId,
                title: desc.slice(0, 200),
                prompt: desc,
                schedule: args.schedule as string,
                maxRuns,
                timeoutSeconds,
                isToolCall: true,
                toolName: args.tool_name as string,
                toolArgs: typeof args.tool_args === "object" ? (args.tool_args as Record<string, unknown>) : {},
              });
              text = JSON.stringify(r.success ? { ok: true, job: r.job } : { ok: false, error: r.error });
              break;
            }
            default:
              text = JSON.stringify({ ok: false, error: `Unknown schedule tool: ${name}` });
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  { type: "text", text: `Schedule error: ${err instanceof Error ? err.message : String(err)}` },
                ],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle tmux tools
      if (name.startsWith("tmux_")) {
        try {
          const { hasTmux: hasTmuxCheck } = await import("../../claude-code/utils");
          if (!hasTmuxCheck()) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: "tmux is not available on this system" }] },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          const args = toolArgs || {};

          // Helper: spawn tmux with the project socket
          function getTmuxSocketForMcp(): string {
            return join(homedir(), ".clawd", "tmux-mcp.sock");
          }

          async function execTmuxMcp(
            tmuxArgs: string[],
          ): Promise<{ success: boolean; output: string; error?: string }> {
            const socketPath = getTmuxSocketForMcp();
            const proc = Bun.spawnSync(["tmux", "-S", socketPath, ...tmuxArgs], { stderr: "pipe" });
            const stdout = proc.stdout ? Buffer.from(proc.stdout).toString("utf-8") : "";
            const stderr = proc.stderr ? Buffer.from(proc.stderr).toString("utf-8") : "";
            if (proc.exitCode !== 0) {
              return { success: false, output: stdout, error: stderr.trim() || `Exit code: ${proc.exitCode}` };
            }
            return { success: true, output: stdout };
          }

          let text = "";
          switch (name) {
            case "tmux_send_command": {
              const session = args.session as string;
              if (!/^[a-zA-Z0-9_-]+$/.test(session)) {
                text = JSON.stringify({ ok: false, error: "Session name must be alphanumeric (a-z, A-Z, 0-9, _, -)" });
                break;
              }
              const socketPath = getTmuxSocketForMcp();
              const listProc = Bun.spawnSync(["tmux", "-S", socketPath, "list-sessions", "-F", "#{session_name}"], {
                stderr: "pipe",
              });
              const sessions =
                listProc.exitCode === 0
                  ? Buffer.from(listProc.stdout).toString("utf-8").split("\n").filter(Boolean)
                  : [];
              const sessionExists = sessions.includes(session);
              const cwd = (args.cwd as string) || process.cwd();
              const cdCmd = `cd "${cwd}" && ${args.command as string}`;
              if (!sessionExists) {
                const r = await execTmuxMcp(["new-session", "-d", "-s", session, cdCmd]);
                text = r.success
                  ? JSON.stringify({
                      ok: true,
                      session,
                      status: "created",
                      command: (args.command as string).slice(0, 100),
                    })
                  : JSON.stringify({ ok: false, error: r.error });
              } else {
                const r = await execTmuxMcp(["send-keys", "-t", session, cdCmd, "C-m"]);
                text = r.success
                  ? JSON.stringify({
                      ok: true,
                      session,
                      status: "command_sent",
                      command: (args.command as string).slice(0, 100),
                    })
                  : JSON.stringify({ ok: false, error: r.error });
              }
              break;
            }
            case "tmux_kill": {
              const r = await execTmuxMcp(["kill-session", "-t", args.session as string]);
              text = r.success
                ? JSON.stringify({ ok: true, session: args.session, status: "killed" })
                : JSON.stringify({ ok: false, error: r.error });
              break;
            }
            case "tmux_kill_window": {
              const target = `${args.session}:${args.window}`;
              const r = await execTmuxMcp(["kill-window", "-t", target]);
              text = r.success
                ? JSON.stringify({ ok: true, session: args.session, window: args.window, status: "killed" })
                : JSON.stringify({ ok: false, error: r.error });
              break;
            }
            case "tmux_list": {
              const r = await execTmuxMcp([
                "list-sessions",
                "-F",
                "#{session_name}|#{session_created}|#{session_windows}",
              ]);
              if (!r.success || !r.output.trim()) {
                text = JSON.stringify({ ok: true, sessions: [], message: "No tmux sessions" });
                break;
              }
              const sessions = r.output
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                  const [sname, created, windows] = line.split("|");
                  return { name: sname, created, windows };
                });
              text = JSON.stringify({ ok: true, sessions });
              break;
            }
            case "tmux_new_window": {
              const windowArgs = ["new-window", "-t", args.session as string];
              if (args.window) windowArgs.push("-n", args.window as string);
              if (args.command) windowArgs.push(args.command as string);
              const r = await execTmuxMcp(windowArgs);
              text = r.success
                ? JSON.stringify({ ok: true, session: args.session, window: args.window || "", status: "created" })
                : JSON.stringify({ ok: false, error: r.error });
              break;
            }
            case "tmux_send_input": {
              const keys = (args.keys as string)
                .replace(/C-m/gi, "Enter")
                .replace(/C-i/gi, "Tab")
                .replace(/C-\[/gi, "Escape")
                .replace(/C-c/gi, "C-c")
                .replace(/C-d/gi, "C-d");
              const r = await execTmuxMcp(["send-keys", "-t", args.session as string, keys, "Enter"]);
              text = r.success
                ? JSON.stringify({ ok: true, session: args.session, keys_sent: args.keys, status: "sent" })
                : JSON.stringify({ ok: false, error: r.error });
              break;
            }
            case "tmux_capture": {
              const captureArgs = ["capture-pane", "-t", args.session as string, "-p"];
              if (args.clear) captureArgs.push("-C");
              const r = await execTmuxMcp(captureArgs);
              text = r.success
                ? JSON.stringify({
                    ok: true,
                    session: args.session,
                    output: r.output,
                    truncated: r.output.length > 50000,
                  })
                : JSON.stringify({ ok: false, error: r.error });
              break;
            }
            default:
              text = JSON.stringify({ ok: false, error: `Unknown tmux tool: ${name}` });
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Tmux error: ${err instanceof Error ? err.message : String(err)}` }],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle skill tools
      if (name.startsWith("skill_")) {
        try {
          const { getSkillManager } = await import("../../agent/skills/manager");
          const manager = getSkillManager();
          manager.indexSkillsIfStale();
          const args = toolArgs || {};
          let text = "";
          switch (name) {
            case "skill_list": {
              const skills = manager.listSkills();
              if (skills.length === 0) {
                text = "No skills installed. Use skill_create to add skills to the project.";
                break;
              }
              text = `Available skills:\n\n${skills.map((s: any) => `• **${s.name}** (${s.source}): ${s.description}\n  Triggers: ${s.triggers.join(", ")}`).join("\n\n")}`;
              break;
            }
            case "skill_search": {
              const matches = manager.searchByKeywords(args.keywords as string[]);
              if (matches.length === 0) {
                text = "No matching skills found.";
                break;
              }
              text = `Matching skills:\n\n${matches.map((m: any) => `• **${m.skill.name}** (${m.skill.source}, ${Math.round(m.score * 100)}% match)\n  ${m.skill.description}\n  Matched: ${m.matchedTriggers.join(", ")}`).join("\n\n")}`;
              break;
            }
            case "skill_activate": {
              const skill = manager.getSkill(args.name as string);
              if (!skill) {
                text = `Skill '${args.name}' not found. Use skill_list to see available skills.`;
                break;
              }
              // A4: Track usage for TTL-based cleanup of auto-generated skills
              manager.touchSkill(args.name as string);
              text = `# Skill: ${skill.name} (${skill.source})\n\n${skill.content}\n\n---\n*Skill activated. Follow the guidelines above.*`;
              break;
            }
            case "skill_create": {
              const scope = ((args.scope as string) || "project") as "project" | "global";
              const result = manager.saveSkill(
                {
                  name: args.name as string,
                  description: args.description as string,
                  triggers: args.triggers as string[],
                  content: args.content as string,
                },
                scope,
              );
              text = result.success ? `Skill '${args.name}' saved to ${scope} scope.` : `Error: ${result.error}`;
              break;
            }
            case "skill_delete": {
              const deleted = manager.deleteSkill(args.name as string);
              text = deleted ? `Skill '${args.name}' deleted.` : `Skill '${args.name}' not found.`;
              break;
            }
            case "skill_cleanup": {
              // A4: Delete auto-generated skills unused for longer than max_age_days
              const maxAgeDays = Math.max(1, typeof args.max_age_days === "number" ? args.max_age_days : 30);
              const deletedCount = manager.cleanupStaleAutoSkills(maxAgeDays);
              text = `Cleaned up ${deletedCount} stale auto-generated skill(s) older than ${maxAgeDays} days.`;
              break;
            }
            default:
              text = `Error: Unknown skill tool: ${name}`;
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Skill error: ${err instanceof Error ? err.message : String(err)}` }],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle article tools
      if (name.startsWith("article_") || name === "send_article") {
        try {
          const { randomUUID } = await import("crypto");
          const args = toolArgs || {};
          let text = "";
          switch (name) {
            case "article_create": {
              const {
                title,
                content: rawContent,
                file_id,
                message_ts: msgTs,
                description: desc,
                thumbnail_url,
                tags,
                published,
              } = args as Record<string, any>;
              if (!title) {
                text = JSON.stringify({ ok: false, error: "title is required" });
                break;
              }

              // Resolve content from one of three sources
              let resolvedContent: string | null = rawContent || null;

              if (!resolvedContent && file_id) {
                const { getFile } = await import("../routes/files");
                const fileResult = getFile(file_id as string);
                if (!fileResult) {
                  text = JSON.stringify({ ok: false, error: `File not found: ${file_id}` });
                  break;
                }
                resolvedContent = fileResult.data.toString("utf-8");
              }

              if (!resolvedContent && msgTs) {
                const msg = db
                  .query<{ text: string }, [string]>(`SELECT text FROM messages WHERE ts = ?`)
                  .get(msgTs as string);
                if (!msg) {
                  text = JSON.stringify({ ok: false, error: `Message not found: ${msgTs}` });
                  break;
                }
                resolvedContent = msg.text;
              }

              if (!resolvedContent) {
                text = JSON.stringify({ ok: false, error: "Provide one of: content, file_id, or message_ts" });
                break;
              }

              const now = Math.floor(Date.now() / 1000);
              const articleId = randomUUID();
              const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : "[]";
              db.run(
                `INSERT INTO articles (id, channel, author, title, description, thumbnail_url, content, tags_json, published, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  articleId,
                  channel,
                  agentId,
                  title,
                  desc || null,
                  thumbnail_url || null,
                  resolvedContent,
                  tagsJson,
                  published ? 1 : 0,
                  now,
                  now,
                ],
              );
              const article = db.query("SELECT * FROM articles WHERE id = ?").get(articleId) as any;
              text = JSON.stringify({
                ok: true,
                article: {
                  id: article.id,
                  title: article.title,
                  url: `/articles/${article.id}`,
                  published: article.published === 1,
                },
              });
              break;
            }
            case "article_delete": {
              db.run("DELETE FROM articles WHERE id = ?", [args.id as string]);
              text = JSON.stringify({ ok: true, id: args.id, deleted: true });
              break;
            }
            case "article_get": {
              const article = db.query("SELECT * FROM articles WHERE id = ?").get(args.id as string) as any;
              if (!article) {
                text = JSON.stringify({ ok: false, error: "Article not found" });
                break;
              }
              text = JSON.stringify({
                ok: true,
                article: {
                  id: article.id,
                  title: article.title,
                  description: article.description,
                  author: article.author,
                  content: article.content,
                  thumbnail_url: article.thumbnail_url,
                  tags: JSON.parse(article.tags_json || "[]"),
                  published: article.published === 1,
                  created_at: article.created_at,
                  updated_at: article.updated_at,
                },
              });
              break;
            }
            case "article_list": {
              const limit = Math.min(Number(args.limit || 10), 100);
              const offset = Number(args.offset || 0);
              const publishedOnly = args.published_only !== false;
              const rows = db
                .query<any, any[]>(
                  `SELECT id, title, description, author, published, created_at FROM articles WHERE channel = ?${publishedOnly ? " AND published = 1" : ""} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                )
                .all(channel, limit, offset);
              text = JSON.stringify({
                ok: true,
                articles: rows.map((a: any) => ({ ...a, published: a.published === 1 })),
              });
              break;
            }
            case "article_update": {
              const existing = db.query("SELECT id FROM articles WHERE id = ?").get(args.id as string) as any;
              if (!existing) {
                text = JSON.stringify({ ok: false, error: "Article not found" });
                break;
              }
              const updates: string[] = [];
              const params: (string | number | boolean | null)[] = [];
              const {
                title,
                content,
                description: desc,
                thumbnail_url,
                tags,
                published,
              } = args as Record<string, unknown>;
              if (title !== undefined) {
                updates.push("title = ?");
                params.push(title);
              }
              if (content !== undefined) {
                updates.push("content = ?");
                params.push(content);
              }
              if (desc !== undefined) {
                updates.push("description = ?");
                params.push(desc);
              }
              if (thumbnail_url !== undefined) {
                updates.push("thumbnail_url = ?");
                params.push(thumbnail_url);
              }
              if (tags !== undefined) {
                updates.push("tags_json = ?");
                params.push(Array.isArray(tags) ? JSON.stringify(tags) : "[]");
              }
              if (published !== undefined) {
                updates.push("published = ?");
                params.push(published ? 1 : 0);
              }
              if (updates.length === 0) {
                text = JSON.stringify({ ok: false, error: "No fields to update" });
                break;
              }
              updates.push("updated_at = ?");
              params.push(Math.floor(Date.now() / 1000), args.id as string);
              db.run(`UPDATE articles SET ${updates.join(", ")} WHERE id = ?`, params);
              const article = db.query("SELECT * FROM articles WHERE id = ?").get(args.id as string) as any;
              text = JSON.stringify({
                ok: true,
                article: { id: article.id, title: article.title, updated_at: article.updated_at },
              });
              break;
            }
            case "send_article": {
              const article = db.query("SELECT * FROM articles WHERE id = ?").get(args.article_id as string) as any;
              if (!article) {
                text = JSON.stringify({ ok: false, error: "Article not found" });
                break;
              }
              const msgResult = postMessage({
                channel,
                user: "UBOT",
                agent_id: agentId,
                text: `Article: ${article.title}`,
                subtype: "article",
                article_json: JSON.stringify({
                  id: article.id,
                  title: article.title,
                  description: article.description,
                  author: article.author,
                  thumbnail_url: article.thumbnail_url,
                }),
              });
              broadcastUpdate(channel, { type: "new_message" });
              text = JSON.stringify({
                ok: true,
                message_ts: (msgResult as any).ts,
                article_id: article.id,
                article_url: `/articles/${article.id}`,
              });
              break;
            }
            default:
              text = JSON.stringify({ ok: false, error: `Unknown article tool: ${name}` });
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Article error: ${err instanceof Error ? err.message : String(err)}` }],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle memory tools
      if (name === "memory_search" || name === "memory_summary") {
        try {
          const { getMemoryManager } = await import("../../agent/memory/memory");
          const memory = getMemoryManager();
          const args = toolArgs || {};
          let text = "";
          switch (name) {
            case "memory_search": {
              // Auto-scope to current channel unless a specific session_id is provided.
              // Session names follow the pattern "{channel}-{agentId}", so filtering
              // by "{channel}-" prefix limits results to the current channel's history.
              const results = memory.search({
                keywords: args.keywords as string[] | undefined,
                startTime: args.start_time as number | undefined,
                endTime: args.end_time as number | undefined,
                role: args.role as ("user" | "assistant" | "tool") | undefined,
                sessionId: args.session_id as string | undefined,
                sessionNamePrefix: !args.session_id && channel ? `${channel}-` : undefined,
                limit: (args.limit as number) || 20,
              });
              if (results.length === 0) {
                text = "No matching messages found.";
                break;
              }
              const formatted = results
                .map(
                  (r: any) =>
                    `[${new Date(r.createdAt).toISOString()}] (${r.sessionName}) ${r.role}: ${r.content?.slice(0, 200)}${r.content?.length > 200 ? "..." : ""}`,
                )
                .join("\n\n");
              text = `Found ${results.length} messages:\n\n${formatted}`;
              break;
            }
            case "memory_summary": {
              const summary = memory.getSessionSummary(args.session_id as string);
              if (!summary) {
                text = "Error: Session not found";
                break;
              }
              text = `Session: ${summary.sessionName}\nMessages: ${summary.messageCount}\nTime Range: ${new Date(summary.timeRange.start).toISOString()} - ${new Date(summary.timeRange.end).toISOString()}\nKey Topics: ${summary.keyTopics.join(", ") || "None detected"}\n\nSummary: ${summary.summary}`;
              break;
            }
            default:
              text = `Error: Unknown memory tool: ${name}`;
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Memory error: ${err instanceof Error ? err.message : String(err)}` }],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle agent memory tools (memo_* — same as non-CC agents)
      if (
        name === "memo_save" ||
        name === "memo_recall" ||
        name === "memo_delete" ||
        name === "memo_pin" ||
        name === "memo_unpin"
      ) {
        try {
          const { getAgentMemoryStore } = await import("../../agent/memory/agent-memory");
          const store = getAgentMemoryStore();

          // Helper: format unix timestamp to relative age string
          function formatAge(unixSeconds: number): string {
            const now = Math.floor(Date.now() / 1000);
            const diff = now - unixSeconds;
            if (diff < 60) return "just now";
            if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
            if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
            return `${Math.floor(diff / 604800)}w ago`;
          }
          const args = toolArgs || {};
          let text = "";

          switch (name) {
            case "memo_save": {
              const content = args.content as string;
              if (!content?.trim()) {
                text = JSON.stringify({ ok: false, error: "Content is required" });
                break;
              }
              const result = store.save({
                agentId,
                channel,
                content: content.trim(),
                category: args.category as any,
                source: "explicit",
              });
              if (result.id === null) {
                text = JSON.stringify({ ok: false, error: result.warning || "Failed to save memory" });
              } else {
                const msg = result.warning
                  ? `Memory #${result.id} saved (${result.warning})`
                  : `Memory #${result.id} saved successfully`;
                text = JSON.stringify({ ok: true, id: result.id, message: msg });
              }
              break;
            }
            case "memo_recall": {
              const results = store.recall({
                agentId,
                channel,
                query: args.query as string | undefined,
                category: args.category as any,
                limit: (args.limit as number) || 20,
                offset: (args.offset as number) || 0,
                includeGlobal: true,
              });
              if (results.length === 0) {
                text = args.query ? `No memories found matching "${args.query}"` : "No memories saved yet";
              } else {
                const lines = results.map((m: any) => {
                  const age = formatAge(m.createdAt);
                  const scope = m.channel ? "" : " [agent-wide]";
                  return `#${m.id} [${m.category}] (${age}${scope}): ${m.content}`;
                });
                const header = args.query
                  ? `Found ${results.length} memories matching "${args.query}":`
                  : `Recent ${results.length} memories:`;
                text = `${header}\n${lines.join("\n")}`;
              }
              break;
            }
            case "memo_delete": {
              const id = Number(args.id);
              if (!id || isNaN(id)) {
                text = JSON.stringify({ ok: false, error: "Valid memory ID required" });
                break;
              }
              const deleted = store.delete(id, agentId);
              text = deleted
                ? JSON.stringify({ ok: true, message: `Memory #${id} deleted` })
                : JSON.stringify({ ok: false, error: `Memory #${id} not found or not owned by you` });
              break;
            }
            case "memo_pin": {
              const id = Number(args.id);
              if (!id || isNaN(id)) {
                text = JSON.stringify({ ok: false, error: "Valid memory ID required" });
                break;
              }
              const result = store.pin(id, agentId);
              text = result.success
                ? `Memory #${id} pinned — it will always be loaded into your context.`
                : JSON.stringify({ ok: false, error: result.error || "Failed to pin" });
              break;
            }
            case "memo_unpin": {
              const id = Number(args.id);
              if (!id || isNaN(id)) {
                text = JSON.stringify({ ok: false, error: "Valid memory ID required" });
                break;
              }
              const result = store.unpin(id, agentId);
              text = result.success
                ? `Memory #${id} unpinned — it will only be loaded when relevant.`
                : JSON.stringify({ ok: false, error: result.error || "Failed to unpin" });
              break;
            }
            default:
              text = `Error: Unknown memo tool: ${name}`;
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Memory error: ${err instanceof Error ? err.message : String(err)}` }],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle utility tools
      if (name === "today" || name === "convert_to_markdown" || name === "get_agent_logs" || name === "bash") {
        try {
          const args = toolArgs || {};
          let text = "";
          switch (name) {
            case "today": {
              const now = new Date();
              const date = now.toLocaleDateString("en-CA");
              const time = now.toLocaleTimeString("en-US", { hour12: false });
              const day = now.toLocaleDateString("en-US", { weekday: "long" });
              text = `${day}, ${date} ${time}`;
              break;
            }
            case "convert_to_markdown": {
              const filePath = args.path as string;
              if (!filePath) {
                text = "Error: path is required";
                break;
              }
              const { convertToMarkdown } = await import("../../agent/tools/document-converter");
              const result = await convertToMarkdown(filePath);
              if (!result.success) {
                text = `Error: ${result.error}`;
                break;
              }
              const { writeFile, mkdir } = await import("node:fs/promises");
              const { basename, extname, join } = await import("node:path");
              // Prefer injected project root; fall back to CWD so the .md never lands
              // in the user's home dir (which leaks outputs across projects).
              const projectRoot = (args._project_root as string | undefined) || process.cwd();
              const filesDir = join(projectRoot, ".clawd", "files");
              await mkdir(filesDir, { recursive: true });
              const base = basename(filePath, extname(filePath)).replace(/[^a-zA-Z0-9._-]/g, "_") || "converted";
              const mdPath = join(filesDir, `${base}.md`);
              await writeFile(mdPath, result.markdown, "utf-8");
              text = `Converted ${result.format?.toUpperCase() || "document"} to Markdown (${result.markdown.length} chars). Saved to: ${mdPath}\nUse view("${mdPath}") to read the full content.`;
              break;
            }
            case "get_agent_logs": {
              const targetAgentId = args.agent_id as string;
              // Validate targetAgentId to only allow safe characters (prevent path traversal)
              if (!/^[a-zA-Z0-9_-]+$/.test(targetAgentId)) {
                text = `Error: Invalid agent_id "${targetAgentId}": only alphanumeric, underscore, and hyphen characters are allowed.`;
                break;
              }
              const tail = (args.tail as number) || 100;
              // Use getProjectAgentsDir() for correct project-scoped path
              // (mirrors chat-tools.ts get_agent_logs handler)
              const { readFileSync, existsSync, statSync: fsStatSync } = await import("node:fs");
              const agentsDir = getProjectAgentsDir();
              // sessionName = agent_id without "tmux-" prefix, matching chat-tools.ts logic
              const sessionName = targetAgentId.replace(/^tmux-/, "");
              const logFile = join(agentsDir, sessionName, "output.log");
              const MAX_LOG_BYTES = 1 * 1024 * 1024; // 1 MB
              if (existsSync(logFile)) {
                const logStat = fsStatSync(logFile);
                if (logStat.size > MAX_LOG_BYTES) {
                  text = `Agent: ${targetAgentId}\n(log file too large: ${logStat.size} bytes, max ${MAX_LOG_BYTES})`;
                } else {
                  const content = readFileSync(logFile, "utf-8");
                  const lines = content.split("\n");
                  const output = lines.slice(-tail).join("\n");
                  text = `Agent: ${targetAgentId}\n\n--- Output (last ${Math.min(tail, lines.length)} lines) ---\n${output || "(no output yet)"}`;
                }
              } else {
                text = `Agent: ${targetAgentId}\n(no output log found at ${logFile} — agent may not have started yet)`;
              }
              break;
            }
            case "bash": {
              const { spawn: spawnBash } = await import("node:child_process");
              const command = args.command as string;
              if (!command) {
                text = "Error: command is required";
                break;
              }
              const timeoutMs = Math.min((args.timeout as number) || 30000, 600000);
              const description = (args.description as string) || "";
              const runInBackground = (args.run_in_background as boolean) || false;
              const cwdArg = args.cwd as string | undefined;
              const workDir = cwdArg || process.cwd();

              // Background mode: delegate to tmux job manager
              if (runInBackground) {
                try {
                  const { tmuxJobManager } = await import("../../agent/jobs/tmux-manager");
                  const jobName = description || command.slice(0, 40).replace(/[^a-zA-Z0-9-_]/g, "_");
                  const jobId = tmuxJobManager.submit(jobName, command);
                  text = `Background job started: ${jobId}\nUse job_status(job_id="${jobId}") to check output.`;
                } catch (bgErr: unknown) {
                  text = `Error: Failed to start background job: ${bgErr instanceof Error ? bgErr.message : String(bgErr)}`;
                }
                break;
              }

              // Foreground execution: SIGTERM → SIGKILL escalation, 100KB output limit
              const MAX_MCP_BASH_OUTPUT = 100 * 1024; // 100KB

              let finalCommand = command;

              // Apply sandbox wrapping if Claw'd server itself is sandboxed
              const {
                isSandboxEnabled: isSbxEnabled,
                isSandboxReady: isSbxReady,
                wrapCommandForSandbox: wrapCmd,
              } = await import("../../agent/utils/sandbox");
              if (isSbxEnabled() && isSbxReady()) {
                try {
                  finalCommand = await wrapCmd(command, workDir);
                } catch (wrapErr: unknown) {
                  text = `Error: Sandbox wrapping failed: ${wrapErr instanceof Error ? wrapErr.message : String(wrapErr)}`;
                  break;
                }
              }

              text = await new Promise<string>((resolve) => {
                const proc = spawnBash("bash", ["-c", finalCommand], {
                  cwd: workDir,
                  env: {
                    ...process.env,
                    DEBIAN_FRONTEND: "noninteractive",
                    GIT_TERMINAL_PROMPT: "0",
                    HOMEBREW_NO_AUTO_UPDATE: "1",
                    CONDA_YES: "1",
                    PIP_NO_INPUT: "1",
                  },
                });

                let timedOut = false;
                let killed = false;

                // Graceful shutdown: SIGTERM first, then SIGKILL after 3s grace period
                const timeoutId = setTimeout(() => {
                  timedOut = true;
                  proc.kill("SIGTERM");
                  setTimeout(() => {
                    if (!killed) {
                      killed = true;
                      proc.kill("SIGKILL");
                    }
                  }, 3000);
                }, timeoutMs);

                let stdout = "";
                let stderr = "";
                let outputBytes = 0;
                let outputTruncated = false;

                proc.stdout?.on("data", (data: Buffer) => {
                  if (outputBytes < MAX_MCP_BASH_OUTPUT) {
                    stdout += data.toString();
                    outputBytes += data.length;
                    if (outputBytes >= MAX_MCP_BASH_OUTPUT) outputTruncated = true;
                  }
                });
                proc.stderr?.on("data", (data: Buffer) => {
                  if (outputBytes < MAX_MCP_BASH_OUTPUT) {
                    stderr += data.toString();
                    outputBytes += data.length;
                    if (outputBytes >= MAX_MCP_BASH_OUTPUT) outputTruncated = true;
                  }
                });

                proc.on("close", (code: number | null) => {
                  clearTimeout(timeoutId);
                  killed = true;
                  const truncNote = outputTruncated ? "\n[OUTPUT TRUNCATED: exceeded 100KB limit]" : "";
                  if (timedOut) {
                    resolve(
                      `TIMEOUT: Command exceeded ${timeoutMs / 1000}s. Partial output:\n${stdout.trim()}` +
                        `${stderr.trim() ? `\nSTDERR:\n${stderr.trim()}` : ""}${truncNote}\n` +
                        `Tip: Use run_in_background=true for long-running commands.`,
                    );
                    return;
                  }
                  const parts: string[] = [];
                  if (stdout.trim()) parts.push(stdout.trimEnd());
                  if (stderr.trim()) parts.push(`STDERR:\n${stderr.trim()}`);
                  const output = parts.join("\n") + truncNote;
                  resolve(code !== 0 ? `Exit code: ${code}\n${output || "(no output)"}` : output || "(no output)");
                });

                proc.on("error", (err: Error) => {
                  clearTimeout(timeoutId);
                  resolve(`Error: ${err.message}`);
                });
              });
              break;
            }
            default:
              text = `Error: Unknown utility tool: ${name}`;
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  { type: "text", text: `Utility tool error: ${err instanceof Error ? err.message : String(err)}` },
                ],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Check if this is an agent management or todo tool
      const AGENT_TOOL_NAMES = [
        "spawn_agent",
        "list_agents",
        "get_agent_report",
        "stop_agent",
        "todo_write",
        "todo_read",
        "todo_update",
      ];
      if (AGENT_TOOL_NAMES.includes(name)) {
        const { executeAgentToolCall } = await import("../../spaces/agent-mcp-tools");
        const result = await executeAgentToolCall(name, toolArgs || {}, channel, agentId);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check if this is a tunnel tool
      if (name.startsWith("tunnel_")) {
        try {
          const { TunnelPlugin } = await import("../../agent/plugins/tunnel-plugin");
          // Pass owner context so tmux-backed metadata records which
          // channel+agent created each tunnel (used by tunnel_list filters
          // and tunnel_prune).
          const tunnelPlugin = new TunnelPlugin(channel, agentId);
          const tools = tunnelPlugin.getTools();
          const tool = tools.find((t) => t.name === name);
          if (tool) {
            const result = await tool.handler(toolArgs || {});
            const text = result.success ? result.output : `Error: ${result.error || "Unknown error"}`;
            return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Tunnel error: ${err instanceof Error ? err.message : String(err)}` }],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Check if this is a browser tool
      if (name.startsWith("browser_")) {
        try {
          const { BrowserPlugin } = await import("../../agent/plugins/browser-plugin");
          const browserPlugin = new BrowserPlugin(channel, agentId);
          const tools = browserPlugin.getTools();
          const tool = tools.find((t) => t.name === name);
          if (tool) {
            const result = await tool.handler(toolArgs || {});
            const text = result.success ? result.output : `Error: ${result.error || "Unknown error"}`;
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text }] },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Browser error: ${err instanceof Error ? err.message : String(err)}` }],
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle connected channel MCP server tools FIRST (before enrichment)
      // External tools like Notion reject unknown fields (channel/agent_id) in their API
      try {
        const mcpManager = _workerManager?.getChannelMcpManager(channel);
        if (mcpManager) {
          const mcpResult = await mcpManager.executeMCPTool(name, toolArgs || {});
          if (mcpResult !== undefined) {
            const text = typeof mcpResult === "string" ? mcpResult : JSON.stringify(mcpResult);
            return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
      } catch {
        // Intentionally swallowed — channel MCP tool execution is best-effort; falls through to local tool handler
      }

      // Auto-inject channel and agent_id into local chat tool calls only.
      // Also inject `_project_root` for tools that can save files locally
      // (download_file, convert_to_markdown) so CC agents get the same
      // "auto-save to {projectRoot}/.clawd/files/" behaviour non-CC agents
      // get via the clawd-chat plugin's transformToolArgs hook. Without this,
      // CC agents fall through to the metadata-only branch of
      // download_file and never get `local_path` — breaking the
      // system-prompt contract that says "saves into the project root".
      const needsProjectRoot = name === "download_file" || name === "convert_to_markdown";
      const enrichedArgs: Record<string, unknown> = {
        ...(toolArgs || {}),
        channel: (toolArgs?.channel as string) || channel,
        agent_id: (toolArgs?.agent_id as string) || agentId,
      };
      if (needsProjectRoot && !enrichedArgs._project_root) {
        try {
          const { getAgentProjectRoot } = await import("../routes/agents");
          const pr = getAgentProjectRoot(db, channel, agentId);
          if (pr) enrichedArgs._project_root = pr;
        } catch {
          // Best-effort — if lookup fails the tool falls through to its
          // metadata-only branch, which still works (agent can retry
          // download_file from a context with _project_root injected).
        }
      }

      const result = await executeToolCall(name, enrichedArgs);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown method: ${method}` }) }],
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" },
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
}

/**
 * Handle MCP requests scoped to a specific space.
 * Only exposes `complete_task` — no other tools visible.
 * Route: /mcp/space/{spaceId}
 */
