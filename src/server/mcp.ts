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
import { broadcastMessageSeen, broadcastUpdate } from "./websocket";

// Scheduler reference (set by index.ts after creation)
let _scheduler: SchedulerManager | null = null;
export function setMcpScheduler(scheduler: SchedulerManager): void {
  _scheduler = scheduler;
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
  - include_bot (boolean): Include bot messages for context (default: true)

Returns JSON:
{
  "ok": true,
  "messages": [...],           // All messages (for context)
  "pending": [...],            // UHUMAN messages needing processing
  "last_seen_ts": "...",       // Timestamp marked as seen
  "last_processed_ts": "...",  // Last processed timestamp
  "count": number              // Number of pending messages
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
        channel: {
          type: "string",
          description: "Channel ID (e.g., 'chat-task')",
        },
        agent_id: {
          type: "string",
          description: "Agent identifier for tracking seen messages",
          default: "default",
        },
        include_bot: {
          type: "boolean",
          description: "Include bot messages for context understanding",
          default: true,
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
        channel: {
          type: "string",
          description: "Channel ID (auto-injected if omitted)",
        },
        timestamp: {
          type: "string",
          description: "Timestamp of the processed message",
        },
        agent_id: {
          type: "string",
          description: "Agent identifier (auto-injected if omitted)",
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
        channel: {
          type: "string",
          description: "Channel ID (auto-injected if omitted)",
        },
        text: {
          type: "string",
          description: "Message text (supports markdown)",
        },
        agent_id: {
          type: "string",
          description: "Agent identifier (auto-injected if omitted)",
        },
        user: {
          type: "string",
          description: "User ID (auto-injected if omitted)",
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
        channel: {
          type: "string",
          description: "Channel ID",
        },
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
        channel: {
          type: "string",
          description: "Channel ID",
        },
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
        channel: {
          type: "string",
          description: "Channel ID",
        },
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
        channel: {
          type: "string",
          description: "Channel ID for association",
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
        channel: {
          type: "string",
          description: "Channel ID for association",
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
        channel: {
          type: "string",
          description: "Channel ID",
        },
        text: {
          type: "string",
          description: "Message text",
        },
        file_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of file IDs to attach",
        },
        agent_id: {
          type: "string",
          description: "Agent identifier (your agent name)",
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
        channel: {
          type: "string",
          description: "Channel ID",
        },
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
        channel: {
          type: "string",
          description: "Channel ID",
        },
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
        channel: {
          type: "string",
          description: "Channel ID",
        },
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
        channel: {
          type: "string",
          description: "Channel ID (e.g., 'chat-task')",
        },
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
      properties: {
        channel: {
          type: "string",
          description: "Channel ID",
        },
        agent_id: {
          type: "string",
          description: "Agent identifier",
          default: "default",
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
        channel: {
          type: "string",
          description: "Channel ID",
        },
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
        agent_id: {
          type: "string",
          description: "Agent identifier",
          default: "default",
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
        channel: { type: "string", description: "Channel ID" },
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
      properties: {
        channel: { type: "string", description: "Channel ID" },
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
        channel: { type: "string", description: "Channel ID" },
        agent_id: { type: "string", description: "Agent ID creating the schedule" },
        title: { type: "string", description: "Job/reminder title (max 200 chars)" },
        prompt: { type: "string", description: "Task prompt or reminder message" },
        schedule: { type: "string", description: 'Schedule: "in 5 minutes", "every 2 hours", cron, or ISO 8601' },
        is_reminder: { type: "boolean", description: "If true, creates a reminder instead of a job" },
        max_runs: { type: "number", description: "Max runs before auto-completing" },
        timeout_seconds: { type: "number", description: "Per-run timeout (default: 300, max: 3600)" },
      },
      required: ["title", "prompt", "schedule"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "scheduler_list",
    description: "List scheduled jobs and reminders in a channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID" },
        status: { type: "string", description: "Filter by status: active, paused, completed, failed, cancelled" },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "scheduler_cancel",
    description: "Cancel a scheduled job or reminder.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job/reminder ID" },
        agent_id: { type: "string", description: "Agent ID (for authorization)" },
        channel: { type: "string", description: "Channel ID (for authorization)" },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "scheduler_history",
    description: "View run history for a scheduled job.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job/reminder ID" },
        limit: { type: "number", description: "Number of recent runs (default: 10, max: 50)" },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
              { type: "text", text: JSON.stringify({ ok: false, error: "Tool not available in space scope" }) },
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
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Scheduler not available" }) }] };
      }
      switch (name) {
        case "scheduler_create": {
          const maxRuns = args.max_runs as number | undefined;
          const timeoutSeconds = args.timeout_seconds as number | undefined;
          if (maxRuns !== undefined && (!Number.isFinite(maxRuns) || maxRuns <= 0 || !Number.isInteger(maxRuns))) {
            resultText = JSON.stringify({ ok: false, error: "max_runs must be a positive integer" });
            break;
          }
          if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
            resultText = JSON.stringify({ ok: false, error: "timeout_seconds must be a positive number" });
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
          resultText = JSON.stringify(r.success ? { ok: true, job: r.job } : { ok: false, error: r.error }, null, 2);
          break;
        }
        case "scheduler_list": {
          const jobs = _scheduler.listJobsForChannel(args.channel as string, args.status as string | undefined);
          resultText = JSON.stringify({ ok: true, jobs }, null, 2);
          break;
        }
        case "scheduler_cancel": {
          const r = _scheduler.cancelJobFromTool(args.id as string, args.agent_id as string, args.channel as string);
          resultText = JSON.stringify({ ok: r.success, error: r.success ? undefined : r.error }, null, 2);
          break;
        }
        case "scheduler_history": {
          const limit = Math.min((args.limit as number) || 10, 50);
          const runs = _scheduler.getJobRunsForTool(args.id as string, limit, args.channel as string | undefined);
          resultText = JSON.stringify({ ok: true, runs }, null, 2);
          break;
        }
        default:
          resultText = JSON.stringify({ ok: false, error: `Unknown scheduler tool: ${name}` });
      }
      return { content: [{ type: "text", text: resultText }] };
    }

    switch (name) {
      case "chat_poll_and_ack": {
        const channel = args.channel as string;
        const agentId = (args.agent_id as string) || "default";
        const includeBot = args.include_bot !== false;

        // Get agent's last processed timestamp (for filtering pending)
        const agentState = db
          .query<{ last_seen_ts: string | null; last_processed_ts: string | null }, [string, string]>(
            `SELECT last_seen_ts, last_processed_ts FROM agent_seen WHERE agent_id = ? AND channel = ?`,
          )
          .get(agentId, channel);

        let lastProcessedTs = agentState?.last_processed_ts;

        // Get all messages (for context)
        const allResult = getPendingMessages(channel, undefined, includeBot);
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
        // Include UHUMAN and UWORKER-* messages (scheduler, sub-agents, etc.)
        // Exclude UBOT messages from other agents (already in context) and self-messages
        const pending = messages.filter(
          (m: { user: string; ts: string; agent_id?: string }) =>
            (m.user === "UHUMAN" ||
              m.user.startsWith("UWORKER-") ||
              (m.user === "UBOT" && m.agent_id && m.agent_id !== agentId)) &&
            (!lastProcessedTs || m.ts > lastProcessedTs),
        );

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

        // Add seen_by to each message
        const messagesWithSeenBy = messages.map((m: { ts: string; user: string; text?: string }) => {
          const seenBy = getMessageSeenBy(channel, m.ts);
          // Get avatar color for each agent who saw the message
          const seenByWithColors = seenBy.map((aid) => {
            const agent = getAgent(aid, channel);
            return {
              agent_id: aid,
              avatar_color: agent?.avatar_color || "#D97853",
            };
          });
          return { ...m, seen_by: seenByWithColors };
        });

        // Estimate tokens for context length warning
        // Rough estimate: 1 token ≈ 4 characters (for English text)
        // Conservative: 3.5 chars/token to catch edge cases earlier
        const estimateTokens = (text: string): number => Math.ceil(text.length / 3.5);
        const totalChars = messages.reduce((sum: number, m: { text?: string }) => sum + (m.text?.length || 0), 0);
        const estimatedTokens = estimateTokens(JSON.stringify(messagesWithSeenBy));
        const TOKEN_WARNING_THRESHOLD = 50000; // Warn at 50k estimated tokens
        const TOKEN_CRITICAL_THRESHOLD = 70000; // Critical at 70k

        const shouldCompact = estimatedTokens > TOKEN_WARNING_THRESHOLD;
        const compactUrgent = estimatedTokens > TOKEN_CRITICAL_THRESHOLD;

        // Add seen_by to pending messages as well
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
        const truncatedMessages = messagesWithSeenBy.map((m) => ({ ...m, text: truncateForAgent(m.text) }));
        const truncatedPending = pendingWithSeenBy.map((m) => ({ ...m, text: truncateForAgent(m.text) }));

        resultText = JSON.stringify(
          {
            ok: true,
            messages: truncatedMessages,
            pending: truncatedPending,
            last_seen_ts: messages.length > 0 ? messages[messages.length - 1].ts : null,
            last_processed_ts: lastProcessedTs,
            count: pending.length,
            // Token estimation for context management
            estimated_tokens: estimatedTokens,
            total_chars: totalChars,
            should_compact: shouldCompact,
            compact_urgent: compactUrgent,
            ...(shouldCompact && {
              compact_hint: compactUrgent
                ? "[CRITICAL] Context approaching limit! Run /compact NOW to summarize and clear old messages."
                : "[WARNING] Context is getting long. Consider running /compact soon to free up space.",
            }),
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
           last_processed_ts = excluded.last_processed_ts, updated_at = excluded.updated_at`,
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

        const result = postMessage({
          channel,
          text,
          user: userId,
          agent_id: agentId,
          html_preview: htmlPreview,
          code_preview: codePreview,
          workspace_json: workspaceJson,
        });

        resultText = JSON.stringify(result, null, 2);
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
            return { ...m, text: truncateForAgent(m.text), seen_by: seenByWithColors };
          }) as typeof result.messages;
        }

        resultText = JSON.stringify(result, null, 2);
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
            { ok: true, message: { ...slackMsg, text: truncateForAgent(slackMsg.text) } },
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

        resultText = JSON.stringify({ ok: true, files: fileResults }, null, 2);
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

          resultText = JSON.stringify(response, null, 2);
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

        const { basename, extname, join } = await import("node:path");
        const { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } = await import("node:fs");
        const { ATTACHMENTS_DIR } = await import("./database");

        // Validate file exists
        if (!existsSync(filePath)) {
          resultText = JSON.stringify({ ok: false, error: `File not found: ${filePath}` });
          break;
        }

        // Check it's a file (not directory)
        const stat = statSync(filePath);
        if (!stat.isFile()) {
          resultText = JSON.stringify({ ok: false, error: `Not a file: ${filePath}` });
          break;
        }

        // Read the file
        const buffer = readFileSync(filePath);

        // Determine filename
        const displayName = (args.filename as string) || basename(filePath);

        // Auto-detect mimetype from extension
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
          resultText = JSON.stringify(msgResult, null, 2);
        }
        break;
      }

      case "chat_delete_message": {
        const channel = args.channel as string;
        const ts = args.ts as string;

        // Import deleteMessage from routes
        const { deleteMessage } = await import("./routes/messages");
        const result = deleteMessage(channel, ts);

        resultText = JSON.stringify(result, null, 2);
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

        resultText = JSON.stringify(result, null, 2);
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

        resultText = JSON.stringify(result, null, 2);
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

        // Apply regex filter post-query
        if (searchRegex) {
          try {
            const regex = new RegExp(searchRegex, "i");
            messages = messages.filter((m) => regex.test(m.text || ""));
          } catch (e) {
            resultText = JSON.stringify({
              ok: false,
              error: `Invalid regex pattern: ${(e as Error).message}`,
            });
            break;
          }
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
        resultText = JSON.stringify({ ok: true, plan }, null, 2);
        break;
      }

      case "plan_list": {
        const { listPlans } = await import("./routes/tasks");
        const plans = listPlans(args.channel as string);
        resultText = JSON.stringify({ ok: true, plans }, null, 2);
        break;
      }

      case "plan_get": {
        const { getPlan } = await import("./routes/tasks");
        const plan = getPlan(args.plan_id as string);
        if (!plan) {
          resultText = JSON.stringify({ ok: false, error: "Plan not found" });
        } else {
          resultText = JSON.stringify({ ok: true, plan }, null, 2);
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
          resultText = JSON.stringify({ ok: true, plan }, null, 2);
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
          resultText = JSON.stringify({ ok: true, phase }, null, 2);
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
          resultText = JSON.stringify({ ok: true, phase }, null, 2);
        }
        break;
      }

      case "plan_link_task": {
        const { linkTaskToPhase } = await import("./routes/tasks");
        const success = linkTaskToPhase(args.plan_id as string, args.phase_id as string, args.task_id as string);
        resultText = JSON.stringify({ ok: success, error: success ? undefined : "Failed to link task" }, null, 2);
        break;
      }

      case "plan_get_tasks": {
        const { getTasksForPlan } = await import("./routes/tasks");
        const phases = getTasksForPlan(args.plan_id as string);
        resultText = JSON.stringify({ ok: true, phases }, null, 2);
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
          .query<{ id: string; name: string; mimetype: string; size: number; path: string }, [string]>(
            `SELECT id, name, mimetype, size, path FROM files WHERE id = ?`,
          )
          .get(fileId);

        if (!file) {
          resultText = JSON.stringify({ ok: false, error: "File not found" });
        } else if (!file.mimetype.toLowerCase().startsWith("image/")) {
          resultText = JSON.stringify({ ok: false, error: `File is not an image (${file.mimetype})` });
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
              quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining },
            });
          } catch (err) {
            resultText = JSON.stringify({
              ok: false,
              error: `Image generated but failed to register: ${(err as Error).message}`,
              quota: getImageQuotaStatus(),
            });
          }
        } else {
          resultText = JSON.stringify({ ok: false, error: result.error, quota: getImageQuotaStatus() });
        }
        break;
      }

      case "edit_image": {
        const sourceFileId = args.file_id as string;
        const prompt = args.prompt as string;

        const sourceFile = db
          .query<{ id: string; name: string; mimetype: string; size: number; path: string }, [string]>(
            `SELECT id, name, mimetype, size, path FROM files WHERE id = ?`,
          )
          .get(sourceFileId);

        if (!sourceFile) {
          resultText = JSON.stringify({ ok: false, error: "Source file not found" });
        } else if (!sourceFile.mimetype.toLowerCase().startsWith("image/")) {
          resultText = JSON.stringify({ ok: false, error: `Source file is not an image (${sourceFile.mimetype})` });
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
                quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining },
              });
            } catch (err) {
              resultText = JSON.stringify({
                ok: false,
                error: `Image edited but failed to register: ${(err as Error).message}`,
                quota: getImageQuotaStatus(),
              });
            }
          } else {
            resultText = JSON.stringify({ ok: false, error: result.error, quota: getImageQuotaStatus() });
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
          .query<{ id: string; name: string; mimetype: string; size: number; path: string }, [string]>(
            `SELECT id, name, mimetype, size, path FROM files WHERE id = ?`,
          )
          .get(fileId);

        if (!file) {
          resultText = JSON.stringify({ ok: false, error: "File not found" });
        } else if (!file.mimetype.toLowerCase().startsWith("video/")) {
          resultText = JSON.stringify({ ok: false, error: `File is not a video (${file.mimetype})` });
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
