/**
 * Copilot analytics route handlers.
 *
 * Handles all /api/analytics/copilot/* endpoints.
 */

import { keyPool } from "../../agent/api/key-pool";
import {
  type CallsQueryOptions,
  queryCalls,
  queryCallsCount,
  queryKeyHistory,
  queryKeyStats,
  queryModelStats,
  queryRecentStats,
  querySummary,
} from "../../analytics";
import { json, numParam } from "../http-helpers";

export function handleAnalyticsRoutes(req: Request, url: URL, path: string): Response | null {
  // GET /api/analytics/copilot/calls
  //   ?limit=100&offset=0&from=<ms>&to=<ms>&model=X&status=ok|429|403|error
  //   &channel=X&agentId=X&keyFingerprint=X
  if (path === "/api/analytics/copilot/calls" && req.method === "GET") {
    const opts: CallsQueryOptions = {
      limit: numParam(url, "limit"),
      offset: numParam(url, "offset"),
      from: numParam(url, "from"),
      to: numParam(url, "to"),
      model: url.searchParams.get("model") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      channel: url.searchParams.get("channel") ?? undefined,
      agentId: url.searchParams.get("agentId") ?? undefined,
      keyFingerprint: url.searchParams.get("keyFingerprint") ?? undefined,
    };
    const calls = queryCalls(opts);
    const total = queryCallsCount(opts);
    return json({ ok: true, total, calls });
  }

  // GET /api/analytics/copilot/summary?granularity=day|hour|week&from=<ms>&to=<ms>&...
  if (path === "/api/analytics/copilot/summary" && req.method === "GET") {
    const granularity = (url.searchParams.get("granularity") ?? "day") as "day" | "hour" | "week";
    const opts: CallsQueryOptions & {
      granularity?: "day" | "hour" | "week";
    } = {
      from: numParam(url, "from"),
      to: numParam(url, "to"),
      model: url.searchParams.get("model") ?? undefined,
      channel: url.searchParams.get("channel") ?? undefined,
      agentId: url.searchParams.get("agentId") ?? undefined,
      granularity,
    };
    return json({ ok: true, summary: querySummary(opts) });
  }

  // GET /api/analytics/copilot/keys?from=<ms>&to=<ms>
  if (path === "/api/analytics/copilot/keys" && req.method === "GET") {
    const opts: CallsQueryOptions = {
      from: numParam(url, "from"),
      to: numParam(url, "to"),
    };
    const stats = queryKeyStats(opts);
    // Enrich with live KeyPool data (premium remaining from GitHub API)
    const liveStatus = keyPool.getStatus();
    const enriched = stats.map((s) => {
      const live = liveStatus.find((l) => s.key_fingerprint === l.fingerprint);
      return {
        ...s,
        premium_remaining: live?.premiumRemainingFromApi ?? null,
        premium_used_cycle: live?.premiumUsedCycle ?? null,
        user_initiator_sent_today: live?.userInitiatorSentToday ?? null,
      };
    });
    return json({ ok: true, keys: enriched });
  }

  // GET /api/analytics/copilot/keys/history?granularity=day|hour|week&from=<ms>&to=<ms>&keyFingerprint=X
  if (path === "/api/analytics/copilot/keys/history" && req.method === "GET") {
    const granularity = (url.searchParams.get("granularity") ?? "day") as "day" | "hour" | "week";
    const opts = {
      from: numParam(url, "from"),
      to: numParam(url, "to"),
      keyFingerprint: url.searchParams.get("keyFingerprint") ?? undefined,
      granularity,
    };
    return json({ ok: true, history: queryKeyHistory(opts) });
  }

  // GET /api/analytics/copilot/models?from=<ms>&to=<ms>&channel=X
  if (path === "/api/analytics/copilot/models" && req.method === "GET") {
    const opts: CallsQueryOptions = {
      from: numParam(url, "from"),
      to: numParam(url, "to"),
      channel: url.searchParams.get("channel") ?? undefined,
    };
    return json({ ok: true, models: queryModelStats(opts) });
  }

  // GET /api/analytics/copilot/recent?window=60  (last N minutes rolling window)
  if (path === "/api/analytics/copilot/recent" && req.method === "GET") {
    const window = numParam(url, "window") ?? 60;
    return json({
      ok: true,
      windowMinutes: window,
      ...queryRecentStats(window),
    });
  }

  return null;
}
