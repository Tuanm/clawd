/**
 * Claude Code memory.db helpers
 *
 * Shared session/message persistence for Thoughts history UI.
 */

import { getSessionManager } from "../agent/session/manager";

export function initMemorySession(sessionName: string, model: string): string | null {
  try {
    const sessions = getSessionManager();
    const session = sessions.getOrCreateSession(sessionName, model);
    return session.id;
  } catch (err) {
    // Silent failure here means the agent runs with NO persistence — preamble will
    // be empty every turn, [CC-Turn] writes become no-ops. Log so operators notice.
    console.error(`[initMemorySession] Failed to initialise session "${sessionName}":`, err);
    return null;
  }
}

export function saveToMemory(
  memorySessionId: string | null,
  role: "user" | "assistant" | "tool",
  content: string,
  toolCalls?: any[],
  toolCallId?: string,
): number | null {
  if (!memorySessionId) return null;
  try {
    const sessions = getSessionManager();
    return sessions.addMessage(memorySessionId, {
      role,
      content,
      tool_calls: toolCalls,
      tool_call_id: toolCallId,
    });
  } catch (err) {
    // Persistence failures are recoverable (next turn will try again) but the
    // operator should know when the session DB is in trouble.
    console.error(`[saveToMemory] Failed to persist ${role} message:`, err);
    return null;
  }
}
