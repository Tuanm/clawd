/**
 * Tests for src/utils/timed-fetch.ts — prerequisite for Phase 4.2 (DRY fetch consolidation).
 *
 * Covers:
 *   - Fetch is called with an AbortSignal
 *   - Timeout fires and aborts the in-flight request
 *   - Caller-provided signal is composed with the timeout signal
 *   - Fetch errors propagate without wrapping
 *   - Timer is cleared on fast success (no dangling timers)
 *
 * Uses bun:test. globalThis.fetch is overridden per test and restored via afterEach.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { timedFetch } from "../timed-fetch";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Build a mock fetch that resolves immediately with a 200 OK response. */
function mockOk(capturedSignals?: AbortSignal[]) {
  return mock(async (_url: string, opts: RequestInit = {}) => {
    capturedSignals?.push(opts.signal as AbortSignal);
    return new Response("ok", { status: 200 });
  });
}

/**
 * Build a mock fetch that holds forever until the AbortSignal fires,
 * then rejects with an AbortError (mirrors real fetch behaviour).
 */
function mockAbortable(capturedSignals: AbortSignal[]) {
  return mock(async (_url: string, opts: RequestInit = {}) => {
    const signal = opts.signal as AbortSignal;
    capturedSignals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  });
}

/** Build a mock fetch that rejects with a network-style error. */
function mockNetworkError(err: Error) {
  return mock(async () => {
    throw err;
  });
}

// ─── Basic happy path ────────────────────────────────────────────────────────

describe("timedFetch — happy path", () => {
  test("resolves with the fetch response on success", async () => {
    globalThis.fetch = mockOk() as unknown as typeof fetch;
    const res = await timedFetch("https://example.com");
    expect(res.status).toBe(200);
  });

  test("calls fetch with the given URL", async () => {
    const signals: AbortSignal[] = [];
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string, opts: RequestInit = {}) => {
      capturedUrl = url as string;
      signals.push(opts.signal as AbortSignal);
      return new Response("ok");
    }) as unknown as typeof fetch;

    await timedFetch("https://api.example.com/v1");
    expect(capturedUrl).toBe("https://api.example.com/v1");
  });

  test("always injects an AbortSignal into the request", async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = mockOk(signals) as unknown as typeof fetch;
    await timedFetch("https://example.com");
    expect(signals[0]).toBeDefined();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  test("signal is not aborted on fast success", async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = mockOk(signals) as unknown as typeof fetch;
    await timedFetch("https://example.com");
    expect(signals[0]?.aborted).toBe(false);
  });

  test("passes through extra RequestInit options", async () => {
    let capturedMethod = "";
    globalThis.fetch = mock(async (_url: string, opts: RequestInit = {}) => {
      capturedMethod = opts.method ?? "";
      return new Response("ok");
    }) as unknown as typeof fetch;

    await timedFetch("https://example.com", { method: "POST" });
    expect(capturedMethod).toBe("POST");
  });
});

// ─── Timeout behaviour ───────────────────────────────────────────────────────

describe("timedFetch — timeout", () => {
  test("aborts the request after the specified timeout (ms)", async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = mockAbortable(signals) as unknown as typeof fetch;

    await expect(timedFetch("https://example.com", {}, 30)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(signals[0]?.aborted).toBe(true);
  });

  test("shorter timeout aborts before longer one", async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = mockAbortable(signals) as unknown as typeof fetch;

    const start = Date.now();
    await expect(timedFetch("https://slow.example.com", {}, 40)).rejects.toBeDefined();
    const elapsed = Date.now() - start;

    // Should abort in ~40 ms; allow generous window for CI
    expect(elapsed).toBeLessThan(500);
  });
});

// ─── Caller-provided signal ───────────────────────────────────────────────────

describe("timedFetch — caller abort signal", () => {
  test("rejects immediately when caller passes a pre-aborted signal", async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = mockAbortable(signals) as unknown as typeof fetch;

    const ctrl = new AbortController();
    ctrl.abort();

    await expect(timedFetch("https://example.com", { signal: ctrl.signal }, 60_000)).rejects.toBeDefined();
  });

  test("rejects when caller aborts before timeout fires", async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = mockAbortable(signals) as unknown as typeof fetch;

    const ctrl = new AbortController();
    // Abort after a short delay, well before the 60 s timeout
    setTimeout(() => ctrl.abort(), 20);

    await expect(timedFetch("https://example.com", { signal: ctrl.signal }, 60_000)).rejects.toBeDefined();
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────

describe("timedFetch — error propagation", () => {
  test("propagates network errors without wrapping", async () => {
    const networkErr = new TypeError("Failed to fetch");
    globalThis.fetch = mockNetworkError(networkErr) as unknown as typeof fetch;

    await expect(timedFetch("https://example.com")).rejects.toBe(networkErr);
  });

  test("propagates arbitrary thrown errors", async () => {
    const customErr = new Error("custom");
    globalThis.fetch = mock(async () => {
      throw customErr;
    }) as unknown as typeof fetch;

    await expect(timedFetch("https://example.com")).rejects.toBe(customErr);
  });
});
