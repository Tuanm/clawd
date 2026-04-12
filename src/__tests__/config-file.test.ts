/**
 * Tests for config-file.ts — prerequisite for Phase 3 (config hygiene)
 * and Phase 4.1 (isContainerEnv extraction).
 *
 * Strategy: write the real config JSON to a temp copy and swap it in via
 * the module-level mock, then call reloadConfigFile() to bust the cache.
 *
 * Uses bun:test; no vitest imports.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Shared mutable state read by the fs mock ────────────────────────────────

/** Set to true when the "config file" should appear to exist. */
let mockFileExists = false;
/** Raw JSON string returned by readFileSync when mockFileExists is true. */
let mockFileContent = "{}";

// ─── Module-level mock — must be before any static import of config-file ─────

mock.module("node:fs", () => {
  // We still need the real mkdirSync/existsSync for other modules (e.g. bun:sqlite
  // directory creation).  Only intercept the paths used by config-file.ts.
  const real = require("node:fs");
  return {
    ...real,
    existsSync: (p: string) => {
      // Only intercept the ~/.clawd/config.json path; let everything else through.
      if (typeof p === "string" && p.includes(".clawd") && p.endsWith("config.json")) {
        return mockFileExists;
      }
      return real.existsSync(p);
    },
    readFileSync: (p: string, enc?: string) => {
      if (typeof p === "string" && p.includes(".clawd") && p.endsWith("config.json")) {
        return mockFileContent;
      }
      return real.readFileSync(p, enc);
    },
    // watch is called at module-init time; return a no-op watcher
    watch: (p: string, ...args: unknown[]) => {
      if (typeof p === "string" && p.includes(".clawd") && p.endsWith("config.json")) {
        return {}; // fake FSWatcher — config-file.ts doesn't store the return value
      }
      return (real.watch as (...a: unknown[]) => unknown)(p, ...args);
    },
  };
});

// ─── Import AFTER mock is registered ─────────────────────────────────────────

import {
  type ConfigFile,
  isAuthEnabled,
  isContainerEnv,
  isWorktreeEnabled,
  loadConfigFile,
  reloadConfigFile,
  validateApiToken,
} from "../config/config-file";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Reset mock state and module cache before each test. */
function setConfig(obj: ConfigFile | null) {
  if (obj === null) {
    mockFileExists = false;
    mockFileContent = "{}";
  } else {
    mockFileExists = true;
    mockFileContent = JSON.stringify(obj);
  }
  reloadConfigFile();
}

/** Save original ENV value and restore after all tests. */
const originalEnv = process.env.ENV;
afterAll(() => {
  if (originalEnv === undefined) {
    delete process.env.ENV;
  } else {
    process.env.ENV = originalEnv;
  }
});

beforeEach(() => {
  setConfig(null); // start each test with empty config / no file
  delete process.env.ENV;
});

// ─── loadConfigFile ───────────────────────────────────────────────────────────

describe("loadConfigFile", () => {
  test("returns {} when config file does not exist", () => {
    mockFileExists = false;
    reloadConfigFile();
    expect(loadConfigFile()).toEqual({});
  });

  test("parses valid JSON config", () => {
    setConfig({ debug: true, port: 9000 });
    const cfg = loadConfigFile();
    expect(cfg.debug).toBe(true);
    expect(cfg.port).toBe(9000);
  });

  test("returns {} on malformed JSON (silent fallback)", () => {
    mockFileExists = true;
    mockFileContent = "not valid json }{";
    reloadConfigFile();
    expect(loadConfigFile()).toEqual({});
  });

  test("caches result on repeated calls", () => {
    setConfig({ debug: true });
    const a = loadConfigFile();
    const b = loadConfigFile();
    expect(a).toBe(b); // same object reference
  });

  test("reloadConfigFile() busts cache", () => {
    setConfig({ debug: true });
    const a = loadConfigFile();
    setConfig({ debug: false });
    const b = loadConfigFile();
    expect(a).not.toBe(b);
    expect(b.debug).toBe(false);
  });
});

// ─── ConfigFile interface field coverage ─────────────────────────────────────

