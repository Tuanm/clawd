/**
 * MCP tool definitions for chat_* tools.
 */

export const CHAT_TOOL_DEFS = [
  {
    name: "chat_poll_and_ack",
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
3. Send response via chat_send_message
4. Call chat_mark_processed(channel, timestamp=pending[i].ts)

IMPORTANT: After processing each message, call chat_mark_processed to prevent
re-processing on restart. Use this for polling loops. Call every 2-10 seconds.`,
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
    name: "chat_mark_processed",
    description: `Mark a message as processed after completing the task.

Call this AFTER successfully processing a message. This prevents the message
from appearing in "pending" again if the agent restarts.

Args:
  - channel (string): Channel ID
  - timestamp (string): Message timestamp that was processed
  - agent_id (string): Agent identifier (default: "default")

Returns JSON:
{
  "ok": true,
  "last_processed_ts": "..."
}

Flow: poll_and_ack -> process message -> send response -> mark_processed`,
    inputSchema: {
      type: "object",
      properties: {
        timestamp: {
          type: "string",
          description: "Timestamp of the processed message",
        },
      },
      required: ["timestamp"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "chat_send_message",
    description: `Send a message to a channel.

Args:
  - channel (string): Channel ID (e.g., "chat-task")
  - text (string): Message text (supports markdown)
  - agent_id (string): Agent identifier (e.g., "Claw'd 1")

Returns JSON:
{
  "ok": true,
  "ts": "1234567890.123456",  // Message timestamp/ID
  "channel": "chat-task"
}

Use this to respond to user messages or send notifications.`,
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Message text (supports markdown)",
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
    name: "chat_get_history",
    description: `Get conversation history from a channel.

Args:
  - channel (string): Channel ID
  - limit (number): Max messages to return (default: 50, max: 200)
  - before_ts (string): Get messages before this timestamp (for pagination)

Returns JSON:
{
  "ok": true,
  "messages": [...],  // Array of messages, newest first
  "has_more": boolean // Whether more messages exist
}

Use this to get context or review past conversations.`,
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max messages to return",
          default: 50,
        },
        before_ts: {
          type: "string",
          description: "Get messages before this timestamp (for pagination)",
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
    name: "chat_get_message",
    description: `Get a specific message by timestamp.

Args:
  - channel (string): Channel ID
  - ts (string): Message timestamp/ID

Returns JSON:
{
  "ok": true,
  "message": { ... }  // The message object
}

Use this to fetch referenced messages (e.g., @msg:timestamp).`,
    inputSchema: {
      type: "object",
      properties: {
        ts: {
          type: "string",
          description: "Message timestamp/ID",
        },
      },
      required: ["ts"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "chat_get_message_files",
    description: `Get all file attachments from a specific message.

Args:
  - channel (string): Channel ID
  - ts (string): Message timestamp/ID
  - include_content (boolean): Include base64 content for each file (default: false)

Returns JSON:
{
  "ok": true,
  "files": [
    { "id": "F...", "name": "...", "mimetype": "...", "size": number, "content_base64"?: "...", "image_hint"?: "..." }
  ]
}

Use this to get all attachments from a message at once.

**IMPORTANT FOR IMAGES:**
- By default (include_content=false), images return an \`image_hint\` instead of base64 content
- The hint explains how to use vision tools (Claude, Gemini, GPT-4V) to analyze images
- This avoids context token limits from large image base64 data`,
    inputSchema: {
      type: "object",
      properties: {
        ts: {
          type: "string",
          description: "Message timestamp/ID",
        },
        include_content: {
          type: "boolean",
          description: "Include base64 content for each file (default: false)",
          default: false,
        },
      },
      required: ["ts"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "chat_download_file",
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
    name: "chat_read_file_range",
    description: `Read a portion of a file by byte range or line range. Perfect for large files.

Args:
  - file_id (string): File ID from message attachments
  - mode (string): "bytes" or "lines" (default: "bytes")
  - start (number): Start byte offset or line number (0-indexed)
  - end (number): End byte offset or line number (exclusive). Omit to read to end.
  - encoding (string): "utf8" or "base64" (default: "utf8")

Returns JSON:
{
  "ok": true,
  "file_id": "...",
  "mode": "bytes",
  "start": 0,
  "end": 1000,
  "total_size": 50000,
  "total_lines": 1200,  // Only for text files
  "content": "...",     // UTF-8 string or base64
  "has_more": true
}

Examples:
- First 1KB: { file_id: "F...", start: 0, end: 1000 }
- Lines 0-50: { file_id: "F...", mode: "lines", start: 0, end: 50 }
- Last 500 bytes: { file_id: "F...", start: -500 }`,
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "File ID from message attachments",
        },
        mode: {
          type: "string",
          enum: ["bytes", "lines"],
          description: "Read by byte offset or line number (default: bytes)",
        },
        start: {
          type: "number",
          description: "Start position (0-indexed). Negative values count from end.",
        },
        end: {
          type: "number",
          description: "End position (exclusive). Omit to read to end.",
        },
        encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: "Output encoding (default: utf8)",
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
    name: "chat_upload_file",
    description: `Upload a file and attach it to a message.

**WORKFLOW FOR ATTACHING FILES TO MESSAGES:**
1. chat_upload_file → returns file_id
2. chat_send_message_with_files → sends message with attached files

Args:
  - content_base64 (string): Base64-encoded file content
  - filename (string): Original filename with extension
  - mimetype (string): MIME type (e.g., "text/plain", "image/png")
  - channel (string): Channel ID (for association)

Returns JSON:
{
  "ok": true,
  "file": {
    "id": "F...",
    "name": "filename.txt",
    "mimetype": "text/plain",
    "size": 1234
  }
}

Use file.id (the file_id) with chat_send_message_with_files to attach the file to a message.

**COMPLETE EXAMPLE:**
\`\`\`
// Step 1: Upload the file
result1 = chat_upload_file(
  content_base64="SGVsbG8gV29ybGQh",  // "Hello World!" in base64
  filename="greeting.txt",
  mimetype="text/plain",
  channel="chat-task"
)
// result1.file.id = "Fxyz123"

// Step 2: Send message with file attachment
chat_send_message_with_files(
  channel="chat-task",
  text="Here's the file you requested:",
  file_ids=["Fxyz123"],
  agent_id="MyAgent"
)
\`\`\`

The UI will display the file as a clickable attachment with preview for images.`,
    inputSchema: {
      type: "object",
      properties: {
        content_base64: {
          type: "string",
          description: "Base64-encoded file content",
        },
        filename: {
          type: "string",
          description: "Filename with extension",
        },
        mimetype: {
          type: "string",
          description: "MIME type (e.g., 'text/plain', 'image/png')",
        },
      },
      required: ["content_base64", "filename", "mimetype"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "chat_upload_local_file",
    description: `Upload a file from a local filesystem path. Reads the file server-side so the LLM never needs to handle base64 data.

**USE THIS INSTEAD OF chat_upload_file** when the file already exists on disk. This avoids the LLM
having to generate/output large base64 strings as tool arguments, which can cause stream timeouts.

**WORKFLOW FOR ATTACHING LOCAL FILES TO MESSAGES:**
1. chat_upload_local_file → returns file_id (reads file from disk)
2. chat_send_message_with_files → sends message with attached files

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

Use file.id (the file_id) with chat_send_message_with_files to attach the file to a message.

**COMPLETE EXAMPLE:**
\`\`\`
// Step 1: Upload from local path
result1 = chat_upload_local_file(
  file_path="/path/to/icon.png",
  channel="chat-task"
)
// result1.file.id = "Fxyz123"

// Step 2: Send message with file attachment
chat_send_message_with_files(
  channel="chat-task",
  text="Here's the icon:",
  file_ids=["Fxyz123"],
  agent_id="MyAgent"
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
    name: "chat_send_message_with_files",
    description: `Send a message with file attachments.

Args:
  - channel (string): Channel ID
  - text (string): Message text
  - file_ids (string[]): Array of file IDs from chat_upload_file
  - agent_id (string): Agent identifier (your agent name)

Returns JSON:
{
  "ok": true,
  "ts": "1234567890.123456",
  "channel": "chat-task",
  "files": [...]
}

Use after uploading files with chat_upload_file.`,
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Message text",
        },
        file_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of file IDs to attach",
        },
      },
      required: ["text", "file_ids"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "chat_delete_message",
    description: `Delete a specific message from a channel.

Args:
  - channel (string): Channel ID
  - ts (string): Message timestamp/ID to delete

Returns JSON:
{
  "ok": true,
  "channel": "chat-task",
  "ts": "1234567890.123456"
}

Use this to remove messages (e.g., cleanup, corrections).
Note: Deletion is permanent and broadcasts to all connected clients.`,
    inputSchema: {
      type: "object",
      properties: {
        ts: {
          type: "string",
          description: "Message timestamp/ID to delete",
        },
      },
      required: ["ts"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "chat_update_message",
    description: `Update an existing message's text content.

Args:
  - channel (string): Channel ID
  - ts (string): Message timestamp/ID to update
  - text (string): New text content

Returns JSON:
{
  "ok": true,
  "channel": "chat-task",
  "ts": "1234567890.123456"
}

Use this for:
- Live streaming (update message as content streams in)
- Corrections/edits to previous messages
- Progress updates during long operations

Note: Updates broadcast to all connected WebSocket clients in real-time.`,
    inputSchema: {
      type: "object",
      properties: {
        ts: {
          type: "string",
          description: "Message timestamp/ID to update",
        },
        text: {
          type: "string",
          description: "New text content for the message",
        },
      },
      required: ["ts", "text"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "chat_get_artifact_actions",
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
    name: "chat_append_message",
    description: `Append text to an existing message. Unlike chat_update_message which replaces the full text,
this tool appends new content to the end of the current message text.

Args:
  - channel (string): Channel ID
  - ts (string): Message timestamp/ID to append to
  - text (string): Text to append
  - separator (string, optional): Separator between existing and appended text. Default: "\\n\\n"

Returns JSON:
{
  "ok": true,
  "channel": "chat-task",
  "ts": "1234567890.123456"
}

Use this for:
- Progressive message building (send initial summary, then append details)
- Breaking up long messages into smaller tool calls for faster streaming
- Adding follow-up content without overwriting existing text

Tip: Send a short initial message with chat_send_message, then use chat_append_message
to add more content. This way users see your initial response faster.

Note: Updates broadcast to all connected WebSocket clients in real-time.`,
    inputSchema: {
      type: "object",
      properties: {
        ts: {
          type: "string",
          description: "Message timestamp/ID to append to",
        },
        text: {
          type: "string",
          description: "Text to append to the existing message",
        },
        separator: {
          type: "string",
          description: 'Separator between existing and appended text (default: "\\n\\n")',
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
    name: "chat_query_messages",
    description: `Search and query messages in a channel with powerful filtering.

USE THIS TO FIND MESSAGES IN CONVERSATION HISTORY. Supports text search, regex patterns,
role filtering, and timestamp ranges. Always use this instead of manual grep/jq filtering.

Args:
  - channel (string, required): Channel ID (e.g., "chat-task")
  - search (string): Text search (case-insensitive substring match)
  - search_regex (string): Regex pattern for advanced search (JavaScript regex, case-insensitive)
  - roles (string[]): Filter by user roles: "bot", "worker", "human"
  - from_ts (string): Get messages after this timestamp
  - to_ts (string): Get messages before this timestamp
  - has_attachments (boolean): Filter messages with file attachments
  - has_images (boolean): Filter messages with image attachments
  - limit (number): Max messages to return (default: 100, max: 500)

Returns JSON:
{
  "ok": true,
  "messages": [...],
  "count": number,
  "has_more": boolean
}

Role mapping: UBOT="bot", UWORKER-*="worker", UHUMAN="human"

Examples:

1. Find messages about "codebase research":
   { "channel": "chat-task", "search": "codebase research" }

2. Find CLI-related discussions with regex:
   { "channel": "chat-task", "search_regex": "CLI.*architecture|session.*storage" }

3. Get human messages from the last hour containing "bug":
   { "channel": "chat-task", "roles": ["human"], "search": "bug", "from_ts": "1234567890.000000" }

4. Find bot responses with code blocks:
   { "channel": "chat-task", "roles": ["bot"], "search_regex": "\\\`\\\`\\\`" }`,
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Text search (case-insensitive substring match)",
        },
        search_regex: {
          type: "string",
          description: "Regex pattern for advanced search (JavaScript regex, case-insensitive)",
        },
        roles: {
          type: "array",
          items: { type: "string", enum: ["bot", "worker", "human"] },
          description: "Filter by user roles",
        },
        from_ts: {
          type: "string",
          description: "Get messages after this timestamp",
        },
        to_ts: {
          type: "string",
          description: "Get messages before this timestamp",
        },
        has_attachments: {
          type: "boolean",
          description: "Filter messages with file attachments",
        },
        has_images: {
          type: "boolean",
          description: "Filter messages with image attachments",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default: 100, max: 500)",
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
    name: "chat_get_last_summary",
    description: `Get the last conversation summary for a channel.

Args:
  - channel (string): Channel ID
  - agent_id (string): Agent identifier (default: "default")

Returns JSON:
{
  "ok": true,
  "summary": "Previous conversation summary...",
  "ts": "1234567890.000000",       // Summary creation timestamp
  "from_ts": "...",                // First message in summary
  "to_ts": "...",                  // Last message in summary
  "message_count": 150,            // Messages included in summary
  "has_summary": true
}

If no summary exists, returns the channel's first message timestamp as from_ts
with has_summary=false, so you know where the conversation begins.`,
    inputSchema: {
      type: "object",
      properties: {},
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
    name: "chat_store_summary",
    description: `Store a conversation summary for a channel.

Call this after generating a summary of conversation history.
The summary should include key points, decisions, and technical details.

Args:
  - channel (string): Channel ID
  - summary (string): The summary text (max 5000 chars)
  - from_ts (string): First message timestamp included in summary
  - to_ts (string): Last message timestamp included in summary
  - agent_id (string): Agent identifier (default: "default")

Returns JSON:
{
  "ok": true,
  "summary_id": "S...",
  "channel": "chat-task",
  "message_count": 150
}

Best practices:
- Keep summaries concise but complete (~300-500 words)
- Include: topics discussed, decisions made, code changes, open questions
- Reference important message timestamps for future lookup`,
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "The summary text",
        },
        from_ts: {
          type: "string",
          description: "First message timestamp in summary",
        },
        to_ts: {
          type: "string",
          description: "Last message timestamp in summary",
        },
      },
      required: ["summary", "from_ts", "to_ts"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
] as const;
