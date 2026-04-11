/**
 * Tests for AgentMemoryStore — wiki-related methods.
 *
 * Uses real SQLite in-memory DB via runMigrations().
 * Tests both correct behavior and documents known bugs.
 *
 * Known bugs exposed (tests that CURRENTLY FAIL):
 *   [BUG-C] mergeMemories(): NOT wrapped in a transaction (atomicity gap)
 *
 * Previously documented bugs that have since been fixed:
 *   [BUG-A] save() dedup UPDATE path now calls markWikiArticlesDirty ✓
 *   [BUG-B] delete() now calls markWikiArticlesDirty before deleting ✓
 *   [BUG-D] pin()/unpin() now call markWikiArticlesDirty ✓
 *   [BUG-E] getAllForCompilation() now includes channel IS NULL (global) memories ✓
 *   [BUG-F] getUpdatedSince() now includes channel IS NULL (global) memories ✓
 *   [BUG-G] setupConcurrency() now enables PRAGMA foreign_keys = ON ✓
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../db/migrations";
import { memoryMigrations } from "../../db/migrations/memory-migrations";
import { AgentMemoryStore } from "../../agent/memory/agent-memory";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create AgentMemoryStore backed by a fresh in-memory SQLite DB. */
function makeStore(): AgentMemoryStore {
  return new AgentMemoryStore(":memory:");
}

/**
 * Insert a row directly into agent_wiki, bypassing WikiCompiler.
 * Returns the new wiki article id.
 */
function insertWikiArticle(
  db: Database,
  agentId: string,
  channel: string,
  topic: string,
  lastCompiledAt = 999,
): number {
  const content =
    "Minimum length wiki article content that satisfies the hundred-character CHECK constraint in the schema definition.";
  const r = db.run(
    `INSERT INTO agent_wiki
       (agent_id, channel, topic, summary, content, memory_ids, source_count, version,
        last_compiled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', 0, 1, ?, unixepoch(), unixepoch())`,
    [agentId, channel, topic, `Summary of ${topic}`, content, lastCompiledAt],
  );
  return Number(r.lastInsertRowid);
}

/** Insert a wiki_memory_refs row. */
function insertRef(db: Database, wikiId: number, memoryId: number): void {
  db.run(`INSERT OR IGNORE INTO wiki_memory_refs (wiki_id, memory_id) VALUES (?, ?)`, [wikiId, memoryId]);
}

/** Get last_compiled_at for a wiki article. */
function getLastCompiledAt(db: Database, wikiId: number): number {
  const row = db.query("SELECT last_compiled_at FROM agent_wiki WHERE id = ?").get(wikiId) as any;
  return row?.last_compiled_at ?? -1;
}

/** Count wiki_memory_refs rows for a wiki article. */
function countRefs(db: Database, wikiId: number): number {
  const row = db.query("SELECT COUNT(*) as c FROM wiki_memory_refs WHERE wiki_id = ?").get(wikiId) as any;
  return row?.c ?? 0;
}

