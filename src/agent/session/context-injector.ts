/**
 * Context Injector
 *
 * Builds a compact conversation-history preamble from the Claw'd SQLite session
 * store for injection into fresh CC sessions.
 *
 * This replaces ~/.claude/projects/ session continuity with a controlled,
 * token-reduced context window managed entirely by SessionManager, so each CC
 * turn starts fresh while still having access to recent conversation history.
 */

import { getSessionManager, type SessionManager } from "./manager";

// Matches lines formatted by main-worker's formatMessageLine():
// "[timestamp] username: text"
// Supports both integer ms timestamps (1705001234567) and dot-notation (1705001234.567890)
const MSG_LINE_RE = /^\[([\d.]+)\]\s+(\S+):\s+(.+)$/;

// ============================================================================
// Types
// ============================================================================

export interface ContextPreambleOpts {
  /** Max number of recent DB rows to read (default: 50). Each row may expand to many lines. */
  maxMessages?: number;
  /** Max chars per stored message before smart-truncation (default: 8000) */
  maxContentLength?: number;
  /** Estimated-token threshold that triggers autoCompact (default: 100_000) */
  maxTokensBeforeCompact?: number;
  /** Messages to keep after compaction (default: 50) */
  keepCountAfterCompact?: number;
  /**
   * Hard cap on total extracted lines in the preamble (default: 200).
   * Prevents unbounded growth when a single LLM turn contains many chat messages.
   * Most-recent lines are kept when the cap is applied.
   */
  maxLines?: number;
  /**
   * Skip the built-in autoCompact call entirely.
   * Use this when the caller manages compaction externally (e.g. main-worker
   * does async LLM-based compaction before calling buildContextPreamble).
   */
  disableAutoCompact?: boolean;
  /**
   * The agent's own ID. Used to label assistant turns accurately instead of
   * the generic "Assistant" tag. Also important in multi-agent channels where
   * other agents' messages appear inside the user-role prompt blobs.
   */
  agentId?: string;
  /**
   * Override the SessionManager instance (for testing only).
   * Production code leaves this undefined to use the default singleton.
   */
  _manager?: SessionManager;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Expand a single stored session message into one or more labelled lines.
 *
 * Storage format:
 *   role='user'      → full formatted prompt blob — contains all channel
 *                      participants' lines, a header, and a REMINDER footer
 *   role='assistant' → EITHER "[Sent to chat]: <text>" (visible response)
 *                              "[Actions taken]: <tool list>" (tool-only turn)
 *                              raw streaming text (skipped — noisy, UI-only)
 *
 * Compaction summary rows (content starts with "[CONTEXT SUMMARY") are
 * rendered as a [System] block.
 *
 * @param seenTimestamps  Set of message timestamps already emitted. Lines whose
 *   ts is in this set are skipped to prevent duplicate entries when the same
 *   channel messages appear in consecutive retry polls.
 */
function expandMessage(
  role: string,
  content: string,
  agentLabel: string,
  isSummaryRow: boolean,
  seenTimestamps: Set<string>,
): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  // Compaction summary row — strip the storage marker and render the LLM
  // summary content cleanly. The "[CONTEXT SUMMARY - N messages compacted]"
  // line is an implementation artifact; the agent only needs the bullet-point
  // content that follows it.
  if (isSummaryRow) {
    const markerMatch = /^\[CONTEXT SUMMARY - (\d+) older messages compacted\]\s*/i.exec(trimmed);
    if (markerMatch) {
      const count = markerMatch[1];
      const body = trimmed.slice(markerMatch[0].length).trim();
      const label = `[Context summary — ${count} messages]`;
      return body ? [`${label}:\n${body}`] : [label];
    }
    return [`[Context summary]: ${trimmed}`];
  }

  if (role === "assistant") {
    // [CC-Turn] rows are pre-formatted structured turn logs containing [Thought],
    // [Action]+Output, and plain message lines — pass through directly as-is.
    if (trimmed.startsWith("[CC-Turn]:")) {
      const inner = trimmed.slice("[CC-Turn]:".length).trim();
      return inner ? inner.split("\n").filter((l) => l.trim()) : [];
    }

    // Legacy rows (non-CC agents): surface [Sent to chat] and [Actions taken] only.
    // Raw streaming text blobs (no prefix) are skipped — verbose, UI-only.
    const prefix = trimmed.startsWith("[Sent to chat]:")
      ? "[Sent to chat]:"
      : trimmed.startsWith("[Actions taken]:")
        ? "[Actions taken]:"
        : null;
    if (!prefix) return [];

    const text = trimmed.slice(prefix.length).trim();
    return text ? [`[${agentLabel}]: ${text}`] : [];
  }

  // role='user': extract individual [timestamp] sender: text lines.
  // Also handles two special sections embedded in certain prompts:
  //   • [WAKEUP]/[ONBOARDING] prior-conversation blocks — lines formatted as
  //     "sender: text" (no timestamp) between "--- Prior conversation ---" markers
  //   • Regular timestamped lines matching MSG_LINE_RE
  // Boilerplate (channel headers, REMINDER footer) is silently skipped.

