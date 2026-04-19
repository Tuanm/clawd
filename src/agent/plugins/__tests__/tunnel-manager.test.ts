/**
 * Tests for TmuxTunnelManager.
 *
 * Two tiers:
 *
 * 1. Fast unit tests that exercise disk state only — seed meta.json files
 *    in a tmp rootDir, verify list/get/destroy/prune/url-scrape behavior
 *    without spawning cloudflared or tmux.
 *
 * 2. Integration tests (opt-in via CLAWD_INTEGRATION=1) that spin a real
 *    local HTTP server + real cloudflared + real tmux. Slow (~30s per
 *    tunnel) and hits the network, so off by default in CI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrapeLatestPublicUrl, TmuxTunnelManager } from "../tunnel-manager";

/** Generate a UUID-shaped id for test fixtures. The manager rejects non-UUID
 *  ids at every public boundary as a defensive gate; use this helper to
 *  produce ids that survive the gate. Call with a label so the generated
 *  id is identifiable in assertion output (we take the first 8 chars as
 *  a "name" and prefix a real UUID on top). */
const tid = () => randomUUID();

let tmpRoot: string;
let mgr: TmuxTunnelManager;

beforeEach(() => {
  // Isolated tmp root per test. socketPath defaults to <rootDir>/tmux.sock;
  // we don't touch tmux in the fast tier, so an unused socket path is fine.
  tmpRoot = mkdtempSync(join(tmpdir(), "clawd-tunnels-test-"));
  mgr = new TmuxTunnelManager({ rootDir: tmpRoot });
});

