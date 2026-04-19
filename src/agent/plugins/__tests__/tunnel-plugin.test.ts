/**
 * Tests for TunnelPlugin's handler surface (the args→result shape agents see).
 *
 * The plugin is a thin adapter over `tunnelManager` — these tests mock the
 * singleton so we can focus on argument validation, owner context injection,
 * filter wiring, and response shape without touching tmux / cloudflared.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the manager module BEFORE importing the plugin so the plugin binds
// to the mocked singleton.
const calls: Array<{ method: string; args: unknown }> = [];
let createImpl: (opts: unknown) => Promise<unknown> = async () => ({
  id: "t-1",
  publicUrl: "https://example.trycloudflare.com",
  localUrl: "http://localhost:3000",
  reused: false,
});
let getImpl: (id: string) => unknown | undefined = () => ({
  id: "t-1",
  localUrl: "http://localhost:3000",
  publicUrl: "https://example.trycloudflare.com",
  status: "running",
  createdAt: Date.now(),
  uptimeSeconds: 1,
});
let listImpl: (filter?: unknown) => unknown[] = () => [];
let destroyImpl: (id: string) => boolean = () => true;
let pruneImpl: (filter: unknown) => string[] = () => [];

mock.module("../tunnel-manager", () => ({
  tunnelManager: {
    create: (opts: unknown) => {
      calls.push({ method: "create", args: opts });
      return createImpl(opts);
    },
    get: (id: string) => {
      calls.push({ method: "get", args: id });
      return getImpl(id);
    },
    list: (filter?: unknown) => {
      calls.push({ method: "list", args: filter });
      return listImpl(filter);
    },
    destroy: (id: string) => {
      calls.push({ method: "destroy", args: id });
      return destroyImpl(id);
    },
    prune: (filter: unknown) => {
      calls.push({ method: "prune", args: filter });
      return pruneImpl(filter);
    },
  },
}));

import { TunnelPlugin } from "../tunnel-plugin";

beforeEach(() => {
  calls.length = 0;
  // Reset to permissive defaults each test; individual tests override.
  createImpl = async () => ({
    id: "t-1",
    publicUrl: "https://example.trycloudflare.com",
    localUrl: "http://localhost:3000",
    reused: false,
  });
  getImpl = () => ({
    id: "t-1",
    localUrl: "http://localhost:3000",
    publicUrl: "https://example.trycloudflare.com",
    status: "running",
    createdAt: Date.now(),
    uptimeSeconds: 1,
  });
  listImpl = () => [];
  destroyImpl = () => true;
  pruneImpl = () => [];
});

afterEach(() => {
  calls.length = 0;
});

function getHandler(plugin: TunnelPlugin, name: string) {
  const tool = plugin.getTools().find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool.handler;
}

// ============================================================================
// tunnel_create
// ============================================================================

describe("tunnel_create", () => {
  test("passes owner context (channel, agentId) through to the manager", async () => {
    const plugin = new TunnelPlugin("ch-42", "agent-x");
    await getHandler(plugin, "tunnel_create")({ url: "http://localhost:3000" });
    const createCall = calls.find((c) => c.method === "create");
    expect(createCall).toBeDefined();
    expect((createCall?.args as any).channel).toBe("ch-42");
    expect((createCall?.args as any).agentId).toBe("agent-x");
    expect((createCall?.args as any).localUrl).toBe("http://localhost:3000");
  });

  test("rejects missing url", async () => {
    const res = await getHandler(new TunnelPlugin(), "tunnel_create")({});
    expect(res.success).toBe(false);
    expect(res.error).toContain("url is required");
  });

  test("rejects non-http(s) URL", async () => {
    const res = await getHandler(new TunnelPlugin(), "tunnel_create")({ url: "ftp://x/" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("http://");
  });

  test("rejects malformed URL", async () => {
    const res = await getHandler(new TunnelPlugin(), "tunnel_create")({ url: "not a url" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Invalid URL");
  });

  test("returns reused=false for a fresh tunnel", async () => {
    const res = await getHandler(new TunnelPlugin(), "tunnel_create")({ url: "http://localhost:3000" });
    expect(res.success).toBe(true);
    const body = JSON.parse(res.output);
    expect(body.reused).toBe(false);
    expect(body.public_url).toBe("https://example.trycloudflare.com");
    expect(body.message).toContain("Tunnel created");
  });

  test("returns reused=true + owner when the manager reports a dedupe hit", async () => {
    createImpl = async () => ({
      id: "t-existing",
      publicUrl: "https://shared.trycloudflare.com",
      localUrl: "http://localhost:3000",
      reused: true,
      owner: { channel: "original-ch", agentId: "original-ag" },
    });
    const res = await getHandler(
      new TunnelPlugin("new-ch", "new-ag"),
      "tunnel_create",
    )({
      url: "http://localhost:3000",
    });
    expect(res.success).toBe(true);
    const body = JSON.parse(res.output);
    expect(body.reused).toBe(true);
    expect(body.owner.channel).toBe("original-ch");
    expect(body.owner.agentId).toBe("original-ag");
    expect(body.message).toContain("Tunnel reused");
  });

  test("surfaces manager error", async () => {
    createImpl = async () => {
      throw new Error("cloudflared is not installed");
    };
    const res = await getHandler(new TunnelPlugin(), "tunnel_create")({ url: "http://localhost:3000" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("cloudflared is not installed");
  });

  test("rejects URL with shell-special characters before reaching the manager", async () => {
    // The plugin's `new URL(...)` check may or may not accept these; the
    // manager has its own injection-safe regex. But for some inputs the
    // plugin's URL parser rejects first (backtick, quote). Verify that when
    // the plugin DOES pass through (e.g. $PATH-style strings are technically
    // valid URL hosts), the manager's error surfaces cleanly to the agent.
    createImpl = async () => {
      throw new Error('localUrl contains unsafe characters (one of " ` $ \\ \\n \\r)');
    };
    const res = await getHandler(new TunnelPlugin(), "tunnel_create")({ url: "http://foo$evil.com" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("unsafe characters");
  });
});

// ============================================================================
// tunnel_destroy
// ============================================================================

describe("tunnel_destroy", () => {
  test("rejects missing id", async () => {
    const res = await getHandler(new TunnelPlugin(), "tunnel_destroy")({});
    expect(res.success).toBe(false);
    expect(res.error).toContain("id is required");
  });

  test("returns helpful error with the list of active tunnels when id is unknown", async () => {
    getImpl = () => undefined;
    listImpl = () => [
      { id: "alpha", localUrl: "http://localhost:3000", status: "running", createdAt: 0, uptimeSeconds: 0 },
      { id: "beta", localUrl: "http://localhost:3001", status: "running", createdAt: 0, uptimeSeconds: 0 },
    ];
    const res = await getHandler(new TunnelPlugin(), "tunnel_destroy")({ id: "gone" });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Tunnel "gone" not found');
    expect(res.error).toContain("alpha");
    expect(res.error).toContain("beta");
  });

  test("destroys and returns confirmation when id exists", async () => {
    const res = await getHandler(new TunnelPlugin(), "tunnel_destroy")({ id: "t-1" });
    expect(res.success).toBe(true);
    const body = JSON.parse(res.output);
    expect(body.id).toBe("t-1");
    expect(body.message).toContain("destroyed");
    expect(body.message).toContain("http://localhost:3000");
    expect(calls.some((c) => c.method === "destroy" && c.args === "t-1")).toBe(true);
  });
});

// ============================================================================
// tunnel_list
// ============================================================================

describe("tunnel_list", () => {
  test("no filter → passes empty filter object", async () => {
    await getHandler(new TunnelPlugin(), "tunnel_list")({});
    const listCall = calls.find((c) => c.method === "list");
    expect(listCall?.args).toEqual({});
  });

  test("mine=true with agent context → passes agentId filter", async () => {
    await getHandler(new TunnelPlugin("ch", "agent-x"), "tunnel_list")({ mine: true });
    const listCall = calls.find((c) => c.method === "list");
    expect((listCall?.args as any).agentId).toBe("agent-x");
  });

  test("mine=true WITHOUT agent context → returns error (no silent unscoped fallback)", async () => {
    const res = await getHandler(new TunnelPlugin(), "tunnel_list")({ mine: true });
    expect(res.success).toBe(false);
    expect(res.error).toContain("no agent context");
    // Manager.list must NOT have been called at all — we bail before it.
    expect(calls.find((c) => c.method === "list")).toBeUndefined();
  });

  test("status filter with invalid value is rejected (prevents silent empty results)", async () => {
    const res = await getHandler(new TunnelPlugin(), "tunnel_list")({ status: "runnig" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Invalid status filter");
    expect(res.error).toContain("running");
    expect(res.error).toContain("reconnecting");
    expect(res.error).toContain("dead");
  });

  test("status filter accepts valid enum values", async () => {
    for (const status of ["running", "reconnecting", "dead"] as const) {
      const res = await getHandler(new TunnelPlugin(), "tunnel_list")({ status });
      expect(res.success).toBe(true);
    }
  });

  test("channel / local_url / status filters are forwarded", async () => {
    await getHandler(
      new TunnelPlugin(),
      "tunnel_list",
    )({
      channel: "ch-7",
      local_url: "http://localhost:4000",
      status: "running",
    });
    const listCall = calls.find((c) => c.method === "list");
    expect(listCall?.args).toEqual({
      channel: "ch-7",
      localUrl: "http://localhost:4000",
      status: "running",
    });
  });

  test("response reshapes manager rows into snake_case JSON", async () => {
    listImpl = () => [
      {
        id: "t-1",
        localUrl: "http://localhost:3000",
        publicUrl: "https://x.trycloudflare.com",
        status: "running",
        createdAt: 1000,
        uptimeSeconds: 42,
        channel: "ch-a",
        agentId: "ag-a",
      },
    ];
    const res = await getHandler(new TunnelPlugin(), "tunnel_list")({});
    expect(res.success).toBe(true);
    const body = JSON.parse(res.output);
    expect(body.count).toBe(1);
    expect(body.tunnels[0]).toEqual({
      id: "t-1",
      public_url: "https://x.trycloudflare.com",
      local_url: "http://localhost:3000",
      status: "running",
      uptime_seconds: 42,
      channel: "ch-a",
      agent_id: "ag-a",
    });
  });
});

// ============================================================================
// tunnel_prune
// ============================================================================

describe("tunnel_prune", () => {
  test("rejects an empty filter to prevent accidental full-wipe", async () => {
    const res = await getHandler(new TunnelPlugin(), "tunnel_prune")({});
    expect(res.success).toBe(false);
    expect(res.error).toContain("at least one non-trivial filter");
    expect(calls.find((c) => c.method === "prune")).toBeUndefined();
  });

  test("rejects trivial filter {older_than_seconds: 0} — matches everything, same as empty", async () => {
    const res = await getHandler(new TunnelPlugin(), "tunnel_prune")({ older_than_seconds: 0 });
    expect(res.success).toBe(false);
    expect(res.error).toContain("non-trivial");
    expect(calls.find((c) => c.method === "prune")).toBeUndefined();
  });

  test("rejects dead_only=false as trivial", async () => {
    const res = await getHandler(new TunnelPlugin(), "tunnel_prune")({ dead_only: false });
    expect(res.success).toBe(false);
    expect(res.error).toContain("non-trivial");
    expect(calls.find((c) => c.method === "prune")).toBeUndefined();
  });

  test("rejects negative or non-finite older_than_seconds", async () => {
    const neg = await getHandler(new TunnelPlugin(), "tunnel_prune")({ older_than_seconds: -5 });
    expect(neg.success).toBe(false);
    expect(neg.error).toContain("non-negative");

    const nan = await getHandler(new TunnelPlugin(), "tunnel_prune")({ older_than_seconds: Number.NaN });
    expect(nan.success).toBe(false);
    expect(nan.error).toContain("non-negative");
  });

  test("accepts older_than_seconds>0 alone", async () => {
    pruneImpl = () => ["old-1"];
    const res = await getHandler(new TunnelPlugin(), "tunnel_prune")({ older_than_seconds: 30 });
    expect(res.success).toBe(true);
    expect(JSON.parse(res.output).removed_ids).toEqual(["old-1"]);
  });

  test("accepts dead_only=true alone", async () => {
    pruneImpl = () => ["dead-1", "dead-2"];
    const res = await getHandler(new TunnelPlugin(), "tunnel_prune")({ dead_only: true });
    expect(res.success).toBe(true);
    expect(JSON.parse(res.output).removed_count).toBe(2);
  });

  test("translates older_than_seconds → olderThanMs", async () => {
    pruneImpl = () => ["t-old-1", "t-old-2"];
    await getHandler(new TunnelPlugin(), "tunnel_prune")({ older_than_seconds: 60 });
    const pruneCall = calls.find((c) => c.method === "prune");
    expect((pruneCall?.args as any).olderThanMs).toBe(60000);
  });

  test("passes all filter dimensions through", async () => {
    pruneImpl = () => [];
    await getHandler(
      new TunnelPlugin(),
      "tunnel_prune",
    )({
      dead_only: true,
      local_url: "http://localhost:3000",
      channel: "ch-7",
      agent_id: "ag-7",
    });
    const pruneCall = calls.find((c) => c.method === "prune");
    expect(pruneCall?.args).toEqual({
      deadOnly: true,
      localUrl: "http://localhost:3000",
      channel: "ch-7",
      agentId: "ag-7",
    });
  });

  test("returns removed_count + removed_ids", async () => {
    pruneImpl = () => ["a", "b", "c"];
    const res = await getHandler(new TunnelPlugin(), "tunnel_prune")({ dead_only: true });
    expect(res.success).toBe(true);
    const body = JSON.parse(res.output);
    expect(body.removed_count).toBe(3);
    expect(body.removed_ids).toEqual(["a", "b", "c"]);
  });
});

// ============================================================================
// destroyAll is a documented noop (backwards compat)
// ============================================================================

describe("TunnelPlugin.destroyAll (backwards-compat noop)", () => {
  test("does not invoke any manager method", () => {
    TunnelPlugin.destroyAll();
    expect(calls.filter((c) => c.method === "destroy" || c.method === "prune").length).toBe(0);
  });
});
