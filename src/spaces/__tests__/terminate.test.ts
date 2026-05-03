/**
 * Regression tests for `terminateSpace`, the shared termination helper used
 * by both `kill_agent` (chat-tools) and `stop_agent` (agent-mcp-tools).
 *
 * These tests guard the round-3 fixes that made the two paths consistent:
 *   - The wall-clock timer is cleared from `spaceTimeoutTimers` so it can't
 *     fire after termination.
 *   - The MCP-shared Maps (callbacks/tokens/projectRoots) are unconditionally
 *     cleared so a late completion can't repopulate state.
 *   - `failSpace` is the atomic CAS — its `false` return must NOT be hidden
 *     behind a hardcoded "stopped"/"failed" status. The result must reflect
 *     the actual settled state from a fresh re-read.
 *   - The chat post lands in the sub-agent's parent channel (`space.channel`),
 *     not the caller's context channel.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Space } from "../db";

// ─── Mock state — reassign per-test, single mock.module up front ─────────────

let getSpaceImpl: (id: string) => Space | null = () => null;

mock.module("../db", () => ({
  getSpace: (id: string) => getSpaceImpl(id),
  // Stubs for transitive imports via ../manager — terminate.ts statically
  // pulls SpaceManager even when callers pass opts.spaceManager, so the
  // module must load without DB side effects.
  atomicLockSpace: () => false,
  createSpaceRecord: () => null,
  deleteSpaceAgents: () => {},
  getActiveSpaces: () => [],
  getSpaceByChannel: () => null,
  listSpaces: () => [],
  resetSpaceForRetask: () => false,
  updateCardTs: () => {},
}));

mock.module("../manager", () => ({
  // Stub class — terminate.ts only instantiates this when opts.spaceManager
  // is omitted, which our tests never do. Defining the symbol prevents the
  // static import from breaking on real DB access.
  SpaceManager: class {
    failSpace() {
      return false;
    }
  },
}));

const stopWorker = mock(() => {});
const unregisterWorker = mock((_id: string) => {});
let getWorkerImpl: (id: string) => unknown = () => undefined;

mock.module("../claude-code-worker", () => ({
  getClaudeCodeWorker: (id: string) => getWorkerImpl(id),
  unregisterClaudeCodeWorker: unregisterWorker,
}));

const spaceTimeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
const spaceCompleteCallbacks = new Map<string, () => void>();
const spaceAuthTokens = new Map<string, string>();
const spaceProjectRoots = new Map<string, string>();

mock.module("../../server/mcp", () => ({
  spaceTimeoutTimers,
  spaceCompleteCallbacks,
  spaceAuthTokens,
  spaceProjectRoots,
}));

// Dynamic import — mock.module must run first
const { terminateSpace } = await import("../terminate");

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSpaceRow(overrides: Partial<Space> = {}): Space {
  return {
    id: "space-1",
    channel: "main-channel",
    space_channel: "main-channel:space-1",
    title: "Test space",
    description: null,
    agent_id: "sub-agent-1",
    agent_color: "#aaaaaa",
    status: "active",
    source: "spawn",
    source_id: null,
    card_message_ts: null,
    timeout_seconds: 300,
    created_at: Date.now(),
    completed_at: null,
    result_summary: null,
    locked: 0,
    ...overrides,
  };
}

function captureFetch() {
  const bodies: any[] = [];
  const calls: { url: string }[] = [];
  const fn = mock(async (url: string, opts: RequestInit = {}) => {
    calls.push({ url });
    if (opts.body) {
      try {
        bodies.push(JSON.parse(opts.body as string));
      } catch {
        bodies.push(opts.body);
      }
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies, calls, fn };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("terminateSpace", () => {
  beforeEach(() => {
    spaceTimeoutTimers.clear();
    spaceCompleteCallbacks.clear();
    spaceAuthTokens.clear();
    spaceProjectRoots.clear();
    stopWorker.mockClear();
    unregisterWorker.mockClear();
    getWorkerImpl = () => undefined;
    getSpaceImpl = () => null;
  });

  afterEach(() => {
    spaceTimeoutTimers.clear();
  });

  test("clears timer + worker + MCP maps, fails space, posts agent_report to PARENT channel", async () => {
    const initialRow = makeSpaceRow({ id: "space-1", status: "active" });
    const finalRow = makeSpaceRow({ id: "space-1", status: "failed" });
    let getCalls = 0;
    getSpaceImpl = () => {
      getCalls++;
      return getCalls === 1 ? initialRow : finalRow;
    };

    getWorkerImpl = () => ({ stop: stopWorker });

    // Pre-populate all the cross-module state terminateSpace must clean up.
    const realTimer = setTimeout(() => {
      throw new Error("timer must be cleared before firing");
    }, 60_000);
    spaceTimeoutTimers.set("space-1", realTimer);
    spaceCompleteCallbacks.set("space-1", () => {});
    spaceAuthTokens.set("space-1", "tok-abc");
    spaceProjectRoots.set("space-1", "/tmp/proj");

    const failSpy = mock((_id: string, _reason: string) => true);
    const fakeManager = { failSpace: failSpy } as any;

    const { bodies, calls, fn } = captureFetch();

    const result = await terminateSpace("space-1", "Killed by parent agent", {
      chatApiUrl: "http://localhost:9999",
      fetchImpl: fn,
      spaceManager: fakeManager,
    });

    // Step 1: wall-clock timer cleared and removed from Map
    expect(spaceTimeoutTimers.has("space-1")).toBe(false);

    // Step 2+3: worker stopped + unregistered, MCP maps cleared
    expect(stopWorker).toHaveBeenCalledTimes(1);
    expect(unregisterWorker).toHaveBeenCalledWith("space-1");
    expect(spaceCompleteCallbacks.has("space-1")).toBe(false);
    expect(spaceAuthTokens.has("space-1")).toBe(false);
    expect(spaceProjectRoots.has("space-1")).toBe(false);

    // Step 4: failSpace called with the original reason
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(failSpy.mock.calls[0]).toEqual(["space-1", "Killed by parent agent"]);

    // Step 5: result reflects re-read (status="failed"), NOT a hardcoded literal
    expect(result.locked).toBe(true);
    expect(result.finalSpace?.status).toBe("failed");
    expect(result.spaceBefore?.status).toBe("active");

    // Step 6: chat post lands in PARENT channel (space.channel), with subtype=agent_report
    expect(result.postedToChat).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://localhost:9999/api/chat.postMessage");
    expect(bodies.length).toBe(1);
    expect(bodies[0].channel).toBe("main-channel"); // NOT space_channel
    expect(bodies[0].subtype).toBe("agent_report");
    expect(bodies[0].agent_id).toBe("sub-agent-1");
    expect(bodies[0].user).toBe("sub-agent-1");
    expect(bodies[0].text).toContain("Killed by parent agent");
  });

  test("when failSpace loses CAS, locked=false AND finalSpace reflects ACTUAL settled status", async () => {
    // Regression for the old stop_agent bug: it returned status:"stopped"
    // unconditionally even when the space had already settled as "completed"
    // through a concurrent path. The shared helper must re-read instead.
    const initialRow = makeSpaceRow({ id: "space-2", status: "active" });
    const settledRow = makeSpaceRow({ id: "space-2", status: "completed" });
    let getCalls = 0;
    getSpaceImpl = () => {
      getCalls++;
      return getCalls === 1 ? initialRow : settledRow;
    };

    const failSpy = mock(() => false); // CAS lost
    const fakeManager = { failSpace: failSpy } as any;

    const { fn } = captureFetch();

    const result = await terminateSpace("space-2", "Stopped by parent agent", {
      fetchImpl: fn,
      spaceManager: fakeManager,
    });

    expect(result.locked).toBe(false);
    expect(result.finalSpace?.status).toBe("completed"); // NOT "failed", NOT "stopped"
  });

  test("returns no-op result when space not found (idempotent)", async () => {
    getSpaceImpl = () => null;

    const failSpy = mock(() => true);
    const { fn } = captureFetch();

    const result = await terminateSpace("ghost-space", "reason", {
      fetchImpl: fn,
      spaceManager: { failSpace: failSpy } as any,
    });

    expect(result).toEqual({
      spaceBefore: null,
      locked: false,
      finalSpace: null,
      postedToChat: false,
    });
    // No side effects when the space doesn't exist
    expect(failSpy).not.toHaveBeenCalled();
    expect(stopWorker).not.toHaveBeenCalled();
  });

  test("clears MCP maps even when no worker is registered (late callback safety)", async () => {
    const row = makeSpaceRow({ id: "space-3" });
    getSpaceImpl = () => row;
    getWorkerImpl = () => undefined; // no worker

    spaceCompleteCallbacks.set("space-3", () => {});
    spaceAuthTokens.set("space-3", "tok");
    spaceProjectRoots.set("space-3", "/tmp");

    const fakeManager = { failSpace: mock(() => true) } as any;
    const { fn } = captureFetch();

    await terminateSpace("space-3", "reason", {
      fetchImpl: fn,
      spaceManager: fakeManager,
    });

    // Worker not stopped (none registered) but Maps still cleared
    expect(stopWorker).not.toHaveBeenCalled();
    expect(unregisterWorker).not.toHaveBeenCalled();
    expect(spaceCompleteCallbacks.has("space-3")).toBe(false);
    expect(spaceAuthTokens.has("space-3")).toBe(false);
    expect(spaceProjectRoots.has("space-3")).toBe(false);
  });
});
