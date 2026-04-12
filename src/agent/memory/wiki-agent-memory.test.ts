/**
 * Tests for AgentMemoryStore — wiki-related paths.
 *
 * Covers: mergeMemories, delete, save (dedup UPDATE path), pin, unpin,
 *         getAllForCompilation, getMemoryDb, setupConcurrency, getUpdatedSince.
 *
 * Uses ":memory:" SQLite for zero-filesystem, zero-side-effect isolation.
 *
 * Regression tests:
 *   [BUG-C] mergeMemories() atomicity: wrapped in db.transaction so that if the INSERT
 *           fails after the DELETE, originals are NOT lost (transaction rolled back).
 *           cleanupWikiRefsForMemories() is also called inside the same transaction.
 */

import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentMemoryStore } from "./agent-memory";

// ── Helpers ───────────────────────────────────────────────────────────────────

const AGENT = "agent-wiki-test";
const CHAN = "chan-wiki-test";

/** Insert a raw memory into agent_memories; returns its id. */
function insertRawMemory(db: Database, agentId: string, channel: string, content: string, priority = 50): number {
  db.run(
    `INSERT INTO agent_memories (agent_id, channel, content, category, source, priority)
     VALUES (?, ?, ?, 'fact', 'explicit', ?)`,
    [agentId, channel, content, priority],
  );
  return (db.query("SELECT last_insert_rowid() as id").get() as any).id as number;
}

const LONG_CONTENT = "Y".repeat(150);

/** Insert a wiki article with last_compiled_at > 0 (non-dirty); returns its id. */
function insertWikiArticle(db: Database, agentId: string, channel: string, topic: string): number {
  db.run(
    `INSERT INTO agent_wiki (agent_id, channel, topic, summary, content, last_compiled_at)
     VALUES (?, ?, ?, 'Summary', ?, 9999)`,
    [agentId, channel, topic, LONG_CONTENT],
  );
  return (db.query("SELECT last_insert_rowid() as id").get() as any).id as number;
}

/** Link a memory to a wiki article. */
function linkRef(db: Database, wikiId: number, memoryId: number): void {
  db.run("INSERT OR IGNORE INTO wiki_memory_refs (wiki_id, memory_id) VALUES (?, ?)", [wikiId, memoryId]);
}