  // Extract wakeup/onboarding prior-conversation block if present.
  // Lines inside are "sender: text" without timestamps — we emit them as
  // [System context] so the agent retains what happened while it was sleeping.
  const priorConvoMatch = /--- Prior conversation ---\n([\s\S]*?)\n--- End of prior conversation ---/i.exec(trimmed);
  const wakeupLines: string[] = [];
  if (priorConvoMatch) {
    const block = priorConvoMatch[1];
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      // Detect "sender: text" lines (no timestamp brackets)
      const senderMatch = /^([a-zA-Z0-9_-]+):\s+(.+)$/.exec(line);
      if (senderMatch) {
        const [, sender, text] = senderMatch;
        // Normalize to lowercase so wakeup labels match regular channel labels
        // (wakeup summary uses "Human" capital, channel uses "human" lowercase)
        wakeupLines.push(`[${sender.toLowerCase()}]: ${text.trim()}`);
      }
    }
  }

  const extracted: string[] = [];
  if (wakeupLines.length > 0) {
    // Deduplicate: the wakeup prompt may be retried and appear in multiple DB rows.
    // Use a sentinel key so only the first occurrence is emitted.
    const wakeupKey = "wakeup:prior_conversation";
    if (!seenTimestamps.has(wakeupKey)) {
      seenTimestamps.add(wakeupKey);
      extracted.push(`[System context — while sleeping]:\n${wakeupLines.join("\n")}`);
    }
  }

  for (const raw of trimmed.split("\n")) {
    const line = raw.trim();
    const match = MSG_LINE_RE.exec(line);
    if (!match) continue;
    const [, ts, sender, text] = match;

    // Deduplicate: skip lines whose timestamp+sender was already emitted from a
    // prior turn's prompt (happens when a message is seen-but-not-processed
    // and carried into the next poll's prompt).
    // Composite key on ts+sender prevents same-ms messages from different
    // agents in multi-agent channels silently dropping one another.
    const dedupKey = `${ts}:${sender}`;
    if (seenTimestamps.has(dedupKey)) continue;
    seenTimestamps.add(dedupKey);

    const snippet = text.replace(/\[truncated\]$/, "").trim();
    if (!snippet) continue;
    const label = sender === "human" ? "human" : sender;
    extracted.push(`[${ts}] ${label}: ${snippet}`);
  }

  // Fallback for plain-text content (no formatted lines found) — used by
  // non-CC callers and tests that store raw text rather than formatted prompts.
  if (extracted.length === 0) {
    return [`[Human]: ${trimmed}`];
  }

  return extracted;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Builds a compact conversation-history preamble string from the SQLite session.
 *
 * Returns an empty string when the session is new or has no usable messages,
 * so callers can safely skip injection with a simple truthiness check.
 *
 * Side-effect: may compact the session in-place if it exceeds maxTokensBeforeCompact.
 */
export function buildContextPreamble(sessionName: string, opts: ContextPreambleOpts = {}): string {
  // Guard against empty session name — an empty prefix in getSession() would
  // match every row (LIKE '%') and silently inject the wrong session's history.
  if (!sessionName) return "";

  const {
    maxMessages = 50,
    maxContentLength = 8000,
    maxTokensBeforeCompact = 100_000,
    keepCountAfterCompact = 50,
    maxLines = 200,
    disableAutoCompact = false,
    agentId,
    _manager,
  } = opts;

  const agentLabel = agentId || "Assistant";

  try {
    const manager = _manager ?? getSessionManager();

    const session = manager.getSession(sessionName);
    if (!session) return "";

    if (!disableAutoCompact) {
      manager.autoCompact(sessionName, maxTokensBeforeCompact, keepCountAfterCompact);
    }

    const messages = manager.getRecentMessagesCompact(session.id, maxMessages, maxContentLength);
    if (messages.length === 0) return "";

    const lines: string[] = [];
    const seenTimestamps = new Set<string>();

    for (const msg of messages) {
      const content = msg.content?.trim() ?? "";
      if (!content) continue;
      const isSummaryRow = content.startsWith("[CONTEXT SUMMARY");
      const expanded = expandMessage(msg.role, content, agentLabel, isSummaryRow, seenTimestamps);
      lines.push(...expanded);
    }

    if (lines.length === 0) return "";

    // Apply hard line cap — keep the most recent lines when over limit
    const capped = lines.length > maxLines ? lines.slice(-maxLines) : lines;

    return [
      "<conversation_history>",
      "Recent conversation history (use as context for the current turn):",
      "",
      capped.join("\n"),
      "</conversation_history>",
    ].join("\n");
  } catch (err) {
    console.error("[context-injector] Failed to build preamble:", err);
    return "";
  }
}
