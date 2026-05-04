/**
 * Tests for StreamBus — the transport seam that lets the chat plugin emit
 * setStreaming/streamToken/streamToolCall either over HTTP loopback (remote
 * worker case) or via direct in-process function calls (local case).
 *
 * Invariants verified:
 *   1. HttpStreamBus produces the same wire body the inline timedFetch path
 *      produced (byte-equivalent JSON for setStreaming, streamToken,
 *      streamToolCall — including how tool_use_id and result fields are
 *      encoded when undefined).
 *   2. HttpStreamBus swallows transport errors (best-effort: a fetch reject
 *      must not propagate to the agent loop).
 *   3. InProcessStreamBus.setStreaming replicates the server route's
 *      setAgentStreaming → if (success) broadcastAgentStreaming sequence:
 *        - setAgentStreaming always called
 *        - broadcastAgentStreaming called only when DB write returned true
 *   4. InProcessStreamBus.streamToken calls broadcastAgentToken with
 *      identical positional args to the route handler.
 *   5. InProcessStreamBus.streamToolCall calls broadcastAgentToolCall with
 *      identical args including the toolUseId pass-through.
 *   6. InProcessStreamBus swallows thrown errors from any injected dep.
 *   7. trailing-slash apiUrl normalisation works for HttpStreamBus.
 */

import { describe, expect, spyOn, test } from "bun:test";
import {
  buildStreamBus,
  HttpStreamBus,
  InProcessStreamBus,
  type InProcessStreamBusDeps,
  type StreamBus,
} from "../stream-bus";

// --------------------------------------------------------------------------
// HttpStreamBus
// --------------------------------------------------------------------------

type FetchCall = { url: string; options?: RequestInit };

