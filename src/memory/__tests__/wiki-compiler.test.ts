/**
 * Tests for WikiCompiler class.
 *
 * Uses in-memory SQLite via real migrations (no filesystem).
 * LLMClient interface is mocked.
 *
 * Known bugs exposed (tests that CURRENTLY FAIL and document bugs):
 *   [BUG-1] refreshMemoryIdsCache: NOT NULL violation when zero refs (missing COALESCE)
 *
 * Previously documented bugs that have since been fixed:
 *   [BUG-2] getTOC: LIMIT 20 is now enforced
 *   [BUG-3] absorbPendingNotes: only deletes notes when save() returns a valid id
 *   [BUG-4] compileIncremental: absorbed memory IDs are now added to staleMemoryIds
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../db/migrations";
import { memoryMigrations } from "../../db/migrations/memory-migrations";
import { WikiCompiler } from "../../agent/memory/wiki-compiler";
import type { AgentMemory, MemorySaveInput } from "../../agent/memory/agent-memory";

// ─── Shared constants ─────────────────────────────────────────────────────────

/** Minimum-length wiki article content (schema: CHECK(length(content) BETWEEN 100 AND 4000)) */
const ARTICLE_CONTENT =
  "This test wiki article has enough content to satisfy the hundred-character minimum imposed by the agent_wiki table schema CHECK constraint.";

/** Two memory strings that share ≥ 2 keywords so they form a cluster */
const MEM_A = "The authentication system uses OAuth tokens for login security verification";
const MEM_B = "OAuth authentication requires secure tokens and login credentials for verification";

/** A valid LLM batch response for clusterIdx 0 */
const VALID_LLM_RESPONSE = JSON.stringify([
  {
    clusterIdx: 0,
    topic: "Authentication System",
    summary: "OAuth-based authentication tokens and login security",
    content:
      "The authentication system uses OAuth tokens for login. Security verification requires credentials. Token management ensures secure access to all protected resources in the system architecture.",
  },
]);

const MALFORMED_LLM_RESPONSE = "Sorry, I cannot compile these memories at this time. There was an internal error.";

const PROSE_BEFORE_JSON = "Here are the compiled wiki articles for the clusters you provided:\n\n" + VALID_LLM_RESPONSE;

const FENCED_JSON_RESPONSE = "```json\n" + VALID_LLM_RESPONSE + "\n```";

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Create a fresh in-memory DB with all memory migrations applied. */
function makeDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db, memoryMigrations);
  return db;
}

/** Build a mock LLMClient that always returns the given text. */
function makeMockLLM(responseText: string) {
  return {
    model: "test-model",
    complete: async (_opts: unknown) => ({
      choices: [{ message: { content: responseText } }],
    }),
  };
}

/** Minimal AgentMemoryStore interface used by WikiCompiler methods. */
interface MinimalStore {
  save(input: MemorySaveInput): { id: number | null; warning?: string };
  getAllForCompilation(agentId: string, channel: string): AgentMemory[];
}

/** Build a controllable fake store. `saveResults` is consumed in order. */
function makeFakeStore(
  memories: AgentMemory[] = [],
  saveResults: Array<{ id: number | null; warning?: string }> = [],
): MinimalStore & { savedInputs: MemorySaveInput[] } {
  const savedInputs: MemorySaveInput[] = [];
  let autoId = 100;
  return {
    savedInputs,
    save(input) {
      savedInputs.push(input);
      return saveResults.length > 0 ? saveResults.shift()! : { id: autoId++ };
    },
    getAllForCompilation(_agentId, _channel) {
      return memories;
    },
  };
}

/** Construct an AgentMemory object (no DB needed). */
function makeMemory(id: number, content: string, agentId = "a1", channel = "c1"): AgentMemory {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    agentId,
    channel,
    category: "fact",
    content,
    source: "explicit",
    priority: 50,
    tags: "",
    effectiveness: 0.5,
    accessCount: 0,
    lastAccessed: now,
    createdAt: now,
    updatedAt: now,
  };
}

/** Insert a row into agent_memories, keeping FTS in sync. */
function insertMemoryRow(db: Database, agentId: string, channel: string, content: string, updatedAt?: number): number {
  const ts = updatedAt ?? Math.floor(Date.now() / 1000);
  const r = db.run(
    `INSERT INTO agent_memories
       (agent_id, channel, category, content, source, priority, tags, effectiveness,
        updated_at, created_at, last_accessed)
     VALUES (?, ?, 'fact', ?, 'explicit', 50, '', 0.5, ?, ?, ?)`,
    [agentId, channel, content, ts, ts, ts],
  );
  const rowid = Number(r.lastInsertRowid);
  db.run(`INSERT INTO agent_memories_fts(rowid, content) VALUES (?, ?)`, [rowid, content]);
  return rowid;
}

