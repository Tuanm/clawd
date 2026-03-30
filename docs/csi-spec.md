# CSI — Codebase Symbol Index

**Version:** 1.0
**Status:** Draft
**Authors:** MiniMax Agent (research + design)
**Last Updated:** 2026-03-30

---

## 0. Getting Started (Implementation Roadmap)

New to this spec? Implement in this order:

1. **Set up the SQLite store** (`csi-store.ts`): Create `~/.clawd/data/csi.db` using the schema in §2.2. Apply the WAL pragmas, then run the migration runner (reuse `memory-migrations.ts` as a template). Test with `PRAGMA integrity_check`.

2. **Build the file enumeration** (`csi-indexer.ts`, Phase 1): Walk the project root with `fs`. Apply `isCsiExcluded()` from §9.1. Store results in the `files` table. Test by running it on a small project and comparing the row count against `find {root} -type f | wc -l` (minus ignored patterns).

3. **Add Tree-sitter symbol extraction** (`csi-parser.ts`, Phase 2): Wire up `tree-sitter` + `tree-sitter-javascript`. Parse each file's AST, extract symbols into the `symbols` table, and wire the FTS triggers so FTS rows stay in sync. Target: ≤ 30 s for 1,000 files.

4. **Build call graph and dependency edges** (Phases 3–4): Traverse the AST for call expressions and `import`/`require`/`from` statements. Populate `calls` and `dependencies`. Test by writing a file with known call chains and asserting the edge count.

5. **Wire the plugin hooks** (`codebase-index-plugin.ts`): Implement `onInit`, `onShutdown`, `onToolResult`, and `getSystemContext` as specified in §5.1. The `onInit` call to `ensureIndex()` kicks off the full pipeline asynchronously — do not await it.

6. **Register the `codebase_lookup` tool** (`codebase-lookup.ts`): Use `registerTool` from `registry.ts`. Pass `normalizeToolArgs` to the handler. Connect to the `csi-store` read path. Test with the concrete example in §5.3.

7. **Add delta sync** (Phase 4.1): Wire the 5-minute timer and `onToolResult` hook so edits trigger re-indexing. Implement the WAL checkpoint strategy from §2.1. Test by editing a file and checking the symbols table is updated within one delta cycle.

**Implementation dependencies (read order matters):**
- Read §1 (Overview) and §0 (this section) first.
- Read §2 (Architecture) before writing any code — it defines the DB schema and WAL pragmas that everything else depends on.
- Read §5 (Integration) after §2 — it explains how the plugin hooks into the agent.
- Read §9 (Security) before connecting any external inputs (file paths, tool args) to the SQL layer.

---

## 1. Overview

### Problem

Every new task re-explores the codebase because exploration results aren't cheaply reusable. Agents burn thousands of tokens re-reading files they've already visited, wasting context window and budget.

### Solution

CSI is a **persistent, project-scoped index** of the codebase's structure that agents query instead of re-reading files. It stores:

- File tree (no content)
- Symbol map (functions, classes, interfaces, types)
- Call graph (who calls whom)
- Dependency graph (imports/exports)
- Git history signals (recent changes)
- Semantic pattern tags

**Target index size:** ~50–200 KB for large codebases (vs. potentially 500K+ tokens of verbose exploration output).

**Token win:** A query that would normally cost ~80K tokens returns ~200–500 tokens of focused results.

---

## 2. Architecture

### 2.1 Storage

**Location:** `~/.clawd/data/csi.db` (SQLite with WAL)

This places the index alongside `memory.db` (at `~/.clawd/data/memory.db`) in the shared Claw'd data directory. CSI is project-scoped by the files it indexes (not by DB path); file paths in the DB are relative to the project root passed at `onInit` time.

**Required pragmas** (set at connection open, before any schema DDL):
```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 30000;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;   -- 64 MB page cache (use -8000 in containers)
PRAGMA mmap_size = 268435456; -- 256 MB memory-mapped I/O (set to 0 in containers)
PRAGMA wal_autocheckpoint = 4096; -- Checkpoint WAL to disk every ~16 MB of writes; keeps WAL bounded under heavy indexing
```
> **Container detection:** Follow the same `ENV` env-var pattern used in `AgentMemoryStore.setupConcurrency()` — check for `ENV=dev|prod|staging` to disable `mmap_size` and reduce `cache_size`. The pragmas above show non-container defaults; apply the conditional logic from `agent-memory.ts` lines 146–148.
Use `getDataDir()` from `src/config-file.ts` for the path. Reuse the same migration runner pattern as `memory-migrations.ts`.

**WAL lifecycle:** Without an explicit `wal_autocheckpoint`, SQLite defaults to checkpointing every ~2000 pages (~8 MB). Under heavy re-indexing (thousands of file updates), the WAL can grow to 100+ MB before auto-checkpointing fires. Implement the following in `csi-store.ts`:

```typescript
// After each bulk-write transaction (full index, delta sync, or re-index):
this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
// TRUNCATE mode: checkpoint and delete the WAL file, resetting its size to 0.
// Use PASSIVE if you cannot block (readers are active); PASSIVE does not truncate.
//
// WAL size guard: before opening for reads, check file size of csi.db-wal.
// If it exceeds 50 MB, run "PRAGMA wal_checkpoint(TRUNCATE)" proactively before
// serving queries. This prevents WAL bloat from degrading read latency.
```

The `TRUNCATE` variant is safe to use after index builds complete (no active readers). During delta sync while agents may be querying, use `PASSIVE` instead, or skip the checkpoint and rely on the 4096-page autocheckpoint to keep WAL bounded. Monitor WAL size in the background; log a warning if WAL exceeds 100 MB.

**Database path resolution:**
```
newDefault:  {DATA_DIR}/csi.db   (= ~/.clawd/data/csi.db via getDataDir())
oldFallback: ~/.clawd/projects/{hash}/csi.db  (v0 path — migrate if found)
```

> ⚠️ `getDataDir()` lives in **`src/config-file.ts`**, NOT `src/agent/utils/agent-context.ts`. The latter exports `getContextProjectRoot()` / `getContextProjectHash()` for per-agent context — no `getDataDir` exists there. Use `getDataDir()` (config-file) + `getContextProjectRoot()` (agent-context) together.

### 2.2 Database Schema