function makeFakeFetch(impl?: (url: string, options?: RequestInit) => Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = (url: string, options?: RequestInit, _ms?: number): Promise<Response> => {
    calls.push({ url, options });
    if (impl) return impl(url, options);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  return { fn, calls };
}

describe("HttpStreamBus", () => {
  test("setStreaming POSTs to /api/agent.setStreaming with correct body shape", async () => {
    const { fn, calls } = makeFakeFetch();
    const bus = new HttpStreamBus("http://localhost:53456", fn);
    await bus.setStreaming("agent-1", "general", true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:53456/api/agent.setStreaming");
    expect(calls[0].options?.method).toBe("POST");
    const body = JSON.parse(calls[0].options!.body as string);
    expect(body).toEqual({
      agent_id: "agent-1",
      channel: "general",
      is_streaming: true,
    });
  });

  test("streamToken POSTs to /api/agent.streamToken with token + token_type", async () => {
    const { fn, calls } = makeFakeFetch();
    const bus = new HttpStreamBus("http://localhost:53456", fn);
    await bus.streamToken("agent-1", "general", "hello world", "content");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:53456/api/agent.streamToken");
    const body = JSON.parse(calls[0].options!.body as string);
    expect(body).toEqual({
      agent_id: "agent-1",
      channel: "general",
      token: "hello world",
      token_type: "content",
    });
  });

  test("streamToolCall POSTs to /api/agent.streamToolCall with all fields including toolUseId", async () => {
    const { fn, calls } = makeFakeFetch();
    const bus = new HttpStreamBus("http://localhost:53456", fn);
    await bus.streamToolCall("agent-1", "general", "bash", { cmd: "ls" }, "completed", "stdout-output", "ct-123");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:53456/api/agent.streamToolCall");
    const body = JSON.parse(calls[0].options!.body as string);
    expect(body).toEqual({
      agent_id: "agent-1",
      channel: "general",
      tool_name: "bash",
      tool_args: { cmd: "ls" },
      tool_use_id: "ct-123",
      status: "completed",
      result: "stdout-output",
    });
  });

  test("setStreaming: byte-identical wire body to the pre-bus inline timedFetch shape (key order pinned)", async () => {
    // Legacy inline path: agent_id, channel, is_streaming. Pin the exact JSON
    // string so a refactor that re-orders or spreads cannot silently drift.
    const { fn, calls } = makeFakeFetch();
    const bus = new HttpStreamBus("http://localhost:53456", fn);
    await bus.setStreaming("agent-1", "general", true);
    const body = calls[0].options!.body as string;
    expect(body).toBe(
      JSON.stringify({
        agent_id: "agent-1",
        channel: "general",
        is_streaming: true,
      }),
    );
  });

  test("streamToken: byte-identical wire body to the pre-bus inline timedFetch shape (key order pinned)", async () => {
    // Legacy inline path: agent_id, channel, token, token_type.
    const { fn, calls } = makeFakeFetch();
    const bus = new HttpStreamBus("http://localhost:53456", fn);
    await bus.streamToken("agent-1", "general", "hello world", "content");
    const body = calls[0].options!.body as string;
    expect(body).toBe(
      JSON.stringify({
        agent_id: "agent-1",
        channel: "general",
        token: "hello world",
        token_type: "content",
      }),
    );
  });

  test("streamToolCall: byte-identical wire body to the pre-bus inline timedFetch shape (key order pinned)", async () => {
    // The legacy inline path serialised JSON with this exact key order:
    // agent_id, channel, tool_name, tool_args, tool_use_id, status, result.
    // Object literal property order is preserved by V8/Bun, so the wire body
    // is deterministic — pin it as a string-equality test so a future refactor
    // (e.g. spread into a different shape) can't silently change byte output.
    const { fn, calls } = makeFakeFetch();
    const bus = new HttpStreamBus("http://localhost:53456", fn);
    await bus.streamToolCall("agent-1", "general", "bash", { cmd: "ls" }, "completed", "stdout-output", "ct-123");
    const body = calls[0].options!.body as string;
    expect(body).toBe(
      JSON.stringify({
        agent_id: "agent-1",
        channel: "general",
        tool_name: "bash",
        tool_args: { cmd: "ls" },
        tool_use_id: "ct-123",
        status: "completed",
        result: "stdout-output",
      }),
    );
  });

  test("streamToolCall: undefined result + undefined toolUseId omitted from JSON (matches legacy wire shape)", async () => {
    const { fn, calls } = makeFakeFetch();
    const bus = new HttpStreamBus("http://localhost:53456", fn);
    await bus.streamToolCall("agent-1", "general", "view", { path: "/x" }, "started");
    const body = calls[0].options!.body as string;
    // JSON.stringify drops undefined values — so neither field key appears.
    expect(body).not.toContain("tool_use_id");
    expect(body).not.toContain("result");
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({
      agent_id: "agent-1",
      channel: "general",
      tool_name: "view",
      tool_args: { path: "/x" },
      status: "started",
    });
  });

  test("trailing slash on apiUrl is normalised", async () => {
    const { fn, calls } = makeFakeFetch();
    const bus = new HttpStreamBus("http://localhost:53456/", fn);
    await bus.setStreaming("a", "c", false);
    expect(calls[0].url).toBe("http://localhost:53456/api/agent.setStreaming");
  });

  test("setStreaming swallows fetch rejections (best-effort)", async () => {
    const { fn } = makeFakeFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const bus = new HttpStreamBus("http://localhost:53456", fn);
    // Should not throw.
    await expect(bus.setStreaming("a", "c", true)).resolves.toBeUndefined();
  });

  test("streamToken swallows fetch rejections (best-effort)", async () => {
    const { fn } = makeFakeFetch(() => Promise.reject(new Error("timeout")));
    const bus = new HttpStreamBus("http://localhost:53456", fn);
    await expect(bus.streamToken("a", "c", "tok", "content")).resolves.toBeUndefined();
  });

  test("streamToolCall swallows fetch rejections (best-effort)", async () => {
    const { fn } = makeFakeFetch(() => Promise.reject(new Error("net")));
    const bus = new HttpStreamBus("http://localhost:53456", fn);
    await expect(bus.streamToolCall("a", "c", "bash", {}, "started")).resolves.toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// InProcessStreamBus
// --------------------------------------------------------------------------

interface SpyCalls {
  setAgentStreaming: Array<[string, string, boolean]>;
  broadcastAgentStreaming: Array<[string, string, boolean]>;
  broadcastAgentToken: Array<[string, string, string, string]>;
  broadcastAgentToolCall: Array<[string, string, string, any, string, any?, string?]>;
}

function makeSpyDeps(opts: { setStreamingResult?: boolean; throwIn?: keyof InProcessStreamBusDeps } = {}): {
  deps: InProcessStreamBusDeps;
  calls: SpyCalls;
} {
  const calls: SpyCalls = {
    setAgentStreaming: [],
    broadcastAgentStreaming: [],
    broadcastAgentToken: [],
    broadcastAgentToolCall: [],
  };
  const setStreamingResult = opts.setStreamingResult ?? true;
  const deps: InProcessStreamBusDeps = {
    setAgentStreaming: (a, c, s) => {
      if (opts.throwIn === "setAgentStreaming") throw new Error("boom");
      calls.setAgentStreaming.push([a, c, s]);
      return setStreamingResult;
    },
    broadcastAgentStreaming: (c, a, s) => {
      if (opts.throwIn === "broadcastAgentStreaming") throw new Error("boom");
      calls.broadcastAgentStreaming.push([c, a, s]);
    },
    broadcastAgentToken: (c, a, t, tt) => {
      if (opts.throwIn === "broadcastAgentToken") throw new Error("boom");
      calls.broadcastAgentToken.push([c, a, t, tt]);
    },
    broadcastAgentToolCall: (c, a, n, args, status, result, tid) => {
      if (opts.throwIn === "broadcastAgentToolCall") throw new Error("boom");
      calls.broadcastAgentToolCall.push([c, a, n, args, status, result, tid]);
    },
  };
  return { deps, calls };
}

describe("InProcessStreamBus", () => {
  test("setStreaming: DB write succeeds → broadcasts (matches /api/agent.setStreaming route)", async () => {
    const { deps, calls } = makeSpyDeps({ setStreamingResult: true });
    const bus: StreamBus = new InProcessStreamBus(deps);
    await bus.setStreaming("agent-1", "general", true);
    expect(calls.setAgentStreaming).toEqual([["agent-1", "general", true]]);
    // Note arg order: broadcast takes (channel, agentId, isStreaming)
    expect(calls.broadcastAgentStreaming).toEqual([["general", "agent-1", true]]);
  });

  test("setStreaming: DB write fails → does NOT broadcast (matches route's `if (success)` guard)", async () => {
    const { deps, calls } = makeSpyDeps({ setStreamingResult: false });
    const bus = new InProcessStreamBus(deps);
    await bus.setStreaming("agent-1", "general", true);
    expect(calls.setAgentStreaming).toEqual([["agent-1", "general", true]]);
    expect(calls.broadcastAgentStreaming).toEqual([]);
  });

  test("streamToken delegates to broadcastAgentToken with positional args matching route", async () => {
    const { deps, calls } = makeSpyDeps();
    const bus = new InProcessStreamBus(deps);
    await bus.streamToken("agent-1", "general", "hello", "content");
    expect(calls.broadcastAgentToken).toEqual([["general", "agent-1", "hello", "content"]]);
  });

  test("streamToken passes through 'thinking' and 'event' token types", async () => {
    const { deps, calls } = makeSpyDeps();
    const bus = new InProcessStreamBus(deps);
    await bus.streamToken("a", "c", "think-tok", "thinking");
    await bus.streamToken("a", "c", "evt-tok", "event");
    expect(calls.broadcastAgentToken[0][3]).toBe("thinking");
    expect(calls.broadcastAgentToken[1][3]).toBe("event");
  });

  test("streamToolCall delegates to broadcastAgentToolCall with all fields including toolUseId", async () => {
    const { deps, calls } = makeSpyDeps();
    const bus = new InProcessStreamBus(deps);
    await bus.streamToolCall("agent-1", "general", "bash", { cmd: "ls" }, "completed", "result-data", "ct-42");
    expect(calls.broadcastAgentToolCall).toEqual([
      ["general", "agent-1", "bash", { cmd: "ls" }, "completed", "result-data", "ct-42"],
    ]);
  });

  test("streamToolCall with undefined result + toolUseId passes through as undefined", async () => {
    const { deps, calls } = makeSpyDeps();
    const bus = new InProcessStreamBus(deps);
    await bus.streamToolCall("agent-1", "general", "view", { path: "/" }, "started");
    expect(calls.broadcastAgentToolCall).toEqual([
      ["general", "agent-1", "view", { path: "/" }, "started", undefined, undefined],
    ]);
  });

  test("setStreaming swallows throws from setAgentStreaming (best-effort) AND surfaces exactly one console.warn", async () => {
    // The InProcessStreamBus.setStreaming catch is the ONLY error path that
    // logs (DB-write failures are operationally relevant — they used to surface
    // as non-2xx on the old HTTP loopback). Pin both the swallow AND the warn
    // count so a future refactor can't either (a) regress to silent failure or
    // (b) accidentally log per-token bursts.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { deps } = makeSpyDeps({ throwIn: "setAgentStreaming" });
      const bus = new InProcessStreamBus(deps);
      await expect(bus.setStreaming("a", "c", true)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("[InProcessStreamBus] setStreaming failed");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("setStreaming swallows throws from broadcastAgentStreaming (best-effort) AND surfaces exactly one console.warn", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { deps, calls } = makeSpyDeps({ throwIn: "broadcastAgentStreaming" });
      const bus = new InProcessStreamBus(deps);
      await expect(bus.setStreaming("a", "c", true)).resolves.toBeUndefined();
      // DB write still happened (the throw came from the broadcast)
      expect(calls.setAgentStreaming).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("[InProcessStreamBus] setStreaming failed");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("streamToken swallows throws (best-effort)", async () => {
    const { deps } = makeSpyDeps({ throwIn: "broadcastAgentToken" });
    const bus = new InProcessStreamBus(deps);
    await expect(bus.streamToken("a", "c", "tok", "content")).resolves.toBeUndefined();
  });

  test("streamToolCall swallows throws (best-effort)", async () => {
    const { deps } = makeSpyDeps({ throwIn: "broadcastAgentToolCall" });
    const bus = new InProcessStreamBus(deps);
    await expect(bus.streamToolCall("a", "c", "bash", {}, "started")).resolves.toBeUndefined();
  });

  test("multiple sequential calls accumulate independently (no shared state leakage)", async () => {
    const { deps, calls } = makeSpyDeps();
    const bus = new InProcessStreamBus(deps);
    await bus.setStreaming("a", "general", true);
    await bus.streamToken("a", "general", "hi", "content");
    await bus.streamToolCall("a", "general", "bash", { cmd: "ls" }, "started");
    await bus.setStreaming("a", "general", false);
    expect(calls.setAgentStreaming).toHaveLength(2);
    expect(calls.broadcastAgentStreaming).toHaveLength(2);
    expect(calls.broadcastAgentToken).toHaveLength(1);
    expect(calls.broadcastAgentToolCall).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// buildStreamBus — selection factory
// --------------------------------------------------------------------------

describe("buildStreamBus", () => {
  test("directDb=true → returns InProcessStreamBus", () => {
    const { deps } = makeSpyDeps();
    const bus = buildStreamBus(true, deps);
    expect(bus).toBeInstanceOf(InProcessStreamBus);
  });

  test("directDb=undefined → returns InProcessStreamBus (default-on; matches `directDb !== false` gate)", () => {
    // worker-loop.ts and several call-sites use `this.config.directDb !== false`
    // which treats undefined as in-process. This test pins that contract — if
    // someone changes the default to remote, remote workers will silently
    // route through HTTP and this test will catch it.
    const { deps } = makeSpyDeps();
    const bus = buildStreamBus(undefined, deps);
    expect(bus).toBeInstanceOf(InProcessStreamBus);
  });

  test("directDb=false → returns undefined (remote worker case; chat plugin falls back to HttpStreamBus)", () => {
    const { deps } = makeSpyDeps();
    const bus = buildStreamBus(false, deps);
    expect(bus).toBeUndefined();
  });

  test("returned bus integrates correctly: setStreaming → setAgentStreaming + broadcast", async () => {
    const { deps, calls } = makeSpyDeps();
    const bus = buildStreamBus(true, deps);
    expect(bus).toBeDefined();
    await bus!.setStreaming("agent-x", "channel-y", true);
    expect(calls.setAgentStreaming).toEqual([["agent-x", "channel-y", true]]);
    expect(calls.broadcastAgentStreaming).toEqual([["channel-y", "agent-x", true]]);
  });
});
