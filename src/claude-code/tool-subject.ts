/**
 * Tool subject extraction for [Actions taken] preamble summaries.
 *
 * Extracts the primary "subject" argument from a CC agent tool call so the
 * preamble shows `file_view(src/auth.ts)` instead of just `file_view`.
 * Kept in a separate module so it can be unit-tested without loading the
 * heavy main-worker.ts dependency graph.
 */

/** Strip newline/carriage-return characters from a subject string.
 * Subjects are stored as a single line in memory — embedded newlines break
 * the stored row and confuse the LLM reading the preamble. */
function sanitizeSubject(s: string): string {
  return s.replace(/[\r\n]/g, " ");
}

/**
 * Truncate a string to `maxChars` Unicode codepoints.
 * Uses `Array.from` (codepoint-aware) instead of `.slice` (code-unit-based)
 * to avoid splitting surrogate pairs for emoji/non-BMP characters.
 */
function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s; // fast path — no emoji involved
  return Array.from(s).slice(0, maxChars).join("");
}

/**
 * Extract the primary "subject" argument from a tool call for the [Actions taken] summary.
 * Returns a short string like "src/auth.ts" or `"bun test"` to give the agent
 * context on WHAT it operated on, not just which tool type it used.
 *
 * @param shortName - Tool name with `mcp__clawd__` prefix already stripped.
 * @param toolInput - Raw tool input object from the SDK hook.
 */
export function extractSubject(shortName: string, toolInput: unknown): string {
  const input = (toolInput || {}) as Record<string, any>;
  switch (shortName) {
    case "file_view":
    case "file_edit":
    case "file_create":
      return sanitizeSubject(input.file_path ?? "");
    case "file_multi_edit": {
      // Show all edited paths — first + count of additional ones.
      const edits: any[] = Array.isArray(input.edits) ? input.edits : [];
      const paths = edits.map((e: any) => e?.file_path).filter(Boolean) as string[];
      if (paths.length === 0) return "";
      const first = sanitizeSubject(paths[0]);
      return paths.length === 1 ? first : `${first} +${paths.length - 1} more`;
    }
    case "file_glob":
    case "file_grep":
      return sanitizeSubject(input.pattern ?? "");
    case "bash": {
      // Truncate first, then escape — escaping before truncation can leave a trailing
      // lone backslash when a `"` straddles the cut point, breaking the outer quotes.
      const cmd = truncate(sanitizeSubject(input.command ?? ""), 40).replace(/"/g, '\\"');
      return `"${cmd}"`;
    }
    case "spawn_agent":
      return sanitizeSubject(input.name ?? "");
    case "memo_save":
      return truncate(sanitizeSubject(input.content ?? ""), 30);
    case "memo_recall":
      return sanitizeSubject(input.query ?? "");
    case "web_search": {
      // Same truncate-first, escape-second ordering as bash.
      const q = truncate(sanitizeSubject(input.query ?? ""), 40).replace(/"/g, '\\"');
      return `"${q}"`;
    }
    case "web_fetch":
      return truncate(sanitizeSubject(input.url ?? ""), 80);
    default:
      return "";
  }
}
