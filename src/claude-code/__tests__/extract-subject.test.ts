/**
 * Unit tests for extractSubject — the function that populates [Actions taken]
 * summaries in CC agent preambles with specific file/command context.
 */

import { describe, expect, test } from "bun:test";
import { extractSubject } from "../tool-subject";

// ── file_view / file_edit / file_create ───────────────────────────────────────

describe("extractSubject: file operations (view/edit/create)", () => {
  test("file_view extracts file_path", () => {
    expect(extractSubject("file_view", { file_path: "src/auth.ts" })).toBe("src/auth.ts");
  });

  test("file_edit extracts file_path", () => {
    expect(extractSubject("file_edit", { file_path: "src/utils.js" })).toBe("src/utils.js");
  });

  test("file_create extracts file_path", () => {
    expect(extractSubject("file_create", { file_path: "tests/unit.test.ts" })).toBe("tests/unit.test.ts");
  });

  test("returns empty string when file_path is missing", () => {
    expect(extractSubject("file_view", {})).toBe("");
  });

  test("returns empty string when file_path is null", () => {
    expect(extractSubject("file_view", { file_path: null })).toBe("");
  });

  test("handles null toolInput", () => {
    expect(extractSubject("file_view", null)).toBe("");
  });

  test("preserves relative and absolute paths", () => {
    expect(extractSubject("file_view", { file_path: "./src/nested/file.ts" })).toBe("./src/nested/file.ts");
    expect(extractSubject("file_view", { file_path: "/absolute/path/file.ts" })).toBe("/absolute/path/file.ts");
  });

  test("sanitizes newlines in file_path", () => {
    expect(extractSubject("file_view", { file_path: "src/foo\nbar.ts" })).toBe("src/foo bar.ts");
    expect(extractSubject("file_view", { file_path: "src/foo\r\nbar.ts" })).toBe("src/foo  bar.ts");
  });
});

// ── file_multi_edit ───────────────────────────────────────────────────────────

describe("extractSubject: file_multi_edit", () => {
  test("single edit shows path only", () => {
    expect(extractSubject("file_multi_edit", { edits: [{ file_path: "src/only.ts" }] })).toBe("src/only.ts");
  });

  test("multiple edits shows first path + count", () => {
    const result = extractSubject("file_multi_edit", {
      edits: [{ file_path: "src/first.ts" }, { file_path: "src/second.ts" }, { file_path: "src/third.ts" }],
    });
    expect(result).toBe("src/first.ts +2 more");
  });

  test("two edits shows +1 more", () => {
    const result = extractSubject("file_multi_edit", {
      edits: [{ file_path: "src/a.ts" }, { file_path: "src/b.ts" }],
    });
    expect(result).toBe("src/a.ts +1 more");
  });

  test("empty edits array returns empty string", () => {
    expect(extractSubject("file_multi_edit", { edits: [] })).toBe("");
  });

  test("first edit missing file_path is skipped in paths list", () => {
    // edits without file_path are filtered; if all filtered → ""
    const result = extractSubject("file_multi_edit", { edits: [{ line_start: 1 }, { file_path: "src/b.ts" }] });
    // paths = ["src/b.ts"] (length 1) → single path, no count
    expect(result).toBe("src/b.ts");
  });

  test("returns empty string when edits is not an array", () => {
    expect(extractSubject("file_multi_edit", { edits: "not an array" })).toBe("");
  });

  test("returns empty string when edits key is missing", () => {
    expect(extractSubject("file_multi_edit", {})).toBe("");
  });

  test("sanitizes newlines in first path", () => {
    const result = extractSubject("file_multi_edit", {
      edits: [{ file_path: "src/foo\nbar.ts" }, { file_path: "src/other.ts" }],
    });
    expect(result).toBe("src/foo bar.ts +1 more");
  });
});

// ── file_glob / file_grep ─────────────────────────────────────────────────────

