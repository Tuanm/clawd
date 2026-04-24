/**
 * Shared prompt fragments — single source of truth for runtime architecture
 * notices used across all Claw'd agent prompt builders.
 *
 * Import from here rather than duplicating strings across:
 *   - src/agent/prompt/builder.ts         (in-process agents: OpenAI/Anthropic/Copilot/Ollama)
 *   - src/claude-code/main-worker.ts        (Claude Code SDK agents)
 *   - src/agent/workers/clawd-chat/index.ts (external clawd-worker subprocess)
 */

// ============================================================================
// Core notice (tool-name-agnostic)
// ============================================================================

/**
 * Two-line core notice explaining that streaming text output is not visible.
 * Shared by all provider paths — does NOT reference any specific tool name.
 */
export const CLAWD_RUNTIME_NOTICE =
  `RUNTIME ARCHITECTURE: You are an agent connected to Claw'd's chat UI.\n` +
  `Your streaming text output is captured by the agentic framework as internal reasoning — it is NEVER displayed in the chat UI.\n` +
  `Writing text in your output without calling the send-message tool means the human will NEVER see your response.`;

// ============================================================================
// Provider-specific runtime blocks
// ============================================================================

/**
 * Full runtime block for standard in-process main agents
 * (OpenAI / Anthropic / Copilot / Ollama / custom providers).
 * Tool name: `reply` (no MCP prefix — injected by the clawd-chat plugin).
 * reply unifies "send visible text" + "mark triggering message processed".
 * Every turn MUST end with exactly one reply call.
 */
export const MAIN_AGENT_RUNTIME_BLOCK =
  `${CLAWD_RUNTIME_NOTICE}\n` +
  `Every turn MUST end with exactly one call to reply — this delivers your visible response AND marks the triggering message processed. ` +
  `Pass text="" or text="[SILENT]" to end the turn without sending a visible message.\n` +
  `If you receive a system reminder that reply was not called (wording like "Your turn did not end", "Reminder #N", "FINAL NOTICE"), your ONLY permitted next action is to call reply immediately. ` +
  `Do not perform any other tool calls, do not emit commentary, do not re-analyse — just call reply with text="[SILENT]" (or your reply) and the supplied timestamp. This is non-negotiable.\n` +
  `You have access to tools defined in the tool schema — use them as needed.`;

/**
 * Full runtime block for Claude Code main workers (claude-code provider).
 * Tool name: `mcp__clawd__reply` (full MCP prefix required by the SDK).
 */
export const CLAUDE_CODE_RUNTIME_BLOCK =
  `${CLAWD_RUNTIME_NOTICE}\n` +
  `Every turn MUST end with exactly one call to mcp__clawd__reply(text, timestamp). This delivers your reply AND marks the triggering message processed. ` +
  `Pass text="" or text="[SILENT]" to end the turn without sending a visible message.\n` +
  `If you receive a system reminder that mcp__clawd__reply was not called (wording like "Your turn did not end", "Reminder #N", "FINAL NOTICE"), your ONLY permitted next action is to call mcp__clawd__reply immediately. ` +
  `Do not perform any other tool calls, do not emit commentary, do not re-analyse — just call mcp__clawd__reply with text="[SILENT]" (or your reply) and the supplied timestamp. This is non-negotiable.\n` +
  `Do NOT reply in streaming text output — the human cannot see it, only the agentic framework can.`;