describe("ConfigFile shape", () => {
  test("accepts all documented optional fields", () => {
    const full: ConfigFile = {
      host: "localhost",
      port: 3000,
      debug: false,
      yolo: true,
      root: "/projects",
      contextMode: false,
      dataDir: "/data",
      uiDir: "/ui",
      providers: { openai: {} },
      env: { GEMINI_API_KEY: "key" },
      quotas: { daily_image_limit: 50 },
      worker: { chan1: ["token"] },
      vision: { provider: "gemini", model: "gemini-1.5-flash" },
      browser: false,
      memory: true,
      heartbeat: { enabled: true, intervalMs: 10000 },
      auth: { token: "abc" },
      model_token_limits: { anthropic: { "claude-3": 200000 } },
      worktree: true,
      author: { name: "Bot", email: "bot@example.com" },
    };
    // Type check: all fields assignable (compile-time) + loadable at runtime
    setConfig(full);
    const loaded = loadConfigFile();
    expect(loaded.port).toBe(3000);
    expect(loaded.host).toBe("localhost");
    expect(loaded.dataDir).toBe("/data");
  });
});

// ─── isContainerEnv ───────────────────────────────────────────────────────────

describe("isContainerEnv", () => {
  test("returns false when ENV is not set", () => {
    delete process.env.ENV;
    expect(isContainerEnv()).toBe(false);
  });

  test("returns true when ENV=dev", () => {
    process.env.ENV = "dev";
    expect(isContainerEnv()).toBe(true);
  });

  test("returns true when ENV=prod", () => {
    process.env.ENV = "prod";
    expect(isContainerEnv()).toBe(true);
  });

  test("returns true when ENV=staging", () => {
    process.env.ENV = "staging";
    expect(isContainerEnv()).toBe(true);
  });

  test("returns false for arbitrary ENV values", () => {
    process.env.ENV = "local";
    expect(isContainerEnv()).toBe(false);
    process.env.ENV = "test";
    expect(isContainerEnv()).toBe(false);
    process.env.ENV = "DEV"; // case-sensitive
    expect(isContainerEnv()).toBe(false);
  });
});
// ─── isWorktreeEnabled (structural parity with isWorkspacesEnabled) ───────────

describe("isWorktreeEnabled", () => {
  test("false when absent", () => {
    setConfig({});
    expect(isWorktreeEnabled()).toBe(false);
  });

  test("true when worktree: true", () => {
    setConfig({ worktree: true });
    expect(isWorktreeEnabled()).toBe(true);
    expect(isWorktreeEnabled("any-channel")).toBe(true);
  });

  test("channel-array matching", () => {
    setConfig({ worktree: ["main", "feature"] });
    expect(isWorktreeEnabled("main")).toBe(true);
    expect(isWorktreeEnabled("hotfix")).toBe(false);
    expect(isWorktreeEnabled()).toBe(true); // array non-empty
  });
});

// ─── auth helpers ────────────────────────────────────────────────────────────

describe("isAuthEnabled / validateApiToken", () => {
  test("auth disabled when no auth field", () => {
    setConfig({});
    expect(isAuthEnabled()).toBe(false);
  });

  test("auth enabled with legacy token", () => {
    setConfig({ auth: { token: "secret" } });
    expect(isAuthEnabled()).toBe(true);
  });

  test("validateApiToken returns true when auth disabled", () => {
    setConfig({});
    expect(validateApiToken("anything")).toBe(true);
  });

  test("validateApiToken validates legacy token", () => {
    setConfig({ auth: { token: "my-token" } });
    expect(validateApiToken("my-token")).toBe(true);
    expect(validateApiToken("wrong")).toBe(false);
    expect(validateApiToken(null)).toBe(false);
  });

  test("validateApiToken validates channel-based tokens", () => {
    setConfig({ auth: { dev: ["tok1", "tok2"], prod: ["tok3"] } });
    expect(validateApiToken("tok1", "dev")).toBe(true);
    expect(validateApiToken("tok3", "prod")).toBe(true);
    expect(validateApiToken("tok1", "prod")).toBe(false);
  });
});
