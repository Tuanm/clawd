/**
 * Chat fallback — worker-level rescue path for agents that produce visible
 * text but fail to call `chat_send_message` even after re-injection.
 *
 * Flow (called only after a re-injection round has also failed):
 *   - If reinjection output is exactly "[SILENT]" → agent explicitly opted out
 *   - If reinjection output is empty → nothing to rescue
 *   - Otherwise → POST the text directly to the chat API via /mcp so it
 *     persists to the DB like a real agent message
 *
 * Bypasses the per-turn throttle (guard lives inside agent.ts) because this
 * is a worker-level rescue, not an agent decision.
 */

import { timedFetch } from "../../utils/timed-fetch";
import { stripReasoningBlocks } from "./strip-reasoning";

export type FallbackOutcome =
  | { kind: "silent_accepted" }
  | { kind: "empty_discarded" }
  | { kind: "fallback_sent"; chars: number }
  | { kind: "fallback_failed"; error: string };

/** Decide what to do with re-injection output. Pure function — easy to test. */
export function classifyReinjectionOutput(text: string): "silent" | "empty" | "send" {
  const cleaned = stripReasoningBlocks(text).trim();
  if (cleaned === "[SILENT]") return "silent";
  if (cleaned.length === 0) return "empty";
  return "send";
}

/** Extract the text that would actually be sent (post-strip, post-trim). */
export function extractFallbackText(text: string): string {
  return stripReasoningBlocks(text).trim();
}

/**
 * Send a chat_send_message as the final rescue after re-injection produced
 * text but the agent still didn't call the tool.
 *
 * Returns an outcome describing what happened (for logging).
 */
export async function sendChatFallback(params: {
  apiUrl: string;
  channel: string;
  agentId: string;
  userId: string;
  reinjectionText: string;
  authHeaders?: Record<string, string>;
}): Promise<FallbackOutcome> {
  const { apiUrl, channel, agentId, userId, reinjectionText, authHeaders } = params;

  const decision = classifyReinjectionOutput(reinjectionText);
  if (decision === "silent") return { kind: "silent_accepted" };
  if (decision === "empty") return { kind: "empty_discarded" };

  const text = extractFallbackText(reinjectionText);
  try {
    const res = await timedFetch(`${apiUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authHeaders ?? {}) },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "chat_send_message",
          arguments: { channel, text, agent_id: agentId, user: userId },
        },
      }),
    });
    if (!res.ok) {
      return { kind: "fallback_failed", error: `HTTP ${res.status}` };
    }
    return { kind: "fallback_sent", chars: text.length };
  } catch (err) {
    return { kind: "fallback_failed", error: err instanceof Error ? err.message : String(err) };
  }
}
