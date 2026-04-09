/**
 * MCP (Model Context Protocol) Handler for Chat Server
 *
 * Provides MCP tools over HTTP JSON-RPC for AI agents to interact with the chat system.
 * Tools: chat_poll_and_ack, chat_send_message, chat_send_message_with_files, chat_upload_file,
 *        chat_upload_local_file, chat_download_file, chat_read_file_range, chat_get_message_files,
 *        chat_get_history, chat_query_messages
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getProjectAgentsDir } from "../agent/tools/registry";
import type { SchedulerManager } from "../scheduler/manager";
import {
  ATTACHMENTS_DIR,
  db,
  generateId,
  generateTs,
  getAgent,
  getMessageSeenBy,
  type Message,
  markMessagesSeen,
  toSlackMessage,
} from "./database";
import { analyzeImage, analyzeVideo, editImage, generateImage, getImageQuotaStatus } from "./multimodal";
import { getOptimizedFile } from "./routes/files";
import { getConversationHistory, getPendingMessages, postMessage } from "./routes/messages";
import { broadcastMessage, broadcastMessageSeen, broadcastUpdate } from "./websocket";

// Scheduler reference (set by index.ts after creation)
let _scheduler: SchedulerManager | null = null;
export function setMcpScheduler(scheduler: SchedulerManager): void {
  _scheduler = scheduler;
}

// WorkerManager reference (set by index.ts after creation — used by handleAgentMcpRequest)
let _workerManager: any = null;
export function setMcpWorkerManager(wm: any): void {
  _workerManager = wm;
}

/**
 * Truncate text for agent context — always active (defense in depth).
 * Applied unconditionally regardless of contextMode since this prevents
 * the agent from re-ingesting untruncated content via MCP retrieval tools.
 */
function truncateForAgent(text: string | undefined | null, maxLength = 10000): string {
  if (!text || text.length <= maxLength) return text || "";
  const marker = "\n\n[TRUNCATED — content too long for agent context]";
  let cp = maxLength - marker.length;
  if (cp > 0 && cp < text.length && text.charCodeAt(cp - 1) >= 0xd800 && text.charCodeAt(cp - 1) <= 0xdbff) cp--;
  return text.slice(0, cp) + marker;
}

