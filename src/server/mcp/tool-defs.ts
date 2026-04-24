/**
 * MCP Tool definitions (static schemas exposed via tools/list).
 * Covers chat, plan, scheduler, and multimodal tools.
 */

// MCP Tool definitions
export const MCP_TOOLS = [
  {
    name: "pollack",
    description: `Poll for new messages in a channel and mark them as seen.

This is the primary tool for agents to receive messages. It:
1. Fetches the agent's last_processed_ts from the server
2. Marks ALL messages as SEEN (user knows you received them)
3. Returns "pending" = UHUMAN messages after last_processed_ts

Args:
  - channel (string): Channel ID (e.g., "chat-task", "general")
  - agent_id (string): Agent identifier (default: "default")
  - include_bot (boolean): Include bot/worker messages in pending (default: false)
  - limit (number): Max pending messages to return (default: 20, max: 100)
  - offset (number): Skip first N pending messages for pagination (default: 0)

Returns JSON:
{
  "ok": true,
  "pending": [...],            // Unprocessed messages needing action
  "last_seen_ts": "...",       // Timestamp marked as seen
  "last_processed_ts": "...",  // Last processed timestamp
  "count": number,             // Total pending count (before limit/offset)
  "has_more": boolean          // True if more pending messages exist beyond this page
}

CRITICAL: If count > 0, you MUST process each message in "pending" array:
1. Read pending[i].text
2. Execute the task
3. End the turn with reply_human(text="<reply or [SILENT]>", timestamp=pending[i].ts).
   reply_human delivers the reply AND marks the message processed in one call.

IMPORTANT: Every turn must end with reply_human to prevent re-processing on
restart. Use this tool for polling loops, every 2-10 seconds.`,
    inputSchema: {
      type: "object",
      properties: {
        include_bot: {
          type: "boolean",
          description: "Include bot/worker messages in pending (default: false)",
          default: false,
        },
        limit: {
          type: "number",
          description: "Max pending messages to return (default: 20, max: 100)",
          default: 20,
        },
        offset: {
          type: "number",
          description: "Skip first N pending messages for pagination (default: 0)",
          default: 0,
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: false, // Modifies seen state
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "reply_human",
    description: `Reply to the human and end the current turn.

MANDATORY: Every turn MUST end with exactly one call to reply_human.
- To send a reply: pass text with the message content.
- To skip replying (no user-facing message this turn): pass text="" or text="[SILENT]".
- If a human message triggered this turn, pass its ts via timestamp to mark it processed
  (prevents it reappearing as pending on restart). Omit timestamp for proactive/scheduled turns.
- To attach files: pass file_ids (array) from upload_file.

Args:
  - channel (string): Channel ID (e.g., "chat-task")
  - text (string): Message text (supports markdown). "" or "[SILENT]" = no message sent.
  - agent_id (string): Agent identifier (e.g., "Claw'd 1")
  - timestamp (string, optional): Human message ts to mark as processed.
  - file_ids (string[], optional): Attach files uploaded via upload_file.

Returns JSON:
{
  "ok": true,
  "ts": "1234567890.123456",  // Sent message timestamp (absent when SILENT)
  "channel": "chat-task",
  "files": [...],             // Attached files (when file_ids provided)
  "last_processed_ts": "..."  // When timestamp was provided
}

Flow: poll_and_ack -> do work -> reply_human (marks processed + ends turn).`,
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: 'Message text (supports markdown). Pass "" or "[SILENT]" to skip sending.',
        },
        timestamp: {
          type: "string",
          description:
            "Optional ts of the human message that triggered this turn. When present, marks it as processed so it won't resurface after restart.",
        },
        file_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional file IDs to attach (from upload_file). Ignored when text is empty or [SILENT].",
        },
        html_preview: {
          type: "string",
          description:
            "Optional HTML content to render as a preview (use for rich visual content like charts, diagrams, or formatted output)",
        },
        workspace_json: {
          type: "string",
          description:
            'Optional JSON string for an agent workspace preview card. Format: {"workspace_id":"<id>","title":"<title>","description":"<optional>","status":"running|waiting|completed"}. Clicking the card opens the agent\'s noVNC desktop in a new tab.',
        },
        code_preview: {
          type: "object",
          description: "Optional code preview with syntax highlighting",
          properties: {
            filename: {
              type: "string",
              description: "Filename to display (e.g., 'app.ts')",
            },
            language: {
              type: "string",
              description: "Programming language for syntax highlighting (e.g., 'typescript', 'python')",
            },
            content: { type: "string", description: "Code content to display" },
            start_line: {
              type: "number",
              description: "Starting line number (optional)",
            },
            highlight_lines: {
              type: "array",
              items: { type: "number" },
              description: "Line numbers to highlight (optional)",
            },
          },
          required: ["filename", "language", "content"],
        },
        interactive_json: {
          type: "object",
          description:
            "Interactive component spec for user interactions (approvals, forms, polls). Contains: version, components[], on_action, one_shot",
          properties: {
            version: { type: "string", description: "Schema version (default '1')" },
            components: { type: "array", description: "Array of component objects" },
            on_action: { type: "object", description: "Action handler config" },
            one_shot: { type: "boolean", description: "Disable after first action (default true)" },
          },
        },
      },
      required: ["text"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "query_files",
    description: `Search and query file attachments across the channel's message history.
Mirrors query_messages but scoped to attachments — use this whenever the agent
needs to locate a file by name, id, mimetype, uploader, or time window.

Args:
  - channel (string, required): Channel ID
  - ts (string): Only files attached to this exact message timestamp
  - file_id (string): Exact file id lookup — returns 0 or 1 files
  - from_ts (string): Files on messages with ts > from_ts (exclusive)
  - to_ts (string): Files on messages with ts < to_ts (exclusive; pagination cursor)
  - name (string): Substring match against file name (case-insensitive)
  - mimetype (string): Case-insensitive. Ends with "/" → prefix match (e.g., "image/" matches image/png, image/jpeg). Otherwise exact match (e.g., "application/pdf"). Passing "image" alone will NOT match anything.
  - uploader_ids (string[]): Filter by uploader user IDs (e.g., "UHUMAN", "UWORKER-xyz")
  - roles (string[]): Filter by uploader role: "bot", "worker", "human"
  - agent_ids (string[]): Filter by agent_id of the attaching message
  - limit (number): Max files to return (default: 100, max: 500)
  - order (string): "asc" (default, oldest first) or "desc" (newest first)

Returns JSON:
{
  "ok": true,
  "files": [
    {
      "id": "F...",
      "name": "...",
      "mimetype": "...",
      "size": number,
      "message_ts": "...",
      "uploaded_by": "...",
      "created_at": number,
      "image_hint"?: "..."
    }
  ],
  "count": number,
  "has_more": boolean
}

Role mapping: UBOT="bot", UWORKER-*="worker", UHUMAN="human"

To read a file's content, follow up with download_file(file_id) — for images use
read_image, for documents use convert_to_markdown after downloading.

Examples:

1. All files on one message:
   { "channel": "chat-task", "ts": "1234567890.123456" }

2. Look up one file by id:
   { "channel": "chat-task", "file_id": "Fxyz123" }

3. Find PDFs uploaded by humans:
   { "channel": "chat-task", "mimetype": "application/pdf", "roles": ["human"] }

4. Find images by name pattern:
   { "channel": "chat-task", "mimetype": "image/", "name": "screenshot" }

5. Recent uploads (newest first):
   { "channel": "chat-task", "limit": 20, "order": "desc" }`,
    inputSchema: {
      type: "object",
      properties: {
        ts: {
          type: "string",
          description: "Only files attached to this exact message timestamp",
        },
        file_id: {
          type: "string",
          description: "Exact file id lookup — returns 0 or 1 files",
        },
        from_ts: {
          type: "string",
          description: "Files on messages with ts > from_ts (exclusive)",
        },
        to_ts: {
          type: "string",
          description: "Files on messages with ts < to_ts (exclusive; pagination cursor)",
        },
        name: {
          type: "string",
          description: "Substring match against file name (case-insensitive)",
        },
        mimetype: {
          type: "string",
          description:
            'Case-insensitive. Trailing "/" → prefix match (e.g., "image/"); otherwise exact (e.g., "application/pdf"). "image" alone matches nothing.',
        },
        uploader_ids: {
          type: "array",
          items: { type: "string" },
          description: "Filter by uploader user IDs",
        },
        roles: {
          type: "array",
          items: { type: "string", enum: ["bot", "worker", "human"] },
          description: "Filter by uploader role",
        },
        agent_ids: {
          type: "array",
          items: { type: "string" },
          description: "Filter by agent_id of the attaching message",
        },
        limit: {
          type: "number",
          description: "Max files to return (default: 100, max: 500)",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: '"asc" (default, oldest first) or "desc" (newest first)',
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "download_file",
    description: `Download a file attachment and save it locally for the agent to access.

Args:
  - file_id (string): File ID from message attachments

Returns JSON:
{
  "ok": true,
  "file": {
    "id": "...",
    "name": "...",
    "mimetype": "...",
    "size": number,
    "local_path": "..."  // Absolute path where the file was saved
  },
  "hint": "..."  // Instructions on how to access the file
}

The file is automatically saved to {projectRoot}/.clawd/files/{filename}.
File content is NEVER included in the result to avoid context bloat.
Use the returned local_path to read the file with view, bash, or other tools.

**For images:** Use the read_image tool with the file_id instead.
**For documents (PDF, DOCX, XLSX, PPTX, etc.):** Use convert_to_markdown tool with the local_path to convert to readable text.`,
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "File ID from message attachments",
        },
      },
      required: ["file_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "upload_file",
    description: `Upload a file from a local filesystem path. Reads the file server-side so the LLM never needs to handle base64 data.

**WORKFLOW FOR ATTACHING LOCAL FILES TO MESSAGES:**
1. upload_file → returns file_id (reads file from disk)
2. reply_human(file_ids=[...]) → sends message with attached files (ends the turn)

Args:
  - file_path (string): Absolute path to the file on the local filesystem
  - channel (string): Channel ID (for association)
  - filename (string): Optional display name override (defaults to basename of file_path)
  - mimetype (string): Optional MIME type override (auto-detected from extension if not provided)

Returns JSON:
{
  "ok": true,
  "file": {
    "id": "F...",
    "name": "icon.png",
    "mimetype": "image/png",
    "size": 18432
  }
}

Use file.id (the file_id) with reply_human's file_ids arg to attach the file to a message.

**COMPLETE EXAMPLE:**
\`\`\`
// Step 1: Upload from local path
result1 = upload_file(
  file_path="/path/to/icon.png",
  channel="chat-task"
)
// result1.file.id = "Fxyz123"

// Step 2: Send message with file attachment (ends turn)
reply_human(
  channel="chat-task",
  text="Here's the icon:",
  file_ids=["Fxyz123"],
  agent_id="MyAgent",
  timestamp="<triggering human msg ts>"
)
\`\`\``,
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute path to the file on the local filesystem",
        },
        filename: {
          type: "string",
          description: "Optional display name (defaults to basename of file_path)",
        },
        mimetype: {
          type: "string",
          description: "Optional MIME type (auto-detected from extension if not provided)",
        },
      },
      required: ["file_path"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "update_message",
    description: `Modify an existing message's text content. Use mode to replace the full text
or append new content to the end.

Args:
  - channel (string): Channel ID
  - ts (string): Message timestamp/ID to modify
  - text (string): New text content (or text to append)
  - mode (string, optional): "replace" (default) overwrites the existing text; "append" concatenates
  - separator (string, optional, mode=append only): Separator between existing and appended text. Default: "\\n\\n"

Returns JSON:
{
  "ok": true,
  "channel": "chat-task",
  "ts": "1234567890.123456"
}

Use mode="replace" for:
- Live streaming (update message as content streams in)
- Corrections/edits to previous messages
- Progress updates during long operations

Use mode="append" for:
- Progressive message building (send initial summary, then append details)
- Breaking up long messages into smaller tool calls for faster streaming
- Adding follow-up content without overwriting existing text

Tip: End a turn with reply_human (short initial summary), then in a later turn
use update_message(mode="append") to extend the delivered message. Users see the
initial response faster while long work continues.

Note: Updates broadcast to all connected WebSocket clients in real-time.`,
    inputSchema: {
      type: "object",
      properties: {
        ts: {
          type: "string",
          description: "Message timestamp/ID to modify",
        },
        text: {
          type: "string",
          description: "New text content (or text to append when mode=append)",
        },
        mode: {
          type: "string",
          enum: ["replace", "append"],
          description: 'Modification mode — "replace" (default) overwrites; "append" concatenates',
        },
        separator: {
          type: "string",
          description: 'Separator between existing and appended text when mode=append (default: "\\n\\n")',
        },
      },
      required: ["ts", "text"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "get_artifact_actions",
    description: `Get user responses/actions taken on an interactive artifact.

Use this to read back poll results, form submissions, or approval decisions.

Args:
  - channel (string): Channel ID
  - message_ts (string): Timestamp of the message containing the interactive artifact

Returns JSON:
{
  "ok": true,
  "actions": [
    { "action_id": "0:color", "value": {"color": "blue"}, "user": "UHUMAN", "created_at": 1234567890 }
  ],
  "count": 1
}`,
    inputSchema: {
      type: "object",
      properties: {
        message_ts: { type: "string", description: "Message timestamp containing the interactive artifact" },
      },
      required: ["message_ts"],
    },
  },
  {
    name: "query_messages",
    description: `Search and query messages in a channel. Replaces chat_get_history, chat_get_message, and chat_query_messages.

Supports exact-timestamp lookup, timestamp ranges, pagination, text/regex search, role and
user/agent filtering, and attachment filters. Always use this instead of manual grep/jq.

Args:
  - channel (string, required): Channel ID (e.g., "chat-task")
  - ts (string): Exact message timestamp — returns 0 or 1 messages
  - from_ts (string): Get messages with ts > from_ts (range start, exclusive)
  - to_ts (string): Get messages with ts < to_ts (range end / pagination cursor, exclusive). Combine with order="desc" to page newest first.
  - search (string): Text search (case-insensitive substring match)
  - search_regex (string): Regex pattern (JavaScript regex, case-insensitive)
  - roles (string[]): Filter by user roles: "bot", "worker", "human"
  - user_ids (string[]): Filter by specific user IDs (e.g., "UHUMAN", "UWORKER-xyz")
  - agent_ids (string[]): Filter by agent_id field on messages
  - attachment_name (string): Filter messages whose attachment filename contains this substring
  - file_id (string): Filter messages that have this specific attached file_id
  - has_attachments (boolean): Filter messages with any file attachment
  - has_images (boolean): Filter messages with image attachments
  - limit (number): Max messages to return (default: 100, max: 500)
  - order (string): "asc" (default, oldest first) or "desc" (newest first)

Returns JSON:
{
  "ok": true,
  "messages": [...],
  "count": number,
  "has_more": boolean
}

Role mapping: UBOT="bot", UWORKER-*="worker", UHUMAN="human"

Examples:

1. Get one specific message:
   { "channel": "chat-task", "ts": "1234567890.123456" }

2. Get recent history (newest first):
   { "channel": "chat-task", "limit": 50, "order": "desc" }

3. Find human messages about "bug" since a timestamp:
   { "channel": "chat-task", "roles": ["human"], "search": "bug", "from_ts": "1234567890.000000" }

4. Find messages from a specific agent:
   { "channel": "chat-task", "agent_ids": ["Claw'd"] }

5. Find messages with an attachment named "report":
   { "channel": "chat-task", "attachment_name": "report" }

6. Find the message that attached a particular file:
   { "channel": "chat-task", "file_id": "Fxyz123" }`,
    inputSchema: {
      type: "object",
      properties: {
        ts: {
          type: "string",
          description: "Exact message timestamp — returns 0 or 1 messages",
        },
        from_ts: {
          type: "string",
          description: "Get messages with ts > from_ts (range start, exclusive)",
        },
        to_ts: {
          type: "string",
          description:
            'Get messages with ts < to_ts (range end / pagination cursor, exclusive). Combine with order="desc" to page newest first.',
        },
        search: {
          type: "string",
          description: "Text search (case-insensitive substring match)",
        },
        search_regex: {
          type: "string",
          description: "Regex pattern (JavaScript regex, case-insensitive)",
        },
        roles: {
          type: "array",
          items: { type: "string", enum: ["bot", "worker", "human"] },
          description: "Filter by user roles",
        },
        user_ids: {
          type: "array",
          items: { type: "string" },
          description: "Filter by specific user IDs",
        },
        agent_ids: {
          type: "array",
          items: { type: "string" },
          description: "Filter by agent_id field on messages",
        },
        attachment_name: {
          type: "string",
          description: "Substring match against attachment filenames",
        },
        file_id: {
          type: "string",
          description: "Filter messages that have this specific attached file_id",
        },
        has_attachments: {
          type: "boolean",
          description: "Filter messages with any file attachment",
        },
        has_images: {
          type: "boolean",
          description: "Filter messages with image attachments",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default: 50, max: 500)",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: '"asc" (default, oldest first) or "desc" (newest first)',
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  // Plan tools
  {
    name: "plan_create",
    description: "Create a new project plan for the channel. Plans organize work into phases with assigned agents.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Plan title" },
        description: { type: "string", description: "Plan description/goals" },
        agent_in_charge: {
          type: "string",
          description: "Overall plan owner (agent ID)",
        },
        created_by: { type: "string", description: "Creator agent ID" },
      },
      required: ["title"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "plan_list",
    description: "List all plans in the channel.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_get",
    description: "Get detailed view of a plan with phases and progress.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan ID" },
      },
      required: ["plan_id"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_update",
    description: "Update a plan's status, title, description, or owner.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan ID" },
        status: {
          type: "string",
          description: "New status (draft/active/completed/archived)",
        },
        title: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
        agent_in_charge: { type: "string", description: "New owner agent ID" },
      },
      required: ["plan_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_add_phase",
    description: "Add a new phase to a plan.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan ID" },
        name: { type: "string", description: "Phase name" },
        description: { type: "string", description: "Phase description" },
        agent_in_charge: {
          type: "string",
          description: "Agent responsible for this phase",
        },
      },
      required: ["plan_id", "name"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "plan_update_phase",
    description: "Update a phase's status, name, description, or owner.",
    inputSchema: {
      type: "object",
      properties: {
        phase_id: { type: "string", description: "Phase ID" },
        status: {
          type: "string",
          description: "New status (pending/active/completed)",
        },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
        agent_in_charge: { type: "string", description: "New owner agent ID" },
      },
      required: ["phase_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_link_task",
    description: "Link a task to a plan phase.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan ID" },
        phase_id: { type: "string", description: "Phase ID" },
        task_id: { type: "string", description: "Task ID" },
      },
      required: ["plan_id", "phase_id", "task_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_get_tasks",
    description: "Get all tasks for a plan organized by phase.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan ID" },
      },
      required: ["plan_id"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  // Scheduler tools
  {
    name: "scheduler_create",
    description: "Create a scheduled job or reminder in a channel. Jobs spawn an agent; reminders just post a message.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Job/reminder title (max 200 chars)",
        },
        prompt: {
          type: "string",
          description: "Task prompt or reminder message",
        },
        schedule: {
          type: "string",
          description: 'Schedule: "in 5 minutes", "every 2 hours", cron, or ISO 8601',
        },
        is_reminder: {
          type: "boolean",
          description: "If true, creates a reminder instead of a job",
        },
        max_runs: {
          type: "number",
          description: "Max runs before auto-completing",
        },
        timeout_seconds: {
          type: "number",
          description: "Per-run timeout (default: 300, max: 3600)",
        },
      },
      required: ["title", "prompt", "schedule"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "scheduler_list",
    description: "List scheduled jobs and reminders in a channel.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status: active, paused, completed, failed, cancelled",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "scheduler_cancel",
    description: "Cancel a scheduled job or reminder.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job/reminder ID" },
      },
      required: ["id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "scheduler_pause",
    description: "Pause an active scheduled job.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job ID" },
      },
      required: ["id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "scheduler_resume",
    description: "Resume a paused scheduled job. Resets consecutive error count.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job ID" },
      },
      required: ["id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "scheduler_history",
    description: "View run history for a scheduled job.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job/reminder ID" },
        limit: {
          type: "number",
          description: "Number of recent runs (default: 10, max: 50)",
        },
      },
      required: ["id"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // ============================================================================
  // Multimodal Tools — Image/Video Analysis & Generation
  // ============================================================================

  {
    name: "read_image",
    description: `Analyze an image using a multimodal AI vision model. Returns a text description/analysis of the image content.

Use this tool to:
- Describe what's in an image
- Extract text from screenshots (OCR)
- Analyze diagrams, charts, or UI screenshots
- Identify objects, people, or scenes

Requires MiniMax provider (providers.minimax) or GEMINI_API_KEY in ~/.clawd/config.json. Gemini is tried first; MiniMax is used as fallback.`,
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "File ID from the chat system (e.g., F-xxxxx). The file must be an image.",
        },
        prompt: {
          type: "string",
          description:
            'What to analyze or describe about the image. Default: "Describe this image in detail, including any text, diagrams, or notable visual elements."',
        },
      },
      required: ["file_id"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },

  {
    name: "create_image",
    description: `Generate an image from a text description. The generated image is automatically saved and registered in the chat system.

Use this tool to:
- Create illustrations, diagrams, or concept art
- Generate visual mockups or design ideas
- Create icons, logos, or simple graphics

Requires MiniMax provider (providers.minimax) or GEMINI_API_KEY in ~/.clawd/config.json. Gemini is tried first; MiniMax is used as fallback.`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Detailed description of the image to generate. Describe the scene narratively rather than listing keywords.",
        },
        aspect_ratio: {
          type: "string",
          description:
            'Aspect ratio (default: "1:1"). Options: "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"',
        },
        image_size: {
          type: "string",
          description: 'Output resolution (default: "1K"). Options: "512px", "1K", "2K", "4K"',
        },
      },
      required: ["prompt"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },

  {
    name: "edit_image",
    description: `Edit an existing image using AI. Provide a source image (by file_id) and a text prompt describing the desired changes. The tool reads the source image internally — the agent does not need to know the image content, only its file_id and a description from read_image. The edited image is saved as a new file and registered in the chat system.

Use this tool to:
- Remove objects, watermarks, or trademarks from images
- Change backgrounds or colors
- Add or modify elements in an image
- Apply style changes or adjustments
- Combine elements from the description with the source image

Tip: Use read_image first to understand the source image content, then describe the specific changes needed.

Requires MiniMax provider (providers.minimax) or GEMINI_API_KEY in ~/.clawd/config.json. Gemini is tried first; MiniMax is used as fallback.`,
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "ID of the source image file to edit (from download_file or create_image).",
        },
        prompt: {
          type: "string",
          description:
            "Detailed description of the changes to apply. Be specific about what to add, remove, or modify.",
        },
      },
      required: ["file_id", "prompt"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },

  {
    name: "read_video",
    description: `Analyze a video using a multimodal AI model (Gemini). Returns a text description/analysis of the video content.

The tool first attempts direct video analysis via Gemini's native video support. If that fails (e.g., unsupported codec, file too large), it falls back to extracting frames with ffmpeg and analyzing those.

Use this tool to:
- Describe what happens in a video
- Transcribe spoken content
- Analyze screen recordings or demos
- Identify key moments or scenes

Requires: GEMINI_API_KEY in ~/.clawd/config.json, ffmpeg/ffprobe for fallback frame extraction.`,
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "File ID from the chat system (e.g., F-xxxxx). The file must be a video.",
        },
        prompt: {
          type: "string",
          description:
            'What to analyze about the video. Default: "Describe what happens in this video, including any spoken content, on-screen text, and key visual elements."',
        },
        max_frames: {
          type: "number",
          description: "Maximum number of frames to extract for fallback analysis (default: 30).",
        },
      },
      required: ["file_id"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];
