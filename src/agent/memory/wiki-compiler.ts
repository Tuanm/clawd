/**
 * WikiCompiler — compiles flat agent_memories into dense wiki articles.
 *
 * Algorithm: keyword co-occurrence graph → greedy union-find clustering →
 * batched LLM prompts → UPSERT into agent_wiki.
 */

import type Database from "bun:sqlite";
import type { AgentMemoryStore, AgentMemory } from "./agent-memory";

// ── Types ──────────────────────────────────────────────────────────

export interface WikiArticle {
  id: number;
  agentId: string;
  channel: string;
  topic: string;
  summary: string;
  content: string;
  memoryIds: number[];
  sourceCount: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastCompiledAt: number;
}

export interface WikiTOCEntry {
  topic: string;
  summary: string;
  updatedAt: number;
}

export interface CompilationResult {
  created: number;
  updated: number;
  errors: number;
  durationMs: number;
}

export interface PendingNote {
  id: number;
  agentId: string;
  channel: string;
  topicHint: string | null;
  content: string;
  priority: number;
  createdAt: number;
}

interface ClusterInput {
  clusterIdx: number;
  category: string;
  memories: Array<{ id: number; content: string; category: string }>;
}

interface ParsedArticle {
  clusterIdx: number;
  topic: string;
  summary: string;
  content: string;
}

interface LLMClient {
  model: string;
  complete(opts: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
  }): Promise<{ choices?: Array<{ message?: { content?: string } }> }>;
}

// ── Constants ──────────────────────────────────────────────────────

const CLUSTER_EDGE_THRESHOLD = 2;
const MAX_CLUSTER_SIZE = 30;
const MAX_ARTICLE_CHARS = 4000;
const MIN_ARTICLE_CHARS = 100;
const MAX_SUMMARY_CHARS = 120;
const MAX_CLUSTERS_PER_LLM_CALL = 5;
const MIN_CLUSTER_SIZE = 2;

// ── WikiCompiler ───────────────────────────────────────────────────

export class WikiCompiler {
  private initialized = false;

  constructor(private db: Database) {}

  // ── Init guard ─────────────────────────────────────────────────

  private ensureInit(): boolean {
    if (this.initialized) return true;
    try {
      const exists = this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_wiki'").get();
      this.initialized = !!exists;
    } catch {
      this.initialized = false;
    }
    return this.initialized;
  }

  // ── Public: getLastCompilationTs ───────────────────────────────

  getLastCompilationTs(agentId: string, channel: string): number {
    if (!this.ensureInit()) return 0;
    try {
      const row = this.db
        .query(
          `SELECT MAX(last_compiled_at) as ts FROM agent_wiki
           WHERE agent_id = ? AND channel = ?`,
        )
        .get(agentId, channel) as { ts: number | null } | null;
      return row?.ts ?? 0;
    } catch {
      return 0;
    }
  }

  // ── Public: getArticleCount ────────────────────────────────────

  getArticleCount(agentId: string, channel: string): number {
    if (!this.ensureInit()) return 0;
    const row = this.db
      .query("SELECT COUNT(*) as count FROM agent_wiki WHERE agent_id = ? AND channel = ?")
      .get(agentId, channel) as { count: number } | null;
    return row?.count ?? 0;
  }

  // ── Public: getTOC ─────────────────────────────────────────────

  getTOC(agentId: string, channel: string): WikiTOCEntry[] {
    if (!this.ensureInit()) return [];
    try {
      const rows = this.db
        .query(
          `SELECT topic, summary, updated_at FROM agent_wiki
           WHERE agent_id = ? AND channel = ?
           ORDER BY updated_at DESC
           LIMIT 20`,
        )
        .all(agentId, channel) as Array<{ topic: string; summary: string; updated_at: number }>;
      return rows.map((r) => ({ topic: r.topic, summary: r.summary, updatedAt: r.updated_at }));
    } catch {
      return [];
    }
  }

  // ── Public: search ─────────────────────────────────────────────

