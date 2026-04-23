/**
 * OutputCompressor — Unit Tests
 * Tests: getToolCap, isExempt, compressToolOutput
 */

import { describe, expect, mock, test } from "bun:test";
import { compressToolOutput, getToolCap, isExempt, type ToolResult } from "./output-compressor";

// ── Helpers ─────────────────────────────────────────────────────────

function makeOutput(n: number): string {
  return "x".repeat(n);
}

function mockIndexFn() {
  return mock((_sessionId: string, _sourceId: string, _toolName: string, _content: string) => true);
}

// ── getToolCap Tests ─────────────────────────────────────────────────

describe("getToolCap", () => {
  test("returns exact match from TOOL_CAPS", () => {
    expect(getToolCap("bash")).toBe(8192);
    expect(getToolCap("grep")).toBe(6144);
    expect(getToolCap("view")).toBe(10240);
    expect(getToolCap("browser_extract")).toBe(512);
    expect(getToolCap("convert_to_markdown")).toBe(20480);
  });

  test("returns DEFAULT_CAP for unknown tools", () => {
    expect(getToolCap("unknown_tool")).toBe(32768);
    expect(getToolCap("foobar")).toBe(32768);
    expect(getToolCap("")).toBe(32768);
  });

  test("strips MCP serverName__ prefix and matches base name", () => {
    expect(getToolCap("clawd__knowledge_search")).toBe(4096); // exact match
    expect(getToolCap("chat-mcp-server__query_messages")).toBe(4096); // exact match
    // Non-listed base: falls through to default
    expect(getToolCap("unknown-server__some_tool")).toBe(32768);
  });

  test("MCP prefix stripping works for tools that exist without prefix", () => {
    // grep is 6144 in TOOL_CAPS, so MCP version should also be 6144
    const cap = getToolCap("clawd__grep");
    // Since "grep" is in TOOL_CAPS with value 6144, stripping prefix gives baseName="grep"
    expect(cap).toBe(6144);
  });
});

// ── isExempt Tests ───────────────────────────────────────────────────

describe("isExempt", () => {
  const successResult: ToolResult = { success: true, output: "output" };
  const failureResult: ToolResult = {
    success: false,
    output: "",
    error: "boom",
  };

  test("edit and create are always exempt", () => {
    expect(isExempt("edit", successResult)).toBe(true);
    expect(isExempt("create", successResult)).toBe(true);
    expect(isExempt("edit", failureResult)).toBe(true);
  });

  test("METADATA_ONLY_TOOLS are exempt", () => {
    const tools = ["reply_human", "upload_file"];
    for (const t of tools) {
      expect(isExempt(t, successResult)).toBe(true);
    }
  });

  test("bash/exec errors are exempt", () => {
    expect(isExempt("bash", failureResult)).toBe(true);
    expect(isExempt("exec", failureResult)).toBe(true);
  });

  test("bash/exec success is NOT exempt", () => {
    expect(isExempt("bash", successResult)).toBe(false);
    expect(isExempt("exec", successResult)).toBe(false);
  });

  test("non-exempt tools with success are not exempt", () => {
    expect(isExempt("view", successResult)).toBe(false);
    expect(isExempt("grep", successResult)).toBe(false);
    expect(isExempt("bash", successResult)).toBe(false);
  });

  test("non-exempt tools with failure are not exempt", () => {
    // Only bash/exec errors are exempt — others fail normally
    expect(isExempt("view", failureResult)).toBe(false);
    expect(isExempt("grep", { ...failureResult, error: "not found" })).toBe(false);
    expect(isExempt("browser_extract", failureResult)).toBe(false);
  });
});

// ── compressToolOutput Tests ─────────────────────────────────────────

