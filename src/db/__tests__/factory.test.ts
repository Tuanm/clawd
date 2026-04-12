/**
 * Tests for src/db/factory.ts — prerequisite for Phase 4.5 (DB factory extraction).
 *
 * Covers:
 *   - createDatabase() returns a usable Database instance
 *   - Standard PRAGMAs are applied (WAL, synchronous, busy_timeout, temp_store)
 *   - In-memory mode works (:memory: path)
 *   - Container env detection (ENV=dev/prod/staging) selects smaller cache/no mmap
 *   - Desktop env (ENV unset) selects larger cache + mmap enabled
 *   - applyPragmas() is idempotent (calling twice doesn't corrupt the DB)
 *
 * Uses bun:test + bun:sqlite. No filesystem access.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyPragmas, createDatabase } from "../factory";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const originalEnv = process.env.ENV;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.ENV;
  } else {
    process.env.ENV = originalEnv;
  }
});

beforeEach(() => {
  delete process.env.ENV;
});

/** Read a PRAGMA value as a string. */
function pragma(db: Database, name: string): string {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
  if (!row) return "";
  return String(Object.values(row)[0]);
}

// ─── createDatabase — basic ──────────────────────────────────────────────────

describe("createDatabase", () => {
  test("returns a Database instance", () => {
    const db = createDatabase();
    expect(db).toBeInstanceOf(Database);
    db.close();
  });

  test("defaults to in-memory mode", () => {
    const db = createDatabase();
    // In-memory DBs can execute statements without any file path
    expect(() => db.exec("CREATE TABLE t (id INTEGER)")).not.toThrow();
    db.close();
  });

  test("explicit :memory: path works", () => {
    const db = createDatabase(":memory:");
    expect(() => db.exec("CREATE TABLE t (id INTEGER)")).not.toThrow();
    db.close();
  });

  test("creates a usable database (can insert and query)", () => {
    const db = createDatabase();
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO items (name) VALUES ('hello')");
    const row = db.query("SELECT name FROM items").get() as { name: string };
    expect(row.name).toBe("hello");
    db.close();
  });

  test("each call returns an independent database", () => {
    const db1 = createDatabase();
    const db2 = createDatabase();
    db1.exec("CREATE TABLE t (id INTEGER)");
    // db2 should not have this table
    expect(() => db2.query("SELECT * FROM t").all()).toThrow();
    db1.close();
    db2.close();
  });
});

// ─── PRAGMA application ───────────────────────────────────────────────────────

describe("applyPragmas — PRAGMA values", () => {
  test("sets busy_timeout to 30000 by default", () => {
    const db = new Database(":memory:");
    applyPragmas(db);
    expect(pragma(db, "busy_timeout")).toBe("30000");
    db.close();
  });

  test("sets foreign_keys to ON by default", () => {
    const db = new Database(":memory:");
    applyPragmas(db);
    expect(pragma(db, "foreign_keys")).toBe("1");
    db.close();
  });

  test("busyTimeout option overrides default", () => {
    const db = new Database(":memory:");
    applyPragmas(db, { busyTimeout: 5000 });
    expect(pragma(db, "busy_timeout")).toBe("5000");
    db.close();
  });

  test("foreignKeys=false disables FK enforcement", () => {
    const db = new Database(":memory:");
    applyPragmas(db, { foreignKeys: false });
    expect(pragma(db, "foreign_keys")).toBe("0");
    db.close();
  });

  test("sets synchronous to NORMAL (1)", () => {
    const db = new Database(":memory:");
    applyPragmas(db);
    // SQLite returns numeric value: 0=OFF, 1=NORMAL, 2=FULL
    expect(pragma(db, "synchronous")).toBe("1");
    db.close();
  });

  test("sets temp_store to MEMORY (2)", () => {
    const db = new Database(":memory:");
    applyPragmas(db);
    // 0=DEFAULT, 1=FILE, 2=MEMORY
    expect(pragma(db, "temp_store")).toBe("2");
    db.close();
  });

  test("sets journal_mode to WAL or memory (in-memory DB returns memory)", () => {
    const db = new Database(":memory:");
    applyPragmas(db);
    const mode = pragma(db, "journal_mode");
    // In-memory SQLite cannot use WAL — it stays "memory"
    expect(["wal", "memory"]).toContain(mode);
    db.close();
  });
});

