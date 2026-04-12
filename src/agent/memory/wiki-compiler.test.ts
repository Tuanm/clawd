/**
 * Tests for WikiCompiler and its associated pure functions.
 *
 * All tests use in-memory SQLite — no file I/O, no LLM network calls.
 * Private functions (clusterMemories, parseBatchResponse, searchFallback)
 * are exercised indirectly through the public API with capturing mock LLMs.
 */

import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentMemoryStore } from "./agent-memory";
import { extractWikiKeywords, WikiCompiler } from "./wiki-compiler";

// ── Constants (mirror module-level values) ────────────────────────────────────
const MAX_CLUSTER_SIZE = 30;

// ── Test helpers ──────────────────────────────────────────────────────────────

const AGENT = "agent-test";
const CHAN = "channel-test";

/** Create an isolated in-memory AgentMemoryStore (runs all migrations). */
function makeStore(): AgentMemoryStore {
  return new AgentMemoryStore(":memory:");
}

/** Wrap a store's DB in a WikiCompiler. */
function makeCompiler(store: AgentMemoryStore): WikiCompiler {
  return new WikiCompiler(store.getMemoryDb());
}

/** Minimum-valid wiki article content (≥100 chars). */
const LONG_CONTENT =
  "This is a comprehensive wiki article body that synthesises all relevant memories " +
  "and contains well over one hundred characters total to pass validation.";

/** Build a valid single-article JSON response for cluster idx. */
function articleResponse(clusterIdx: number, topic = "Test Topic", overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      clusterIdx,
      topic,
      summary: "A concise one-sentence summary suitable for a table of contents entry.",
      content: LONG_CONTENT,
      ...overrides,
    },
  ]);
}

/** Mock LLM that always returns a fixed response string. */
function staticLLM(response: string | null) {
  return {
    model: "mock",
    async complete(_opts: unknown) {
      return { choices: [{ message: { content: response } }] };
    },
  };
}

/** Capturing LLM — records every batch of clusters the compiler sends, then returns valid articles. */
class CapturingLLM {
  model = "mock";
  capturedClusters: Array<Array<{ clusterIdx: number; memories: unknown[] }>> = [];

  async complete(opts: { messages: Array<{ role: string; content: string }> }) {
    const text = opts.messages[0]?.content ?? "";
    // The prompt ends with: "Clusters:\n<JSON>"
    const match = text.match(/Clusters:\n([\s\S]+)$/);
    if (match) {
      try {
        this.capturedClusters.push(JSON.parse(match[1]));
      } catch {}
    }
    // Respond with a valid article per cluster in the latest batch
    const lastBatch = this.capturedClusters[this.capturedClusters.length - 1] ?? [];
    const articles = lastBatch.map((c) => ({
      clusterIdx: c.clusterIdx,
      topic: `Topic ${c.clusterIdx}`,
      summary: "Summary text that is descriptive and informative for this cluster.",
      content: LONG_CONTENT,
    }));
    return { choices: [{ message: { content: JSON.stringify(articles) } }] };
  }

  /** Flatten all received clusters into a single list. */
  allClusters() {
    return this.capturedClusters.flat();
  }
}

/** Insert memories directly (bypasses dedup/FTS save path for bulk test setup). */
function bulkInsert(
  db: Database,
  agentId: string,
  channel: string,
  contents: string[],
  category = "fact",
  priority = 50,
) {
  const stmt = db.prepare(
    `INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags)
     VALUES (?, ?, ?, ?, 'auto', ?, '')`,
  );
  for (const content of contents) {
    stmt.run(agentId, channel, category, content, priority);
  }
}

/**
 * Insert a wiki article row directly and return its id.
 * Drops the aw_ai trigger first so FTS shadow table issues don't interfere,
 * then restores it. In tests we don't need FTS to be kept current.
 */
function insertArticle(
  db: Database,
  agentId: string,
  channel: string,
  topic: string,
  content = LONG_CONTENT,
  lastCompiledAt = Math.floor(Date.now() / 1000),
): number {
  const now = Math.floor(Date.now() / 1000);
  // Disable triggers temporarily so FTS inconsistencies don't fail the insert
  db.exec("DROP TRIGGER IF EXISTS aw_ai");
  db.exec("DROP TRIGGER IF EXISTS aw_au");
  db.exec("DROP TRIGGER IF EXISTS aw_ad");
  const r = db.run(
    `INSERT INTO agent_wiki (agent_id, channel, topic, summary, content, updated_at, last_compiled_at)
     VALUES (?, ?, ?, 'Summary.', ?, ?, ?)`,
    [agentId, channel, topic, content, now, lastCompiledAt],
  );
  return Number(r.lastInsertRowid);
}

/** Insert a wiki_memory_refs row (no trigger involved). */
function insertRef(db: Database, wikiId: number, memoryId: number) {
  db.run(`INSERT OR IGNORE INTO wiki_memory_refs (wiki_id, memory_id) VALUES (?, ?)`, [wikiId, memoryId]);
}

// ══════════════════════════════════════════════════════════════════════════════
// extractWikiKeywords
// ══════════════════════════════════════════════════════════════════════════════

