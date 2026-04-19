/**
 * tmux-based Cloudflare Quick Tunnel Manager — persistent background tunnels.
 *
 * Mirrors the TmuxJobManager pattern: each tunnel runs inside a dedicated
 * tmux session on a private socket (`~/.clawd/tunnels/tmux.sock`) so tunnels:
 *   1. Survive Claw'd server restart.
 *   2. Are isolated from the user's normal tmux sessions.
 *   3. Can be recovered after restart — `tunnel_list` enumerates the on-disk
 *      metadata + live tmux sessions and rebuilds the catalogue.
 *
 * Design decisions (confirmed with the user):
 *   - Ephemeral quick-tunnel URLs with re-capture on reconnect. Each tunnel
 *     spawns `cloudflared tunnel --url <local>` and writes stdout/stderr to
 *     `output.log`. We scan the log for the latest `https://…trycloudflare.com`
 *     match on demand.
 *   - Global pool with dedupe: `create(localUrl)` returns an existing running
 *     tunnel on the same localUrl instead of spinning a second cloudflared
 *     process. Saves resources; two agents wanting the same port share.
 *   - Cross-agent destroy allowed: any agent can call `destroy` on any
 *     tunnel (global-pool semantics).
 *   - No automatic cleanup — provide `prune()` instead so callers can sweep
 *     dead / old / scoped tunnels explicitly.
 *   - On-demand health: status is computed at query time from
 *     tmux-session-exists + log-URL-match, not a background sweep.
 *
 * Layout on disk:
 *   ~/.clawd/tunnels/
 *     tmux.sock
 *     <tunnel-id>/
 *       meta.json      — { id, localUrl, channel?, agentId?, createdAt, publicUrl? }
 *       output.log     — cloudflared stdout+stderr (tailed for URL capture)
 *       run.sh         — launcher script
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TUNNELS_ROOT = join(homedir(), ".clawd", "tunnels");
const TUNNEL_PREFIX = "clawd-tun-";
const URL_CAPTURE_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
const DEFAULT_CREATE_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Tunnel IDs are generated via `crypto.randomUUID()`. Enforce the exact
 *  RFC 4122 shape at every public API boundary that interpolates the id
 *  into a shell command (sessionExists / kill-session / tunnelDir). A
 *  malformed dir dropped into ~/.clawd/tunnels/ (or a tampered id passed
 *  to destroy/get) cannot reach the shell layer this way. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// Types
// ============================================================================

export type TunnelStatus = "running" | "reconnecting" | "dead";

export interface TunnelRecord {
  id: string;
  localUrl: string;
  publicUrl?: string;
  createdAt: number;
  channel?: string;
  agentId?: string;
  status: TunnelStatus;
  /** Seconds since createdAt — convenience for display. */
  uptimeSeconds: number;
}

interface TunnelMeta {
  id: string;
  localUrl: string;
  createdAt: number;
  channel?: string;
  agentId?: string;
  /** Captured at creation time; may become stale if cloudflared reconnects.
   *  Readers reconcile by scanning output.log for the LATEST URL match. */
  publicUrl?: string;
}

export interface PruneFilter {
  /** Prune only tunnels marked dead (tmux gone). */
  deadOnly?: boolean;
  /** Prune tunnels older than this many ms since createdAt. */
  olderThanMs?: number;
  /** Prune only tunnels with this localUrl. */
  localUrl?: string;
  /** Prune only tunnels owned by this channel. */
  channel?: string;
  /** Prune only tunnels owned by this agentId. */
  agentId?: string;
}

// ============================================================================
// Low-level helpers
// ============================================================================

function sessionNameFor(id: string): string {
  return `${TUNNEL_PREFIX}${id}`;
}

/** Atomic JSON write: write to a unique tmp file then rename. rename(2) is
 *  atomic on the same filesystem, so partial writes (SIGKILL / disk-full
 *  / anything short of the kernel crashing) cannot leave a reader observing
 *  a truncated meta.json. Mode is applied to the tmp file so the final
 *  visible inode has the requested permissions even if someone stats it
 *  between the write and the rename. */