```sql
-- File tree: directory listing (no file content)
CREATE TABLE files (
  id          INTEGER PRIMARY KEY,
  path        TEXT    NOT NULL UNIQUE,  -- relative to project root
  kind        TEXT    NOT NULL,         -- 'file' | 'directory' | 'symlink'
  size_bytes  INTEGER,
  mtime       INTEGER,                  -- Unix timestamp
  indexed_at  INTEGER NOT NULL
);

-- Symbols: function/class/interface/type declarations
CREATE TABLE symbols (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id),
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,         -- 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'var'
  signature   TEXT,                      -- full signature string e.g. "loginUser(email: string, pw: string): Promise<User>"
  line_start  INTEGER NOT NULL,
  line_end    INTEGER,
  visibility  TEXT    DEFAULT 'public',  -- 'public' | 'private' | 'protected' | 'internal'
  is_async    INTEGER  DEFAULT 0,       -- 1 if function is async
  lang        TEXT,                      -- 'typescript' | 'javascript' | 'python' etc.
  indexed_at  INTEGER NOT NULL
);

-- Call graph: who calls whom (edges in the call graph)
CREATE TABLE calls (
  id              INTEGER PRIMARY KEY,
  caller_file_id  INTEGER NOT NULL REFERENCES files(id),
  caller_sym_id   INTEGER REFERENCES symbols(id),
  callee_file_id  INTEGER NOT NULL REFERENCES files(id),
  callee_sym_id   INTEGER REFERENCES symbols(id),
  line_number     INTEGER,
  call_type       TEXT DEFAULT 'direct',  -- 'direct' | 'dynamic' | 'callback' | 'event'
  indexed_at      INTEGER NOT NULL,
  UNIQUE(caller_sym_id, callee_sym_id, line_number)
);

-- Imports/exports: dependency edges
CREATE TABLE dependencies (
  id            INTEGER PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES files(id),
  target_module TEXT    NOT NULL,    -- e.g. "../utils/auth" or "lodash"
  target_type   TEXT    NOT NULL,    -- 'relative' | 'package' | 'builtin'
  imported_names TEXT,                -- JSON array e.g. '["foo", "bar"]'
  line_number   INTEGER,
  is_re_exported INTEGER DEFAULT 0,
  indexed_at    INTEGER NOT NULL
);

-- Semantic tags: human-readable pattern labels
CREATE TABLE pattern_tags (
  id       INTEGER PRIMARY KEY,
  file_id  INTEGER NOT NULL REFERENCES files(id),
  sym_id   INTEGER REFERENCES symbols(id),
  tag      TEXT NOT NULL,            -- e.g. "route-handler", "db-model", "auth", "middleware"
  source   TEXT DEFAULT 'regex',       -- 'regex' | 'llm' | 'inferred'
  confidence REAL DEFAULT 0.5,         -- 0.0–1.0
  indexed_at INTEGER NOT NULL
);

-- Git history: file change frequency signals
CREATE TABLE git_signals (
  id           INTEGER PRIMARY KEY,
  file_id      INTEGER NOT NULL REFERENCES files(id),
  change_count INTEGER DEFAULT 0,    -- commits touching this file in last 90 days
  last_commit  INTEGER,               -- Unix timestamp of last commit
  last_author  TEXT,                 -- author of last commit
  churn        REAL DEFAULT 0,        -- lines added + removed in last 90 days
  indexed_at   INTEGER NOT NULL
);

-- FTS5 virtual tables for fast search
CREATE VIRTUAL TABLE symbols_fts USING fts5(
  name, signature, tag,
  content='symbols',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE files_fts USING fts5(
  path,
  content='files',
  content_rowid='id',
  tokenize='porter unicode61'
);
-- Tag filtering is done via JOIN: JOIN pattern_tags pt ON f.id = pt.file_id WHERE pt.tag = ?
-- This avoids the non-deterministic GROUP_CONCAT ordering problem.

-- Metadata
CREATE TABLE meta (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
-- Insert: meta('version', '1.0'), meta('indexed_at', '{timestamp}'), meta('langs', 'typescript,javascript'), meta('project_root', '{resolved_absolute_path}')
-- ⚠️ project_root is required: on every open, compare meta('project_root') against getContextProjectRoot() and trigger a full re-index if they differ (e.g. the agent opened a different project). Store as an absolute path.

-- Required indexes (omitting these causes full-table scans on every join)
CREATE INDEX IF NOT EXISTS idx_symbols_file   ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name   ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_lang   ON symbols(lang);
CREATE INDEX IF NOT EXISTS idx_calls_caller   ON calls(caller_file_id, caller_sym_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee   ON calls(callee_file_id, callee_sym_id);
CREATE INDEX IF NOT EXISTS idx_deps_file      ON dependencies(file_id);
CREATE INDEX IF NOT EXISTS idx_deps_target    ON dependencies(target_module);
CREATE INDEX IF NOT EXISTS idx_tags_file      ON pattern_tags(file_id);
CREATE INDEX IF NOT EXISTS idx_tags_sym       ON pattern_tags(sym_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag        ON pattern_tags(tag);
CREATE INDEX IF NOT EXISTS idx_git_file       ON git_signals(file_id);
CREATE INDEX IF NOT EXISTS idx_files_mtime    ON files(mtime);

-- FTS5 triggers (mirrors the pattern from memory-migrations.ts)
CREATE TRIGGER IF NOT EXISTS symbols_fts_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, signature, tag)
    VALUES (new.id, new.name, COALESCE(new.signature,''), '');
END;
CREATE TRIGGER IF NOT EXISTS symbols_fts_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, tag) VALUES('delete', old.id, old.name, COALESCE(old.signature,''), '');
END;
CREATE TRIGGER IF NOT EXISTS symbols_fts_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, tag) VALUES('delete', old.id, old.name, COALESCE(old.signature,''), '');
  INSERT INTO symbols_fts(rowid, name, signature, tag) VALUES (new.id, new.name, COALESCE(new.signature,''), '');
END;

-- NOTE: The `tag` column in symbols_fts is populated only from the symbols.name and
-- symbols.signature fields above. Pattern tags from pattern_tags table are NOT mirrored
-- into symbols_fts — they are searched via JOIN on pattern_tags.tag = ? (see idx_tags_tag).
-- FTS search for tag keywords on symbols therefore searches symbol names/signatures,
-- not file-level pattern labels.

-- NOTE: pattern_tags.tag is indexed via idx_tags_tag (LIKE/= queries).
-- Do NOT use a subquery-backed FTS5 virtual table for files_fts — FTS5
-- content= subqueries have non-deterministic GROUP_CONCAT ordering and
-- cannot be kept in sync via triggers. Instead, search files.path via
-- files_fts and join pattern_tags separately when tag filtering is needed.
```

### 2.3 Indexing Pipeline

#### Phase 1: File Tree Enumeration

- Walk the project root recursively using Node.js `fs` (via the existing sandbox)
- Filter out ignored paths: `.git`, `node_modules`, `dist`, `build`, `.next`, `__pycache__`, `*.pyc`, `vendor/`, etc.
- Store path, kind, size, mtime (modification time)
- **Incremental:** compare mtime against last indexed value; skip unchanged files

#### Phase 2: Symbol Extraction

Parse each source file using **Tree-sitter** (`tree-sitter` npm package + per-language grammar packages):

```sh
bun add tree-sitter
bun add tree-sitter-javascript  # TypeScript + JavaScript
# bun add tree-sitter-python     # add as needed for v1+
```

> **Note:** `@tree-sitter/node` does not exist. The correct packages are `tree-sitter` (runtime) and `tree-sitter-LANG` (grammar). TypeScript support requires `tree-sitter-javascript` with a `.parse(src, { parser: { lang: "typescript" } })` config or the separate `tree-sitter-typescript` grammar.

**File size cap:** Skip files larger than 5 MB. Log a warning and skip. These are almost always generated artifacts, not hand-written code worth indexing.
> **Note:** Open Question #4 ("chunk files >10,000 lines") is superseded by the 5 MB skip rule. Use the size cap as the single, unambiguous gate. Large hand-written files over 5 MB are vanishingly rare; if encountered, log and skip rather than chunk (chunking complicates symbol boundary tracking and is not worth the complexity for v1).

