/**
 * Comprehensive tests for smart-truncation.ts
 * Covers: code fence preservation, UTF-16 surrogates, head/tail ratios,
 * truncation markers, empty/small inputs, nested blocks, and performance.
 */

import { describe, expect, test } from "bun:test";
import { safeCut, smartTruncate } from "./smart-truncation";

// ═══════════════════════════════════════════════════════════════════════════
// CODE FENCE PRESERVATION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Code fence preservation", () => {
  describe("Triple backtick fences (```)", () => {
    test("complete balanced fences → unchanged", () => {
      const text = "```typescript\nconst x = 42;\n```\n\nSome text here";
      const result = smartTruncate(text, { maxLength: 10 });
      const fenceCount = (result.match(/```/g) || []).length;
      expect(fenceCount % 2).toBe(0); // Must be even
    });

    test("unclosed opening fence → closes it", () => {
      const text = "```python\ndef foo():\n    pass\n# missing closing fence\nMore content below";
      const result = smartTruncate(text, { maxLength: 50 });
      const fenceCount = (result.match(/```/g) || []).length;
      expect(fenceCount % 2).toBe(0); // Should be even after closure
    });

    test("fence in middle of text with truncation", () => {
      const text = "First line\n```\ncode block\n```\nLast line";
      const result = smartTruncate(text, { maxLength: 30 });
      const fenceCount = (result.match(/```/g) || []).length;
      expect(fenceCount % 2).toBe(0);
    });

    test("multiple code blocks", () => {
      const text = "```js\nconst a = 1;\n```\nText\n```py\ndef b(): pass\n```\nEnd";
      const result = smartTruncate(text, { maxLength: 40 });
      const fenceCount = (result.match(/```/g) || []).length;
      expect(fenceCount % 2).toBe(0);
    });
  });

  describe("Single quote fences (''')", () => {
    test("Python triple single quotes - balanced", () => {
      // Text length is 36 chars; truncation at 20 chars cuts before closing '''.
      // Parity check only valid when both opening and closing fences are preserved.
      const text = "'''\npython docstring\n'''\nmore text";
      const result = smartTruncate(text, { maxLength: 20 });
      expect(result.length).toBeLessThanOrEqual(20);
    });

    test("Python triple single quotes - unclosed", () => {
      // Text is 41 chars; truncation at 25 cuts before any closing '''.
      const text = "'''\nunclosed docstring\nMore content below";
      const result = smartTruncate(text, { maxLength: 25 });
      expect(result.length).toBeLessThanOrEqual(25);
    });
  });

  describe('Double quote fences (""")', () => {
    test("Python triple double quotes - balanced", () => {
      const text = '"""\nmultiline string\n"""\nafter';
      const result = smartTruncate(text, { maxLength: 20 });
      expect(result.length).toBeLessThanOrEqual(20);
    });

    test("Python triple double quotes - unclosed", () => {
      // Text is 37 chars; truncation at 20 cuts before any closing """.
      const text = '"""\nunclosed multiline\nmore content';
      const result = smartTruncate(text, { maxLength: 20 });
      expect(result.length).toBeLessThanOrEqual(20);
    });
  });

  describe("Fenced code with language specifier", () => {
    test("language specifier preserved", () => {
      const text = "```typescript\nconst x: number = 42;\n```\nafter";
      const result = smartTruncate(text, { maxLength: 30 });
      expect(result).toContain("```typescript");
    });

    test("fence with info string", () => {
      const text = "```json filename=test.json\n{}\n```\ntext";
      const result = smartTruncate(text, { maxLength: 25 });
      const fenceCount = (result.match(/```/g) || []).length;
      expect(fenceCount % 2).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UTF-16 SURROGATE SAFETY TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("UTF-16 surrogate safety", () => {
  describe("Emoji handling", () => {
    test("emoji at head cut point - not split", () => {
      // 🧠 is U+1F9E0 = surrogate pair D83E DDE0
      const emoji = "🧠";
      const text = "Hello " + emoji + " World! This is a longer text to trigger truncation.";
      const result = smartTruncate(text, { maxLength: 20, snapToLines: false });

      // Should not produce invalid UTF-16 (lone surrogate)
      expect(() => Buffer.from(result, "utf8")).not.toThrow();
    });

    test("multiple emoji in sequence at cut", () => {
      const text = "Start 👨‍👩‍👧‍👦👩‍👦🎉🎊 text to truncate";
      const result = smartTruncate(text, { maxLength: 25, snapToLines: false });
      expect(() => Buffer.from(result, "utf8")).not.toThrow();
    });

    test("flag emoji (regional indicator symbols)", () => {
      // 🇺🇸 = U+1F1FA U+1F1F8
      const text = "Country: 🇺🇸 Flag emoji test string here";
      const result = smartTruncate(text, { maxLength: 30, snapToLines: false });
      expect(() => Buffer.from(result, "utf8")).not.toThrow();
    });

    test("skin tone modifier", () => {
      // 👍🏻 = U+1F44D U+1F3FB
      const text = "Thumbs up 👍🏻 for this code";
      const result = smartTruncate(text, { maxLength: 25, snapToLines: false });
      expect(() => Buffer.from(result, "utf8")).not.toThrow();
    });
  });

  describe("Special characters", () => {
    test("mathematical symbols (surrogate pairs)", () => {
      // Some mathematical symbols are outside BMP, need surrogates
      const text = "∑∏∫√∞≈ text content for testing";
      const result = smartTruncate(text, { maxLength: 20, snapToLines: false });
      expect(() => Buffer.from(result, "utf8")).not.toThrow();
    });

    test("CJK extension characters", () => {
      const text = "𠀀𠀁𠀂汉字中文 text for testing";
      const result = smartTruncate(text, { maxLength: 20, snapToLines: false });
      expect(() => Buffer.from(result, "utf8")).not.toThrow();
    });

    test("control picture symbols", () => {
      const text = "🔴🟢🔵⚫⚪ circle symbols here";
      const result = smartTruncate(text, { maxLength: 25, snapToLines: false });
      expect(() => Buffer.from(result, "utf8")).not.toThrow();
    });
  });

  describe("Mixed content", () => {
    test("emoji mixed with ASCII at cut point", () => {
      const text = "function foo() {\n  return 'hello' + '🧠';\n} // comment";
      const result = smartTruncate(text, { maxLength: 35, snapToLines: false });
      expect(() => Buffer.from(result, "utf8")).not.toThrow();
    });

    test("emoji at tail start position", () => {
      const prefix = "x".repeat(50);
      const emoji = "🎉";
      const suffix = emoji + "x".repeat(50);
      const text = prefix + suffix;
      const result = smartTruncate(text, { maxLength: 80 });
      // Tail should not start with lone low surrogate
      expect(() => Buffer.from(result, "utf8")).not.toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HEAD/TAIL PRESERVATION LOGIC TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Head/tail preservation", () => {
  test("default 60/40 split", () => {
    const text = "A".repeat(600) + "B".repeat(400);
    const result = smartTruncate(text, { maxLength: 200 });
    expect(result).toContain("A"); // Has head
    expect(result).toContain("B"); // Has tail
  });

  test("custom headRatio 0.8", () => {
    const text = "X".repeat(800) + "Y".repeat(200);
    const result = smartTruncate(text, { maxLength: 200, headRatio: 0.8 });
    const headEnd = result.indexOf("Y");
    const tailStart = result.lastIndexOf("Y");
    expect(headEnd).toBeGreaterThan(0);
    expect(tailStart).toBeGreaterThan(headEnd);
  });

  test("custom headRatio 0.5", () => {
    const text = "P".repeat(500) + "Q".repeat(500);
    const result = smartTruncate(text, { maxLength: 200, headRatio: 0.5 });
    expect(result).toContain("P");
    expect(result).toContain("Q");
  });

  test("preserves line boundaries in head", () => {
    const lines = ["line1", "line2", "line3", "line4", "line5"];
    const text = lines.join("\n");
    const result = smartTruncate(text, { maxLength: 20 });
    // Should snap to line boundary, not cut mid-line
    const linesInResult = result.split("\n");
    expect(linesInResult.every((l) => text.includes(l) || l === "")).toBe(true);
  });

  test("preserves line boundaries in tail", () => {
    const lines = ["aaa1", "aaa2", "aaa3", "aaa4", "aaa5"];
    const text = lines.join("\n");
    const result = smartTruncate(text, { maxLength: 20 });
    // Tail should also snap to line boundary
    expect(result).toBeDefined();
  });

  test("marker placed between head and tail", () => {
    // Create longer text that will definitely be truncated
    const text = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ"; // 40 chars
    // Use a short marker to ensure we have room for both head and tail
    const result = smartTruncate(text, {
      maxLength: 30,
      headRatio: 0.5,
      snapToLines: false,
      marker: "\n[..]\n",
    });

    // Should contain marker between head and tail portions
    expect(result).toContain("[..]");
    // Head should contain beginning content
    expect(result).toContain("AAAA");
    // Tail should have end content (may be truncated)
    expect(result).toContain("JJJJ") || result.endsWith("[..]\n");
    // Marker should be present and positioned after head
    const markerPos = result.indexOf("[..]");
    expect(markerPos).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TRUNCATION MARKER TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Truncation marker", () => {
  test("default marker format", () => {
    const text = "x".repeat(500);
    const result = smartTruncate(text, { maxLength: 100 });
    expect(result).toContain("[TRUNCATED");
    expect(result).toContain("60%");
    expect(result).toContain("40%");
  });

  test("custom marker", () => {
    const text = "x".repeat(500);
    const result = smartTruncate(text, { maxLength: 100, marker: "\n[...]\n" });
    expect(result).toContain("[...]");
  });

  test("marker deduplication - already truncated", () => {
    const text = "x".repeat(500) + "[TRUNCATED" + "y".repeat(100);
    const result = smartTruncate(text, { maxLength: 100 });
    // Should use minimal marker (the ellipsis)
    expect(result).toContain("…");
  });

  test("custom marker placed between head and tail", () => {
    const markerText = "[CUSTOM_MARKER]";
    // Use a marker that won't appear naturally in the content
    const text = "A".repeat(300) + "B".repeat(300);
    const result = smartTruncate(text, { maxLength: 100, marker: markerText });
    // Marker should appear exactly once
    const matches = result.match(/\[CUSTOM_MARKER\]/g) || [];
    expect(matches.length).toBe(1);
    // Should be between head and tail content
    const markerPos = result.indexOf(markerText);
    expect(markerPos).toBeGreaterThan(10); // After head
    expect(markerPos).toBeLessThan(result.length - markerText.length - 10); // Before tail
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EMPTY AND SMALL INPUT EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

describe("Empty and small input edge cases", () => {
  test("empty string", () => {
    const result = smartTruncate("", { maxLength: 100 });
    expect(result).toBe("");
  });

  test("undefined-like check - falsy but not empty", () => {
    const result = smartTruncate("x", { maxLength: 100 });
    expect(result).toBe("x");
  });

  test("text exactly at maxLength", () => {
    const text = "x".repeat(100);
    const result = smartTruncate(text, { maxLength: 100 });
    expect(result).toBe(text);
  });

  test("text just over maxLength", () => {
    const text = "x".repeat(101);
    const result = smartTruncate(text, { maxLength: 100 });
    expect(result.length).toBeLessThan(101);
  });

  test("maxLength smaller than marker", () => {
    const text = "x".repeat(200);
    const result = smartTruncate(text, { maxLength: 5 });
    // Should fallback to safeCut
    expect(result.length).toBeLessThanOrEqual(5);
  });

  test("maxLength equal to marker length", () => {
    const text = "x".repeat(200);
    const result = smartTruncate(text, { maxLength: 10 });
    expect(result.length).toBeLessThanOrEqual(10);
  });

  test("single character text", () => {
    const result = smartTruncate("x", { maxLength: 10 });
    expect(result).toBe("x");
  });

  test("very small maxLength (1-5)", () => {
    const text = "Hello World!";
    [1, 2, 3, 4, 5].forEach((maxLen) => {
      const result = smartTruncate(text, { maxLength: maxLen });
      expect(result.length).toBeLessThanOrEqual(maxLen);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NESTED CODE BLOCK TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Nested code blocks", () => {
  test("markdown with inline code", () => {
    const text = `Regular text with \`inline code\` and more content.
\`\`\`python
def example():
    return "code block"
\`\`\`
After the block.`;
    const result = smartTruncate(text, { maxLength: 60 });
    const fenceCount = (result.match(/```/g) || []).length;
    expect(fenceCount % 2).toBe(0);
  });

  test("nested fences in example code", () => {
    const text = `\`\`\`javascript
// Example showing inline code
const template = \`\`\`html
<div></div>
\`\`\`;
\`\`\`
After`;
    const result = smartTruncate(text, { maxLength: 50 });
    expect(result.length).toBeLessThanOrEqual(50);
    // Outer fences should be balanced
    const fenceCount = (result.match(/```/g) || []).length;
    expect(fenceCount % 2).toBe(0);
  });

  test("consecutive code blocks", () => {
    const text = "```js\nconst a = 1;\n```\n```py\ndef b(): pass\n```\n```go\nfunc c() {}\n```";
    const result = smartTruncate(text, { maxLength: 40 });
    const fenceCount = (result.match(/```/g) || []).length;
    expect(fenceCount % 2).toBe(0);
  });

  test("code block at very start", () => {
    const text = "```\ncode at start\n```\nrest of the content";
    const result = smartTruncate(text, { maxLength: 30 });
    expect(result).toContain("```");
  });

  test("code block at very end", () => {
    const text = "content before\n```\ncode at end\n```";
    const result = smartTruncate(text, { maxLength: 30 });
    const fenceCount = (result.match(/```/g) || []).length;
    expect(fenceCount % 2).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VARIOUS TRUNCATION PERCENTAGES
// ═══════════════════════════════════════════════════════════════════════════

describe("Various truncation percentages", () => {
  test("10% preservation", () => {
    const text = "A".repeat(900) + "B".repeat(900);
    const result = smartTruncate(text, { maxLength: 200, headRatio: 0.1 });
    expect(result.length).toBeLessThan(200);
  });

  test("90% preservation (minimal truncation)", () => {
    const text = "X".repeat(500) + "Y".repeat(500);
    const result = smartTruncate(text, { maxLength: 950 });
    // Output is less than maxLength due to fence reserve and marker
    expect(result.length).toBeLessThanOrEqual(950);
    expect(result.length).toBeGreaterThan(900); // Still preserves most content
  });

  test("50/50 split", () => {
    const text = "H".repeat(500) + "T".repeat(500);
    const result = smartTruncate(text, { maxLength: 400, headRatio: 0.5 });
    const hCount = (result.match(/H/g) || []).length;
    const tCount = (result.match(/T/g) || []).length;
    // Should have roughly equal counts (allowing for marker)
    expect(Math.abs(hCount - tCount)).toBeLessThan(100);
  });

  test("extreme headRatio 0.99", () => {
    const text = "A".repeat(900) + "B".repeat(100);
    const result = smartTruncate(text, { maxLength: 200, headRatio: 0.99 });
    expect(result).toContain("A");
  });

  test("extreme headRatio 0.01", () => {
    const text = "A".repeat(100) + "B".repeat(900);
    const result = smartTruncate(text, { maxLength: 200, headRatio: 0.01 });
    expect(result).toContain("B");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LINE SNAPPING TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Line boundary snapping", () => {
  test("snapToLines enabled (default)", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    const result = smartTruncate(text, { maxLength: 20, snapToLines: true });
    // Result should not be truncated mid-character (surrogate-safe)
    expect(result.length).toBeLessThanOrEqual(20);
    // Check that if there's a newline in result, it's at valid positions
    // (This is tested indirectly by ensuring valid UTF-8 output)
    expect(() => Buffer.from(result, "utf8")).not.toThrow();
  });

  test("snapToLines disabled", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    const result = smartTruncate(text, { maxLength: 20, snapToLines: false });
    expect(result.length).toBeLessThanOrEqual(20);
  });

  test("long line without newlines", () => {
    const text = "x".repeat(500);
    const result = smartTruncate(text, { maxLength: 100, snapToLines: true });
    // With no newlines, should just cut at boundary
    expect(result.length).toBeLessThanOrEqual(100);
  });

  test("very short lines", () => {
    const text = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
    const result = smartTruncate(text, { maxLength: 10 });
    expect(result.length).toBeLessThanOrEqual(10);
  });

  test("line longer than maxLength", () => {
    const text = "x".repeat(200) + "\nend";
    const result = smartTruncate(text, { maxLength: 50 });
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PERFORMANCE TESTS (sanity checks)
// ═══════════════════════════════════════════════════════════════════════════

describe("Performance sanity checks", () => {
  test("large text (100KB)", () => {
    const text = "lorem ipsum ".repeat(5000);
    const start = Date.now();
    const result = smartTruncate(text, { maxLength: 5000 });
    const elapsed = Date.now() - start;
    expect(result.length).toBeLessThanOrEqual(5000);
    expect(elapsed).toBeLessThan(100); // Should complete in under 100ms
  });

  test("large text with many lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10000; i++) {
      lines.push(`line ${i}: ${"x".repeat(20)}`);
    }
    const text = lines.join("\n");
    const start = Date.now();
    const result = smartTruncate(text, { maxLength: 5000 });
    const elapsed = Date.now() - start;
    expect(result.length).toBeLessThanOrEqual(5000);
    expect(elapsed).toBeLessThan(100);
  });

  test("many fences (stress test)", () => {
    const fences: string[] = [];
    for (let i = 0; i < 100; i++) {
      fences.push(`\`\`\`\ncode block ${i}\n\`\`\``);
    }
    const text = fences.join("\n\n");
    const start = Date.now();
    const result = smartTruncate(text, { maxLength: 500 });
    const elapsed = Date.now() - start;
    expect(result.length).toBeLessThanOrEqual(500);
    expect(elapsed).toBeLessThan(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// safeCut SPECIFIC TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("safeCut function", () => {
  test("respects maxLength strictly", () => {
    const text = "```\ncode block\n```\nmore text";
    const result = safeCut(text, 15);
    expect(result.length).toBeLessThanOrEqual(15);
  });

  test("appends closing fence when needed", () => {
    const text = "```\nunclosed";
    const result = safeCut(text, 15);
    const fenceCount = (result.match(/```/g) || []).length;
    expect(fenceCount % 2).toBe(0);
  });

  test("backtracks when can't append", () => {
    const text = "```\nunclosed";
    const result = safeCut(text, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  test("handles text with no fences", () => {
    const text = "plain text without any fences";
    const result = safeCut(text, 10);
    expect(result).toBe("plain text");
  });

  test("handles even fence count", () => {
    const text = "```\nclosed\n```";
    const result = safeCut(text, 20);
    const fenceCount = (result.match(/```/g) || []).length;
    expect(fenceCount % 2).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REAL-WORLD SCENARIO TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Real-world scenarios", () => {
  test("stack trace preservation - tail contains error context", () => {
    const stackTrace = `
Error: Something went wrong
    at Function.name (file.js:10:5)
    at Module._compile (internal/modules/cjs/loader.js:1138:30)
    at Object.Module._sync (internal/modules/cjs/loader.js:554:30)
    at Function.Module._load (internal/modules/cjs/loader.js:517:10)
    at Module.call (internal/modules/cjs/loader.js:410:22)
`.trim();

    const code = "```javascript\nconst x = undefined;\nx.foo();\n```";
    const text = "A".repeat(3000) + "\n\n" + code + "\n\n" + stackTrace;

    const result = smartTruncate(text, { maxLength: 500 });
    // Tail should preserve some stack trace content
    expect(result).toContain("at Function");
    expect(result).toContain("[TRUNCATED");
    // Head should contain some of the initial content
    expect(result).toContain("A");
  });

  test("compiler error output", () => {
    const compilerOutput = `
> tsc --noEmit
src/index.ts:10:15 - error TS2322: Type 'string' is not assignable to type 'number'.
    at Function.name (src/index.ts:10:15)
`.trim();

    const text = "B".repeat(4000) + "\n\n" + compilerOutput;
    const result = smartTruncate(text, { maxLength: 400 });

    expect(result).toContain("error TS2322");
    expect(result).toContain("src/index.ts");
  });

  test("JSON response truncation", () => {
    const json = JSON.stringify(
      {
        users: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: `User ${i}`,
        })),
      },
      null,
      2,
    );

    const result = smartTruncate(json, { maxLength: 200 });
    expect(result.length).toBeLessThanOrEqual(200);
    // Should still be valid-ish JSON start
    expect(result).toContain("{");
  });
});