function atomicWriteJson(path: string, value: unknown, mode = 0o600): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  renameSync(tmp, path);
}

// ============================================================================
// URL capture — scan output.log for the latest public URL
// ============================================================================

/** Scan the cloudflared log for trycloudflare URLs, return the LAST match.
 *  cloudflared may print multiple URLs if it reconnects; the latest wins.
 *  Exported for the test suite. */
export function scrapeLatestPublicUrl(logPath: string): string | undefined {
  if (!existsSync(logPath)) return undefined;
  // Bound memory via pread: only the last 64KB of the log is loaded, even
  // for multi-GB logs that accumulate over long-running tunnels.
  // URL lines appear near the top on normal startup AND re-appear on each
  // reconnect, so the tail is where the FRESHEST URL lives.
  const MAX_READ = 64 * 1024;
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_READ);
    const toRead = size - start;
    if (toRead === 0) return undefined;
    const buf = Buffer.alloc(toRead);
    readSync(fd, buf, 0, toRead, start);
    const matches = buf.toString("utf8").match(URL_CAPTURE_REGEX);
    return matches?.[matches.length - 1];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

// ============================================================================
// Manager
// ============================================================================

export interface CreateOptions {
  /** Local URL to expose (e.g. "http://localhost:3000"). */
  localUrl: string;
  /** Owner context — tracked in metadata for filtering / auditing. */
  channel?: string;
  agentId?: string;
  /** Timeout to wait for cloudflared to print the public URL. */
  timeoutMs?: number;
}

export interface CreateResult {
  id: string;
  publicUrl: string;
  localUrl: string;
  reused: boolean;
  /** Only set when reused=true; identifies the original creator. */
  owner?: { channel?: string; agentId?: string };
}

export interface TmuxTunnelManagerOptions {
  /** Override the tunnels root directory (tests use a tmp dir). Defaults to ~/.clawd/tunnels. */
  rootDir?: string;
  /** Override the tmux socket path. Defaults to <rootDir>/tmux.sock. */
  socketPath?: string;
  /** Test seam: supply a custom alive-session enumerator. When set, the
   *  manager uses this instead of shelling out to tmux list-sessions.
   *  Used by unit tests to simulate live tunnels without a real tmux
   *  server. Production code leaves this unset. */
  aliveSessionsProvider?: () => Set<string>;
}

export class TmuxTunnelManager {
  private readonly rootDir: string;
  private readonly socketPath: string;
  private readonly aliveSessionsProvider?: () => Set<string>;

  constructor(options: TmuxTunnelManagerOptions = {}) {
    this.rootDir = options.rootDir ?? DEFAULT_TUNNELS_ROOT;
    this.socketPath = options.socketPath ?? join(this.rootDir, "tmux.sock");
    this.aliveSessionsProvider = options.aliveSessionsProvider;
    // NOTE: no ensureRoot() here — the constructor is side-effect-free so
    // importing this module never creates directories on disk. ensureRoot()
    // runs lazily inside create() and list() which are the only methods
    // that need the directory to exist.
  }

  // --------------------------------------------------------------------------
  // Low-level per-instance helpers (isolated via rootDir + socketPath)
  // --------------------------------------------------------------------------

