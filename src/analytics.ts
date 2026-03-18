/**
 * Copilot call analytics — fire-and-forget async writes, SQL-backed queries.
 *
 * Imported by:
 *   - src/agent/src/api/client.ts (writes)
 *   - src/index.ts (reads via exported query helpers)
 *
 * Uses the existing `db` instance from server/database so all analytics live
 * in the same chat.db file alongside messages, agents, etc.
 */

import { getModelMultiplier } from "./agent/src/api/key-pool";
import { db } from "./server/database";

// ============================================================================
// Types
// ============================================================================

export interface CopilotCallRecord {
  ts: number;
  keyFingerprint: string;
  model: string;
  initiator: "agent" | "user";
  status: "ok" | "429" | "403" | "error";
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  premiumRequests: number;
  agentId?: string;
  channel?: string;
  errorMsg?: string;
}

export interface CallsQueryOptions {
  limit?: number;
  offset?: number;
  from?: number; // epoch ms
  to?: number; // epoch ms
  model?: string;
  status?: string;
  channel?: string;
  agentId?: string;
  keyFingerprint?: string;
}

export interface SummaryRow {
  period: string;
  total_calls: number;
  ok_calls: number;
  error_calls: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_premium_requests: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
}

export interface KeyStatsRow {
  key_fingerprint: string;
  total_calls: number;
  ok_calls: number;
  error_calls: number;
  total_premium_requests: number;
  avg_latency_ms: number | null;
  last_used_ts: number;
}

export interface ModelStatsRow {
  model: string;
  total_calls: number;
  ok_calls: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_premium_requests: number;
  avg_latency_ms: number | null;
}

// ============================================================================
// Lazy prepared statement (avoids initialization order issues)
// ============================================================================

let _insert: ReturnType<typeof db.prepare> | null = null;