  search(agentId: string, channel: string, query: string, limit = 3): WikiArticle[] {
    if (!this.ensureInit()) return [];
    if (!query.trim()) return [];

    try {
      const sanitized = sanitizeFTSQuery(query);
      if (!sanitized) return [];

      const rows = this.db
        .query(
          `SELECT aw.*, fts.rank
           FROM agent_wiki aw
           JOIN agent_wiki_fts fts ON aw.id = fts.rowid
           WHERE fts.agent_wiki_fts MATCH ?
             AND aw.agent_id = ? AND aw.channel = ?
           ORDER BY fts.rank
           LIMIT ?`,
        )
        .all(sanitized, agentId, channel, limit) as any[];

      return rows.map(rowToArticle);
    } catch {
      // FTS5 failed — fallback to LIKE scan
      return this.searchFallback(agentId, channel, query, limit);
    }
  }

  private searchFallback(agentId: string, channel: string, query: string, limit: number): WikiArticle[] {
    try {
      const escaped = query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const pattern = `%${escaped}%`;
      const rows = this.db
        .query(
          `SELECT * FROM agent_wiki
           WHERE agent_id = ? AND channel = ?
             AND (lower(topic) LIKE ? ESCAPE '\\' OR lower(content) LIKE ? ESCAPE '\\')
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(agentId, channel, pattern, pattern, limit) as any[];
      return rows.map(rowToArticle);
    } catch {
      return [];
    }
  }

  // ── Public: getArticles by topic ───────────────────────────────

  getArticles(agentId: string, channel: string, topics: string[]): WikiArticle[] {
    if (!this.ensureInit() || topics.length === 0) return [];
    try {
      const placeholders = topics.map(() => "?").join(",");
      const rows = this.db
        .query(
          `SELECT * FROM agent_wiki
           WHERE agent_id = ? AND channel = ?
             AND lower(topic) IN (${placeholders})
           ORDER BY updated_at DESC`,
        )
        .all(agentId, channel, ...topics.map((t) => t.toLowerCase())) as any[];
      return rows.map(rowToArticle);
    } catch {
      return [];
    }
  }

  // ── Public: stagePendingNote ───────────────────────────────────

  stagePendingNote(agentId: string, channel: string, content: string, topicHint?: string | null): boolean {
    if (!this.ensureInit()) return false;
    try {
      this.db.run(
        `INSERT INTO wiki_pending_notes (agent_id, channel, topic_hint, content)
         VALUES (?, ?, ?, ?)`,
        [agentId, channel, topicHint ?? null, content],
      );
      return true;
    } catch (err) {
      console.warn("[Wiki] Failed to stage pending note:", err);
      return false;
    }
  }

  // ── Public: absorbPendingNotes ─────────────────────────────────

  absorbPendingNotes(agentId: string, channel: string, store: AgentMemoryStore): number[] {
    if (!this.ensureInit()) return [];
    try {
      const notes = this.db
        .query(
          `SELECT * FROM wiki_pending_notes
           WHERE agent_id = ? AND channel = ?
           ORDER BY created_at ASC`,
        )
        .all(agentId, channel) as Array<{
        id: number;
        topic_hint: string | null;
        content: string;
        priority: number;
      }>;

      if (notes.length === 0) return [];

      const succeededNoteIds: number[] = [];
      const newMemoryIds: number[] = [];

      this.db.transaction(() => {
        for (const note of notes) {
          const result = store.save({
            agentId,
            channel,
            content: note.content,
            source: "auto",
            priority: note.priority,
          });
          // Only track notes that were successfully saved (id !== null)
          if (result.id !== null) {
            succeededNoteIds.push(note.id);
            newMemoryIds.push(result.id as number);
          }
        }
        // Delete only the notes that were successfully absorbed
        if (succeededNoteIds.length > 0) {
          const placeholders = succeededNoteIds.map(() => "?").join(",");
          this.db.run(`DELETE FROM wiki_pending_notes WHERE id IN (${placeholders})`, succeededNoteIds);
        }
      })();

      return newMemoryIds;
    } catch (err) {
      console.warn("[Wiki] Failed to absorb pending notes:", err);
      return [];
    }
  }

  // ── Public: compile (full) ─────────────────────────────────────

  async compile(
    agentId: string,
    channel: string,
    llmClient: LLMClient,
    model: string,
    store: AgentMemoryStore,
  ): Promise<CompilationResult> {
    const start = Date.now();
    const result: CompilationResult = { created: 0, updated: 0, errors: 0, durationMs: 0 };
    if (!this.ensureInit()) return result;

    // 0. Absorb pending notes
    this.absorbPendingNotes(agentId, channel, store);

    // 1. Fetch all non-pinned memories for this channel
    const memories = store.getAllForCompilation(agentId, channel);
    if (memories.length === 0) {
      result.durationMs = Date.now() - start;
      return result;
    }

    // 2. Get existing topics for stability anchoring
    const existingTopics = this.getTOC(agentId, channel).map((t) => t.topic);

    // 3. Cluster memories
    const clusters = clusterMemories(memories);
    if (clusters.length === 0) {
      result.durationMs = Date.now() - start;
      return result;
    }

    // 4. Batch compile clusters
    await this.compileClusters(clusters, existingTopics, agentId, channel, llmClient, model, result);

    // 5. Delete orphaned articles (articles with no remaining memory refs)
    this.deleteOrphanedArticles(agentId, channel);

    result.durationMs = Date.now() - start;
    return result;
  }

  // ── Public: compileIncremental ─────────────────────────────────

  async compileIncremental(
    agentId: string,
    channel: string,
    llmClient: LLMClient,
    model: string,
    store: AgentMemoryStore,
  ): Promise<CompilationResult> {
    const start = Date.now();
    const result: CompilationResult = { created: 0, updated: 0, errors: 0, durationMs: 0 };
    if (!this.ensureInit()) return result;

    // Absorb pending notes first — capture new memory IDs for incremental compilation
    const absorbedMemoryIds = this.absorbPendingNotes(agentId, channel, store);

    // Find stale articles (source memory updated after last_compiled_at)
    const staleRows = this.db
      .query(
        `SELECT DISTINCT w.id, w.topic
         FROM agent_wiki w
         JOIN wiki_memory_refs r ON r.wiki_id = w.id
         JOIN agent_memories m ON m.id = r.memory_id
         WHERE w.agent_id = ? AND w.channel = ?
           AND m.updated_at > w.last_compiled_at`,
      )
      .all(agentId, channel) as Array<{ id: number; topic: string }>;

    // Also include articles marked with last_compiled_at = 0 (dirty sentinel)
    const queuedRows = this.db
      .query(
        `SELECT id, topic FROM agent_wiki
         WHERE agent_id = ? AND channel = ? AND last_compiled_at = 0`,
      )
      .all(agentId, channel) as Array<{ id: number; topic: string }>;

    const toRecompile = [...new Map([...staleRows, ...queuedRows].map((a) => [a.id, a])).values()];

    if (toRecompile.length === 0 && absorbedMemoryIds.length === 0) {
      result.durationMs = Date.now() - start;
      return result;
    }

    // Re-cluster all memories (to pick up neighboring changes)
    const memories = store.getAllForCompilation(agentId, channel);
    if (memories.length === 0) {
      result.durationMs = Date.now() - start;
      return result;
    }

    const existingTopics = this.getTOC(agentId, channel).map((t) => t.topic);
    const allClusters = clusterMemories(memories);

    // Build set of memory IDs belonging to stale wiki articles
    const staleWikiIds = toRecompile.map((a) => a.id);
    let staleMemoryIds = new Set<number>();
    if (staleWikiIds.length > 0) {
      const ph = staleWikiIds.map(() => "?").join(",");
      const refs = this.db
        .query(`SELECT memory_id FROM wiki_memory_refs WHERE wiki_id IN (${ph})`)
        .all(...staleWikiIds) as Array<{ memory_id: number }>;
      staleMemoryIds = new Set(refs.map((r) => r.memory_id));
    }
    // Add newly absorbed note memory IDs so they get included in incremental compilation
    for (const id of absorbedMemoryIds) {
      staleMemoryIds.add(id);
    }

    // Compile clusters that contain any stale-article source memory (or all clusters if no existing articles)
    const clustersToCompile =
      existingTopics.length === 0
        ? allClusters
        : allClusters.filter((c) => c.memories.some((m) => staleMemoryIds.has(m.id)));

    await this.compileClusters(clustersToCompile, existingTopics, agentId, channel, llmClient, model, result);

    // Delete orphaned articles after incremental compilation
    this.deleteOrphanedArticles(agentId, channel);

    result.durationMs = Date.now() - start;
    return result;
  }

  // ── Private: compileClusters ───────────────────────────────────

  private async compileClusters(
    clusters: MemoryCluster[],
    existingTopics: string[],
    agentId: string,
    channel: string,
    llmClient: LLMClient,
    model: string,
    result: CompilationResult,
  ): Promise<void> {
    // Batch into groups of MAX_CLUSTERS_PER_LLM_CALL
    for (let i = 0; i < clusters.length; i += MAX_CLUSTERS_PER_LLM_CALL) {
      const batch = clusters.slice(i, i + MAX_CLUSTERS_PER_LLM_CALL);

      // Use LOCAL indices (0..batch.length-1) so the LLM echoes back simple 0-based indices
      // and we can do direct batch[item.clusterIdx] lookup — no global offset arithmetic needed.
      const clusterInputs: ClusterInput[] = batch.map((c, idx) => ({
        clusterIdx: idx,
        category: c.dominantCategory,
        memories: c.memories.map((m) => ({
          id: m.id,
          content: m.content,
          category: m.category,
        })),
      }));

      try {
        const prompt = buildCompilePrompt(clusterInputs, existingTopics);
        const llmResult = await llmClient.complete({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 4000,
          temperature: 0,
        });

        const responseText = llmResult?.choices?.[0]?.message?.content || "";
        const parsed = parseBatchResponse(responseText);

        for (const item of parsed) {
          if (!item.topic?.trim() || !item.content?.trim()) continue;
          if (item.content.length < MIN_ARTICLE_CHARS) {
            console.warn(`[Wiki] Article too short for topic "${item.topic}", skipping`);
            continue;
          }

          // Direct lookup using local clusterIdx — no subtraction needed
          const cluster = batch[item.clusterIdx];
          if (!cluster) continue;

          const memoryIds = cluster.memories.map((m) => m.id);
          try {
            const upsertResult = this.upsertArticle(agentId, channel, item, memoryIds);
            if (upsertResult === null) {
              result.errors++;
            } else if (upsertResult === true) {
              result.created++;
            } else {
              result.updated++;
            }
          } catch (err) {
            result.errors++;
            console.warn(`[Wiki] upsertArticle failed for "${item.topic}":`, err);
          }
        }
      } catch (err) {
        result.errors++;
        console.warn(`[Wiki] Batch compile error (batch ${i}–${i + batch.length - 1}):`, err);
      }
    }

    // Note: FTS is maintained incrementally by aw_ai/aw_au/aw_ad triggers — no full rebuild needed.
  }

  // ── Private: upsertArticle ─────────────────────────────────────

  private upsertArticle(
    agentId: string,
    channel: string,
    item: ParsedArticle,
    memoryIds: number[],
  ): boolean | null /* true=new, false=updated, null=error */ {
    const now = Math.floor(Date.now() / 1000);
    const topicKey = item.topic.trim().toLowerCase();
    const content = item.content.slice(0, MAX_ARTICLE_CHARS);
    const summary = item.summary.slice(0, MAX_SUMMARY_CHARS);

    // Wrap all 4 steps in a transaction (Fix 3)
    const txn = this.db.transaction((): boolean => {
      const existing = this.db
        .query(
          `SELECT id, version FROM agent_wiki
           WHERE agent_id = ? AND channel = ? AND lower(topic) = ?`,
        )
        .get(agentId, channel, topicKey) as { id: number; version: number } | null;

      let wikiId: number;
      let isNew = false;

      if (existing) {
        this.db.run(
          `UPDATE agent_wiki SET
             topic            = lower(?),
             summary          = ?,
             content          = ?,
             version          = version + 1,
             updated_at       = ?,
             last_compiled_at = ?
           WHERE id = ?`,
          [item.topic.trim(), summary, content, now, now, existing.id],
        );
        wikiId = existing.id;
        // Replace all refs for this article
        this.db.run(`DELETE FROM wiki_memory_refs WHERE wiki_id = ?`, [wikiId]);
      } else {
        const r = this.db.run(
          `INSERT INTO agent_wiki (agent_id, channel, topic, summary, content, updated_at, last_compiled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [agentId, channel, item.topic.trim(), summary, content, now, now],
        );
        wikiId = Number(r.lastInsertRowid);
        isNew = true;
      }

      // Insert memory refs
      const stmt = this.db.prepare(`INSERT OR IGNORE INTO wiki_memory_refs (wiki_id, memory_id) VALUES (?, ?)`);
      for (const mid of memoryIds) {
        stmt.run(wikiId, mid);
      }

      // Refresh fast-read JSON cache
      this.refreshMemoryIdsCache(wikiId);

      return isNew;
    });

