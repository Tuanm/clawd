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

import { timedFetch as _sharedTimedFetch } from "../../../utils/timed-fetch";
import type { ToolPlugin, ToolRegistration } from "../../tools/plugin";
import { setChatApiUrl, setCurrentAgentId, setCurrentChannel } from "../../tools/tools";
import { getContextProjectRoot } from "../../utils/agent-context";
import type { Plugin, PluginContext } from "../manager";

// Module-scoped wrapper with 15s default for chat API calls (longer than the shared 10s default
// because chat plugin calls include streaming setup and file uploads that need more headroom).
const timedFetch = (url: string, options: RequestInit = {}, ms = 15000): Promise<Response> =>
  _sharedTimedFetch(url, options, ms);

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
  let lastInterruptAt = 0; // Rate-limit: min 3s between interrupts to prevent flood loops
  const INTERRUPT_MIN_INTERVAL_MS = 3000;
  let isInterruptCall = false; // Flag to distinguish interrupt vs initial onUserMessage call
  const injectedTimestamps = new Set<string>(); // Track already-injected message timestamps
  const _channelSummary: string | null = null; // Cached channel summary
  const _summaryGeneratedAt: number | null = null; // When summary was generated

  const apiUrl = config.apiUrl.replace(/\/$/, "");
  const _pollIntervalBase = config.pollInterval || 500;
  let _pollIntervalCurrent = _pollIntervalBase;
  const _POLL_INTERVAL_MAX = 3000; // Backoff to 3s when idle
  let _lastInterruptPollAt = 0;
  const _SUMMARY_TTL = 30 * 60 * 1000; // Refresh summary every 30 minutes

  // Determine user ID based on whether this is a worker/sub-agent
  const userId = config.isWorker || config.isSpaceAgent ? `UWORKER-${config.agentId}` : "UBOT";

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

  // Batch token streaming — coalesces tokens and flushes every 50ms instead of per-token HTTP POST
  let tokenBuffer = "";
  let tokenBufferType: "content" | "thinking" | "event" = "content";
  let tokenFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const TOKEN_FLUSH_INTERVAL = 50; // ms

  async function flushTokenBuffer(): Promise<void> {
    if (!tokenBuffer) return;
    const batch = tokenBuffer;
    const batchType = tokenBufferType;
    tokenBuffer = "";
    try {
      await timedFetch(`${apiUrl}/api/agent.streamToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: config.agentId,
          channel: config.channel,
          token: batch,
          token_type: batchType,
        }),
      });
    } catch {
      // Ignore errors - streaming tokens are best-effort
    }
  }

  async function streamToken(token: string, tokenType: "content" | "thinking" | "event" = "content"): Promise<void> {
    // Event tokens flush immediately (they're infrequent and important)
    if (tokenType === "event") {
      await flushTokenBuffer();
      tokenBuffer = token;
      tokenBufferType = "event";
      await flushTokenBuffer();
      return;
    }
    // If type changed, flush the old buffer first
    if (tokenBufferType !== tokenType && tokenBuffer) {
      await flushTokenBuffer();
    }
    tokenBufferType = tokenType;
    tokenBuffer += token;
    // Schedule flush if not already pending
    if (!tokenFlushTimer) {
      tokenFlushTimer = setTimeout(async () => {
        tokenFlushTimer = null;
        await flushTokenBuffer();
      }, TOKEN_FLUSH_INTERVAL);
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

    // Provide clawd-chat MCP server for chat tools
    // Channel-scoped MCP servers are handled by WorkerManager via sharedMcpManager
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

      return [
        {
          name: "clawd-chat",
          url: `${apiUrl}/mcp`,
          transport: "http" as const,
        },
      ];
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

When calling chat_send_message, only "text" is required — channel, agent_id, and user are auto-injected.
Humans CANNOT see your text output — ALWAYS use chat_send_message for ALL responses.
Do NOT output text intended for users — it will never reach them.
When providing copiable content (commands, code, URLs, paths, config values), ALWAYS wrap it in a markdown code block — users can only copy via the Copy button on code blocks.
CLAWD.md in the project root is your long-term memory (auto-loaded into your system prompt). Save important information there to remember across sessions. Use docs/, reports/, or plans/ for less critical info.
If memo_* tools are available, use them to save/recall important facts, decisions, and lessons. Your memories persist across sessions and are scoped to you.
The chat UI renders <artifact> tags as visual cards. Use them for rich content (HTML, charts, tables, code, diagrams).
</worker_identity>

`;
          } else {
            // Main agent instructions
            context += `<chat_instructions>
You are connected to chat channel "${config.channel}" as "${config.agentId}".

IMPORTANT OUTPUT RULES:
- Humans CANNOT see your text output — they can ONLY see messages sent via chat_send_message
- ALWAYS use chat_send_message for ALL replies to users
- Do NOT output text intended for users — it will never reach them
- When you use chat_mark_processed to skip a message, output only "[SILENT]"
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

COPYABLE CONTENT RULE:
- The chat UI does NOT allow users to select and copy text from messages
- Users can ONLY copy content by clicking the Copy button on code blocks
- Therefore, whenever you provide content the user may want to copy (commands, code snippets, URLs, file paths, config values, etc.), you MUST wrap it in a markdown code block (triple backticks) so the Copy button appears
- Even single-line commands or short values should use code blocks if the user might need to copy them

ARTIFACTS — use <artifact type="T"> tags. No nesting. Don't use artifacts when plain text suffices.
Types: interactive (tables/charts/forms/polls/dashboards — PREFERRED for data), html (full pages), react (custom UIs, has Tailwind), svg, code, csv, markdown. For data display ALWAYS use interactive, not chart.

INTERACTIVE ARTIFACTS — \`<artifact type="interactive">\`
Components: text(content:md), image(src,alt), table(headers[],rows[][]), chart(spec:{type,data,xKey,series}), divider, button(id,label,value,style?), button_group(id,buttons[{label,value}]), radio_group(id,label,options[{label,value}]), select(id,label,options[],hint?), text_input(id,label,placeholder?,multiline?,hint?), number_input(id,label,min?,max?,step?), checkbox(id,label,hint?), toggle(id,label), slider(id,label,min,max,step?,unit?), rating(id,max?), date_picker(id,label), tabs(id,tabs[{label,value}]), submit(label,style?) — only submit fires to server.
Examples:
  Table: { "components": [{ "type": "table", "headers": ["Name","Score"], "rows": [["Alice","95"],["Bob","87"]] }], "one_shot": false }
  Form: { "components": [{ "type": "select", "id": "env", "label": "Env", "options": [{"label":"Prod","value":"prod"}] }, { "type": "submit", "label": "Deploy" }], "on_action": { "type": "agent" }, "one_shot": true }
  Dashboard: { "components": [{ "type": "slider", "id": "min", "label": "Min", "min": 0, "max": 500 }, { "type": "chart", "spec": { "type": "bar", "data": [...], "xKey": "month", "series": [{"key": "sales"}] } }], "one_shot": false }
Handlers: store (save), message (template:"{{value}}" — posts as user message, use for quick-reply options), agent (re-invoke), custom_script (tool_id + args_template REQUIRED, runs .clawd/tools/ script — NOT built-in tools)
  Quick-reply (no submit needed): { "components": [{ "type": "button_group", "id": "choice", "buttons": [{"label":"Option A","value":"a"},{"label":"Option B","value":"b"}] }], "on_action": { "type": "message", "template": "{{choice}}" } }
  → User clicks "Option A" → "Option A" posted as user message instantly (label resolved). Form disables. Use for offering choices the user should "say".
Datasource: chart/table can ref files — { "datasource": { "type":"file", "file_id":"Fxyz", "filters": { "col": {"gte":"{{slider_id}}"} }, "sort": {"field":"col","order":"desc"}, "limit": 100 } }. {{id}} refs substituted live. Supports CSV/TSV/JSON.
Rules: one_shot:true disables after submit. Omit submit for always-interactive. Use datasource for dynamic/large data, inline for small/static.
React+bridge: \`<artifact type="react">\` with ClauwdBridge.sendAction(id,val)→Promise. Only when interactive primitives insufficient.

LONG-TERM MEMORY:
- CLAWD.md in the project root is your persistent memory — its content is automatically loaded into your system prompt every session
- Save important information you want to remember long-term into CLAWD.md: key decisions, user preferences, project conventions, critical context, lessons learned, architecture notes
- Keep CLAWD.md concise and well-organized — it is your primary memory, not a dump
- For less critical information (research, reports, detailed plans), use docs/, reports/, or plans/ directories instead
- If memo_* tools or identity_update are available, use them to save/recall important facts, decisions, preferences, and lessons — your memories persist across sessions and are scoped to you
- You can refine your own role/personality by using identity_update (if available) based on your experience
</chat_instructions>

`;
          }

          if (messages.length > 0) {
            context += formatContextMessages(messages);
          }

          // Inject active sub-agent reminder (only when agents are running)
          try {
            const agentRes = await timedFetch(`${apiUrl}/mcp`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: Date.now(),
                method: "tools/call",
                params: { name: "list_agents", arguments: { channel: config.channel } },
              }),
            });
            const agentData = safeJsonParse(((await agentRes.json()) as any)?.result?.content?.[0]?.text, {}) as any;
            const activeCount = (agentData?.agents ?? []).filter((a: any) => a.status === "active").length;
            if (activeCount > 0) {
              context += `\n<system-reminder>${activeCount} sub-agent${activeCount > 1 ? "s are" : " is"} currently running in this channel. They will report back when done — do not start work that overlaps their tasks.</system-reminder>\n`;
            }
          } catch {
            /* best-effort — skip on error */
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
        // Flush any remaining batched tokens
        if (tokenFlushTimer) {
          clearTimeout(tokenFlushTimer);
          tokenFlushTimer = null;
        }
        await flushTokenBuffer();
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

        // Mark the message as processed — but skip on error responses so the
        // seenNotProcessed continuation mechanism can retry on next poll cycle
        if (currentProcessingTs) {
          const responseContent = response.content?.trim() || "";
          const isErrorResponse =
            responseContent.includes("[Agent stopped") || responseContent.includes("[stream error");
          if (!isErrorResponse) {
            try {
              await markProcessed(currentProcessingTs);
              // Update local timestamp only when server confirmed
              lastProcessedTs = String(Date.now() / 1000);
            } catch (err) {
              console.error(`[clawd-chat] markProcessed failed: ${err}`);
            }
          } else {
            console.log("[clawd-chat] Skipping markProcessed — error response detected, enabling continuation retry");
          }
        }

        // Reset ALL state for next user message
        _currentMessageTs = null;
        _streamBuffer = "";
        isProcessingMessage = false;
        currentProcessingTs = null;
        injectedTimestamps.clear();
        _pollIntervalCurrent = _pollIntervalBase; // Reset polling backoff for next message
        // Server auto-detects sleeping based on polling activity
      },

      async checkInterrupt(_ctx: PluginContext): Promise<string | null> {
        // Rate-limit interrupts to prevent flood loops (min 3s between interrupts)
        const now = Date.now();
        if (lastInterruptAt && now - lastInterruptAt < INTERRUPT_MIN_INTERVAL_MS) {
          return null;
        }

        // Check for pending interrupt from polling
        if (pendingInterrupt) {
          const msg = pendingInterrupt;
          pendingInterrupt = null;
          interruptCount++;
          lastInterruptAt = now;
          _pollIntervalCurrent = _pollIntervalBase; // Reset backoff on interrupt
          isInterruptCall = true;
          return msg;
        }

        // Adaptive polling: skip if too soon since last poll
        if (now - _lastInterruptPollAt < _pollIntervalCurrent) {
          return null;
        }
        _lastInterruptPollAt = now;

        // Poll for new messages
        const result = await pollForInterrupt();
        if (result) {
          interruptCount++;
          lastInterruptAt = Date.now();
          _pollIntervalCurrent = _pollIntervalBase; // Reset backoff on interrupt
          // Set flag so onUserMessage knows this is an interrupt, not a fresh prompt
          isInterruptCall = true;
        } else {
          // No interrupt — back off polling interval
          _pollIntervalCurrent = Math.min(_pollIntervalCurrent * 2, _POLL_INTERVAL_MAX);
        }
        return result;
      },

      async transformToolArgs(name: string, args: any, _ctx: PluginContext) {
        // Auto-inject channel + agent_id on ALL chat_* tools (for ALL agent types)
        // LLM can omit these params — they're filled from plugin config
        if (name.startsWith("chat_") || name.startsWith("schedule_")) {
          if (!args.channel) args = { ...args, channel: config.channel };
          if (!args.agent_id) args = { ...args, agent_id: config.agentId };
        }
        // Auto-inject user ID for chat_send_message (all agent types)
        if (name === "chat_send_message" && !args.user) {
          args = { ...args, user: userId };
        }
        // Auto-inject project root for tools that need to save files locally
        if (name === "chat_download_file" || name === "convert_to_markdown") {
          // Use original project root for .clawd/files/ — not worktree path
          const { getContextConfigRoot } = require("../../utils/agent-context");
          const configRoot = getContextConfigRoot();
          if (configRoot) {
            args = { ...args, _project_root: configRoot };
          }
        }
        return args;
      },

      async onToolCall(name: string, args: any, _ctx: PluginContext) {
        // Refresh streaming heartbeat so stale-streaming cleanup doesn't clear us during long tool executions
        setAgentStreaming(true).catch(() => {});
        // Stream tool call to chat UI
        await streamToolCall(name, args, "started");
      },

      async onToolResult(name: string, result: any, _ctx: PluginContext) {
        // Stream tool result to chat UI - use "error" status when tool failed
        const status = result && result.success === false ? "error" : "completed";
        // Extract formatted text from ToolResult to avoid sending raw {success,output,error} JSON
        const resultText =
          result && typeof result === "object"
            ? result.success === false
              ? result.error || result.output || "Unknown error"
              : result.output || ""
            : result;
        await streamToolCall(name, {}, status, resultText);
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
                  output: JSON.stringify({
                    ok: false,
                    error: `File not found: ${filePath}`,
                  }),
                };
              }

              // Check it's a file (not directory)
              const stat = statSync(filePath);
              if (!stat.isFile()) {
                return {
                  success: false,
                  output: JSON.stringify({
                    ok: false,
                    error: `Not a file: ${filePath}`,
                  }),
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
