/**
 * Bridge summary: generate a conversation summary for an agent on risky config
 * change (provider family swap, model change, cwd/agent_type change) so the
 * fresh session doesn't suffer amnesia.
 *
 * Design rationale: when we clear `claude_code_session_id` to avoid cross-
 * provider/model session incompatibilities (e.g. thinking-signature mismatch,
 * cwd mismatch), the agent would otherwise restart with ZERO knowledge of
 * prior turns. The main-worker already injects any existing summary via
 *   <prior_conversation_summary>...</prior_conversation_summary>
 * in the system prompt — but summaries only get generated when the session
 * crosses the compaction threshold (100k tokens). A young conversation below
 * threshold has no summary, so clearing the CC session = amnesia.
 *
 * This module forces a one-shot summary BEFORE the CC session is cleared,
 * without deleting the underlying rows. That way:
 *   - next turn's system prompt carries the gist forward
 *   - rows survive, so if the agent later switches to a provider that uses
 *     the legacy preamble path (full history), fidelity is intact.
 */

import { generateConversationSummary } from "./summarizer";
import { getSessionManager, type SessionManager, type StoredMessage } from "./manager";

/** Format stored rows into line-oriented text suitable for LLM summarization.
 *  Mirrors the formatting in main-worker.ts `maybeCompactSession` so the
 *  summarizer sees a consistent view regardless of which path invoked it. */
export function formatRowsForSummary(rows: StoredMessage[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const content = (row.content || "").trim();
    if (!content) {
      // Tool-use-only assistant rows have empty content but a tool_calls field.
      if (row.role === "assistant" && row.tool_calls) {
        lines.push(`[you]: (used tools)`);
      }
      continue;
    }
    if (content.startsWith("[CONTEXT SUMMARY")) {
      // Prior summary — feed it forward so the new summary incorporates it.
      lines.push(content);
    } else if (content.startsWith("[CC-Turn]:")) {
      // Legacy structured turn row — strip marker.
      const inner = content.slice("[CC-Turn]:".length).trim();
      if (inner) lines.push(inner);
    } else if (content.startsWith("[Sent to chat]:") || content.startsWith("[Actions taken]:")) {
      lines.push(`[you]: ${content.slice(0, 600)}`);
    } else if (row.role === "assistant") {
      lines.push(`[you]: ${content.slice(0, 600)}`);
    } else if (row.role === "tool") {
      lines.push(`[tool-result]: ${content.replace(/\s+/g, " ").slice(0, 400)}`);
    } else if (row.role === "user") {
      lines.push(`[user]: ${content.replace(/\s+/g, " ").slice(0, 400)}`);
    }
  }
  return lines;
}

/**
 * Canonical per-agent session name used by both CC and non-CC workers.
 * Kept here (rather than importing from workers) to avoid worker→server
 * import cycles; worker code references its own copy via `get sessionName`.
 */
export function agentSessionName(channel: string, agentId: string): string {
  return `${channel}-${agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

/**
 * Generate and persist a bridge summary for the agent's session. Safe to call
 * repeatedly — each call replaces the previous summary. Safe to call on
 * sessions with no real content — returns false without invoking the LLM.
 *
 * Returns true on success. On LLM failure returns false and leaves the
 * existing summary (if any) intact — the caller should usually NOT proceed
 * to clear the CC session on failure, since doing so would still produce
 * amnesia.
 */
export async function bridgeConversationSummary(
  channel: string,
  agentId: string,
  model: string | undefined,
  opts: {
    /** Inject a SessionManager (tests) — defaults to the global singleton. */
    _manager?: SessionManager;
    /** Inject a summarizer (tests) — defaults to generateConversationSummary. */
    _summarize?: (text: string, count: number, model?: string) => Promise<string>;
  } = {},
): Promise<boolean> {
  const manager = opts._manager ?? getSessionManager();
  const summarize = opts._summarize ?? generateConversationSummary;
  const sessionName = agentSessionName(channel, agentId);
  const session = manager.getSession(sessionName);
  if (!session) return false;

  const rows = manager.getAllStoredMessages(session.id);
  // Skip empty sessions and sessions whose only content is a prior summary.
  const realRows = rows.filter((r) => r.created_at > 0 && ((r.content || "").trim() || r.tool_calls));
  if (realRows.length === 0) return false;

  const lines = formatRowsForSummary(rows);
  if (lines.length === 0) return false;

  try {
    const summary = await summarize(lines.join("\n"), rows.length, model);
    if (!summary || !summary.trim()) return false;
    manager.setConversationSummary(session.id, summary);
    return true;
  } catch (err) {
    // Don't re-throw — the caller decides what to do on failure. Log here so
    // operators can correlate LLM errors with transition events.
    console.error(`[bridge-summary] Failed for ${channel}:${agentId}:`, err);
    return false;
  }
}
