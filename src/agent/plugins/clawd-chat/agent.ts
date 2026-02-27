/**
 * Claw'd-Chat Agent Plugin
 *
 * Integration with clawd-chat server for streaming and interrupts.
 *
 * Features:
 * - Stream tokens directly to channel
 * - Poll for new completed messages
 * - Interrupt on full messages only (not streaming responses)
 */

import type { Plugin, PluginContext } from "../../src/plugins/manager";
import type { ToolPlugin, ToolRegistration } from "../../src/tools/plugin";
import { setCurrentAgentId, setCurrentChannel, setChatApiUrl } from "../../src/tools/tools";
import { getMCPServers } from "../../src/api/provider-config";

// ============================================================================
// Types
// ============================================================================

export interface ClawdChatConfig {
  apiUrl: string;
  channel: string;
  agentId: string;
  pollInterval?: number;
  /** If true, this agent is a worker/sub-agent (uses UWORKER- prefix instead of UBOT) */
  isWorker?: boolean;
  /** If true, this agent is a space sub-agent */
  isSpaceAgent?: boolean;
}

interface ChatMessage {
  ts: string;
  text: string;
  user: string;
  agent_id?: string;
  is_sleeping?: boolean;
}

// ============================================================================
// Utilities
// ============================================================================

function safeJsonParse<T = any>(text: string | undefined | null, defaultValue: T): T {
  if (!text) return defaultValue;
  try {
    return JSON.parse(text);
  } catch {
    return defaultValue;
  }
}

// ============================================================================
// Claw'd-Chat Plugin Factory
// ============================================================================