describe("extractSubject: file_glob and file_grep", () => {
  test("file_glob extracts pattern", () => {
    expect(extractSubject("file_glob", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
  });

  test("file_grep extracts pattern", () => {
    expect(extractSubject("file_grep", { pattern: "function\\s+\\w+" })).toBe("function\\s+\\w+");
  });

  test("returns empty string when pattern is missing", () => {
    expect(extractSubject("file_glob", {})).toBe("");
  });

  test("returns empty string when pattern is null", () => {
    expect(extractSubject("file_grep", { pattern: null })).toBe("");
  });

  test("sanitizes newlines in pattern", () => {
    expect(extractSubject("file_grep", { pattern: "foo\nbar" })).toBe("foo bar");
  });
});

// ── bash ──────────────────────────────────────────────────────────────────────

describe("extractSubject: bash", () => {
  test("short command is not truncated, wrapped in quotes", () => {
    expect(extractSubject("bash", { command: "bun test" })).toBe('"bun test"');
  });

  test("command at exactly 40 chars is not truncated", () => {
    const cmd = "x".repeat(40);
    expect(extractSubject("bash", { command: cmd })).toBe(`"${cmd}"`);
  });

  test("command longer than 40 chars is truncated", () => {
    const longCmd = "a".repeat(100);
    expect(extractSubject("bash", { command: longCmd })).toBe(`"${"a".repeat(40)}"`);
  });

  test("returns empty quotes when command is missing", () => {
    expect(extractSubject("bash", {})).toBe('""');
  });

  test("returns empty quotes when command is null", () => {
    expect(extractSubject("bash", { command: null })).toBe('""');
  });

  test("internal double-quotes are escaped", () => {
    expect(extractSubject("bash", { command: 'echo "hello"' })).toBe('"echo \\"hello\\""');
  });

  test("newlines in command are replaced with space", () => {
    expect(extractSubject("bash", { command: "some cmd\nrm -rf /" })).toBe('"some cmd rm -rf /"');
  });

  test("double-quote at position 39 does not produce trailing backslash", () => {
    // 39 x chars + 1 double-quote = 40 chars total. After slice(0,40) we get all 40 chars.
    // Escape happens AFTER slice, so the `"` at pos 39 becomes `\"` — no dangling backslash.
    const cmd = "x".repeat(39) + '"';
    const result = extractSubject("bash", { command: cmd });
    expect(result).toBe('"' + "x".repeat(39) + '\\"' + '"');
    // Must NOT end with \" before the closing quote (which would escape the closing quote)
    expect(result.endsWith('\\"')).toBe(false);
  });

  test("double-quote past truncation boundary is not included", () => {
    // 40 xs + 1 double-quote = 41 chars. Slice at 40 drops the quote entirely.
    const cmd = "x".repeat(40) + '"';
    const result = extractSubject("bash", { command: cmd });
    expect(result).toBe('"' + "x".repeat(40) + '"');
  });
});

// ── spawn_agent ───────────────────────────────────────────────────────────────

describe("extractSubject: spawn_agent", () => {
  test("extracts agent name", () => {
    expect(extractSubject("spawn_agent", { name: "researcher" })).toBe("researcher");
  });

  test("returns empty string when name is missing", () => {
    expect(extractSubject("spawn_agent", {})).toBe("");
  });

  test("sanitizes newlines in agent name", () => {
    expect(extractSubject("spawn_agent", { name: "research\nagent" })).toBe("research agent");
  });
});

// ── memo_save ─────────────────────────────────────────────────────────────────

describe("extractSubject: memo_save", () => {
  test("content at exactly 30 chars is not truncated", () => {
    const content = "x".repeat(30);
    expect(extractSubject("memo_save", { content })).toBe(content);
  });

  test("content longer than 30 chars is truncated", () => {
    expect(extractSubject("memo_save", { content: "This is a very long memo content that should be truncated" })).toBe(
      "This is a very long memo conte",
    );
  });

  test("returns empty string when content is missing", () => {
    expect(extractSubject("memo_save", {})).toBe("");
  });

  test("sanitizes newlines in content", () => {
    expect(extractSubject("memo_save", { content: "line1\nline2" })).toBe("line1 line2");
  });
});

// ── memo_recall ───────────────────────────────────────────────────────────────

describe("extractSubject: memo_recall", () => {
  test("extracts query", () => {
    expect(extractSubject("memo_recall", { query: "authentication flow" })).toBe("authentication flow");
  });

  test("returns empty string when query is missing", () => {
    expect(extractSubject("memo_recall", {})).toBe("");
  });

  test("sanitizes newlines in query", () => {
    expect(extractSubject("memo_recall", { query: "foo\nbar" })).toBe("foo bar");
  });
});

// ── web_search ────────────────────────────────────────────────────────────────

describe("extractSubject: web_search", () => {
  test("short query wrapped in quotes", () => {
    expect(extractSubject("web_search", { query: "Node.js best practices" })).toBe('"Node.js best practices"');
  });

  test("long query is truncated to 40 chars", () => {
    const q = "how to implement a React component with hooks and TypeScript";
    const result = extractSubject("web_search", { query: q });
    expect(result.length).toBeLessThanOrEqual(42); // 40 + 2 quotes
  });

  test("returns empty quotes when query is missing", () => {
    expect(extractSubject("web_search", {})).toBe('""');
  });

  test("internal double-quotes are escaped", () => {
    expect(extractSubject("web_search", { query: 'search "exact phrase"' })).toBe('"search \\"exact phrase\\""');
  });

  test("newlines in query are replaced with space", () => {
    expect(extractSubject("web_search", { query: "foo\nbar" })).toBe('"foo bar"');
  });
});

// ── web_fetch ─────────────────────────────────────────────────────────────────

describe("extractSubject: web_fetch", () => {
  test("extracts URL without truncation", () => {
    expect(extractSubject("web_fetch", { url: "https://example.com/api/docs" })).toBe("https://example.com/api/docs");
  });

  test("returns empty string when url is missing", () => {
    expect(extractSubject("web_fetch", {})).toBe("");
  });

  test("truncates long URLs at 80 codepoints", () => {
    const longUrl = "https://example.com/" + "x".repeat(100);
    const result = extractSubject("web_fetch", { url: longUrl });
    expect(result).toBe(longUrl.slice(0, 80));
    expect(result.length).toBe(80);
  });

  test("sanitizes newlines in URL", () => {
    expect(extractSubject("web_fetch", { url: "https://example.com/\npath" })).toBe("https://example.com/ path");
  });
});

// ── unknown tools ─────────────────────────────────────────────────────────────

describe("extractSubject: unknown/unhandled tools", () => {
  test("unknown tool returns empty string", () => {
    expect(extractSubject("unknown_tool", { some: "input" })).toBe("");
  });

  test("CONVERSATION_TOOLS fall through to default (empty)", () => {
    expect(extractSubject("chat_send_message", { message: "hi" })).toBe("");
    expect(extractSubject("chat_mark_processed", {})).toBe("");
  });

  test("tool names are case-sensitive", () => {
    expect(extractSubject("FILE_VIEW", { file_path: "src/test.ts" })).toBe("");
  });
});

// ── edge cases / integration ──────────────────────────────────────────────────

describe("extractSubject: edge cases", () => {
  test("handles undefined toolInput", () => {
    expect(extractSubject("file_view", undefined)).toBe("");
  });

  test("handles primitive toolInput (number)", () => {
    // number is truthy so not coerced to {} — but property access returns undefined
    expect(extractSubject("file_view", 42 as any)).toBe("");
  });

  test("subject → summary format: with subject uses parens", () => {
    const subject = extractSubject("file_view", { file_path: "src/auth.ts" });
    const entry = subject ? `file_view(${subject})` : "file_view";
    expect(entry).toBe("file_view(src/auth.ts)");
  });

  test("subject → summary format: empty subject omits parens", () => {
    const subject = extractSubject("unknown_tool", {});
    const entry = subject ? `unknown_tool(${subject})` : "unknown_tool";
    expect(entry).toBe("unknown_tool");
  });

  test("multi-file-edit full summary example", () => {
    const subject = extractSubject("file_multi_edit", {
      edits: [{ file_path: "src/auth.ts" }, { file_path: "src/routes.ts" }, { file_path: "src/middleware.ts" }],
    });
    expect(subject).toBe("src/auth.ts +2 more");
    expect(`file_multi_edit(${subject})`).toBe("file_multi_edit(src/auth.ts +2 more)");
  });
});

// ── truncate codepoint safety ─────────────────────────────────────────────────

describe("extractSubject: codepoint-safe truncation (emoji / non-BMP)", () => {
  // 🔥 is U+1F525, encoded as a surrogate pair in UTF-16 (.length = 2, codepoints = 1)
  const FIRE = "\u{1F525}";

  test("bash: emoji entirely before cut point is preserved intact", () => {
    // 39 ASCII + 1 emoji = 40 codepoints; codepoint-safe slice keeps all 40
    const cmd = "x".repeat(39) + FIRE;
    const result = extractSubject("bash", { command: cmd });
    // The emoji should appear in the result (not split into lone surrogates)
    expect(result).toContain(FIRE);
    // Outer quotes are present
    expect(result.startsWith('"')).toBe(true);
    expect(result.endsWith('"')).toBe(true);
  });

  test("bash: emoji at position 40 (over limit) is excluded, not split", () => {
    // 40 ASCII + emoji: truncate at 40 codepoints drops the emoji entirely
    const cmd = "x".repeat(40) + FIRE;
    const result = extractSubject("bash", { command: cmd });
    expect(result).not.toContain(FIRE);
    expect(result).toBe('"' + "x".repeat(40) + '"');
  });

  test("memo_save: newline inside window + truncation both applied", () => {
    // "x".repeat(25) + "\n" + "y".repeat(10) = 36 chars; slice to 30 keeps newline, sanitize replaces it
    const content = "x".repeat(25) + "\n" + "y".repeat(10);
    const result = extractSubject("memo_save", { content });
    // After sanitize: spaces replace \n; after truncate at 30: first 30 codepoints
    expect(result).toBe("x".repeat(25) + " " + "y".repeat(4));
    expect(result.length).toBe(30);
  });
});