- **TypeScript/JavaScript:** Extract function declarations, class definitions, interface declarations, type aliases, enums, const/var exports
- **Python** *(v2 — see Open Question #2)*: Extract `def`, `class`, `async def`
- **SQL:** Extract CREATE TABLE, CREATE INDEX, CREATE VIEW
- **General:** Use regex fallback for unknown file types

For each symbol, store:
- `name`, `kind`, `signature` (human-readable: `"loginUser(email: string, pw: string): Promise<User>"`)
- `line_start`, `line_end`
- `visibility` (inferred from naming conventions or TypeScript `export` keyword)
- `is_async`
- `lang`

**Pipeline bounding (large monorepo protection):**
- **Batch size:** Process files in batches of **≤ 100 files** per transaction. After each batch, `db.exec("PRAGMA wal_checkpoint(TRUNCATE)")` to checkpoint WAL and keep WAL size bounded. Do not hold a DB write transaction open across more than 100 files.
- **Memory guard:** After parsing each file's AST, immediately extract symbols and discard the AST — do not accumulate ASTs across files. Peak heap during Phase 2 should stay ≤ 50 MB regardless of project size.
- **Phase 2 time budget:** If Phase 2 exceeds **120 seconds** for a full index, abort the current run, checkpoint, and return partial results with `partial: true`. The next delta cycle will resume from where it left off. This prevents a pathological codebase (e.g., 50K-line generated files, deeply recursive macros) from blocking the agent indefinitely.
- **Parallelism cap:** Parse no more than **8 files concurrently** in `Promise.all()` batches. More parallelism increases peak memory and CPU contention on I/O-bound parsing; 8 is a safe ceiling for typical developer machines.

#### Phase 3: Call Graph Construction

Traverse each file's AST to extract call expressions:

```
login() {
  verifyToken(token)     → calls: verifyToken
  db.query(...)           → calls: db.query (dynamic)
}
```

Call types:
- `direct`: static call `foo()`
- `dynamic`: `obj[methodName]()`
- `callback`: passed as argument `map(fn)`
- `event`: `.on('event', handler)`

Store as directed edges: `calls(caller_sym, callee_sym)`.

> **Traversal safety (also see §4.1):** During any index-time traversal of the call graph (e.g., for inferred tagging), track visited `(symbol_id, file_id)` pairs and abort if a pair re-appears in the same chain. Cap traversal depth at **50 levels** to bound CPU use on pathological codebases.
#### Phase 4: Dependency Graph

Parse `import`/`require`/`from` statements:

```
import { foo, bar } from '../utils'
→ dependencies: "../utils" imports ["foo", "bar"]
```

Also track re-exports: `export { foo } from './x'`.

#### Phase 5: Pattern Tagging

Three tagging sources:

1. **Regex rules** (fast, synchronous, runs in critical path):
   ```text
   route-handler: /router\.(get|post|put|delete|patch)/, /app\.(get|post|...)/, /@.*Route/
   db-model:      /class.*extends.*Model/, /sequelize\.define/, /prisma\./, /type.*Schema/
   auth:          /authenticate|authorization|login|logout|signup|token|jwt|oauth/
   middleware:    /middleware|interceptor|beforeEach|afterEach|use\(.*\)/
   component:    /class.*extends.*Component|function.*=.*\(|React\.|Vue\.|@Component/
   test:         /\.test\.|\.spec\.|_test\.|\bdescribe\b|\bit\(/
   config:       /config\.|env\.|settings|options/
   ```

2. **LLM inference** (slow, runs in a background task after initial index completes):
   - Run a lightweight LLM call (fastModel, ~100 tokens in) on each file to assign 1–3 pattern tags
   - Only for files that regex couldn't classify
   - Batch: group 10 files per LLM call
   - **Runs asynchronously** — do NOT block the initial index build. Insert placeholder rows with `source='llm-pending'` during initial index so agents can see LLM tagging is in-flight. When the background task completes, `UPDATE pattern_tags SET source='llm' WHERE source='llm-pending' AND id IN (...)` to mark confirmed results.

3. **Inferred from call graph**:
   - Files called by route handlers → `api`
   - Files defining classes used by route handlers → `handler`
   - Files in `db/` or `models/` → `db`

#### Phase 6: Git History Signals

> **Run this in a separate async step after the main index write**, not as part of the 30-second critical path.

Run `git log --since="90 days ago" --name-only --format="%H %ad %aN"` on the project:

- Count commits per file → `change_count`
- Get last commit timestamp → `last_commit`
- Get last author → `last_author`
- Count lines added/removed → `churn`

Files with high `churn` or recent `last_commit` are marked as "active" and get elevated relevance in queries.

---

## 3. Query Interface

### 3.1 `codebase_lookup` Tool

> **Query caching:** Implement an in-process LRU cache keyed on `(keywords_sorted, mode, lang, file_path, limit)`. Cache TTL is **5 seconds** (within a 5-second window, repeated identical queries hit memory instead of SQLite). This prevents thundering-herd degradation when an agent issues back-to-back identical `codebase_lookup` calls. Cache size limit: **128 entries** max. Evict oldest on overflow. Cache is **not** shared across plugin instances (single plugin instance = single cache, which is correct).

```typescript
interface CodebaseLookupArgs {
  keywords: string[] | string;    // Search terms. A single string is accepted and coerced to [string] by normalizeToolArgs before processing.
  mode?: "symbol" | "deep" | "structure" | "graph";
  limit?: number;               // Max results per query (default: 10)
  lang?: string;                 // Filter by language. Accepted values: "typescript", "javascript", "python", "sql". Partial match accepted (e.g. "ts" → "typescript").
  file_path?: string;            // Scope to a file or directory (prefix match)
  task_type?: "bug-fix" | "feature" | "refactor" | "docs" | "review" | "any";
                                   // ⚠️ Reserved for v2 scoring hooks — has no effect on relevance in v1.
  include_callers?: boolean;     // Include direct caller symbols (1 hop only; use mode=graph for multi-hop chains)
  include_callees?: boolean;     // Include direct callee symbols (1 hop only; use mode=graph for multi-hop chains)
  kind_filter?: ("function" | "class" | "interface" | "type" | "enum" | "const" | "var")[];
                                   // Filter results by symbol kind. Omit to return all kinds.
  exclude_path?: string[];       // Exclude paths with any of these prefixes (e.g. ["test/", "dist/"])
}

interface CodebaseLookupResult {
  symbols?: SymbolEntry[];       // mode=symbol (default)
  files?: FileEntry[];           // mode=structure
  graph?: GraphEntry[];          // mode=graph
  deep?: DeepEntry[];            // mode=deep
  tokens_used: number;            // Approximate token cost of this response
  index_age_seconds: number;      // How old the index is
  is_stale: boolean;              // True if index is >1h old
  is_building?: boolean;           // True if a full index build is currently in progress
  partial?: boolean;              // True if results may be incomplete (stale index, in-progress build, or caller/callee expansion timed out)
}

interface SymbolEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
  signature: string;
  tags: string[];
  relevance_score: number;         // 0.0–1.0
  is_active: boolean;             // True if file modified in last 30 days (mtime), OR
                                  // git_signals.last_commit is within 90 days (git_history signal).
                                  // If neither signal is available, default to false.
}

interface FileEntry {
  path: string;                     // Relative to project root
  kind: "file" | "directory" | "symlink";
  size_bytes?: number;
  mtime?: number;                  // Unix timestamp
  tags: string[];
  symbol_count: number;            // Number of symbols defined in this file
  is_active: boolean;              // True if file changed in last 30 days
}

interface GraphEntry {
  from_name: string;               // Calling symbol name
  from_file: string;               // File containing the caller
  from_line: number;                // Line of the call expression site
  to_name: string;                 // Called symbol name
  to_file: string;                 // File containing the callee
  to_line: number;                  // Declaration line of the callee symbol
  call_type: "direct" | "dynamic" | "callback" | "event";
  depth: number;                   // 1 = direct neighbor of root matched symbol; 2 = caller-of-caller; max 3
  relevance_score: number;          // 0.0–1.0 (propagated from the root matched symbol's FTS rank)
}

interface DeepEntry {
  file: string;
  content: string;               // Window centered on best match; max 200 lines total; truncated at file boundaries if match is near start/end
  line_start: number;             // Start line of the window
  line_end: number;               // End line of the window (may be < line_start + 200 if near EOF)
  matched_keywords: string[];    // Which of the input keywords matched within this window
}
```

### 3.2 Relevance Scoring

Each result is scored using a weighted sum of five normalized signals. All sub-scores are normalized to **[0, 1]** before weighting:

```
relevance_score =
  fts_rank      × 0.30   // Normalized BM25 rank from FTS5 (see normalization below)
+ tag_match     × 0.20   // 1.0 if any keyword matches a pattern_tag; else 0.0
+ recency       × 0.25   // 1.0 if file modified <7 days ago; sigmoid decay to 0.0 at 90 days
+ git_activity  × 0.15   // Normalized churn = file_churn / max_churn_across_all_files
+ access_freq   × 0.10   // In-degree in call graph, normalized by max_in_degree (see below)
```

**`fts_rank` normalization:** Raw BM25 scores are unbounded. Normalize as `normalized = (raw - min_raw) / (max_raw - min_raw)` over the result set for the current query. If all scores are identical, use `0.5`.

**`access_freq` formula:** `access_freq = caller_count_for_this_symbol / max(caller_count_across_all_symbols)`. `caller_count` = number of distinct `caller_sym_id` rows in `calls` where this symbol is the callee. Symbols with no callers get `0.0`. The denominator `max(...)` is computed per-query from the result set.

**`recency` formula:** `recency = sigmoid((days_since_last_change - 7) / 20)`, scaled so that `recency = 1.0` at ≤7 days and `recency → 0.0` at ≥90 days. Files with no git history default to `recency = 0.5`.

> **`task_type` is reserved for v2** — it currently has no effect on scoring weights. Do not rely on it in v1 implementations.

### 3.3 Output Modes

| Mode | Use Case | Token Cost |
|---|---|---|
| `symbol` | "where is the auth function?" | ~100–300 tokens |
| `structure` | "what does the project look like?" | ~200–500 tokens |
| `graph` | "trace the call chain for this endpoint" | ~200–800 tokens |
| `deep` | "read the actual code of auth.ts" | ~500–2000 tokens |

### 3.4 Concrete Query Example

**Query:** `codebase_lookup({ keywords: ["auth", "login"], mode: "symbol", limit: 3 })`

```json
{
  "symbols": [
    {
      "name": "loginUser",
      "kind": "function",
      "file": "src/auth/service.ts",
      "line": 42,
      "signature": "loginUser(email: string, pw: string): Promise<User>",
      "tags": ["auth", "handler"],
      "relevance_score": 0.91,
      "is_active": true
    },
    {
      "name": "AuthService",
      "kind": "class",
      "file": "src/auth/service.ts",
      "line": 10,
      "signature": "class AuthService",
      "tags": ["auth"],
      "relevance_score": 0.87,
      "is_active": true
    },
    {
      "name": "loginForm",
      "kind": "function",
      "file": "src/auth/frontend.tsx",
      "line": 15,
      "signature": "loginForm(props: LoginProps): JSX.Element",
      "tags": ["component"],
      "relevance_score": 0.62,
      "is_active": false
    }
  ],
  "tokens_used": 387,
  "index_age_seconds": 180,
  "is_stale": false,
  "is_building": false,
  "partial": false
}
```

**How to interpret the result:**
- `relevance_score` is a 0.0–1.0 weighted sum of FTS rank (30%), tag match (20%), recency (25%), git churn (15%), and call-graph in-degree (10%) — see §3.2.
- `is_active: true` means the file was touched in the last 30 days (mtime) or had a git commit in the last 90 days. A new implementer should prioritize files with `is_active: true` for understanding current behavior.
- `tags` come from the pattern tagger (Phase 5) — `["auth", "handler"]` on `loginUser` means regex matched an auth pattern AND an inferred handler tag from the call graph.
- If the result were empty, fall back to `knowledge_search` from KnowledgeBase (see §7 error table row: "No results found").

---

## 4. Incremental Indexing

### 4.1 Delta Sync Strategy

Inspired by Cursor's 5-minute delta sync:

1. **On agent `onInit`:** Check if index exists. If not, run full index. If yes, check `git diff --name-only` for changed files since last index.
2. **Every 5 minutes (background timer):** Re-scan for mtime changes on all tracked files.
3. **On file change event:** If workspace plugin detects a file save, trigger re-index for that file only.
4. **On `git commit`:** Re-run git history signals for changed files.
5. **File rename/move handling:** `git diff --name-only` shows deleted + added paths for renamed files. On delta sync, cross-reference the set of deleted paths against added paths by inode/device (from `fs.stat`). If a deleted path and an added path share the same device + inode on non-Windows systems, treat it as a rename: update `files.path` in-place. **Caveat:** inode comparison is unreliable on Windows and some network/overlay filesystems (NFS, container tmpfs) — in those cases fall back to delete + re-insert; log at debug level.

**Delta sync timing:** Measure elapsed milliseconds for each completed delta sync cycle and store in the CSI plugin instance state as `last_delta_ms`. This value is surfaced via `stats().last_delta_ms` (see §6.3) and emitted as `elapsedMs` on the `delta:sync` log event (§6.2).

**Never block the agent on indexing.** Index runs asynchronously; agent uses stale index if building.

**Concurrent reads during re-index:** WAL mode allows concurrent readers without blocking writers. `codebase_lookup` queries served during an active index build return results from the last committed snapshot — they are not degraded by in-progress writes. However, long-running transactions (the index build itself) hold a SHARED lock; WAL readers take a SHARED lock too, so they proceed without blocking each other. WAL auto-checkpoint (every ~16 MB of writes) may briefly pause writers to do a checkpoint, which can add a few milliseconds to a concurrent `codebase_lookup` call. This is acceptable. If WAL grows very large (>50 MB) without checkpointing, reader I/O increases; use the WAL checkpoint strategy in §2.1 to prevent this.

**Safety guards:**
- **OOM protection:** Parse files in a streaming fashion, never load >1 file into memory simultaneously. Use `readFileStream` or read then discard — do not accumulate parsed ASTs.
- **Circular call graph:** Track visited `(caller_sym_id, path_set)` pairs during traversal; abort if depth > 50 or a (symbol, file) pair re-appears in the same call chain.
- **`deep` mode is not parallel-safe:** It reads file content from disk, so it must not be registered as `readOnly: true`. Remove `readOnly: true` from the `deep` mode variant.

### 4.2 Stale Detection

- Index older than **1 hour** → `is_stale = true` in results
- Index older than **24 hours** → warn the user "CSI index is stale, re-indexing in background"
- Full re-index triggered if >7 days old or project root changed

---

## 5. Integration with Existing Systems

### 5.1 Plugin Hooks

The CSI plugin (`codebase-index-plugin.ts`) registers these hooks. All hooks receive `PluginContext` from `src/agent/plugins/manager.ts`:

```typescript
// PluginContext fields used by CSI (from manager.ts):
interface PluginContext {
  agentId: string;
  sessionId?: string;
  model: string;
  currentMessageTs?: string;  // Timestamp of message being processed
  llmClient?: CopilotClient; // LLM client; CSI uses this for Phase 5 LLM tagging
}

// onInit → load or build index
async onInit(ctx: PluginContext) { await this.ensureIndex(); }

// onShutdown → clean up resources (close DB handle, stop file watchers)
// Called automatically by PluginManager.shutdown() when the agent exits.
async onShutdown() { this.close(); }

// beforeCompaction → no-op (CSI index is on disk, not in the message context)
// Compaction has no effect on the CSI index. No state needs to be extracted or serialized.
async beforeCompaction(droppedMessages: any[], ctx: PluginContext) {}

// onToolResult → after edit/write/write-file tools, update mtime so delta sync
// picks up the change without waiting for the next 5-min scan.
// NOTE: This is the correct trigger set. Do NOT use 'view' or 'glob' — those
// are read-only and do not modify files. The 'edit'/'write'/'write-file' tools
// are the only ones that can change file content.
async onToolResult(name: string, result: any, ctx: PluginContext) {
  if (['edit', 'write', 'write-file'].includes(name)) {
    await this.touchFilesFromToolArgs(result);
  }
}

// getSystemContext → inject brief index summary into system prompt
async getSystemContext(ctx: PluginContext): Promise<string | null> {
  const age = this.getIndexAge();
  if (age > 3600) return null; // Don't inject if stale
  return `CSI: ${this.stats().file_count} files, ${this.stats().symbol_count} symbols indexed ${age < 60 ? 'just now' : ` ${Math.round(age/60)}m ago`}`;
}
```

> **Additional hooks available:** `PluginHooks` also includes `transformToolArgs` (inspect or modify tool args before execution) and `getMcpServers` (declare MCP server dependencies). Neither is required for the core CSI implementation.

**Required helper methods** (implement in `codebase-index-plugin.ts`):
- `ensureIndex(): Promise<void>` — entry point; runs full or delta index asynchronously.
- `getIndexAge(): number` — returns seconds since `meta('indexed_at')` was last written.
- `stats(): { file_count: number; symbol_count: number }` — reads `COUNT(*)` from the `files` and `symbols` tables. Must not mutate any state.
- `touchFilesFromToolArgs(result: any): Promise<void>` — extracts file paths from the tool result object (supports `edit`/`write`/`write-file` result shapes) and calls `UPDATE files SET mtime = unixepoch() WHERE path = ?` for each. Silently skips paths not in the index.

### 5.2 Relationship with Other Systems

| System | Relationship |
|---|---|
| **KnowledgeBase** | CSI serves structure; KB serves exploration outputs. `codebase_lookup` falls back to KB if CSI returns no results. |
| **AgentMemoryStore** | Separate concerns: CSI = codebase structure, AgentMemory = conversation facts. CSI does NOT store memories. |
| **WorkspacePlugin** | WorkspacePlugin (Docker container manager) does NOT provide file change notifications. CSI must implement its own file watcher (e.g., fs.watch or chokidar) in the main process outside the sandbox. See §4.1 item 3. |
| **explore sub-agent** | The generic SubAgent class (src/agent/subagent/) runs exploration tasks. CSI should hook SubAgentPlugin.onComplete to receive results when an explore task finishes, then index them. Future explore tasks should call codebase_lookup first as a pre-explore check. If no specific explore sub-agent exists yet, register a SubAgentPlugin hook on the agent's SubAgentPluginManager. |
| **GitTools** | CSI git_signals table uses git log. If git tools aren't available, skip Phase 6. |

### 5.3 Tool Registration

`codebase_lookup` is **NOT read-only** when `mode=deep` (it reads file content from disk). Register without `readOnly: true`. The `symbol`, `structure`, and `graph` modes are functionally read-only, but the tool as a whole must not claim `readOnly: true` since `deep` mode is not.

```typescript
// Use normalizeToolArgs from src/agent/tools/registry.ts to handle LLM quirks
// (e.g. receiving keywords as a plain string instead of string[]).
import { registerTool, normalizeToolArgs } from '../tools/registry';

registerTool(
  'codebase_lookup',
  'Query the persistent codebase symbol index. Use this instead of re-reading files when you need to locate functions, classes, or understand project structure.',
  {
    keywords:      { type: 'array',  description: 'Search terms (string or string[]; normalizeToolArgs handles coercion).', items: { type: 'string' } },
    mode:          { type: 'string',
                     description: 'symbol (find function/class by name) | deep (read actual code) | structure (file tree) | graph (call chain). Default: symbol. See §3.3 for the full mode table.',
                     default: 'symbol' },
    limit:         { type: 'number', description: 'Max results per query', default: 10 },
    lang:          { type: 'string', description: 'Filter by language (typescript, javascript, python, sql)' },
    file_path:     { type: 'string', description: 'Scope to a file or directory (prefix match)' },
    task_type:     { type: 'string',
                     description: 'bug-fix | feature | refactor | docs | review | any. Reserved for v2 scoring — has no effect in v1. Do not rely on this parameter yet.',
                     default: 'any' },
    include_callers: { type: 'boolean', description: 'Include direct caller symbols (1 hop)' },
    include_callees: { type: 'boolean', description: 'Include direct callee symbols (1 hop)' },
    kind_filter:   { type: 'array',
                     description: 'Filter by symbol kind. Valid values: function, class, interface, type, enum, const, var. Omit to return all kinds.',
                     items: { type: 'string' } },
    exclude_path:  { type: 'array',  description: 'Exclude paths with these prefixes', items: { type: 'string' } },
  },
  ['keywords'],  // required
  async (rawArgs) => {
    const args = normalizeToolArgs(rawArgs);
    return codebase_lookup_handler(args);
  },
  false  // NOT readOnly: mode=deep reads file content from disk
);
```

> **Alternative registration path:** The `ToolPluginManager` in `src/agent/tools/plugin.ts` accepts `parameters: Record<string, ToolParameter>` (typed schema). Either registration path works — prefer `registerTool` from `registry.ts` if CSI is loaded as a standalone plugin; use `ToolPluginManager` if CSI tools are registered alongside other plugin tools via a single manager instance.

#### Tool Decision Matrix

Use this matrix to choose the right tool:

| Situation | Recommended Tool | Why |
|---|---|---|
| "Where is function X defined?" | `codebase_lookup` mode=symbol | Direct symbol lookup, no file I/O |
| "What does the project structure look like?" | `codebase_lookup` mode=structure | Fast file tree from index |
| "Trace the call chain for endpoint Y" | `codebase_lookup` mode=graph | Call graph traversal |
| "Show me the actual code of auth.ts" | `codebase_lookup` mode=deep | File content with match context |
| "Find all usages of variable X in code" | `grep` | Regex search over actual file content |
| "Show me lines 40–60 of auth.ts" | `view` | Exact file content, no index needed |
| "List all .test.ts files in src/" | `glob` | File path pattern matching |
| "I need context before the index is built" | `grep` / `view` / `glob` | These tools work without any index |
| "I need file content for a file not yet indexed" | `view` | Reads directly from disk |
| "The index might be stale for this file" | `view` | Bypasses index, always current |

> **Tip:** `codebase_lookup` costs ~50ms and returns ~200–500 tokens. `grep` + `view` for the same query can cost 10× more tokens and 5–10× more time on large codebases. Prefer `codebase_lookup` for navigation and orientation; use `grep`/`view` for deep content investigation.

---


## 6. Testing & Verification

### 6.1 Phase-Level Acceptance Tests

Each phase of the indexing pipeline has specific, verifiable outputs. Implementers should write tests that assert these invariants after every code change.

#### Phase 1 — File Tree Enumeration
```
✓ files table row count matches find {root} -type f | wc -l (minus ignored patterns)
✓ no row has kind = 'file' and path ends with an ignored pattern (.git/, node_modules/, etc.)
✓ mtime matches stat().mtimeMs / 1000 for at least 5 spot-checked files
✓ incremental: adding a file to the project root appears in the DB within one delta cycle
✓ incremental: deleting a file from disk disappears from DB within one delta cycle
✓ files larger than 5 MB are absent from the DB
```

#### Phase 2 — Symbol Extraction
```
✓ every symbols row has non-null name, kind, line_start, lang
✓ for TypeScript files, symbols.kind in {function, class, interface, type, enum, const, var}
✓ async functions have is_async = 1
✓ exported symbols have visibility = 'public'
✓ no symbol has line_end < line_start
✓ symbols_fts FTS table row count >= symbols table row count (FTS populated on insert via triggers)
✓ Phase 2 runs in the main process (not the sandbox) — tree-sitter needs local .node grammar files
  and file I/O access; sandboxed tool execution cannot reach ~/.clawd/node_modules or the project root
  reliably for Phase 2 parsing. Run csi-indexer.ts in the main process, not via a sandboxed tool call.
```

#### Phase 3 — Call Graph
```
✓ no duplicate edges in calls table (UNIQUE constraint enforced)
✓ no self-loop (caller_sym_id != callee_sym_id) unless the function is genuinely recursive
✓ circular call chain of depth > 50 is aborted — test with a synthetic mutual-recursion file
✓ call_type is one of {direct, dynamic, callback, event}
```

#### Phase 4 — Dependency Graph
```
✓ every dependencies row has target_type in {relative, package, builtin}
✓ imported_names is valid JSON array (or NULL) — parse it to verify
✓ re-exports (export { foo } from './x') have is_re_exported = 1
```

#### Phase 5 — Pattern Tagging
```
✓ every pattern_tags row has tag in the known tag vocabulary
✓ confidence in [0.0, 1.0]
✓ source in {regex, llm, inferred, llm-pending}
✓ files with no regex match get source = 'llm-pending' before LLM batch runs, then updated
✓ pattern_tags.tag column is queried via idx_tags_tag (covered index scan, not full table scan)
```

#### Phase 6 — Git History Signals
```
✓ git_signals rows only exist for files already in the files table
✓ change_count >= 0; churn >= 0
✓ last_commit <= current Unix timestamp (future timestamps indicate clock skew — log warning)
✓ when git is unavailable, git_signals table is empty and all files have is_active = false, recency = 0.5
```

#### End-to-End
```
✓ Full index of a 1,000-file project completes in < 30 seconds
✓ codebase_lookup query returns in < 50 ms
✓ After a file edit, the symbol table reflects the new symbol within one 5-minute delta cycle
✓ index_age_seconds in results matches actual time since last write
✓ is_stale is false within 1 hour of last write, true after
✓ PRAGMA integrity_check returns 'ok'
```

### 6.2 Structured Logging

CSI emits structured log events via `console.error` with the prefix `[CSI]`. All events include `{ phase, projectRoot, elapsedMs }`:

| Event | When | Extra fields |
|---|---|---|
| `index:start` | Full index begins | `fileCount` (estimated) |
| `index:phase:start` | Each phase begins | `phase` (1-6) |
| `index:phase:done` | Each phase completes | `phase`, `rowsIndexed`, `rowsSkipped` |
| `index:done` | Full index completes | `totalMs`, `fileCount`, `symbolCount` |
| `index:error` | Any phase throws | `phase`, `error`, `file` (if parse error) |
| `query:start` | `codebase_lookup` called | `mode`, `keywords` |
| `query:done` | Query returns | `mode`, `resultCount`, `elapsedMs` |
| `delta:sync` | Background delta cycle | `changedFiles`, `elapsedMs` |
| `llm:tag:start` | LLM tagging batch begins | `batchIndex`, `fileCount` |
| `llm:tag:done` | LLM batch completes | `batchIndex`, `appliedCount` |

**Debug flag:** When `config.debug === true` (from `src/config-file.ts`), also emit `index:verbose` events for every file parsed: `{ phase, file, symbolsExtracted, callsExtracted, elapsedMs }`. Never emit verbose events in production.

### 6.3 Observability Hooks

The CSI plugin exposes these stats for external monitoring. Implement `stats()` as part of the required helper methods in §5.1:

```typescript
interface CsiStats {
  file_count: number;
  symbol_count: number;
  call_edge_count: number;
  dep_edge_count: number;
  index_version: string;         // from meta table: 'version'
  indexed_at: number | null;    // Unix timestamp from meta table
  index_age_seconds: number;
  is_stale: boolean;
  is_building: boolean;         // true if index is currently being rebuilt
  last_delta_ms: number | null; // elapsed ms of last delta sync
  project_root: string;         // resolved project root
}
```

Poll `stats()` via `getSystemContext` (already in §5.1) so external monitoring tools can scrape it.


## 7. Error Handling

> **Retry guidance for LLM agents:** The `Retry?` column distinguishes transient errors (retry with backoff) from fatal errors (do not retry, fall back to `grep`/`view`). Always check `is_building` and `partial` in the result before deciding to retry — a partial result with some symbols is usually better than an error.

| Scenario | Behavior | Retry? |
|---|---|---|
| No index exists | Return `{ error: "Index not built yet", is_building: true }`. Trigger async full build. | Yes — retry after 2s |
| Index is building | Return partial results from current build progress. Set `is_building: true, partial: true`. | No — use partial result |
| Index is building, FTS returns results | Return FTS results immediately; set `is_building: true, partial: true`. | No — use FTS results |
| No results found (FTS or symbol query returns empty) | Fall back to `knowledge_search` (KnowledgeBase). Return both with a note indicating which system each result came from. | No |
| Parse error on file | Skip file, log warning. Do not fail entire index. | No |
| File deleted since index | Remove from index on next delta sync. Stale `file` entries return empty results with no error. | No |
| DB locked | Retry 3× with 100ms backoff. Fail gracefully with `{ error: "Index busy", partial: true }` if retries exhausted. | Yes — 3× with backoff |
| DB write failure (disk full, I/O error) | Catch the error; log a warning; abort the current indexing batch. Do not leave partial rows in the DB. On next cycle, retry the batch. If disk full persists, surface a user-facing warning that the index cannot be updated. | No (surface warning) |
| git not available | Skip Phase 6 (git signals). All files treated as non-active (`is_active: false`, `recency: 0.5`). | No |
| git repo does not exist at project root | Treat as git-not-available: skip Phase 6, `is_active: false` for all files. Do not throw. | No |
| git history read produces malformed output | If `git log` output cannot be parsed for a file, skip that file's `git_signals` row. Log a warning at debug level. Do not fail the entire index. | No |
| `include_callers` or `include_callees` times out | Return matched symbols immediately; set `partial: true`; omit the caller/callee expansion. | No — use partial result |
| `mode=graph` exceeds max depth (50) | Return edges up to depth 3 (max visible depth); set `partial: true`. | No — use partial result |
| SQLite partial corruption (missing rows) | Detect via `PRAGMA integrity_check`. If corruption found, trigger full re-index asynchronously and return `{ error: "Index corrupted, rebuilding", partial: true }`. | No — fall back to `grep`/`view` |
| SQLite WAL grows > 100 MB | Detect on next query or background tick. Run `PRAGMA wal_checkpoint(TRUNCATE)`. Log a warning with WAL size. If checkpoint itself fails (disk full), log an error and surface a user-facing warning. | No (surface warning) |
| SQLite WAL corruption or uncommitted writer crash | On next open, if WAL header is invalid, delete the `-wal` and `-shm` files and reopen in rollback mode. Log a warning. Trigger re-index if data loss is detected (e.g., `PRAGMA integrity_check` fails). | No |
| FTS query exceeds 5s timeout | Enforce via `bun:sqlite`'s `.query()` cancellation support or a `Promise.race([queryPromise, timeout(5000)])` wrapper. On timeout, interrupt the statement and return `{ error: "Query timed out", partial: true }`. | Yes — retry with a narrower `file_path` filter |
| `mode=deep`: file not in index yet | Fall back to direct `fs.readFile()` at `file_path`. Return the content window the same as any indexed file. CSI indexes the file asynchronously after returning the result. | No |
| `mode=deep`: file deleted after index | Return `{ error: "File no longer exists", file: "..." }` for that entry; set `partial: true`. | No |
| `mode=deep`: file unreadable (permission denied) | Return `{ error: "Permission denied", file: "..." }` for that entry; set `partial: true`. Do not propagate the error to the agent. | No |
| `onToolResult` fires for a file that no longer exists on disk | Treat as a no-op. Log at debug level. Do not attempt to update mtime. | No |
| Delta sync rename detection: inode unavailable | If `fs.stat` returns the same device+inode for deleted and added paths on non-Windows, apply rename logic. If device/inode cannot be determined (some network FSs), fall back to delete + re-insert; do not silently skip the rename. | No |

---

### 7.1 CLI & Operator Interface

CSI exposes these commands via the agent shell tool or a dedicated `csi` CLI entrypoint. All commands operate on `~/.clawd/data/csi.db` unless `--db` is specified.

| Command | Description |
|---|---|
| `csi stats` | Print file count, symbol count, index age, is_stale, is_building from `stats()`. |
| `csi status` | Shortcut for `csi stats`. |
| `csi rebuild --force` | Delete the existing index and trigger a synchronous full rebuild. Blocks until complete. Use `--force` to confirm destructive rebuild. |
| `csi rebuild --async` | Trigger async full rebuild without blocking (same as `onInit` fresh build). |
| `csi invalidate <path>` | Delete symbol/file rows for a specific path and mark it for re-index on next delta cycle. |
| `csi verify` | Run `PRAGMA integrity_check` and report result. Triggers async re-index if corrupted. |
| `csi log --level debug` | Enable verbose `[CSI] index:verbose` events for every file parsed. |
| `csi wal checkpoint` | Manually run `PRAGMA wal_checkpoint(TRUNCATE)` and report WAL size before/after. |
| `sqlite3 ~/.clawd/data/csi.db ".schema"` | Inspect the live schema (useful for debugging without a dedicated CLI). |
| `sqlite3 ~/.clawd/data/csi.db "SELECT * FROM meta;"` | Inspect key/value metadata including `version`, `indexed_at`, `project_root`, `langs`. |

> **Force rebuild signal:** Implement a file-based rebuild trigger (`~/.clawd/data/csi.rebuild`) that `ensureIndex()` checks on startup. If the file exists, delete it and run a full rebuild. Agents can trigger this by writing to that path (bypassing the sandbox restriction since `~/.clawd/` is outside the sandbox).


## 8. Migration

### v0 → v1 Database Migration

If a v0 CSI database exists at the old path (`~/.clawd/projects/{hash}/csi.db`), migrate it on first access:

1. Check if `~/.clawd/projects/{hash}/csi.db` exists (use `getContextProjectHash()` from `src/agent/utils/agent-context.ts` to construct the path).
2. If found, open it read-only and copy all rows into the new `~/.clawd/data/csi.db` using `INSERT OR IGNORE` (to avoid primary-key conflicts on re-runs).
3. After successful copy, delete the old DB file. Log a warning if deletion fails (non-fatal; CSI continues with the new DB).
4. If the copy fails (corrupt file, disk full), discard the old DB and start fresh with a new index. Log the error.

> **Migration is one-way.** After migration, the old file is deleted. Do not attempt to write back to it.

### Existing Users

Existing users with no v0 DB: no action needed. CSI creates `~/.clawd/data/csi.db` from scratch on first run.

### Schema Versioning Protocol

CSI uses the `meta.version` row as the authority on which schema the DB was built with. On every DB open, the version must be checked before any queries run.

**Protocol for schema changes (e.g., v1 → v2):**

1. **Increment the version in the spec** (this doc): `meta.version = '2.0'`.
2. **Write a migration in `csi-store.ts`:** add a `migrate_v1_to_v2()` function. Use the same `migrationRun` / `Migration` pattern as `memory-migrations.ts`.
3. **Migration function must be idempotent:** use `INSERT OR IGNORE` or `ALTER TABLE ... ADD COLUMN` (SQLite supports adding columns with defaults). Do not `DROP` columns in the migration — the old data may still be in users' DBs.
4. **After migration, update `meta.version`:** `INSERT OR REPLACE INTO meta(key, value) VALUES('version', '2.0')`.
5. **If migration fails:** log the error, delete the DB, and trigger a fresh full rebuild. Do not leave a partially-migrated DB in place.
6. **Document the migration** in this section: add a `### v1 → v2` subsection with the schema diff.

**What counts as a breaking change requiring a version bump:**
- Adding a `NOT NULL` column without a default
- Removing or renaming a column
- Changing the meaning of an existing field value
- Adding a required index (backfill it in the migration)
- Changing FTS5 schema

**What does NOT require a version bump:**
- Adding a new optional column with a default
- Adding a new table
- Adding a new index
- Adding a new `meta` key

> ⚠️ **The meta insert (§2.2) must always include `meta('project_root', '{path}')`.** Store the absolute path. On every open, compare `meta('project_root')` against `getContextProjectRoot()`. If they differ, delete the DB and rebuild — the index was built for a different project.

## 9. Security & Safety

This section covers all implementation constraints that must be respected to keep the index safe, correct, and isolated. All subsections are mandatory for a compliant v1 implementation.

### 9.1 File Exclusion List

All exclusions must be implemented as **explicit path checks in `csi-indexer.ts`**, independent of `registry.ts`'s `isSensitiveFile()` (which only covers `.env`/`.env.*`). A dedicated `isCsiExcluded(path: string): boolean` helper must cover the full list below.

**Always excluded (secrets / build artifacts):**
- `.env` and `.env.*` files (any variant: `.env.local`, `.env.production`, `.env.*.local`, etc.)
- `credentials.json`, `secrets.json`
- `*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx`, `*.ovpn`
- `id_rsa`, `id_ed25519`, `*.gpg`
- `.npmrc`, `.yarnrc` — may contain private registry tokens
- `.git/index`, `.git/config`, `.git/objects/` — internal git data
- `package-lock.json`, `yarn.lock`, `bun.lockb` — lockfiles may embed resolved registry URLs with auth segments
- `.aws/credentials`, `.aws/config` — AWS credential files
- `*.kdbx`, `*.keepass` — password database files
- `Dockerrun.aws.json`, `ebextensions/`, `.ebextensions/` — may contain AWS credentials
- `.github/dependabot.yml` — private registry URLs may appear here
- CI/CD workflow files: `.github/workflows/*.yml`, `.github/workflows/*.yaml`, `.gitlab-ci.yml`, `.circleci/config.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml`
  - **Path only** (never parse content): paths may be stored; file content must never be read or parsed for symbols
  - Before inserting the path, scrub any embedded secrets from the path string itself (e.g. `src/.secrets-token-abc.yml` → `src/.secrets-*.yml`)

**Explicitly allowed (no secrets risk):**
- `.env.example`, `*.example` — placeholder files

**Additional implicit exclusions from Phase 1 enumeration:** `.git`, `node_modules`, `dist`, `build`, `.next`, `__pycache__`, `*.pyc`, `vendor/`, `venv/`, `.venv/`, `.tox/`, `vendor/bundle/`, `.sass-cache/`, `.cache/`, `.parcel-cache/`.

**Exclusion algorithm:** Check paths in order: exact match → suffix match → glob pattern. Log every exclusion at debug level: `{ phase, file, reason }`.

### 9.2 Git Worktree Safety

Resolve all symlinks in the project root with `fs.realpathSync` before enumeration. If a symlink resolves to a path outside the project root, do not follow it and log a warning: `{ phase: 1, symlink, target, reason: "points outside project root" }`.

### 9.3 Project Hash (v0 Migration)

The v0 database path `~/.clawd/projects/{hash}/csi.db` is constructed using `getContextProjectHash()` from `src/agent/utils/agent-context.ts`. The hash **must** be a one-way trapdoor function of the project root (e.g. HMAC-SHA256 keyed by a local installation secret) — it must NOT be derivable from public project metadata (e.g. bare directory path or git remote URL) alone. An attacker who obtains the hash can open `csi.db` and enumerate the user's codebase structure. Treat the hash as a secret within `~/.clawd/` directory permissions. Document the hash algorithm in a code comment when implementing `getContextProjectHash()`; do not rely on undocumented behavior.

### 9.4 SQL Injection Prevention

All SQL queries that incorporate user-controlled values must use **parameterized queries** (`?` / `$1` placeholders). Never string-concatenate user-supplied values into SQL.

**High-risk parameters — MUST be parameterized:**

| Parameter | Source | SQL context |
|---|---|---|
| `keywords[]` | Agent / user tool args | FTS5 `MATCH` clause (see §9.5) |
| `file_path` | Agent / user tool args | `WHERE path LIKE ? \|\| '%'` prefix match |
| `exclude_path[]` | Agent / user tool args | `WHERE path NOT LIKE ? \|\| '%'` per entry |
| `lang` | Agent / user tool args | `WHERE lang = ?` |
| `kind_filter[]` | Agent / user tool args | `WHERE kind IN (?, ?, ...)` |
| `sym_id` / `file_id` | Internal (integer) | Safe if cast to `number` before binding |

```typescript
// UNSAFE — do not do this:
const rows = db.prepare(`SELECT * FROM symbols WHERE name LIKE '${keyword}%'`).all();

// SAFE — parameter binding:
const stmt = db.prepare(`SELECT * FROM symbols WHERE name LIKE ? || '%'`);
const rows = stmt.all(keyword);  // special chars are treated as literals
```

### 9.5 FTS5 Query Escaping

FTS5 has its own query syntax with special characters (`"`, `*`, `(`, `)`, `AND`, `OR`, `NOT`, `:`, `^`, `-`, `+`). A keyword containing these is interpreted as an FTS5 operator, not a literal token. This corrupts query results and can cause unexpected row returns.

**Escape function — implement in `csi-store.ts`:**
```typescript
// FTS5 special characters that must be escaped with a backslash prefix
function escapeFts5Token(s: string): string {
  return s.replace(/([*"():^+\-])/g, '\\$1');
}
```

**FTS5 trigger handling:** The three `symbols_fts_*` triggers in §2.2 handle FTS sync automatically. SQLite's prepared-statement layer escapes raw values in `VALUES(...)` clauses against SQL injection — this also correctly stores symbol names containing FTS5 special characters (e.g., a backtick or double-quote in a TypeScript template literal type) without corrupting the FTS index. The `escapeFts5Token()` function (§9.5) is **only needed for the MATCH query clause**, not for INSERT values. Choose one FTS sync strategy and document the choice in `csi-store.ts`:
- **Triggers (recommended):** Use the triggers from §2.2 as-is. No application-layer FTS insert/delete/update code is needed.
- **Application-layer:** Remove all three `symbols_fts_*` triggers from the schema. Handle all FTS sync in application code after each bulk INSERT/UPDATE/DELETE on the `symbols` table (e.g., run `INSERT INTO symbols_fts SELECT id, name, COALESCE(signature,''), '' FROM symbols` after a bulk insert). If application-layer sync is chosen, all three trigger definitions must be removed from the schema in §2.2.

**FTS5 query construction in `codebase_lookup` handler:**
```typescript
// 1. Escape each keyword
// 2. Append wildcard (*) for single-term queries; join multi-term with OR
// 3. Never pass a raw user string to FTS5 MATCH — always escape first
const ftsQuery = keywords
  .map(escapeFts5Token)
  .map(k => keywords.length === 1 ? `${k}*` : k)
  .join(' OR ');
// Example: ['auth', 'login'] → 'auth OR login'; ['jwt:token'] → 'jwt\:token OR token'
```

> **FTS5 content table integrity:** `symbols_fts` and `files_fts` are declared `content='symbols'` / `content='files'` (FTS5 content tables). Because FTS5 rows are stored independently of the base table, deleting a `symbols` row without also deleting its FTS counterpart corrupts the index. The `symbols_fts_ad` and `symbols_fts_au` DELETE/UPDATE triggers in §2.2 exist to keep the FTS index in sync — they must not be removed or disabled. If the application-layer FTS insert approach is chosen over triggers, ensure all three sync triggers (`ai`, `ad`, `au`) are replaced by equivalent application code paths.

### 9.6 Git Signals Privacy

The `git_signals.last_author` column stores the git `user.name` for the last commit touching each file. This is a privacy-relevant field because it can identify the developer associated with recent changes to specific files.

**For v1, default to store no author:** omit `last_author` from `git_signals` entirely; retain only `change_count`, `last_commit`, and `churn` for relevance scoring. If developer attribution is needed in a future version, add a `csi.storeGitAuthors: boolean` config flag (default `false`) or anonymize with a local HMAC.

### 9.7 Git Log Output Scrubbing

In Phase 6, use `git log --name-only --format="%H %ad %aN"` (not `--name-status`). The `--name-status` flag emits `A path/to/file` / `D old/path` lines that expose full filenames of deleted and renamed files, including any sensitive path components that were subsequently renamed away. `--name-only` provides file names for `change_count` aggregation without leaking delete/rename status.

### 9.8 Sandbox & Data Isolation

- CSI operates within the sandbox (`isPathAllowed`). No files outside project root or `/tmp` are indexed.
- Index stored locally at `~/.clawd/data/csi.db` (via `getDataDir()`). Never sent to any remote server.
- The DB lives outside the sandbox (sandbox restricts the agent's `/tmp` + `projectRoot`; `~/.clawd/` is on the host fs). CSI DB writes are made by the main agent process, not by sandboxed tool executions.
- **Indexing repos you don't own:** The spec does not restrict which project roots may be indexed. Any directory the agent can access may be indexed. Treat the index as having the same confidentiality as the source files — if the agent has read access to the files, it has read access to the index. Do not expose CSI query results to other agents or channels that lack access to the original files.

### 9.9 Incremental Indexing Safety

- **OOM protection:** Parse files in a streaming fashion; never hold more than one file's AST in memory simultaneously.
- **Circular call graph:** Track visited `(caller_sym_id, path_set)` pairs; abort if depth exceeds 50 or a (symbol, file) pair re-appears in the same chain.
- **`deep` mode is not parallel-safe:** Reads file content from disk — must not be registered with `readOnly: true`.

### 9.10 LLM Tagging Injection Guard

`pattern_tags.source = 'llm'` inference could be manipulated to inject false tags if the agent indexes a codebase with attacker-controlled filenames or content. Mitigations: (a) only run LLM inference on project source files, not user-uploaded content; (b) treat `pattern_tags` as hints only, never as ground truth for security decisions.

---

## 10. Performance Targets

| Metric | Target | Notes |
|---|---|---|
| Full index (1,000 files) | < 30 seconds | Achievable with Bun's native sqlite, bulk INSERT batching (500 rows/statement), WAL mode, and parallel Phase 2 parsing (Worker threads or `Promise.all` batching). |
| Full index (5,000 files) | < 3 minutes | Batched phases, WAL checkpoint after each 100-file batch. Peak memory ≤ 100 MB. |
| Full index (10,000+ files) | O(n) scaling; no hard limit | Pipeline bounded by batch size (100 files/batch × ~5s/batch = ~500s worst case for 10K files). Use Phase 2 time budget (abort at 120s, resume next cycle) to prevent indefinite blocking. |
| Incremental delta (1 file change) | < 500ms | Single file: parse + delete old rows + insert new rows. Achievable. |
| `codebase_lookup` query (cached hit) | < 2ms | LRU cache hit returns in ~1–2 ms. Avoids SQLite round-trip entirely. |
| `codebase_lookup` query (uncached) | < 50ms | FTS5 queries on 100K rows are typically 5–20 ms. WAL readers don't block writers. |
| Index size (1,000 files) | **1–5 MB raw, ~500 KB–2 MB gzip-compressed** | Rough breakdown: ~500 KB (files table + index), ~2 MB (symbols × 10/file avg × 200 B each), ~1 MB (calls × 20/file), ~300 KB (deps), ~500 KB (FTS5 pages). gzip on short identifiers compresses well; budget 1–3 MB on-disk. |
| Index size (10,000 files) | ~10–50 MB raw | Linear scaling. See §2.1 WAL pragmas for checkpoint strategy that keeps WAL near zero. |
| Memory usage (idle) | < 5 MB | SQLite mmap handles most reads without loading into process heap. FTS5 load is ~1–2 MB. Achievable. |
| Memory usage (indexing, peak) | ≤ 100 MB | Bounded by: 8-file parallel parse × ~5 MB AST each + 64 MB SQLite page cache. Never accumulate ASTs across files. |
| WAL size (steady state) | < 20 MB | Enforced by `wal_autocheckpoint` pragma (see §2.1) plus explicit `TRUNCATE` checkpoint after each batch. |
| Parallel tool execution eligibility | All read-only query modes | `symbol`, `structure`, `graph` are read-only. `deep` reads files via `fs` — not parallel-safe with respect to file writes. |

**Achieving the 30-second target:** Use `db.transaction()` wrapping bulk inserts (not individual INSERT per file). Parse files in parallel batches of 20–50 using `Promise.all()`. Apply the WAL pragmas from §2.1 (set `synchronous = NORMAL`, not FULL). Skip large files (>5 MB). Run Phase 6 (git history) in a separate background step after the initial index is written.

---

## 11. File Structure

```
src/agent/
  plugins/
    codebase-index-plugin.ts   # Main plugin (~400 lines)
  tools/
    codebase-lookup.ts          # Tool registration + handler (~200 lines)
  memory/
    csi-indexer.ts             # Indexing pipeline (~500 lines)
    csi-store.ts                # SQLite store, schema, migrations (~300 lines)
    csi-parser.ts               # Tree-sitter + regex parsers (~250 lines)
    csi-git.ts                  # Git history signals (~80 lines)
  types/
    csi.ts                      # All shared types (~100 lines) — NEW FILE
```
> **Note:** The `types/` directory under `src/agent/` does not yet exist. Create it and add `csi.ts` with the interfaces from §3.1 (`CodebaseLookupArgs`, `CodebaseLookupResult`, `SymbolEntry`, `FileEntry`, `GraphEntry`, `DeepEntry`). Export all of them so `codebase-lookup.ts` and `codebase-index-plugin.ts` can import from one canonical source.

---

## 12. Open Questions

1. **Vector embeddings:** Skip for v1 (requires external service or a local embedding model). FTS5 + relevance scoring covers 90% of cases. Revisit after v1 ships.
2. **Python/other language support:** Tree-sitter grammars needed per language. Start with TypeScript/JavaScript only (v1). Add languages incrementally.
3. **Index sharing across channels:** Each channel runs the same agent; CSI is project-level. No conflict. Multiple agents on same project share one index.
4. **Large files (>5 MB):** These are skipped at enumeration time (see Phase 2). This resolves the original question — no chunking logic is needed. Revisit only if a legitimate hand-written source file genuinely exceeds 5 MB.
5. **Cross-repo queries:** Out of scope for v1. Single-repo only.

---

## 13. References

| Technique | Source |
|---|---|
| Function/class logical chunking | Cursor AI |
| Incremental delta indexing (5 min) | Cursor AI |
| Call graph + dependency graph | Sourcegraph Cody |
| Git history relevance signals | Tabnine Enterprise |
| Curation ratio filtering | AugmentCode |
| Relevance scoring with recency | Industry best practice |
| Task-linked context | Windsurf Cascade |
| Pre-exploration context injection | Claude Code hooks |