export function createClawdChatPlugin(config: ClawdChatConfig): Plugin {
  let _currentMessageTs: string | null = null;
  let _streamBuffer = "";
  let lastProcessedTs: string | null = null;
  let currentProcessingTs: string | null = null; // Timestamp of message being processed
  let pollTimer: Timer | null = null;
  let pendingInterrupt: string | null = null;
  let isProcessingMessage = false; // Guard against multiple "..." messages
  let interruptCount = 0; // Track interrupts per user message
  const MAX_INTERRUPTS = 3; // Maximum interrupts to handle per user message
  let isInterruptCall = false; // Flag to distinguish interrupt vs initial onUserMessage call
  const injectedTimestamps = new Set<string>(); // Track already-injected message timestamps
  const _channelSummary: string | null = null; // Cached channel summary
  const _summaryGeneratedAt: number | null = null; // When summary was generated

  const apiUrl = config.apiUrl.replace(/\/$/, "");
  const _pollInterval = config.pollInterval || 500;
  const _SUMMARY_TTL = 30 * 60 * 1000; // Refresh summary every 30 minutes

  // Determine user ID based on whether this is a worker/sub-agent
  const userId = config.isWorker || config.isSpaceAgent ? `UWORKER-${config.agentId}` : "UBOT";

  // Fetch with timeout to prevent hangs on self-calls to localhost
  const timedFetch = (url: string, options: RequestInit = {}, ms = 15000): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  };

  // ============================================================================
  // API Helpers
  // ============================================================================

  async function setAgentStreaming(isStreaming: boolean): Promise<void> {
    try {
      await timedFetch(`${apiUrl}/api/agent.setStreaming`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: config.agentId,
          channel: config.channel,
          is_streaming: isStreaming,
        }),
      });
    } catch {
      // Ignore errors
    }
  }

  async function streamToken(token: string, tokenType: "content" | "thinking" | "event" = "content"): Promise<void> {
    try {
      await timedFetch(`${apiUrl}/api/agent.streamToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: config.agentId,
          channel: config.channel,
          token,
          token_type: tokenType,
        }),
      });
    } catch {
      // Ignore errors - streaming tokens are best-effort
    }
  }

  async function streamToolCall(
    toolName: string,
    toolArgs: any,
    status: "started" | "completed" | "error" = "started",
    result?: any,
  ): Promise<void> {
    try {
      await timedFetch(`${apiUrl}/api/agent.streamToolCall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: config.agentId,
          channel: config.channel,
          tool_name: toolName,
          tool_args: toolArgs,
          status,
          result,
        }),
      });
    } catch {
      // Ignore errors - tool call streaming is best-effort
    }
  }

  async function _sendMessage(text: string): Promise<string> {
    const response = await timedFetch(`${apiUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "chat_send_message",
          arguments: {
            channel: config.channel,
            text,
            agent_id: config.agentId,
            user: userId,
          },
        },
      }),
    });

    const result = (await response.json()) as any;
    const content = safeJsonParse(result.result?.content?.[0]?.text, {}) as any;
    return content.ts || "";
  }

  async function _updateMessage(ts: string, text: string): Promise<void> {
    try {
      await timedFetch(`${apiUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: "chat_update_message",
            arguments: {
              channel: config.channel,
              ts,
              text,
            },
          },
        }),
      });
    } catch {
      // Update failed, ignore (message will be final on stream end)
    }
  }

  async function getChatHistory(limit: number = 50): Promise<ChatMessage[]> {
    try {
      const response = await timedFetch(`${apiUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: "chat_get_history",
            arguments: {
              channel: config.channel,
              limit,
            },
          },
        }),
      });

      const result = (await response.json()) as any;
      const content = safeJsonParse(result.result?.content?.[0]?.text, {}) as any;
      return content.messages || [];
    } catch {
      return [];
    }
  }

  // Generate LLM-based summary of channel history
  async function _generateChannelSummary(ctx: PluginContext): Promise<string | null> {
    try {
      // Fetch more history for summarization (last 100 messages)
      const messages = await getChatHistory(100);
      if (messages.length < 5) return null; // Not enough history to summarize

      // Format messages for LLM
      const formattedHistory = messages
        .reverse()
        .map((msg) => {
          const sender = msg.agent_id || (msg.user === "UHUMAN" ? "Human" : msg.user);
          const text = msg.text.slice(0, 500) + (msg.text.length > 500 ? "..." : "");
          return `[${sender}]: ${text}`;
        })
        .join("\n\n");

      // Use plugin context to make LLM call if available
      if (!ctx.llmClient) {
        return generateFallbackSummary(messages);
      }

      const response = await ctx.llmClient.complete({
        model: "claude-sonnet-4.5",
        messages: [
          {
            role: "system",
            content: `You are summarizing a chat channel's history for an AI agent joining the conversation.

Create a concise summary that includes:
1. **Current Topic**: What is being discussed right now?
2. **Key Context**: Important decisions, facts, or state that the agent needs to know
3. **Active Tasks**: Any ongoing work or requests being handled
4. **Participants**: Who is involved and their roles (if clear)

Keep the summary under 500 words. Focus on actionable context, not play-by-play.
Output in plain text, no markdown headers.`,
          },
          {
            role: "user",
            content: `Summarize this channel history:\n\n${formattedHistory}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      });

      return response.choices[0]?.message?.content || null;
    } catch (err) {
      console.error("[ClawdChat] Failed to generate channel summary:", err);
      return null;
    }
  }

  // Fallback summary when LLM not available
  function generateFallbackSummary(messages: ChatMessage[]): string {
    const humanMessages = messages.filter((m) => m.user === "UHUMAN");
    const agentMessages = messages.filter((m) => m.agent_id);

    const recentTopics = humanMessages.slice(-5).map((m) => {
      const text = m.text.slice(0, 100);
      return `- ${text}${m.text.length > 100 ? "..." : ""}`;
    });

    return `Channel has ${messages.length} recent messages (${humanMessages.length} from humans, ${agentMessages.length} from agents).

Recent human requests:
${recentTopics.join("\n")}`;
  }

  function formatContextMessages(messages: ChatMessage[]): string {
    if (messages.length === 0) return "";

    // Format recent messages as context (reverse to get chronological order)
    const contextLines = messages.reverse().map((msg) => {
      const sender = msg.agent_id || (msg.user === "UHUMAN" ? "Human" : msg.user);
      return `[${sender}]: ${msg.text}`;
    });

    return `\n\n--- Recent conversation context ---\n${contextLines.join("\n\n")}\n--- End context ---\n`;
  }

  async function getNewMessages(afterTs: string): Promise<ChatMessage[]> {
    const response = await timedFetch(`${apiUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "chat_query_messages",
          arguments: {
            channel: config.channel,
            from_ts: afterTs,
            limit: 10,
          },
        },
      }),
    });

    const result = (await response.json()) as any;
    const content = safeJsonParse(result.result?.content?.[0]?.text, {}) as any;
    return content.messages || [];
  }

  async function markProcessed(ts: string): Promise<void> {
    await timedFetch(`${apiUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "chat_mark_processed",
          arguments: {
            channel: config.channel,
            timestamp: ts,
            agent_id: config.agentId,
          },
        },
      }),
    });
  }

  // Mark messages as seen (but NOT processed) - used during interrupts
  // so the UI shows messages are acknowledged without marking them as handled
  async function markAsSeen(ts: string): Promise<void> {
    try {
      await timedFetch(`${apiUrl}/api/agent.markSeen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: config.agentId,
          channel: config.channel,
          last_seen_ts: ts,
        }),
      });
    } catch {
      /* best effort */
    }
  }

  // ============================================================================
  // Interrupt Polling
  // ============================================================================

  async function pollForInterrupt(): Promise<string | null> {
    // Use currentProcessingTs to only find messages AFTER the one we're processing
    const fromTs = currentProcessingTs || lastProcessedTs;
    if (!fromTs) return null;

    try {
      const messages = await getNewMessages(fromTs);

      // Filter to only HUMAN messages that haven't been injected already
      // This prevents cascade of duplicate responses when multiple agents are active
      // and prevents re-interrupting for messages we've already seen
      const interruptingMessages = messages.filter((msg) => {
        // Only human messages can interrupt
        if (msg.user !== "UHUMAN") return false;
        // Skip messages we've already injected (prevents infinite interrupt loop)
        if (injectedTimestamps.has(msg.ts)) return false;
        return true;
      });

      if (interruptingMessages.length > 0) {
        // Update lastProcessedTs to the newest message
        const newest = interruptingMessages[interruptingMessages.length - 1];
        lastProcessedTs = newest.ts;

        // Mark the newest interrupting message as seen (not processed)
        // so the UI shows the agent has acknowledged them
        await markAsSeen(newest.ts);

        // Format all interrupting messages
        const formatted = interruptingMessages
          .map((msg) => {
            const author = msg.user === "UHUMAN" ? "human" : msg.agent_id || msg.user || "unknown";
            const chatMarker = "\n\n[TRUNCATED — message too long]";
            const truncatedText =
              msg.text && msg.text.length > 10000
                ? (() => {
                    let cp = 10000 - chatMarker.length;
                    if (
                      cp > 0 &&
                      cp < msg.text.length &&
                      msg.text.charCodeAt(cp - 1) >= 0xd800 &&
                      msg.text.charCodeAt(cp - 1) <= 0xdbff
                    )
                      cp--;
                    return msg.text.slice(0, cp) + chatMarker;
                  })()
                : msg.text || "";
            return `[ts:${msg.ts}] ${author}: ${truncatedText}`;
          })
          .join("\n\n---\n\n");

        return `## NEW PENDING MESSAGES\n\n${formatted}`;
      }
    } catch (_error) {
      // Polling error, ignore
    }

    return null;
  }

  // ============================================================================
  // Plugin Implementation
  // ============================================================================

  return {
    name: "clawd-chat",
    version: "1.0.0",
    description: "Integration with clawd-chat server for streaming and interrupts",

    // Provide clawd-chat MCP server for chat tools + any additional MCP servers from config
    getMcpServers() {
      // Workers only get tools through ToolPlugin — skip MCP to prevent scheduler tool access (S6)
      if (config.isWorker && !config.isSpaceAgent) return [];

      // Space agents get ONLY clawd-chat MCP with scope=space filter (chat_* tools only)
      if (config.isSpaceAgent) {
        return [
          {
            name: "clawd-chat",
            url: `${apiUrl}/mcp?scope=space`,
            transport: "http" as const,
          },
        ];
      }

      const servers: ReturnType<typeof getMCPServers> = getMCPServers();

      // Build MCP server list: always include clawd-chat first, then add configured servers
      const mcpServers: Array<{
        name: string;
        url?: string;
        transport?: "http" | "stdio";
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      }> = [
        {
          name: "clawd-chat",
          url: `${apiUrl}/mcp`,
          transport: "http" as const,
        },
      ];

      // Add configured MCP servers from ~/.clawd/config.json
      for (const [serverName, serverConfig] of Object.entries(servers)) {
        mcpServers.push({
          name: serverName,
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
          transport: serverConfig.transport || "stdio",
          url: serverConfig.url,
        });
      }

      return mcpServers;
    },

    hooks: {
      async onInit(_ctx: PluginContext) {
        // Initialize last processed timestamp
        lastProcessedTs = String(Date.now() / 1000);

        // Set chat config for tools (so sub-agents can auto-inherit)
        setChatApiUrl(apiUrl);
        setCurrentChannel(config.channel);
        setCurrentAgentId(config.agentId);

        // Server auto-detects sleeping based on polling activity
      },

      async onShutdown() {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        // Clear streaming state on shutdown to prevent stale indicators
        // This handles graceful shutdowns (SIGTERM, SIGINT, agent exit)
        await setAgentStreaming(false);
        // Server will auto-detect sleeping when polling stops
      },

      // Provide conversation context for system prompt
      async getSystemContext(_ctx: PluginContext): Promise<string | null> {
        try {
          // Get recent messages (last 20 for immediate context)
          // Note: LLM-based summarization disabled for now to reduce latency
          const messages = await getChatHistory(20);

          let context = "";

          // Add worker-specific instructions if this is a sub-agent or space agent
          if (config.isWorker || config.isSpaceAgent) {
            const workerId = `UWORKER-${config.agentId}`;
            context += `<worker_identity>
You are a SUB-AGENT WORKER, not the main bot.
Your worker ID is: ${workerId}
Your agent name is: ${config.agentId}
Channel: ${config.channel}

CRITICAL: When calling chat_send_message, you MUST include these EXACT parameters:
- channel: "${config.channel}"
- text: <your message>
- agent_id: "${config.agentId}"
- user: "${workerId}"

The "user" parameter is REQUIRED for worker identity. Do not omit it.
</worker_identity>

`;
          } else {
            // Main agent instructions
            context += `<chat_instructions>
You are connected to chat channel "${config.channel}" as "${config.agentId}".

IMPORTANT OUTPUT RULES:
- When you use chat_send_message to reply, do NOT produce additional conversational text output
- When you use chat_mark_processed to skip a message, respond ONLY with "[SILENT]"
- Your text output will be sent to chat if you don't use chat tools, so avoid duplicate messages
- For messages from other agents/workers that don't need a response, just mark_processed and output "[SILENT]"
- IF chat_send_message FAILS (returns ok:false or error), you MUST RETRY immediately with the same parameters

RICH CONTENT FEATURES (use with chat_send_message):
- html_preview: Include HTML content for rich visual output (charts, diagrams, formatted tables, etc.)
- code_preview: Include code snippets with syntax highlighting
  - filename: Display name (e.g., "app.ts")
  - language: Syntax highlighting language (e.g., "typescript", "python")
  - content: The code content
  - start_line (optional): Starting line number
  - highlight_lines (optional): Array of line numbers to highlight
</chat_instructions>

`;
          }

          if (messages.length > 0) {
            context += formatContextMessages(messages);
          }

          return context || null;
        } catch {
          return null;
        }
      },

      async onUserMessage(message: string, _ctx: PluginContext) {
        // Distinguish between initial prompt and interrupt-injected messages
        if (isInterruptCall) {
          // This is called from checkInterrupt -> agent's checkInterrupt -> onUserMessage
          // Do NOT reset interruptCount or other state - just update currentProcessingTs
          isInterruptCall = false; // Reset flag

          // Extract timestamps from the interrupt message and track them
          const allTs = [...message.matchAll(/\[ts:([^\]]+)\]/g)];
          if (allTs.length > 0) {
            // Update currentProcessingTs to the NEWEST timestamp in this interrupt
            const newestTs = allTs[allTs.length - 1][1];
            currentProcessingTs = newestTs;
            // Track all injected timestamps so we don't re-interrupt for them
            for (const match of allTs) {
              injectedTimestamps.add(match[1]);
            }
          }
          return;
        }

        // Reset state for new user message (initial prompt only)
        _currentMessageTs = null;
        _streamBuffer = "";
        pendingInterrupt = null;
        isProcessingMessage = true;
        interruptCount = 0;
        injectedTimestamps.clear();

        // Extract target timestamp from prompt
        // Use the LAST chat_mark_processed timestamp (the one at the bottom of the prompt,
        // not one that might appear in quoted/pasted text from the user)
        const allMarkProcessed = [...message.matchAll(/chat_mark_processed\([^)]*timestamp="([^"]+)"/g)];
        let extractedTs: string | null = null;

        if (allMarkProcessed.length > 0) {
          // Use the LAST match (the system instruction at the bottom of the prompt)
          extractedTs = allMarkProcessed[allMarkProcessed.length - 1][1];
        } else {
          // Fallback: try injected format - get the LAST timestamp (newest message)
          const allTs = [...message.matchAll(/\[ts:([^\]]+)\]/g)];
          if (allTs.length > 0) {
            extractedTs = allTs[allTs.length - 1][1];
          }
        }

        currentProcessingTs = extractedTs;

        // Also track all message timestamps mentioned in the prompt as already known
        const allTs = [...message.matchAll(/\[ts:([^\]]+)\]/g)];
        for (const match of allTs) {
          injectedTimestamps.add(match[1]);
        }

        // Server auto-detects awake status from polling
      },

      async onStreamStart(_ctx: PluginContext) {
        // Reset buffer and notify server that streaming has started
        if (isProcessingMessage) {
          _streamBuffer = "";
          // Signal streaming state to server so polling-based sync stays consistent
          // Without this, fetchAgentStreamingStatus polling clears the UI indicator
          await setAgentStreaming(true);
        }
      },

      async onStreamToken(token: string, _ctx: PluginContext) {
        // Accumulate tokens in buffer
        _streamBuffer += token;
        // Stream content token to server for real-time display
        streamToken(token, "content"); // Fire-and-forget
      },

      async onThinkingToken(token: string, _ctx: PluginContext) {
        // Stream thinking token to server for real-time display
        streamToken(token, "thinking"); // Fire-and-forget
      },

      async onStreamEnd(_content: string, _ctx: PluginContext) {
        // Just keep accumulating - final message sent in onAgentResponse
      },

      async onAgentResponse(response, _ctx: PluginContext) {
        // Filter out [SILENT] responses - agent decided to stay quiet
        const content = response.content?.trim();
        const _isSilent =
          content === "[SILENT]" ||
          content?.startsWith("[SILENT]") ||
          content?.endsWith("[SILENT]") ||
          content?.includes("\n[SILENT]");

        // DO NOT auto-send agent's text output to chat.
        // The agent should use chat_send_message tool explicitly.
        // Auto-sending causes duplicates when agent uses tool AND outputs text.

        // Mark streaming as done
        await setAgentStreaming(false);

        // Mark the message we just processed as seen (updates seen indicator)
        if (currentProcessingTs) {
          await markProcessed(currentProcessingTs);
        }

        // Reset ALL state for next user message
        _currentMessageTs = null;
        _streamBuffer = "";
        isProcessingMessage = false;
        currentProcessingTs = null;
        injectedTimestamps.clear();

        // Update last processed timestamp
        lastProcessedTs = String(Date.now() / 1000);
        // Server auto-detects sleeping based on polling activity
      },

      async checkInterrupt(_ctx: PluginContext): Promise<string | null> {
        // Don't allow more than MAX_INTERRUPTS per user message
        if (interruptCount >= MAX_INTERRUPTS) {
          return null;
        }

        // Check for pending interrupt from polling
        if (pendingInterrupt) {
          const msg = pendingInterrupt;
          pendingInterrupt = null;
          interruptCount++;
          // Set flag so onUserMessage knows this is an interrupt, not a fresh prompt
          isInterruptCall = true;
          return msg;
        }

        // Poll for new messages
        const result = await pollForInterrupt();
        if (result) {
          interruptCount++;
          // Set flag so onUserMessage knows this is an interrupt, not a fresh prompt
          isInterruptCall = true;
        }
        return result;
      },

      async transformToolArgs(name: string, args: any, _ctx: PluginContext) {
        // SP21: Space agents — force channel on ALL chat_* tools
        if (config.isSpaceAgent && name.startsWith("chat_")) {
          args = { ...args, channel: config.channel };
        }
        // Auto-inject user ID for chat_send_message when worker or space agent
        if ((config.isWorker || config.isSpaceAgent) && name === "chat_send_message") {
          return {
            ...args,
            user: userId,
          };
        }
        return args;
      },

      async onToolCall(name: string, args: any, _ctx: PluginContext) {
        // Stream tool call to chat UI
        await streamToolCall(name, args, "started");
      },

      async onToolResult(name: string, result: any, _ctx: PluginContext) {
        // Stream tool result to chat UI - use "error" status when tool failed
        const status = result && result.success === false ? "error" : "completed";
        await streamToolCall(name, {}, status, result);
      },

      async onInterrupt(message: string, _ctx: PluginContext) {
        // Stream interrupt event to chat UI
        streamToken(`[Interrupted] New message received`, "event");
      },

      async onCompaction(deleted: number, remaining: number, _ctx: PluginContext) {
        // Stream compaction event to chat UI
        const label = remaining === 0 ? "Context reset" : "Context compacted";
        streamToken(`[${label}] Removed ${deleted} messages, kept ${remaining}`, "event");
      },

      async onError(error: string, _ctx: PluginContext) {
        // Stream error event to chat UI
        streamToken(`[Error] ${error}`, "event");
      },
    },
  };
}

