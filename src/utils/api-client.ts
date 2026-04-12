/**
 * Shared API client utilities.
 *
 * Extracted from the duplicated postToChannel pattern in:
 *   src/index.ts, src/scheduler/runner.ts
 */

import { timedFetch } from "./timed-fetch";

/**
 * Post a message to a Claw'd channel via the chat API.
 *
 * @throws if the server responds with a non-OK status
 */
export async function postToChannel(apiUrl: string, channel: string, text: string, agentId: string): Promise<void> {
  const res = await timedFetch(`${apiUrl}/api/chat.postMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel,
      text,
      user: "UBOT",
      agent_id: agentId,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to post message: ${res.status}`);
  }
}