// MCP Tool definitions
const MCP_TOOLS = [
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
          description: "ID of the source image file to edit (from chat_download_file or create_image).",
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

// MCP JSON-RPC handler
export async function handleMcpRequest(req: Request): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

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

    const { jsonrpc, id, method, params = {} } = body;

    if (jsonrpc !== "2.0") {
      return jsonRpcError(id, -32600, "Invalid JSON-RPC version", corsHeaders);
    }

    let result: unknown;

    switch (method) {
      // MCP Protocol methods
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "chat-mcp-server",
            version: "1.0.0",
          },
          capabilities: {
            tools: {},
          },
        };
        break;

      case "tools/list": {
        const scope = new URL(req.url, "http://localhost").searchParams.get("scope");
        const tools = scope === "space" ? MCP_TOOLS.filter((t: any) => t.name.startsWith("chat_")) : MCP_TOOLS;
        result = { tools };
        break;
      }

      case "tools/call": {
        const scope = new URL(req.url, "http://localhost").searchParams.get("scope");
        const { name, arguments: args } = params as {
          name: string;
          arguments: Record<string, unknown>;
        };
        if (scope === "space" && !name.startsWith("chat_")) {
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "Tool not available in space scope",
                }),
              },
            ],
          };
          break;
        }
        result = await executeToolCall(name, args || {});
        break;
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`, corsHeaders);
    }

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[MCP] Error:", error);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}

function jsonRpcError(
  id: number | string | null,
  code: number,
  message: string,
  headers: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }),
    {
      headers: { ...headers, "Content-Type": "application/json" },
    },
  );
}

// Execute MCP tool calls
async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    let resultText: string;

    // Handle scheduler tools before main switch
    if (name.startsWith("scheduler_")) {
      if (!_scheduler) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "Scheduler not available",
              }),
            },
          ],
        };
      }
      switch (name) {
        case "scheduler_create": {
          const maxRuns = args.max_runs as number | undefined;
          const timeoutSeconds = args.timeout_seconds as number | undefined;
          if (maxRuns !== undefined && (!Number.isFinite(maxRuns) || maxRuns <= 0 || !Number.isInteger(maxRuns))) {
            resultText = JSON.stringify({
              ok: false,
              error: "max_runs must be a positive integer",
            });
            break;
          }
          if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
            resultText = JSON.stringify({
              ok: false,
              error: "timeout_seconds must be a positive number",
            });
            break;
          }
          const r = _scheduler.createJobFromTool({
            channel: args.channel as string,
            agentId: args.agent_id as string,
            title: args.title as string,
            prompt: args.prompt as string,
            schedule: args.schedule as string,
            maxRuns,
            timeoutSeconds,
            isReminder: args.is_reminder as boolean | undefined,
          });
          resultText = JSON.stringify(r.success ? { ok: true, job: r.job } : { ok: false, error: r.error });
          break;
        }
        case "scheduler_list": {
          const jobs = _scheduler.listJobsForChannel(args.channel as string, args.status as string | undefined);
          resultText = JSON.stringify({ ok: true, jobs });
          break;
        }
        case "scheduler_cancel": {
          const r = _scheduler.cancelJobFromTool(args.id as string, args.agent_id as string, args.channel as string);
          resultText = JSON.stringify({
            ok: r.success,
            error: r.success ? undefined : r.error,
          });
          break;
        }
        case "scheduler_history": {
          const limit = Math.min((args.limit as number) || 10, 50);
          const runs = _scheduler.getJobRunsForTool(args.id as string, limit, args.channel as string | undefined);
          resultText = JSON.stringify({ ok: true, runs });
          break;
        }
        default:
          resultText = JSON.stringify({
            ok: false,
            error: `Unknown scheduler tool: ${name}`,
          });
      }
      return { content: [{ type: "text", text: resultText }] };
    }

    switch (name) {
      case "chat_poll_and_ack": {
        const channel = args.channel as string;
        const agentId = (args.agent_id as string) || "default";
        const includeBot = args.include_bot === true;
        const limit = Math.min(Math.max(1, (args.limit as number) || 20), 100);
        const offset = Math.max(0, (args.offset as number) || 0);

        // Get agent's last processed timestamp (for filtering pending)
        const agentState = db
          .query<{ last_seen_ts: string | null; last_processed_ts: string | null }, [string, string]>(
            `SELECT last_seen_ts, last_processed_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
          )
          .get(agentId, channel);

        let lastProcessedTs = agentState?.last_processed_ts;

        // Get all messages (for seen-marking and context)
        const allResult = getPendingMessages(channel, undefined, true);
        const messages = allResult.messages || [];

        // IMPORTANT: If this is a new agent (no last_processed_ts), auto-initialize
        // to avoid overwhelming the agent with ALL historical messages as "pending"
        // Only show the most recent UHUMAN message(s) as pending
        if (!lastProcessedTs && messages.length > 0) {
          // Find all actionable messages (from humans and workers)
          const actionableMessages = messages.filter(
            (m: { user: string; agent_id?: string }) =>
              m.user === "UHUMAN" ||
              m.user.startsWith("UWORKER-") ||
              (m.user === "UBOT" && m.agent_id && m.agent_id !== agentId),
          );
          if (actionableMessages.length > 1) {
            lastProcessedTs = actionableMessages[actionableMessages.length - 2].ts;
          } else if (actionableMessages.length === 1) {
            lastProcessedTs = null;
          }
          // Note: We don't persist this auto-initialization - agent should call mark_processed
        }

        // Filter pending = messages from others after last_processed_ts
        // Always include UHUMAN; optionally include UWORKER-* and other UBOT agents
        const allPending = messages.filter(
          (m: { user: string; ts: string; agent_id?: string }) =>
            (m.user === "UHUMAN" ||
              (includeBot &&
                (m.user.startsWith("UWORKER-") || (m.user === "UBOT" && m.agent_id && m.agent_id !== agentId)))) &&
            (!lastProcessedTs || m.ts > lastProcessedTs),
        );
        const totalPending = allPending.length;
        const pending = allPending.slice(offset, offset + limit);

        // Mark ALL messages as SEEN immediately, also update last_poll_ts
        if (messages.length > 0) {
          const maxTs = messages.reduce((max: string, m: { ts: string }) => (m.ts > max ? m.ts : max), "0");
          const nowTs = Math.floor(Date.now() / 1000);
          db.run(
            `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_poll_ts, updated_at)
             VALUES (?, ?, ?, ?, strftime('%s', 'now'))
             ON CONFLICT(agent_id, channel) DO UPDATE SET
             last_seen_ts = excluded.last_seen_ts, last_poll_ts = excluded.last_poll_ts, updated_at = excluded.updated_at`,
            [agentId, channel, maxTs, nowTs],
          );

          // Mark individual messages as seen by this agent (for multi-agent seen_by tracking)
          // Returns only NEWLY seen messages (not already marked as seen by this agent)
          const messageTsList = messages.map((m: { ts: string }) => m.ts);
          const newlySeen = markMessagesSeen(channel, agentId, messageTsList);

          // Broadcast seen event to UI for real-time updates
          // Only broadcast the LAST seen message (not all of them - causes UI lag with O(n*m) updates)
          if (newlySeen.length > 0) {
            // Find the last non-self message to show where agent's read position is
            const lastNonSelfMsg = messages
              .filter(
                (m: { user: string }) => m.user === "UHUMAN" || (m.user !== "UBOT" && !m.user.startsWith("UWORKER")),
              )
              .slice(-1)[0];
            if (lastNonSelfMsg && newlySeen.includes(lastNonSelfMsg.ts)) {
              broadcastMessageSeen(channel, lastNonSelfMsg.ts, agentId);
            }
          }
        } else {
          // Even if no messages, still update last_poll_ts to show agent is alive
          const nowTs = Math.floor(Date.now() / 1000);
          db.run(
            `INSERT INTO agent_seen (agent_id, channel, last_poll_ts, updated_at)
             VALUES (?, ?, ?, strftime('%s', 'now'))
             ON CONFLICT(agent_id, channel) DO UPDATE SET
             last_poll_ts = excluded.last_poll_ts, updated_at = excluded.updated_at`,
            [agentId, channel, nowTs],
          );
        }

        // Add seen_by to pending messages
        const pendingWithSeenBy = pending.map((m: { ts: string; text?: string }) => {
          const seenBy = getMessageSeenBy(channel, m.ts);
          const seenByWithColors = seenBy.map((aid) => {
            const agent = getAgent(aid, channel);
            return {
              agent_id: aid,
              avatar_color: agent?.avatar_color || "#D97853",
            };
          });
          return { ...m, seen_by: seenByWithColors };
        });

        // Truncate message text for agent context
        const truncatedPending = pendingWithSeenBy.map((m) => ({
          ...m,
          text: truncateForAgent(m.text),
        }));

        resultText = JSON.stringify(
          {
            ok: true,
            pending: truncatedPending,
            last_seen_ts: messages.length > 0 ? messages[messages.length - 1].ts : null,
            last_processed_ts: lastProcessedTs,
            count: totalPending,
            has_more: offset + limit < totalPending,
            ...(offset > 0 && { offset }),
            ...(limit !== 20 && { limit }),
          },
          null,
          2,
        );
        break;
      }

      case "chat_mark_processed": {
        const channel = args.channel as string;
        const timestamp = args.timestamp as string;
        const agentId = (args.agent_id as string) || "default";

        db.run(
          `INSERT INTO agent_seen (agent_id, channel, last_seen_ts, last_processed_ts, updated_at)
           VALUES (?, ?, ?, ?, strftime('%s', 'now'))
           ON CONFLICT(agent_id, channel) DO UPDATE SET
           last_processed_ts = MAX(COALESCE(last_processed_ts, '0'), excluded.last_processed_ts), updated_at = excluded.updated_at`,
          [agentId, channel, timestamp, timestamp],
        );

        resultText = JSON.stringify(
          {
            ok: true,
            agent_id: agentId,
            channel,
            last_processed_ts: timestamp,
          },
          null,
          2,
        );
        break;
      }

      case "chat_send_message": {
        const channel = args.channel as string;
        const text = args.text as string;
        const agentId = args.agent_id as string;
        const userOverride = args.user as string | undefined;

        // Validate parameter order - detect if agent swapped text and agent_id
        if (agentId && text) {
          // Check 1: text looks like an agent ID (short, alphanumeric with spaces/apostrophes for names like "Claw'd")
          const textLooksLikeAgentId =
            text.length <= 25 &&
            /^[A-Za-z0-9_'\-\s]+$/.test(text) &&
            (text.toLowerCase().includes("clawd") ||
              text.toLowerCase().includes("claw'd") ||
              !text.includes(" ") ||
              text.split(" ").length <= 3); // At most 3 words like "Claw'd 2"

          // Check 2: agent_id looks like a message (long, has multiple spaces, punctuation, newlines)
          const agentIdLooksLikeMessage =
            agentId.length > 30 ||
            (agentId.includes(" ") && agentId.split(" ").length > 3) ||
            agentId.includes("\n") ||
            agentId.includes(".") ||
            agentId.includes(",") ||
            agentId.includes("!") ||
            agentId.includes("?");

          if (textLooksLikeAgentId && agentIdLooksLikeMessage) {
            resultText = JSON.stringify(
              {
                ok: false,
                error: "PARAMETER_ORDER_ERROR",
                message:
                  "It looks like you swapped 'text' and 'agent_id' parameters. " +
                  "The 'text' field should contain your message content, and 'agent_id' should be your short identifier. " +
                  `You sent: text="${text}", agent_id="${agentId.substring(0, 50)}...". ` +
                  'Please call again with: text="<your message>", agent_id="<your agent name>"',
              },
              null,
              2,
            );
            break;
          }
        }

        // Use user override if provided, otherwise default to UBOT
        const userId = userOverride || "UBOT";
        const htmlPreview = args.html_preview as string | undefined;
        const workspaceJson = args.workspace_json as string | undefined;
        const codePreview = args.code_preview as
          | {
              filename: string;
              language: string;
              content: string;
              start_line?: number;
              highlight_lines?: number[];
            }
          | undefined;
        const interactiveJson = args.interactive_json as Record<string, any> | undefined;

        const result = postMessage({
          channel,
          text,
          user: userId,
          agent_id: agentId,
          html_preview: htmlPreview,
          code_preview: codePreview,
          workspace_json: workspaceJson,
          interactive_json: interactiveJson ? JSON.stringify(interactiveJson) : undefined,
        });

        // Broadcast to WebSocket clients so UI updates immediately (no 10s poll wait)
        if (result.ok && result.ts) {
          const rawMsg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(result.ts);
          if (rawMsg) broadcastMessage(channel, rawMsg);
        }

        resultText = JSON.stringify(result);
        break;
      }

      case "chat_get_history": {
        const channel = args.channel as string;
        const limit = Math.min((args.limit as number) || 50, 200);

        const result = getConversationHistory(channel, limit);

        // Add seen_by to each message
        if (result.messages) {
          result.messages = result.messages.map((m) => {
            const seenBy = getMessageSeenBy(channel, m.ts);
            const seenByWithColors = seenBy.map((aid) => {
              const agent = getAgent(aid, channel);
              return {
                agent_id: aid,
                avatar_color: agent?.avatar_color || "#D97853",
              };
            });
            return {
              ...m,
              text: truncateForAgent(m.text),
              seen_by: seenByWithColors,
            };
          }) as typeof result.messages;
        }

        resultText = JSON.stringify(result);
        break;
      }

      case "chat_get_message": {
        const _channel = args.channel as string;
        const ts = args.ts as string;

        const message = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(ts);

        if (!message) {
          resultText = JSON.stringify({
            ok: false,
            error: "Message not found",
          });
        } else {
          const slackMsg = toSlackMessage(message);
          resultText = JSON.stringify(
            {
              ok: true,
              message: { ...slackMsg, text: truncateForAgent(slackMsg.text) },
            },
            null,
            2,
          );
        }
        break;
      }

      case "chat_get_message_files": {
        const channel = args.channel as string;
        const ts = args.ts as string;
        const includeContent = args.include_content === true;

        // Get message first to verify it exists
        const message = db
          .query<Message, [string, string]>(`SELECT * FROM messages WHERE channel = ? AND ts = ?`)
          .get(channel, ts);

        if (!message) {
          resultText = JSON.stringify({
            ok: false,
            error: "Message not found",
          });
          break;
        }

        // Get files attached to this message
        const files = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE message_ts = ?`)
          .all(ts);

        const fileResults = [];
        for (const file of files) {
          const fileInfo: Record<string, unknown> = {
            id: file.id,
            name: file.name,
            mimetype: file.mimetype,
            size: file.size,
          };

          // Images NEVER return base64 — always provide hint to use read_image tool
          if (file.mimetype.toLowerCase().startsWith("image/")) {
            fileInfo.image_hint =
              `This is an image file (${file.name}, ${file.mimetype}, ${file.size} bytes). ` +
              `To analyze or describe this image, use the read_image tool with file_id="${file.id}". ` +
              `Do NOT attempt to read the image as base64 as it may exceed context limits.`;
          } else if (includeContent && file.size < 1024 * 1024) {
            // Include base64 content if requested and file is small enough (<1MB)
            try {
              const fileData = await Bun.file(file.path).arrayBuffer();
              fileInfo.content_base64 = Buffer.from(fileData).toString("base64");
            } catch {
              fileInfo.content_error = "Could not read file content";
            }
          }

          fileResults.push(fileInfo);
        }

        resultText = JSON.stringify({ ok: true, files: fileResults });
        break;
      }

      case "chat_download_file": {
        const fileId = args.file_id as string;
        const projectRoot = args._project_root as string | undefined; // Injected by agent plugin

        const file = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE id = ?`)
          .get(fileId);

        if (!file) {
          resultText = JSON.stringify({ ok: false, error: "File not found" });
        } else {
          const response: Record<string, unknown> = {
            ok: true,
            file: {
              id: file.id,
              name: file.name,
              mimetype: file.mimetype,
              size: file.size,
            },
          };

          // Images — always provide hint to use read_image tool
          if (file.mimetype.toLowerCase().startsWith("image/")) {
            (response.file as Record<string, unknown>).image_hint =
              `This is an image file (${file.name}, ${file.mimetype}, ${file.size} bytes). ` +
              `To analyze or describe this image, use the read_image tool with file_id="${file.id}". ` +
              `Do NOT attempt to read the image as base64 as it may exceed context limits.`;
          }

          // Auto-save file to {projectRoot}/.clawd/files/ if project root is available
          if (projectRoot) {
            try {
              const { mkdirSync, copyFileSync, existsSync: fsExists } = await import("node:fs");
              const { join: pathJoin, extname, basename } = await import("node:path");

              const filesDir = pathJoin(projectRoot, ".clawd", "files");
              mkdirSync(filesDir, { recursive: true });

              // Determine target filename — use original name, deduplicate if needed
              let targetName = file.name;
              let targetPath = pathJoin(filesDir, targetName);
              if (fsExists(targetPath)) {
                // Add file ID prefix to deduplicate
                const ext = extname(file.name);
                const base = basename(file.name, ext);
                targetName = `${base}-${file.id}${ext}`;
                targetPath = pathJoin(filesDir, targetName);
              }

              copyFileSync(file.path, targetPath);
              (response.file as Record<string, unknown>).local_path = targetPath;
              response.hint =
                `File saved to: ${targetPath}\n` +
                `You can read this file using view("${targetPath}") or bash tools (cat, head, etc.).\n` +
                `For documents (PDF, DOCX, XLSX, PPTX), use convert_to_markdown(path="${targetPath || file.path}") to convert to readable text.`;
            } catch (saveErr: any) {
              response.hint =
                `Failed to save file locally: ${saveErr.message}. ` +
                `Use chat_read_file_range(file_id="${file.id}") to read the file content directly.`;
            }
          } else {
            response.hint =
              `File metadata retrieved. Use chat_read_file_range(file_id="${file.id}") to read the file content. ` +
              `For documents (PDF, DOCX, XLSX, PPTX), use convert_to_markdown(path="${file.path}") to convert to readable text.`;
          }

          resultText = JSON.stringify(response);
        }
        break;
      }

      case "chat_read_file_range": {
        const fileId = args.file_id as string;
        const mode = (args.mode as string) || "bytes";
        const start = args.start as number | undefined;
        const end = args.end as number | undefined;
        const encoding = (args.encoding as string) || "utf8";

        const file = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE id = ?`)
          .get(fileId);

        if (!file) {
          resultText = JSON.stringify({ ok: false, error: "File not found" });
          break;
        }

        // Block ALL image file content — use read_image tool instead
        if (file.mimetype.toLowerCase().startsWith("image/")) {
          resultText = JSON.stringify({
            ok: false,
            error: `Cannot read image file content. Use the read_image tool with file_id="${file.id}" to analyze this image instead.`,
          });
          break;
        }

        try {
          const bunFile = Bun.file(file.path);
          const fileBuffer = Buffer.from(await bunFile.arrayBuffer());

          let content: string;
          let actualStart: number;
          let actualEnd: number;
          let totalLines: number | undefined;

          if (mode === "lines") {
            // Read by lines
            const text = fileBuffer.toString("utf8");
            const lines = text.split("\n");
            totalLines = lines.length;

            actualStart = start !== undefined ? (start < 0 ? Math.max(0, lines.length + start) : start) : 0;
            actualEnd = end !== undefined ? Math.min(end, lines.length) : lines.length;

            const selectedLines = lines.slice(actualStart, actualEnd);
            content =
              encoding === "base64"
                ? Buffer.from(selectedLines.join("\n")).toString("base64")
                : selectedLines.join("\n");
          } else {
            // Read by bytes
            actualStart = start !== undefined ? (start < 0 ? Math.max(0, file.size + start) : start) : 0;
            actualEnd = end !== undefined ? Math.min(end, file.size) : file.size;

            const slice = fileBuffer.subarray(actualStart, actualEnd);
            content = encoding === "base64" ? slice.toString("base64") : slice.toString("utf8");
          }

          resultText = JSON.stringify(
            {
              ok: true,
              file_id: file.id,
              mode,
              start: actualStart,
              end: actualEnd,
              total_size: file.size,
              ...(totalLines !== undefined && { total_lines: totalLines }),
              content: truncateForAgent(content),
              has_more: actualEnd < (mode === "lines" ? totalLines || 0 : file.size),
            },
            null,
            2,
          );
        } catch (err) {
          resultText = JSON.stringify({
            ok: false,
            error: `Failed to read file: ${err}`,
          });
        }
        break;
      }

      case "chat_upload_file": {
        const contentBase64 = args.content_base64 as string;
        const filename = args.filename as string;
        const mimetype = args.mimetype as string;
        const _channel = args.channel as string;

        // Decode base64 content
        const buffer = Buffer.from(contentBase64, "base64");

        // Generate file ID and path
        const id = `F${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const ext = filename.split(".").pop() || "";
        const storedFilename = `${id}.${ext}`;
        const { ATTACHMENTS_DIR } = await import("./database");
        const { join } = await import("node:path");
        const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");

        // Ensure attachments directory exists
        if (!existsSync(ATTACHMENTS_DIR)) {
          mkdirSync(ATTACHMENTS_DIR, { recursive: true });
        }

        const filepath = join(ATTACHMENTS_DIR, storedFilename);
        writeFileSync(filepath, buffer);

        // Insert file record
        db.run(`INSERT INTO files (id, name, mimetype, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`, [
          id,
          filename,
          mimetype,
          buffer.length,
          filepath,
          "UBOT",
        ]);

        resultText = JSON.stringify(
          {
            ok: true,
            file: {
              id,
              name: filename,
              mimetype,
              size: buffer.length,
            },
          },
          null,
          2,
        );
        break;
      }

      case "chat_upload_local_file": {
        const filePath = args.file_path as string;
        const _channel = args.channel as string;
        const _agentId = (args.agent_id as string) || "default";

        const { basename, extname, join, resolve: resolvePath } = await import("node:path");
        const { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, realpathSync } = await import("node:fs");
        const { ATTACHMENTS_DIR } = await import("./database");

        // A-1: Path allowlist — only permit files under projectRoot, /tmp, or the
        // server's current working directory.  Symlink-safe via realpathSync.
        let resolvedFilePath: string;
        {
          // A-1c: Use agent's project root from DB.
          // If the agent has no project configured, isUnderProjectRoot is always false —
          // only /tmp uploads are permitted. Falling back to process.cwd() would allow
          // uploading arbitrary server-side files for unconfigured agents.
          const agentRow = db
            .query<{ project: string | null }, [string, string]>(
              "SELECT project FROM channel_agents WHERE channel = ? AND agent_id = ?",
            )
            .get(_channel, _agentId);
          try {
            resolvedFilePath = existsSync(filePath) ? realpathSync(filePath) : resolvePath(filePath);
          } catch {
            resolvedFilePath = resolvePath(filePath);
          }
          const configuredProject = agentRow?.project;
          const projectRoot = configuredProject ? resolvePath(configuredProject) : null;
          const isUnderProjectRoot =
            projectRoot !== null &&
            (resolvedFilePath === projectRoot || resolvedFilePath.startsWith(`${projectRoot}/`));
          // A-1b: Resolve canonical /tmp path (handles macOS /tmp → /private/tmp symlink)
          const canonicalTmp = (() => {
            try {
              return realpathSync("/tmp");
            } catch {
              return "/tmp";
            }
          })();
          const isUnderTmp = resolvedFilePath === canonicalTmp || resolvedFilePath.startsWith(canonicalTmp + "/");
          if (!isUnderProjectRoot && !isUnderTmp) {
            resultText = JSON.stringify({
              ok: false,
              error: `Access denied: file path "${filePath}" is outside allowed directories (project root or /tmp).`,
            });
            break;
          }
        }

        // A-1a: Use resolvedFilePath consistently to avoid TOCTOU races
        // Validate file exists
        if (!existsSync(resolvedFilePath)) {
          resultText = JSON.stringify({
            ok: false,
            error: `File not found: ${filePath}`,
          });
          break;
        }

        // Check it's a file (not directory)
        const stat = statSync(resolvedFilePath);
        if (!stat.isFile()) {
          resultText = JSON.stringify({
            ok: false,
            error: `Not a file: ${filePath}`,
          });
          break;
        }

        // A-5: File size limit — reject files larger than 50 MB before reading
        const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
        if (stat.size > MAX_UPLOAD_BYTES) {
          resultText = JSON.stringify({
            ok: false,
            error: `File too large: ${stat.size} bytes (max ${MAX_UPLOAD_BYTES})`,
          });
          break;
        }

        // Read the file
        const buffer = readFileSync(resolvedFilePath);

        // Determine filename — use original filePath for display name so symlink names are preserved
        const displayName = (args.filename as string) || basename(filePath);

        // Auto-detect mimetype from extension — use original filePath extension for same reason
        const MIME_MAP: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
          ".bmp": "image/bmp",
          ".pdf": "application/pdf",
          ".json": "application/json",
          ".xml": "application/xml",
          ".html": "text/html",
          ".htm": "text/html",
          ".css": "text/css",
          ".js": "application/javascript",
          ".ts": "text/typescript",
          ".txt": "text/plain",
          ".md": "text/markdown",
          ".csv": "text/csv",
          ".zip": "application/zip",
          ".gz": "application/gzip",
          ".tar": "application/x-tar",
          ".mp3": "audio/mpeg",
          ".wav": "audio/wav",
          ".mp4": "video/mp4",
          ".webm": "video/webm",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
          ".ttf": "font/ttf",
          ".otf": "font/otf",
        };
        const ext = extname(filePath).toLowerCase();
        const detectedMime = MIME_MAP[ext] || "application/octet-stream";
        const mimetype = (args.mimetype as string) || detectedMime;

        // Generate file ID and store
        const id = `F${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const storedExt = ext.replace(".", "") || "bin";
        const storedFilename = `${id}.${storedExt}`;

        if (!existsSync(ATTACHMENTS_DIR)) {
          mkdirSync(ATTACHMENTS_DIR, { recursive: true });
        }

        const destPath = join(ATTACHMENTS_DIR, storedFilename);
        writeFileSync(destPath, buffer);

        // Insert file record
        db.run(`INSERT INTO files (id, name, mimetype, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`, [
          id,
          displayName,
          mimetype,
          buffer.length,
          destPath,
          "UBOT",
        ]);

        resultText = JSON.stringify(
          {
            ok: true,
            file: {
              id,
              name: displayName,
              mimetype,
              size: buffer.length,
            },
          },
          null,
          2,
        );
        break;
      }

      case "chat_send_message_with_files": {
        const channel = args.channel as string;
        const text = args.text as string;
        const fileIds = args.file_ids as string[];
        const agentId = args.agent_id as string;

        // Post the message with agent_id
        const msgResult = postMessage({
          channel,
          text,
          user: "UBOT",
          agent_id: agentId,
        });

        if (msgResult.ok && fileIds && fileIds.length > 0) {
          // Attach files to the message
          const { attachFilesToMessage } = await import("./routes/files");
          const files = attachFilesToMessage(msgResult.ts, fileIds);

          // Broadcast to WebSocket clients so UI updates immediately
          const updatedMsg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(msgResult.ts);
          if (updatedMsg) broadcastMessage(channel, updatedMsg);

          resultText = JSON.stringify(
            {
              ok: true,
              ts: msgResult.ts,
              channel,
              files,
            },
            null,
            2,
          );
        } else {
          if (msgResult.ok && msgResult.ts) {
            const rawMsg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(msgResult.ts);
            if (rawMsg) broadcastMessage(channel, rawMsg);
          }
          resultText = JSON.stringify(msgResult);
        }
        break;
      }

      case "chat_delete_message": {
        const channel = args.channel as string;
        const ts = args.ts as string;

        // Import deleteMessage from routes
        const { deleteMessage } = await import("./routes/messages");
        const result = deleteMessage(channel, ts);

        resultText = JSON.stringify(result);
        break;
      }

      case "chat_update_message": {
        const channel = args.channel as string;
        const ts = args.ts as string;
        const text = args.text as string;

        // Import updateMessage from routes
        const { updateMessage } = await import("./routes/messages");
        const result = updateMessage({ channel, ts, text });

        // Broadcast update to WebSocket clients if successful
        if (result.ok) {
          const updatedMsg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(ts);
          if (updatedMsg) {
            broadcastUpdate(channel, toSlackMessage(updatedMsg));
          }
        }

        resultText = JSON.stringify(result);
        break;
      }

      case "chat_get_artifact_actions": {
        const messageTs = args.message_ts as string;
        const { getArtifactActions: getActions } = await import("./routes/artifact-actions");
        const result = getActions(messageTs, args.channel as string);
        resultText = JSON.stringify(result);
        break;
      }

      case "chat_append_message": {
        const channel = args.channel as string;
        const ts = args.ts as string;
        const text = args.text as string;
        const separator = args.separator as string | undefined;

        const { appendMessage } = await import("./routes/messages");
        const result = appendMessage({ channel, ts, text, separator });

        // Broadcast update to WebSocket clients if successful
        if (result.ok) {
          const updatedMsg = db.query<Message, [string]>(`SELECT * FROM messages WHERE ts = ?`).get(ts);
          if (updatedMsg) {
            broadcastUpdate(channel, toSlackMessage(updatedMsg));
          }
        }

        resultText = JSON.stringify(result);
        break;
      }

      case "chat_query_messages": {
        const channel = args.channel as string;
        const fromTs = args.from_ts as string | undefined;
        const toTs = args.to_ts as string | undefined;
        const roles = args.roles as string[] | undefined;
        const search = args.search as string | undefined;
        const searchRegex = args.search_regex as string | undefined;
        const hasAttachments = args.has_attachments as boolean | undefined;
        const hasImages = args.has_images as boolean | undefined;
        const limit = Math.min(Math.max((args.limit as number) || 100, 1), 500);

        // Build WHERE clause
        const conditions: string[] = ["channel = ?"];
        const params: (string | number)[] = [channel];

        if (fromTs) {
          conditions.push("ts > ?");
          params.push(fromTs);
        }
        if (toTs) {
          conditions.push("ts < ?");
          params.push(toTs);
        }
        if (roles && roles.length > 0) {
          // Map roles to user patterns
          const roleConditions: string[] = [];
          for (const role of roles) {
            if (role === "bot") roleConditions.push("user = 'UBOT'");
            if (role === "worker") roleConditions.push("user LIKE 'UWORKER-%'");
            if (role === "human") roleConditions.push("user = 'UHUMAN'");
          }
          if (roleConditions.length > 0) {
            conditions.push(`(${roleConditions.join(" OR ")})`);
          }
        }
        if (search) {
          conditions.push("text LIKE ?");
          params.push(`%${search}%`);
        }
        // Note: search_regex is applied post-query (SQLite doesn't support regex natively)
        if (hasAttachments === true) {
          conditions.push("files_json != '[]' AND files_json IS NOT NULL");
        }
        if (hasImages === true) {
          conditions.push("(files_json LIKE '%image/%' OR files_json LIKE '%\"mimetype\":\"image%')");
        }

        const whereClause = conditions.join(" AND ");
        // Fetch more if regex filtering will be applied
        const fetchLimit = searchRegex ? limit * 10 : limit + 1;
        const query = `SELECT * FROM messages WHERE ${whereClause} ORDER BY ts ASC LIMIT ?`;
        params.push(fetchLimit);

        let messages = db.query<Message, (string | number)[]>(query).all(...params);

        // Apply regex filter post-query (A-4: run in worker thread with 5s timeout to prevent ReDoS)
        if (searchRegex) {
          // Validate the regex pattern is syntactically valid first (cheap, no risk)
          try {
            new RegExp(searchRegex, "i");
          } catch (e) {
            resultText = JSON.stringify({
              ok: false,
              error: `Invalid regex pattern: ${(e as Error).message}`,
            });
            break;
          }

          // Run the actual matching in a worker thread to isolate catastrophic backtracking
          const { Worker } = await import("worker_threads");
          const textsToMatch = messages.map((m) => m.text || "");
          const workerCode = `
            const { workerData, parentPort } = require('worker_threads');
            try {
              const regex = new RegExp(workerData.pattern, 'i');
              const matched = workerData.texts.map((t) => regex.test(t));
              parentPort.postMessage({ ok: true, matched });
            } catch (e) {
              parentPort.postMessage({ ok: false, error: e.message });
            }
          `;

          const matchResult = await new Promise<{ ok: boolean; matched?: boolean[]; error?: string }>((resolve) => {
            const worker = new Worker(workerCode, {
              eval: true,
              workerData: { pattern: searchRegex, texts: textsToMatch },
            });
            const timeoutId = setTimeout(() => {
              worker.terminate();
              resolve({ ok: false, error: "Regex timed out (possible ReDoS). Pattern took longer than 5 seconds." });
            }, 5000);
            worker.on("message", (msg) => {
              clearTimeout(timeoutId);
              worker.terminate();
              resolve(msg);
            });
            worker.on("error", (err: Error) => {
              clearTimeout(timeoutId);
              worker.terminate();
              resolve({ ok: false, error: err.message });
            });
          });

          if (!matchResult.ok) {
            resultText = JSON.stringify({
              ok: false,
              error: matchResult.error || "Regex evaluation failed",
            });
            break;
          }

          messages = messages.filter((_, i) => matchResult.matched![i]);
        }

        const hasMore = messages.length > limit;
        if (hasMore) messages = messages.slice(0, limit);

        resultText = JSON.stringify(
          {
            ok: true,
            messages: messages.map((m) => {
              const sm = toSlackMessage(m);
              return { ...sm, text: truncateForAgent(sm.text) };
            }),
            count: messages.length,
            has_more: hasMore,
          },
          null,
          2,
        );
        break;
      }

      case "chat_get_last_summary": {
        const channel = args.channel as string;
        const agentId = (args.agent_id as string) || "default";

        // Essential files to include after compaction for context restoration
        const ESSENTIAL_FILES = [`${homedir()}/.clawd/CLAWD.md`];

        // Read essential files content
        let essentialFilesContent = "";
        for (const filePath of ESSENTIAL_FILES) {
          try {
            const content = await Bun.file(filePath).text();
            essentialFilesContent += `\n\n---\n## Essential File: ${filePath}\n\`\`\`markdown\n${content}\n\`\`\`\n`;
          } catch {
            // File not found - skip
          }
        }

        // Get the most recent summary for this channel/agent
        const summary = db
          .query<
            {
              id: string;
              summary: string;
              from_ts: string;
              to_ts: string;
              message_count: number;
              created_at: number;
            },
            [string, string]
          >(
            `SELECT id, summary, from_ts, to_ts, message_count, created_at
           FROM summaries
           WHERE channel = ? AND agent_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
          )
          .get(channel, agentId);

        if (summary) {
          resultText = JSON.stringify(
            {
              ok: true,
              has_summary: true,
              summary: truncateForAgent(summary.summary),
              essential_files: truncateForAgent(essentialFilesContent.trim()) || null,
              ts: generateTs(), // Current timestamp
              from_ts: summary.from_ts,
              to_ts: summary.to_ts,
              message_count: summary.message_count,
              summary_id: summary.id,
              restore_hint: essentialFilesContent
                ? "Essential files included - read them to restore core knowledge after compaction."
                : null,
            },
            null,
            2,
          );
        } else {
          // No summary exists - return channel start info
          const firstMessage = db
            .query<{ ts: string }, [string]>(`SELECT MIN(ts) as ts FROM messages WHERE channel = ?`)
            .get(channel);

          resultText = JSON.stringify(
            {
              ok: true,
              has_summary: false,
              summary: "No prior summary - beginning of conversation",
              essential_files: truncateForAgent(essentialFilesContent.trim()) || null,
              from_ts: firstMessage?.ts || "0",
              to_ts: firstMessage?.ts || "0",
              message_count: 0,
              restore_hint: essentialFilesContent
                ? "Essential files included - read them to restore core knowledge."
                : null,
            },
            null,
            2,
          );
        }
        break;
      }

      case "chat_store_summary": {
        const channel = args.channel as string;
        const summary = args.summary as string;
        const fromTs = args.from_ts as string;
        const toTs = args.to_ts as string;
        const agentId = (args.agent_id as string) || "default";

        // Validate summary length
        if (summary.length > 5000) {
          resultText = JSON.stringify({
            ok: false,
            error: "Summary too long (max 5000 characters)",
          });
          break;
        }

        // Count messages in the range
        const countResult = db
          .query<{ count: number }, [string, string, string]>(
            `SELECT COUNT(*) as count FROM messages WHERE channel = ? AND ts >= ? AND ts <= ?`,
          )
          .get(channel, fromTs, toTs);
        const messageCount = countResult?.count || 0;

        // Generate summary ID and insert
        const summaryId = `S${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

        db.run(
          `INSERT INTO summaries (id, channel, agent_id, summary, from_ts, to_ts, message_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [summaryId, channel, agentId, summary, fromTs, toTs, messageCount],
        );

        resultText = JSON.stringify(
          {
            ok: true,
            summary_id: summaryId,
            channel,
            agent_id: agentId,
            from_ts: fromTs,
            to_ts: toTs,
            message_count: messageCount,
          },
          null,
          2,
        );
        break;
      }

      // Plan tools
      case "plan_create": {
        const { createPlan } = await import("./routes/tasks");
        const plan = createPlan({
          channel: args.channel as string,
          title: args.title as string,
          description: args.description as string | undefined,
          agent_in_charge: args.agent_in_charge as string | undefined,
          created_by: (args.created_by as string) || "agent",
        });
        resultText = JSON.stringify({ ok: true, plan });
        break;
      }

      case "plan_list": {
        const { listPlans } = await import("./routes/tasks");
        const plans = listPlans(args.channel as string);
        resultText = JSON.stringify({ ok: true, plans });
        break;
      }

      case "plan_get": {
        const { getPlan } = await import("./routes/tasks");
        const plan = getPlan(args.plan_id as string);
        if (!plan) {
          resultText = JSON.stringify({ ok: false, error: "Plan not found" });
        } else {
          resultText = JSON.stringify({ ok: true, plan });
        }
        break;
      }

      case "plan_update": {
        const { updatePlan } = await import("./routes/tasks");
        const plan = updatePlan(args.plan_id as string, {
          status: args.status as "active" | "completed" | "draft" | "cancelled" | undefined,
          title: args.title as string | undefined,
          description: args.description as string | undefined,
          agent_in_charge: args.agent_in_charge as string | undefined,
        });
        if (!plan) {
          resultText = JSON.stringify({ ok: false, error: "Plan not found" });
        } else {
          resultText = JSON.stringify({ ok: true, plan });
        }
        break;
      }

      case "plan_add_phase": {
        const { addPhase } = await import("./routes/tasks");
        const phase = addPhase(args.plan_id as string, {
          name: args.name as string,
          description: args.description as string | undefined,
          agent_in_charge: args.agent_in_charge as string | undefined,
        });
        if (!phase) {
          resultText = JSON.stringify({ ok: false, error: "Plan not found" });
        } else {
          resultText = JSON.stringify({ ok: true, phase });
        }
        break;
      }

      case "plan_update_phase": {
        const { updatePhase } = await import("./routes/tasks");
        const phase = updatePhase(args.phase_id as string, {
          status: args.status as "blocked" | "pending" | "active" | "completed" | "skipped" | undefined,
          name: args.name as string | undefined,
          description: args.description as string | undefined,
          agent_in_charge: args.agent_in_charge as string | undefined,
        });
        if (!phase) {
          resultText = JSON.stringify({ ok: false, error: "Phase not found" });
        } else {
          resultText = JSON.stringify({ ok: true, phase });
        }
        break;
      }

      case "plan_link_task": {
        const { linkTaskToPhase } = await import("./routes/tasks");
        const success = linkTaskToPhase(args.plan_id as string, args.phase_id as string, args.task_id as string);
        resultText = JSON.stringify({
          ok: success,
          error: success ? undefined : "Failed to link task",
        });
        break;
      }

      case "plan_get_tasks": {
        const { getTasksForPlan } = await import("./routes/tasks");
        const phases = getTasksForPlan(args.plan_id as string);
        resultText = JSON.stringify({ ok: true, phases });
        break;
      }

      // ============================================================================
      // Multimodal Tool Handlers
      // ============================================================================

      case "read_image": {
        const fileId = args.file_id as string;
        const prompt =
          (args.prompt as string) ||
          "Describe this image in detail, including any text, diagrams, or notable visual elements.";

        const file = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE id = ?`)
          .get(fileId);

        if (!file) {
          resultText = JSON.stringify({ ok: false, error: "File not found" });
        } else if (!file.mimetype.toLowerCase().startsWith("image/")) {
          resultText = JSON.stringify({
            ok: false,
            error: `File is not an image (${file.mimetype})`,
          });
        } else {
          const result = await analyzeImage(file.path, prompt, [ATTACHMENTS_DIR, "/tmp"]);
          resultText = JSON.stringify({
            ok: result.ok,
            file: { id: file.id, name: file.name, mimetype: file.mimetype },
            ...(result.ok ? { analysis: result.result } : { error: result.error }),
          });
        }
        break;
      }

      case "create_image": {
        const prompt = args.prompt as string;
        const aspectRatio = (args.aspect_ratio as string) || "1:1";
        const imageSize = (args.image_size as string) || "1K";

        const validAspectRatios = [
          "1:1",
          "2:3",
          "3:2",
          "3:4",
          "4:3",
          "4:5",
          "5:4",
          "9:16",
          "16:9",
          "21:9",
          "1:4",
          "4:1",
          "1:8",
          "8:1",
        ];
        if (!validAspectRatios.includes(aspectRatio)) {
          resultText = JSON.stringify({
            ok: false,
            error: `Invalid aspect_ratio: "${aspectRatio}". Valid: ${validAspectRatios.join(", ")}`,
          });
          break;
        }
        const validImageSizes = ["512px", "1K", "2K", "4K"];
        if (!validImageSizes.includes(imageSize)) {
          resultText = JSON.stringify({
            ok: false,
            error: `Invalid image_size: "${imageSize}". Valid: ${validImageSizes.join(", ")}`,
          });
          break;
        }

        const fileId = generateId("F");
        const baseName = `generated-${fileId}-${Date.now()}`;
        const outputPath = join(ATTACHMENTS_DIR, `${baseName}.png`);

        const result = await generateImage(prompt, outputPath, aspectRatio, [ATTACHMENTS_DIR, "/tmp"], imageSize);

        if (result.ok && result.path) {
          try {
            const actualPath = result.path;
            const ext = actualPath.split(".").pop()?.toLowerCase() || "png";
            const fileName = `${baseName}.${ext}`;
            const mimetype = result.mimeType || "image/png";
            const stat = statSync(actualPath);

            db.run("INSERT INTO files (id, name, mimetype, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)", [
              fileId,
              fileName,
              mimetype,
              stat.size,
              actualPath,
              "system",
            ]);

            const quota = getImageQuotaStatus();
            resultText = JSON.stringify({
              ok: true,
              image: {
                id: fileId,
                name: fileName,
                path: actualPath,
                mimetype,
                size: stat.size,
                prompt,
                aspect_ratio: aspectRatio,
              },
              quota: {
                used: quota.used,
                limit: quota.limit,
                remaining: quota.remaining,
              },
            });
          } catch (err) {
            resultText = JSON.stringify({
              ok: false,
              error: `Image generated but failed to register: ${(err as Error).message}`,
              quota: getImageQuotaStatus(),
            });
          }
        } else {
          resultText = JSON.stringify({
            ok: false,
            error: result.error,
            quota: getImageQuotaStatus(),
          });
        }
        break;
      }

      case "edit_image": {
        const sourceFileId = args.file_id as string;
        const prompt = args.prompt as string;

        const sourceFile = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE id = ?`)
          .get(sourceFileId);

        if (!sourceFile) {
          resultText = JSON.stringify({
            ok: false,
            error: "Source file not found",
          });
        } else if (!sourceFile.mimetype.toLowerCase().startsWith("image/")) {
          resultText = JSON.stringify({
            ok: false,
            error: `Source file is not an image (${sourceFile.mimetype})`,
          });
        } else {
          const newFileId = generateId("F");
          const baseName = `edited-${newFileId}-${Date.now()}`;
          const outputPath = join(ATTACHMENTS_DIR, `${baseName}.png`);

          const result = await editImage(sourceFile.path, prompt, outputPath, [ATTACHMENTS_DIR, "/tmp"]);

          if (result.ok && result.path) {
            try {
              const actualPath = result.path;
              const ext = actualPath.split(".").pop()?.toLowerCase() || "png";
              const fileName = `${baseName}.${ext}`;
              const mimetype = result.mimeType || "image/png";
              const stat = statSync(actualPath);

              db.run("INSERT INTO files (id, name, mimetype, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)", [
                newFileId,
                fileName,
                mimetype,
                stat.size,
                actualPath,
                "system",
              ]);

              const quota = getImageQuotaStatus();
              resultText = JSON.stringify({
                ok: true,
                image: {
                  id: newFileId,
                  name: fileName,
                  path: actualPath,
                  mimetype,
                  size: stat.size,
                  source_file_id: sourceFileId,
                  prompt,
                },
                quota: {
                  used: quota.used,
                  limit: quota.limit,
                  remaining: quota.remaining,
                },
              });
            } catch (err) {
              resultText = JSON.stringify({
                ok: false,
                error: `Image edited but failed to register: ${(err as Error).message}`,
                quota: getImageQuotaStatus(),
              });
            }
          } else {
            resultText = JSON.stringify({
              ok: false,
              error: result.error,
              quota: getImageQuotaStatus(),
            });
          }
        }
        break;
      }

      case "read_video": {
        const fileId = args.file_id as string;
        const prompt =
          (args.prompt as string) ||
          "Describe what happens in this video, including any spoken content, on-screen text, and key visual elements.";
        const maxFrames = (args.max_frames as number) || 30;

        const file = db
          .query<
            {
              id: string;
              name: string;
              mimetype: string;
              size: number;
              path: string;
            },
            [string]
          >(`SELECT id, name, mimetype, size, path FROM files WHERE id = ?`)
          .get(fileId);

        if (!file) {
          resultText = JSON.stringify({ ok: false, error: "File not found" });
        } else if (!file.mimetype.toLowerCase().startsWith("video/")) {
          resultText = JSON.stringify({
            ok: false,
            error: `File is not a video (${file.mimetype})`,
          });
        } else {
          const result = await analyzeVideo(file.path, prompt, [ATTACHMENTS_DIR, "/tmp"], maxFrames);
          resultText = JSON.stringify({
            ok: result.ok,
            file: { id: file.id, name: file.name, mimetype: file.mimetype },
            ...(result.ok ? { analysis: result.result } : { error: result.error }),
          });
        }
        break;
      }

      case "web_search": {
        const { webSearch } = await import("../agent/tools/web-search");
        const query = args.query as string;
        const maxResults = (args.max_results as number) || 5;
        const allowedDomains = args.allowed_domains as string[] | undefined;
        const blockedDomains = args.blocked_domains as string[] | undefined;
        if (!query) {
          resultText = JSON.stringify({ ok: false, error: "Missing required parameter: query" });
          break;
        }
        let effectiveQuery = query;
        if (Array.isArray(allowedDomains) && allowedDomains.length > 0)
          effectiveQuery += " " + allowedDomains.map((d) => `site:${d}`).join(" OR ");
        const searchResult = await webSearch(effectiveQuery, maxResults);
        const filtered =
          Array.isArray(blockedDomains) && blockedDomains.length > 0
            ? {
                ...searchResult,
                results: (searchResult as any).results?.filter(
                  (r: any) => !blockedDomains.some((d) => r.url?.includes(d)),
                ),
              }
            : searchResult;
        resultText = JSON.stringify(filtered);
        break;
      }

      case "web_fetch": {
        const url = args.url as string;
        const raw = (args.raw as boolean) || false;
        const maxLength = (args.max_length as number) || 10000;
        if (!url) {
          resultText = JSON.stringify({ ok: false, error: "Missing required parameter: url" });
          break;
        }
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 30000);
          const fetchRes = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; ClawdAgent/1.0)",
              Accept: "text/html,application/json,text/plain,*/*",
            },
            signal: ctrl.signal,
          }).finally(() => clearTimeout(timer));
          if (!fetchRes.ok) {
            resultText = JSON.stringify({ ok: false, error: `HTTP ${fetchRes.status}: ${fetchRes.statusText}` });
            break;
          }
          const contentType = fetchRes.headers.get("content-type") || "";
          let content = await fetchRes.text();
          const { stripHtmlTagBlocks } = await import("../agent/tools/registry");
          if (!raw && contentType.includes("text/html")) {
            content = stripHtmlTagBlocks(content, "script");
            content = stripHtmlTagBlocks(content, "style");
            content = content
              .replace(/<p[^>]*>/gi, "\n")
              .replace(/<\/p>/gi, "\n")
              .replace(/<br\s*\/?>/gi, "\n")
              .replace(/<li[^>]*>/gi, "- ")
              .replace(/<\/li>/gi, "\n")
              .replace(/<[^>]+>/g, "")
              .replace(/&nbsp;/g, " ")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&amp;/g, "&")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
          }
          if (content.length > maxLength) content = content.substring(0, maxLength) + "\n\n[Content truncated]";
          resultText = JSON.stringify({ ok: true, content });
        } catch (fetchErr: any) {
          resultText = JSON.stringify({ ok: false, error: fetchErr.message });
        }
        break;
      }

      default:
        resultText = JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    return {
      content: [{ type: "text", text: resultText }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : "Tool execution failed",
          }),
        },
      ],
    };
  }
}

// ============================================================================
// Space-Scoped MCP Handler (Claude Code sub-agents)
// ============================================================================

/**
 * Callback registry for Claude Code space workers.
 * When a Claude Code subprocess calls complete_task via MCP,
 * the handler looks up the resolve callback here.
 */
export const spaceCompleteCallbacks = new Map<string, (result: string) => void>();

/** Per-space auth tokens — validated on every MCP and hook API request */
export const spaceAuthTokens = new Map<string, string>();

/** Per-space project roots — populated by ClaudeCodeSpaceWorker before runSDKQuery */
export const spaceProjectRoots = new Map<string, string>();

/**
 * Handle MCP requests scoped to a main channel agent.
 * Auto-injects channel and agent_id into every tool call so the agent
 * doesn't need to pass them. Route: /mcp/agent/{channel}/{agentId}
 */
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
      const { AGENT_MCP_TOOLS } = await import("../spaces/agent-mcp-tools");

      // Get plugin tool definitions dynamically (browser, tunnel)
      const pluginToolDefs: any[] = [];
      const pluginToRegister = [
        async () => {
          const { BrowserPlugin } = await import("../agent/plugins/browser-plugin");
          return new BrowserPlugin(channel, agentId).getTools();
        },
        async () => {
          const { TunnelPlugin } = await import("../agent/plugins/tunnel-plugin");
          return new TunnelPlugin().getTools();
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
        } catch {}
      }

      // Add job tools if tmux is available
      const jobToolDefs: any[] = [];
      try {
        const { hasTmux } = await import("../claude-code-utils");
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
      } catch {}

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
      const tmuxToolDefs: any[] = [];
      try {
        const { hasTmux: hasTmuxCheck } = await import("../claude-code-utils");
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
      } catch {}

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
      ];

      // Article tools
      const articleToolDefs = [
        {
          name: "article_create",
          description:
            "Create a new article (blog post, documentation, etc.). The article is stored and can be published to the channel. Provide content via one of: 'content' (raw markdown), 'file_id' (uploaded file from chat_upload_local_file), or 'message_ts' (existing chat message timestamp).",
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
                  "File ID from chat_upload_local_file — file content is used as article body (mutually exclusive with content and message_ts)",
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
          name: "chat_send_article",
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
          name: "chat_search",
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
          name: "get_environment",
          description:
            "Get working environment: OS, shell, project root, and runtime. Call at session start. All file tools accept relative paths (resolved from project root).",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
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
            "Get the output logs of a sub-agent by its ID. Use this to check what a sub-agent is doing or has done.",
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

      // Add remote worker tools if agent has a connected remote worker
      const remoteToolDefs: any[] = [];
      try {
        const agentRow = db
          .query<{ worker_token: string | null }, [string, string]>(
            `SELECT worker_token FROM channel_agents WHERE agent_id = ? AND channel = ?`,
          )
          .get(agentId, channel);
        if (agentRow?.worker_token) {
          const { createHash } = await import("crypto");
          const tokenHash = createHash("sha256").update(agentRow.worker_token).digest("hex");
          const { getConnectedWorker } = await import("./remote-worker");
          const worker = getConnectedWorker(tokenHash);
          if (worker && worker.status === "connected" && worker.tools.length > 0) {
            const platform = worker.platform || "unknown";
            const isWindows = platform.toLowerCase().includes("win");
            const tag = `[Remote: ${worker.name}, ${platform}]`;
            for (const t of worker.tools) {
              let desc = `${tag} ${t.description}`;
              if (t.name === "bash" && isWindows) {
                desc +=
                  "\n\nThis remote machine runs Windows. Use PowerShell syntax: " +
                  "Get-ChildItem (not ls), Get-Content (not cat), $env:VAR (not $VAR), " +
                  "backslash paths. For multi-line scripts, write to a .ps1 file first.";
              }
              remoteToolDefs.push({ name: `remote_${t.name}`, description: desc, inputSchema: t.inputSchema });
            }
          }
        }
      } catch {}

      const { getMcpFileToolDefs } = await import("./mcp-file-tools");
      const fileToolDefs = getMcpFileToolDefs().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      const { CUSTOM_SCRIPT_MCP_TOOL_DEF } = await import("../agent/plugins/custom-tool-plugin");

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
        ...remoteToolDefs,
        ...fileToolDefs,
        ...webToolDefs,
        CUSTOM_SCRIPT_MCP_TOOL_DEF,
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
      } catch {}

      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: allTools } }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (method === "tools/call") {
      const { name, arguments: toolArgs } = params as {
        name: string;
        arguments: Record<string, unknown>;
      };

      // Handle remote worker tools
      if (name.startsWith("remote_")) {
        try {
          const agentRow = db
            .query<{ worker_token: string | null }, [string, string]>(
              `SELECT worker_token FROM channel_agents WHERE agent_id = ? AND channel = ?`,
            )
            .get(agentId, channel);
          if (!agentRow?.worker_token) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: "No remote worker connected" }] },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          const { createHash } = await import("crypto");
          const tokenHash = createHash("sha256").update(agentRow.worker_token).digest("hex");
          const { callRemoteWorkerTool } = await import("./remote-worker");
          const toolName = name.replace(/^remote_/, "");
          const result = await callRemoteWorkerTool(tokenHash, toolName, (toolArgs || {}) as Record<string, any>);
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result }] } }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Remote tool error: ${err.message}` }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle file tools (MCP file operations — project-root scoped)
      if (name.startsWith("file_")) {
        try {
          const { getAgentProjectRoot } = await import("../api/agents");
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
          const { executeMcpFileTool } = await import("./mcp-file-tools");
          const result = await executeMcpFileTool(name, (toolArgs || {}) as Record<string, unknown>, projectRoot);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }) }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle custom_script tool
      if (name === "custom_script") {
        try {
          const { getAgentProjectRoot } = await import("../api/agents");
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
          const { executeCustomScriptMcp } = await import("../agent/plugins/custom-tool-plugin");
          const result = await executeCustomScriptMcp(projectRoot, (toolArgs || {}) as Record<string, any>);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }) }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle job tools (tmux-based background jobs)
      if (name.startsWith("job_")) {
        try {
          const { tmuxJobManager } = await import("../agent/jobs/tmux-manager");
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
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Job error: ${err.message}` }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle memo tools (agent long-term memory)
      if (name.startsWith("memo_")) {
        try {
          const { getAgentMemoryStore } = await import("../agent/memory/agent-memory");
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
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Memo error: ${err.message}` }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle task tools (channel kanban board)
      if (name.startsWith("task_")) {
        try {
          const { listTasks, getTask, createTask, createTasksBatch, updateTask, deleteTask, addTaskComment } =
            await import("./routes/tasks");
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
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Task error: ${err.message}` }] },
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
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Schedule error: ${err.message}` }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle tmux tools
      if (name.startsWith("tmux_")) {
        try {
          const { hasTmux: hasTmuxCheck } = await import("../claude-code-utils");
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
            const { join } = require("node:path");
            const { homedir } = require("node:os");
            const home = homedir();
            return join(home, ".clawd", "tmux-mcp.sock");
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
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Tmux error: ${err.message}` }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle skill tools
      if (name.startsWith("skill_")) {
        try {
          const { getSkillManager } = await import("../agent/skills/manager");
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
            default:
              text = `Error: Unknown skill tool: ${name}`;
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Skill error: ${err.message}` }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle article tools
      if (name.startsWith("article_") || name === "chat_send_article") {
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
                const { getFile } = await import("./routes/files");
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
              const params: any[] = [];
              const { title, content, description: desc, thumbnail_url, tags, published } = args as Record<string, any>;
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
            case "chat_send_article": {
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
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Article error: ${err.message}` }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle memory tools
      if (name === "chat_search" || name === "memory_summary") {
        try {
          const { getMemoryManager } = await import("../agent/memory/memory");
          const memory = getMemoryManager();
          const args = toolArgs || {};
          let text = "";
          switch (name) {
            case "chat_search": {
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
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Memory error: ${err.message}` }] },
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
          const { getAgentMemoryStore } = await import("../agent/memory/agent-memory");
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
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Memory error: ${err.message}` }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Handle utility tools
      if (
        name === "get_environment" ||
        name === "today" ||
        name === "convert_to_markdown" ||
        name === "get_agent_logs" ||
        name === "bash"
      ) {
        try {
          const args = toolArgs || {};
          let text = "";
          switch (name) {
            case "get_environment": {
              const os = await import("node:os");
              const platform = os.platform();
              const isWindows = platform === "win32";
              const shell = isWindows ? process.env.COMSPEC || "cmd.exe" : process.env.SHELL || "/bin/bash";
              text = JSON.stringify(
                {
                  os: platform,
                  arch: os.arch(),
                  shell,
                  shell_type: isWindows
                    ? shell.toLowerCase().includes("powershell")
                      ? "powershell"
                      : "cmd"
                    : shell.split("/").pop(),
                  user: os.userInfo().username,
                  runtime: `Bun ${Bun.version}`,
                  cwd: process.cwd(),
                  hint: isWindows ? "Windows machine. Use PowerShell/cmd syntax." : "Unix machine. Use bash syntax.",
                },
                null,
                2,
              );
              break;
            }
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
              const { convertToMarkdown } = await import("../agent/tools/document-converter");
              const result = await convertToMarkdown(filePath);
              if (!result.success) {
                text = `Error: ${result.error}`;
                break;
              }
              const { writeFile, mkdir } = await import("node:fs/promises");
              const { basename, extname, join } = await import("node:path");
              const { homedir } = await import("node:os");
              const filesDir = join(homedir(), ".clawd", "files");
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
                  const { tmuxJobManager } = await import("../agent/jobs/tmux-manager");
                  const jobName = description || command.slice(0, 40).replace(/[^a-zA-Z0-9-_]/g, "_");
                  const jobId = tmuxJobManager.submit(jobName, command);
                  text = `Background job started: ${jobId}\nUse job_status(job_id="${jobId}") to check output.`;
                } catch (bgErr: any) {
                  text = `Error: Failed to start background job: ${bgErr.message}`;
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
              } = await import("../agent/utils/sandbox");
              if (isSbxEnabled() && isSbxReady()) {
                try {
                  finalCommand = await wrapCmd(command, workDir);
                } catch (wrapErr: any) {
                  text = `Error: Sandbox wrapping failed: ${wrapErr.message}`;
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
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Utility tool error: ${err.message}` }] },
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
        const { executeAgentToolCall } = await import("../spaces/agent-mcp-tools");
        const result = await executeAgentToolCall(name, toolArgs || {}, channel, agentId);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check if this is a tunnel tool
      if (name.startsWith("tunnel_")) {
        try {
          const { TunnelPlugin } = await import("../agent/plugins/tunnel-plugin");
          const tunnelPlugin = new TunnelPlugin();
          const tools = tunnelPlugin.getTools();
          const tool = tools.find((t) => t.name === name);
          if (tool) {
            const result = await tool.handler(toolArgs || {});
            const text = result.success ? result.output : `Error: ${result.error || "Unknown error"}`;
            return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Tunnel error: ${err.message}` }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Check if this is a browser tool
      if (name.startsWith("browser_")) {
        try {
          const { BrowserPlugin } = await import("../agent/plugins/browser-plugin");
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
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Browser error: ${err.message}` }] },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Auto-inject channel and agent_id into chat tool calls
      const enrichedArgs = {
        ...(toolArgs || {}),
        channel: (toolArgs?.channel as string) || channel,
        agent_id: (toolArgs?.agent_id as string) || agentId,
      };

      // Handle connected channel MCP server tools
      try {
        const mcpManager = _workerManager?.getChannelMcpManager(channel);
        if (mcpManager) {
          const mcpResult = await mcpManager.executeMCPTool(name, enrichedArgs);
          if (mcpResult !== undefined) {
            const text = typeof mcpResult === "string" ? mcpResult : JSON.stringify(mcpResult);
            return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
      } catch {}

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
  } catch (error) {
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
export async function handleSpaceMcpRequest(req: Request, spaceId: string): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Validate per-space auth token
  const authHeader = req.headers.get("Authorization") || "";
  const reqToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const expectedToken = spaceAuthTokens.get(spaceId);
  if (!expectedToken || reqToken !== expectedToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
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

    let result: unknown;

    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "clawd-space-mcp", version: "1.0.0" },
          capabilities: { tools: {} },
        };
        break;

      case "notifications/initialized":
        // Client acknowledgment — no response needed for notifications
        return new Response(null, { status: 204, headers: corsHeaders });

      case "tools/list": {
        const { getMcpFileToolDefs: getSpaceFileToolDefs } = await import("./mcp-file-tools");
        const spaceFileToolDefs = getSpaceFileToolDefs().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        const { CUSTOM_SCRIPT_MCP_TOOL_DEF: spaceCustomScriptToolDef } = await import(
          "../agent/plugins/custom-tool-plugin"
        );
        result = {
          tools: [
            {
              name: "complete_task",
              description:
                "Signal that your task is fully complete. Call this ONCE when done. " +
                "This posts your result to the parent channel and closes the sub-space.",
              inputSchema: {
                type: "object",
                properties: {
                  space_id: { type: "string", description: "The space ID (from your system prompt)" },
                  result: { type: "string", description: "Your final result summary" },
                },
                required: ["space_id", "result"],
              },
            },
            ...spaceFileToolDefs,
            spaceCustomScriptToolDef,
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
          ],
        };
        break;
      }

      case "tools/call": {
        const { name, arguments: toolArgs } = params as {
          name: string;
          arguments: Record<string, unknown>;
        };

        if (name.startsWith("file_")) {
          try {
            const projectRoot = spaceProjectRoots.get(spaceId);
            if (!projectRoot) {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          ok: false,
                          error: "Space project root not registered yet — the space may still be initializing",
                        }),
                      },
                    ],
                  },
                }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
            const { executeMcpFileTool } = await import("./mcp-file-tools");
            const fileResult = await executeMcpFileTool(name, (toolArgs || {}) as Record<string, unknown>, projectRoot);
            return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: fileResult }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          } catch (err: any) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }) }] },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }

        if (name === "custom_script") {
          try {
            const projectRoot = spaceProjectRoots.get(spaceId);
            if (!projectRoot) {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          ok: false,
                          error: "Space project root not registered yet — the space may still be initializing",
                        }),
                      },
                    ],
                  },
                }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
            const { executeCustomScriptMcp } = await import("../agent/plugins/custom-tool-plugin");
            const customScriptResult = await executeCustomScriptMcp(
              projectRoot,
              (toolArgs || {}) as Record<string, any>,
            );
            return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: customScriptResult }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          } catch (err: any) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }) }] },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }

        if (name === "web_search" || name === "web_fetch") {
          try {
            if (name === "web_search") {
              const { webSearch } = await import("../agent/tools/web-search");
              const query = (toolArgs?.query as string) || "";
              const maxResults = (toolArgs?.max_results as number) || 5;
              const allowedDomains = toolArgs?.allowed_domains as string[] | undefined;
              const blockedDomains = toolArgs?.blocked_domains as string[] | undefined;
              if (!query) {
                result = {
                  content: [
                    { type: "text", text: JSON.stringify({ ok: false, error: "Missing required parameter: query" }) },
                  ],
                };
                break;
              }
              let q = query;
              if (Array.isArray(allowedDomains) && allowedDomains.length > 0)
                q += " " + allowedDomains.map((d) => `site:${d}`).join(" OR ");
              const sr = await webSearch(q, maxResults);
              const filtered =
                Array.isArray(blockedDomains) && blockedDomains.length > 0
                  ? {
                      ...sr,
                      results: (sr as any).results?.filter(
                        (r: any) => !blockedDomains.some((d: string) => r.url?.includes(d)),
                      ),
                    }
                  : sr;
              result = { content: [{ type: "text", text: JSON.stringify(filtered) }] };
            } else {
              const url = (toolArgs?.url as string) || "";
              const raw = (toolArgs?.raw as boolean) || false;
              const maxLength = (toolArgs?.max_length as number) || 10000;
              if (!url) {
                result = {
                  content: [
                    { type: "text", text: JSON.stringify({ ok: false, error: "Missing required parameter: url" }) },
                  ],
                };
                break;
              }
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 30000);
              const fetchRes = await fetch(url, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (compatible; ClawdAgent/1.0)",
                  Accept: "text/html,application/json,text/plain,*/*",
                },
                signal: ctrl.signal,
              }).finally(() => clearTimeout(timer));
              if (!fetchRes.ok) {
                result = {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ ok: false, error: `HTTP ${fetchRes.status}: ${fetchRes.statusText}` }),
                    },
                  ],
                };
                break;
              }
              const contentType = fetchRes.headers.get("content-type") || "";
              let content = await fetchRes.text();
              const { stripHtmlTagBlocks } = await import("../agent/tools/registry");
              if (!raw && contentType.includes("text/html")) {
                content = stripHtmlTagBlocks(content, "script");
                content = stripHtmlTagBlocks(content, "style");
                content = content
                  .replace(/<p[^>]*>/gi, "\n")
                  .replace(/<\/p>/gi, "\n")
                  .replace(/<br\s*\/?>/gi, "\n")
                  .replace(/<li[^>]*>/gi, "- ")
                  .replace(/<\/li>/gi, "\n")
                  .replace(/<[^>]+>/g, "")
                  .replace(/&nbsp;/g, " ")
                  .replace(/&lt;/g, "<")
                  .replace(/&gt;/g, ">")
                  .replace(/&quot;/g, '"')
                  .replace(/&amp;/g, "&")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim();
              }
              if (content.length > maxLength) content = content.substring(0, maxLength) + "\n\n[Content truncated]";
              result = { content: [{ type: "text", text: JSON.stringify({ ok: true, content }) }] };
            }
          } catch (webErr: any) {
            result = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: webErr.message }) }] };
          }
          break;
        }

        if (name !== "complete_task") {
          result = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Unknown tool" }) }] };
          break;
        }

        const argSpaceId = toolArgs?.space_id as string;
        const taskResult = toolArgs?.result as string;

        if (argSpaceId !== spaceId) {
          result = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Invalid space_id" }) }] };
          break;
        }

        // Fire the completion callback
        const callback = spaceCompleteCallbacks.get(spaceId);
        if (callback) {
          callback(taskResult || "Task completed");
        }

        result = { content: [{ type: "text", text: JSON.stringify({ ok: true, message: "Task completed." }) }] };
        break;
      }

      default:
        result = {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown method: ${method}` }) }],
        };
    }

    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
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
