# Multi-Agent Context Sharing Analysis

**Date:** 2026-03-15
**Scope:** Knowledge base, spawn/worker, tool execution, context-mode plugin
**Files Analyzed:**
- `src/agent/src/memory/knowledge-base.ts`
- `src/spaces/spawn-plugin.ts`
- `src/spaces/worker.ts`
- `src/agent/src/tools/tools.ts`
- `src/agent/src/plugins/context-mode-plugin.ts`
- `src/agent/src/utils/agent-context.ts`
- `src/agent/src/utils/output-compressor.ts`
- `src/worker-loop.ts`

---

## 1. File Read Duplication

### Current Behavior

Every agent calls `view` (which calls `readFileSync`) independently. There is no deduplication layer between agents sharing the same project root. The `view` tool in `tools.ts` reads the file, the output gets compressed by `output-compressor.ts` (capped at 10,240 chars for `view`), then indexed into the FTS5 knowledge base -- **but scoped to `session_id`**.

Key finding in `knowledge-base.ts`:
- All queries filter by `session_id` (lines 170, 189-193)
- Each agent gets its own `sessionId` from `ContextModeConfig`
- Even though all agents write to the **same `~/.clawd/memory.db`**, the session filter prevents cross-agent reuse

### Waste Estimate

If 5 sub-agents each read a shared 200-line file (common for reviewing a single feature across API, tests, types, docs, security):
- Raw read: 5x filesystem I/O (negligible cost)
- Context window: 5 x ~10KB compressed = **~50KB of redundant context tokens**
- KB indexing: 5 separate FTS index operations for identical content
- At ~4 chars/token, that's ~12,500 redundant tokens per shared file across agents

For a typical review spawning 5 agents that share 10 common files: **~125,000 wasted tokens** (~$0.50-2.00 per review depending on model).

### Root Cause

`knowledge-base.ts` line 170: `const sessionFilter = sessionId ? "AND k.session_id = ?" : ""` -- the `search()` method supports cross-session search when `sessionId` is omitted, but `context-mode-plugin.ts` line 104 **always passes** `config.sessionId`. The capability exists but is not used.

---

## 2. Knowledge Base Sharing

### Current Architecture

```
memory.db (SQLite, WAL mode, single file)
  knowledge table:
    session_id  -- per-agent isolation
    source_id   -- tool call identifier
    tool_name   -- e.g. "view", "grep"
    content     -- chunked tool output (20 lines, 5-line overlap)
```

All agents connect to the same `~/.clawd/memory.db` (line 46-47 in `knowledge-base.ts`). SQLite WAL mode allows concurrent reads. The data IS physically shared but logically siloed by `session_id`.

### What Could Be Shared

The `knowledge_search` tool (context-mode-plugin.ts line 141-168) already supports a `scope` parameter:
- `"session"` (default) -- searches current session only
- anything else -- searches globally (passes `undefined` as sessionId)

**This is already wired up but underused.** If agents knew each other's session IDs or could search by `source_id` pattern (e.g., a file path), cross-agent retrieval would work today.

### Improvement: Project-Scoped Knowledge Sharing

Add a `"project"` scope that filters by `project_hash` instead of `session_id`:

```typescript
// In knowledge table, add: project_hash TEXT NOT NULL
// In search():
if (scope === "project") {
  filter = "AND k.project_hash = ?";
  params.push(projectHash);
} else if (scope === "session") {
  filter = "AND k.session_id = ?";
  params.push(sessionId);
}
// scope === "global" -- no filter
```

**Expected gain:** Agents searching for file contents already indexed by a sibling agent would get instant FTS results (~5ms) instead of re-reading + re-compressing (~50-200ms + full context cost). For 5 agents sharing 10 files, eliminates ~80% of redundant indexing.

---

## 3. Session Context Overlap (Parent-to-SubAgent Seeding)

### Current Behavior

`spawn-plugin.ts` lines 100-158 show that sub-agents get:
- A new `spaceId` (UUID)
- A new `WorkerLoop` with fresh config
- Task text posted as a chat message
- No parent context, file reads, or accumulated knowledge

`worker.ts` line 91-112 creates a `WorkerLoop` with `contextMode: true` and `isSpaceAgent: true`, but the `WorkerLoop` starts from scratch -- fresh `Agent`, fresh session, no seeded knowledge.

### The Gap

When a parent agent has already read 15 files and built understanding of the codebase, spawning 5 sub-agents means each repeats that discovery. The parent's `knowledge` entries in `memory.db` are inaccessible because sub-agents get different `session_id` values.

### Improvement: Context Seeding via Knowledge Snapshot

When spawning a sub-agent, the parent could:

1. **Export a context manifest** -- list of `source_id`s (file paths) already indexed
2. **Copy relevant KB entries** to the sub-agent's session (SQLite INSERT...SELECT, ~1ms)
3. **Include a context summary** in the task prompt

Implementation sketch:
```typescript
// In spawn-plugin.ts, before starting worker:
const parentSessionId = currentSessionId();
const relevantSources = kb.getSourcesForSession(parentSessionId);
// Copy to sub-agent session
kb.copyEntries(parentSessionId, subAgentSessionId, relevantSources);
```