    try {
      return txn();
    } catch (err) {
      // Fix 4: rethrow so compileClusters catch block counts this as an error
      console.warn(`[Wiki] upsertArticle failed for topic "${item.topic}":`, err);
      return null;
    }
  }

  // ── Public: refreshMemoryIdsCache (called externally for dirty-marking) ──

  refreshMemoryIdsCache(wikiId: number): void {
    try {
      this.db.run(
        `UPDATE agent_wiki
         SET
           memory_ids   = (SELECT COALESCE(json_group_array(memory_id), '[]') FROM wiki_memory_refs WHERE wiki_id = ?),
           source_count = (SELECT COUNT(*) FROM wiki_memory_refs WHERE wiki_id = ?)
         WHERE id = ?`,
        [wikiId, wikiId, wikiId],
      );
    } catch (err) {
      console.warn("[Wiki] refreshMemoryIdsCache failed:", err);
    }
  }

  // ── Private: deleteOrphanedArticles ───────────────────────────

  private deleteOrphanedArticles(agentId: string, channel: string): void {
    try {
      // Single-query DELETE: any article with no remaining wiki_memory_refs is orphaned
      this.db.run(
        `DELETE FROM agent_wiki
         WHERE agent_id = ? AND channel = ?
           AND id NOT IN (SELECT DISTINCT wiki_id FROM wiki_memory_refs)`,
        [agentId, channel],
      );
    } catch (err) {
      console.warn("[Wiki] deleteOrphanedArticles failed:", err);
    }
  }

  // ── Private: rebuildFTS ────────────────────────────────────────

  private rebuildFTS(): void {
    try {
      this.db.exec(`INSERT INTO agent_wiki_fts(agent_wiki_fts) VALUES('rebuild')`);
    } catch (err) {
      console.warn("[Wiki] FTS5 rebuild failed:", err);
    }
  }
}

