/**
 * Claude Code shared utilities
 *
 * Pure helpers used by both main-worker and space-worker.
 */

// ============================================================================
// Tmux Detection
// ============================================================================

let _tmuxAvailable: boolean | null = null;
export function hasTmux(): boolean {
  if (_tmuxAvailable === null) {
    try {
      _tmuxAvailable = Bun.spawnSync(["which", "tmux"]).exitCode === 0;
    } catch {
      _tmuxAvailable = false;
    }
  }
  return _tmuxAvailable;
}

// ============================================================================
// Tool Result Formatting
// ============================================================================

export function truncateToolResult(response: any): string {
  if (!response) return "";
  // Handle MCP content blocks — either { content: [...] } or the array directly [{ type, text }]
  const contentArray = Array.isArray(response?.content)
    ? response.content
    : Array.isArray(response) && response[0]?.type
      ? response
      : null;
  if (contentArray) {
    return contentArray
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b?.text || "")
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000);
  }
  const text =
    response?.file?.content || response?.stdout || (typeof response === "string" ? response : JSON.stringify(response));
  return typeof text === "string" ? text.slice(0, 2000) : "";
}

export function formatToolDescription(tool: string, input: Record<string, any>): string {
  if (!input) return tool;
  // Normalize mcp__clawd__ prefix for consistent matching
  const normalized = tool.startsWith("mcp__clawd__") ? tool.slice("mcp__clawd__".length) : tool;
  // For external MCP tools (serverName__toolName), extract the raw tool name for matching
  const extSep = normalized.indexOf("__");
  const rawToolName = extSep !== -1 ? normalized.slice(extSep + 2) : normalized;
  switch (rawToolName) {
    case "Read":
    case "file_view":
      return input.file_path || input.path || "Read file";
    case "Edit":
    case "MultiEdit":
    case "file_edit":
    case "file_multi_edit":
      return `${input.file_path || input.path || "file"} (edit)`;
    case "Write":
    case "Create":
    case "file_create":
      return input.file_path || input.path || "Write file";
    case "Bash":
    case "bash":
      return (input.command || "").slice(0, 80);
    case "Glob":
    case "file_glob":
      return input.pattern || "Search files";
    case "Grep":
    case "file_grep":
      return `/${input.pattern || ""}/ ${input.path || ""}`.trim();
    case "WebSearch":
    case "web_search":
      return input.query || "Web search";
    case "WebFetch":
    case "web_fetch":
      return input.url || "Fetch URL";
    default:
      // For external MCP tools, show as "server/tool" for readability
      return extSep !== -1 ? `${normalized.slice(0, extSep)}/${rawToolName}` : normalized;
  }
}
