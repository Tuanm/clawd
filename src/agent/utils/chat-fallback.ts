/**
 * Chat fallback — worker-level rescue path for agents that produce visible
 * text but fail to call `reply` even after re-injection.
 *
 * Flow (called only after a re-injection round has also failed):
 *   - If reinjection output is exactly "[SILENT]" → agent explicitly opted out
 *   - If reinjection output is empty → nothing to rescue
 *   - Otherwise → POST the text directly to the chat API via /mcp so it
 *     persists to the DB like a real agent message. If `processedTs` is
 *     provided, also marks that human message as processed via the same
 *     `reply` call so it won't re-poll after restart.
 *
 * Bypasses the per-turn throttle (guard lives inside agent.ts) because this
 * is a worker-level rescue, not an agent decision.
 */

import { timedFetch } from "../../utils/timed-fetch";
import { stripReasoningBlocks } from "./strip-reasoning";

/**
 * Hard cap on reply re-injection retries per turn.
 * Beyond this, we stop wasting tokens and let the next poll cycle retry on
 * the same (unprocessed) message in a fresh turn.
 */
export const MAX_REINJECT_ATTEMPTS = 10;

/**
 * Build an escalating re-injection prompt. Wording gets progressively firmer
 * as the attempt count grows, so compliant agents notice on attempt 1 while
 * stubborn ones eventually get an unambiguous directive.
 *
 * @param attempt 1-indexed attempt number
 * @param opts.toolName Fully-qualified tool name (e.g. "reply" or "mcp__clawd__reply")
 * @param opts.lastTs Timestamp of the triggering message (or "latest")
 * @param opts.hadText True if the agent emitted visible streaming text this turn
 */
export function buildReinjectionPrompt(
  attempt: number,
  opts: { toolName: string; lastTs: string; hadText: boolean },
): string {
  const { toolName, lastTs, hadText } = opts;
  const call = `${toolName}(text=${hadText ? '"<your reply or [SILENT]>"' : '"[SILENT]"'}, timestamp="${lastTs}")`;

  if (attempt <= 1) {
    return hadText
      ? `[Your turn did not end properly — call \`${call}\` now to deliver your reply AND mark the message processed. Without this, the message will re-poll.]`
      : `[Your turn did not end properly — call \`${call}\` now. Without this, the message will re-poll.]`;
  }
  if (attempt === 2) {
    return `[Reminder #${attempt}: ${toolName} has NOT been called yet. Stop whatever you're doing and call \`${call}\` NOW. Do not emit any other tool calls or text before this.]`;
  }
  if (attempt <= 4) {
    return `[Reminder #${attempt}: your ONLY permitted next action is \`${call}\`. No further analysis, tool calls, or commentary — just call ${toolName} immediately.]`;
  }
  return `[FINAL NOTICE #${attempt}/${MAX_REINJECT_ATTEMPTS}: call \`${call}\` NOW. This is non-negotiable — any other output is ignored. Call ${toolName} or the turn continues re-polling.]`;
}

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
 * Send a reply as the final rescue after re-injection produced text
 * but the agent still didn't call the tool.
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
  /** Optional ts of the triggering human message; marks it processed alongside the send. */
  processedTs?: string;
}): Promise<FallbackOutcome> {
  const { apiUrl, channel, agentId, userId, reinjectionText, authHeaders, processedTs } = params;

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
          name: "reply",
          arguments: {
            channel,
            text,
            agent_id: agentId,
            user: userId,
            ...(processedTs && { timestamp: processedTs }),
          },
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
