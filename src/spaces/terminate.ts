/**
 * Shared termination logic for sub-agents.
 *
 * Both `kill_agent` (from chat-tools) and `stop_agent` (from agent-mcp-tools)
 * route through `terminateSpace` so the cleanup ordering and status reporting
 * stay aligned. Without this, the two paths drifted: kill_agent re-read the
 * final status after the failSpace CAS while stop_agent reported a hardcoded
 * "stopped" even when the agent settled naturally between the request and
 * the lock — the caller saw a lie.
 *
 * Order of operations is load-bearing:
 *   1. clear the wall-clock timer FIRST so it can't fire after we settle
 *      the space and post a spurious "timed out" chat message
 *   2. stop the worker + unregister so completion callbacks stop firing
 *   3. clear the MCP-shared Maps so a late callback can't repopulate state
 *   4. failSpace (atomic CAS) — wins the status transition or no-ops
 *   5. re-read so the response carries the actual final status (the CAS may
 *      have lost to a concurrent completion/timeout — caller should see
 *      whatever status actually settled)
 *   6. chat-post into the SUB-AGENT'S parent channel — not the caller's
 *      context channel (which can be a sibling space or "general")
 */

import { type Space, getSpace } from "./db";
import { SpaceManager } from "./manager";

export interface TerminateOptions {
  /** Optional Chat API base URL (defaults to localhost:9081). */
  chatApiUrl?: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional SpaceManager override for tests. */
  spaceManager?: SpaceManager;
}

export interface TerminateResult {
  /** The space row before termination (null if not found). */
  spaceBefore: Space | null;
  /** Whether failSpace's atomic lock won the CAS. */
  locked: boolean;
  /** The space row after termination, freshly re-read. */
  finalSpace: Space | null;
  /** Whether the chat-post succeeded. */
  postedToChat: boolean;
}

/**
 * Terminate a sub-agent space: clear timer, stop worker, clear MCP maps,
 * fail the space, post a chat report. Idempotent against late callbacks.
 */
export async function terminateSpace(
  spaceId: string,
  reason: string,
  opts: TerminateOptions = {},
): Promise<TerminateResult> {
  const space = getSpace(spaceId);
  if (!space) {
    return { spaceBefore: null, locked: false, finalSpace: null, postedToChat: false };
  }

  // Step 1: clear the timer BEFORE anything else so it can't fire mid-sequence.
  try {
    const { spaceTimeoutTimers } = await import("../server/mcp");
    const timer = spaceTimeoutTimers.get(spaceId);
    if (timer) {
      clearTimeout(timer);
      spaceTimeoutTimers.delete(spaceId);
    }
  } catch (err) {
    console.warn("[terminateSpace] timer clear failed (continuing):", err);
  }

  // Step 2 + 3: stop worker, unregister, clear MCP-shared maps.
  try {
    const { getClaudeCodeWorker, unregisterClaudeCodeWorker } = await import("./claude-code-worker");
    const worker = getClaudeCodeWorker(spaceId);
    if (worker) {
      worker.stop();
      unregisterClaudeCodeWorker(spaceId);
    }
    const { spaceCompleteCallbacks, spaceAuthTokens, spaceProjectRoots } = await import("../server/mcp");
    // Clear regardless of whether worker was found — a late completion
    // callback could otherwise repopulate state for a now-failed space.
    spaceCompleteCallbacks.delete(spaceId);
    spaceAuthTokens.delete(spaceId);
    spaceProjectRoots.delete(spaceId);
  } catch (err) {
    console.warn("[terminateSpace] worker cleanup failed (continuing to mark space failed):", err);
  }

  // Step 4: fail the space (atomic CAS — broadcasts lock + refreshes card).
  const manager = opts.spaceManager ?? new SpaceManager();
  const locked = manager.failSpace(spaceId, reason);
  if (!locked) {
    console.warn(`[terminateSpace] failSpace returned false for ${spaceId} — likely already settled by another path`);
  }

  // Step 5: re-read so the response carries the actual final status.
  const finalSpace = getSpace(spaceId);

  // Step 6: post the agent_report chat message to the sub-agent's parent
  // channel (where its card lives), not the caller's context channel.
  let postedToChat = false;
  try {
    const chatApiUrl = opts.chatApiUrl ?? `http://localhost:${process.env.PORT || 9081}`;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const stopAgentId = space.agent_id;
    const res = await fetchImpl(`${chatApiUrl}/api/chat.postMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: space.channel,
        text: `Sub-agent stopped: ${reason}`,
        user: stopAgentId,
        agent_id: stopAgentId,
        subtype: "agent_report",
      }),
    });
    postedToChat = res.ok;
  } catch (err) {
    console.warn("[terminateSpace] chat.postMessage failed:", err);
  }

  return { spaceBefore: space, locked, finalSpace, postedToChat };
}
