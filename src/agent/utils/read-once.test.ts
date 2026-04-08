/**
 * Unit tests for ReadOnceCache
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadOnceCache, clearReadOnceCache, getReadOnceCache } from "./read-once";

// Use a temp directory for file system tests
const TEST_DIR = join("/tmp", "read-once-test-" + Date.now());

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

beforeEach(setup);
afterEach(cleanup);

describe("ReadOnceCache", () => {
  let cache: ReadOnceCache;

  beforeEach(() => {
    cache = new ReadOnceCache(200);
  });

  // ── 1. Cache miss on first read ─────────────────────────────────────────────

  test("first read returns fromCache=false", () => {
    const filePath = join(TEST_DIR, "file1.txt");
    writeFileSync(filePath, "hello world");

    const result = cache.read(filePath);
    expect(result).not.toBeNull();
    expect(result!.fromCache).toBe(false);
    expect(result!.wasModified).toBe(false);
    expect(result!.content).toBe("hello world");
  });

  // ── 2. Cache hit on second read ────────────────────────────────────────────

  test("second identical read returns fromCache=true", () => {
    const filePath = join(TEST_DIR, "file2.txt");
    writeFileSync(filePath, "cached content");

    const first = cache.read(filePath);
    expect(first!.fromCache).toBe(false);

    const second = cache.read(filePath);
    expect(second!.fromCache).toBe(true);
    expect(second!.wasModified).toBe(false);
    expect(second!.content).toBe("cached content");
  });

  // ── 3. Cache bust on modification ──────────────────────────────────────────

  test("file modification busts the cache", () => {
    const filePath = join(TEST_DIR, "file3.txt");
    writeFileSync(filePath, "original");

    const first = cache.read(filePath);
    expect(first!.fromCache).toBe(false);

    // Modify the file and wait for mtime to change
    writeFileSync(filePath, "modified");
    // Force mtime to advance by at least 1ms (needed on fast tmpfs)
    const { utimesSync } = require("node:fs");
    const stat = require("node:fs").statSync(filePath);
    utimesSync(filePath, stat.atimeMs, stat.mtimeMs + 1);

    const second = cache.read(filePath);
    expect(second!.fromCache).toBe(false); // bust → cache miss
    expect(second!.wasModified).toBe(true);
    expect(second!.content).toBe("modified");
  });

  // ── 4. Non-existent file ────────────────────────────────────────────────────

  test("read returns null for non-existent file (does not throw)", () => {
    const result = cache.read(join(TEST_DIR, "does-not-exist.txt"));
    expect(result).toBeNull();
  });

  test("non-existent file removes any stale entry", () => {
    const filePath = join(TEST_DIR, "to-delete.txt");
    writeFileSync(filePath, "content");
    cache.read(filePath); // populate cache

    // File gets deleted externally
    rmSync(filePath);

    const result = cache.read(filePath);
    expect(result).toBeNull();
    // Stale entry should be removed after the miss
    const stats = cache.getStats();
    expect(stats.entries).toBe(0);
  });

  // ── 5. Invalidate single file ───────────────────────────────────────────────

  test("invalidate() clears a single file entry", () => {
    const filePath = join(TEST_DIR, "file5.txt");
    writeFileSync(filePath, "content");

    cache.read(filePath);
    expect(cache.getStats().entries).toBe(1);

    cache.invalidate(filePath);
    expect(cache.getStats().entries).toBe(0);

    const result = cache.read(filePath);
    expect(result!.fromCache).toBe(false); // fresh read
  });

  // ── 6. Invalidate all ───────────────────────────────────────────────────────

  test("invalidateAll() clears all entries", () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(TEST_DIR, `file${i}.txt`), `content ${i}`);
      cache.read(join(TEST_DIR, `file${i}.txt`));
    }
    expect(cache.getStats().entries).toBe(5);

    cache.invalidateAll();
    expect(cache.getStats().entries).toBe(0);
  });

  // ── 7. Stats tracking ──────────────────────────────────────────────────────

  test("hitRate calculation is correct", () => {
    const filePath = join(TEST_DIR, "stats.txt");
    writeFileSync(filePath, "content");

    cache.read(filePath); // miss
    cache.read(filePath); // hit
    cache.read(filePath); // hit

    const stats = cache.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(2);
    expect(stats.busts).toBe(0);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });

  test("bust increments bust counter", () => {
    const filePath = join(TEST_DIR, "bust.txt");
    writeFileSync(filePath, "v1");
    cache.read(filePath);

    writeFileSync(filePath, "v2");
    // Force mtime to advance (needed on fast tmpfs)
    const { utimesSync, statSync } = require("node:fs");
    utimesSync(filePath, statSync(filePath).atimeMs, statSync(filePath).mtimeMs + 1);
    cache.read(filePath);

    const stats = cache.getStats();
    expect(stats.busts).toBe(1);
    expect(stats.misses).toBe(2); // bust counts as miss (new disk read)
    expect(stats.hits).toBe(0);
  });

  test("empty cache has hitRate 0", () => {
    const stats = cache.getStats();
    expect(stats.entries).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe(0);
  });

  // ── 8. Relative path resolution ────────────────────────────────────────────

  test("relative path resolved against projectRoot", () => {
    const filePath = join(TEST_DIR, "relative.txt");
    writeFileSync(filePath, "relative content");

    const result = cache.read("relative.txt", TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.fromCache).toBe(false);
    expect(result!.content).toBe("relative content");
  });

  test("relative path second read is cached", () => {
    const filePath = join(TEST_DIR, "rel2.txt");
    writeFileSync(filePath, "rel2 content");

    cache.read("rel2.txt", TEST_DIR);
    const second = cache.read("rel2.txt", TEST_DIR);
    expect(second!.fromCache).toBe(true);
  });

  // ── 9. Symlink resolution ────────────────────────────────────────────────────

  test("reads via different paths resolve to same canonical path (symlink)", () => {
    const realPath = join(TEST_DIR, "real.txt");
    const linkPath = join(TEST_DIR, "link.txt");
    writeFileSync(realPath, "symlink content");
    symlinkSync(realPath, linkPath);

    cache.read(realPath); // first via real path
    const viaLink = cache.read(linkPath); // second via symlink

    expect(viaLink!.fromCache).toBe(true); // should hit cache
  });

  // ── 10. LRU eviction ────────────────────────────────────────────────────────

  test("LRU eviction fires when exceeding maxEntries", () => {
    const smallCache = new ReadOnceCache(5); // small cap

    for (let i = 0; i < 10; i++) {
      writeFileSync(join(TEST_DIR, `evict${i}.txt`), `content ${i}`);
      smallCache.read(join(TEST_DIR, `evict${i}.txt`));
    }

    // Should evict down to 5
    expect(smallCache.getStats().entries).toBeLessThanOrEqual(5);
  });

  test("LRU evicts least-read entry", () => {
    const smallCache = new ReadOnceCache(3);

    // Create 3 files
    const paths = ["a.txt", "b.txt", "c.txt"];
    for (const f of paths) {
      writeFileSync(join(TEST_DIR, f), f);
    }

    // Read A once, B once, C twice
    smallCache.read(join(TEST_DIR, "a.txt"));
    smallCache.read(join(TEST_DIR, "b.txt"));
    smallCache.read(join(TEST_DIR, "c.txt"));
    smallCache.read(join(TEST_DIR, "c.txt")); // C has readCount=2

    // Add 4th file → C should survive (readCount=2), A evicted (readCount=1)
    writeFileSync(join(TEST_DIR, "d.txt"), "d");
    smallCache.read(join(TEST_DIR, "d.txt"));

    // A should be evicted
    const afterA = smallCache.read(join(TEST_DIR, "a.txt"));
    expect(afterA!.fromCache).toBe(false); // was evicted, must be re-read
  });

  // ── 11. getCachedPaths ──────────────────────────────────────────────────────

  test("getCachedPaths returns all cached file paths", () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(TEST_DIR, `paths${i}.txt`), `p${i}`);
      cache.read(join(TEST_DIR, `paths${i}.txt`));
    }

    const cached = cache.getCachedPaths();
    expect(cached.length).toBe(3);
  });

  // ── 12. readCount increments on cache hit ───────────────────────────────────

  test("readCount increments on each cache hit", () => {
    const filePath = join(TEST_DIR, "readcount.txt");
    writeFileSync(filePath, "content");

    cache.read(filePath); // miss
    cache.read(filePath); // hit 1
    cache.read(filePath); // hit 2
    cache.read(filePath); // hit 3

    expect(cache.getCachedPaths().length).toBe(1);
    // Re-read to verify readCount (by checking LRU order — higher readCount survives)
    const smallCache = new ReadOnceCache(2);
    writeFileSync(join(TEST_DIR, "rc1.txt"), "rc1");
    writeFileSync(join(TEST_DIR, "rc2.txt"), "rc2");
    smallCache.read(join(TEST_DIR, "rc1.txt"));
    smallCache.read(join(TEST_DIR, "rc2.txt"));
    smallCache.read(join(TEST_DIR, "rc2.txt")); // rc2 has higher readCount
    writeFileSync(join(TEST_DIR, "rc3.txt"), "rc3");
    smallCache.read(join(TEST_DIR, "rc3.txt")); // should evict rc1 (readCount=1)
    const rc1 = smallCache.read(join(TEST_DIR, "rc1.txt"));
    expect(rc1!.fromCache).toBe(false); // evicted
  });
});

// ── Module-level factory tests ──────────────────────────────────────────────────

describe("getReadOnceCache factory", () => {
  const SESSION_A = "session-a-" + Date.now();
  const SESSION_B = "session-b-" + Date.now();

  afterEach(() => {
    clearReadOnceCache(SESSION_A);
    clearReadOnceCache(SESSION_B);
  });

  test("returns same instance for same sessionId", () => {
    const a1 = getReadOnceCache(SESSION_A);
    const a2 = getReadOnceCache(SESSION_A);
    expect(a1).toBe(a2);
  });

  test("returns different instances for different sessionIds", () => {
    const a = getReadOnceCache(SESSION_A);
    const b = getReadOnceCache(SESSION_B);
    expect(a).not.toBe(b);
  });

  test("cache isolation between sessions", () => {
    const filePath = join(TEST_DIR, "session-iso.txt");
    writeFileSync(filePath, "session content");

    const cacheA = getReadOnceCache(SESSION_A);
    const cacheB = getReadOnceCache(SESSION_B);

    cacheA.read(filePath); // session A reads
    const bRead = cacheB.read(filePath); // session B reads → cache miss

    expect(bRead!.fromCache).toBe(false); // different session = separate cache
  });

  test("clearReadOnceCache removes session cache", () => {
    const cacheA = getReadOnceCache(SESSION_A);
    const filePath = join(TEST_DIR, "clear-test.txt");
    writeFileSync(filePath, "clear content");
    cacheA.read(filePath);

    clearReadOnceCache(SESSION_A);

    const cacheA2 = getReadOnceCache(SESSION_A);
    expect(cacheA2).not.toBe(cacheA); // new instance
  });
});
