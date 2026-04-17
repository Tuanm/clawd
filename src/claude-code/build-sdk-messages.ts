/**
 * Build an AsyncIterable of SDK messages for a CC agent turn.
 *
 * Each turn, instead of a single big prompt string, we feed the CC SDK an
 * iterable of role-structured messages:
 *
 *   • role:"user"     — channel messages (human, other agents, sub-agents, system),
 *                       content formatted as "[timestamp] author: text"
 *   • role:"user"     — tool_result blocks for prior tool_use calls
 *   • role:"assistant" — agent X's own LLM output (text + tool_use blocks)
 *
 * The CC SDK accepts `AsyncIterable<SDKUserMessage>` on the `prompt` argument,
 * but the runtime also honours `type:"assistant"` objects on the same channel
 * (the SDK schema accepts both roles, and the ProcessTransport forwards them
 * verbatim to the CLI subprocess). We cast via `as any` where needed.
 *
 * Agent X's OWN messages stay as ordinary assistant messages — this is a normal
 * Claude Code session, the only twist is that channel messages from non-X
 * sources get injected as attributed user messages.
 */

import type { SessionManager, StoredMessage } from "../agent/session/manager";
import { getSessionManager } from "../agent/session/manager";

// ============================================================================
// Types
// ============================================================================

/** A single content block inside an assistant or user message. */
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/** Shape accepted by the SDK's AsyncIterable input channel. We cast to `any`
 *  at the call site because the public type only names `SDKUserMessage`, but
 *  the SDK internally discriminates on `.type` and forwards both shapes. */
