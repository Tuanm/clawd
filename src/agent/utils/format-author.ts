/**
 * Single source of truth for converting a channel message into the author
 * label used in agent prompts. Inconsistent label format across prompt
 * builders previously caused multi-agent attribution drift (`human` vs
 * `Human`, `bot` vs `unknown` fallback, missing `[Sub-agent: ...]` wrapper).
 *
 * `USYSTEM` is a runtime-only sentinel (never persisted) used for synthetic
 * context messages such as wakeup/onboarding summaries — labelling them
 * `system` keeps the agent from mistaking them for real human input.
 */
export function formatAuthor(msg: { user?: string | null; agent_id?: string | null }): string {
  if (msg.user === "UHUMAN") return "human";
  if (msg.user === "USYSTEM") return "system";
  if (msg.user?.startsWith("UWORKER-")) return `[Sub-agent: ${msg.agent_id || "unknown"}]`;
  return msg.agent_id || msg.user || "unknown";
}
