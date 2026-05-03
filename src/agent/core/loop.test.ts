/**
 * Unit tests for AgenticLoop
 *
 * Coverage:
 * 1. Simple completion (no tools) — loop returns when model says stop
 * 2. Tool call → tool result → loop continues → final text response
 * 3. Max iterations limit respected
 * 4. Abort signal stops the loop
 */

import { describe, expect, mock, test } from "bun:test";
import type { Message, ToolCall, ToolDefinition } from "../api/client";
import {
  AgenticLoop,
  type CompletionProvider,
  type LoopConfig,
  type ToolExecutionResult,
  type ToolExecutor,
} from "./loop";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: LoopConfig = {
  maxIterations: 10,
  model: "gpt-4o",
  systemPrompt: "You are a helpful assistant.",
};

/** Builds a text-only assistant message (no tool_calls) */
function textMessage(content: string): Message {
  return { role: "assistant", content };
}

/** Builds an assistant message that makes a single tool call */
function toolCallMessage(name: string, args: Record<string, any>, callId = "call_001"): Message {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: callId,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

/** Creates a CompletionProvider that returns pre-configured responses in order */
function makeProvider(responses: Message[]): CompletionProvider {
  let idx = 0;
  return {
    complete: mock(async (_messages: Message[], _tools: ToolDefinition[], _model: string) => {
      const message = responses[idx % responses.length];
      idx++;
      return { message };
    }),
  };
}

/** Creates a simple ToolExecutor that returns a canned result for any tool call */
function makeExecutor(result: string = "tool-result"): ToolExecutor {
  return {
    getTools: mock((): ToolDefinition[] => [
      {
        type: "function",
        function: {
          name: "echo",
          description: "Echoes back the input",
          parameters: { type: "object", properties: { text: { type: "string" } } },
        },
      },
    ]),
    execute: mock(
      async (toolCall: ToolCall): Promise<ToolExecutionResult> => ({
        tool_call_id: toolCall.id,
        content: result,
        success: true,
      }),
    ),
  };
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe("AgenticLoop", () => {
  // ── 1. Simple completion (no tools) ────────────────────────────────────────

  describe("simple completion — no tool calls", () => {
    test("loop returns success when model responds with text only", async () => {
      const provider = makeProvider([textMessage("Hello, world!")]);
      const executor = makeExecutor();

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor);
      const result = await loop.run("Say hello");

      expect(result.success).toBe(true);
      expect(result.content).toBe("Hello, world!");
      expect(result.toolCalls).toBe(0);
      expect(result.iterations).toBe(1);
    });

    test("status transitions idle → running → completed", async () => {
      const statusHistory: string[] = [];
      const provider = makeProvider([textMessage("Done.")]);
      const executor = makeExecutor();

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor);
      loop.on("status", (s: string) => statusHistory.push(s));
      await loop.run("task");

      expect(statusHistory).toContain("running");
      expect(statusHistory).toContain("completed");
    });

    test("getMessages() includes system, user and assistant messages after run", async () => {
      const provider = makeProvider([textMessage("reply")]);
      const executor = makeExecutor();

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor);
      await loop.run("user task");

      const messages = loop.getMessages();
      expect(messages[0].role).toBe("system");
      expect(messages[1].role).toBe("user");
      expect(messages[2].role).toBe("assistant");
    });
  });

  // ── 2. Tool call → result → continue → final response ──────────────────────

  describe("tool call flow", () => {
    test("loop executes a tool call and then gets a final text response", async () => {
      const toolMsg = toolCallMessage("echo", { text: "ping" });
      const finalMsg = textMessage("All done!");

      const provider = makeProvider([toolMsg, finalMsg]);
      const executor = makeExecutor("pong");

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor);
      const result = await loop.run("do something");

      expect(result.success).toBe(true);
      expect(result.toolCalls).toBe(1);
      expect(result.content).toBe("All done!");
    });

    test("tool result is appended to messages with correct role", async () => {
      const toolMsg = toolCallMessage("echo", { text: "hi" }, "call_xyz");
      const finalMsg = textMessage("finished");

      const provider = makeProvider([toolMsg, finalMsg]);
      const executor = makeExecutor("tool-output");

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor);
      await loop.run("task");

      const messages = loop.getMessages();
      const toolResultMsg = messages.find((m) => m.role === "tool");
      expect(toolResultMsg).toBeDefined();
      expect(toolResultMsg?.content).toBe("tool-output");
      expect(toolResultMsg?.tool_call_id).toBe("call_xyz");
    });

    test("executor.execute is called once per tool call", async () => {
      const toolMsg = toolCallMessage("echo", { text: "test" });
      const finalMsg = textMessage("ok");

      const provider = makeProvider([toolMsg, finalMsg]);
      const executor = makeExecutor("result");

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor);
      await loop.run("task");

      expect(executor.execute).toHaveBeenCalledTimes(1);
    });

    test("multiple tool calls in a single response are all executed", async () => {
      const multiToolMsg: Message = {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"a"}' } },
          { id: "c2", type: "function", function: { name: "echo", arguments: '{"text":"b"}' } },
        ],
      };
      const finalMsg = textMessage("done");

      const provider = makeProvider([multiToolMsg, finalMsg]);
      const executor = makeExecutor("result");

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor);
      const result = await loop.run("task");

      expect(result.toolCalls).toBe(2);
      expect(executor.execute).toHaveBeenCalledTimes(2);
    });
  });

  // ── 3. Max iterations limit ─────────────────────────────────────────────────

  describe("max iterations limit", () => {
    test("loop stops after maxIterations even if model keeps calling tools", async () => {
      // Provider always returns a tool call (never a final text response)
      const alwaysTool = toolCallMessage("echo", { text: "loop" });
      const provider = makeProvider([alwaysTool]);
      const executor = makeExecutor("result");

      const config: LoopConfig = { ...DEFAULT_CONFIG, maxIterations: 3 };
      const loop = new AgenticLoop(config, provider, executor);
      const result = await loop.run("infinite task");

      expect(result.iterations).toBeLessThanOrEqual(3);
    });

    test("result.success reflects the last iteration outcome when max is hit", async () => {
      const alwaysTool = toolCallMessage("echo", { text: "x" });
      const provider = makeProvider([alwaysTool]);
      const executor = makeExecutor("r");

      const config: LoopConfig = { ...DEFAULT_CONFIG, maxIterations: 2 };
      const loop = new AgenticLoop(config, provider, executor);
      const result = await loop.run("task");

      // Loop exits the while without a final text message — success depends on whether
      // it was aborted vs just hitting the limit.  Without abort it should be success.
      expect(result.success).toBe(true);
    });

    test("getIterations() returns the number of iterations performed", async () => {
      const provider = makeProvider([textMessage("stop")]);
      const executor = makeExecutor();

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor);
      await loop.run("task");

      expect(loop.getIterations()).toBe(1);
    });
  });

  // ── 4. Abort ────────────────────────────────────────────────────────────────

  describe("abort", () => {
    test("loop respects abort() called from a hook", async () => {
      let callCount = 0;
      const provider: CompletionProvider = {
        complete: mock(async () => {
          callCount++;
          return { message: toolCallMessage("echo", { text: "x" }) };
        }),
      };
      const executor = makeExecutor();

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor, {
        onIteration: async (iteration) => {
          if (iteration >= 2) loop.abort();
        },
      });

      const result = await loop.run("task");

      expect(result.success).toBe(false);
      expect(loop.isAborted()).toBe(true);
    });

    test("status is 'aborted' after abort()", async () => {
      const provider = makeProvider([toolCallMessage("echo", { text: "x" })]);
      const executor = makeExecutor();

      const loop = new AgenticLoop({ ...DEFAULT_CONFIG, maxIterations: 5 }, provider, executor, {
        onIteration: async () => {
          loop.abort();
        },
      });

      await loop.run("task");
      expect(loop.getStatus()).toBe("aborted");
    });
  });

  // ── 5. Plugin hooks ─────────────────────────────────────────────────────────

  describe("plugin hooks", () => {
    test("onStart hook is called with the task string", async () => {
      const onStart = mock(async (_task: string) => {});
      const provider = makeProvider([textMessage("done")]);
      const executor = makeExecutor();

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor, { onStart });
      await loop.run("my-task");

      expect(onStart).toHaveBeenCalledWith("my-task");
    });

    test("onComplete hook receives the final LoopResult", async () => {
      const onComplete = mock(async (_result: any) => {});
      const provider = makeProvider([textMessage("result text")]);
      const executor = makeExecutor();

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor, { onComplete });
      await loop.run("task");

      expect(onComplete).toHaveBeenCalledTimes(1);
      const [result] = (onComplete as ReturnType<typeof mock>).mock.calls[0];
      expect(result.success).toBe(true);
      expect(result.content).toBe("result text");
    });

    test("onToolCalls hook is called when tool calls are made", async () => {
      const onToolCalls = mock(async (_calls: ToolCall[]) => {});
      const provider = makeProvider([toolCallMessage("echo", { text: "x" }), textMessage("final")]);
      const executor = makeExecutor();

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor, { onToolCalls });
      await loop.run("task");

      expect(onToolCalls).toHaveBeenCalledTimes(1);
    });
  });

  // ── 6. Error handling ───────────────────────────────────────────────────────

  describe("error handling", () => {
    test("loop returns success=false when CompletionProvider throws", async () => {
      const failingProvider: CompletionProvider = {
        complete: mock(async () => {
          throw new Error("API error");
        }),
      };
      const executor = makeExecutor();

      const loop = new AgenticLoop(DEFAULT_CONFIG, failingProvider, executor);
      const result = await loop.run("task");

      expect(result.success).toBe(false);
      expect(result.error).toContain("API error");
      expect(loop.getStatus()).toBe("failed");
    });

    // Regression: parallel read-only tool calls used Promise.all, so a single
    // rejected sibling aborted the whole turn. Verify the allSettled path
    // recovers — the rejection becomes a tool message with an error body and
    // sibling results land alongside it.
    test("parallel read-only tools: one rejection produces an error message, siblings succeed", async () => {
      const multiToolMsg: Message = {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "ok-1", type: "function", function: { name: "echo", arguments: '{"text":"a"}' } },
          { id: "boom", type: "function", function: { name: "echo", arguments: '{"text":"b"}' } },
          { id: "ok-2", type: "function", function: { name: "echo", arguments: '{"text":"c"}' } },
        ],
      };
      const finalMsg = textMessage("done");
      const provider = makeProvider([multiToolMsg, finalMsg]);

      // Mark echo as readOnly so the loop takes the parallel branch.
      const executor: ToolExecutor = {
        getTools: mock((): ToolDefinition[] => [
          {
            type: "function",
            readOnly: true,
            function: {
              name: "echo",
              description: "Echoes back the input",
              parameters: { type: "object", properties: { text: { type: "string" } } },
            },
          },
        ]),
        execute: mock(async (toolCall: ToolCall): Promise<ToolExecutionResult> => {
          if (toolCall.id === "boom") throw new Error("kaboom");
          return { tool_call_id: toolCall.id, content: `ok:${toolCall.id}`, success: true };
        }),
      };

      const loop = new AgenticLoop(DEFAULT_CONFIG, provider, executor);
      const result = await loop.run("task");

      // Loop should not crash — siblings + an error placeholder all land in messages.
      expect(result.success).toBe(true);
      const toolMessages = loop.getMessages().filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(3);
      const byId = new Map(toolMessages.map((m) => [m.tool_call_id, m.content]));
      expect(byId.get("ok-1")).toBe("ok:ok-1");
      expect(byId.get("ok-2")).toBe("ok:ok-2");
      expect(byId.get("boom")).toContain("kaboom");
    });
  });
});
