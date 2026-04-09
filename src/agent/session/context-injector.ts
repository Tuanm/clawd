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

import { type SessionManager, getSessionManager } from "./manager";

// ============================================================================
// Types
// ============================================================================

export interface ContextPreambleOpts {
  /** Max number of recent messages to include (default: 30) */
  maxMessages?: number;
  /** Max chars per message content before smart-truncation (default: 6000) */
  maxContentLength?: number;
  /** Estimated-token threshold that triggers autoCompact (default: 50_000) */
  maxTokensBeforeCompact?: number;
  /** Messages to keep after compaction (default: 30) */
  keepCountAfterCompact?: number;
  /**
   * Override the SessionManager instance (for testing only).
   * Production code leaves this undefined to use the default singleton.
   */
  _manager?: SessionManager;
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
    maxMessages = 30,
    maxContentLength = 6000,
    maxTokensBeforeCompact = 50_000,
    keepCountAfterCompact = 30,
    _manager,
  } = opts;

  try {
    const manager = _manager ?? getSessionManager();

    const session = manager.getSession(sessionName);
    if (!session) return "";

    // Apply token reduction before reading — keeps the preamble lean even as
    // the session grows. autoCompact is a no-op when under the threshold.
    manager.autoCompact(sessionName, maxTokensBeforeCompact, keepCountAfterCompact);

    // getRecentMessagesCompact strips tool call/result rows and truncates large
    // content, so the preamble contains only human-readable conversational turns.
    const messages = manager.getRecentMessagesCompact(session.id, maxMessages, maxContentLength);
    if (messages.length === 0) return "";

    const lines: string[] = [];
    for (const msg of messages) {
      const content = msg.content?.trim() ?? "";
      if (!content) continue;
      const role = msg.role === "user" ? "Human" : "Assistant";
      lines.push(`[${role}]: ${content}`);
    }

    if (lines.length === 0) return "";

    return [
      "<conversation_history>",
      "Recent conversation history (use as context for the current turn):",
      "",
      lines.join("\n\n"),
      "</conversation_history>",
    ].join("\n");
  } catch (err) {
    // Never crash a CC turn due to context injection failure
    console.error("[context-injector] Failed to build preamble:", err);
    return "";
  }
}
