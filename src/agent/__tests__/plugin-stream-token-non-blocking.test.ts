/**
 * Tests that the void+catch pattern used in agent.ts for plugin.onStreamToken /
 * onThinkingToken does not block the SSE consumer.
 *
 * Background: previously the agent's stream loop did `await this.plugins.onStreamToken(t)`,
 * which serialised every token through whatever the plugin chose to do (including HTTP
 * POSTs to the local SSE bridge). Tokens are emitted ~50/sec at peak, so every awaited
 * ms shaves throughput. Switching to `void plugins.onStreamToken(t).catch(...)` makes
 * the call fire-and-forget while still surfacing errors via logSilentError.
 *
 * The contract we encode here:
 *   1. The void+catch wrapper returns synchronously even when the plugin promise resolves
 *      far later (token loop never blocks)
 *   2. Errors thrown by the plugin do NOT surface as unhandled rejections — the .catch()
 *      handler must intercept them
 *   3. All N plugin calls eventually run to completion (no calls dropped)
 */

import { describe, expect, test } from "bun:test";

// Mirror logSilentError signature used in agent.ts
function makeRecordingLogger() {
  const errors: Array<{ ctx: string; err: any }> = [];
  return {
    log: (ctx: string, err: any) => errors.push({ ctx, err }),
    errors,
  };
}

// Mirror the exact pattern used at agent.ts:2272 / 2283
function fireAndForget(promise: Promise<void>, ctx: string, log: (c: string, e: any) => void) {
  void promise.catch((err) => log(ctx, err));
}

describe("plugin onStreamToken/onThinkingToken non-blocking pattern", () => {
  test("void+catch returns synchronously even when plugin is slow (50ms per token)", async () => {
    const { log, errors } = makeRecordingLogger();
    const tokens = Array.from({ length: 20 }, (_, i) => `tok-${i}`);

    // Simulate 20 tokens dispatched in tight loop with a SLOW_MS-per-call plugin.
    // If we awaited each, total wall time would be ≥ 20 * SLOW_MS. With void+catch
    // dispatch should be a small fraction of one plugin call — we assert the relative
    // ratio rather than an absolute ceiling, so the test is not flaky on busy CI.
    const SLOW_MS = 50;
    const slowPlugin = async (_t: string) => {
      await Bun.sleep(SLOW_MS);
    };

    const start = performance.now();
    const inflight: Promise<void>[] = [];
    for (const t of tokens) {
      const p = slowPlugin(t);
      inflight.push(p);
      fireAndForget(p, "plugin.onStreamToken", log);
    }
    const dispatchMs = performance.now() - start;

    // Dispatch must finish in well under one plugin call's wait time. We pick 1/5 of
    // SLOW_MS as the ceiling: tight enough that a regression to `await` (which would
    // make dispatchMs ≥ 20 * SLOW_MS) blows through it, loose enough to absorb
    // scheduler jitter on a contended CI runner.
    expect(dispatchMs).toBeLessThan(SLOW_MS / 5);

    // But the plugin work eventually completes — no dropped calls.
    await Promise.all(inflight);
    expect(errors).toHaveLength(0);
  });

  test("plugin errors are caught, never surface as unhandled rejection", async () => {
    const { log, errors } = makeRecordingLogger();
    const failingPlugin = async (_t: string) => {
      throw new Error("plugin boom");
    };

    let unhandled: any = null;
    const handler = (err: any) => {
      unhandled = err;
    };
    process.on("unhandledRejection", handler);

    try {
      for (let i = 0; i < 5; i++) {
        fireAndForget(failingPlugin(`t-${i}`), "plugin.onStreamToken", log);
      }
      // Drain microtask queue + any deferred .catch() handlers.
      await Bun.sleep(50);
    } finally {
      process.off("unhandledRejection", handler);
    }

    expect(unhandled).toBeNull();
    expect(errors).toHaveLength(5);
    for (const e of errors) {
      expect(e.ctx).toBe("plugin.onStreamToken");
      expect(e.err.message).toBe("plugin boom");
    }
  });

  test("synchronous throw inside plugin (sync exception) does not block dispatch", async () => {
    const { log, errors } = makeRecordingLogger();
    // Async function that synchronously throws still returns a rejected promise —
    // verifying the .catch() handles this branch too.
    const syncFailingPlugin = async (_t: string) => {
      throw new Error("sync inside async");
    };

    let unhandled: any = null;
    const handler = (err: any) => {
      unhandled = err;
    };
    process.on("unhandledRejection", handler);

    try {
      for (let i = 0; i < 3; i++) {
        fireAndForget(syncFailingPlugin(`t-${i}`), "plugin.onThinkingToken", log);
      }
      await Bun.sleep(20);
    } finally {
      process.off("unhandledRejection", handler);
    }

    expect(unhandled).toBeNull();
    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.ctx === "plugin.onThinkingToken")).toBe(true);
  });
});