function insertStmt() {
  if (!_insert) {
    _insert = db.prepare(
      `INSERT INTO copilot_calls
         (ts, key_fingerprint, model, initiator, status, latency_ms,
          prompt_tokens, completion_tokens, premium_cost, agent_id, channel, error_msg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }
  return _insert;
}

// ============================================================================
// Write — fire-and-forget (never throws, never blocks the hot path)
// ============================================================================

export function trackCopilotCall(record: CopilotCallRecord): void {
  queueMicrotask(() => {
    try {
      insertStmt().run(
        record.ts,
        record.keyFingerprint,
        record.model,
        record.initiator,
        record.status,
        record.latencyMs ?? null,
        record.promptTokens ?? null,
        record.completionTokens ?? null,
        record.premiumRequests,
        record.agentId ?? null,
        record.channel ?? null,
        record.errorMsg ?? null,
      );
    } catch {
      // Never propagate — analytics must not disrupt the main request flow
    }
  });
}

/**
 * Convenience helper called from client.ts on success.
 * Computes premium cost via MODEL_MULTIPLIERS so client.ts doesn't need to.
 */
export function trackSuccess(opts: {
  keyFingerprint: string;
  model: string;
  initiator: "agent" | "user";
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  agentId?: string;
  channel?: string;
}): void {
  const cost = opts.initiator === "user" ? getModelMultiplier(opts.model) : 0;
  trackCopilotCall({
    ts: Date.now(),
    keyFingerprint: opts.keyFingerprint,
    model: opts.model,
    initiator: opts.initiator,
    status: "ok",
    latencyMs: opts.latencyMs,
    promptTokens: opts.promptTokens,
    completionTokens: opts.completionTokens,
    premiumRequests: cost,
    agentId: opts.agentId,
    channel: opts.channel,
  });
}

/**
 * Convenience helper called from client.ts on failure.
 */
export function trackFailure(opts: {
  keyFingerprint: string;
  model: string;
  initiator: "agent" | "user";
  status: "429" | "403" | "error";
  latencyMs: number;
  errorMsg?: string;
  agentId?: string;
  channel?: string;
}): void {
  trackCopilotCall({
    ts: Date.now(),
    keyFingerprint: opts.keyFingerprint,
    model: opts.model,
    initiator: opts.initiator,
    status: opts.status,
    latencyMs: opts.latencyMs,
    premiumRequests: 0,
    agentId: opts.agentId,
    channel: opts.channel,
    errorMsg: opts.errorMsg,
  });
}

// ============================================================================
// Read — synchronous SQLite queries (fast, used by API endpoints)
// ============================================================================

function buildWhere(opts: CallsQueryOptions): { sql: string; params: any[] } {
  const clauses: string[] = [];
  const params: any[] = [];

  if (opts.from != null) {
    clauses.push("ts >= ?");
    params.push(opts.from);
  }
  if (opts.to != null) {
    clauses.push("ts <= ?");
    params.push(opts.to);
  }
  if (opts.model) {
    clauses.push("model = ?");
    params.push(opts.model);
  }
  if (opts.status) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (opts.channel) {
    clauses.push("channel = ?");
    params.push(opts.channel);
  }
  if (opts.agentId) {
    clauses.push("agent_id = ?");
    params.push(opts.agentId);
  }
  if (opts.keyFingerprint) {
    clauses.push("key_fingerprint = ?");
    params.push(opts.keyFingerprint);
  }

  return {
    sql: clauses.length ? "WHERE " + clauses.join(" AND ") : "",
    params,
  };
}

/** Paginated raw call log */
export function queryCalls(opts: CallsQueryOptions = {}): unknown[] {
  const limit = Math.min(opts.limit ?? 100, 1000);
  const offset = opts.offset ?? 0;
  const { sql: where, params } = buildWhere(opts);
  return db
    .query(`SELECT * FROM copilot_calls ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown[];
}

/** Total count matching filters (for pagination) */
export function queryCallsCount(opts: CallsQueryOptions = {}): number {
  const { sql: where, params } = buildWhere(opts);
  const row = db.query(`SELECT COUNT(*) as n FROM copilot_calls ${where}`).get(...params) as { n: number };
  return row?.n ?? 0;
}

/**
 * Time-bucketed summary.
 * @param granularity "hour" | "day" | "week" (SQLite strftime format applied to ts/1000)
 */
export function querySummary(opts: CallsQueryOptions & { granularity?: "hour" | "day" | "week" }): SummaryRow[] {
  const { sql: where, params } = buildWhere(opts);
  const fmt = opts.granularity === "hour" ? "%Y-%m-%dT%H:00Z" : opts.granularity === "week" ? "%Y-W%W" : "%Y-%m-%d";

  // Fetch summary rows without P95 (correlated subquery nesting not supported in SQLite)
  const rows = db
    .query(`
    SELECT
      strftime('${fmt}', ts / 1000, 'unixepoch') AS period,
      COUNT(*)                                    AS total_calls,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_calls,
      SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS error_calls,
      COALESCE(SUM(prompt_tokens), 0)             AS total_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0)         AS total_completion_tokens,
      COALESCE(SUM(premium_cost), 0)              AS total_premium_requests,
      AVG(latency_ms)                             AS avg_latency_ms
    FROM copilot_calls
    ${where}
    GROUP BY period
    ORDER BY period DESC
  `)
    .all(...params) as Omit<SummaryRow, "p95_latency_ms">[];

  // Compute P95 per-period in TypeScript: fetch all latencies for the same window, group by period
  const latencies = db
    .query(`
    SELECT
      strftime('${fmt}', ts / 1000, 'unixepoch') AS period,
      latency_ms
    FROM copilot_calls
    WHERE latency_ms IS NOT NULL
    ${where ? where.replace(/^WHERE/, "AND") : ""}
    ORDER BY period, latency_ms
  `)
    .all(...params) as { period: string; latency_ms: number }[];

  const latByPeriod = new Map<string, number[]>();
  for (const r of latencies) {
    let arr = latByPeriod.get(r.period);
    if (!arr) {
      arr = [];
      latByPeriod.set(r.period, arr);
    }
    arr.push(r.latency_ms);
  }

  return rows.map((row) => {
    const lats = latByPeriod.get(row.period) ?? [];
    const p95 = lats.length > 0 ? (lats[Math.floor(lats.length * 0.95)] ?? null) : null;
    return { ...row, p95_latency_ms: p95 };
  });
}

/** Per-key breakdown */
export function queryKeyStats(opts: CallsQueryOptions = {}): KeyStatsRow[] {
  const { sql: where, params } = buildWhere(opts);
  return db
    .query(`
    SELECT
      key_fingerprint,
      COUNT(*)                                    AS total_calls,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_calls,
      SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS error_calls,
      COALESCE(SUM(premium_cost), 0)              AS total_premium_requests,
      AVG(latency_ms)                             AS avg_latency_ms,
      MAX(ts)                                     AS last_used_ts
    FROM copilot_calls
    ${where}
    GROUP BY key_fingerprint
    ORDER BY total_calls DESC
  `)
    .all(...params) as KeyStatsRow[];
}

/** Per-model breakdown */
export function queryModelStats(opts: CallsQueryOptions = {}): ModelStatsRow[] {
  const { sql: where, params } = buildWhere(opts);
  return db
    .query(`
    SELECT
      model,
      COUNT(*)                                    AS total_calls,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_calls,
      COALESCE(SUM(prompt_tokens), 0)             AS total_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0)         AS total_completion_tokens,
      COALESCE(SUM(premium_cost), 0)              AS total_premium_requests,
      AVG(latency_ms)                             AS avg_latency_ms
    FROM copilot_calls
    ${where}
    GROUP BY model
    ORDER BY total_calls DESC
  `)
    .all(...params) as ModelStatsRow[];
}

export interface KeyHistoryRow {
  key_fingerprint: string;
  period: string;
  total_calls: number;
  ok_calls: number;
  error_calls: number;
  total_premium_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
}

/** Per-key daily usage history (for long-term analysis) */
export function queryKeyHistory(
  opts: CallsQueryOptions & { granularity?: "hour" | "day" | "week" } = {},
): KeyHistoryRow[] {
  const { sql: where, params } = buildWhere(opts);
  const fmt = opts.granularity === "hour" ? "%Y-%m-%dT%H:00Z" : opts.granularity === "week" ? "%Y-W%W" : "%Y-%m-%d";
  return db
    .query(`
    SELECT
      key_fingerprint,
      strftime('${fmt}', ts / 1000, 'unixepoch') AS period,
      COUNT(*)                                    AS total_calls,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_calls,
      SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS error_calls,
      COALESCE(SUM(premium_cost), 0)              AS total_premium_requests,
      COALESCE(SUM(prompt_tokens), 0)             AS total_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0)         AS total_completion_tokens
    FROM copilot_calls
    ${where}
    GROUP BY key_fingerprint, period
    ORDER BY period DESC, key_fingerprint
  `)
    .all(...params) as KeyHistoryRow[];
}

/** Current "live" snapshot: last N minutes rolling window */
export function queryRecentStats(windowMinutes = 60): {
  calls: number;
  errors: number;
  premiumRequests: number;
  avgLatencyMs: number | null;
} {
  const since = Date.now() - windowMinutes * 60_000;
  const row = db
    .query(`
    SELECT
      COUNT(*)                                        AS calls,
      SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
      COALESCE(SUM(premium_cost), 0)                  AS premiumRequests,
      AVG(latency_ms)                                 AS avgLatencyMs
    FROM copilot_calls
    WHERE ts >= ?
  `)
    .get(since) as { calls: number; errors: number; premiumRequests: number; avgLatencyMs: number | null };
  return row ?? { calls: 0, errors: 0, premiumRequests: 0, avgLatencyMs: null };
}