  private ensureRoot(): void {
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    }
  }

  private tunnelDir(id: string): string {
    return join(this.rootDir, id);
  }

  private tmuxCmd(args: string): string {
    return `tmux -S "${this.socketPath}" ${args}`;
  }

  private execTmux(args: string, timeoutMs = 5000): string {
    try {
      return execSync(this.tmuxCmd(args), {
        encoding: "utf8",
        timeout: timeoutMs,
        // Swallow tmux's own stderr — we care only about the success signal.
        // Without this, tests and ops logs get noisy "error connecting to /.../tmux.sock"
        // lines on every has-session check against a cold socket.
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  }

  private sessionExists(sessionName: string): boolean {
    if (this.aliveSessionsProvider) return this.aliveSessionsProvider().has(sessionName);
    return this.execTmux(`has-session -t "${sessionName}" && echo yes`) === "yes";
  }

  /** Enumerate all alive tmux sessions on our private socket in one call.
   *  Used by list() to avoid O(N) has-session invocations on large catalogs.
   *  Returns the set of session names (including non-tunnel sessions in
   *  case anything else shares the socket — not expected, but harmless). */
  private listAliveSessions(): Set<string> {
    if (this.aliveSessionsProvider) return this.aliveSessionsProvider();
    const out = this.execTmux(`list-sessions -F "#{session_name}"`);
    if (!out) return new Set();
    return new Set(out.split("\n").filter((s) => s.length > 0));
  }

  // --------------------------------------------------------------------------
  // Create (with dedupe)
  // --------------------------------------------------------------------------

  async create(opts: CreateOptions): Promise<CreateResult> {
    this.ensureRoot();
    const { localUrl, channel, agentId, timeoutMs = DEFAULT_CREATE_TIMEOUT_MS } = opts;

    // Shell-injection hardening: the URL is interpolated into a bash script
    // inside double quotes. Within double quotes, `"`, `$`, backtick, and `\`
    // retain their special meaning and can break out. Newlines end the line.
    // Valid HTTP URLs percent-encode these chars; reject raw occurrences.
    // (Word-splitting chars like `&`, `;`, `|`, `<`, `>` are LITERAL inside
    // double quotes so we don't need to reject them.)
    // This check runs BEFORE URL parsing so newline/quote inputs surface the
    // security-focused error message rather than a generic URL-parse error.
    if (/["`$\\\n\r]/.test(localUrl)) {
      throw new Error(
        `localUrl contains unsafe characters (one of " \` $ \\ \\n \\r). ` +
          `If these are legitimate, percent-encode them. Got: ${JSON.stringify(localUrl)}`,
      );
    }

    // Structural URL validation — reject malformed URLs outright.
    let parsed: URL;
    try {
      parsed = new URL(localUrl);
    } catch {
      throw new Error(`Invalid localUrl: ${localUrl}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`localUrl must use http:// or https:// (got ${parsed.protocol})`);
    }

    // Fast-path dedupe: if a tunnel for the SAME localUrl is already
    // running/reconnecting with a captured URL, return it immediately.
    // Dead tunnels are ignored — they're stale and will be reaped by the
    // caller (or by prune).
    //
    // Concurrent create() calls are handled by reconcileAfterCreate()
    // AFTER spawn+URL-capture. This fast-path is just an optimization so
    // common "already running" calls don't pay for a whole spawn cycle.
    const existing = this.findAliveByLocalUrl(localUrl);
    if (existing && existing.publicUrl) {
      return {
        id: existing.id,
        publicUrl: existing.publicUrl,
        localUrl: existing.localUrl,
        reused: true,
        owner:
          existing.channel || existing.agentId ? { channel: existing.channel, agentId: existing.agentId } : undefined,
      };
    }

    // Ensure cloudflared is installed before we bother creating dirs.
    try {
      execSync("cloudflared --version", { timeout: 5000, stdio: "pipe" });
    } catch {
      throw new Error(
        "cloudflared is not installed. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
      );
    }

    const id = randomUUID();
    const dir = this.tunnelDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const logFile = join(dir, "output.log");
    const metaFile = join(dir, "meta.json");
    const scriptFile = join(dir, "run.sh");

    const meta: TunnelMeta = { id, localUrl, createdAt: Date.now(), channel, agentId };
    atomicWriteJson(metaFile, meta);

    // Wrapper script: redirects cloudflared output to output.log, runs with
    // --no-autoupdate, and uses exec so the process group tracks correctly.
    // The script runs inside tmux so a session exit == process exit.
    const scriptContent = `#!/bin/bash
exec > "${logFile}" 2>&1
exec cloudflared tunnel --url "${localUrl}" --no-autoupdate
`;
    writeFileSync(scriptFile, scriptContent, { mode: 0o700 });

    const sessionName = sessionNameFor(id);
    try {
      execSync(this.tmuxCmd(`new-session -d -s "${sessionName}" "${scriptFile}"`), {
        encoding: "utf8",
        timeout: 5000,
      });
    } catch (err: unknown) {
      // Clean up on failure — recursive rm handles any stray files cloudflared
      // might have dropped, unlike the narrower unlinkSync+rmdirSync pair.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
      throw new Error(`Failed to start tunnel tmux session: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Poll the log until the URL appears or we time out.
    const start = Date.now();
    let publicUrl: string | undefined;
    while (Date.now() - start < timeoutMs) {
      publicUrl = scrapeLatestPublicUrl(logFile);
      if (publicUrl) break;
      if (!this.sessionExists(sessionName)) {
        // cloudflared died before printing the URL — bubble up the error.
        const tail = this.getLogTail(id, 50);
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
        throw new Error(`cloudflared exited before printing a public URL. Last log lines:\n${tail}`);
      }
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }

    if (!publicUrl) {
      // Timed out: kill the session and clean up.
      this.execTmux(`kill-session -t "${sessionName}"`);
      const tail = this.getLogTail(id, 50);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
      throw new Error(`Tunnel creation timed out after ${timeoutMs}ms. Last log lines:\n${tail}`);
    }

    // Persist captured URL so list/status can serve it quickly.
    meta.publicUrl = publicUrl;
    atomicWriteJson(metaFile, meta);

    // Post-spawn dedupe reconciliation. Closes the create() race.
    const reconciled = this.reconcileAfterCreate(id, localUrl, meta.createdAt);
    if (reconciled) return reconciled;

    return { id, publicUrl, localUrl, reused: false };
  }

  /**
   * Reconcile a just-created tunnel against any concurrent peer on the same
   * localUrl. Closes the create() race: two concurrent create() calls for
   * the same localUrl can both see "no alive tunnel" on their initial
   * dedupe scan and both spawn cloudflared. After spawn+URL-capture,
   * reconcileAfterCreate() re-scans; if another live tunnel exists for the
   * same localUrl, the oldest-createdAt wins (id tiebreak lexicographic).
   *
   * Returns:
   *   - CreateResult (reused=true) pointing at the winner if this caller
   *     LOST the race (this method destroys our own tunnel as a side effect)
   *   - undefined if we won OR no peers exist — caller should return its
   *     own freshly-created tunnel.
   *
   * Exposed (non-private) so unit tests can exercise it with seeded disk
   * state without spawning real cloudflared.
   */
  reconcileAfterCreate(id: string, localUrl: string, createdAt: number): CreateResult | undefined {
    // Only CONFIRMED peers (alive AND with a captured URL) can win the race.
    // A peer that's still reconnecting might die before becoming functional;
    // yielding to it would leave us with no working tunnel. Such a peer
    // will resolve its own duplication when its reconcile runs — at that
    // point WE are a confirmed peer from its perspective.
    //
    // Consequence: when the oldest peer has no URL but a middle peer does,
    // we correctly yield to the middle peer rather than give up because
    // the "nominal winner" is unconfirmed.
    const confirmedPeers = this.list({ localUrl }).filter((r) => r.id !== id && r.status !== "dead" && !!r.publicUrl);
    if (confirmedPeers.length === 0) return undefined;

    const competitors: Array<{ id: string; createdAt: number }> = [
      { id, createdAt },
      ...confirmedPeers.map((p) => ({ id: p.id, createdAt: p.createdAt })),
    ];
    competitors.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const winner = competitors[0];
    if (winner.id === id) return undefined; // we won, keep ours

    // Race-safe re-confirm: a concurrent destroy could have killed winner
    // between list() and now. Returning a URL we just lost would point
    // at a dead tunnel.
    //
    // Duplication fallback: if concurrent-reconcile races leave two
    // tunnels alive on the same localUrl, the user reaps them with
    // `tunnel_prune({ localUrl })`.
    const winnerRec = this.get(winner.id);
    if (!winnerRec || !winnerRec.publicUrl || winnerRec.status === "dead") {
      return undefined;
    }

    this.destroy(id);
    return {
      id: winnerRec.id,
      publicUrl: winnerRec.publicUrl,
      localUrl: winnerRec.localUrl,
      reused: true,
      owner:
        winnerRec.channel || winnerRec.agentId ? { channel: winnerRec.channel, agentId: winnerRec.agentId } : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Destroy
  // --------------------------------------------------------------------------

  /** Kill a tunnel's tmux session and remove its metadata dir.
   *  Returns true if the tunnel existed and was destroyed, false if unknown
   *  or the id is not a valid UUID (defensive: keeps shell-unsafe strings
   *  out of the tmux kill-session command and prevents `../etc` traversal). */
  destroy(id: string): boolean {
    if (!UUID_RE.test(id)) return false;
    const dir = this.tunnelDir(id);
    if (!existsSync(join(dir, "meta.json"))) return false;

    const sessionName = sessionNameFor(id);
    this.execTmux(`kill-session -t "${sessionName}"`);

    // Clean up the dir regardless of session state — metadata is owned by us.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort — leaving a partially-cleaned dir is not fatal.
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // Get / list
  // --------------------------------------------------------------------------

  get(id: string): TunnelRecord | undefined {
    return this._getInternal(id, undefined);
  }

  /** Internal get() that optionally accepts a pre-computed alive-sessions
   *  set. When provided, we skip the per-tunnel `has-session` shell call
   *  and just check membership — turns list() into a single tmux IPC
   *  instead of O(N). Callers outside this module should use the public
   *  get() which queries fresh. */
  private _getInternal(id: string, aliveSet: Set<string> | undefined): TunnelRecord | undefined {
    // Defensive: id must be a UUID (same reasoning as destroy()).
    if (!UUID_RE.test(id)) return undefined;
    const metaFile = join(this.tunnelDir(id), "meta.json");
    if (!existsSync(metaFile)) return undefined;

    let meta: TunnelMeta;
    try {
      meta = JSON.parse(readFileSync(metaFile, "utf8"));
    } catch {
      return undefined;
    }

    const sessionName = sessionNameFor(id);
    const logFile = join(this.tunnelDir(id), "output.log");

    // Prefer the freshest URL in the log (catches reconnect-new-URL case).
    // Fall back to whatever meta.json persisted.
    const liveUrl = scrapeLatestPublicUrl(logFile);
    const publicUrl = liveUrl ?? meta.publicUrl;

    const alive = aliveSet ? aliveSet.has(sessionName) : this.sessionExists(sessionName);
    const status: TunnelStatus = !alive ? "dead" : publicUrl ? "running" : "reconnecting";

    return {
      id: meta.id,
      localUrl: meta.localUrl,
      publicUrl,
      createdAt: meta.createdAt,
      channel: meta.channel,
      agentId: meta.agentId,
      status,
      uptimeSeconds: Math.max(0, Math.round((Date.now() - meta.createdAt) / 1000)),
    };
  }

  list(filter?: { channel?: string; agentId?: string; status?: TunnelStatus; localUrl?: string }): TunnelRecord[] {
    this.ensureRoot();
    const entries = existsSync(this.rootDir) ? readdirSync(this.rootDir) : [];
    // Single bulk tmux query for the whole list — replaces N has-session
    // shell calls with one list-sessions call. Meaningful on catalogs
    // larger than a few tunnels.
    const aliveSet = entries.length > 0 ? this.listAliveSessions() : new Set<string>();
    const out: TunnelRecord[] = [];
    for (const entry of entries) {
      // Skip the socket file, dotfiles, and anything that isn't a UUID-
      // shaped dir — prevents ad-hoc junk in the tunnels root from being
      // passed through to the tmux layer (which interpolates the entry
      // name into a shell command via sessionNameFor).
      if (!UUID_RE.test(entry)) continue;
      const rec = this._getInternal(entry, aliveSet);
      if (!rec) continue;
      if (filter?.channel && rec.channel !== filter.channel) continue;
      if (filter?.agentId && rec.agentId !== filter.agentId) continue;
      if (filter?.status && rec.status !== filter.status) continue;
      if (filter?.localUrl && rec.localUrl !== filter.localUrl) continue;
      out.push(rec);
    }
    // Newest-first is the most useful default for an ops tool.
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  /** Find a running-or-reconnecting tunnel for a given localUrl. Used for
   *  create-time dedupe. Ignores dead tunnels so callers can reap and retry. */
  findAliveByLocalUrl(localUrl: string): TunnelRecord | undefined {
    return this.list({ localUrl }).find((r) => r.status !== "dead");
  }

  // --------------------------------------------------------------------------
  // Prune
  // --------------------------------------------------------------------------

  /** Destroy tunnels matching the filter. Returns the list of destroyed ids. */
  prune(filter: PruneFilter = {}): string[] {
    const now = Date.now();
    const removed: string[] = [];
    for (const rec of this.list()) {
      if (filter.deadOnly && rec.status !== "dead") continue;
      if (filter.localUrl && rec.localUrl !== filter.localUrl) continue;
      if (filter.channel && rec.channel !== filter.channel) continue;
      if (filter.agentId && rec.agentId !== filter.agentId) continue;
      if (filter.olderThanMs !== undefined && now - rec.createdAt < filter.olderThanMs) continue;
      if (this.destroy(rec.id)) removed.push(rec.id);
    }
    return removed;
  }

  // --------------------------------------------------------------------------
  // Logs
  // --------------------------------------------------------------------------

  /** Return the last `lines` lines of the tunnel's log file. Returns "" for
   *  invalid ids (defensive — `tail -n <n> "<path>"` would otherwise shell-
   *  interpolate a user-supplied id into the path). `lines` is coerced to
   *  a non-negative integer to keep `tail -n <lines>` safe from non-number
   *  callers (TypeScript stops this at compile time, but a JS caller could
   *  bypass).
   *
   *  Fallback path (when `tail` is missing / disallowed) reads only the
   *  tail BYTES via pread rather than loading the whole file — bounded
   *  memory even for multi-GB logs. The heuristic cap of ~400 bytes per
   *  requested line comfortably covers cloudflared's output format; if
   *  it under-shoots for unusually long lines, the result is just fewer
   *  lines than requested, not a crash. */
  getLogTail(id: string, lines = 100): string {
    if (!UUID_RE.test(id)) return "";
    const safeLines = Math.max(0, Math.floor(Number(lines) || 0));
    const logPath = join(this.tunnelDir(id), "output.log");
    if (!existsSync(logPath)) return "";
    try {
      return execSync(`tail -n ${safeLines} "${logPath}"`, { encoding: "utf8" });
    } catch {
      return readTailLines(logPath, safeLines);
    }
  }

  // --------------------------------------------------------------------------
  // Shutdown helper (kills the manager's private tmux server)
  // --------------------------------------------------------------------------

  /** Stop the tmux server that owns all tunnels. Leaves metadata on disk so
   *  subsequent runs of Claw'd can still see the records (with status="dead"). */
  killServer(): boolean {
    try {
      this.execTmux("kill-server");
      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

export const tunnelManager = new TmuxTunnelManager();

// ============================================================================
// Private helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read approximately the last N lines of a file without loading the whole
 *  file into memory. Used as a fallback for `tail -n` when the tail binary
 *  is unavailable. The sizing heuristic (400 bytes/line) covers
 *  cloudflared's line lengths; unusually long lines return fewer lines,
 *  never more memory. */
function readTailLines(path: string, lines: number): string {
  if (lines <= 0) return "";
  const MAX_BYTES_PER_LINE = 400;
  const wantBytes = Math.min(lines * MAX_BYTES_PER_LINE, 1024 * 1024); // hard cap 1MB
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - wantBytes);
    const toRead = size - start;
    if (toRead === 0) return "";
    const buf = Buffer.alloc(toRead);
    readSync(fd, buf, 0, toRead, start);
    const text = buf.toString("utf8");
    return text.split("\n").slice(-lines).join("\n");
  } finally {
    closeSync(fd);
  }
}
