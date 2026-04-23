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

const {
  MAX_REINJECT_ATTEMPTS,
  buildReinjectionPrompt,
  classifyReinjectionOutput,
  extractFallbackText,
  sendChatFallback,
} = await import("./chat-fallback");

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

describe("buildReinjectionPrompt", () => {
  const opts = { toolName: "reply_human", lastTs: "1700000000.000000", hadText: false };

  test("attempt 1 is polite and mentions re-poll", () => {
    const p = buildReinjectionPrompt(1, opts);
    expect(p).toContain("reply_human");
    expect(p).toContain("1700000000.000000");
    expect(p.toLowerCase()).toContain("re-poll");
  });

  test("attempt 2 is firmer and numbers the reminder", () => {
    const p = buildReinjectionPrompt(2, opts);
    expect(p).toContain("Reminder #2");
    expect(p.toUpperCase()).toContain("NOW");
  });

  test("attempts 3-4 demand reply_human as the ONLY action", () => {
    for (const attempt of [3, 4]) {
      const p = buildReinjectionPrompt(attempt, opts);
      expect(p).toContain(`Reminder #${attempt}`);
      expect(p).toContain("ONLY");
    }
  });

  test("final-tier attempts escalate to FINAL NOTICE and cite the cap", () => {
    const p = buildReinjectionPrompt(MAX_REINJECT_ATTEMPTS, opts);
    expect(p).toContain("FINAL NOTICE");
    expect(p).toContain(String(MAX_REINJECT_ATTEMPTS));
  });

  test("hadText=true offers <your reply or [SILENT]>, hadText=false forces [SILENT]", () => {
    const withText = buildReinjectionPrompt(1, { ...opts, hadText: true });
    const noText = buildReinjectionPrompt(1, { ...opts, hadText: false });
    expect(withText).toContain("<your reply or [SILENT]>");
    expect(noText).toContain('"[SILENT]"');
  });

  test("uses fully-qualified MCP tool name verbatim", () => {
    const p = buildReinjectionPrompt(2, { ...opts, toolName: "mcp__clawd__reply_human" });
    expect(p).toContain("mcp__clawd__reply_human");
  });
});

describe("MAX_REINJECT_ATTEMPTS", () => {
  test("is a positive integer safety cap", () => {
    expect(Number.isInteger(MAX_REINJECT_ATTEMPTS)).toBe(true);
    expect(MAX_REINJECT_ATTEMPTS).toBeGreaterThan(1);
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

  test("posts reply_human with stripped text on real content", async () => {
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
    expect(body.params.name).toBe("reply_human");
    expect(body.params.arguments.text).toBe("Hello world");
    expect(body.params.arguments.channel).toBe("#test");
    expect(body.params.arguments.agent_id).toBe("agent-x");
    expect(body.params.arguments.user).toBe("UBOT");
    // timestamp omitted when not provided
    expect(body.params.arguments.timestamp).toBeUndefined();
  });

  test("threads processedTs through as timestamp when provided", async () => {
    const result = await sendChatFallback({
      apiUrl: "http://localhost:9999",
      channel: "#test",
      agentId: "agent-x",
      userId: "UBOT",
      reinjectionText: "Hello",
      processedTs: "1700000000.123",
    });
    expect(result.kind).toBe("fallback_sent");
    expect(capturedCalls.length).toBe(1);
    const body = JSON.parse(capturedCalls[0].init.body as string);
    expect(body.params.name).toBe("reply_human");
    expect(body.params.arguments.timestamp).toBe("1700000000.123");
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
