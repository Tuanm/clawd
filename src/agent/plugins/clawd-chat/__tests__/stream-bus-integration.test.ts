/**
 * Integration tests for the chat plugin × StreamBus seam.
 *
 * Goal: validate that the bus injection point in createClawdChatPlugin is
 * actually reachable, that the 50ms token batcher coalesces correctly, and
 * that the batched output equals the bus surface contract.
 *
 * Why a separate file: stream-bus.test.ts unit-tests the two bus impls in
 * isolation. This file tests the plugin → bus end-to-end through the real
 * onStreamToken/onThinkingToken/onStreamEnd hooks.
 */

import { describe, expect, test } from "bun:test";
import { createClawdChatPlugin } from "../agent";
import type { StreamBus, TokenType, ToolCallStatus } from "../stream-bus";

interface CapturedCalls {
  setStreaming: Array<[string, string, boolean]>;
  streamToken: Array<[string, string, string, TokenType]>;
  streamToolCall: Array<[string, string, string, any, ToolCallStatus, any?, string?]>;
}

function makeCapturingBus(): { bus: StreamBus; calls: CapturedCalls } {
  const calls: CapturedCalls = { setStreaming: [], streamToken: [], streamToolCall: [] };
  const bus: StreamBus = {
    async setStreaming(a, c, s) {
      calls.setStreaming.push([a, c, s]);
    },
    async streamToken(a, c, t, tt) {
      calls.streamToken.push([a, c, t, tt]);
    },
    async streamToolCall(a, c, n, args, status, result, tid) {
      calls.streamToolCall.push([a, c, n, args, status, result, tid]);
    },
  };
  return { bus, calls };
}

const fakeCtx = { agentId: "agent-1", model: "test-model" } as any;