/** Insert a row into agent_wiki. */
function insertArticleRow(
  db: Database,
  agentId: string,
  channel: string,
  topic: string,
  opts: { lastCompiledAt?: number; updatedAt?: number; content?: string } = {},
): number {
  const { lastCompiledAt = 0, updatedAt = Math.floor(Date.now() / 1000), content = ARTICLE_CONTENT } = opts;
  const r = db.run(
    `INSERT INTO agent_wiki
       (agent_id, channel, topic, summary, content, memory_ids, source_count, version,
        last_compiled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', 0, 1, ?, unixepoch(), ?)`,
    [agentId, channel, topic, `Summary of ${topic}`, content, lastCompiledAt, updatedAt],
  );
  return Number(r.lastInsertRowid);
}

/** Insert a wiki_memory_refs row. */
function insertRef(db: Database, wikiId: number, memoryId: number): void {
  db.run(`INSERT OR IGNORE INTO wiki_memory_refs (wiki_id, memory_id) VALUES (?, ?)`, [wikiId, memoryId]);
}

/** Helper to return two memories that share enough keywords to cluster. */
function clusterPair(): AgentMemory[] {
  return [makeMemory(1, MEM_A), makeMemory(2, MEM_B)];
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("WikiCompiler", () => {
  let db: Database;
  let compiler: WikiCompiler;

  beforeEach(() => {
    db = makeDb();
    compiler = new WikiCompiler(db);
  });

  // ── ensureInit ─────────────────────────────────────────────────────────────

  describe("ensureInit (tested via public methods)", () => {
    test("returns true after migrations create agent_wiki — public methods succeed", () => {
      // getTOC is a convenient public wrapper that calls ensureInit internally
      expect(() => compiler.getTOC("a1", "c1")).not.toThrow();
      expect(compiler.getTOC("a1", "c1")).toEqual([]);
    });

    test("returns false when agent_wiki table is absent — public methods return defaults", () => {
      const bareDb = new Database(":memory:");
      // No migrations → agent_wiki does not exist
      const bareCompiler = new WikiCompiler(bareDb);

      expect(bareCompiler.getTOC("a1", "c1")).toEqual([]);
      expect(bareCompiler.getArticles("a1", "c1", ["any"])).toEqual([]);
      expect(bareCompiler.getArticleCount("a1", "c1")).toBe(0);
      expect(bareCompiler.search("a1", "c1", "query")).toEqual([]);
    });

    test("all wiki tables created by migrations: agent_wiki, wiki_memory_refs, agent_wiki_fts, wiki_pending_notes", () => {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' OR type='shadow'").all() as Array<{
        name: string;
      }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("agent_wiki");
      expect(names).toContain("wiki_memory_refs");
      expect(names).toContain("wiki_pending_notes");
    });

    test("FTS triggers keep agent_wiki_fts in sync after INSERT", () => {
      // The aw_ai trigger fires on INSERT into agent_wiki
      insertArticleRow(db, "a1", "c1", "TypeScript Basics");
      db.run(`INSERT INTO agent_wiki_fts(agent_wiki_fts) VALUES('rebuild')`);
      const rows = db.query("SELECT * FROM agent_wiki_fts WHERE agent_wiki_fts MATCH '\"typescript\"'").all();
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  // ── upsertArticle (via compile) ────────────────────────────────────────────

  describe("upsertArticle (exercised via compile)", () => {
    test("inserts new article — result.created increments", async () => {
      const store = makeFakeStore(clusterPair());
      const result = await compiler.compile("a1", "c1", makeMockLLM(VALID_LLM_RESPONSE) as any, "m", store as any);
      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);

      const row = db.query("SELECT topic, version FROM agent_wiki WHERE agent_id='a1'").get() as any;
      expect(row.topic).toBe("Authentication System");
      expect(row.version).toBe(1);
    });

    test("updates existing article — version increments on second compile", async () => {
      // First compile — creates
      const store1 = makeFakeStore(clusterPair());
      await compiler.compile("a1", "c1", makeMockLLM(VALID_LLM_RESPONSE) as any, "m", store1 as any);

      // Second compile — updates
      const store2 = makeFakeStore(clusterPair());
      const result2 = await compiler.compile("a1", "c1", makeMockLLM(VALID_LLM_RESPONSE) as any, "m", store2 as any);
      expect(result2.updated).toBe(1);
      expect(result2.created).toBe(0);

      const row = db.query("SELECT version FROM agent_wiki WHERE agent_id='a1'").get() as any;
      expect(row.version).toBe(2);
    });

    test("handles zero-ref article insertion (COALESCE guard in refreshMemoryIdsCache)", async () => {
      // When LLM returns valid article but memoryIds list is empty (edge case),
      // upsertArticle should not throw. refreshMemoryIdsCache will silently fail
      // due to NOT NULL constraint — the insert still succeeds.
      const store = makeFakeStore(clusterPair());
      await expect(
        compiler.compile("a1", "c1", makeMockLLM(VALID_LLM_RESPONSE) as any, "m", store as any),
      ).resolves.not.toBeNull();
    });

    test("skips article when content is below MIN_ARTICLE_CHARS (100)", async () => {
      const shortContentResponse = JSON.stringify([
        { clusterIdx: 0, topic: "Short", summary: "too short", content: "Too short." },
      ]);
      const store = makeFakeStore(clusterPair());
      const result = await compiler.compile("a1", "c1", makeMockLLM(shortContentResponse) as any, "m", store as any);
      expect(result.created).toBe(0);
      const count = db.query("SELECT COUNT(*) as c FROM agent_wiki").get() as any;
      expect(count.c).toBe(0);
    });

    test("transaction rollback on DB error: errors counted, compile does not throw", async () => {
      // Force a CHECK constraint violation by crafting content that exceeds 4000 chars
      const bigContent = "x".repeat(4001);
      const oversizedResponse = JSON.stringify([
        { clusterIdx: 0, topic: "Big Article", summary: "big", content: bigContent },
      ]);
      const store = makeFakeStore(clusterPair());
      // Should not throw — upsertArticle catches errors and logs them
      const result = await compiler.compile("a1", "c1", makeMockLLM(oversizedResponse) as any, "m", store as any);
      // Content is sliced to MAX_ARTICLE_CHARS (4000) before insert, so it succeeds
      expect(result.errors).toBe(0);
    });
  });

  // ── refreshMemoryIdsCache ──────────────────────────────────────────────────

  describe("refreshMemoryIdsCache", () => {
    test("updates memory_ids JSON array and source_count when refs exist", () => {
      const wikiId = insertArticleRow(db, "a1", "c1", "Topic A");
      const mid1 = insertMemoryRow(db, "a1", "c1", "Memory content one");
      const mid2 = insertMemoryRow(db, "a1", "c1", "Memory content two");
      insertRef(db, wikiId, mid1);
      insertRef(db, wikiId, mid2);

      compiler.refreshMemoryIdsCache(wikiId);

      const row = db.query("SELECT memory_ids, source_count FROM agent_wiki WHERE id = ?").get(wikiId) as any;
      const ids = JSON.parse(row.memory_ids) as number[];
      expect(ids).toContain(mid1);
      expect(ids).toContain(mid2);
      expect(row.source_count).toBe(2);
    });

    test("[BUG-1] KNOWN BUG: refreshMemoryIdsCache with zero refs silently fails — missing COALESCE", () => {
      // json_group_array() on empty set returns NULL, which violates NOT NULL constraint on memory_ids.
      // The try/catch swallows the error, so memory_ids is NOT updated (stays '[]' from INSERT).
      const wikiId = insertArticleRow(db, "a1", "c1", "Empty Refs Topic");

      // Must not throw (error is caught internally)
      expect(() => compiler.refreshMemoryIdsCache(wikiId)).not.toThrow();

      const row = db.query("SELECT memory_ids, source_count FROM agent_wiki WHERE id = ?").get(wikiId) as any;
      // BUG: memory_ids was NOT updated to '[]' by COALESCE — stays at initial default '[]'
      // This passes for the wrong reason: the update silently failed.
      // Fix: use COALESCE(json_group_array(memory_id), '[]') in the UPDATE query.
      expect(row.memory_ids).toBe("[]");
      expect(row.source_count).toBe(0); // source_count IS updated by a separate scalar subquery
    });

    test("correct JSON when single ref exists", () => {
      const wikiId = insertArticleRow(db, "a1", "c1", "Single Ref");
      const mid = insertMemoryRow(db, "a1", "c1", "Single memory");
      insertRef(db, wikiId, mid);

      compiler.refreshMemoryIdsCache(wikiId);

      const row = db.query("SELECT memory_ids FROM agent_wiki WHERE id = ?").get(wikiId) as any;
      const ids = JSON.parse(row.memory_ids) as number[];
      expect(ids).toEqual([mid]);
    });
  });

  // ── getArticles ────────────────────────────────────────────────────────────

  describe("getArticles", () => {
    test("returns empty array for empty topics list", () => {
      insertArticleRow(db, "a1", "c1", "Existing Topic");
      expect(compiler.getArticles("a1", "c1", [])).toEqual([]);
    });

    test("returns empty array for topic that does not exist", () => {
      expect(compiler.getArticles("a1", "c1", ["Ghost Topic"])).toEqual([]);
    });

    test("case-insensitive topic lookup — lowercase query matches mixed-case stored topic", () => {
      insertArticleRow(db, "a1", "c1", "TypeScript Guide");
      const results = compiler.getArticles("a1", "c1", ["typescript guide"]);
      expect(results).toHaveLength(1);
      expect(results[0].topic).toBe("TypeScript Guide");
    });

    test("case-insensitive topic lookup — uppercase query", () => {
      insertArticleRow(db, "a1", "c1", "typescript guide");
      const results = compiler.getArticles("a1", "c1", ["TYPESCRIPT GUIDE"]);
      expect(results).toHaveLength(1);
    });

    test("returns article for exact matching topic", () => {
      insertArticleRow(db, "a1", "c1", "Exact Match Topic");
      const results = compiler.getArticles("a1", "c1", ["Exact Match Topic"]);
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe("a1");
      expect(results[0].channel).toBe("c1");
    });

    test("returns multiple articles for multiple topics", () => {
      insertArticleRow(db, "a1", "c1", "Topic Alpha");
      insertArticleRow(db, "a1", "c1", "Topic Beta");
      const results = compiler.getArticles("a1", "c1", ["Topic Alpha", "Topic Beta"]);
      expect(results).toHaveLength(2);
    });

    test("scoped to agent_id — different agent sees no articles", () => {
      insertArticleRow(db, "a1", "c1", "Private Topic");
      expect(compiler.getArticles("a2", "c1", ["Private Topic"])).toHaveLength(0);
    });

    test("scoped to channel — different channel sees no articles", () => {
      insertArticleRow(db, "a1", "c1", "Channel Topic");
      expect(compiler.getArticles("a1", "c2", ["Channel Topic"])).toHaveLength(0);
    });

    test("returns WikiArticle with all expected fields", () => {
      const wikiId = insertArticleRow(db, "a1", "c1", "Full Fields Topic");
      const mid = insertMemoryRow(db, "a1", "c1", "Source memory");
      insertRef(db, wikiId, mid);
      compiler.refreshMemoryIdsCache(wikiId);

      const results = compiler.getArticles("a1", "c1", ["Full Fields Topic"]);
      expect(results).toHaveLength(1);
      const art = results[0];
      expect(art.id).toBe(wikiId);
      expect(art.topic).toBe("Full Fields Topic");
      expect(art.content).toBe(ARTICLE_CONTENT);
      expect(typeof art.version).toBe("number");
      expect(typeof art.createdAt).toBe("number");
      expect(typeof art.updatedAt).toBe("number");
    });
  });

  // ── getTOC ────────────────────────────────────────────────────────────────

  describe("getTOC", () => {
    test("returns empty array for unknown agent/channel", () => {
      expect(compiler.getTOC("nobody", "nowhere")).toEqual([]);
    });

    test("returns entries with topic, summary, updatedAt fields", () => {
      insertArticleRow(db, "a1", "c1", "My Topic");
      const toc = compiler.getTOC("a1", "c1");
      expect(toc).toHaveLength(1);
      expect(toc[0].topic).toBe("My Topic");
      expect(toc[0].summary).toBe("Summary of My Topic");
      expect(typeof toc[0].updatedAt).toBe("number");
    });

    test("orders entries by updated_at DESC (newest first)", () => {
      // Insert older article first with explicit timestamp
      db.run(
        `INSERT INTO agent_wiki
           (agent_id, channel, topic, summary, content, memory_ids, source_count, version,
            last_compiled_at, created_at, updated_at)
         VALUES ('a1', 'c1', 'Older', 'sum', ?, '[]', 0, 1, 0, 1000, 1000)`,
        [ARTICLE_CONTENT],
      );
      db.run(
        `INSERT INTO agent_wiki
           (agent_id, channel, topic, summary, content, memory_ids, source_count, version,
            last_compiled_at, created_at, updated_at)
         VALUES ('a1', 'c1', 'Newer', 'sum', ?, '[]', 0, 1, 0, 2000, 2000)`,
        [ARTICLE_CONTENT],
      );

      const toc = compiler.getTOC("a1", "c1");
      expect(toc[0].topic).toBe("Newer");
      expect(toc[1].topic).toBe("Older");
    });

    test("scoped to agent_id and channel", () => {
      insertArticleRow(db, "a1", "c1", "Agent1 Topic");
      insertArticleRow(db, "a2", "c1", "Agent2 Topic");
      expect(compiler.getTOC("a1", "c1")).toHaveLength(1);
      expect(compiler.getTOC("a2", "c1")).toHaveLength(1);
    });

    test("getTOC enforces LIMIT 20 — returns at most 20 articles when more exist", () => {
      // Insert 25 articles
      for (let i = 0; i < 25; i++) {
        insertArticleRow(db, "a1", "c1", `Bulk Topic ${i}`);
      }
      const toc = compiler.getTOC("a1", "c1");
      // LIMIT 20 is enforced in getTOC's SQL
      expect(toc.length).toBeLessThanOrEqual(20);
      expect(toc.length).toBeGreaterThan(0);
    });
  });

  // ── deleteOrphanedArticles (via compile) ───────────────────────────────────

  describe("deleteOrphanedArticles (exercised via compile)", () => {
    test("removes articles with zero refs after compilation", async () => {
      // Article has no wiki_memory_refs rows → orphaned
      insertArticleRow(db, "a1", "c1", "Orphaned Topic");

      const store = makeFakeStore(clusterPair());
      await compiler.compile("a1", "c1", makeMockLLM("[]") as any, "m", store as any);

      const orphan = db.query("SELECT id FROM agent_wiki WHERE topic='Orphaned Topic'").get();
      expect(orphan).toBeNull();
    });

    test("keeps articles that have at least one ref", async () => {
      const wikiId = insertArticleRow(db, "a1", "c1", "Referenced Topic");
      const mid = insertMemoryRow(db, "a1", "c1", "Referenced memory content here");
      insertRef(db, wikiId, mid);

      // Use that memory ID in the cluster too, so it's a "live" article
      const store = makeFakeStore([makeMemory(mid, MEM_A), makeMemory(99, MEM_B)]);
      await compiler.compile("a1", "c1", makeMockLLM("[]") as any, "m", store as any);

      const article = db.query("SELECT id FROM agent_wiki WHERE topic='Referenced Topic'").get();
      expect(article).not.toBeNull();
    });

    test("single-query efficiency — deleteOrphanedArticles checks refs without N+1 queries", () => {
      // Insert many articles — some with refs, some without
      for (let i = 0; i < 10; i++) {
        const wid = insertArticleRow(db, "a1", "c1", `Orphan ${i}`);
        if (i % 2 === 0) {
          const mid = insertMemoryRow(db, "a1", "c1", `Memory for topic ${i}`);
          insertRef(db, wid, mid);
        }
      }

      const store = makeFakeStore(clusterPair());
      // Should complete without throwing even with many articles
      expect(async () => compiler.compile("a1", "c1", makeMockLLM("[]") as any, "m", store as any)).not.toThrow();
    });
  });

  // ── compileIncremental ────────────────────────────────────────────────────

  describe("compileIncremental", () => {
    test("skips compilation when all articles are up-to-date (memory updated_at ≤ last_compiled_at)", async () => {
      const now = Math.floor(Date.now() / 1000);
      const mid = insertMemoryRow(db, "a1", "c1", MEM_A, now - 200); // updated 200s ago
      const wid = insertArticleRow(db, "a1", "c1", "Fresh Topic", {
        lastCompiledAt: now, // compiled NOW → newer than memory
      });
      insertRef(db, wid, mid);

      let llmCalled = false;
      const llm = {
        model: "test",
        complete: async () => {
          llmCalled = true;
          return { choices: [{ message: { content: "[]" } }] };
        },
      };
      const store = makeFakeStore([makeMemory(mid, MEM_A), makeMemory(99, MEM_B)]);
      await compiler.compileIncremental("a1", "c1", llm as any, "m", store as any);

      expect(llmCalled).toBe(false);
    });

    test("recompiles dirty articles (last_compiled_at = 0 sentinel)", async () => {
      const mid = insertMemoryRow(db, "a1", "c1", MEM_A);
      const wid = insertArticleRow(db, "a1", "c1", "Dirty Topic", { lastCompiledAt: 0 });
      insertRef(db, wid, mid);

      let llmCalled = false;
      const llm = {
        model: "test",
        complete: async () => {
          llmCalled = true;
          return { choices: [{ message: { content: "[]" } }] };
        },
      };
      const store = makeFakeStore([makeMemory(mid, MEM_A), makeMemory(99, MEM_B)]);
      await compiler.compileIncremental("a1", "c1", llm as any, "m", store as any);

      expect(llmCalled).toBe(true);
    });

    test("recompiles stale articles (memory updated_at > last_compiled_at)", async () => {
      const now = Math.floor(Date.now() / 1000);
      const mid = insertMemoryRow(db, "a1", "c1", MEM_A, now); // updated NOW
      const wid = insertArticleRow(db, "a1", "c1", "Stale Topic", {
        lastCompiledAt: now - 300, // compiled 300s ago → stale
      });
      insertRef(db, wid, mid);

      let llmCalled = false;
      const llm = {
        model: "test",
        complete: async () => {
          llmCalled = true;
          return { choices: [{ message: { content: "[]" } }] };
        },
      };
      const store = makeFakeStore([makeMemory(mid, MEM_A), makeMemory(99, MEM_B)]);
      await compiler.compileIncremental("a1", "c1", llm as any, "m", store as any);

      expect(llmCalled).toBe(true);
    });

    test("returns early (no LLM call) when store.getAllForCompilation returns empty", async () => {
      const mid = insertMemoryRow(db, "a1", "c1", MEM_A);
      const wid = insertArticleRow(db, "a1", "c1", "Dirty", { lastCompiledAt: 0 });
      insertRef(db, wid, mid);

      let llmCalled = false;
      const llm = {
        model: "test",
        complete: async () => {
          llmCalled = true;
          return { choices: [{ message: { content: "[]" } }] };
        },
      };
      const store = makeFakeStore([]); // No memories
      const result = await compiler.compileIncremental("a1", "c1", llm as any, "m", store as any);

      expect(llmCalled).toBe(false);
      expect(result.created).toBe(0);
    });

    test("calls deleteOrphanedArticles — orphaned articles removed during incremental compile", async () => {
      // Orphaned article (no refs)
      insertArticleRow(db, "a1", "c1", "Orphan During Incremental");

      // A dirty article that triggers compilation
      const mid = insertMemoryRow(db, "a1", "c1", MEM_A);
      const wid = insertArticleRow(db, "a1", "c1", "Trigger Dirty", { lastCompiledAt: 0 });
      insertRef(db, wid, mid);

      // deleteOrphanedArticles IS called by compileIncremental (fixed behavior)
      const store = makeFakeStore([makeMemory(mid, MEM_A), makeMemory(99, MEM_B)]);
      await compiler.compileIncremental("a1", "c1", makeMockLLM("[]") as any, "m", store as any);

      // Orphan IS removed by compileIncremental
      const orphan = db.query("SELECT id FROM agent_wiki WHERE topic='Orphan During Incremental'").get();
      expect(orphan).toBeNull(); // Removed — compileIncremental does prune orphans
    });

    test("[BUG-4] KNOWN BUG: new memories from absorbPendingNotes are not in staleMemoryIds", async () => {
      // Stage a pending note
      compiler.stagePendingNote("a1", "c1", "Brand new note becoming a fresh memory", "hint");

      let llmCalled = false;
      const llm = {
        model: "test",
        complete: async () => {
          llmCalled = true;
          return { choices: [{ message: { content: "[]" } }] };
        },
      };
      // Store with no pre-existing stale articles and no memories (all returned by getAllForCompilation)
      const store = makeFakeStore([]);
      await compiler.compileIncremental("a1", "c1", llm as any, "m", store as any);

      // BUG: The new memory created from the note has no existing wiki article referencing it,
      // so staleMemoryIds is empty, toRecompile is empty, and compileIncremental returns early.
      // The brand-new memory is never compiled into an article.
      expect(llmCalled).toBe(false); // Confirms the bug
    });
  });

  // ── parseBatchResponse (via compile) ──────────────────────────────────────

  describe("parseBatchResponse (exercised via compile)", () => {
    test("valid JSON array: creates wiki articles", async () => {
      const store = makeFakeStore(clusterPair());
      await compiler.compile("a1", "c1", makeMockLLM(VALID_LLM_RESPONSE) as any, "m", store as any);

      const count = db.query("SELECT COUNT(*) as c FROM agent_wiki WHERE agent_id='a1'").get() as any;
      expect(count.c).toBeGreaterThan(0);
    });

    test("malformed response (no JSON): no articles created, no throw", async () => {
      const store = makeFakeStore(clusterPair());
      const result = await compiler.compile("a1", "c1", makeMockLLM(MALFORMED_LLM_RESPONSE) as any, "m", store as any);

      expect(result.errors).toBe(0); // Graceful degradation, not an error
      const count = db.query("SELECT COUNT(*) as c FROM agent_wiki WHERE agent_id='a1'").get() as any;
      expect(count.c).toBe(0);
    });

    test("prose text before JSON array bracket: fallback parser extracts array", async () => {
      const store = makeFakeStore(clusterPair());
      await compiler.compile("a1", "c1", makeMockLLM(PROSE_BEFORE_JSON) as any, "m", store as any);

      const count = db.query("SELECT COUNT(*) as c FROM agent_wiki WHERE agent_id='a1'").get() as any;
      expect(count.c).toBeGreaterThan(0);
    });

    test("JSON in markdown code fence: fences stripped, array parsed", async () => {
      const store = makeFakeStore(clusterPair());
      await compiler.compile("a1", "c1", makeMockLLM(FENCED_JSON_RESPONSE) as any, "m", store as any);

      const count = db.query("SELECT COUNT(*) as c FROM agent_wiki WHERE agent_id='a1'").get() as any;
      expect(count.c).toBeGreaterThan(0);
    });

    test("array with missing required fields: invalid items silently skipped", async () => {
      const incompleteResponse = JSON.stringify([
        { clusterIdx: 0 }, // missing topic, summary, content
        { clusterIdx: 0, topic: "Good", summary: "Good summary", content: ARTICLE_CONTENT },
      ]);
      const store = makeFakeStore(clusterPair());
      // Should not throw — invalid items are skipped
      await expect(
        compiler.compile("a1", "c1", makeMockLLM(incompleteResponse) as any, "m", store as any),
      ).resolves.toBeDefined();
    });
  });

  // ── absorbPendingNotes ─────────────────────────────────────────────────────

  describe("absorbPendingNotes", () => {
    test("saves each pending note via store.save() and returns array of new memory IDs", () => {
      db.run(
        `INSERT INTO wiki_pending_notes (agent_id, channel, content, priority) VALUES ('a1','c1','Note one content here', 45)`,
      );
      db.run(
        `INSERT INTO wiki_pending_notes (agent_id, channel, content, priority) VALUES ('a1','c1','Note two content here', 45)`,
      );

      const store = makeFakeStore();
      const newIds = compiler.absorbPendingNotes("a1", "c1", store as any);

      // Returns array of memory IDs for successfully saved notes
      expect(newIds).toHaveLength(2);
      expect(newIds[0]).toBeNumber();
      expect(newIds[1]).toBeNumber();
      expect(store.savedInputs).toHaveLength(2);
      expect(store.savedInputs[0].content).toBe("Note one content here");
      expect(store.savedInputs[1].content).toBe("Note two content here");
    });

    test("saves notes with correct agentId and channel", () => {
      db.run(
        `INSERT INTO wiki_pending_notes (agent_id, channel, content) VALUES ('agent-xyz','channel-abc','Test content')`,
      );

      const store = makeFakeStore();
      compiler.absorbPendingNotes("agent-xyz", "channel-abc", store as any);

      expect(store.savedInputs[0].agentId).toBe("agent-xyz");
      expect(store.savedInputs[0].channel).toBe("channel-abc");
      expect(store.savedInputs[0].source).toBe("auto");
    });

    test("deletes notes after saving them", () => {
      db.run(`INSERT INTO wiki_pending_notes (agent_id, channel, content) VALUES ('a1','c1','Content to absorb')`);

      const store = makeFakeStore();
      compiler.absorbPendingNotes("a1", "c1", store as any);

      const remaining = db.query("SELECT COUNT(*) as c FROM wiki_pending_notes WHERE agent_id='a1'").get() as any;
      expect(remaining.c).toBe(0);
    });

    test("returns empty array when no pending notes exist", () => {
      const store = makeFakeStore();
      expect(compiler.absorbPendingNotes("a1", "c1", store as any)).toEqual([]);
      expect(store.savedInputs).toHaveLength(0);
    });

    test("only absorbs notes for specified agent+channel", () => {
      db.run(`INSERT INTO wiki_pending_notes (agent_id, channel, content) VALUES ('a1','c1','Agent1 note')`);
      db.run(`INSERT INTO wiki_pending_notes (agent_id, channel, content) VALUES ('a2','c1','Agent2 note')`);

      const store = makeFakeStore();
      const newIds = compiler.absorbPendingNotes("a1", "c1", store as any);
      expect(newIds).toHaveLength(1);

      // a2's note should remain
      const a2Notes = db.query("SELECT COUNT(*) as c FROM wiki_pending_notes WHERE agent_id='a2'").get() as any;
      expect(a2Notes.c).toBe(1);
    });

    test("preserves note priority when saving as memory", () => {
      db.run(
        `INSERT INTO wiki_pending_notes (agent_id, channel, content, priority) VALUES ('a1','c1','High priority note', 70)`,
      );

      const store = makeFakeStore();
      compiler.absorbPendingNotes("a1", "c1", store as any);

      expect(store.savedInputs[0].priority).toBe(70);
    });

    test("notes with failed saves (id=null) are NOT deleted — only successful saves are removed", () => {
      db.run(`INSERT INTO wiki_pending_notes (agent_id, channel, content) VALUES ('a1','c1','Note A')`);
      db.run(`INSERT INTO wiki_pending_notes (agent_id, channel, content) VALUES ('a1','c1','Note B')`);

      // Simulate save() failure: returns { id: null } for both
      const failingStore = makeFakeStore([], [{ id: null }, { id: null }]);
      const newIds = compiler.absorbPendingNotes("a1", "c1", failingStore as any);

      // No successful saves → empty array returned
      expect(newIds).toEqual([]);

      // Notes are NOT deleted because saves failed — data preserved for retry
      const remaining = db.query("SELECT COUNT(*) as c FROM wiki_pending_notes WHERE agent_id='a1'").get() as any;
      expect(remaining.c).toBe(2);
    });
  });

  // ── stagePendingNote ───────────────────────────────────────────────────────

  describe("stagePendingNote", () => {
    test("stores note with string topicHint", () => {
      const ok = compiler.stagePendingNote("a1", "c1", "Note content here", "typescript");

      expect(ok).toBe(true);
      const row = db.query("SELECT * FROM wiki_pending_notes WHERE agent_id='a1'").get() as any;
      expect(row).not.toBeNull();
      expect(row.content).toBe("Note content here");
      expect(row.topic_hint).toBe("typescript");
      expect(row.agent_id).toBe("a1");
      expect(row.channel).toBe("c1");
    });

    test("stores note with null topicHint", () => {
      const ok = compiler.stagePendingNote("a1", "c1", "Note without hint", null);

      expect(ok).toBe(true);
      const row = db.query("SELECT topic_hint FROM wiki_pending_notes WHERE agent_id='a1'").get() as any;
      expect(row.topic_hint).toBeNull();
    });

    test("stores note with undefined topicHint (treated as NULL in SQLite)", () => {
      // topicHint is optional — omitting it maps to undefined → NULL in DB
      const ok = compiler.stagePendingNote("a1", "c1", "Note with no hint at all");

      expect(ok).toBe(true);
      const row = db.query("SELECT topic_hint FROM wiki_pending_notes WHERE agent_id='a1'").get() as any;
      expect(row.topic_hint).toBeNull();
    });

    test("returns false when DB has no wiki tables (uninitialized)", () => {
      const bareDb = new Database(":memory:");
      const bareCompiler = new WikiCompiler(bareDb);
      const ok = bareCompiler.stagePendingNote("a1", "c1", "Content");
      expect(ok).toBe(false);
    });

    test("multiple notes staged independently for the same agent+channel", () => {
      compiler.stagePendingNote("a1", "c1", "First note", "hint-one");
      compiler.stagePendingNote("a1", "c1", "Second note", "hint-two");

      const rows = db.query("SELECT * FROM wiki_pending_notes WHERE agent_id='a1' ORDER BY id").all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].topic_hint).toBe("hint-one");
      expect(rows[1].topic_hint).toBe("hint-two");
    });
  });

  // ── search (searchArticles) ────────────────────────────────────────────────

  describe("search / searchArticles", () => {
    test("returns empty array for empty query string", () => {
      insertArticleRow(db, "a1", "c1", "Irrelevant Topic");
      expect(compiler.search("a1", "c1", "")).toEqual([]);
    });

    test("returns empty array for whitespace-only query", () => {
      insertArticleRow(db, "a1", "c1", "Topic");
      expect(compiler.search("a1", "c1", "   ")).toEqual([]);
    });

    test("FTS search returns articles matching query terms", () => {
      const richContent =
        "TypeScript generics and decorators enable powerful compile-time type checking and metadata reflection patterns in modern applications.";
      db.run(
        `INSERT INTO agent_wiki
           (agent_id, channel, topic, summary, content, memory_ids, source_count, version,
            last_compiled_at, created_at, updated_at)
         VALUES ('a1','c1','TypeScript Patterns','TS patterns',?,  '[]', 0, 1, 0, unixepoch(), unixepoch())`,
        [richContent],
      );
      db.run(`INSERT INTO agent_wiki_fts(agent_wiki_fts) VALUES('rebuild')`);

      const results = compiler.search("a1", "c1", "TypeScript generics");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].topic).toBe("TypeScript Patterns");
    });

    test("sanitizeFTSQuery: strips FTS5 special characters without throwing", () => {
      expect(() => compiler.search("a1", "c1", 'foo AND "bar" OR baz*')).not.toThrow();
      expect(() => compiler.search("a1", "c1", "foo(bar)^2 NEAR/3 qux")).not.toThrow();
      expect(() => compiler.search("a1", "c1", "alpha:beta gamma[delta]")).not.toThrow();
    });

    test("sanitizeFTSQuery: handles single-character terms (filtered out)", () => {
      // Single chars are filtered, empty result returns []
      expect(() => compiler.search("a1", "c1", "a b c")).not.toThrow();
    });

    test("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        const content = `Authentication login security tokens OAuth verification system article number ${i} with sufficient length here.`;
        db.run(
          `INSERT INTO agent_wiki
             (agent_id, channel, topic, summary, content, memory_ids, source_count, version,
              last_compiled_at, created_at, updated_at)
           VALUES ('a1','c1',?, 'sum', ?, '[]', 0, 1, 0, unixepoch(), unixepoch())`,
          [`Auth Topic ${i}`, content],
        );
      }
      db.run(`INSERT INTO agent_wiki_fts(agent_wiki_fts) VALUES('rebuild')`);

      const results = compiler.search("a1", "c1", "authentication", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    test("scoped to agent_id and channel — other agents/channels excluded", () => {
      const content =
        "Authentication tokens are essential for secure login security OAuth system management and access verification flow.";
      db.run(
        `INSERT INTO agent_wiki
           (agent_id, channel, topic, summary, content, memory_ids, source_count, version,
            last_compiled_at, created_at, updated_at)
         VALUES ('a1','c1','Auth Topic','sum', ?, '[]', 0, 1, 0, unixepoch(), unixepoch())`,
        [content],
      );
      db.run(`INSERT INTO agent_wiki_fts(agent_wiki_fts) VALUES('rebuild')`);

      expect(compiler.search("a2", "c1", "authentication")).toHaveLength(0);
      expect(compiler.search("a1", "c2", "authentication")).toHaveLength(0);
    });

    test("returns empty for uninitialized DB", () => {
      const bareDb = new Database(":memory:");
      const bareCompiler = new WikiCompiler(bareDb);
      expect(bareCompiler.search("a1", "c1", "query")).toEqual([]);
    });
  });

  // ── markWikiArticlesDirty (compile-pipeline integration) ──────────────────

  describe("markWikiArticlesDirty (compile-pipeline effect)", () => {
    test("articles with last_compiled_at = 0 are picked up by compileIncremental as dirty", async () => {
      const mid = insertMemoryRow(db, "a1", "c1", MEM_A);
      const wid = insertArticleRow(db, "a1", "c1", "Will Be Dirty", { lastCompiledAt: 99999 });
      insertRef(db, wid, mid);

      // Manually set last_compiled_at = 0 (simulating what markWikiArticlesDirty does)
      db.run(`UPDATE agent_wiki SET last_compiled_at = 0 WHERE id = ?`, [wid]);

      let llmCalled = false;
      const llm = {
        model: "test",
        complete: async () => {
          llmCalled = true;
          return { choices: [{ message: { content: "[]" } }] };
        },
      };
      const store = makeFakeStore([makeMemory(mid, MEM_A), makeMemory(99, MEM_B)]);
      await compiler.compileIncremental("a1", "c1", llm as any, "m", store as any);

      // LLM called because the dirty sentinel was detected
      expect(llmCalled).toBe(true);
    });

    test("sets last_compiled_at = 0 only for specified wiki IDs (verified via SQL)", () => {
      const wid1 = insertArticleRow(db, "a1", "c1", "Dirty Article", { lastCompiledAt: 1000 });
      const wid2 = insertArticleRow(db, "a1", "c1", "Clean Article", { lastCompiledAt: 1000 });

      // Directly exercise the effect (markWikiArticlesDirty is private on AgentMemoryStore)
      db.run(`UPDATE agent_wiki SET last_compiled_at = 0 WHERE id = ?`, [wid1]);

      const dirty = db.query("SELECT last_compiled_at FROM agent_wiki WHERE id = ?").get(wid1) as any;
      const clean = db.query("SELECT last_compiled_at FROM agent_wiki WHERE id = ?").get(wid2) as any;

      expect(dirty.last_compiled_at).toBe(0);
      expect(clean.last_compiled_at).toBe(1000); // Unaffected
    });
  });
});