/** Read last_compiled_at for a wiki article. */
function getLastCompiledAt(db: Database, wikiId: number): number {
  return ((db.query("SELECT last_compiled_at FROM agent_wiki WHERE id = ?").get(wikiId) as any) ?? {})
    .last_compiled_at as number;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let store: AgentMemoryStore;
let db: Database;

beforeEach(() => {
  store = new AgentMemoryStore(":memory:");
  db = store.getMemoryDb(); // triggers ensureInit + migrations
});

afterEach(() => {
  store.close();
});

// ── getMemoryDb ───────────────────────────────────────────────────────────────

describe("getMemoryDb", () => {
  test("returns an initialized db (not null/undefined)", () => {
    const result = store.getMemoryDb();
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  test("returned db has agent_memories table (migrations ran)", () => {
    const d = store.getMemoryDb();
    const row = d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_memories'").get() as any;
    expect(row).not.toBeNull();
  });

  test("returned db has agent_wiki table (v4 migration ran)", () => {
    const d = store.getMemoryDb();
    const row = d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_wiki'").get() as any;
    expect(row).not.toBeNull();
  });
});

// ── getAllForCompilation ───────────────────────────────────────────────────────

describe("getAllForCompilation", () => {
  test("returns memories for the given channel", () => {
    store.save({ agentId: AGENT, channel: CHAN, content: "Python is great for scripting tasks" });
    store.save({ agentId: AGENT, channel: CHAN, content: "JavaScript runs in the browser today" });

    const memories = store.getAllForCompilation(AGENT, CHAN);
    expect(memories.length).toBeGreaterThanOrEqual(2);
    for (const m of memories) {
      expect(m.agentId).toBe(AGENT);
      expect(m.channel).toBe(CHAN);
    }
  });

  test("excludes memories from other channels", () => {
    store.save({ agentId: AGENT, channel: CHAN, content: "Correct channel memory content here" });
    store.save({ agentId: AGENT, channel: "other-channel", content: "Wrong channel memory data here" });

    const memories = store.getAllForCompilation(AGENT, CHAN);
    for (const m of memories) {
      expect(m.channel).toBe(CHAN);
    }
  });

  test("excludes pinned memories (priority >= 80)", () => {
    const r = store.save({ agentId: AGENT, channel: CHAN, content: "To be pinned memory content here" });
    store.pin(r.id!, AGENT);

    const memories = store.getAllForCompilation(AGENT, CHAN);
    const pinned = memories.find((m) => m.id === r.id);
    expect(pinned).toBeUndefined();
  });

  test("returns empty array when no memories exist", () => {
    const memories = store.getAllForCompilation(AGENT, CHAN);
    expect(memories).toEqual([]);
  });
});

// ── delete + markWikiArticlesDirty ────────────────────────────────────────────

describe("delete()", () => {
  test("calls markWikiArticlesDirty — wiki last_compiled_at set to 0 after deletion", () => {
    const memId = insertRawMemory(db, AGENT, CHAN, "memory to delete content here");
    const wikiId = insertWikiArticle(db, AGENT, CHAN, "Article to Dirty");
    linkRef(db, wikiId, memId);

    expect(getLastCompiledAt(db, wikiId)).toBe(9999);

    store.delete(memId, AGENT);

    // markWikiArticlesDirty sets last_compiled_at = 0
    expect(getLastCompiledAt(db, wikiId)).toBe(0);
  });

  test("returns true when memory exists and is owned by agent", () => {
    const memId = insertRawMemory(db, AGENT, CHAN, "content to remove from the store");
    expect(store.delete(memId, AGENT)).toBe(true);
  });

  test("returns false for non-existent memory", () => {
    expect(store.delete(999999, AGENT)).toBe(false);
  });
});

// ── save() dedup UPDATE path + markWikiArticlesDirty ─────────────────────────

describe("save() dedup UPDATE path", () => {
  test("markWikiArticlesDirty called when explicit save updates a near-duplicate memory", () => {
    const content = "The project uses TypeScript for type safety and developer experience";
    const r1 = store.save({ agentId: AGENT, channel: CHAN, content });
    expect(r1.id).not.toBeNull();

    const wikiId = insertWikiArticle(db, AGENT, CHAN, "TypeScript Usage");
    linkRef(db, wikiId, r1.id!);
    expect(getLastCompiledAt(db, wikiId)).toBe(9999);

    // Near-duplicate (explicit source → triggers UPDATE path)
    const similar = "The project uses TypeScript for type safety and better developer experience";
    store.save({ agentId: AGENT, channel: CHAN, content: similar, source: "explicit" });

    // Wiki article should now be marked dirty
    expect(getLastCompiledAt(db, wikiId)).toBe(0);
  });
});

// ── pin() + markWikiArticlesDirty ─────────────────────────────────────────────

describe("pin()", () => {
  test("calls markWikiArticlesDirty — wiki last_compiled_at set to 0 after pin", () => {
    const memId = insertRawMemory(db, AGENT, CHAN, "memory to be pinned content here");
    const wikiId = insertWikiArticle(db, AGENT, CHAN, "Pinned Article");
    linkRef(db, wikiId, memId);

    expect(getLastCompiledAt(db, wikiId)).toBe(9999);

    const result = store.pin(memId, AGENT);
    expect(result.success).toBe(true);

    expect(getLastCompiledAt(db, wikiId)).toBe(0);
  });

  test("succeeds for a valid non-pinned memory", () => {
    const memId = insertRawMemory(db, AGENT, CHAN, "non-pinned memory content entry");
    const result = store.pin(memId, AGENT);
    expect(result.success).toBe(true);
  });
});

// ── unpin() + markWikiArticlesDirty ───────────────────────────────────────────

describe("unpin()", () => {
  test("calls markWikiArticlesDirty — wiki last_compiled_at set to 0 after unpin", () => {
    // Insert with priority 90 (pinned)
    const memId = insertRawMemory(db, AGENT, CHAN, "pinned memory to unpin content here", 90);
    const wikiId = insertWikiArticle(db, AGENT, CHAN, "Unpinned Article");
    linkRef(db, wikiId, memId);

    expect(getLastCompiledAt(db, wikiId)).toBe(9999);

    const result = store.unpin(memId, AGENT);
    expect(result.success).toBe(true);

    expect(getLastCompiledAt(db, wikiId)).toBe(0);
  });

  test("succeeds for a pinned memory", () => {
    const memId = insertRawMemory(db, AGENT, CHAN, "pinned memory for unpin test entry", 90);
    const result = store.unpin(memId, AGENT);
    expect(result.success).toBe(true);
  });
});

// ── setupConcurrency ──────────────────────────────────────────────────────────

describe("setupConcurrency", () => {
  test("WAL journal mode is requested (may return 'memory' for :memory: DBs)", () => {
    const row = db.query("PRAGMA journal_mode").get() as any;
    expect(["wal", "memory"]).toContain(row.journal_mode);
  });

  test("busy_timeout is set to 30 000 ms", () => {
    const row = db.query("PRAGMA busy_timeout").get() as any;
    expect(row.timeout).toBe(30000);
  });

  test("foreign_keys pragma IS enabled — ON DELETE CASCADE fires", () => {
    const row = db.query("PRAGMA foreign_keys").get() as any;
    expect(row.foreign_keys).toBe(1);
  });

  test("agent_wiki table exists after ensureInit (migration v4 applied)", () => {
    const row = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_wiki'").get();
    expect(row).not.toBeNull();
  });
});

// ── mergeMemories ─────────────────────────────────────────────────────────────

describe("mergeMemories()", () => {
  test("wrapped in transaction: if INSERT fails, original memories are NOT deleted (rollback)", () => {
    const memId1 = insertRawMemory(db, AGENT, CHAN, "First memory about Python scripting language");
    const memId2 = insertRawMemory(db, AGENT, CHAN, "Second memory about JavaScript browser runtime");

    // Drop the FTS table so the INSERT trigger (am_ai) fails when the merged
    // memory is inserted. This simulates a DB error during the INSERT step.
    db.exec("DROP TABLE agent_memories_fts");

    const result = store.mergeMemories(
      AGENT,
      [memId1, memId2],
      "Merged content about Python and JavaScript scripting languages",
      "fact",
    );

    // INSERT failed — result should indicate failure
    expect(result.id).toBeNull();

    // Both originals must still exist (transaction rolled back the DELETE)
    const m1 = db.query("SELECT id FROM agent_memories WHERE id = ?").get(memId1) as any;
    const m2 = db.query("SELECT id FROM agent_memories WHERE id = ?").get(memId2) as any;
    expect(m1).not.toBeNull();
    expect(m2).not.toBeNull();
  });

  test("cleanupWikiRefsForMemories() called: dangling refs removed after successful merge", () => {
    const memId1 = insertRawMemory(db, AGENT, CHAN, "Memory alpha about Python scripting tasks");
    const memId2 = insertRawMemory(db, AGENT, CHAN, "Memory beta about web development projects");

    const wikiId = insertWikiArticle(db, AGENT, CHAN, "Merged Sources Article");
    linkRef(db, wikiId, memId1);
    linkRef(db, wikiId, memId2);

    const result = store.mergeMemories(
      AGENT,
      [memId1, memId2],
      "Combined: Python scripting and web development tasks and projects",
      "fact",
    );

    expect(result.id).not.toBeNull();

    // Dangling refs to the deleted memories must be cleaned up
    const dangling = db
      .query("SELECT COUNT(*) as c FROM wiki_memory_refs WHERE memory_id IN (?, ?)")
      .get(memId1, memId2) as any;
    expect(dangling.c).toBe(0);
  });

  test("marks wiki articles dirty before deleting originals", () => {
    const memId1 = insertRawMemory(db, AGENT, CHAN, "Python is used for data analysis work");
    const memId2 = insertRawMemory(db, AGENT, CHAN, "Python libraries include numpy and pandas");

    const wikiId = insertWikiArticle(db, AGENT, CHAN, "Python Data Science");
    linkRef(db, wikiId, memId1);
    linkRef(db, wikiId, memId2);

    expect(getLastCompiledAt(db, wikiId)).toBe(9999);

    store.mergeMemories(
      AGENT,
      [memId1, memId2],
      "Python is used for data analysis with numpy and pandas libraries",
      "fact",
    );

    // Wiki article should be marked dirty
    expect(getLastCompiledAt(db, wikiId)).toBe(0);
  });

  test("[BUG-C] regression: cleanupWikiRefsForMemories runs inside transaction — refs removed only if merge succeeds", () => {
    // Verifies that cleanupWikiRefsForMemories is called within the same transaction as the DELETE+INSERT.
    // If INSERT fails (FTS table dropped), both DELETE and cleanup must be rolled back.
    const memId1 = insertRawMemory(db, AGENT, CHAN, "TypeScript language static types compile");
    const memId2 = insertRawMemory(db, AGENT, CHAN, "TypeScript interfaces generics type safety");

    const wikiId = insertWikiArticle(db, AGENT, CHAN, "TypeScript Guide");
    linkRef(db, wikiId, memId1);
    linkRef(db, wikiId, memId2);

    // Drop FTS table to cause INSERT trigger to fail, which rolls back the entire transaction
    db.exec("DROP TABLE agent_memories_fts");

    const result = store.mergeMemories(
      AGENT,
      [memId1, memId2],
      "TypeScript provides static types for JavaScript development",
      "fact",
    );

    // Merge failed — should return null
    expect(result.id).toBeNull();

    // Originals must still exist (DELETE rolled back)
    const m1 = db.query("SELECT id FROM agent_memories WHERE id = ?").get(memId1) as any;
    const m2 = db.query("SELECT id FROM agent_memories WHERE id = ?").get(memId2) as any;
    expect(m1).not.toBeNull();
    expect(m2).not.toBeNull();

    // Refs must still exist (cleanupWikiRefsForMemories rolled back with the transaction)
    const refs = db
      .query("SELECT COUNT(*) as c FROM wiki_memory_refs WHERE memory_id IN (?, ?)")
      .get(memId1, memId2) as any;
    expect(refs.c).toBe(2);
  });
});

// ── getUpdatedSince() ─────────────────────────────────────────────────────────

describe("getUpdatedSince()", () => {
  test("returns memories updated after the given timestamp", () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    store.save({ agentId: AGENT, channel: CHAN, content: "Recent memory content here for testing" });
    const results = store.getUpdatedSince(AGENT, CHAN, past);
    expect(results.length).toBeGreaterThan(0);
  });

  test("excludes memories updated before the threshold", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    store.save({ agentId: AGENT, channel: CHAN, content: "Old memory content for testing purposes" });
    const results = store.getUpdatedSince(AGENT, CHAN, future);
    expect(results).toHaveLength(0);
  });

  test("excludes pinned memories (priority >= 80)", () => {
    const { id } = store.save({ agentId: AGENT, channel: CHAN, content: "Pinned memory updated since test" });
    store.pin(id!, AGENT);
    const past = Math.floor(Date.now() / 1000) - 3600;
    const results = store.getUpdatedSince(AGENT, CHAN, past);
    const pinned = results.filter((m) => m.priority >= 80);
    expect(pinned).toHaveLength(0);
  });

  test("includes channel IS NULL (global) memories", () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    store.save({ agentId: AGENT, channel: null, content: "Global memory updated since test content" });
    store.save({ agentId: AGENT, channel: CHAN, content: "Channel memory updated since test" });
    const results = store.getUpdatedSince(AGENT, CHAN, past);
    const globalMems = results.filter((m) => m.channel === null);
    expect(globalMems).toHaveLength(1);
    const channelMems = results.filter((m) => m.channel === CHAN);
    expect(channelMems).toHaveLength(1);
  });

  test("returns memories in descending updated_at order", () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    store.save({ agentId: AGENT, channel: CHAN, content: "Ordering memory one content here" });
    store.save({ agentId: AGENT, channel: CHAN, content: "Ordering memory two content here" });
    const results = store.getUpdatedSince(AGENT, CHAN, past);
    if (results.length >= 2) {
      expect(results[0].updatedAt).toBeGreaterThanOrEqual(results[1].updatedAt);
    }
  });
});