// ── Clustering ────────────────────────────────────────────────────

interface MemoryCluster {
  memories: AgentMemory[];
  dominantCategory: string;
  assignedTopic?: string;
}

/**
 * Keyword co-occurrence graph → greedy union-find clustering (O(n log n), no LLM).
 */
function clusterMemories(memories: AgentMemory[]): MemoryCluster[] {
  if (memories.length === 0) return [];

  // Extract keyword sets per memory
  const keywordSets: string[][] = memories.map((m) => extractKeywordsLocal(m.content));

  // Build adjacency weights: edge[i][j] = shared keyword count
  const n = memories.length;
  const edges: Array<{ i: number; j: number; weight: number }> = [];

  for (let i = 0; i < n; i++) {
    const ki = new Set(keywordSets[i]);
    for (let j = i + 1; j < n; j++) {
      const kj = new Set(keywordSets[j]);
      const shared = [...ki].filter((k) => kj.has(k)).length;
      if (shared >= CLUSTER_EDGE_THRESHOLD) {
        edges.push({ i, j, weight: shared });
      }
    }
  }

  // Sort edges by weight descending
  edges.sort((a, b) => b.weight - a.weight);

  // Union-Find
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array(n).fill(0);
  const clusterSize = new Array(n).fill(1);

  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }

  function union(x: number, y: number): boolean {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return false;
    if (clusterSize[rx] + clusterSize[ry] > MAX_CLUSTER_SIZE) return false;
    if (rank[rx] < rank[ry]) {
      parent[rx] = ry;
      clusterSize[ry] += clusterSize[rx];
    } else if (rank[rx] > rank[ry]) {
      parent[ry] = rx;
      clusterSize[rx] += clusterSize[ry];
    } else {
      parent[ry] = rx;
      clusterSize[rx] += clusterSize[ry];
      rank[rx]++;
    }
    return true;
  }

  for (const edge of edges) {
    union(edge.i, edge.j);
  }

  // Group memories by cluster root
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const clusters: MemoryCluster[] = [];

  // Bin singletons into misc_<category> groups
  const miscGroups = new Map<string, number[]>();

  for (const [, indices] of groups) {
    if (indices.length < MIN_CLUSTER_SIZE) {
      // Singleton — bin by category
      const m = memories[indices[0]];
      const key = `misc_${m.category}`;
      if (!miscGroups.has(key)) miscGroups.set(key, []);
      miscGroups.get(key)!.push(indices[0]);
    } else {
      const clusterMems = indices.map((i) => memories[i]);
      clusters.push({
        memories: clusterMems,
        dominantCategory: getDominantCategory(clusterMems),
      });
    }
  }

  // Add misc groups as clusters (if >= MIN_CLUSTER_SIZE)
  for (const [_key, indices] of miscGroups) {
    if (indices.length >= MIN_CLUSTER_SIZE) {
      const clusterMems = indices.map((i) => memories[i]);
      clusters.push({
        memories: clusterMems,
        dominantCategory: getDominantCategory(clusterMems),
      });
    }
  }

  return clusters;
}