**Expected gain:** Eliminates the first 3-5 tool calls each sub-agent makes to orient itself. At ~2,000 tokens per orientation call, saves ~10,000-25,000 tokens per sub-agent spawn. For 5 sub-agents: **~50,000-125,000 tokens saved**.

---

## 4. Tool Output Caching

### Current Behavior

No caching layer exists between the filesystem and tool output. Each `view` call does `readFileSync()` (tools.ts line 620), compresses the result (output-compressor.ts), and indexes it in KB. If the file hasn't changed, this is pure waste.

The `output-compressor.ts` TOOL_CAPS (lines 10-31) define per-tool size limits but do not check whether the same content was recently processed.

### Improvement: Project-Level mtime Cache

```typescript
interface CachedToolOutput {
  mtime: number;
  compressed: CompressResult;
  sourceId: string;
}

// Project-scoped cache (shared across agents via project hash)
const cache = new Map<string, CachedToolOutput>();

function getCachedOrExecute(toolName: string, filePath: string): CompressResult {
  const stat = statSync(filePath);
  const key = `${toolName}:${filePath}`;
  const cached = cache.get(key);
  if (cached && cached.mtime === stat.mtimeMs) {
    return cached.compressed;  // Skip read + compress + index
  }
  // ... execute normally, cache result
}
```

For in-memory sharing across agents in the same process (clawd-app mode), this is straightforward since all WorkerLoops run in a single Bun process.

**Expected gain:** Eliminates redundant `readFileSync` + compression + FTS indexing for unchanged files. In a typical session where agents re-read the same files 3-5 times: **~60-80% reduction in view tool execution time and context consumption**.

### SQLite-Backed Variant (Cross-Process)

For cases where agents run in separate processes, store cached outputs in `memory.db`:

```sql
CREATE TABLE tool_cache (
  project_hash TEXT NOT NULL,
  cache_key TEXT NOT NULL,  -- "view:/path/to/file"
  mtime_ms INTEGER NOT NULL,
  compressed_output TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (project_hash, cache_key)
);
```

---

## 5. Shared Scratch Pad

### Current Behavior

Agents communicate through chat messages posted to channels (spawn-plugin.ts lines 113-153). This is inherently noisy -- messages are rendered in UI, processed by polling loops, and mixed with user messages.

There is no structured key-value store for intermediate results. The `AgentContext` (agent-context.ts) uses `AsyncLocalStorage` for per-agent isolation but provides no cross-agent data sharing.

### Improvement: Project-Scoped Artifact Store

Add a lightweight KV table to `memory.db`:

```sql
CREATE TABLE artifacts (
  project_hash TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  author_session TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ttl_seconds INTEGER DEFAULT 3600,
  PRIMARY KEY (project_hash, key)
);
```

Use cases:
- **Scout results:** `scout:edge-cases` -> JSON array of findings
- **File summaries:** `summary:src/worker-loop.ts` -> compressed file overview
- **Dependency graphs:** `deps:src/agent` -> module dependency map
- **Shared decisions:** `decision:auth-strategy` -> architectural choice

Tool interface:
```typescript
registerTool("artifact_set", { key: "string", value: "string" });
registerTool("artifact_get", { key: "string" });
registerTool("artifact_list", { prefix: "string?" });
```

**Expected gain:** Reduces inter-agent chat noise by ~40%. Enables structured handoffs without the overhead of parsing natural-language messages. Sub-agents can check for existing analysis before duplicating work.

---

## Summary of Proposals (Ranked by Impact)

| # | Proposal | Effort | Token Savings | Latency Savings |
|---|----------|--------|---------------|-----------------|
| 1 | **Project-scoped KB search** (use existing `scope` param) | Low | ~80% of duplicate reads | ~200ms per cached hit |
| 2 | **mtime-validated tool cache** (in-process Map) | Low | ~60-80% for view/grep | ~50-200ms per call |
| 3 | **Context seeding on spawn** (copy parent KB entries) | Medium | ~50K-125K tokens per 5-agent spawn | ~5-15s orientation time |
| 4 | **Artifact store** (structured KV in memory.db) | Medium | Indirect (prevents duplicate analysis) | Significant for multi-step workflows |
| 5 | **SQLite-backed tool cache** (cross-process) | Medium | Same as #2 but durable | Same as #2 |

### Quick Wins (Implementable Today)

1. **Change default `knowledge_search` scope from `"session"` to `"project"`** in context-mode-plugin.ts line 149. This single-line change enables cross-agent knowledge reuse immediately, since all agents already write to the same `memory.db`.

2. **Add `project_hash` column to `knowledge` table.** Currently, cross-session search has no way to filter by project -- it searches ALL sessions globally. Adding project scoping makes cross-agent search safe in multi-project environments.

3. **In-process file cache.** Since `WorkerLoop` instances share the same Bun process (visible from worker.ts creating loops in-process), a module-level `Map<string, {mtime, result}>` in `tools.ts` would immediately deduplicate concurrent reads.

---

## Unresolved Questions

- What is the typical sub-agent count per task? If usually 1-2, the savings are modest. If 5+, the gains compound significantly.
- Is there a risk of stale KB entries misleading agents? The mtime validation addresses files, but grep/glob results may go stale if the codebase changes mid-session.
- Should the artifact store have access control (e.g., only the parent can write certain keys)?
- Would a shared LRU cache need eviction tuning for large monorepos?
