/**
 * Shared prompt fragments — single source of truth for runtime architecture
 * notices used across all Claw'd agent prompt builders.
 *
 * Import from here rather than duplicating strings across:
 *   - src/agent/prompt/builder.ts         (in-process agents: OpenAI/Anthropic/Copilot/Ollama)
 *   - src/claude-code-main-worker.ts       (Claude Code SDK agents)
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
  `RUNTIME ARCHITECTURE: You are running inside Claw'd's agentic system, NOT a standard chat interface.\n` +
  `Your streaming text output (everything you write while thinking or responding) is captured by the system and is NEVER shown to users.`;

// ============================================================================
// Provider-specific runtime blocks
// ============================================================================

/**
 * Full runtime block for standard in-process main agents
 * (OpenAI / Anthropic / Copilot / Ollama / custom providers).
 * Tool name: `chat_send_message` (no MCP prefix — injected by the clawd-chat plugin).
 */
export const MAIN_AGENT_RUNTIME_BLOCK =
  `${CLAWD_RUNTIME_NOTICE}\n` +
  `To communicate with users you MUST call the chat_send_message tool — that is the ONLY output channel to humans.\n` +
  `You have access to tools defined in the tool schema — use them as needed.`;

/**
 * Full runtime block for Claude Code main workers (claude-code provider).
 * Tool name: `mcp__clawd__chat_send_message` (full MCP prefix required by the SDK).
 */
export const CLAUDE_CODE_RUNTIME_BLOCK =
  `${CLAWD_RUNTIME_NOTICE}\n` +
  `Users can ONLY see messages sent via mcp__clawd__chat_send_message — do NOT reply in text output.`;
