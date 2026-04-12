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
  } catch {
    return null;
  }
}

export function saveToMemory(
  memorySessionId: string | null,
  role: "user" | "assistant" | "tool",
  content: string,
  toolCalls?: any[],
  toolCallId?: string,
): void {
  if (!memorySessionId) return;
  try {
    const sessions = getSessionManager();
    sessions.addMessage(memorySessionId, {
      role,
      content,
      tool_calls: toolCalls,
      tool_call_id: toolCallId,
    });
  } catch {}
}
