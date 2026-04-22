import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Swap timedFetch with a capturing mock we can re-stub per test. Declared at
// module scope (before the import under test) so bun's module mocking hooks it
// up before chat-fallback.ts resolves the real implementation.
let fetchImpl: (url: string, options?: RequestInit) => Promise<Response> = async () => {
  throw new Error("fetchImpl not configured");
};
const capturedCalls: Array<{ url: string; init: RequestInit }> = [];

mock.module("../../utils/timed-fetch", () => ({
  timedFetch: async (url: string, init?: RequestInit) => {
    capturedCalls.push({ url, init: init ?? {} });
    return fetchImpl(url, init);
  },
}));

const { classifyReinjectionOutput, extractFallbackText, sendChatFallback } = await import("./chat-fallback");

describe("classifyReinjectionOutput", () => {
  test("detects strict [SILENT]", () => {
    expect(classifyReinjectionOutput("[SILENT]")).toBe("silent");
    expect(classifyReinjectionOutput("  [SILENT]  ")).toBe("silent");
    expect(classifyReinjectionOutput("\n[SILENT]\n")).toBe("silent");
  });

  test("rejects [SILENT] when surrounded by other text", () => {
    expect(classifyReinjectionOutput("I am [SILENT] because")).toBe("send");
    expect(classifyReinjectionOutput("Not [SILENT]")).toBe("send");
    expect(classifyReinjectionOutput("[SILENT] extra")).toBe("send");
  });

  test("strips <think> blocks before classifying", () => {
    expect(classifyReinjectionOutput("<think>reasoning</think>[SILENT]")).toBe("silent");
    expect(classifyReinjectionOutput("<think>reasoning</think>")).toBe("empty");
  });

  test("treats empty/whitespace as empty", () => {
    expect(classifyReinjectionOutput("")).toBe("empty");
    expect(classifyReinjectionOutput("   \n\t  ")).toBe("empty");
  });

  test("classifies real content as send", () => {
    expect(classifyReinjectionOutput("Here is my answer.")).toBe("send");
  });
});

describe("extractFallbackText", () => {
  test("strips reasoning blocks and trims", () => {
    expect(extractFallbackText("<think>x</think>\n  hello  ")).toBe("hello");
  });
});

describe("sendChatFallback", () => {
  beforeEach(() => {
    capturedCalls.length = 0;
    fetchImpl = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  afterEach(() => {
    fetchImpl = async () => {
      throw new Error("fetchImpl not configured");
    };
  });

  test("returns silent_accepted for [SILENT] output and skips HTTP", async () => {
    const result = await sendChatFallback({
      apiUrl: "http://localhost:9999",
      channel: "#test",
      agentId: "agent-x",
      userId: "UBOT",
      reinjectionText: "[SILENT]",
    });
    expect(result).toEqual({ kind: "silent_accepted" });
    expect(capturedCalls.length).toBe(0);
  });

  test("returns empty_discarded for empty output and skips HTTP", async () => {
    const result = await sendChatFallback({
      apiUrl: "http://localhost:9999",
      channel: "#test",
      agentId: "agent-x",
      userId: "UBOT",
      reinjectionText: "",
    });
    expect(result).toEqual({ kind: "empty_discarded" });
    expect(capturedCalls.length).toBe(0);
  });

  test("posts chat_send_message with stripped text on real content", async () => {
    const result = await sendChatFallback({
      apiUrl: "http://localhost:9999",
      channel: "#test",
      agentId: "agent-x",
      userId: "UBOT",
      reinjectionText: "<think>private</think>\nHello world",
    });
    expect(result).toEqual({ kind: "fallback_sent", chars: "Hello world".length });
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0].url).toBe("http://localhost:9999/mcp");
    const body = JSON.parse(capturedCalls[0].init.body as string);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("chat_send_message");
    expect(body.params.arguments.text).toBe("Hello world");
    expect(body.params.arguments.channel).toBe("#test");
    expect(body.params.arguments.agent_id).toBe("agent-x");
    expect(body.params.arguments.user).toBe("UBOT");
  });

  test("passes through authHeaders when provided", async () => {
    await sendChatFallback({
      apiUrl: "http://localhost:9999",
      channel: "#test",
      agentId: "agent-x",
      userId: "UWORKER-agent-x",
      reinjectionText: "hi",
      authHeaders: { Authorization: "Bearer xyz" },
    });
    const headers = capturedCalls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xyz");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("returns fallback_failed on non-ok HTTP", async () => {
    fetchImpl = async () => new Response("down", { status: 503 });
    const result = await sendChatFallback({
      apiUrl: "http://localhost:9999",
      channel: "#test",
      agentId: "agent-x",
      userId: "UBOT",
      reinjectionText: "hi",
    });
    expect(result.kind).toBe("fallback_failed");
    if (result.kind === "fallback_failed") expect(result.error).toContain("503");
  });

  test("returns fallback_failed on fetch throw", async () => {
    fetchImpl = async () => {
      throw new Error("network down");
    };
    const result = await sendChatFallback({
      apiUrl: "http://localhost:9999",
      channel: "#test",
      agentId: "agent-x",
      userId: "UBOT",
      reinjectionText: "hi",
    });
    expect(result.kind).toBe("fallback_failed");
    if (result.kind === "fallback_failed") expect(result.error).toContain("network down");
  });
});
