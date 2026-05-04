/**
 * Reproducer for the streamToken batcher race.
 *
 * Setup mirrors clawd-chat/agent.ts:108-157 verbatim. The plugin hook
 * `onStreamToken` calls `streamToken(token, ...)` WITHOUT await — i.e.
 * it is fire-and-forget INSIDE the plugin, regardless of whether
 * agent.ts's caller awaits the hook itself.
 *
 * This test simulates the OLD agent.ts behaviour (await pluginHook(t))
 * and shows that two concurrent streamToken invocations can still
 * interleave at the `await flushTokenBuffer()` yield point on a
 * type-change boundary, producing out-of-order batches.
 *
 * If this race reproduces under simulated-OLD-agent semantics, it
 * proves the race is pre-existing and not introduced by the Phase A
 * `void plugins.onStreamToken(...)` change.
 */

import { beforeEach, describe, expect, test } from "bun:test";

describe("streamToken race (pre-existing in clawd-chat plugin)", () => {
  let tokenBuffer: string;
  let tokenBufferType: "content" | "thinking" | "event";
  let tokenFlushTimer: ReturnType<typeof setTimeout> | null;
  let flushedBatches: Array<{ batch: string; type: string; resolveSignal: () => void }>;
  let pendingFetches: Array<{ resolve: () => void }>;

  beforeEach(() => {
    tokenBuffer = "";
    tokenBufferType = "content";
    tokenFlushTimer = null;
    flushedBatches = [];
    pendingFetches = [];
  });

  // Mirrors flushTokenBuffer() at line 114-133, with timedFetch replaced
  // by a controllable promise.
  async function flushTokenBuffer(): Promise<void> {
    if (!tokenBuffer) return;
    const batch = tokenBuffer;
    const batchType = tokenBufferType;
    tokenBuffer = "";
    // Suspend until the test harness releases this fetch.
    await new Promise<void>((resolve) => {
      pendingFetches.push({ resolve });
    });
    flushedBatches.push({ batch, type: batchType, resolveSignal: () => {} });
  }

  // Mirrors streamToken() at line 135-157, content/thinking branches only.
  async function streamToken(token: string, tokenType: "content" | "thinking" = "content"): Promise<void> {
    if (tokenBufferType !== tokenType && tokenBuffer) {
      await flushTokenBuffer();
    }
    tokenBufferType = tokenType;
    tokenBuffer += token;
    // Skip the 50ms setTimeout — the test drives flushes manually.
  }

  // Mirrors plugin hook at line 723-728: fire-and-forget INSIDE the hook.
  async function onStreamToken(token: string): Promise<void> {
    streamToken(token, "content"); // unawaited — same as line 727
  }
  async function onThinkingToken(token: string): Promise<void> {
    streamToken(token, "thinking"); // unawaited — same as line 732
  }

  test("OLD await-style agent loop: type-change still races at await flushTokenBuffer", async () => {
    // Simulated OLD agent loop: `await this.plugins.onStreamToken(t)`.
    // The plugin hook returns synchronously after kicking off streamToken,
    // so the await resolves immediately — the agent advances to next token
    // while the kicked-off streamToken is suspended on flushTokenBuffer.
    const oldAgentLoop = async () => {
      await onStreamToken("c1"); // kicks off streamToken("c1","content")
      await onThinkingToken("t1"); // streamToken("t1","thinking") — type change → awaits flushTokenBuffer
      await onStreamToken("c2"); // streamToken("c2","content") starts WHILE t1's flush is suspended
    };

    const loopDone = oldAgentLoop();

    // Drain microtasks so all streamToken bodies reach their first yield.
    await new Promise((r) => setTimeout(r, 10));

    // At this point: t1's streamToken is suspended on flushTokenBuffer
    // (which has cleared the buffer that held "c1" and is awaiting fetch).
    // c2's streamToken should have run synchronously past the type-check
    // (buffer is empty, so no flush) and appended "c2" with type=content.
    // Then t1 resumes, sets type=thinking, appends "t1" — but on top of "c2"!

    // Release the in-flight flush (the c1-content batch).
    expect(pendingFetches.length).toBe(1);
    pendingFetches.shift()!.resolve();

    await loopDone;
    // Drain trailing microtasks.
    await new Promise((r) => setTimeout(r, 10));

    // Buffer at end should hold the corrupted state.
    // If the race is REAL: after sequence resolves, tokenBuffer holds "c2t1"
    // with tokenBufferType="thinking" (because t1 won the assignment last),
    // mixing content and thinking text into a single thinking-typed batch.
    // The c1 batch was emitted with type=content (correct).
    // But c2 is now stuck in a thinking-typed buffer.

    // We assert the corruption so the test is a positive proof:
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toEqual(
      expect.objectContaining({ batch: "c1", type: "content" }),
    );
    // Pending state shows the corruption.
    expect(tokenBuffer).toBe("c2t1");
    expect(tokenBufferType).toBe("thinking");
  });
});