// ============================================================================
// Tool Plugin: Agent-side tools that run locally
// ============================================================================

/**
 * MIME type detection by file extension
 */
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

/**
 * Create a ToolPlugin that provides agent-side file upload capability.
 *
 * This tool reads files from the agent's LOCAL filesystem and uploads them
 * to the chat server via HTTP multipart POST. This is necessary because:
 * - Agent and server may run on different machines
 * - The MCP chat_upload_file tool requires base64 content as a tool argument,
 *   which causes stream timeouts for large files (the LLM must generate ~24KB
 *   of base64 tokens)
 * - This tool only requires the LLM to pass a short file path string
 */
export function createClawdChatToolPlugin(config: ClawdChatConfig): ToolPlugin {
  const apiUrl = config.apiUrl.replace(/\/$/, "");

  return {
    name: "clawd-chat-tools",

    getTools(): ToolRegistration[] {
      return [
        {
          name: "chat_upload_local_file",
          description: `Upload a file from the agent's local filesystem to the chat server.

**USE THIS INSTEAD OF chat_upload_file** when the file already exists on disk. This avoids the LLM
having to generate large base64 content as a tool argument (which causes stream timeouts).

The tool reads the file locally, auto-detects MIME type from extension, and uploads it via HTTP
to the chat server. Returns a file_id that can be used with chat_send_message_with_files.

**File Size Limit:** Max 10MB per file. For larger files, upload to a cloud service and share the link instead.

**For Images/Videos:**
- Screenshots and small images work best
- For large images: Use Gemini vision API to analyze and describe instead of uploading raw bytes
- For videos: Upload to YouTube or cloud storage and share the link

**WORKFLOW:**
1. chat_upload_local_file(file_path="/path/to/image.png", channel="chat-task") -> returns file_id
2. chat_send_message_with_files(channel="chat-task", text="Here's the file", file_ids=["F..."])

**COMPLETE EXAMPLE:**
\`\`\`
result = chat_upload_local_file(
  file_path="/path/to/screenshot.png",
  channel="chat-task"
)
// result: { ok: true, file: { id: "Fxyz123", name: "screenshot.png", ... } }

chat_send_message_with_files(
  channel="chat-task",
  text="Here's the screenshot",
  file_ids=["Fxyz123"],
  agent_id="Claw'd"
)
\`\`\``,
          parameters: {
            file_path: {
              type: "string",
              description: "Absolute path to the file on the agent's local filesystem",
            },
            channel: {
              type: "string",
              description: "Channel ID (for association)",
            },
            filename: {
              type: "string",
              description: "Display filename override (default: basename of file_path)",
            },
            mimetype: {
              type: "string",
              description: "MIME type override (default: auto-detected from extension)",
            },
          },
          required: ["file_path", "channel"],
          handler: async (args) => {
            const filePath = args.file_path as string;
            const channel = args.channel as string;

            try {
              const { existsSync, statSync, readFileSync } = await import("node:fs");
              const { basename, extname } = await import("node:path");

              // Validate file exists
              if (!existsSync(filePath)) {
                return {
                  success: false,
                  output: JSON.stringify({ ok: false, error: `File not found: ${filePath}` }),
                };
              }

              // Check it's a file (not directory)
              const stat = statSync(filePath);
              if (!stat.isFile()) {
                return {
                  success: false,
                  output: JSON.stringify({ ok: false, error: `Not a file: ${filePath}` }),
                };
              }

              // Check file size (limit to 50MB)
              const MAX_SIZE = 50 * 1024 * 1024;
              if (stat.size > MAX_SIZE) {
                return {
                  success: false,
                  output: JSON.stringify({
                    ok: false,
                    error: `File too large: ${stat.size} bytes (max ${MAX_SIZE} bytes)`,
                  }),
                };
              }

              // Determine filename and mimetype
              const displayName = (args.filename as string) || basename(filePath);
              const ext = extname(filePath).toLowerCase();
              const detectedMime = MIME_MAP[ext] || "application/octet-stream";
              const mimetype = (args.mimetype as string) || detectedMime;

              // Read file and create a Blob/File for multipart upload
              const fileBuffer = readFileSync(filePath);
              const blob = new Blob([fileBuffer], { type: mimetype });
              const file = new File([blob], displayName, { type: mimetype });

              // Upload via HTTP multipart POST to the server's /api/files.upload endpoint
              const formData = new FormData();
              formData.append("file", file);
              formData.append("channel", channel);

              const response = await timedFetch(
                `${apiUrl}/api/files.upload`,
                {
                  method: "POST",
                  body: formData,
                },
                60000,
              );

              if (!response.ok) {
                const errorText = await response.text();
                return {
                  success: false,
                  output: JSON.stringify({
                    ok: false,
                    error: `Upload failed: HTTP ${response.status} - ${errorText}`,
                  }),
                };
              }

              const result = (await response.json()) as any;

              return {
                success: result.ok === true,
                output: JSON.stringify(result, null, 2),
              };
            } catch (err: any) {
              return {
                success: false,
                output: JSON.stringify({
                  ok: false,
                  error: `Upload error: ${err.message}`,
                }),
              };
            }
          },
        },
      ];
    },
  };
}