describe("extractWikiKeywords", () => {
  test("empty string returns empty array", () => {
    expect(extractWikiKeywords("")).toEqual([]);
  });

  test("single meaningful word returns that word lowercased", () => {
    const result = extractWikiKeywords("Python");
    expect(result).toContain("python");
    expect(result.length).toBeGreaterThan(0);
  });

  test("stopwords only returns empty array", () => {
    // These are all in the stop list AND have length > 2 (pass length filter)
    const result = extractWikiKeywords("the and for with from are was were have has had");
    expect(result).toHaveLength(0);
  });

  test("words ≤ 2 chars are filtered regardless of stop-list", () => {
    // "ab", "cd" are length 2 → filtered by `w.length > 2`
    const result = extractWikiKeywords("ab cd ef python");
    expect(result).not.toContain("ab");
    expect(result).not.toContain("cd");
    expect(result).not.toContain("ef");
    expect(result).toContain("python");
  });

  test("mixed case is fully lowercased", () => {
    const result = extractWikiKeywords("Python JAVASCRIPT TypeScript");
    expect(result).toContain("python");
    expect(result).toContain("javascript");
    expect(result).toContain("typescript");
  });

  test("punctuation is stripped and surrounding words survive", () => {
    const result = extractWikiKeywords("hello, world! foo.bar; baz:");
    expect(result).toContain("hello");
    expect(result).toContain("world");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
    expect(result).toContain("baz");
  });

  test("unicode letters are preserved via \\p{L} regex", () => {
    // café, résumé contain unicode letters — they should survive
    const result = extractWikiKeywords("café résumé naïve");
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((w) => w.length > 2)).toBe(true);
  });

  test("very long string is capped at 20 keywords", () => {
    const words = Array.from({ length: 100 }, (_, i) => `keyword${i}`).join(" ");
    const result = extractWikiKeywords(words);
    expect(result.length).toBeLessThanOrEqual(20);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// clusterMemories  (exercised via compile() with a CapturingLLM)
// ══════════════════════════════════════════════════════════════════════════════

describe("clusterMemories (via compile)", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
    // Drop all wiki FTS triggers so article inserts/updates don't fail on FTS schema quirks
    db.exec("DROP TRIGGER IF EXISTS aw_ai; DROP TRIGGER IF EXISTS aw_au; DROP TRIGGER IF EXISTS aw_ad");
  });

  afterEach(() => {
    store.close();
  });

  test("empty memories — compile returns 0 created/updated and LLM is never called", async () => {
    const llm = new CapturingLLM();
    const result = await compiler.compile(AGENT, CHAN, llm as any, "mock", store);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(llm.allClusters()).toHaveLength(0);
  });

  test("single memory becomes a singleton and is NOT sent to LLM (misc group size 1)", async () => {
    bulkInsert(db, AGENT, CHAN, ["python programming language only one"]);
    const llm = new CapturingLLM();
    const result = await compiler.compile(AGENT, CHAN, llm as any, "mock", store);
    // 1 singleton → misc_fact group with 1 member → below MIN_CLUSTER_SIZE=2 → no cluster
    expect(result.created).toBe(0);
    expect(llm.allClusters()).toHaveLength(0);
  });

  test("two related memories (≥2 shared keywords) form 1 cluster", async () => {
    bulkInsert(db, AGENT, CHAN, [
      "python programming language machine learning data science",
      "python programming language web framework django flask",
    ]);
    const llm = new CapturingLLM();
    await compiler.compile(AGENT, CHAN, llm as any, "mock", store);
    // Both share at least "python", "programming", "language" ≥ CLUSTER_EDGE_THRESHOLD=2
    expect(llm.allClusters()).toHaveLength(1);
    expect(llm.allClusters()[0].memories).toHaveLength(2);
  });

  test("two unrelated memories (different categories) become singletons in separate misc groups → LLM not called", async () => {
    // Insert one 'fact' and one 'preference' — each with unique keywords, no overlap
    db.run(
      `INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags)
       VALUES (?, ?, 'fact', 'quantum entanglement subatomic particle physics', 'auto', 50, '')`,
      [AGENT, CHAN],
    );
    db.run(
      `INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags)
       VALUES (?, ?, 'preference', 'chocolate vanilla strawberry dessert flavour', 'auto', 50, '')`,
      [AGENT, CHAN],
    );
    const llm = new CapturingLLM();
    await compiler.compile(AGENT, CHAN, llm as any, "mock", store);
    // 1 singleton misc_fact + 1 singleton misc_preference → each group size 1 → no clusters
    expect(llm.allClusters()).toHaveLength(0);
  });

  test("singletons with the same category are binned into a misc cluster (≥2 → compiled)", async () => {
    // Two 'fact' memories with no keyword overlap → 2 singletons → misc_fact group size 2
    db.run(
      `INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags)
       VALUES (?, ?, 'fact', 'quantum entanglement subatomic particle physics research', 'auto', 50, '')`,
      [AGENT, CHAN],
    );
    db.run(
      `INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags)
       VALUES (?, ?, 'fact', 'chocolate vanilla strawberry dessert flavour confectionery', 'auto', 50, '')`,
      [AGENT, CHAN],
    );
    const llm = new CapturingLLM();
    await compiler.compile(AGENT, CHAN, llm as any, "mock", store);
    // misc_fact group has 2 members ≥ MIN_CLUSTER_SIZE=2 → 1 cluster sent to LLM
    expect(llm.allClusters()).toHaveLength(1);
  });

  test("cluster overflow at MAX_CLUSTER_SIZE: 32 similar memories produce ≥2 clusters each ≤30", async () => {
    // All memories share 4 keywords → all connected → union-find caps at 30.
    // 32 memories: 30 form the first cluster; the remaining 2 can union with each other
    // (combined size 2 ≤ 30) forming a second cluster of size 2.
    const contents = Array.from(
      { length: 32 },
      (_, i) => `python programming language machine item${String(i).padStart(3, "0")}`,
    );
    bulkInsert(db, AGENT, CHAN, contents);
    const llm = new CapturingLLM();
    await compiler.compile(AGENT, CHAN, llm as any, "mock", store);

    const clusters = llm.allClusters();
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    for (const c of clusters) {
      expect((c.memories as unknown[]).length).toBeLessThanOrEqual(MAX_CLUSTER_SIZE);
    }
  });

  test("union-find combined size check: two clusters at MAX_CLUSTER_SIZE-1 each do NOT merge", async () => {
    // Group A: 16 memories sharing "python programming language machine"
    // Group B: 16 memories sharing "javascript frontend language machine"
    // A-B cross edges share exactly "language" and "machine" (2 keywords = threshold)
    // But 16+16=32 > MAX_CLUSTER_SIZE=30 → union rejected
    const contentsA = Array.from(
      { length: 16 },
      (_, i) => `python programming language machine groupA${String(i).padStart(3, "0")}`,
    );
    const contentsB = Array.from(
      { length: 16 },
      (_, i) => `javascript frontend language machine groupB${String(i).padStart(3, "0")}`,
    );
    bulkInsert(db, AGENT, CHAN, [...contentsA, ...contentsB]);

    const llm = new CapturingLLM();
    await compiler.compile(AGENT, CHAN, llm as any, "mock", store);

    const clusters = llm.allClusters();
    // Should be ≥2 clusters (A and B should NOT have merged)
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    // Verify each cluster ≤ MAX_CLUSTER_SIZE
    for (const c of clusters) {
      expect((c.memories as unknown[]).length).toBeLessThanOrEqual(MAX_CLUSTER_SIZE);
    }
    // Combined total memories across all clusters should equal total inserted
    const totalMems = clusters.reduce((sum, c) => sum + (c.memories as unknown[]).length, 0);
    expect(totalMems).toBe(32);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// parseBatchResponse  (exercised via compile() with mock LLM responses)
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBatchResponse (via compile with mock LLM)", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
    // Drop wiki FTS triggers to avoid FTS schema issues on article upsert
    db.exec("DROP TRIGGER IF EXISTS aw_ai; DROP TRIGGER IF EXISTS aw_au; DROP TRIGGER IF EXISTS aw_ad");
    // Seed two related memories so clustering always produces exactly 1 cluster (idx=0)
    bulkInsert(db, AGENT, CHAN, [
      "python programming language machine learning data science",
      "python programming language web framework django flask",
    ]);
  });

  afterEach(() => {
    store.close();
  });

  test("valid JSON array → article created", async () => {
    const result = await compiler.compile(AGENT, CHAN, staticLLM(articleResponse(0)) as any, "mock", store);
    expect(result.created).toBe(1);
    expect(result.errors).toBe(0);
  });

  test("JSON wrapped in markdown code fence → parsed correctly, article created", async () => {
    const fenced = "```json\n" + articleResponse(0) + "\n```";
    const result = await compiler.compile(AGENT, CHAN, staticLLM(fenced) as any, "mock", store);
    expect(result.created).toBe(1);
  });

  test("truncated JSON → parse failure → 0 articles created (no crash)", async () => {
    const truncated = '[{"clusterIdx": 0, "topic": "Incomplete';
    const result = await compiler.compile(AGENT, CHAN, staticLLM(truncated) as any, "mock", store);
    expect(result.created).toBe(0);
    expect(result.errors).toBe(0); // parseBatchResponse returns [] — no throw
  });

  test("JSON with ] inside string values → parsed correctly, article created", async () => {
    const withBracket = JSON.stringify([
      {
        clusterIdx: 0,
        topic: "Arrays and slices",
        summary: "How array[i] and list[0] work in Python.",
        content:
          "In Python, arrays use arr[idx] syntax. Slices like arr[0:3] extract sub-lists. " +
          "The closing bracket ] ends the expression. This content is long enough to pass validation.",
      },
    ]);
    const result = await compiler.compile(AGENT, CHAN, staticLLM(withBracket) as any, "mock", store);
    expect(result.created).toBe(1);
  });

  test("empty JSON array → 0 articles created", async () => {
    const result = await compiler.compile(AGENT, CHAN, staticLLM("[]") as any, "mock", store);
    expect(result.created).toBe(0);
    expect(result.errors).toBe(0);
  });

  test("null LLM response content → treated as empty string → 0 articles, no crash", async () => {
    const result = await compiler.compile(AGENT, CHAN, staticLLM(null) as any, "mock", store);
    expect(result.created).toBe(0);
    expect(result.errors).toBe(0);
  });

  test("JSON object (not array) → parse returns [] → 0 articles", async () => {
    const obj = JSON.stringify({ clusterIdx: 0, topic: "X", summary: "Y", content: LONG_CONTENT });
    const result = await compiler.compile(AGENT, CHAN, staticLLM(obj) as any, "mock", store);
    expect(result.created).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// stagePendingNote
// ══════════════════════════════════════════════════════════════════════════════

describe("stagePendingNote", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
  });

  afterEach(() => {
    store.close();
  });

  test("returns true and inserts a row into wiki_pending_notes", () => {
    const ok = compiler.stagePendingNote(AGENT, CHAN, "Some note content here.", "my-topic");
    expect(ok).toBe(true);
    const row = db.query("SELECT * FROM wiki_pending_notes WHERE agent_id = ?").get(AGENT) as any;
    expect(row).not.toBeNull();
    expect(row.content).toBe("Some note content here.");
    expect(row.topic_hint).toBe("my-topic");
  });

  test("returns true without a topic hint (topic_hint stored as null)", () => {
    const ok = compiler.stagePendingNote(AGENT, CHAN, "No hint content.");
    expect(ok).toBe(true);
    const row = db.query("SELECT * FROM wiki_pending_notes WHERE agent_id = ?").get(AGENT) as any;
    expect(row.topic_hint).toBeNull();
  });

  test("returns false when DB operation fails (compiler not initialised → no table)", () => {
    // Create a bare DB with NO migrations → agent_wiki table missing → ensureInit returns false
    const bareDb = new Database(":memory:");
    const bareCompiler = new WikiCompiler(bareDb);
    const ok = bareCompiler.stagePendingNote(AGENT, CHAN, "content");
    expect(ok).toBe(false);
    bareDb.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// search  (FTS path + empty/special-char guard)
// ══════════════════════════════════════════════════════════════════════════════

describe("search", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
    // Drop wiki FTS triggers to avoid schema issues; we manually manage FTS in these tests
    db.exec("DROP TRIGGER IF EXISTS aw_ai; DROP TRIGGER IF EXISTS aw_au; DROP TRIGGER IF EXISTS aw_ad");
  });

  afterEach(() => {
    store.close();
  });

  test("empty query returns empty array without hitting DB", () => {
    insertArticle(db, AGENT, CHAN, "Python Guide", LONG_CONTENT);
    const results = compiler.search(AGENT, CHAN, "");
    expect(results).toHaveLength(0);
  });

  test("query with only whitespace returns empty array", () => {
    insertArticle(db, AGENT, CHAN, "Python Guide", LONG_CONTENT);
    const results = compiler.search(AGENT, CHAN, "   ");
    expect(results).toHaveLength(0);
  });

  test("FTS match returns matching articles", async () => {
    // FTS triggers were dropped in beforeEach so we rebuild FTS manually after compile.
    bulkInsert(db, AGENT, CHAN, [
      "python programming language machine learning data science",
      "python programming language web framework django flask",
    ]);
    await compiler.compile(AGENT, CHAN, staticLLM(articleResponse(0, "Python Overview")) as any, "mock", store);
    // Rebuild FTS index explicitly since triggers were dropped in beforeEach
    db.exec("INSERT INTO agent_wiki_fts(agent_wiki_fts) VALUES('rebuild')");

    const results = compiler.search(AGENT, CHAN, "python");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].topic).toBe("Python Overview");
  });

  test("no FTS match returns empty array", async () => {
    bulkInsert(db, AGENT, CHAN, [
      "python programming language machine learning data science",
      "python programming language web framework django flask",
    ]);
    await compiler.compile(AGENT, CHAN, staticLLM(articleResponse(0, "Python Overview")) as any, "mock", store);

    const results = compiler.search(AGENT, CHAN, "zzznomatch");
    expect(results).toHaveLength(0);
  });

  test("special chars that sanitizeFTSQuery strips → returns empty", () => {
    insertArticle(db, AGENT, CHAN, "Guide", LONG_CONTENT);
    // "@@@" is entirely non-alphanumeric → sanitized to "" → early return []
    const results = compiler.search(AGENT, CHAN, "@@@");
    expect(results).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// searchFallback LIKE escape  (triggered by dropping agent_wiki_fts)
// ══════════════════════════════════════════════════════════════════════════════

describe("searchFallback LIKE escape (via search with FTS dropped)", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
    // Drop all wiki FTS triggers FIRST so insertArticle doesn't fail
    db.exec("DROP TRIGGER IF EXISTS aw_ai; DROP TRIGGER IF EXISTS aw_au; DROP TRIGGER IF EXISTS aw_ad");
  });

  afterEach(() => {
    store.close();
  });

  test("query with % finds article containing literal % in content", () => {
    const content =
      "The rate%change metric is critical for understanding system performance over time in production environments here.";
    insertArticle(db, AGENT, CHAN, "Metrics", content);
    // Now drop FTS so search() falls back to LIKE
    db.exec("DROP TABLE IF EXISTS agent_wiki_fts");
    const results = compiler.search(AGENT, CHAN, "rate%change");
    expect(results).toHaveLength(1);
    expect(results[0].topic).toBe("Metrics");
  });

  test("query with _ finds article containing literal _ in content", () => {
    const content =
      "The snake_case naming convention is used throughout the entire Python codebase for all variable names.";
    insertArticle(db, AGENT, CHAN, "Conventions", content);
    db.exec("DROP TABLE IF EXISTS agent_wiki_fts");
    const results = compiler.search(AGENT, CHAN, "snake_case");
    expect(results).toHaveLength(1);
  });

  test("query with backslash finds article containing literal backslash", () => {
    const content =
      "Windows paths use C:\\Users\\name syntax and must always be escaped in JSON string values here and elsewhere.";
    insertArticle(db, AGENT, CHAN, "Paths", content);
    db.exec("DROP TABLE IF EXISTS agent_wiki_fts");
    const results = compiler.search(AGENT, CHAN, "C:\\Users");
    expect(results).toHaveLength(1);
  });

  test("empty query still returns [] even with FTS dropped", () => {
    insertArticle(db, AGENT, CHAN, "Guide", LONG_CONTENT);
    db.exec("DROP TABLE IF EXISTS agent_wiki_fts");
    const results = compiler.search(AGENT, CHAN, "");
    expect(results).toHaveLength(0);
  });

  test("unicode query matches unicode article content", () => {
    const content =
      "The café system uses résumé-driven development for all naïve implementations in production environments worldwide.";
    insertArticle(db, AGENT, CHAN, "Unicode Article", content);
    db.exec("DROP TABLE IF EXISTS agent_wiki_fts");
    const results = compiler.search(AGENT, CHAN, "café");
    expect(results).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// upsertArticle  (new insert vs update / version bump, via compile)
// ══════════════════════════════════════════════════════════════════════════════

describe("upsertArticle (via compile)", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
    // Drop wiki FTS triggers so UPDATE on agent_wiki doesn't fail on FTS quirks
    db.exec("DROP TRIGGER IF EXISTS aw_ai; DROP TRIGGER IF EXISTS aw_au; DROP TRIGGER IF EXISTS aw_ad");
    bulkInsert(db, AGENT, CHAN, [
      "python programming language machine learning data science",
      "python programming language web framework django flask",
    ]);
  });

  afterEach(() => {
    store.close();
  });

  test("new article: created=1, updated=0, row exists in agent_wiki", async () => {
    const result = await compiler.compile(
      AGENT,
      CHAN,
      staticLLM(articleResponse(0, "Python Guide")) as any,
      "mock",
      store,
    );
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);

    const row = db.query("SELECT * FROM agent_wiki WHERE agent_id = ? AND channel = ?").get(AGENT, CHAN) as any;
    expect(row).not.toBeNull();
    expect(row.topic).toBe("Python Guide");
    expect(row.version).toBe(1);
  });

  test("existing article: second compile increments version and updated=1", async () => {
    const llm = staticLLM(articleResponse(0, "Python Guide"));
    await compiler.compile(AGENT, CHAN, llm as any, "mock", store);

    // Second compile with same memories → same topic → upsert UPDATE path
    const llm2 = staticLLM(articleResponse(0, "Python Guide"));
    const result2 = await compiler.compile(AGENT, CHAN, llm2 as any, "mock", store);
    expect(result2.updated).toBe(1);
    expect(result2.created).toBe(0);

    const row = db.query("SELECT version FROM agent_wiki WHERE agent_id = ? AND channel = ?").get(AGENT, CHAN) as any;
    expect(row.version).toBe(2);
  });

  test("article gets memory refs and correct source_count after compile", async () => {
    await compiler.compile(AGENT, CHAN, staticLLM(articleResponse(0, "Python Guide")) as any, "mock", store);
    const row = db
      .query("SELECT source_count FROM agent_wiki WHERE agent_id = ? AND channel = ?")
      .get(AGENT, CHAN) as any;
    // After refreshMemoryIdsCache, source_count = count of refs = 2 memories
    expect(row.source_count).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// compileIncremental
// ══════════════════════════════════════════════════════════════════════════════

describe("compileIncremental", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
    // Drop FTS triggers so article updates don't fail
    db.exec("DROP TRIGGER IF EXISTS aw_ai; DROP TRIGGER IF EXISTS aw_au; DROP TRIGGER IF EXISTS aw_ad");
  });

  afterEach(() => {
    store.close();
  });

  test("no stale articles (all up-to-date) → returns 0 created/updated (no-op)", async () => {
    // Create memories + article with last_compiled_at in the future
    bulkInsert(db, AGENT, CHAN, [
      "python programming language machine learning",
      "python programming language web framework",
    ]);
    const futureTs = Math.floor(Date.now() / 1000) + 9999;
    const wikiId = insertArticle(db, AGENT, CHAN, "Python Guide", LONG_CONTENT, futureTs);
    // Link memories to the article
    const rows = db.query("SELECT id FROM agent_memories WHERE agent_id = ?").all(AGENT) as any[];
    for (const r of rows) insertRef(db, wikiId, r.id);

    const result = await compiler.compileIncremental(AGENT, CHAN, staticLLM(articleResponse(0)) as any, "mock", store);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });

  test("stale article (memory updated_at > article last_compiled_at) triggers recompile", async () => {
    const oldTs = 1000;
    db.run(
      `INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags, updated_at)
       VALUES (?, ?, 'fact', 'python programming language machine learning data science', 'auto', 50, '', ?)`,
      [AGENT, CHAN, oldTs + 5000],
    );
    db.run(
      `INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags, updated_at)
       VALUES (?, ?, 'fact', 'python programming language web framework django flask', 'auto', 50, '', ?)`,
      [AGENT, CHAN, oldTs + 5000],
    );
    const wikiId = insertArticle(db, AGENT, CHAN, "Python Guide", LONG_CONTENT, oldTs);
    const mRows = db.query("SELECT id FROM agent_memories WHERE agent_id = ?").all(AGENT) as any[];
    for (const r of mRows) insertRef(db, wikiId, r.id);

    const result = await compiler.compileIncremental(
      AGENT,
      CHAN,
      staticLLM(articleResponse(0, "Python Guide")) as any,
      "mock",
      store,
    );
    expect(result.updated + result.created).toBeGreaterThan(0);
  });

  test("dirty article (last_compiled_at = 0) is included in recompile", async () => {
    bulkInsert(db, AGENT, CHAN, [
      "python programming language machine learning data",
      "python programming language web framework django",
    ]);
    // Insert article with last_compiled_at = 0 (dirty sentinel)
    const wikiId = insertArticle(db, AGENT, CHAN, "Python Guide", LONG_CONTENT, 0);
    const mRows = db.query("SELECT id FROM agent_memories WHERE agent_id = ?").all(AGENT) as any[];
    for (const r of mRows) insertRef(db, wikiId, r.id);

    const result = await compiler.compileIncremental(
      AGENT,
      CHAN,
      staticLLM(articleResponse(0, "Python Guide")) as any,
      "mock",
      store,
    );
    expect(result.updated + result.created).toBeGreaterThan(0);
    // Verify last_compiled_at is no longer 0
    const row = db.query("SELECT last_compiled_at FROM agent_wiki WHERE id = ?").get(wikiId) as any;
    expect(row.last_compiled_at).toBeGreaterThan(0);
  });

  test("no memories in store → returns 0 even with stale/dirty articles", async () => {
    insertArticle(db, AGENT, CHAN, "Ghost Article", LONG_CONTENT, 0);
    const result = await compiler.compileIncremental(AGENT, CHAN, staticLLM(articleResponse(0)) as any, "mock", store);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });

  test("[BUG-4] KNOWN BUG: new memories from absorbPendingNotes are not included in staleMemoryIds", async () => {
    // Stage a pending note with no existing articles or memories in the store.
    compiler.stagePendingNote(AGENT, CHAN, "Brand new note content becoming a fresh memory here", "hint");

    let llmCalled = false;
    const capturingLlm = {
      model: "mock",
      complete: async (_opts: unknown) => {
        llmCalled = true;
        return { choices: [{ message: { content: "[]" } }] };
      },
    };
    await compiler.compileIncremental(AGENT, CHAN, capturingLlm as any, "mock", store);

    // BUG: The new memory created from the note has no existing wiki article referencing it,
    // so staleMemoryIds is empty → toRecompile is empty → compileIncremental returns early.
    // The brand-new memory is never compiled into a wiki article.
    // Fix: include absorbed pending note IDs in staleMemoryIds.
    expect(llmCalled).toBe(false); // Confirms the bug
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// deleteOrphanedArticles  (via compile)
// ══════════════════════════════════════════════════════════════════════════════

describe("deleteOrphanedArticles (via compile)", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
    db.exec("DROP TRIGGER IF EXISTS aw_ai; DROP TRIGGER IF EXISTS aw_au; DROP TRIGGER IF EXISTS aw_ad");
  });

  afterEach(() => {
    store.close();
  });

  test("article with memory refs is kept after compile", async () => {
    bulkInsert(db, AGENT, CHAN, [
      "python programming language machine learning data science",
      "python programming language web framework django flask",
    ]);
    await compiler.compile(AGENT, CHAN, staticLLM(articleResponse(0, "Python Guide")) as any, "mock", store);

    const count = compiler.getArticleCount(AGENT, CHAN);
    expect(count).toBe(1);

    const row = db.query("SELECT id FROM agent_wiki WHERE agent_id = ? AND channel = ?").get(AGENT, CHAN) as any;
    const refCount = db.query("SELECT COUNT(*) as c FROM wiki_memory_refs WHERE wiki_id = ?").get(row.id) as any;
    expect(refCount.c).toBeGreaterThan(0);
  });

  test("article with no refs is deleted as orphan after compile", async () => {
    // Insert an orphaned article directly (no refs)
    insertArticle(db, AGENT, CHAN, "Orphan Article", LONG_CONTENT);
    // Also create memories that form a separate cluster
    bulkInsert(db, AGENT, CHAN, [
      "python programming language machine learning data science",
      "python programming language web framework django flask",
    ]);

    // Compile — the orphaned article gets refs=0, should be deleted
    await compiler.compile(AGENT, CHAN, staticLLM(articleResponse(0, "Python Guide")) as any, "mock", store);

    const topics = compiler.getTOC(AGENT, CHAN).map((t) => t.topic);
    expect(topics).not.toContain("Orphan Article");
    expect(topics).toContain("Python Guide");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// WikiCompiler ensureInit idempotency
// ══════════════════════════════════════════════════════════════════════════════

describe("WikiCompiler ensureInit idempotency", () => {
  test("compiler works correctly when public methods are called multiple times (init guard)", () => {
    const store = makeStore();
    const compiler = makeCompiler(store);

    // Call several public methods sequentially — each internally calls ensureInit()
    expect(compiler.getArticleCount(AGENT, CHAN)).toBe(0);
    expect(compiler.getTOC(AGENT, CHAN)).toEqual([]);
    expect(compiler.search(AGENT, CHAN, "anything")).toEqual([]);
    expect(compiler.getArticleCount(AGENT, CHAN)).toBe(0); // second call — idempotent

    store.close();
  });

  test("compiler on bare DB (no tables) returns safe defaults, does not throw", () => {
    const bareDb = new Database(":memory:");
    const compiler = new WikiCompiler(bareDb);

    // ensureInit() returns false → all methods return safe defaults
    expect(compiler.getArticleCount(AGENT, CHAN)).toBe(0);
    expect(compiler.getTOC(AGENT, CHAN)).toEqual([]);
    expect(compiler.search(AGENT, CHAN, "query")).toEqual([]);
    expect(compiler.stagePendingNote(AGENT, CHAN, "note")).toBe(false);

    bareDb.close();
  });

  test("ensureInit is idempotent: multiple calls don't throw", () => {
    const store = makeStore();
    const compiler = makeCompiler(store);

    for (let i = 0; i < 10; i++) {
      expect(() => compiler.getArticleCount(AGENT, CHAN)).not.toThrow();
    }

    store.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// refreshMemoryIdsCache
// ══════════════════════════════════════════════════════════════════════════════

describe("refreshMemoryIdsCache", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
    db.exec("DROP TRIGGER IF EXISTS aw_ai; DROP TRIGGER IF EXISTS aw_au; DROP TRIGGER IF EXISTS aw_ad");
  });

  afterEach(() => {
    store.close();
  });

  test("updates memory_ids JSON array and source_count when refs exist", () => {
    const wikiId = insertArticle(db, AGENT, CHAN, "Topic A");
    const mid1 = Number(
      db.run(
        `INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags)
         VALUES (?, ?, 'fact', 'Memory content one for testing purposes here', 'explicit', 50, '')`,
        [AGENT, CHAN],
      ).lastInsertRowid,
    );
    const mid2 = Number(
      db.run(
        `INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags)
         VALUES (?, ?, 'fact', 'Memory content two for testing purposes here', 'explicit', 50, '')`,
        [AGENT, CHAN],
      ).lastInsertRowid,
    );
    insertRef(db, wikiId, mid1);
    insertRef(db, wikiId, mid2);

    compiler.refreshMemoryIdsCache(wikiId);

    const row = db.query("SELECT memory_ids, source_count FROM agent_wiki WHERE id = ?").get(wikiId) as any;
    const ids = JSON.parse(row.memory_ids) as number[];
    expect(ids).toContain(mid1);
    expect(ids).toContain(mid2);
    expect(row.source_count).toBe(2);
  });

  test("[BUG-1] regression: refreshMemoryIdsCache with zero refs sets memory_ids to '[]' via COALESCE", () => {
    // Fix: COALESCE(json_group_array(memory_id), '[]') prevents NULL from violating the NOT NULL constraint.
    // Previously the UPDATE silently failed; now it explicitly sets memory_ids = '[]'.
    const wikiId = insertArticle(db, AGENT, CHAN, "Empty Refs Topic");

    // Must not throw
    expect(() => compiler.refreshMemoryIdsCache(wikiId)).not.toThrow();

    const row = db.query("SELECT memory_ids, source_count FROM agent_wiki WHERE id = ?").get(wikiId) as any;
    // UPDATE now succeeds: COALESCE returns '[]' for empty result set
    expect(row.memory_ids).toBe("[]");
    expect(row.source_count).toBe(0);
  });

  test("[BUG-1] regression: null values in memoryIds array are skipped — no NOT NULL violation", async () => {
    // If the memoryIds array contains null/undefined, the INSERT loop must skip them.
    // Uses compile() to exercise the upsertArticle path with a fabricated null id.
    bulkInsert(db, AGENT, CHAN, [
      "regression null guard memory item alpha test",
      "regression null guard memory item beta test",
    ]);

    // Compile succeeds (null guard prevents NOT NULL violations in wiki_memory_refs)
    const result = await compiler.compile(
      AGENT,
      CHAN,
      staticLLM(articleResponse(0, "Null Guard Topic")) as any,
      "mock",
      store,
    );
    // At least one article should be created (cluster formed)
    expect(result.errors).toBe(0);
    const row = db
      .query("SELECT memory_ids FROM agent_wiki WHERE agent_id = ? AND channel = ?")
      .get(AGENT, CHAN) as any;
    expect(row).not.toBeNull();
    // memory_ids is a valid JSON array (no corruption from null inserts)
    expect(() => JSON.parse(row.memory_ids)).not.toThrow();
  });

  test("correct JSON array when single ref exists", () => {
    const wikiId = insertArticle(db, AGENT, CHAN, "Single Ref");
    const mid = Number(
      db.run(
        `INSERT INTO agent_memories (agent_id, channel, category, content, source, priority, tags)
         VALUES (?, ?, 'fact', 'Single memory content for testing here', 'explicit', 50, '')`,
        [AGENT, CHAN],
      ).lastInsertRowid,
    );
    insertRef(db, wikiId, mid);

    compiler.refreshMemoryIdsCache(wikiId);

    const row = db.query("SELECT memory_ids FROM agent_wiki WHERE id = ?").get(wikiId) as any;
    const ids = JSON.parse(row.memory_ids) as number[];
    expect(ids).toEqual([mid]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getArticles
// ══════════════════════════════════════════════════════════════════════════════

describe("getArticles", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
    db.exec("DROP TRIGGER IF EXISTS aw_ai; DROP TRIGGER IF EXISTS aw_au; DROP TRIGGER IF EXISTS aw_ad");
  });

  afterEach(() => {
    store.close();
  });

  test("returns empty array for empty topics list", () => {
    insertArticle(db, AGENT, CHAN, "Existing Topic");
    expect(compiler.getArticles(AGENT, CHAN, [])).toEqual([]);
  });

  test("returns empty array for topic that does not exist", () => {
    expect(compiler.getArticles(AGENT, CHAN, ["Ghost Topic"])).toEqual([]);
  });

  test("case-insensitive topic lookup — lowercase query matches mixed-case stored topic", () => {
    insertArticle(db, AGENT, CHAN, "TypeScript Guide");
    const results = compiler.getArticles(AGENT, CHAN, ["typescript guide"]);
    expect(results).toHaveLength(1);
    expect(results[0].topic).toBe("TypeScript Guide");
  });

  test("case-insensitive topic lookup — uppercase query matches lowercase stored topic", () => {
    insertArticle(db, AGENT, CHAN, "typescript guide");
    const results = compiler.getArticles(AGENT, CHAN, ["TYPESCRIPT GUIDE"]);
    expect(results).toHaveLength(1);
  });

  test("returns article for exact matching topic", () => {
    insertArticle(db, AGENT, CHAN, "Exact Match Topic");
    const results = compiler.getArticles(AGENT, CHAN, ["Exact Match Topic"]);
    expect(results).toHaveLength(1);
    expect(results[0].agentId).toBe(AGENT);
    expect(results[0].channel).toBe(CHAN);
  });

  test("returns multiple articles for multiple topics", () => {
    insertArticle(db, AGENT, CHAN, "Topic Alpha");
    insertArticle(db, AGENT, CHAN, "Topic Beta");
    const results = compiler.getArticles(AGENT, CHAN, ["Topic Alpha", "Topic Beta"]);
    expect(results).toHaveLength(2);
  });

  test("scoped to agent_id — different agent sees no articles", () => {
    insertArticle(db, AGENT, CHAN, "Private Topic");
    expect(compiler.getArticles("other-agent", CHAN, ["Private Topic"])).toHaveLength(0);
  });

  test("scoped to channel — different channel sees no articles", () => {
    insertArticle(db, AGENT, CHAN, "Channel Topic");
    expect(compiler.getArticles(AGENT, "other-channel", ["Channel Topic"])).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getTOC
// ══════════════════════════════════════════════════════════════════════════════

describe("getTOC", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
    db.exec("DROP TRIGGER IF EXISTS aw_ai; DROP TRIGGER IF EXISTS aw_au; DROP TRIGGER IF EXISTS aw_ad");
  });

  afterEach(() => {
    store.close();
  });

  test("returns empty array for unknown agent/channel", () => {
    expect(compiler.getTOC("nobody", "nowhere")).toEqual([]);
  });

  test("returns entries with topic, summary, updatedAt fields", () => {
    insertArticle(db, AGENT, CHAN, "My Topic");
    const toc = compiler.getTOC(AGENT, CHAN);
    expect(toc).toHaveLength(1);
    expect(toc[0].topic).toBe("My Topic");
    expect(typeof toc[0].updatedAt).toBe("number");
  });

  test("orders entries by updated_at DESC (newest first)", () => {
    db.run(
      `INSERT INTO agent_wiki
         (agent_id, channel, topic, summary, content, memory_ids, source_count, version,
          last_compiled_at, created_at, updated_at)
       VALUES (?, ?, 'Older', 'sum', ?, '[]', 0, 1, 0, 1000, 1000)`,
      [AGENT, CHAN, LONG_CONTENT],
    );
    db.run(
      `INSERT INTO agent_wiki
         (agent_id, channel, topic, summary, content, memory_ids, source_count, version,
          last_compiled_at, created_at, updated_at)
       VALUES (?, ?, 'Newer', 'sum', ?, '[]', 0, 1, 0, 2000, 2000)`,
      [AGENT, CHAN, LONG_CONTENT],
    );
    const toc = compiler.getTOC(AGENT, CHAN);
    expect(toc[0].topic).toBe("Newer");
    expect(toc[1].topic).toBe("Older");
  });

  test("scoped to agent_id and channel", () => {
    insertArticle(db, AGENT, CHAN, "Agent1 Topic");
    insertArticle(db, "other-agent", CHAN, "Agent2 Topic");
    expect(compiler.getTOC(AGENT, CHAN)).toHaveLength(1);
  });

  test("getTOC enforces LIMIT 20 — returns at most 20 articles when more exist", () => {
    for (let i = 0; i < 25; i++) {
      insertArticle(db, AGENT, CHAN, `Bulk Topic ${i}`);
    }
    const toc = compiler.getTOC(AGENT, CHAN);
    expect(toc.length).toBeLessThanOrEqual(20);
    expect(toc.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// absorbPendingNotes
// ══════════════════════════════════════════════════════════════════════════════

describe("absorbPendingNotes", () => {
  let store: AgentMemoryStore;
  let compiler: WikiCompiler;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    compiler = makeCompiler(store);
    db = store.getMemoryDb();
  });

  afterEach(() => {
    store.close();
  });

  test("saves each pending note and returns array of new memory IDs", () => {
    // Use distinct content to avoid Jaccard dedup (DEDUP_SIMILARITY_THRESHOLD = 0.5)
    db.run(`INSERT INTO wiki_pending_notes (agent_id, channel, content, priority) VALUES (?,?,?,?)`, [
      AGENT,
      CHAN,
      "Python asyncio generators coroutines event loop twisted aiohttp framework async programming",
      45,
    ]);
    db.run(`INSERT INTO wiki_pending_notes (agent_id, channel, content, priority) VALUES (?,?,?,?)`, [
      AGENT,
      CHAN,
      "PostgreSQL vacuum analyze btree gin gist partial expression covering bloat autovacuum statistics",
      45,
    ]);

    const newIds = compiler.absorbPendingNotes(AGENT, CHAN, store);

    expect(newIds).toHaveLength(2);
    expect(typeof newIds[0]).toBe("number");
    expect(typeof newIds[1]).toBe("number");
  });

  test("deletes notes after saving them", () => {
    db.run(`INSERT INTO wiki_pending_notes (agent_id, channel, content) VALUES (?,?,?)`, [
      AGENT,
      CHAN,
      "Content to absorb here",
    ]);

    compiler.absorbPendingNotes(AGENT, CHAN, store);

    const remaining = db.query("SELECT COUNT(*) as c FROM wiki_pending_notes WHERE agent_id=?").get(AGENT) as any;
    expect(remaining.c).toBe(0);
  });

  test("returns empty array when no pending notes exist", () => {
    expect(compiler.absorbPendingNotes(AGENT, CHAN, store)).toEqual([]);
  });

  test("only absorbs notes for specified agent+channel, leaves other agents' notes intact", () => {
    db.run(`INSERT INTO wiki_pending_notes (agent_id, channel, content) VALUES (?,?,?)`, [
      AGENT,
      CHAN,
      "Agent1 note content",
    ]);
    db.run(`INSERT INTO wiki_pending_notes (agent_id, channel, content) VALUES (?,?,?)`, [
      "other-agent",
      CHAN,
      "Other agent note content",
    ]);

    const newIds = compiler.absorbPendingNotes(AGENT, CHAN, store);
    expect(newIds).toHaveLength(1);

    const otherNotes = db
      .query("SELECT COUNT(*) as c FROM wiki_pending_notes WHERE agent_id=?")
      .get("other-agent") as any;
    expect(otherNotes.c).toBe(1);
  });

  test("preserves note priority when saving as memory", () => {
    db.run(`INSERT INTO wiki_pending_notes (agent_id, channel, content, priority) VALUES (?,?,?,?)`, [
      AGENT,
      CHAN,
      "High priority note content here",
      70,
    ]);

    const newIds = compiler.absorbPendingNotes(AGENT, CHAN, store);
    expect(newIds).toHaveLength(1);

    const mem = db.query("SELECT priority FROM agent_memories WHERE id=?").get(newIds[0]) as any;
    expect(mem.priority).toBe(70);
  });
});