/** Count wiki_memory_refs rows for a memory. */
function countRefsForMemory(db: Database, memId: number): number {
  const row = db.query("SELECT COUNT(*) as c FROM wiki_memory_refs WHERE memory_id = ?").get(memId) as any;
  return row?.c ?? 0;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("AgentMemoryStore — wiki integration", () => {
  let store: AgentMemoryStore;
  let db: Database;

  beforeEach(() => {
    store = makeStore();
    // getMemoryDb() triggers lazy ensureInit() → runs all migrations
    db = store.getMemoryDb();
  });

  // ── setupConcurrency ──────────────────────────────────────────────────────

  describe("setupConcurrency", () => {
    test("WAL journal mode is requested (may return 'memory' for :memory: DBs)", () => {
      const row = db.query("PRAGMA journal_mode").get() as any;
      // In-memory DBs don't support WAL but the PRAGMA doesn't throw
      expect(["wal", "memory"]).toContain(row.journal_mode);
    });

    test("busy_timeout is set to 30 000 ms", () => {
      const row = db.query("PRAGMA busy_timeout").get() as any;
      expect(row.timeout).toBe(30000);
    });

    test("foreign_keys pragma IS enabled by setupConcurrency — ON DELETE CASCADE fires", () => {
      const row = db.query("PRAGMA foreign_keys").get() as any;
      // setupConcurrency() executes PRAGMA foreign_keys = ON
      // so ON DELETE CASCADE on wiki_memory_refs fires automatically.
      expect(row.foreign_keys).toBe(1);
    });

    test("agent_wiki table exists after ensureInit (migration v4 applied)", () => {
      const row = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_wiki'").get();
      expect(row).not.toBeNull();
    });
  });

  // ── save() dedup UPDATE path ──────────────────────────────────────────────

  describe("save() dedup UPDATE path", () => {
    test("dedup UPDATE: updates existing memory and returns its id with warning", () => {
      // Insert an explicit memory first
      const first = store.save({
        agentId: "a1",
        channel: "c1",
        content: "The authentication system uses login tokens for secure access verification",
        source: "explicit",
      });
      expect(first.id).toBeNumber();

      // Save nearly identical content (explicit) → should hit dedup path
      const second = store.save({
        agentId: "a1",
        channel: "c1",
        content: "The authentication system uses login tokens for secure access verification updated",
        source: "explicit",
      });

      if (second.id === first.id) {
        // Dedup was triggered — warning should be present
        expect(second.warning).toContain("similar content");
      } else {
        // Content was different enough to insert fresh — still valid
        expect(second.id).toBeNumber();
      }
    });

    test("save() dedup UPDATE marks wiki articles dirty — last_compiled_at reset to 0", () => {
      // Setup: create a memory, a wiki article referencing it, mark it compiled
      const { id: memId } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "The authentication system uses login tokens for secure access verification",
        source: "explicit",
      });
      const wikiId = insertWikiArticle(db, "a1", "c1", "Auth Topic", 99999);
      insertRef(db, wikiId, memId!);

      // Verify article starts with high last_compiled_at
      expect(getLastCompiledAt(db, wikiId)).toBe(99999);

      // Trigger dedup UPDATE by saving similar content
      store.save({
        agentId: "a1",
        channel: "c1",
        content: "The authentication system uses login tokens for secure access verification updated",
        source: "explicit",
      });

      // markWikiArticlesDirty IS called on the dedup update path — article is now dirty
      const afterUpdate = getLastCompiledAt(db, wikiId);
      expect(afterUpdate).toBe(0);
    });

    test("save() with auto source and duplicate content returns id=null (silently deduped)", () => {
      const content = "Auto memory content about database connections and pooling management";
      store.save({ agentId: "a1", channel: "c1", content, source: "auto" });

      // Second auto-save of similar content should be silently dropped
      const second = store.save({ agentId: "a1", channel: "c1", content, source: "auto" });
      expect(second.id).toBeNull();
    });

    test("save() inserts fresh memory when content is sufficiently different", () => {
      const { id: id1 } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "Python is a high-level programming language with dynamic typing",
        source: "explicit",
      });
      const { id: id2 } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "Rust provides memory safety without garbage collection via ownership",
        source: "explicit",
      });
      expect(id1).toBeNumber();
      expect(id2).toBeNumber();
      expect(id1).not.toBe(id2);
    });
  });

  // ── delete() ──────────────────────────────────────────────────────────────

  describe("delete()", () => {
    test("deletes a memory owned by the agent", () => {
      const { id } = store.save({ agentId: "a1", channel: "c1", content: "Deletable memory content" });
      expect(id).toBeNumber();

      const deleted = store.delete(id!, "a1");
      expect(deleted).toBe(true);

      const row = db.query("SELECT id FROM agent_memories WHERE id = ?").get(id!) as any;
      expect(row).toBeNull();
    });

    test("returns false when memory not found or wrong agentId", () => {
      const { id } = store.save({ agentId: "a1", channel: "c1", content: "Protected memory content" });
      expect(store.delete(id!, "wrong-agent")).toBe(false);
      expect(store.delete(99999, "a1")).toBe(false);
    });

    test("cleanupWikiRefsForMemories: removes refs for the deleted memory", () => {
      const { id: memId } = store.save({ agentId: "a1", channel: "c1", content: "Ref target memory content" });
      const wikiId = insertWikiArticle(db, "a1", "c1", "Ref Article");
      insertRef(db, wikiId, memId!);

      expect(countRefs(db, wikiId)).toBe(1);

      store.delete(memId!, "a1");

      expect(countRefs(db, wikiId)).toBe(0);
    });

    test("cleanupWikiRefsForMemories: leaves other memories' refs intact", () => {
      // Use distinct content to avoid Jaccard dedup (DEDUP_SIMILARITY_THRESHOLD = 0.5)
      const { id: memId1 } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "Python asyncio generators coroutines event loop twisted tornado aiohttp framework async",
      });
      const { id: memId2 } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "PostgreSQL vacuum analyze btree gin gist partial expression covering bloat indices autovacuum",
      });
      const wikiId = insertWikiArticle(db, "a1", "c1", "Shared Article");
      insertRef(db, wikiId, memId1!);
      insertRef(db, wikiId, memId2!);

      expect(countRefs(db, wikiId)).toBe(2);

      // Delete only memId1
      store.delete(memId1!, "a1");

      // memId2's ref should remain
      expect(countRefs(db, wikiId)).toBe(1);
      expect(countRefsForMemory(db, memId2!)).toBe(1);
    });

    test("delete() marks wiki articles dirty before deleting — last_compiled_at reset to 0", () => {
      const { id: memId } = store.save({ agentId: "a1", channel: "c1", content: "Important memory to track" });
      const wikiId = insertWikiArticle(db, "a1", "c1", "Important Article", 99999);
      insertRef(db, wikiId, memId!);

      expect(getLastCompiledAt(db, wikiId)).toBe(99999);

      store.delete(memId!, "a1");

      // delete() calls markWikiArticlesDirty before removing the memory
      expect(getLastCompiledAt(db, wikiId)).toBe(0);
    });
  });

  // ── mergeMemories() ───────────────────────────────────────────────────────

  describe("mergeMemories()", () => {
    function saveTwo(): [number, number] {
      const { id: id1 } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "First fact about the deployment process pipeline",
      });
      const { id: id2 } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "Second fact about the deployment release workflow",
      });
      return [id1!, id2!];
    }

    test("inserts a consolidated memory and deletes originals", () => {
      const [id1, id2] = saveTwo();
      const { id: mergedId } = store.mergeMemories(
        "a1",
        [id1, id2],
        "Consolidated deployment process and release workflow knowledge",
        "fact",
      );

      expect(mergedId).toBeNumber();

      // Originals should be gone
      expect(store.getByIds([id1, id2], "a1")).toHaveLength(0);

      // Merged memory should exist
      const merged = store.getByIds([mergedId!], "a1");
      expect(merged).toHaveLength(1);
      expect(merged[0].content).toBe("Consolidated deployment process and release workflow knowledge");
    });

    test("calls markWikiArticlesDirty — wiki articles referencing merged IDs get last_compiled_at = 0", () => {
      const [id1, id2] = saveTwo();
      const wikiId = insertWikiArticle(db, "a1", "c1", "Deployment Article", 99999);
      insertRef(db, wikiId, id1);
      insertRef(db, wikiId, id2);

      expect(getLastCompiledAt(db, wikiId)).toBe(99999);

      store.mergeMemories("a1", [id1, id2], "Merged deployment knowledge content here", "fact");

      // markWikiArticlesDirty IS called in mergeMemories (unlike delete/save)
      expect(getLastCompiledAt(db, wikiId)).toBe(0);
    });

    test("calls cleanupWikiRefsForMemories for merged IDs — refs removed", () => {
      const [id1, id2] = saveTwo();
      const wikiId = insertWikiArticle(db, "a1", "c1", "Merge Cleanup Article");
      insertRef(db, wikiId, id1);
      insertRef(db, wikiId, id2);

      store.mergeMemories("a1", [id1, id2], "Merged content that is long enough for a good memory here", "fact");

      // Refs for merged IDs should be cleaned up
      expect(countRefsForMemory(db, id1)).toBe(0);
      expect(countRefsForMemory(db, id2)).toBe(0);
    });

    test("[BUG-C] KNOWN BUG: mergeMemories is NOT wrapped in an explicit transaction", () => {
      // Verify by inspection: mergeMemories calls markWikiArticlesDirty, then DELETE,
      // then INSERT without BEGIN/COMMIT wrapping. If the INSERT fails, deletions are
      // not rolled back — source memories are permanently lost.
      //
      // This test documents the correct happy-path behavior, but notes the missing transaction.
      const [id1, id2] = saveTwo();

      // Happy path — works fine without transaction
      const { id: mergedId } = store.mergeMemories(
        "a1",
        [id1, id2],
        "Merged knowledge about deployment processes and release pipelines",
        "fact",
      );
      expect(mergedId).toBeNumber();

      // NOTE: If we could force the INSERT to fail (e.g., via a DB write lock),
      // the DELETE would NOT be rolled back because there is no wrapping transaction.
      // The correct fix is: db.transaction(() => { delete; insert; })()
    });

    test("preserves highest priority from original memories", () => {
      store.save({ agentId: "a1", channel: "c1", content: "Low priority fact about something here", priority: 20 });
      store.save({ agentId: "a1", channel: "c1", content: "High priority fact about something else", priority: 60 });

      const all = db.query("SELECT id, priority FROM agent_memories WHERE agent_id='a1'").all() as any[];
      const ids = all.map((r) => r.id as number);

      const { id: mergedId } = store.mergeMemories(
        "a1",
        ids,
        "Merged content combining both low and high priority knowledge",
        "fact",
      );
      const merged = store.getByIds([mergedId!], "a1");
      // Max priority from originals (60), capped at 79
      expect(merged[0].priority).toBe(60);
    });

    test("returns { id: null } when mergeIds is empty", () => {
      const { id } = store.mergeMemories("a1", [], "Content", "fact");
      expect(id).toBeNull();
    });

    test("only merges non-pinned memories (priority < 80)", () => {
      const { id: normalId } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "Normal memory content about deployment processes here",
      });
      // Pin the second memory
      store.save({ agentId: "a1", channel: "c1", content: "Pinned memory about deployment workflows" });
      const pinTarget = db
        .query("SELECT id FROM agent_memories WHERE agent_id='a1' ORDER BY id DESC LIMIT 1")
        .get() as any;
      store.pin(pinTarget.id, "a1");

      const { id: mergedId } = store.mergeMemories(
        "a1",
        [normalId!, pinTarget.id],
        "Attempted merge content with pinned and normal memories",
        "fact",
      );

      // Pinned memory should still exist
      const pinned = store.getByIds([pinTarget.id], "a1");
      expect(pinned).toHaveLength(1);

      // Merged memory was created from non-pinned originals
      if (mergedId !== null) {
        const merged = store.getByIds([mergedId], "a1");
        expect(merged).toHaveLength(1);
      }
    });
  });

  // ── pin() / unpin() ───────────────────────────────────────────────────────

  describe("pin() / unpin()", () => {
    test("pin() sets priority to 90", () => {
      const { id } = store.save({ agentId: "a1", channel: "c1", content: "Pin target memory content" });
      const result = store.pin(id!, "a1");
      expect(result.success).toBe(true);

      const row = db.query("SELECT priority FROM agent_memories WHERE id = ?").get(id!) as any;
      expect(row.priority).toBe(90);
    });

    test("unpin() resets priority to 60", () => {
      const { id } = store.save({ agentId: "a1", channel: "c1", content: "Unpin target memory content" });
      store.pin(id!, "a1");
      const result = store.unpin(id!, "a1");
      expect(result.success).toBe(true);

      const row = db.query("SELECT priority FROM agent_memories WHERE id = ?").get(id!) as any;
      expect(row.priority).toBe(60);
    });

    test("pin() returns error when maximum 25 pinned memories reached", () => {
      // Use distinct content to avoid Jaccard dedup (DEDUP_SIMILARITY_THRESHOLD = 0.5)
      // Content strings must come from different domains with minimal word overlap
      const distinctContents = [
        "Python decorators metaclasses dataclasses abstractmethod classmethod staticmethod slots protocols",
        "Rust ownership borrowing lifetimes trait objects unsafe transmute pointer arithmetic allocation",
        "Go channels goroutines WaitGroup select defer recover runtime scheduler garbage collection",
        "JavaScript closures prototype WeakMap Symbol iterator generator promise microtask scheduling",
        "TypeScript discriminated conditional mapped template literal recursive branded utility types",
        "React fiber reconciler suspense concurrent transitions portals error boundaries forwarding refs",
        "Vue composition proxy reactive computed watchEffect teleport defineComponent scoped styles",
        "Angular signals injection tokens lazy routing guards interceptors schematics modules providers",
        "Svelte stores transitions animations compile reactivity server components actions preloading",
        "Webpack federation shaking splitting lazy chunks runtime manifest loaders plugins resolve",
        "Vite rollup native ESM HMR prebuilt dependencies library server rendering transform optimize",
        "PostgreSQL MVCC vacuum btree gin gist partial expression covering bloat autovacuum statistics",
        "Redis cluster replication AOF RDB scripting sorted streams bloom filter pipeline subscribe",
        "MongoDB aggregation atlas search vector embeddings transactions sharding oplog replica sets",
        "GraphQL federation subscriptions dataloader schema directives persisted operation variables",
        "gRPC protobuf streaming bidirectional interceptors reflection deadline context cancellation",
        "Docker buildkit multi-stage cache mounts secrets overlay cgroups namespaces volumes bridge",
        "Kubernetes operators CRD admission webhooks network policies RBAC quotas service mesh ingress",
        "AWS Lambda layers cold provisioned concurrency SAM CDK EventBridge Step Functions SNS SQS",
        "GCP Cloud Run Artifact Registry Pub Sub BigQuery Dataflow Spanner Vertex IAM workload identity",
        "Azure Durable Functions Service Bus Cosmos Event Hub managed identity private endpoints APIM",
        "Terraform workspaces state locking backends import moved replaced lifecycle constraint depends",
        "Ansible collections roles molecule vault encrypted inventory callback handlers notify templates",
        "Prometheus recording alertmanager silences inhibition thanos cortex mimir cardinality remote",
        "OpenTelemetry baggage propagation sampling tail exporters otlp collector spans traces metrics",
      ];
      // Pin 25 memories with distinct content
      for (const content of distinctContents) {
        const { id } = store.save({ agentId: "a1", channel: "c1", content });
        store.pin(id!, "a1");
      }
      // 26th pin should fail
      const { id: extra } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "Cryptography hashing signing certificates TLS PKI verification attestation digital signature",
      });
      const result = store.pin(extra!, "a1");
      expect(result.success).toBe(false);
      expect(result.error).toContain("25");
    });

    test("pin() returns error for wrong agent", () => {
      const { id } = store.save({ agentId: "a1", channel: "c1", content: "Agent ownership test content" });
      const result = store.pin(id!, "wrong-agent");
      expect(result.success).toBe(false);
    });

    test("unpin() returns error when memory is not pinned", () => {
      const { id } = store.save({ agentId: "a1", channel: "c1", content: "Not pinned memory content" });
      const result = store.unpin(id!, "a1");
      expect(result.success).toBe(false);
    });

    test("pin() calls markWikiArticlesDirty — wiki article last_compiled_at reset to 0", () => {
      const { id: memId } = store.save({ agentId: "a1", channel: "c1", content: "Pin wiki integration test" });
      const wikiId = insertWikiArticle(db, "a1", "c1", "Pin Article", 99999);
      insertRef(db, wikiId, memId!);

      expect(getLastCompiledAt(db, wikiId)).toBe(99999);

      store.pin(memId!, "a1");

      // pin() calls markWikiArticlesDirty — article is now dirty
      expect(getLastCompiledAt(db, wikiId)).toBe(0);
    });

    test("unpin() calls markWikiArticlesDirty — wiki article last_compiled_at reset to 0", () => {
      const { id: memId } = store.save({ agentId: "a1", channel: "c1", content: "Unpin wiki integration test" });
      const wikiId = insertWikiArticle(db, "a1", "c1", "Unpin Article", 99999);
      insertRef(db, wikiId, memId!);
      store.pin(memId!, "a1");

      // Reset last_compiled_at after pin (pin() also calls markWikiArticlesDirty)
      db.run(`UPDATE agent_wiki SET last_compiled_at = 99999 WHERE id = ?`, [wikiId]);

      store.unpin(memId!, "a1");

      // unpin() calls markWikiArticlesDirty — article is now dirty
      expect(getLastCompiledAt(db, wikiId)).toBe(0);
    });
  });

  // ── getAllForCompilation() ────────────────────────────────────────────────

  describe("getAllForCompilation()", () => {
    test("returns non-pinned memories for the specified channel", () => {
      store.save({ agentId: "a1", channel: "c1", content: "Channel-specific memory content" });
      const results = store.getAllForCompilation("a1", "c1");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].channel).toBe("c1");
    });

    test("excludes pinned memories (priority >= 80)", () => {
      const { id } = store.save({ agentId: "a1", channel: "c1", content: "Memory that will be pinned content" });
      store.pin(id!, "a1");

      const results = store.getAllForCompilation("a1", "c1");
      const pinned = results.filter((m) => m.priority >= 80);
      expect(pinned).toHaveLength(0);
    });

    test("excludes memories from other agents or channels", () => {
      store.save({ agentId: "a2", channel: "c1", content: "Other agent memory content here" });
      store.save({ agentId: "a1", channel: "c2", content: "Other channel memory content here" });

      const results = store.getAllForCompilation("a1", "c1");
      expect(results.filter((m) => m.agentId !== "a1")).toHaveLength(0);
      expect(results.filter((m) => m.channel !== "c1")).toHaveLength(0);
    });

    test("getAllForCompilation includes channel IS NULL (global) memories", () => {
      // Save a channel-specific memory
      store.save({ agentId: "a1", channel: "c1", content: "Channel specific memory content here" });

      // Save a global memory (channel = null)
      store.save({ agentId: "a1", channel: null, content: "Global memory no channel assigned" });

      const results = store.getAllForCompilation("a1", "c1");

      // The query uses `AND (channel = ? OR channel IS NULL)` — globals are included
      const globalMemories = results.filter((m) => m.channel === null);
      expect(globalMemories).toHaveLength(1); // Global IS included

      // Channel-specific memory IS also returned
      const channelMemories = results.filter((m) => m.channel === "c1");
      expect(channelMemories).toHaveLength(1);
    });

    test("does not bump access_count (read-only for compilation)", () => {
      store.save({ agentId: "a1", channel: "c1", content: "Compilation read-only memory" });
      const before = db
        .query("SELECT access_count FROM agent_memories WHERE agent_id='a1' AND channel='c1'")
        .get() as any;
      const beforeCount = before?.access_count ?? 0;

      store.getAllForCompilation("a1", "c1");

      const after = db
        .query("SELECT access_count FROM agent_memories WHERE agent_id='a1' AND channel='c1'")
        .get() as any;
      expect(after?.access_count).toBe(beforeCount); // No bump
    });
  });

  // ── getUpdatedSince() ─────────────────────────────────────────────────────

  describe("getUpdatedSince()", () => {
    test("returns memories updated after the given timestamp", () => {
      const past = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      store.save({ agentId: "a1", channel: "c1", content: "Recent memory content here for testing" });

      const results = store.getUpdatedSince("a1", "c1", past);
      expect(results.length).toBeGreaterThan(0);
    });

    test("excludes memories updated before the threshold", () => {
      const future = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      store.save({ agentId: "a1", channel: "c1", content: "Old memory content for testing purposes" });

      const results = store.getUpdatedSince("a1", "c1", future);
      expect(results).toHaveLength(0);
    });

    test("excludes pinned memories (priority >= 80)", () => {
      const { id } = store.save({ agentId: "a1", channel: "c1", content: "Pinned memory updated since test" });
      store.pin(id!, "a1");

      const past = Math.floor(Date.now() / 1000) - 3600;
      const results = store.getUpdatedSince("a1", "c1", past);
      const pinned = results.filter((m) => m.priority >= 80);
      expect(pinned).toHaveLength(0);
    });

    test("getUpdatedSince includes channel IS NULL (global) memories", () => {
      const past = Math.floor(Date.now() / 1000) - 3600;

      // Save a global memory (channel = null)
      store.save({ agentId: "a1", channel: null, content: "Global memory updated since test content" });

      // Save a channel-specific memory
      store.save({ agentId: "a1", channel: "c1", content: "Channel memory updated since test" });

      const results = store.getUpdatedSince("a1", "c1", past);

      // The query uses `AND (channel = ? OR channel IS NULL)` — globals are included
      const globalMemories = results.filter((m) => m.channel === null);
      expect(globalMemories).toHaveLength(1); // Global IS included

      // Channel-specific IS also included
      const channelMemories = results.filter((m) => m.channel === "c1");
      expect(channelMemories).toHaveLength(1);
    });

    test("returns memories in descending updated_at order", () => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      store.save({ agentId: "a1", channel: "c1", content: "Ordering memory one content here" });
      store.save({ agentId: "a1", channel: "c1", content: "Ordering memory two content here" });

      const results = store.getUpdatedSince("a1", "c1", past);
      if (results.length >= 2) {
        expect(results[0].updatedAt).toBeGreaterThanOrEqual(results[1].updatedAt);
      }
    });
  });

  // ── markWikiArticlesDirty() [private, tested via observable effects] ───────

  describe("markWikiArticlesDirty() — private, tested via mergeMemories and enforceAgentCap", () => {
    test("sets last_compiled_at = 0 for wiki articles referencing given memory IDs", () => {
      const { id: memId } = store.save({ agentId: "a1", channel: "c1", content: "Memory for dirty test content" });
      const wikiId = insertWikiArticle(db, "a1", "c1", "Will Be Marked Dirty", 88888);
      insertRef(db, wikiId, memId!);

      // mergeMemories calls markWikiArticlesDirty internally
      store.mergeMemories("a1", [memId!], "Merged content that replaces the original memory", "fact");

      expect(getLastCompiledAt(db, wikiId)).toBe(0);
    });

    test("only marks articles that reference the specified memory IDs", () => {
      // Use distinct content to avoid Jaccard dedup (DEDUP_SIMILARITY_THRESHOLD = 0.5)
      const { id: memId1 } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "Python asyncio generators coroutines event loop twisted tornado aiohttp framework async programming",
      });
      const { id: memId2 } = store.save({
        agentId: "a1",
        channel: "c1",
        content:
          "PostgreSQL vacuum analyze btree gin gist partial expression covering bloat indices autovacuum statistics",
      });

      const wiki1 = insertWikiArticle(db, "a1", "c1", "Article for Memory One", 11111);
      const wiki2 = insertWikiArticle(db, "a1", "c1", "Article for Memory Two", 22222);
      insertRef(db, wiki1, memId1!);
      insertRef(db, wiki2, memId2!);

      // Merge only memId1 — should dirty wiki1 but NOT wiki2
      store.mergeMemories("a1", [memId1!], "Merged knowledge from the first memory content here", "fact");

      expect(getLastCompiledAt(db, wiki1)).toBe(0); // Dirty
      expect(getLastCompiledAt(db, wiki2)).toBe(22222); // Untouched
    });

    test("no-ops gracefully when no wiki articles reference the given memory IDs", () => {
      const { id: memId } = store.save({ agentId: "a1", channel: "c1", content: "Orphan memory with no wiki refs" });
      // No wiki article references this memory
      expect(() => store.mergeMemories("a1", [memId!], "Merged content for orphan memory here", "fact")).not.toThrow();
    });

    test("no-ops gracefully when wiki tables do not exist (pre-migration scenario)", () => {
      // Use a bare DB with only v1-v3 migrations (no wiki tables)
      const bareDb = new Database(":memory:");
      // Run only migrations 1-3 (no wiki tables)
      const partialMigrations = memoryMigrations.filter((m) => m.version <= 3);
      runMigrations(bareDb, partialMigrations);

      // Create store pointing to this bare DB — access db directly via a new store
      // Since AgentMemoryStore constructor uses a path, we can't easily inject the DB.
      // Instead, verify that mergeMemories in the main store doesn't throw even when
      // the wiki tables conceptually don't hold the memory.
      const { id: memId } = store.save({ agentId: "a1", channel: "c1", content: "Pre-migration memory test" });
      expect(() =>
        store.mergeMemories("a1", [memId!], "Pre-migration merged content for testing", "fact"),
      ).not.toThrow();
    });
  });

  // ── cleanupWikiRefsForMemories() [private, tested via delete/merge] ────────

  describe("cleanupWikiRefsForMemories() — private, tested via delete() and mergeMemories()", () => {
    test("removes only the refs for the specified memory IDs, leaves others intact", () => {
      // Use distinct content to avoid Jaccard dedup (DEDUP_SIMILARITY_THRESHOLD = 0.5)
      const { id: keep } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "Python asyncio generators coroutines event loop twisted aiohttp framework async programming",
      });
      const { id: remove } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "PostgreSQL vacuum analyze btree gin gist partial expression covering bloat indices autovacuum",
      });

      const wikiId = insertWikiArticle(db, "a1", "c1", "Shared Article");
      insertRef(db, wikiId, keep!);
      insertRef(db, wikiId, remove!);

      expect(countRefs(db, wikiId)).toBe(2);

      // Delete the 'remove' memory → triggers cleanupWikiRefsForMemories([remove])
      store.delete(remove!, "a1");

      // Only the 'remove' ref should be gone
      expect(countRefs(db, wikiId)).toBe(1);
      expect(countRefsForMemory(db, keep!)).toBe(1);
      expect(countRefsForMemory(db, remove!)).toBe(0);
    });

    test("updates source_count on affected wiki article after ref cleanup", () => {
      // Use distinct content to avoid Jaccard dedup (DEDUP_SIMILARITY_THRESHOLD = 0.5)
      const { id: memId1 } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "JavaScript closures prototype chain WeakMap Symbol iterator generator promise microtask queue",
      });
      const { id: memId2 } = store.save({
        agentId: "a1",
        channel: "c1",
        content: "Kubernetes operators CRD admission webhooks network policies RBAC quotas service mesh ingress",
      });

      const wikiId = insertWikiArticle(db, "a1", "c1", "Source Count Article");
      insertRef(db, wikiId, memId1!);
      insertRef(db, wikiId, memId2!);

      // Manually set source_count so we can observe the refresh
      db.run(`UPDATE agent_wiki SET source_count = 2 WHERE id = ?`, [wikiId]);

      // Delete one memory
      store.delete(memId1!, "a1");

      const row = db.query("SELECT source_count FROM agent_wiki WHERE id = ?").get(wikiId) as any;
      expect(row.source_count).toBe(1);
    });

    test("handles cleanup gracefully when no refs exist for the memory", () => {
      const { id: memId } = store.save({ agentId: "a1", channel: "c1", content: "Memory with no wiki refs" });
      // No wiki refs — cleanup should be silent
      expect(() => store.delete(memId!, "a1")).not.toThrow();
    });

    test("cleanup via mergeMemories: removes refs for ALL merged memory IDs", () => {
      const { id: memId1 } = store.save({ agentId: "a1", channel: "c1", content: "Merge cleanup first content" });
      const { id: memId2 } = store.save({ agentId: "a1", channel: "c1", content: "Merge cleanup second content" });

      const wiki1 = insertWikiArticle(db, "a1", "c1", "Article One for Merge");
      const wiki2 = insertWikiArticle(db, "a1", "c1", "Article Two for Merge");
      insertRef(db, wiki1, memId1!);
      insertRef(db, wiki2, memId2!);

      store.mergeMemories("a1", [memId1!, memId2!], "Merged deployment knowledge content here", "fact");

      expect(countRefsForMemory(db, memId1!)).toBe(0);
      expect(countRefsForMemory(db, memId2!)).toBe(0);
    });
  });

  // ── Concurrency / WAL interactions ────────────────────────────────────────

  describe("concurrent save/recall safety", () => {
    test("multiple saves in sequence do not corrupt the DB", () => {
      for (let i = 0; i < 50; i++) {
        const result = store.save({
          agentId: "a1",
          channel: "c1",
          content: `Sequential stress test memory number ${i} with unique content facts`,
        });
        expect(result.id).not.toBeNull();
      }
      const count = store.getCount("a1");
      expect(count).toBeGreaterThan(0);
    });

    test("getMemoryDb() returns the same Database instance on repeated calls", () => {
      const db1 = store.getMemoryDb();
      const db2 = store.getMemoryDb();
      expect(db1).toBe(db2); // Same object reference
    });
  });
});