interface SdkStreamMessage {
  type: "user" | "assistant";
  message: {
    role: "user" | "assistant";
    content: ContentBlock[];
  };
  parent_tool_use_id: null;
  session_id: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Prefix that identifies legacy pre-refactor rows. They are skipped when
 *  rebuilding the message stream — a clean break after upgrade. */
const LEGACY_ASSISTANT_PREFIXES = ["[CC-Turn]:", "[Sent to chat]:", "[Actions taken]:"] as const;

function isLegacyRow(row: StoredMessage): boolean {
  if (row.role !== "assistant") return false;
  const c = row.content ?? "";
  return LEGACY_ASSISTANT_PREFIXES.some((p) => c.startsWith(p));
}

/** Compaction summary rows are stored with created_at=0 and go into the system
 *  prompt, not the message stream. Skip them when building SDK messages. */
function isCompactionSummaryRow(row: StoredMessage): boolean {
  return row.created_at === 0 || (row.content ?? "").startsWith("[CONTEXT SUMMARY");
}

function safeJsonParse<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Convert a stored assistant row back into an assistant SDK message with
 *  interleaved text + tool_use blocks, matching how the SDK originally
 *  emitted it during the prior turn. */
function rowToAssistantMessage(row: StoredMessage, sessionId: string): SdkStreamMessage {
  const blocks: ContentBlock[] = [];
  const text = (row.content ?? "").trim();
  if (text.length > 0) {
    blocks.push({ type: "text", text });
  }
  const toolCalls = safeJsonParse<Array<{ id: string; function: { name: string; arguments: string } }>>(row.tool_calls);
  if (toolCalls) {
    for (const tc of toolCalls) {
      const input = safeJsonParse<unknown>(tc.function.arguments) ?? {};
      blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }
  return {
    type: "assistant",
    message: { role: "assistant", content: blocks },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/** Convert a stored tool-result row into a user message carrying one tool_result block. */
function rowToToolResultMessage(row: StoredMessage, sessionId: string): SdkStreamMessage | null {
  if (!row.tool_call_id) return null;
  const content = row.content ?? "";
  // Anthropic expects is_error to be set when the tool failed. We treat any
  // content starting with "Error:" as an error result — this matches the
  // heuristic used elsewhere in the CC agent.
  const isError = content.startsWith("Error:");
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: row.tool_call_id, content, is_error: isError || undefined }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/** Convert a stored user-role (channel-message) row into a user SDK message.
 *  Content is already formatted as "[ts] author: text" by the writer. */
function rowToUserTextMessage(row: StoredMessage, sessionId: string): SdkStreamMessage | null {
  const text = (row.content ?? "").trim();
  if (!text) return null;
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

// ============================================================================
// Orphan tool_use filler
// ============================================================================

/**
 * Anthropic requires every assistant `tool_use` to be followed by a user
 * `tool_result` with the matching id. A crash or interrupt mid-tool-execution
 * can leave orphan tool_use blocks in the persisted history — on rebuild the
 * API would reject the request.
 *
 * This pass walks the emitted messages and, for any assistant tool_use not
 * matched by a later tool_result, injects a synthetic filler tool_result
 * ({is_error:true}) to satisfy the pairing invariant. The filler is merged
 * INTO the immediately-following user message (if present) rather than
 * emitted as a standalone — keeps tool_results for a given assistant batch
 * contiguous in a single user message, which the Anthropic Messages API
 * expects (the stricter reading of the protocol).
 */
function repairToolUsePairing(messages: SdkStreamMessage[]): SdkStreamMessage[] {
  // Pass 1: collect all resolved tool_result ids.
  const resolvedIds = new Set<string>();
  for (const m of messages) {
    if (m.message.role !== "user") continue;
    for (const block of m.message.content) {
      if (block.type === "tool_result") resolvedIds.add(block.tool_use_id);
    }
  }

  // Pass 2: walk messages; after an assistant with orphan tool_use blocks,
  // prepend filler tool_results to the next user message (merging), or emit
  // a standalone user message if no user follows (e.g. end-of-stream).
  const out: SdkStreamMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    out.push(m);
    i++;

    if (m.message.role !== "assistant") continue;

    const fillers: ContentBlock[] = [];
    for (const block of m.message.content) {
      if (block.type === "tool_use" && !resolvedIds.has(block.id)) {
        fillers.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "[interrupted — no result recorded]",
          is_error: true,
        });
        resolvedIds.add(block.id);
      }
    }
    if (fillers.length === 0) continue;

    // If the next message is a user message, merge fillers into its content
    // (fillers first so tool_results for this assistant are contiguous).
    if (i < messages.length && messages[i].message.role === "user") {
      const nextUser = messages[i];
      out.push({
        ...nextUser,
        message: {
          role: "user",
          content: [...fillers, ...nextUser.message.content],
        },
      });
      i++;
    } else {
      out.push({
        type: "user",
        message: { role: "user", content: fillers },
        parent_tool_use_id: null,
        session_id: m.session_id,
      });
    }
  }
  return out;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Read stored rows for the session and emit an AsyncIterable of SDK messages
 * suitable for `query({ prompt: thisIterable })`.
 *
 * Skips legacy [CC-Turn]/[Sent to chat]/[Actions taken] rows from pre-refactor
 * sessions (clean break — those history items are not re-rendered into the
 * new format). Repairs orphan tool_use blocks from crash/interrupt so the API
 * pairing invariant holds.
 */
export async function* buildSdkMessages(
  sessionName: string,
  opts: { _manager?: SessionManager } = {},
): AsyncIterable<unknown> {
  const manager = opts._manager ?? getSessionManager();
  const session = manager.getSession(sessionName);
  if (!session) return;

  // Raw rows, chronological. We expose StoredMessage via the manager so the
  // loader doesn't double-parse tool_calls JSON here.
  const rows = manager.getAllStoredMessages(session.id);

  const messages: SdkStreamMessage[] = [];
  for (const row of rows) {
    if (isLegacyRow(row)) continue;
    if (isCompactionSummaryRow(row)) continue;
    if (row.role === "assistant") {
      messages.push(rowToAssistantMessage(row, session.id));
    } else if (row.role === "tool" || (row.role === "user" && row.tool_call_id)) {
      const m = rowToToolResultMessage(row, session.id);
      if (m) messages.push(m);
    } else if (row.role === "user") {
      const m = rowToUserTextMessage(row, session.id);
      if (m) messages.push(m);
    }
  }

  const repaired = repairToolUsePairing(messages);
  for (const m of repaired) {
    yield m;
  }
}

/** Test-only: synchronous collection of the iterable's output. */
export async function collectSdkMessages(
  sessionName: string,
  opts: { _manager?: SessionManager } = {},
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const m of buildSdkMessages(sessionName, opts)) out.push(m);
  return out;
}

/**
 * Build the SDK prompt iterable for a CC turn, optionally appending an inline
 * heartbeat message at the end.
 *
 * Heartbeats are intentionally NOT persisted (they're ephemeral wake signals,
 * not conversation content). This helper appends the heartbeat text as an
 * extra user-role message on the iterable so the agent sees it this turn
 * without polluting future turns' rebuilt history.
 *
 * The heartbeat's session_id MUST match the session UUID used by
 * buildSdkMessages — otherwise the SDK could receive messages with mixed
 * session ids on the same iterable. We resolve both through the same
 * `getSession().id` lookup (with a fallback to the session name if the
 * session somehow doesn't exist, which shouldn't happen after
 * initMemorySession).
 */
export async function* buildSdkPromptWithHeartbeat(
  sessionName: string,
  heartbeatText?: string | null,
  opts: { _manager?: SessionManager } = {},
): AsyncIterable<unknown> {
  const manager = opts._manager ?? getSessionManager();
  const sessionUuid = manager.getSession(sessionName)?.id ?? sessionName;

  for await (const m of buildSdkMessages(sessionName, { _manager: manager })) yield m;

  if (heartbeatText) {
    yield {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: heartbeatText }] },
      parent_tool_use_id: null,
      session_id: sessionUuid,
    };
  }
}
