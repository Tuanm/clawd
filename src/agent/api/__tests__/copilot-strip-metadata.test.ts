/**
 * Tests for `stripInternalToolMetadata` — the helper used by both the POST and
 * streaming Copilot paths in client.ts to remove internal-only ToolDefinition
 * fields (`readOnly`, `cacheBreakpoint`) before they reach the wire.
 *
 * Invariants verified:
 *   1. Stripping: `readOnly` and `cacheBreakpoint` never survive on output tools.
 *   2. Zero-allocation fast path: when no tools carry either field, the SAME
 *      request reference is returned (avoids unnecessary copies in the stream loop).
 *   3. Source preservation: the input request and its tool defs are not mutated.
 *   4. Other tool fields (type, function.name/description/parameters) survive intact.
 *   5. Edge cases: undefined tools, empty tools array.
 *   6. Behavioural parity with the JSON.stringify body that actually reaches the wire.
 */

import { describe, expect, test } from "bun:test";
import { stripInternalToolMetadata } from "../client";
import type { CompletionRequest, ToolDefinition } from "../types";

function tool(name: string, opts: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `desc-${name}`,
      parameters: { type: "object", properties: {} },
    },
    ...opts,
  };
}

function makeRequest(tools?: ToolDefinition[]): CompletionRequest {
  return {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    tools,
  };
}

describe("stripInternalToolMetadata", () => {
  test("strips cacheBreakpoint from output tools", () => {
    const req = makeRequest([tool("reply", { cacheBreakpoint: true }), tool("view")]);
    const out = stripInternalToolMetadata(req);
    expect(out.tools).toHaveLength(2);
    for (const t of out.tools!) {
      expect(t.cacheBreakpoint).toBeUndefined();
    }
  });

  test("strips readOnly from output tools", () => {
    const req = makeRequest([tool("reply", { readOnly: false }), tool("view", { readOnly: true })]);
    const out = stripInternalToolMetadata(req);
    expect(out.tools).toHaveLength(2);
    for (const t of out.tools!) {
      expect(t.readOnly).toBeUndefined();
    }
  });

  test("strips both flags simultaneously", () => {
    const req = makeRequest([
      tool("reply", { cacheBreakpoint: true, readOnly: false }),
      tool("view", { readOnly: true }),
    ]);
    const out = stripInternalToolMetadata(req);
    for (const t of out.tools!) {
      expect(t.cacheBreakpoint).toBeUndefined();
      expect(t.readOnly).toBeUndefined();
    }
  });

  test("preserves all wire-bound tool fields (type, function.{name,description,parameters})", () => {
    const replyParams = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
    const original: ToolDefinition = {
      type: "function",
      readOnly: true,
      cacheBreakpoint: true,
      function: { name: "reply", description: "Send a reply", parameters: replyParams },
    };
    const out = stripInternalToolMetadata(makeRequest([original]));
    expect(out.tools).toHaveLength(1);
    const cleaned = out.tools![0];
    expect(cleaned.type).toBe("function");
    expect(cleaned.function.name).toBe("reply");
    expect(cleaned.function.description).toBe("Send a reply");
    expect(cleaned.function.parameters).toEqual(replyParams);
  });

  test("zero-allocation fast path: no flags → same request reference", () => {
    const req = makeRequest([tool("reply"), tool("view")]);
    const out = stripInternalToolMetadata(req);
    expect(out).toBe(req);
  });

  test("zero-allocation fast path: undefined tools", () => {
    const req: CompletionRequest = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    };
    const out = stripInternalToolMetadata(req);
    expect(out).toBe(req);
  });

  test("zero-allocation fast path: empty tools array", () => {
    const req = makeRequest([]);
    const out = stripInternalToolMetadata(req);
    expect(out).toBe(req);
  });

  test("does not mutate input request or tool definitions", () => {
    const replyTool = tool("reply", { cacheBreakpoint: true, readOnly: true });
    const viewTool = tool("view");
    const tools = [replyTool, viewTool];
    const req = makeRequest(tools);
    const toolsSnapshot = [...tools];

    const out = stripInternalToolMetadata(req);

    // Input array unchanged (order, identity)
    expect(req.tools).toEqual(toolsSnapshot);
    expect(req.tools![0]).toBe(replyTool);
    expect(req.tools![1]).toBe(viewTool);
    // Source flags preserved
    expect(replyTool.cacheBreakpoint).toBe(true);
    expect(replyTool.readOnly).toBe(true);
    // Output is a new request object (since stripping was needed)
    expect(out).not.toBe(req);
  });

  test("wire-format parity: JSON.stringify of cleaned request contains no internal flags", () => {
    // This is the exact body shape that reaches the Copilot HTTP/2 wire.
    const req = makeRequest([
      tool("reply", { cacheBreakpoint: true, readOnly: false }),
      tool("view", { readOnly: true }),
      tool("bash"),
    ]);
    const body = JSON.stringify({ ...stripInternalToolMetadata(req), stream: false });
    expect(body).not.toContain("cacheBreakpoint");
    expect(body).not.toContain("readOnly");
    // Sanity: real fields still present
    expect(body).toContain('"name":"reply"');
    expect(body).toContain('"name":"view"');
    expect(body).toContain('"stream":false');
  });

  test("preserves non-tool request fields (model, messages, etc.)", () => {
    const req: CompletionRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [tool("reply", { cacheBreakpoint: true })],
      max_tokens: 1024,
    };
    const out = stripInternalToolMetadata(req);
    expect(out.model).toBe("claude-sonnet-4-6");
    expect(out.messages).toEqual(req.messages);
    expect(out.max_tokens).toBe(1024);
  });
});