describe("createClawdChatPlugin × StreamBus injection", () => {
  test("uses injected bus instead of HttpStreamBus when config.bus is provided", async () => {
    const { bus, calls } = makeCapturingBus();
    const plugin = createClawdChatPlugin({
      apiUrl: "http://localhost:99999", // unreachable — would fail if HttpStreamBus were used
      channel: "general",
      agentId: "agent-1",
      bus,
    });
    // Drive a single content token through the batcher and flush.
    await plugin.hooks.onStreamToken!("hello", fakeCtx);
    await plugin.hooks.onStreamEnd!("hello", fakeCtx);
    expect(calls.streamToken).toEqual([["agent-1", "general", "hello", "content"]]);
  });

  test("50ms batcher: ≥100 sync tokens coalesce into a single bus.streamToken call", async () => {
    const { bus, calls } = makeCapturingBus();
    const plugin = createClawdChatPlugin({
      apiUrl: "http://localhost:99999",
      channel: "general",
      agentId: "agent-1",
      bus,
    });
    // Push 100 tokens synchronously — all should sit in the buffer.
    for (let i = 0; i < 100; i++) {
      await plugin.hooks.onStreamToken!(`t${i}-`, fakeCtx);
    }
    // Force-flush via onStreamEnd (fires before the 50ms timer would).
    await plugin.hooks.onStreamEnd!("dontcare", fakeCtx);
    expect(calls.streamToken).toHaveLength(1);
    const [, , token, tokenType] = calls.streamToken[0];
    // Concatenated payload preserves order
    let expected = "";
    for (let i = 0; i < 100; i++) expected += `t${i}-`;
    expect(token).toBe(expected);
    expect(tokenType).toBe("content");
  });

  test("token type change mid-stream forces an intermediate flush", async () => {
    // Note: the hooks call streamToken fire-and-forget, so the type-change
    // flush of 'ab' starts microtask-after the onThinkingToken hook returns;
    // wait for the trailing 50ms timer to drain the 'c' thinking buffer too.
    const { bus, calls } = makeCapturingBus();
    const plugin = createClawdChatPlugin({
      apiUrl: "http://localhost:99999",
      channel: "general",
      agentId: "agent-1",
      bus,
    });
    await plugin.hooks.onStreamToken!("a", fakeCtx);
    await plugin.hooks.onStreamToken!("b", fakeCtx);
    await plugin.hooks.onThinkingToken!("c", fakeCtx);
    await plugin.hooks.onStreamEnd!("ignored", fakeCtx);
    // Drain any timer-scheduled trailing flush from the thinking buffer.
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.streamToken).toEqual([
      ["agent-1", "general", "ab", "content"],
      ["agent-1", "general", "c", "thinking"],
    ]);
  });

  test("50ms timer fires when onStreamEnd is not called (real-time path)", async () => {
    const { bus, calls } = makeCapturingBus();
    const plugin = createClawdChatPlugin({
      apiUrl: "http://localhost:99999",
      channel: "general",
      agentId: "agent-1",
      bus,
    });
    await plugin.hooks.onStreamToken!("x", fakeCtx);
    await plugin.hooks.onStreamToken!("y", fakeCtx);
    // No onStreamEnd — wait for the 50ms timer.
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.streamToken).toEqual([["agent-1", "general", "xy", "content"]]);
  });

  test("onShutdown clears streaming state via bus.setStreaming(false)", async () => {
    const { bus, calls } = makeCapturingBus();
    const plugin = createClawdChatPlugin({
      apiUrl: "http://localhost:99999",
      channel: "general",
      agentId: "agent-1",
      bus,
    });
    await plugin.hooks.onShutdown!(fakeCtx);
    expect(calls.setStreaming).toEqual([["agent-1", "general", false]]);
  });

  test("onShutdown cancels pending 50ms flush — no ghost streamToken after shutdown", async () => {
    // Regression: pre-fix, onShutdown only cleared pollTimer + setStreaming(false),
    // leaving tokenFlushTimer armed. The 50ms timer would then fire post-shutdown
    // and call bus.streamToken on a potentially torn-down bus / dead WS client,
    // surfacing as a ghost partial token in the UI. Pin the cancellation here.
    const { bus, calls } = makeCapturingBus();
    const plugin = createClawdChatPlugin({
      apiUrl: "http://localhost:99999",
      channel: "general",
      agentId: "agent-1",
      bus,
    });
    // Arm the 50ms batcher with buffered content...
    await plugin.hooks.onStreamToken!("buffered-", fakeCtx);
    // ...then shut down BEFORE the timer fires.
    await plugin.hooks.onShutdown!(fakeCtx);
    // Wait past the 50ms interval to confirm the cancelled timer never fires.
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.streamToken).toEqual([]);
    expect(calls.setStreaming).toEqual([["agent-1", "general", false]]);
  });

  test("event token flushes pending content buffer FIRST, then emits event (ordering preserved)", async () => {
    // Streaming an event mid-content must not lose the buffered content. The
    // implementation flushes the content batch, then emits the event token —
    // this test pins that ordering so a refactor cannot accidentally swap the
    // two and leak event ordering into the UI.
    //
    // Microtask assumption: the 10ms wait below drains the fire-and-forget
    // streamToken("[Interrupted]…", "event") chain inside onInterrupt. The
    // capturing bus here is fully synchronous (push-to-array), so both flushes
    // settle within a single microtask. If StreamBus implementations ever
    // become genuinely async (network, queueing), this wait must grow OR the
    // hook must be refactored to await its internal streamToken call.
    const { bus, calls } = makeCapturingBus();
    const plugin = createClawdChatPlugin({
      apiUrl: "http://localhost:99999",
      channel: "general",
      agentId: "agent-1",
      bus,
    });
    await plugin.hooks.onStreamToken!("a", fakeCtx);
    await plugin.hooks.onStreamToken!("b", fakeCtx);
    // Trigger the event-token branch via onInterrupt (which calls
    // streamToken("[Interrupted] ...", "event")).
    await plugin.hooks.onInterrupt!("user message", fakeCtx);
    // The two awaited flushes inside streamToken are sequenced; nothing
    // remains in the timer queue, but allow the microtask queue to drain.
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.streamToken).toEqual([
      ["agent-1", "general", "ab", "content"],
      ["agent-1", "general", "[Interrupted] New message received", "event"],
    ]);
  });
});
