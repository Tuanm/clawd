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
  const text =
    response?.file?.content || response?.stdout || (typeof response === "string" ? response : JSON.stringify(response));
  return typeof text === "string" ? text.slice(0, 2000) : "";
}

export function formatToolDescription(tool: string, input: Record<string, any>): string {
  if (!input) return tool;
  switch (tool) {
    case "Read":
      return input.file_path || "Read file";
    case "Edit":
      return `${input.file_path || "file"} (edit)`;
    case "Write":
    case "Create":
      return input.file_path || "Write file";
    case "Bash":
      return (input.command || "").slice(0, 80);
    case "Glob":
      return input.pattern || "Search files";
    case "Grep":
      return `/${input.pattern || ""}/ ${input.path || ""}`.trim();
    case "WebSearch":
      return input.query || "Web search";
    case "WebFetch":
      return input.url || "Fetch URL";
    default:
      return tool;
  }
}
