/**
 * Single source of truth for converting a channel message into the author
 * label used in agent prompts. UHUMAN renders as "Pilot" — the proper-noun
 * display label for the human chat user. The DB sentinel stays UHUMAN; only
 * the presentation layer is renamed. Sub-agent role is conveyed by the
 * `kind="sub-agent"` attribute on the message wrapper, so the `from=` label
 * is just the agent_id (no `[Sub-agent: ...]` prefix).
 *
 * `USYSTEM` is a runtime-only sentinel (never persisted) used for synthetic
 * context messages such as wakeup/onboarding summaries — labelling them
 * `system` keeps the agent from mistaking them for real Pilot input.
 */
export function formatAuthor(msg: { user?: string | null; agent_id?: string | null }): string {
  if (msg.user === "UHUMAN") return "Pilot";
  if (msg.user === "USYSTEM") return "system";
  if (msg.user?.startsWith("UWORKER-")) return msg.agent_id || "unknown";
  return msg.agent_id || msg.user || "unknown";
}