function getDominantCategory(memories: AgentMemory[]): string {
  const counts = new Map<string, number>();
  for (const m of memories) {
    counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
  }
  let max = 0;
  let dominant = "fact";
  for (const [cat, count] of counts) {
    if (count > max) {
      max = count;
      dominant = cat;
    }
  }
  return dominant;
}

// ── LLM Prompt ────────────────────────────────────────────────────

function buildCompilePrompt(clusters: ClusterInput[], existingTopics: string[]): string {
  const topicsSection =
    existingTopics.length > 0
      ? `\nExisting topics (reuse these exact names when appropriate):\n${existingTopics.map((t) => `  - ${t}`).join("\n")}\n`
      : "";

  return `You are a knowledge compiler. Convert each memory cluster into a concise wiki article.
Return a JSON array of objects, one per cluster, with these fields:
  - "clusterIdx": (number, same as input)
  - "topic": (string ≤ 60 chars, a clear topic title)
  - "summary": (string ≤ 120 chars, one-sentence overview for a table of contents)
  - "content": (string between 100 and 4000 chars, dense markdown synthesizing all memories)
${topicsSection}
Rules:
- Preserve ALL unique facts; do NOT hallucinate.
- Content should be scannable: use bullets or short paragraphs.
- Omit dates/IDs from the article body (they're metadata).
- Reuse an existing topic name exactly if this cluster clearly belongs to it; only coin a new name if no existing topic fits.
- Return ONLY the JSON array, no prose outside it.

Clusters:
${JSON.stringify(clusters, null, 2)}`;
}