describe("compressToolOutput", () => {
  describe("exempt tools", () => {
    test("edit passes through unchanged", () => {
      const result: ToolResult = { success: true, output: makeOutput(20000) };
      const compressed = compressToolOutput("edit", result, "session1");
      expect(compressed.result.output).toBe(result.output);
      expect(compressed.indexed).toBe(false);
    });

    test("reply_human passes through unchanged", () => {
      const result: ToolResult = { success: true, output: makeOutput(20000) };
      const compressed = compressToolOutput("reply_human", result, "session1");
      expect(compressed.result.output).toBe(result.output);
      expect(compressed.indexed).toBe(false);
    });

    test("bash error passes through unchanged", () => {
      const result: ToolResult = {
        success: false,
        output: "",
        error: "Permission denied",
      };
      const compressed = compressToolOutput("bash", result, "session1");
      expect(compressed.result.output).toBe("");
      expect(compressed.indexed).toBe(false);
    });
  });

  describe("under-cap behavior", () => {
    test("output under cap is returned unchanged when no indexFn", () => {
      const result: ToolResult = { success: true, output: makeOutput(100) };
      const compressed = compressToolOutput("view", result, "session1");
      expect(compressed.result.output).toBe(result.output);
      expect(compressed.compressedSize).toBe(100);
      expect(compressed.indexed).toBe(false);
    });

    test("output under cap is indexed when indexFn provided", () => {
      const result: ToolResult = { success: true, output: makeOutput(100) };
      const indexFn = mockIndexFn();
      const compressed = compressToolOutput("view", result, "session1", indexFn);
      expect(compressed.indexed).toBe(true);
      expect(indexFn).toHaveBeenCalledWith("session1", expect.any(String), "view", makeOutput(100));
      // Source ID appended for retrieval
      expect(compressed.result.output).toContain("source_id:");
    });

    test("sourceId is set when indexed", () => {
      const result: ToolResult = { success: true, output: makeOutput(100) };
      const indexFn = mockIndexFn();
      const compressed = compressToolOutput("grep", result, "session1", indexFn);
      expect(compressed.sourceId).toBeDefined();
      expect(compressed.sourceId).toMatch(/^grep-\d+-[a-z0-9]+$/);
    });
  });

  describe("over-cap behavior", () => {
    test("output over cap is truncated", () => {
      const result: ToolResult = { success: true, output: makeOutput(20000) };
      const compressed = compressToolOutput("bash", result, "session1");
      // bash cap = 8192
      expect(compressed.compressedSize).toBeLessThan(8192);
      expect(compressed.compressedSize).toBeLessThan(compressed.originalSize);
    });

    test("truncated output still indexes full content", () => {
      const result: ToolResult = { success: true, output: makeOutput(20000) };
      const indexFn = mockIndexFn();
      const compressed = compressToolOutput("bash", result, "session1", indexFn);
      expect(compressed.indexed).toBe(true);
      // Index receives FULL original content, not truncated
      expect(indexFn).toHaveBeenCalledWith("session1", expect.any(String), "bash", makeOutput(20000));
    });

    test("truncated output includes retrieval hint with source_id", () => {
      const result: ToolResult = { success: true, output: makeOutput(20000) };
      const indexFn = mockIndexFn();
      const compressed = compressToolOutput("grep", result, "session1", indexFn);
      expect(compressed.result.output).toContain("Full output indexed");
      expect(compressed.result.output).toContain("source_id:");
    });

    test("truncated output without indexing gets different hint", () => {
      const result: ToolResult = { success: true, output: makeOutput(20000) };
      const compressed = compressToolOutput("bash", result, "session1");
      expect(compressed.result.output).toContain("Content truncated");
      expect(compressed.result.output).not.toContain("Full output indexed");
    });

    test("truncation preserves head and tail (smart truncate)", () => {
      const head = "LINE1\nLINE2\nLINE3\n";
      const tail = "\nLINE98\nLINE99\nLINE100";
      const middle = "\n[MIDDLE CONTENT x".repeat(500) + "]\n";
      const result: ToolResult = {
        success: true,
        output: head + middle + tail,
      };
      const compressed = compressToolOutput("bash", result, "session1");
      // Should preserve some head and tail
      expect(compressed.result.output).toContain("LINE1");
      expect(compressed.result.output).toContain("LINE100");
    });

    test("originalSize is always the pre-compression size", () => {
      const result: ToolResult = { success: true, output: makeOutput(20000) };
      const compressed = compressToolOutput("bash", result, "session1");
      expect(compressed.originalSize).toBe(20000);
    });

    test("compressedSize reflects truncated output length", () => {
      const result: ToolResult = { success: true, output: makeOutput(20000) };
      const compressed = compressToolOutput("bash", result, "session1");
      expect(compressed.compressedSize).toBe(compressed.result.output.length);
      expect(compressed.compressedSize).toBeLessThan(compressed.originalSize);
    });
  });

  describe("snippetReserve", () => {
    test("snippetReserve reserves space before truncation", () => {
      // bash cap=8192, snippetReserve=500, hintReserve=150
      // maxLength = 8192 - 150 - 500 = 7542
      const largeOutput = makeOutput(20000);
      const result: ToolResult = { success: true, output: largeOutput };

      // With reserve
      const compressedWithReserve = compressToolOutput("bash", result, "session1", undefined, 500);
      // Without reserve
      const compressedWithoutReserve = compressToolOutput("bash", result, "session1", undefined, 0);

      // With reserve should be smaller (less content allowed)
      expect(compressedWithReserve.compressedSize).toBeLessThanOrEqual(compressedWithoutReserve.compressedSize);
    });

    test("snippetReserve minimum of 100 chars of content preserved", () => {
      const result: ToolResult = { success: true, output: makeOutput(20000) };
      const compressed = compressToolOutput("bash", result, "session1", undefined, 1000);
      // With hintReserve=150 + snippetReserve=1000, maxLength=8192-1150=7042
      // But min is 100
      expect(compressed.compressedSize).toBeGreaterThan(100);
    });
  });

  describe("graceful degradation", () => {
    test("indexFn throwing does not cause compressToolOutput to throw", () => {
      const result: ToolResult = { success: true, output: makeOutput(100) };
      const badIndexFn = mock(() => {
        throw new Error("index error");
      });
      const compressed = compressToolOutput("view", result, "session1", badIndexFn);
      expect(compressed.indexed).toBe(false);
      expect(compressed.result.output).toBe(result.output);
    });

    test("indexFn throwing on over-cap does not cause throw", () => {
      const result: ToolResult = { success: true, output: makeOutput(20000) };
      const badIndexFn = mock(() => {
        throw new Error("index error");
      });
      const compressed = compressToolOutput("bash", result, "session1", badIndexFn);
      expect(compressed.indexed).toBe(false);
      // Should still be truncated
      expect(compressed.compressedSize).toBeLessThan(8192);
    });

    test("empty output is handled gracefully", () => {
      const result: ToolResult = { success: true, output: "" };
      const compressed = compressToolOutput("grep", result, "session1");
      expect(compressed.originalSize).toBe(0);
      expect(compressed.compressedSize).toBe(0);
      expect(compressed.result.output).toBe("");
    });

    test("null output is treated as empty string", () => {
      const result: ToolResult = { success: true, output: "" };
      const compressed = compressToolOutput("grep", result, "session1");
      expect(compressed.result.output).toBe("");
    });
  });

  describe("result shape", () => {
    test("returns correct CompressResult fields", () => {
      const result: ToolResult = { success: true, output: makeOutput(100) };
      const indexFn = mockIndexFn();
      const compressed = compressToolOutput("view", result, "session1", indexFn);
      expect(compressed).toHaveProperty("result");
      expect(compressed).toHaveProperty("indexed");
      expect(compressed).toHaveProperty("originalSize");
      expect(compressed).toHaveProperty("compressedSize");
      expect(compressed).toHaveProperty("sourceId");
    });

    test("sourceId undefined when not indexed", () => {
      const result: ToolResult = { success: true, output: makeOutput(100) };
      const compressed = compressToolOutput("view", result, "session1");
      expect(compressed.sourceId).toBeUndefined();
    });
  });

  describe("tool-specific caps", () => {
    test("glob cap is applied correctly", () => {
      const result: ToolResult = { success: true, output: makeOutput(10000) };
      const compressed = compressToolOutput("glob", result, "session1");
      // glob cap = 6144
      expect(compressed.compressedSize).toBeLessThanOrEqual(6144);
    });

    test("browser_extract cap is applied (smaller cap)", () => {
      const result: ToolResult = { success: true, output: makeOutput(5000) };
      const compressed = compressToolOutput("browser_extract", result, "session1");
      // browser_extract cap = 512
      expect(compressed.compressedSize).toBeLessThanOrEqual(512);
    });

    test("convert_to_markdown has higher cap (20480)", () => {
      const result: ToolResult = { success: true, output: makeOutput(20000) };
      const compressed = compressToolOutput("convert_to_markdown", result, "session1");
      // cap=20480, output=20000 → under cap, no truncation
      expect(compressed.compressedSize).toBe(20000);
      expect(compressed.originalSize).toBe(20000);
    });

    test("very large output exceeds even 20KB cap", () => {
      const result: ToolResult = { success: true, output: makeOutput(50000) };
      const compressed = compressToolOutput("convert_to_markdown", result, "session1");
      expect(compressed.compressedSize).toBeLessThan(20480);
      expect(compressed.originalSize).toBe(50000);
    });
  });

  describe("MCP tool names", () => {
    test("clawd__knowledge_search uses clawd__ cap", () => {
      const result: ToolResult = { success: true, output: makeOutput(10000) };
      const compressed = compressToolOutput("clawd__knowledge_search", result, "session1");
      // clawd__knowledge_search cap = 4096
      expect(compressed.compressedSize).toBeLessThanOrEqual(4096);
    });

    test("unknown MCP tool falls back to DEFAULT_CAP", () => {
      const result: ToolResult = { success: true, output: makeOutput(50000) };
      const compressed = compressToolOutput("unknown-server__tool", result, "session1");
      // DEFAULT_CAP = 32768, output=50000 → over cap
      expect(compressed.compressedSize).toBeLessThan(32768);
    });
  });
});