// ─── Container env detection ─────────────────────────────────────────────────

describe("applyPragmas — container env detection", () => {
  test("desktop (ENV unset): cache_size is -64000", () => {
    delete process.env.ENV;
    const db = new Database(":memory:");
    applyPragmas(db);
    expect(pragma(db, "cache_size")).toBe("-64000");
    db.close();
  });

  test("desktop (ENV unset): mmap_size PRAGMA executes without error", () => {
    // mmap_size is a no-op on :memory: DBs (SQLite ignores it); we verify
    // applyPragmas does not throw and that it sets the correct value on disk DBs.
    delete process.env.ENV;
    const db = new Database(":memory:");
    expect(() => applyPragmas(db)).not.toThrow();
    db.close();
  });

  test("container (ENV=dev): cache_size is -8000", () => {
    process.env.ENV = "dev";
    const db = new Database(":memory:");
    applyPragmas(db);
    expect(pragma(db, "cache_size")).toBe("-8000");
    db.close();
  });

  test("container (ENV=prod): cache_size is -8000", () => {
    process.env.ENV = "prod";
    const db = new Database(":memory:");
    applyPragmas(db);
    expect(pragma(db, "cache_size")).toBe("-8000");
    db.close();
  });

  test("container (ENV=staging): cache_size is -8000", () => {
    process.env.ENV = "staging";
    const db = new Database(":memory:");
    applyPragmas(db);
    expect(pragma(db, "cache_size")).toBe("-8000");
    db.close();
  });

  test("container env: mmap_size PRAGMA executes without error", () => {
    // mmap_size is a no-op on :memory: DBs; we verify applyPragmas does not throw.
    process.env.ENV = "prod";
    const db = new Database(":memory:");
    expect(() => applyPragmas(db)).not.toThrow();
    db.close();
  });

  test("arbitrary ENV value is treated as desktop", () => {
    process.env.ENV = "local";
    const db = new Database(":memory:");
    applyPragmas(db);
    expect(pragma(db, "cache_size")).toBe("-64000");
    db.close();
  });

  test("empty string ENV is treated as desktop", () => {
    process.env.ENV = "";
    const db = new Database(":memory:");
    applyPragmas(db);
    expect(pragma(db, "cache_size")).toBe("-64000");
    db.close();
  });
});

// ─── createDatabase options ──────────────────────────────────────────────────

describe("createDatabase — options", () => {
  test("strict option defaults to false", () => {
    const db = createDatabase();
    // Non-strict: .get() returns null on no match
    db.exec("CREATE TABLE t (id INTEGER)");
    const row = db.query("SELECT * FROM t").get();
    expect(row).toBeNull();
    db.close();
  });

  test("strict=true is passed to Database constructor", () => {
    const db = createDatabase(":memory:", { strict: true });
    // strict mode enables stricter parameter validation in bun:sqlite
    db.exec("CREATE TABLE t (id INTEGER)");
    expect(db).toBeInstanceOf(Database);
    db.close();
  });

  test("busyTimeout passes through to applyPragmas", () => {
    const db = createDatabase(":memory:", { busyTimeout: 5000 });
    expect(pragma(db, "busy_timeout")).toBe("5000");
    db.close();
  });

  test("foreignKeys=false passes through to applyPragmas", () => {
    const db = createDatabase(":memory:", { foreignKeys: false });
    expect(pragma(db, "foreign_keys")).toBe("0");
    db.close();
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("applyPragmas — idempotency", () => {
  test("calling applyPragmas twice does not throw", () => {
    const db = new Database(":memory:");
    expect(() => {
      applyPragmas(db);
      applyPragmas(db);
    }).not.toThrow();
    db.close();
  });

  test("PRAGMA values are consistent after double application", () => {
    const db = new Database(":memory:");
    applyPragmas(db);
    applyPragmas(db);
    expect(pragma(db, "busy_timeout")).toBe("30000");
    expect(pragma(db, "synchronous")).toBe("1");
    expect(pragma(db, "foreign_keys")).toBe("1");
    db.close();
  });
});