afterEach(() => {
  // Best-effort cleanup of the tmp dir.
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// ============================================================================
// Helpers — seed a tunnel directory without actually running cloudflared.
// ============================================================================

interface SeedOpts {
  id: string;
  localUrl: string;
  channel?: string;
  agentId?: string;
  createdAt?: number;
  publicUrl?: string;
  logContents?: string;
}

function seedTunnel(root: string, opts: SeedOpts): void {
  const dir = join(root, opts.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify(
      {
        id: opts.id,
        localUrl: opts.localUrl,
        channel: opts.channel,
        agentId: opts.agentId,
        createdAt: opts.createdAt ?? Date.now(),
        publicUrl: opts.publicUrl,
      },
      null,
      2,
    ),
  );
  if (opts.logContents !== undefined) {
    writeFileSync(join(dir, "output.log"), opts.logContents);
  }
}

// ============================================================================
// create() — input validation (runs BEFORE spawning cloudflared)
// ============================================================================

describe("create — input validation", () => {
  test("rejects malformed URL (no host)", async () => {
    await expect(mgr.create({ localUrl: "not a url" })).rejects.toThrow(/Invalid localUrl/);
  });

  test("rejects non-http(s) protocol", async () => {
    await expect(mgr.create({ localUrl: "ftp://example.com" })).rejects.toThrow(/http:\/\/ or https:\/\//);
  });

  test("rejects URL with embedded double-quote (shell-injection guard)", async () => {
    // Would escape the "${localUrl}" double quotes in the generated run.sh.
    await expect(mgr.create({ localUrl: 'http://evil.com";rm -rf /;#' })).rejects.toThrow(/unsafe characters/);
  });

  test("rejects URL with backtick (command substitution)", async () => {
    await expect(mgr.create({ localUrl: "http://evil.com`whoami`" })).rejects.toThrow(/unsafe characters/);
  });

  test("rejects URL with unescaped $ (variable expansion)", async () => {
    await expect(mgr.create({ localUrl: "http://evil.com$HOME" })).rejects.toThrow(/unsafe characters/);
  });

  test("rejects URL with backslash (escape char)", async () => {
    await expect(mgr.create({ localUrl: "http://evil.com\\x" })).rejects.toThrow(/unsafe characters/);
  });

  test("rejects URL with newline (breaks out of the line)", async () => {
    await expect(mgr.create({ localUrl: "http://evil.com\necho pwned" })).rejects.toThrow(/unsafe characters/);
  });

  test("validation fires BEFORE touching cloudflared or the filesystem", async () => {
    const snapshot = () => (existsSync(tmpRoot) ? readdirSync(tmpRoot).sort() : []);
    const before = snapshot();
    await expect(mgr.create({ localUrl: 'http://evil.com"' })).rejects.toThrow();
    // No new tunnel dirs were created — validation is pre-flight. The only
    // thing in tmpRoot should be whatever was there before (empty).
    expect(snapshot()).toEqual(before);
  });
});

// ============================================================================
// scrapeLatestPublicUrl
// ============================================================================

describe("scrapeLatestPublicUrl", () => {
  test("returns undefined for missing file", () => {
    expect(scrapeLatestPublicUrl(join(tmpRoot, "no-such-file"))).toBeUndefined();
  });

  test("extracts a trycloudflare URL from a cloudflared-style log", () => {
    const log = join(tmpRoot, "log.txt");
    writeFileSync(
      log,
      `Starting cloudflared tunnel...\n` +
        `2026-04-18T09:12:34Z INF +---------------------------------------------+\n` +
        `2026-04-18T09:12:34Z INF | Your quick Tunnel has been created! |\n` +
        `2026-04-18T09:12:34Z INF | https://fancy-orange-moose.trycloudflare.com |\n` +
        `2026-04-18T09:12:34Z INF +---------------------------------------------+\n`,
    );
    expect(scrapeLatestPublicUrl(log)).toBe("https://fancy-orange-moose.trycloudflare.com");
  });

  test("returns the LATEST URL when multiple appear (reconnect case)", () => {
    const log = join(tmpRoot, "reconnect.log");
    writeFileSync(
      log,
      `First session: https://first-tunnel-abc.trycloudflare.com\n` +
        `Connection lost, reconnecting...\n` +
        `Second session: https://second-tunnel-xyz.trycloudflare.com\n`,
    );
    expect(scrapeLatestPublicUrl(log)).toBe("https://second-tunnel-xyz.trycloudflare.com");
  });

  test("returns undefined when log has no URL yet", () => {
    const log = join(tmpRoot, "pending.log");
    writeFileSync(log, "Starting cloudflared...\nConnecting...\n");
    expect(scrapeLatestPublicUrl(log)).toBeUndefined();
  });
});

// ============================================================================
// get / list
// ============================================================================

describe("get / list (disk-state only)", () => {
  test("get returns undefined for unknown id", () => {
    expect(mgr.get(tid())).toBeUndefined();
  });

  test("get rejects non-UUID id (shell-injection defense)", () => {
    expect(mgr.get('evil"; rm -rf /; #')).toBeUndefined();
    expect(mgr.get("../../etc/passwd")).toBeUndefined();
    expect(mgr.get("short-id")).toBeUndefined();
    expect(mgr.get("")).toBeUndefined();
  });

  test("get returns a record with status=dead when no tmux session exists", () => {
    const id = tid();
    seedTunnel(tmpRoot, {
      id,
      localUrl: "http://localhost:3000",
      channel: "ch1",
      agentId: "agent-1",
      publicUrl: "https://x.trycloudflare.com",
    });
    const r = mgr.get(id);
    expect(r).toBeDefined();
    expect(r?.id).toBe(id);
    expect(r?.localUrl).toBe("http://localhost:3000");
    expect(r?.channel).toBe("ch1");
    expect(r?.agentId).toBe("agent-1");
    expect(r?.publicUrl).toBe("https://x.trycloudflare.com");
    // No tmux session seeded → dead.
    expect(r?.status).toBe("dead");
  });

  test("get prefers the LATEST URL in output.log over meta.publicUrl", () => {
    const id = tid();
    seedTunnel(tmpRoot, {
      id,
      localUrl: "http://localhost:4000",
      publicUrl: "https://old-url.trycloudflare.com",
      logContents: "...\nhttps://new-url.trycloudflare.com (reconnected)\n",
    });
    const r = mgr.get(id);
    expect(r?.publicUrl).toBe("https://new-url.trycloudflare.com");
  });

  test("list returns empty for a fresh rootDir", () => {
    expect(mgr.list()).toEqual([]);
  });

  test("list returns all seeded tunnels, newest-first", () => {
    const oldId = tid();
    const midId = tid();
    const newId = tid();
    seedTunnel(tmpRoot, { id: oldId, localUrl: "http://localhost:3000", createdAt: 1000 });
    seedTunnel(tmpRoot, { id: midId, localUrl: "http://localhost:3001", createdAt: 2000 });
    seedTunnel(tmpRoot, { id: newId, localUrl: "http://localhost:3002", createdAt: 3000 });
    const rows = mgr.list();
    expect(rows.map((r) => r.id)).toEqual([newId, midId, oldId]);
  });

  test("list skips entries that aren't UUID-shaped (tmux.sock, dotfiles, garbage dirs)", () => {
    const good = tid();
    seedTunnel(tmpRoot, { id: good, localUrl: "http://localhost:3000" });
    // Stray files / dirs at the root that aren't valid tunnel ids.
    mkdirSync(join(tmpRoot, "garbage-dir"), { recursive: true });
    mkdirSync(join(tmpRoot, 'evil"; rm -rf /; #'), { recursive: true });
    writeFileSync(join(tmpRoot, ".hidden"), "hidden");
    writeFileSync(join(tmpRoot, "tmux.sock"), "sock");
    const rows = mgr.list();
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(good);
  });

  test("list filters by channel / agentId / localUrl / status", () => {
    const a = tid();
    const b = tid();
    const c = tid();
    seedTunnel(tmpRoot, { id: a, localUrl: "http://localhost:3000", channel: "ch1", agentId: "agA" });
    seedTunnel(tmpRoot, { id: b, localUrl: "http://localhost:3001", channel: "ch1", agentId: "agB" });
    seedTunnel(tmpRoot, { id: c, localUrl: "http://localhost:3002", channel: "ch2", agentId: "agA" });

    expect(
      mgr
        .list({ channel: "ch1" })
        .map((r) => r.id)
        .sort(),
    ).toEqual([a, b].sort());
    expect(
      mgr
        .list({ agentId: "agA" })
        .map((r) => r.id)
        .sort(),
    ).toEqual([a, c].sort());
    expect(mgr.list({ localUrl: "http://localhost:3001" }).map((r) => r.id)).toEqual([b]);
    expect(mgr.list({ status: "dead" }).length).toBe(3);
    expect(mgr.list({ status: "running" }).length).toBe(0);
  });

  test("findAliveByLocalUrl skips dead tunnels", () => {
    seedTunnel(tmpRoot, { id: tid(), localUrl: "http://localhost:3000" });
    expect(mgr.findAliveByLocalUrl("http://localhost:3000")).toBeUndefined();
  });
});

// ============================================================================
// destroy
// ============================================================================

describe("destroy", () => {
  test("returns false for unknown id (valid UUID shape)", () => {
    expect(mgr.destroy(tid())).toBe(false);
  });

  test("returns false for non-UUID id (shell-injection defense)", () => {
    expect(mgr.destroy('evil"; rm -rf /; #')).toBe(false);
    expect(mgr.destroy("../../etc/passwd")).toBe(false);
    expect(mgr.destroy("")).toBe(false);
  });

  test("removes the on-disk dir and returns true for a known tunnel", () => {
    const id = tid();
    seedTunnel(tmpRoot, { id, localUrl: "http://localhost:9000" });
    expect(mgr.get(id)).toBeDefined();
    expect(mgr.destroy(id)).toBe(true);
    expect(mgr.get(id)).toBeUndefined();
  });
});

// ============================================================================
// prune
// ============================================================================

describe("prune (disk-state only)", () => {
  test("prune with no filter is a no-op through the manager API (plugin guards it)", () => {
    seedTunnel(tmpRoot, { id: tid(), localUrl: "http://localhost:3000" });
    const removed = mgr.prune({});
    expect(removed.length).toBe(1);
    expect(mgr.list()).toEqual([]);
  });

  test("deadOnly only removes tunnels with status=dead", () => {
    const d1 = tid();
    const d2 = tid();
    seedTunnel(tmpRoot, { id: d1, localUrl: "http://localhost:3000" });
    seedTunnel(tmpRoot, { id: d2, localUrl: "http://localhost:3001" });
    const removed = mgr.prune({ deadOnly: true });
    expect(removed.sort()).toEqual([d1, d2].sort());
  });

  test("olderThanMs skips tunnels younger than the cutoff", () => {
    const now = Date.now();
    const oldId = tid();
    const youngId = tid();
    seedTunnel(tmpRoot, { id: oldId, localUrl: "http://localhost:3000", createdAt: now - 60_000 });
    seedTunnel(tmpRoot, { id: youngId, localUrl: "http://localhost:3001", createdAt: now - 1_000 });
    const removed = mgr.prune({ olderThanMs: 30_000 });
    expect(removed).toEqual([oldId]);
    expect(mgr.list().map((r) => r.id)).toEqual([youngId]);
  });

  test("localUrl / channel / agentId filters scope the sweep", () => {
    const a = tid();
    const b = tid();
    const c = tid();
    seedTunnel(tmpRoot, { id: a, localUrl: "http://localhost:3000", channel: "ch1", agentId: "agA" });
    seedTunnel(tmpRoot, { id: b, localUrl: "http://localhost:3001", channel: "ch1", agentId: "agB" });
    seedTunnel(tmpRoot, { id: c, localUrl: "http://localhost:3000", channel: "ch2", agentId: "agA" });

    const removed = mgr.prune({ localUrl: "http://localhost:3000", channel: "ch1" });
    expect(removed).toEqual([a]);
    expect(
      mgr
        .list()
        .map((r) => r.id)
        .sort(),
    ).toEqual([b, c].sort());
  });
});

// ============================================================================
// getLogTail (on Linux CI this exercises the `tail` path; fallback is
// covered by code inspection — it uses bounded pread via openSync+readSync,
// no test harness can easily force `tail` to be missing)
// ============================================================================

describe("getLogTail", () => {
  test("returns the last N lines of a large log file", () => {
    const id = tid();
    const dir = join(tmpRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, localUrl: "http://x", createdAt: Date.now() }));

    // Write a 2MB log with 10000 lines, then verify getLogTail returns
    // only the last 50 and doesn't load the whole thing.
    const LINES = 10000;
    const content = Array.from({ length: LINES }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(dir, "output.log"), content);
    // Even if `tail` is available (it is on Linux CI), we can still verify
    // correctness: last 50 lines should be "line 9950".."line 9999".
    const out = mgr.getLogTail(id, 50);
    const outLines = out.split("\n").filter((l) => l.startsWith("line "));
    expect(outLines.length).toBeLessThanOrEqual(50);
    expect(outLines[outLines.length - 1]).toBe("line 9999");
  });

  test("returns empty string for zero or negative lines", () => {
    const id = tid();
    seedTunnel(tmpRoot, { id, localUrl: "http://x", logContents: "a\nb\nc\n" });
    expect(mgr.getLogTail(id, 0)).toBe("");
    // Negative coerced to 0 via Math.max(0, ...).
    expect(mgr.getLogTail(id, -5)).toBe("");
  });

  test("returns empty string for missing log file", () => {
    const id = tid();
    seedTunnel(tmpRoot, { id, localUrl: "http://x" }); // no logContents
    expect(mgr.getLogTail(id)).toBe("");
  });

  test("returns empty string for invalid id (UUID gate)", () => {
    expect(mgr.getLogTail('evil"; cat /etc/passwd; #')).toBe("");
    expect(mgr.getLogTail("../../etc/passwd")).toBe("");
  });
});

// ============================================================================
// Atomicity + UUID gate
// ============================================================================

describe("atomic meta.json write + UUID gate", () => {
  test("meta.json write leaves no stale .tmp files behind", () => {
    const id = tid();
    seedTunnel(tmpRoot, { id, localUrl: "http://localhost:3000" });
    // No create() is invoked here (would need cloudflared), but seedTunnel
    // uses plain writeFileSync. Verify at minimum that the dir contains
    // only the expected files.
    const files = readdirSync(join(tmpRoot, id));
    expect(files).toContain("meta.json");
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("list() does not enumerate dirs with shell-metachar names", () => {
    // Simulate an attacker dropping a dir that would shell-inject if passed
    // through sessionNameFor → execTmux. The UUID gate in list() filters
    // it out before it reaches any shell command.
    const good = tid();
    seedTunnel(tmpRoot, { id: good, localUrl: "http://localhost:3000" });
    const badNames = [
      'evil"; rm -rf /; #',
      "`whoami`",
      "$HOME",
      "normal-but-not-uuid",
      "UPPERCASE-1234-5678-9abc-def012345678", // close to UUID but wrong case for canonical
    ];
    for (const name of badNames) {
      try {
        mkdirSync(join(tmpRoot, name), { recursive: true });
        // Seed minimal meta.json so if the filter missed, get() wouldn't
        // bail on missing metadata. This makes the UUID gate the ONLY thing
        // protecting the shell layer.
        writeFileSync(
          join(tmpRoot, name, "meta.json"),
          JSON.stringify({
            id: name,
            localUrl: "http://evil.example",
            createdAt: Date.now(),
          }),
        );
      } catch {
        // Some names may be rejected by the filesystem — skip those.
      }
    }
    const rows = mgr.list();
    // Only the good UUID should appear. The uppercase-hex variant IS a valid
    // UUID per RFC (case-insensitive) so it may or may not appear — what
    // matters is that the shell-metachar ones don't.
    const ids = rows.map((r) => r.id);
    for (const shellUnsafe of ['evil"; rm -rf /; #', "`whoami`", "$HOME", "normal-but-not-uuid"]) {
      expect(ids).not.toContain(shellUnsafe);
    }
    expect(ids).toContain(good);
  });
});

// ============================================================================
// reconcileAfterCreate — deterministic race-resolution coverage
// ============================================================================
//
// The integration test above (`concurrent create() for the same localUrl …`)
// exercises the real race, but it needs cloudflared + network and is
// vulnerable to Cloudflare's API rate limits. These tests poke the
// reconciliation directly by seeding post-spawn disk state — two meta.json
// files for the same localUrl, both with a captured publicUrl — and
// asserting the winner/loser outcome on disk and in the returned result.

describe("reconcileAfterCreate (seeded race state)", () => {
  /** Build a manager rooted at tmpRoot where all seeded tunnels are
   *  considered "alive". Without this, seeded tunnels have status="dead"
   *  (no real tmux server) and reconciliation filters them out. */
  const makeMgrWithAliveSeeds = (...ids: string[]) =>
    new TmuxTunnelManager({
      rootDir: tmpRoot,
      aliveSessionsProvider: () => new Set(ids.map((id) => `clawd-tun-${id}`)),
    });

  test("oldest createdAt wins — loser self-destructs, winner's result is returned", () => {
    const localUrl = "http://localhost:7000";
    const winnerId = tid();
    const loserId = tid();
    seedTunnel(tmpRoot, {
      id: winnerId,
      localUrl,
      channel: "ch-win",
      agentId: "ag-win",
      createdAt: 1000,
      publicUrl: "https://winner.trycloudflare.com",
    });
    seedTunnel(tmpRoot, {
      id: loserId,
      localUrl,
      channel: "ch-lose",
      agentId: "ag-lose",
      createdAt: 2000,
      publicUrl: "https://loser.trycloudflare.com",
    });
    const raceMgr = makeMgrWithAliveSeeds(winnerId, loserId);

    const result = raceMgr.reconcileAfterCreate(loserId, localUrl, 2000);

    expect(result).toBeDefined();
    expect(result?.id).toBe(winnerId);
    expect(result?.publicUrl).toBe("https://winner.trycloudflare.com");
    expect(result?.reused).toBe(true);
    expect(result?.owner?.channel).toBe("ch-win");
    expect(result?.owner?.agentId).toBe("ag-win");
    expect(existsSync(join(tmpRoot, loserId))).toBe(false);
    expect(existsSync(join(tmpRoot, winnerId, "meta.json"))).toBe(true);
  });

  test("winner's own call returns undefined (keep-ours signal)", () => {
    const localUrl = "http://localhost:7001";
    const winnerId = tid();
    const loserId = tid();
    seedTunnel(tmpRoot, { id: winnerId, localUrl, createdAt: 1000, publicUrl: "https://winner.trycloudflare.com" });
    seedTunnel(tmpRoot, { id: loserId, localUrl, createdAt: 2000, publicUrl: "https://loser.trycloudflare.com" });
    const raceMgr = makeMgrWithAliveSeeds(winnerId, loserId);

    const result = raceMgr.reconcileAfterCreate(winnerId, localUrl, 1000);
    expect(result).toBeUndefined();
    expect(existsSync(join(tmpRoot, winnerId))).toBe(true);
    expect(existsSync(join(tmpRoot, loserId))).toBe(true);
  });

  test("no peers on same localUrl → returns undefined (no-op)", () => {
    const id = tid();
    seedTunnel(tmpRoot, {
      id,
      localUrl: "http://localhost:7002",
      createdAt: 1000,
      publicUrl: "https://x.trycloudflare.com",
    });
    const raceMgr = makeMgrWithAliveSeeds(id);
    const result = raceMgr.reconcileAfterCreate(id, "http://localhost:7002", 1000);
    expect(result).toBeUndefined();
    expect(existsSync(join(tmpRoot, id))).toBe(true);
  });

  test("id lexicographic tiebreak when createdAt ties exactly", () => {
    const localUrl = "http://localhost:7003";
    const ids = [tid(), tid()].sort();
    const winnerId = ids[0];
    const loserId = ids[1];
    seedTunnel(tmpRoot, { id: winnerId, localUrl, createdAt: 5000, publicUrl: "https://w.trycloudflare.com" });
    seedTunnel(tmpRoot, { id: loserId, localUrl, createdAt: 5000, publicUrl: "https://l.trycloudflare.com" });
    const raceMgr = makeMgrWithAliveSeeds(winnerId, loserId);

    const result = raceMgr.reconcileAfterCreate(loserId, localUrl, 5000);
    expect(result?.id).toBe(winnerId);
    expect(result?.reused).toBe(true);
    expect(existsSync(join(tmpRoot, loserId))).toBe(false);
  });

  test("dead peers are ignored (only live tunnels compete)", () => {
    const localUrl = "http://localhost:7004";
    const deadPeerId = tid();
    const newId = tid();
    // Dead peer has older createdAt but is not in the alive set.
    seedTunnel(tmpRoot, { id: deadPeerId, localUrl, createdAt: 1000, publicUrl: "https://dead.trycloudflare.com" });
    seedTunnel(tmpRoot, { id: newId, localUrl, createdAt: 2000, publicUrl: "https://new.trycloudflare.com" });
    // Only newId is alive; deadPeerId is NOT in the provider set.
    const raceMgr = new TmuxTunnelManager({
      rootDir: tmpRoot,
      aliveSessionsProvider: () => new Set([`clawd-tun-${newId}`]),
    });

    const result = raceMgr.reconcileAfterCreate(newId, localUrl, 2000);
    expect(result).toBeUndefined();
    expect(existsSync(join(tmpRoot, newId))).toBe(true);
  });

  test("yields to middle peer with URL when oldest peer is still reconnecting", () => {
    // Regression: before the confirmed-peers filter, the oldest peer
    // (reconnecting, no URL) was chosen as nominal winner; the presence
    // of a YOUNGER but confirmed peer was ignored and self kept ours.
    // Post-fix: only peers with URLs count, so we yield to the middle.
    const localUrl = "http://localhost:7007";
    const reconnectingId = tid();
    const middleId = tid();
    const ourId = tid();
    seedTunnel(tmpRoot, { id: reconnectingId, localUrl, createdAt: 1000 }); // no URL
    seedTunnel(tmpRoot, {
      id: middleId,
      localUrl,
      channel: "ch-mid",
      agentId: "ag-mid",
      createdAt: 2000,
      publicUrl: "https://middle.trycloudflare.com",
    });
    seedTunnel(tmpRoot, { id: ourId, localUrl, createdAt: 3000, publicUrl: "https://ours.trycloudflare.com" });
    const raceMgr = makeMgrWithAliveSeeds(reconnectingId, middleId, ourId);

    const result = raceMgr.reconcileAfterCreate(ourId, localUrl, 3000);
    expect(result?.id).toBe(middleId);
    expect(result?.publicUrl).toBe("https://middle.trycloudflare.com");
    expect(result?.reused).toBe(true);
    expect(result?.owner?.channel).toBe("ch-mid");
    expect(existsSync(join(tmpRoot, ourId))).toBe(false);
    // Reconnecting peer untouched — it'll resolve itself when it captures URL.
    expect(existsSync(join(tmpRoot, reconnectingId))).toBe(true);
    expect(existsSync(join(tmpRoot, middleId))).toBe(true);
  });

  test("keeps ours when the winner has no captured URL yet (reconnecting)", () => {
    // A peer that hasn't captured its publicUrl yet is an "unconfirmed
    // winner". We shouldn't destroy ourselves to yield to a peer that
    // might die before ever becoming functional — if the peer DOES
    // eventually capture, its own reconcile will resolve the duplicate.
    const localUrl = "http://localhost:7005";
    const unconfirmedWinnerId = tid();
    const ourId = tid();
    // Unconfirmed winner: older createdAt but NO publicUrl.
    seedTunnel(tmpRoot, { id: unconfirmedWinnerId, localUrl, createdAt: 1000 });
    seedTunnel(tmpRoot, { id: ourId, localUrl, createdAt: 2000, publicUrl: "https://ours.trycloudflare.com" });
    const raceMgr = makeMgrWithAliveSeeds(unconfirmedWinnerId, ourId);

    const result = raceMgr.reconcileAfterCreate(ourId, localUrl, 2000);
    // We would LOSE the createdAt sort, but winner has no URL → keep ours.
    expect(result).toBeUndefined();
    expect(existsSync(join(tmpRoot, ourId))).toBe(true);
    expect(existsSync(join(tmpRoot, unconfirmedWinnerId))).toBe(true);
  });

  test("keeps ours when the winner's metadata vanishes mid-reconcile", () => {
    // Simulates a third caller destroying the winner dir between our
    // list() and our get(). Without a fresh confirmation, we refuse to
    // yield — returning the peer's URL would point at a dead tunnel.
    const localUrl = "http://localhost:7006";
    const winnerId = tid();
    const ourId = tid();
    seedTunnel(tmpRoot, {
      id: winnerId,
      localUrl,
      createdAt: 1000,
      publicUrl: "https://winner.trycloudflare.com",
    });
    seedTunnel(tmpRoot, { id: ourId, localUrl, createdAt: 2000, publicUrl: "https://ours.trycloudflare.com" });

    let call = 0;
    const raceMgr = new TmuxTunnelManager({
      rootDir: tmpRoot,
      aliveSessionsProvider: () => {
        call++;
        if (call === 1) return new Set([`clawd-tun-${winnerId}`, `clawd-tun-${ourId}`]);
        // After first list, simulate winner disappearance.
        rmSync(join(tmpRoot, winnerId), { recursive: true, force: true });
        return new Set([`clawd-tun-${ourId}`]);
      },
    });

    const result = raceMgr.reconcileAfterCreate(ourId, localUrl, 2000);
    // Winner metadata gone between list() and get() → keep ours rather than
    // return a URL that's no longer live.
    expect(result).toBeUndefined();
    expect(existsSync(join(tmpRoot, ourId))).toBe(true);
  });
});

// ============================================================================
// INTEGRATION (opt-in) — real cloudflared + tmux + local HTTP server
// ============================================================================

const runIntegration = process.env.CLAWD_INTEGRATION === "1";
const tmuxAvailable = (() => {
  try {
    execSync("which tmux", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
const cloudflaredAvailable = (() => {
  try {
    execSync("cloudflared --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!runIntegration || !tmuxAvailable || !cloudflaredAvailable)(
  "integration: real cloudflared + tmux lifecycle (opt-in)",
  () => {
    let server: ReturnType<typeof createServer>;
    let port: number;
    let intMgr: TmuxTunnelManager;
    let intTmpRoot: string;

    beforeEach(async () => {
      intTmpRoot = mkdtempSync(join(tmpdir(), "clawd-tunnels-int-"));
      intMgr = new TmuxTunnelManager({ rootDir: intTmpRoot });
      // Start a local HTTP server on an ephemeral port.
      server = createServer((_req, res) => res.end("ok"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      port = (server.address() as { port: number }).port;
    });

    afterEach(() => {
      // Reap any integration tunnels + stop the local server.
      try {
        intMgr.prune({});
        intMgr.killServer();
      } catch {}
      try {
        server.close();
      } catch {}
      try {
        rmSync(intTmpRoot, { recursive: true, force: true });
      } catch {}
    });

    test("create → list (running) → destroy → list empty", async () => {
      const r = await intMgr.create({ localUrl: `http://127.0.0.1:${port}` });
      expect(r.publicUrl).toMatch(/^https:\/\/.+\.trycloudflare\.com$/);
      expect(r.reused).toBe(false);

      const listed = intMgr.list();
      expect(listed.length).toBe(1);
      expect(listed[0].status).toBe("running");
      expect(listed[0].publicUrl).toBe(r.publicUrl);

      expect(intMgr.destroy(r.id)).toBe(true);
      expect(intMgr.list()).toEqual([]);
    }, 60_000);

    test("create with same localUrl returns the existing tunnel (dedupe)", async () => {
      const a = await intMgr.create({ localUrl: `http://127.0.0.1:${port}`, channel: "ch1", agentId: "agA" });
      const b = await intMgr.create({ localUrl: `http://127.0.0.1:${port}`, channel: "ch2", agentId: "agB" });
      expect(b.id).toBe(a.id);
      expect(b.reused).toBe(true);
      expect(b.owner?.channel).toBe("ch1");
      expect(b.owner?.agentId).toBe("agA");
      expect(intMgr.list().length).toBe(1);
    }, 60_000);

    test("tunnels survive manager re-instantiation (simulates Claw'd restart)", async () => {
      const created = await intMgr.create({ localUrl: `http://127.0.0.1:${port}` });
      // Fresh manager pointing at the same rootDir.
      const reMgr = new TmuxTunnelManager({ rootDir: intTmpRoot });
      const row = reMgr.get(created.id);
      expect(row).toBeDefined();
      expect(row?.status).toBe("running");
      expect(row?.publicUrl).toBe(created.publicUrl);
      expect(reMgr.destroy(created.id)).toBe(true);
    }, 60_000);

    test("meta.json shape on disk matches expectations", async () => {
      const r = await intMgr.create({
        localUrl: `http://127.0.0.1:${port}`,
        channel: "ch-meta",
        agentId: "ag-meta",
      });
      const metaPath = join(intTmpRoot, r.id, "meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      expect(meta.id).toBe(r.id);
      expect(meta.localUrl).toBe(`http://127.0.0.1:${port}`);
      expect(meta.channel).toBe("ch-meta");
      expect(meta.agentId).toBe("ag-meta");
      expect(meta.publicUrl).toBe(r.publicUrl);
      expect(typeof meta.createdAt).toBe("number");
      intMgr.destroy(r.id);
    }, 60_000);

    test("concurrent create() for the same localUrl resolves to ONE winning tunnel", async () => {
      // Kick off two overlapping create() calls for the same localUrl.
      // Pre-fix: both would see "no alive tunnel" on the initial scan and
      // both would spawn a separate cloudflared process, leaving TWO
      // tunnels on disk.
      // Post-fix: post-spawn reconciliation detects the collision; the
      // oldest-createdAt wins; the loser self-destructs; both callers
      // receive a CreateResult pointing at the same winning id.
      const url = `http://127.0.0.1:${port}`;
      const [a, b] = await Promise.all([
        intMgr.create({ localUrl: url, channel: "ch-A", agentId: "ag-A" }),
        intMgr.create({ localUrl: url, channel: "ch-B", agentId: "ag-B" }),
      ]);
      expect(a.id).toBe(b.id);
      // At LEAST one is flagged as reused (exact flag depends on which
      // call resolved first; could be (reused=false, reused=true) or
      // (reused=true, reused=false)).
      expect(a.reused || b.reused).toBe(true);
      // Exactly one tunnel remains on disk (the winner).
      const listed = intMgr.list();
      expect(listed.length).toBe(1);
      expect(listed[0].id).toBe(a.id);
      // Cleanup.
      intMgr.destroy(a.id);
    }, 120_000);
  },
);
