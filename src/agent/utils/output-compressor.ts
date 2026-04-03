/**
 * Output Compressor — Per-tool caps for tool result compression
 * Phase 3.3: Enforces per-tool size limits with smart truncation
 */

import { smartTruncate } from "./smart-truncation";

// ── Per-Tool Caps ──────────────────────────────────────────────────

const TOOL_CAPS: Record<string, number> = {
  bash: 8192,
  exec: 8192,
  grep: 6144,
  glob: 6144,
  view: 10240,
  // edit/create: exempt (handled separately)
  chat_get_message_files: 4096,
  chat_download_file: 4096,
  convert_to_markdown: 20480,
  chat_read_file_range: 10240,
  chat_get_history: 10240,
  chat_get_message: 10240,
  chat_query_messages: 10240,
  chat_poll_and_ack: 10240,
  git_diff: 8192,
  git_log: 8192,
  chat_search: 6144,
  web_fetch: 10240,
  tmux_capture: 8192,
  article_get: 10240,
};

const DEFAULT_CAP = 32768; // 32KB for unknown tools

// Tools exempt from compression
const EXEMPT_TOOLS = new Set(["edit", "create"]);

// Metadata-only chat tools — never compress (plan Phase 3B requirement)
const METADATA_ONLY_TOOLS = new Set([
  "chat_send_message",
  "chat_mark_processed",
  "chat_upload_file",
  "chat_upload_local_file",
]);

// ── Types ──────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface CompressResult {
  result: ToolResult;
  indexed: boolean;
  originalSize: number;
  compressedSize: number;
  sourceId?: string;
}

export type IndexFn = (sessionId: string, sourceId: string, toolName: string, content: string) => boolean;

// ── Compressor ─────────────────────────────────────────────────────

/**
 * Get the per-tool cap for a tool name.
 */
export function getToolCap(toolName: string): number {
  return TOOL_CAPS[toolName] ?? DEFAULT_CAP;
}

/**
 * Check if a tool is exempt from compression.
 */
export function isExempt(toolName: string, result: ToolResult): boolean {
  if (EXEMPT_TOOLS.has(toolName)) return true;
  if (METADATA_ONLY_TOOLS.has(toolName)) return true;
  // bash/exec errors are exempt
  if ((toolName === "bash" || toolName === "exec") && !result.success) return true;
  return false;
}

/**
 * Compress a tool result if it exceeds the per-tool cap.
 * Returns the (possibly compressed) result and indexing info.
 */
export function compressToolOutput(
  toolName: string,
  result: ToolResult,
  sessionId: string,
  indexFn?: IndexFn,
): CompressResult {
  const output = result.output || "";
  const originalSize = output.length;

  // Exempt tools pass through
  if (isExempt(toolName, result)) {
    return { result, indexed: false, originalSize, compressedSize: originalSize };
  }

  const cap = getToolCap(toolName);

  // Under cap — no compression needed
  if (output.length <= cap) {
    return { result, indexed: false, originalSize, compressedSize: originalSize };
  }

  // Generate source ID for indexing
  const sourceId = `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Index full content (async-safe, graceful failure)
  let indexed = false;
  if (indexFn) {
    try {
      indexed = indexFn(sessionId, sourceId, toolName, output);
    } catch {
      // C26: graceful degradation
    }
  }

  // Smart truncate to cap, reserving space for retrieval hint
  const hintReserve = 150;
  const truncated = smartTruncate(output, { maxLength: Math.max(cap - hintReserve, 100) });

  // Append retrieval hint
  const hint = indexed
    ? `\n\n[Full output indexed (source_id: ${sourceId}). Use knowledge_search('query') to retrieve specific sections.]`
    : "\n\n[Content truncated. Full text not available for search. Head and tail preserved.]";

  const compressed = truncated + hint;

  return {
    result: { ...result, output: compressed },
    indexed,
    originalSize,
    compressedSize: compressed.length,
    sourceId: indexed ? sourceId : undefined,
  };
}