function parseBatchResponse(text: string): ParsedArticle[] {
  // Strip markdown code fences
  const cleaned = text
    .replace(/```(?:json)?\s*/g, "")
    .replace(/```/g, "")
    .trim();

  function tryParseArray(s: string): ParsedArticle[] | null {
    try {
      const arr = JSON.parse(s);
      if (!Array.isArray(arr)) return null;
      return arr.filter(
        (item): item is ParsedArticle =>
          typeof item === "object" &&
          item !== null &&
          typeof item.topic === "string" &&
          typeof item.summary === "string" &&
          typeof item.content === "string" &&
          typeof item.clusterIdx === "number",
      );
    } catch {
      return null;
    }
  }

  // Try direct parse first (prompt says return ONLY the JSON array)
  const direct = tryParseArray(cleaned);
  if (direct) return direct;

  // Fallback: use regex to extract outermost JSON array (avoids matching prose '[')
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  return tryParseArray(match[0]) ?? [];
}

// ── Helpers ────────────────────────────────────────────────────────

function rowToArticle(row: any): WikiArticle {
  return {
    id: row.id,
    agentId: row.agent_id,
    channel: row.channel,
    topic: row.topic,
    summary: row.summary,
    content: row.content,
    memoryIds: safeParseIds(row.memory_ids),
    sourceCount: row.source_count ?? 0,
    version: row.version ?? 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCompiledAt: row.last_compiled_at ?? 0,
  };
}

function safeParseIds(json: string | null): number[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function sanitizeFTSQuery(query: string): string {
  // Remove FTS5 special chars that cause parse errors
  const terms = query
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 10);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Simple keyword extractor — mirrors logic in agent-memory.ts.
 * Exported as extractWikiKeywords for external use (tests, plugins).
 */
function extractKeywordsLocal(text: string): string[] {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "shall",
    "can",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "as",
    "into",
    "than",
    "then",
    "when",
    "where",
    "which",
    "who",
    "what",
    "how",
    "all",
    "any",
    "both",
    "each",
    "more",
    "also",
    "not",
    "no",
    "so",
    "if",
    "up",
    "out",
    "about",
  ]);

  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 20);
}

/** Public alias for extractKeywordsLocal — importable by tests and plugins. */
export const extractWikiKeywords = extractKeywordsLocal;

/** @internal Exported for unit tests only — do not use in production code. */
export { parseBatchResponse as _parseBatchResponseForTests };
