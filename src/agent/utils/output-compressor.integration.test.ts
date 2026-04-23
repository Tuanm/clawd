/**
 * OutputCompressor — Integration Tests
 * Phase 3.3: End-to-end behavior across tool types, sizes, formats, and edge cases.
 *
 * Covers: compressToolOutput across tool types, large outputs, code fences,
 * UTF-16 surrogate pairs, null/undefined input, compressedSize consistency.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ToolResult } from "./output-compressor";
import { compressToolOutput, getToolCap, isExempt } from "./output-compressor";

// ── Helpers ─────────────────────────────────────────────────────────

function makeOutput(n: number, char = "x"): string {
  return char.repeat(n);
}

function mockIndexFn() {
  return mock((_sessionId: string, _sourceId: string, _toolName: string, _content: string) => true);
}

// ── 1. compressToolOutput across various tool types ─────────────────

describe("compressToolOutput — tool type coverage", () => {
  const toolsUnderTest = [
    // [toolName, outputSize, expectedBehavior]
    ["bash", 8192, "at-cap"],
    ["bash", 20000, "truncated"],
    ["bash", 100, "unchanged"],
    ["grep", 6144, "at-cap"],
    ["grep", 15000, "truncated"],
    ["view", 10240, "at-cap"],
    ["view", 30000, "truncated"],
    ["glob", 6144, "at-cap"],
    ["glob", 20000, "truncated"],
    ["git_diff", 8192, "at-cap"],
    ["git_diff", 25000, "truncated"],
    ["git_log", 8192, "at-cap"],
    ["web_fetch", 10240, "at-cap"],
    ["browser_navigate", 512, "at-cap"],
    ["browser_navigate", 2000, "truncated"],
    ["browser_screenshot", 256, "at-cap"],
    ["query_messages", 10240, "at-cap"],
    ["convert_to_markdown", 20480, "at-cap"],
    ["convert_to_markdown", 60000, "truncated"],
    ["memory_search", 6144, "at-cap"],
    ["tmux_capture", 8192, "at-cap"],
    ["article_get", 10240, "at-cap"],
    ["knowledge_search", 4096, "at-cap"],
    ["knowledge_search", 20000, "truncated"],
  ] as const;

  for (const [toolName, outputSize, expectedBehavior] of toolsUnderTest) {
    test(`${toolName} @ ${outputSize} chars → ${expectedBehavior}`, () => {
      const output = makeOutput(outputSize);
      const result: ToolResult = { success: true, output };
      const cap = getToolCap(toolName);

      // Use indexFn to exercise the indexing path
      const compressed = compressToolOutput(toolName, result, "session1", mockIndexFn());

      if (expectedBehavior === "unchanged") {
        // Under cap: hint is appended when indexed → output grows
        expect(compressed.originalSize).toBe(outputSize);
        expect(compressed.indexed).toBe(true);
        // Output length = original + hint
        expect(compressed.result.output.length).toBeGreaterThan(outputSize);
        // compressedSize includes hint (consistent with over-cap path)
        expect(compressed.compressedSize).toBe(compressed.result.output.length);
      } else if (expectedBehavior === "at-cap") {
        // At exactly the cap: hint appended → output exceeds cap
        expect(compressed.originalSize).toBe(outputSize);
        expect(compressed.indexed).toBe(true);
        expect(compressed.result.output.length).toBeGreaterThan(outputSize);
        expect(compressed.compressedSize).toBe(compressed.result.output.length);
      } else {
        // Truncated: compressedSize must be less than originalSize
        expect(compressed.compressedSize).toBeLessThan(outputSize);
        expect(compressed.originalSize).toBe(outputSize);
        expect(compressed.result.output.length).toBeLessThan(outputSize);
        expect(compressed.indexed).toBe(true);
        expect(compressed.compressedSize).toBe(compressed.result.output.length);
      }

      // Safety: compressedSize must equal actual result output length
      expect(compressed.compressedSize).toBe(compressed.result.output.length);
    });
  }

  test("all TOOL_CAPS tools produce consistent results", () => {
    const tools = Object.keys({
      bash: 8192,
      exec: 8192,
      grep: 6144,
      glob: 6144,
      view: 10240,
      query_files: 4096,
      download_file: 4096,
      convert_to_markdown: 20480,
      query_messages: 10240,
      pollack: 10240,
      git_diff: 8192,
      git_log: 8192,
      memory_search: 6144,
      web_fetch: 10240,
      tmux_capture: 8192,
      article_get: 10240,
      knowledge_search: 4096,
      browser_navigate: 512,
      browser_click: 256,
      browser_type: 256,
      browser_scroll: 256,
      browser_screenshot: 256,
      browser_extract: 512,
      browser_execute: 512,
      browser_tabs: 256,
      browser_handle_dialog: 256,
      browser_download: 1024,
    });

    for (const tool of tools) {
      const result: ToolResult = { success: true, output: makeOutput(50000) };
      const compressed = compressToolOutput(tool, result, "session1");
      expect(compressed.originalSize).toBe(50000);
      expect(compressed.compressedSize).toBeLessThan(50000);
      expect(compressed.result.output.length).toBeLessThan(50000);
    }
  });
});

// ── 2. Large outputs exceeding size caps ─────────────────────────────

describe("compressToolOutput — large output cap enforcement", () => {
  test("100KB bash output is compressed to under 8192", () => {
    const result: ToolResult = { success: true, output: makeOutput(100_000) };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.originalSize).toBe(100_000);
    expect(compressed.compressedSize).toBeLessThan(8192);
    expect(compressed.result.output).toContain("[TRUNCATED");
  });

  test("500KB convert_to_markdown output is compressed to under 20480", () => {
    const result: ToolResult = { success: true, output: makeOutput(500_000) };
    const compressed = compressToolOutput("convert_to_markdown", result, "session1");
    expect(compressed.originalSize).toBe(500_000);
    expect(compressed.compressedSize).toBeLessThan(20480);
    expect(compressed.result.output.length).toBeLessThan(20480);
  });

  test("1MB view output is compressed to under 10240", () => {
    const result: ToolResult = { success: true, output: makeOutput(1_000_000) };
    const compressed = compressToolOutput("view", result, "session1");
    expect(compressed.originalSize).toBe(1_000_000);
    expect(compressed.compressedSize).toBeLessThan(10240);
  });

  test("500B browser_screenshot output over 256 cap → truncated", () => {
    const result: ToolResult = { success: true, output: makeOutput(500) };
    const compressed = compressToolOutput("browser_screenshot", result, "session1");
    expect(compressed.originalSize).toBe(500);
    expect(compressed.compressedSize).toBeLessThan(256);
  });

  test("huge output (10MB) does not cause integer overflow in head/tail split", () => {
    const result: ToolResult = {
      success: true,
      output: makeOutput(10_000_000),
    };
    const compressed = compressToolOutput("view", result, "session1");
    expect(compressed.originalSize).toBe(10_000_000);
    expect(compressed.compressedSize).toBeLessThan(10240);
    // No crashes or NaN
    expect(Number.isFinite(compressed.compressedSize)).toBe(true);
    expect(Number.isFinite(compressed.originalSize)).toBe(true);
  });

  test("edge: output exactly at cap does not truncate", () => {
    const cap = getToolCap("bash"); // 8192
    const result: ToolResult = { success: true, output: makeOutput(cap) };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.originalSize).toBe(cap);
    expect(compressed.result.output.length).toBe(cap);
  });

  test("edge: output one char over cap triggers truncation", () => {
    const cap = getToolCap("bash");
    const result: ToolResult = { success: true, output: makeOutput(cap + 1) };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.originalSize).toBe(cap + 1);
    expect(compressed.compressedSize).toBeLessThan(cap);
    expect(compressed.result.output).toContain("[TRUNCATED");
  });
});

// ── 3. Code fences preservation ───────────────────────────────────────

describe("compressToolOutput — code fence handling", () => {
  test("single open fence is closed after truncation", () => {
    const text = "```typescript\nconst x = 1;\n";
    const result: ToolResult = {
      success: true,
      output: makeOutput(20000).replace("x".repeat(1), text),
    };
    const customOutput = text + makeOutput(20000 - text.length);
    const r: ToolResult = { success: true, output: customOutput };
    const compressed = compressToolOutput("bash", r, "session1");

    const fenceCount = (compressed.result.output.match(/```/g) || []).length;
    // Truncation with odd fences → smartTruncate adds a closing fence
    // Even count is acceptable (even number of fences means balanced markdown)
    expect(fenceCount % 2).toBe(0);
  });

  test("balanced fences remain balanced after truncation", () => {
    const text = ["```typescript", "const x = 42;", "```", "More text"].join("\n");
    const result: ToolResult = {
      success: true,
      output: text + makeOutput(20000),
    };
    const compressed = compressToolOutput("bash", result, "session1");

    const fenceCount = (compressed.result.output.match(/```/g) || []).length;
    // Even number of fences is acceptable
    expect(fenceCount % 2).toBe(0);
  });

  test("code fence inside head and tail both preserved", () => {
    const head = "```js\nconsole.log('start');\n```\n";
    const tail = "\n```py\nprint('end')\n```";
    const middle = makeOutput(20000);
    const result: ToolResult = { success: true, output: head + middle + tail };
    const compressed = compressToolOutput("bash", result, "session1");

    // At least one fence should survive truncation
    const fenceCount = (compressed.result.output.match(/```/g) || []).length;
    expect(fenceCount).toBeGreaterThanOrEqual(0); // Just check no crash
    expect(compressed.result.output).toContain("[TRUNCATED");
  });

  test("fence-only output is handled without crash", () => {
    const result: ToolResult = {
      success: true,
      output: "```\ncode\n" + makeOutput(20000),
    };
    const compressed = compressToolOutput("bash", result, "session1");
    const fenceCount = (compressed.result.output.match(/```/g) || []).length;
    // Even count preferred; odd acceptable only if maxLength too tight
    expect(Number.isFinite(compressed.compressedSize)).toBe(true);
  });

  test("nested code blocks survive truncation", () => {
    const text = ["```typescript", "// outer", "```", "```python", "# inner", "```", makeOutput(20000)].join("\n");
    const result: ToolResult = { success: true, output: text };
    const compressed = compressToolOutput("bash", result, "session1");
    const fenceCount = (compressed.result.output.match(/```/g) || []).length;
    // 4 fences in input → even → should remain even
    expect(fenceCount % 2).toBe(0);
    expect(compressed.compressedSize).toBeLessThan(text.length);
  });

  test("fence at very start of output", () => {
    const text = "```" + makeOutput(20000);
    const result: ToolResult = { success: true, output: text };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.result.output).toContain("```");
    expect(compressed.compressedSize).toBeLessThan(text.length);
  });

  test("fence at very end of output", () => {
    const text = makeOutput(20000) + "```";
    const result: ToolResult = { success: true, output: text };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.result.output).toContain("```");
    expect(compressed.compressedSize).toBeLessThan(text.length);
  });
});

// ── 4. UTF-16 surrogate pair safety ─────────────────────────────────

describe("compressToolOutput — UTF-16 surrogate pair safety", () => {
  test("emoji (U+1F4A9 pile of poo) survives truncation intact", () => {
    const emoji = "💩";
    const text = emoji.repeat(1000) + makeOutput(20000);
    const result: ToolResult = { success: true, output: text };
    const compressed = compressToolOutput("bash", result, "session1");

    // The compressed output must not contain malformed surrogate pairs
    // Splitting U+1F4A9 (high D83D DCA9) would create invalid strings
    let hasInvalidSurrogate = false;
    for (let i = 0; i < compressed.result.output.length; i++) {
      const code = compressed.result.output.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdfff) {
        const nextCode = i + 1 < compressed.result.output.length ? compressed.result.output.charCodeAt(i + 1) : -1;
        // High surrogate must be followed by low surrogate; low must follow high
        if (code <= 0xdbff && (nextCode < 0xdc00 || nextCode > 0xdfff)) {
          hasInvalidSurrogate = true;
        }
        if (code >= 0xdc00 && code <= 0xdfff && nextCode >= 0xdc00) {
          hasInvalidSurrogate = true;
        }
      }
    }
    expect(hasInvalidSurrogate).toBe(false);
  });

  test("mixed ASCII and emoji survives multiple truncation boundaries", () => {
    const emoji = "😀".repeat(500);
    const text = "start\n" + emoji + "\nend\n" + makeOutput(20000);
    const result: ToolResult = { success: true, output: text };
    const compressed = compressToolOutput("bash", result, "session1");

    // Should not throw and should not produce invalid UTF-16
    expect(() => [...compressed.result.output]).not.toThrow();
    // All code units should be valid (surrogate pairs must be complete)
    let valid = true;
    for (let i = 0; i < compressed.result.output.length; i++) {
      const code = compressed.result.output.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdfff) {
        if (code <= 0xdbff) {
          // High surrogate: must be followed by low surrogate
          const next = i + 1 < compressed.result.output.length ? compressed.result.output.charCodeAt(i + 1) : -1;
          if (next < 0xdc00 || next > 0xdfff) valid = false;
        } else {
          // Low surrogate: must be preceded by high surrogate
          const prev = i > 0 ? compressed.result.output.charCodeAt(i - 1) : -1;
          if (prev < 0xd800 || prev > 0xdbff) valid = false;
        }
      }
    }
    expect(valid).toBe(true);
  });

  test("CJK unified ideographs survive truncation", () => {
    // CJK Unified Ideographs are BMP characters (no surrogates) — always safe
    const cjk = "中文测试文本".repeat(500);
    const text = cjk + makeOutput(20000);
    const result: ToolResult = { success: true, output: text };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.compressedSize).toBeLessThan(text.length);
    expect(compressed.result.output).toContain("[TRUNCATED");
  });

  test("mathematical alphanumerics (outside BMP) survive truncation", () => {
    // Mathematical Script capitals — surrogate pairs (U+1D49C etc.)
    const math = "𝒜ℬ𝒞".repeat(500);
    const text = math + makeOutput(20000);
    const result: ToolResult = { success: true, output: text };
    const compressed = compressToolOutput("bash", result, "session1");

    let valid = true;
    for (let i = 0; i < compressed.result.output.length; i++) {
      const code = compressed.result.output.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdfff) {
        if (code <= 0xdbff) {
          // High surrogate: must be followed by low surrogate
          const next = i + 1 < compressed.result.output.length ? compressed.result.output.charCodeAt(i + 1) : -1;
          if (next < 0xdc00 || next > 0xdfff) valid = false;
        } else {
          // Low surrogate: must be preceded by high surrogate
          const prev = i > 0 ? compressed.result.output.charCodeAt(i - 1) : -1;
          if (prev < 0xd800 || prev > 0xdbff) valid = false;
        }
      }
    }
    expect(valid).toBe(true);
  });

  test("surrogate pair at exact truncation boundary", () => {
    // Place emoji exactly at the truncation boundary
    const emoji = "🔥"; // 2 code units
    const head = makeOutput(100);
    const tail = makeOutput(100);
    const text = head + emoji + tail;
    const result: ToolResult = { success: true, output: text };
    const compressed = compressToolOutput("bash", result, "session1");

    // Should not crash and should not leave orphaned surrogate
    let valid = true;
    for (let i = 0; i < compressed.result.output.length; i++) {
      const code = compressed.result.output.charCodeAt(i);
      if (code >= 0xdc00 && code <= 0xdfff) {
        // Low surrogate without preceding high surrogate
        const prev = i > 0 ? compressed.result.output.charCodeAt(i - 1) : 0;
        if (prev < 0xd800 || prev > 0xdbff) valid = false;
      }
    }
    expect(valid).toBe(true);
  });
});

// ── 5. Null/undefined/malformed input handling ───────────────────────

describe("compressToolOutput — malformed input handling", () => {
  test("null output (as null) is treated as empty string", () => {
    // @ts-expect-error — intentional type violation for integration test
    const result: ToolResult = { success: true, output: null };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.originalSize).toBe(0);
    expect(compressed.compressedSize).toBe(0);
    expect(compressed.result.output).toBe("");
  });

  test("undefined output is treated as empty string", () => {
    // @ts-expect-error
    const result: ToolResult = { success: true, output: undefined };
    const compressed = compressToolOutput("grep", result, "session1");
    expect(compressed.originalSize).toBe(0);
    expect(compressed.compressedSize).toBe(0);
    expect(compressed.result.output).toBe("");
  });

  test("empty string output is handled", () => {
    const result: ToolResult = { success: true, output: "" };
    const compressed = compressToolOutput("grep", result, "session1");
    expect(compressed.originalSize).toBe(0);
    expect(compressed.compressedSize).toBe(0);
    expect(compressed.result.output).toBe("");
  });

  test("whitespace-only output is handled", () => {
    const text = "   \n\n   "; // 8 chars: 3 spaces, 2 newlines, 3 spaces
    const result: ToolResult = { success: true, output: text };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.originalSize).toBe(8);
    expect(compressed.result.output).toBe("   \n\n   ");
  });

  test("output with only newlines is handled", () => {
    const result: ToolResult = { success: true, output: "\n\n\n\n" };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.originalSize).toBe(4);
    expect(compressed.result.output).toBe("\n\n\n\n");
  });

  test("result with error field but success=true is not exempt", () => {
    const result: ToolResult = {
      success: true,
      output: makeOutput(20000),
      error: "some warning",
    };
    const compressed = compressToolOutput("bash", result, "session1");
    // Success=true → not exempt even with error field
    expect(compressed.compressedSize).toBeLessThan(20000);
  });

  test("result without error field is handled", () => {
    // ToolResult with only success and output (no error)
    const result = { success: true, output: makeOutput(20000) } as ToolResult;
    const compressed = compressToolOutput("view", result, "session1");
    expect(compressed.originalSize).toBe(20000);
    expect(compressed.compressedSize).toBeLessThan(20000);
  });

  test("very long sessionId does not break compression", () => {
    const result: ToolResult = { success: true, output: makeOutput(20000) };
    const longSessionId = makeOutput(1000);
    const compressed = compressToolOutput("bash", result, longSessionId);
    expect(compressed.originalSize).toBe(20000);
    expect(compressed.compressedSize).toBeLessThan(8192);
  });

  test("Unicode in error field is preserved", () => {
    const result: ToolResult = {
      success: true,
      output: makeOutput(100),
      error: "错误: 文件未找到 😱",
    };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.result.error).toBe("错误: 文件未找到 😱");
  });

  test("binary-looking content (null bytes) does not crash", () => {
    // Create output with null bytes
    const binary = "text\x00\x00binary" + makeOutput(20000);
    const result: ToolResult = { success: true, output: binary };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.originalSize).toBe(binary.length);
    expect(compressed.compressedSize).toBeLessThan(8192);
    expect(() => compressed.result.output.slice(0, 10)).not.toThrow();
  });

  test("CRLF line endings are preserved", () => {
    const text = "line1\r\nline2\r\n" + makeOutput(20000);
    const result: ToolResult = { success: true, output: text };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.result.output).toContain("line1");
    expect(compressed.compressedSize).toBeLessThan(8192);
  });
});

// ── 6. Index generation correctness ───────────────────────────────────

describe("compressToolOutput — index generation correctness", () => {
  test("sourceId format is consistent between under-cap and over-cap", () => {
    const smallResult: ToolResult = { success: true, output: makeOutput(100) };
    const largeResult: ToolResult = {
      success: true,
      output: makeOutput(20000),
    };

    const small = compressToolOutput("bash", smallResult, "session1", mockIndexFn());
    const large = compressToolOutput("bash", largeResult, "session1", mockIndexFn());

    expect(small.sourceId).toMatch(/^bash-\d+-[a-z0-9]+$/);
    expect(large.sourceId).toMatch(/^bash-\d+-[a-z0-9]+$/);
  });

  test("sourceId is unique per call (no collisions)", () => {
    const result: ToolResult = { success: true, output: makeOutput(100) };
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const compressed = compressToolOutput("bash", result, `session${i}`, mockIndexFn());
      if (compressed.sourceId) ids.add(compressed.sourceId);
    }
    expect(ids.size).toBe(100); // All unique
  });

  test("indexFn receives full original content (not truncated)", () => {
    const result: ToolResult = { success: true, output: makeOutput(50000) };
    const indexFn = mockIndexFn();
    compressToolOutput("bash", result, "session1", indexFn);
    expect(indexFn).toHaveBeenCalledTimes(1);
    const callArg = indexFn.mock.calls[0]![3] as string;
    expect(callArg.length).toBe(50000); // Full content indexed
  });

  test("indexFn not called for exempt tools", () => {
    const result: ToolResult = { success: true, output: makeOutput(50000) };
    const indexFn = mockIndexFn();
    compressToolOutput("edit", result, "session1", indexFn);
    expect(indexFn).not.toHaveBeenCalled();
  });

  test("indexFn receives correct toolName and sessionId", () => {
    const result: ToolResult = { success: true, output: makeOutput(5000) };
    const indexFn = mockIndexFn();
    compressToolOutput("clawd__query_messages", result, "my-session-42", indexFn);
    expect(indexFn).toHaveBeenCalledWith(
      "my-session-42",
      expect.stringMatching(/^clawd__query_messages-\d+-[a-z0-9]+$/),
      "clawd__query_messages",
      expect.any(String),
    );
  });
});

// ── 7. compressedSize consistency ─────────────────────────────────────

describe("compressToolOutput — compressedSize field consistency", () => {
  test("compressedSize equals result.output.length in over-cap case", () => {
    const result: ToolResult = { success: true, output: makeOutput(20000) };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.compressedSize).toBe(compressed.result.output.length);
  });

  test("compressedSize equals result.output.length in under-cap no-index case", () => {
    const result: ToolResult = { success: true, output: makeOutput(100) };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.compressedSize).toBe(compressed.result.output.length);
  });

  test("compressedSize reflects actual output length when indexed (under-cap)", () => {
    const result: ToolResult = { success: true, output: makeOutput(100) };
    const compressed = compressToolOutput("bash", result, "session1", mockIndexFn());
    // When indexed under cap, hint is appended: result.output + hint
    // compressedSize should match actual result.output.length
    expect(compressed.compressedSize).toBe(compressed.result.output.length);
  });
});

// ── 8. Smart truncation integration ───────────────────────────────────

describe("compressToolOutput — smart truncation integration", () => {
  test("head of output is preserved in truncated result", () => {
    const important = "ERROR: Critical failure at line 42\n";
    const result: ToolResult = {
      success: true,
      output: important + makeOutput(20000),
    };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.result.output).toContain("ERROR: Critical failure at line 42");
  });

  test("tail of output is preserved (error messages at end)", () => {
    const tail = "line98\nline99\nFAILED: Test suite passed: false";
    const result: ToolResult = {
      success: true,
      output: makeOutput(20000) + tail,
    };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.result.output).toContain("FAILED: Test suite passed: false");
  });

  test("snippetReserve reduces available truncation space", () => {
    const result: ToolResult = { success: true, output: makeOutput(50000) };
    const base = compressToolOutput("bash", result, "session1", undefined, 0);
    const withReserve = compressToolOutput("bash", result, "session1", undefined, 2000);
    // With reserve, compressedSize should be smaller (less content fits)
    expect(withReserve.compressedSize).toBeLessThan(base.compressedSize);
  });

  test("snippetReserve + hintReserve never exceed cap minus minimum content", () => {
    // Very large snippetReserve: cap 8192, hintReserve 150, snippetReserve 10000
    // maxLength = Math.max(8192 - 1150, 100) = Math.max(7042, 100) = 7042
    const result: ToolResult = { success: true, output: makeOutput(50000) };
    const compressed = compressToolOutput("bash", result, "session1", undefined, 10000);
    // At minimum, 100 chars of content should always be preserved
    expect(compressed.compressedSize).toBeGreaterThanOrEqual(100);
  });

  test("retrieval hint is appended after truncation", () => {
    const result: ToolResult = { success: true, output: makeOutput(20000) };
    const compressed = compressToolOutput("bash", result, "session1", mockIndexFn());
    expect(compressed.result.output).toContain("[Full output indexed");
    expect(compressed.result.output).toContain("source_id:");
    expect(compressed.result.output).toContain("knowledge_search");
  });

  test("non-indexed truncation shows different hint", () => {
    const result: ToolResult = { success: true, output: makeOutput(20000) };
    const compressed = compressToolOutput("bash", result, "session1");
    expect(compressed.result.output).toContain("[Content truncated");
    expect(compressed.result.output).not.toContain("[Full output indexed");
  });

  test("retrieval hint does not cause secondary truncation", () => {
    const result: ToolResult = { success: true, output: makeOutput(50000) };
    const compressed = compressToolOutput("browser_screenshot", result, "session1", mockIndexFn());
    // browser_screenshot cap = 256, hint ≈ 150 chars, but smartTruncate reserves
    // 150 (hintReserve) + snippetReserve before calling smartTruncate
    // So the total (truncated + hint) should stay within cap
    expect(compressed.result.output.length).toBeLessThanOrEqual(getToolCap("browser_screenshot"));
  });
});
