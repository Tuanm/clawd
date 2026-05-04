/**
 * Tests for the Anthropic factory's `cache_control` breakpoint placement.
 *
 * The two-breakpoint design:
 *   BP1 — last alwaysInclude tool (marked via `tool.cacheBreakpoint`):
 *         small stable prefix that survives warmup → steady → re-expansion.
 *   BP2 — last tool overall:
 *         large prefix that hits within the same filter state.
 *
 * When BP1 == BP2 (i.e., last tool overall is also the last alwaysInclude tool),
 * we emit ONE cache_control entry rather than duplicating.
 *
 * The factory also strips `cacheBreakpoint` and `readOnly` internal metadata before
 * the body reaches the wire — verified for the OpenAI sanitizer as well.
 */

import { describe, expect, test } from "bun:test";
import { __testHooks } from "../factory";
import type { CompletionRequest, ToolDefinition } from "../types";

const { AnthropicProvider, OpenAIProvider } = __testHooks;

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

function makeAnthropic(): InstanceType<typeof AnthropicProvider> {
  return new AnthropicProvider({
    baseUrl: "https://example.invalid",
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
  });
}

describe("AnthropicProvider.toAnthropicRequest cache_control placement", () => {
  test("places TWO cache_controls when BP1 != BP2 (typical case)", () => {
    const provider = makeAnthropic();
    const req: CompletionRequest = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        tool("complete_task"),
        tool("reply", { cacheBreakpoint: true }), // BP1 (last alwaysInclude)
        tool("bash"),
        tool("view"), // BP2 (last overall)
      ],
    };
    const out = provider._toAnthropicRequestForTests(req);

    expect(out.tools).toHaveLength(4);
    // BP1: tools[1]
    expect(out.tools[1].name).toBe("reply");
    expect(out.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // BP2: tools[3]
    expect(out.tools[3].name).toBe("view");
    expect(out.tools[3].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // No cache_control on others
    expect(out.tools[0].cache_control).toBeUndefined();
    expect(out.tools[2].cache_control).toBeUndefined();
  });

  test("places ONE cache_control when BP1 == BP2 (small all-stable tool set)", () => {
    const provider = makeAnthropic();
    const req: CompletionRequest = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [tool("complete_task"), tool("reply", { cacheBreakpoint: true })],
    };
    const out = provider._toAnthropicRequestForTests(req);

    expect(out.tools).toHaveLength(2);
    expect(out.tools[0].cache_control).toBeUndefined();
    // Last overall is also the cacheBreakpoint-flagged tool — single cache_control.
    expect(out.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("when no cacheBreakpoint flag is set, only BP2 (last) gets cache_control", () => {
    const provider = makeAnthropic();
    const req: CompletionRequest = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [tool("bash"), tool("view"), tool("grep")],
    };
    const out = provider._toAnthropicRequestForTests(req);

    expect(out.tools).toHaveLength(3);
    expect(out.tools[0].cache_control).toBeUndefined();
    expect(out.tools[1].cache_control).toBeUndefined();
    expect(out.tools[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("strips internal-only ToolDefinition fields (cacheBreakpoint, readOnly)", () => {
    const provider = makeAnthropic();
    const req: CompletionRequest = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [tool("reply", { cacheBreakpoint: true, readOnly: false }), tool("view", { readOnly: true })],
    };
    const out = provider._toAnthropicRequestForTests(req);

    // Anthropic-format tools have only: name, description, input_schema, [cache_control]
    for (const t of out.tools) {
      expect(t.cacheBreakpoint).toBeUndefined();
      expect(t.readOnly).toBeUndefined();
      expect(t.type).toBeUndefined(); // OpenAI-format wrapper dropped
      expect(t.function).toBeUndefined();
      expect(t.name).toBeDefined();
      expect(t.description).toBeDefined();
      expect(t.input_schema).toBeDefined();
    }
  });

  test("system prompt cache_control still applied alongside tools breakpoints", () => {
    const provider = makeAnthropic();
    const req: CompletionRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "you are a helpful assistant" },
        { role: "user", content: "hi" },
      ],
      tools: [tool("reply", { cacheBreakpoint: true }), tool("view")],
    };
    const out = provider._toAnthropicRequestForTests(req);

    expect(out.system).toBeDefined();
    expect(out.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Tools still get their breakpoints
    expect(out.tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" }); // BP1
    expect(out.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" }); // BP2
  });

  test("empty / missing tools array → no cache_control on tools", () => {
    const provider = makeAnthropic();
    const noTools = provider._toAnthropicRequestForTests({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(noTools.tools).toBeUndefined();

    const emptyTools = provider._toAnthropicRequestForTests({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(emptyTools.tools).toBeUndefined();
  });

  test("total cache_control breakpoint count never exceeds Anthropic's 4-per-request cap", () => {
    const provider = makeAnthropic();
    // Request with everything: system + many tools (some flagged).
    const tools: ToolDefinition[] = [];
    for (let i = 0; i < 20; i++) {
      // Mark one in the middle as cacheBreakpoint (BP1) — only ONE BP1 per request.
      tools.push(tool(`tool_${i}`, i === 5 ? { cacheBreakpoint: true } : {}));
    }
    const out = provider._toAnthropicRequestForTests({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools,
    });

    let toolBpCount = 0;
    for (const t of out.tools) if (t.cache_control) toolBpCount++;
    const systemBpCount = out.system?.filter((s: any) => s.cache_control).length ?? 0;
    const total = toolBpCount + systemBpCount;
    expect(total).toBeLessThanOrEqual(4);
    // We expect exactly 3: tools BP1, tools BP2, system BP.
    expect(total).toBe(3);
  });
});

describe("OpenAIProvider sanitize strips internal tool metadata", () => {
  test("readOnly and cacheBreakpoint never reach the wire", () => {
    const provider = new OpenAIProvider({
      baseUrl: "https://example.invalid",
      apiKey: "test",
      model: "gpt-4",
    });
    const req: CompletionRequest = {
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
      tools: [tool("reply", { cacheBreakpoint: true, readOnly: false }), tool("view", { readOnly: true })],
    };
    // sanitizeRequest is private; reach via cast for test purposes
    const sanitized: any = (provider as any).sanitizeRequest(req, false);
    expect(sanitized.tools).toHaveLength(2);
    for (const t of sanitized.tools) {
      expect(t.readOnly).toBeUndefined();
      expect(t.cacheBreakpoint).toBeUndefined();
      expect(t.type).toBe("function");
      expect(t.function?.name).toBeDefined();
    }
  });
});
