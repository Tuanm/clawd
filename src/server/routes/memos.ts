/**
 * Memos API Routes
 *
 * Read-only viewer for per-agent long-term memories.
 * Channel-scoped (does not include agent-wide channel=NULL memories).
 */

import { getAgentMemoryStore, type MemoryCategory } from "../../agent/memory/agent-memory";
import { json } from "../http-helpers";

const VALID_CATEGORIES: MemoryCategory[] = ["fact", "preference", "decision", "lesson", "correction"];

export function registerMemosRoutes(): (req: Request, url: URL, path: string) => Response | null {
  return (req, url, path) => {
    if (path !== "/api/app.memos.list" || req.method !== "GET") return null;

    const channel = url.searchParams.get("channel");
    const agentId = url.searchParams.get("agent_id");
    if (!channel) return json({ ok: false, error: "channel required" }, 400);
    if (!agentId) return json({ ok: false, error: "agent_id required" }, 400);

    const query = url.searchParams.get("query") || undefined;
    const categoryParam = url.searchParams.get("category");
    const category =
      categoryParam && VALID_CATEGORIES.includes(categoryParam as MemoryCategory)
        ? (categoryParam as MemoryCategory)
        : undefined;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 200);

    try {
      const store = getAgentMemoryStore();
      const results = store.recall({
        agentId,
        channel,
        query,
        category,
        limit,
        includeGlobal: false,
      });

      const memos = results.map((m) => ({
        id: m.id,
        category: m.category,
        content: m.content,
        priority: m.priority,
        pinned: m.priority >= 80,
        tags: m.tags,
        access_count: m.accessCount,
        last_accessed: m.lastAccessed,
        created_at: m.createdAt,
        updated_at: m.updatedAt,
      }));

      return json({ ok: true, memos });
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500);
    }
  };
}
