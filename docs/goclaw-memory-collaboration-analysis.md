# GoClaw Deep Analysis: Memory Persistence & Multi-Agent Collaboration

> **Purpose**: Lessons learned from GoClaw's memory system and multi-agent collaboration patterns, with recommendations for Claw'd adoption and pitfalls to avoid.
> **Source**: [github.com/nextlevelbuilder/goclaw](https://github.com/nextlevelbuilder/goclaw)

---

## Table of Contents

1. [Part A: Long-Term Memory Persistence](#part-a-long-term-memory-persistence)
   - [Architecture Overview](#1-architecture-overview)
   - [The Memory Write Pipeline](#2-the-memory-write-pipeline)
   - [The Memory Read Pipeline (Hybrid Search)](#3-the-memory-read-pipeline-hybrid-search)
   - [Pre-Compaction Memory Flush](#4-pre-compaction-memory-flush)
   - [Dual-Mode Architecture](#5-dual-mode-architecture)
   - [What Works Well (Learn From)](#6-what-works-well-learn-from)
   - [Drawbacks & Pitfalls (Avoid)](#7-drawbacks--pitfalls-avoid)
   - [Recommendations for Claw'd](#8-recommendations-for-clawd)
2. [Part B: Multi-Agent Collaboration](#part-b-multi-agent-collaboration)
   - [Collaboration Models](#9-collaboration-models)
   - [Task Lifecycle & Conflict Resolution](#10-task-lifecycle--conflict-resolution)
   - [Workspace Isolation Strategies](#11-workspace-isolation-strategies)
   - [The File Collision Problem](#12-the-file-collision-problem)
   - [Git Worktree-Inspired Isolation](#13-git-worktree-inspired-isolation)
   - [Non-Git & Nested Submodule Scenarios](#14-non-git--nested-submodule-scenarios)
   - [What Works Well (Learn From)](#15-what-works-well-learn-from)
   - [Drawbacks & Pitfalls (Avoid)](#16-drawbacks--pitfalls-avoid)
   - [Recommendations for Claw'd](#17-recommendations-for-clawd)
3. [Comparative Summary: GoClaw vs Claw'd](#comparative-summary-goclaw-vs-clawd)

---

## Part A: Long-Term Memory Persistence

### 1. Architecture Overview

GoClaw's memory system is a **dual-mode hybrid search engine** that combines file-based markdown storage with vector embeddings and full-text search:

```
┌─────────────────────────────────────────────────────────┐
│                    Memory Pipeline                       │
│                                                         │
│  Agent writes          File Watcher          LLM Flush  │
│  memory/*.md  ────►  (1.5s debounce)  ◄────  (pre-     │
│                           │                   compaction)│
│                    ┌──────▼──────┐                       │
│                    │  Chunking   │                       │
│                    │ (paragraph) │                       │
│                    └──────┬──────┘                       │
│                           │                              │
│              ┌────────────┼────────────┐                 │
│              ▼                         ▼                 │
│     ┌────────────────┐      ┌──────────────────┐        │
│     │ FTS5 / tsvector│      │  Embedding Gen   │        │
│     │ (keyword index)│      │ (OpenAI/Voyage)  │        │
│     └────────┬───────┘      └────────┬─────────┘        │
│              │                       │                   │
│              └───────────┬───────────┘                   │
│                          ▼                               │
│               ┌─────────────────────┐                    │
│               │   Hybrid Search     │                    │
│               │ 0.7·vec + 0.3·fts  │                    │
│               │ min_score = 0.35    │                    │
│               └─────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- Memory stored as **plain markdown files** (`MEMORY.md`, `memory/*.md`) — human-readable, version-controllable
- **SHA256 hash-based change detection** — skip re-indexing unchanged files
- **Paragraph-aware chunking** — splits at blank lines (50% threshold) or force-splits at 1000 chars
- **Embedding cache** — deduplicates embedding API calls by content hash

### 2. The Memory Write Pipeline

#### Step 1: Agent Writes Memory Files

The agent uses standard file tools (`write_file`, `edit`) to write to `MEMORY.md` or `memory/*.md`. In managed mode, a `MemoryInterceptor` intercepts these writes and routes them to the database instead of disk:

```go
// MemoryInterceptor.WriteFile() routing:
1. Check if path matches memory pattern (MEMORY.md or memory/*)
2. Write content to DB via MemoryStore.PutDocument(agentID, userID, path, content)
3. Trigger re-indexing: MemoryStore.IndexDocument(agentID, userID, path)
```

#### Step 2: Chunking

```
Input: "## Meeting Notes\nDiscussed architecture...\n\n## Action Items\nTask 1..."
                                                          ↑ blank line = paragraph break

Chunk 1: "## Meeting Notes\nDiscussed architecture..."  (lines 1-3)
Chunk 2: "## Action Items\nTask 1..."                   (lines 5-8)
```

Rules:
- Flush chunk at **blank line if chunk ≥ 50% of maxChunkLen** (500 chars default)
- Force flush at **100% of maxChunkLen** (1000 chars)
- Preserve exact line numbers for search result references

#### Step 3: Hashing & Change Detection

```go
hash = SHA256(content)[:16]  // First 16 bytes as hex string
if files_table.hash == hash → skip (no change)
else → delete old chunks, re-chunk, re-embed
```

#### Step 4: Embedding Generation

```go
// Batch embed all chunks at once
embeddings = provider.Embed(ctx, [chunk1.text, chunk2.text, ...])

// Cache by content hash to avoid re-embedding identical text
embedding_cache[contentHash] = {provider, model, vector, dims}
```

#### Step 5: Storage

| Mode | Storage | FTS | Vector |
|------|---------|-----|--------|
| **Standalone** | SQLite `chunks` table | FTS5 virtual table (`porter unicode61`) | JSON-encoded float32 array |
| **Managed** | PostgreSQL `memory_chunks` | `tsvector` column with `plainto_tsquery('simple')` | `pgvector vector(1536)` |

### 3. The Memory Read Pipeline (Hybrid Search)

#### Search Algorithm

```
memory_search(query="architecture decisions")
  │
  ├─► FTS Search (always runs)
  │   SQLite: MATCH query → BM25 rank → score = 1/(1+|rank|)
  │   Postgres: tsv @@ plainto_tsquery → ts_rank
  │
  ├─► Vector Search (if embedding provider available)
  │   1. Embed query → queryVec
  │   2. Standalone: load ALL chunks via GetAllChunks(), compute CosineSimilarity(queryVec, chunk.embedding) — O(N×D) brute force
  │   3. Managed: pgvector operator `1 - (embedding <=> queryVec::vector)`
  │
  └─► Merge Results
      1. Normalize FTS scores to [0,1] (divide by max)
      2. Weight: score = 0.7 × vecScore + 0.3 × ftsScore
      3. Deduplicate by (path, startLine) key
      4. Per-user boost: 1.2× for user-scoped results (managed mode)
      5. Filter: score ≥ minScore (default 0.35, but only applied if explicitly set — not enforced by default)
      6. Return top K (default 6 for hybrid search, 10 for FTS-only fallback)
```

#### memory_get Tool

Direct file reading with optional line range extraction:

```
memory_get(path="memory/decisions.md", from_line=10, num_lines=20)
→ Returns lines 10-30 of the file
```

Falls back: per-user copy → global copy (managed mode).

### 4. Pre-Compaction Memory Flush

**This is the most architecturally significant feature** — the system automatically extracts important information from conversation history into persistent memory files *before* that history is compacted/discarded.

#### Trigger Conditions

```
shouldFlush = ALL of:
  ✓ Memory is enabled (hasMemory=true)
  ✓ Flush settings enabled (default: true)
  ✓ totalTokens > contextWindow - reserveFloor(20K) - softThreshold(4K)
  ✓ Not already flushed in this compaction cycle
```

#### Execution Flow

```
1. Build messages:
   - System prompt (normal + flush-specific instructions)
   - Previous conversation summary (if exists)
   - Last 10 messages from history
   - Flush prompt: "Pre-compaction memory flush. Store durable memories now
     (use memory/YYYY-MM-DD.md; APPEND, don't overwrite). If nothing to store,
     reply with NO_REPLY."

2. Run isolated LLM loop:
   - Max 5 iterations, 90-second timeout
   - Temperature 0.3 (deterministic writes)
   - Only file tools available (write_file, read_file, edit, list_files)
   - Agent decides what's worth remembering

3. Mark flush complete:
   - Set memoryFlushCompactionCount = current compactionCount
   - Prevents double-flushing in same cycle
```

#### The Flush Prompt

```
"Pre-compaction memory flush. Store durable memories now
(use memory/YYYY-MM-DD.md; create memory/ if needed).
IMPORTANT: If the file already exists, APPEND new content only
and do not overwrite existing entries.
If nothing to store, reply with NO_REPLY."
```

### 5. Dual-Mode Architecture

| Aspect | Standalone (SQLite) | Managed (PostgreSQL) |
|--------|-------------------|---------------------|
| **Storage** | Local files + SQLite DB | PostgreSQL tables |
| **Scoping** | Single agent, global | Per-agent + per-user |
| **Vector search** | In-memory brute force (`GetAllChunks()`) | pgvector index (`<=>` operator) |
| **FTS** | FTS5 with `porter unicode61` | `tsvector` with `simple` config |
| **Watcher** | fsnotify with 1.5s debounce | N/A (DB-driven indexing) |
| **Interceptor** | N/A (direct file access) | MemoryInterceptor routes to DB |
| **Embedding cache** | In-memory (ephemeral) | None explicit |
| **Multi-tenant** | No | Yes (agent_id + user_id scoping) |

### 6. What Works Well (Learn From)

#### ✅ Markdown-Based Memory Files
- Human-readable and debuggable
- Version-controllable with Git
- Agents use familiar file tools (no special memory API)
- Users can manually edit memory files

#### ✅ Pre-Compaction Memory Flush
- Prevents information loss when history is compacted
- LLM decides what's worth remembering (intelligent extraction)
- Append-only strategy prevents data loss
- Date-based filenames (`memory/YYYY-MM-DD.md`) for temporal organization

#### ✅ Hybrid Search (Vector + FTS)
- FTS catches exact keyword matches that vectors miss
- Vectors catch semantic similarity that keywords miss
- Graceful degradation: works without embeddings (FTS-only mode)

#### ✅ SHA256 Change Detection
- Avoids re-indexing unchanged files (huge perf win)
- Avoids re-embedding unchanged content (saves API costs)
- Simple and reliable

#### ✅ Paragraph-Aware Chunking
- Respects document structure (doesn't split mid-paragraph)
- Preserves line numbers for precise retrieval
- 50% soft threshold at paragraph breaks is a good heuristic

#### ✅ Per-User Memory Scoping (Managed Mode)
- Each user's memories are isolated
- 1.2× boost for personal results ensures relevance
- Global memories still accessible (fallback chain)

### 7. Drawbacks & Pitfalls (Avoid)

#### ❌ In-Memory Vector Search (Standalone Mode)

**Problem**: `GetAllChunks()` loads ALL chunks into memory for brute-force cosine similarity.

**Impact**: O(N × D) where N=chunks, D=1536 dimensions. Fine for <10K chunks, catastrophic for 100K+.

**Recommendation**: Use approximate nearest neighbor (ANN) indexes even in SQLite mode. Libraries like `sqlite-vss` or FAISS can provide sub-linear search.

#### ❌ No Memory Expiration

**Problem**: Chunks are never automatically expired or archived. Stale/outdated memories persist forever and pollute search results.

**Recommendation**: Implement TTL-based expiration or recency-weighted scoring. Older memories should decay in relevance unless explicitly pinned.

#### ❌ No Semantic Deduplication

**Problem**: The same information written twice (e.g., agent appends to `MEMORY.md` on multiple flushes) creates duplicate chunks that waste storage and pollute search results.

**Recommendation**: Before inserting new chunks, check cosine similarity against existing chunks with same path. Merge near-duplicates (similarity > 0.95).

#### ❌ FTS Tokenizer Limitations

**Problem**: 
- Standalone: Porter stemmer is English-only — fails for CJK, Arabic, Vietnamese
- Managed: `'simple'` config has no stemming at all — reduces search quality for English

**Recommendation**: Use language-aware tokenizers. For multilingual support, consider ICU tokenizer or separate per-language FTS configs.

#### ❌ Memory Flush Timeout Risk

**Problem**: 90-second timeout with no rollback. If LLM times out mid-write, partial memory files are left on disk.

**Recommendation**: Use write-ahead logging or atomic file writes (write to temp, rename on success). Mark flush as failed and retry on next cycle.

#### ❌ No Concurrent Write Protection

**Problem**: Two agents writing `MEMORY.md` simultaneously can lose data (last write wins).

**Recommendation**: Use file-level advisory locking (`flock`/`fcntl`) or optimistic concurrency control (version counter in file header).

#### ❌ Hardcoded Scoring Weights

**Problem**: Vector weight (0.7) and FTS weight (0.3) are hardcoded. The per-user boost (1.2×) is also hardcoded. These may not be optimal for all use cases.

**Recommendation**: Make weights configurable per-agent. Consider learning optimal weights from user feedback (clicked vs. ignored results).

#### ❌ No Memory Consolidation

**Problem**: Over time, `memory/` accumulates many small files from daily flushes. Search quality degrades as relevant info is scattered across dozens of files.

**Recommendation**: Implement periodic memory consolidation — merge related memories into topic-based files. LLM-driven consolidation can reorganize memories by theme.

### 8. Recommendations for Claw'd

#### Priority 1: Implement Pre-Compaction Memory Flush
This is the single most impactful pattern. Before discarding conversation history, run an extraction pass to persist important information. Key improvements over GoClaw:
- Add rollback on timeout (atomic writes)
- Add deduplication check before appending
- Consider a "memory importance scorer" to filter noise

#### Priority 2: Hybrid Search with Graceful Degradation
Start with FTS-only (SQLite FTS5 — Claw'd already uses SQLite), then add vector search as an enhancement:
1. Phase 1: FTS5 with `porter unicode61` tokenizer
2. Phase 2: Add embedding generation (batch, cached by content hash)
3. Phase 3: Hybrid merge with configurable weights

#### Priority 3: Memory Expiration & Consolidation
Solve the problems GoClaw doesn't:
- Recency-weighted scoring (newer memories score higher)
- Periodic LLM-driven consolidation (merge related memories by topic)
- Configurable TTL per memory source

#### Priority 4: Per-User Memory Isolation
Essential for multi-tenant scenarios. Use Claw'd's existing SQLite with agent_id + user_id scoping columns.

---

## Part B: Multi-Agent Collaboration

### 9. Collaboration Models

GoClaw implements three distinct collaboration patterns:

#### Model 1: Delegation (Sync/Async)

```
Agent A ──delegate(task)──► Agent B
              │                │
              │    [executes]  │
              │                │
              ◄──result────────┘
              │
         [quality gate]
              │
         [announce to user]
```

- **Sync**: Agent A blocks until Agent B completes
- **Async**: Agent A continues, result delivered via message bus
- **Quality gates**: Hook-based evaluation before accepting result
- **Capacity gates**: Per-link `MaxConcurrent` + per-target `maxDelegationLoad` (default 5)

#### Model 2: Team Tasks

```
Lead Agent ──create_task──► Task Queue ◄──claim_task── Worker Agent
                              │
                         [row-level lock]
                              │
                    ┌─────────┴─────────┐
                    │ Only ONE agent    │
                    │ wins the claim    │
                    └───────────────────┘
```

- **Atomic claiming**: PostgreSQL `SELECT FOR UPDATE` — exactly one agent wins
- **Status transitions**: Pending → In_Progress → Completed (+ Blocked)
- **Dependency tracking**: `blocked_by[]` — tasks auto-unblock when dependencies complete
- **Priority ordering**: Higher priority tasks served first

#### Model 3: Subagent Spawning

```
Parent Agent ──spawn──► Child Agent (depth+1)
                            │
                       [inherits workspace]
                       [restricted tools]
                       [isolated session]
                            │
                       ──announce──► Parent
```

- **Depth limit**: Default 1 level deep (configurable via `MaxSpawnDepth`)
- **Concurrency limit**: Max 8 global, max 5 per parent
- **Tool restrictions**: Deny lists escalate at each depth level
- **Announce batching**: Results debounced (1000ms) and batched (max 20)

### 10. Task Lifecycle & Conflict Resolution

#### Task Claiming (The Critical Path)

```sql
-- PostgreSQL implementation (teams_tasks.go) — optimistic locking
UPDATE team_tasks 
SET status = 'in_progress', owner_agent_id = $2
WHERE id = $1 AND status = 'pending';  -- Condition prevents double-claiming
-- If 0 rows affected → task was already claimed by another agent
```

**Only one agent can claim a task** — the UPDATE's WHERE condition ensures atomicity. If the task was already claimed (status ≠ 'pending'), the UPDATE affects 0 rows and the claimant gets an error.

#### Conflict Resolution Matrix

| Scenario | Detection | Resolution | Gap? |
|----------|-----------|------------|------|
| Two agents claim same task | Optimistic locking (WHERE condition) | First wins, second gets 0 rows | ✅ Handled |
| Delegation overload | Active count ≥ maxLoad | Error: "at capacity" | ✅ Handled |
| Spawn depth exceeded | Depth check pre-spawn | Error: "depth limit" | ✅ Handled |
| Max concurrent subagents | Atomic counter check | Error: "max concurrent" | ✅ Handled |
| Sibling delegation batching | Sibling counting | Suppress intermediate, batch final | ✅ Handled |
| Session compaction race | TryLock (non-blocking) | Skip if locked | ✅ Handled |
| **File write collision** | **None** | **Last write wins** | ❌ **Gap** |
| **Task double-completion** | **None** | **Silent overwrite** | ⚠️ Minor |
| **Memory write collision** | **None** | **Last write wins** | ❌ **Gap** |

### 11. Workspace Isolation Strategies

#### Current GoClaw Isolation Model

```
Isolation Level:
┌───────────────────────────────────────────────────┐
│ Level 1: Per-Agent Workspace (config-based)       │
│   workspace = /data/agents/{agent_key}/           │
│                                                   │
│ Level 2: Per-User Workspace (managed mode)        │
│   workspace = /data/agents/{agent_key}/{user_id}/ │
│                                                   │
│ Level 3: Sandbox Container (Docker)               │
│   Scope: session | agent | shared                 │
│   Mount: workspace → /workspace in container      │
│                                                   │
│ Level 4: Session Serialization (scheduler)        │
│   Queue: 1 concurrent run per session (default)   │
│   Effect: no concurrent file writes within session│
└───────────────────────────────────────────────────┘
```

#### What's Protected

| Resource | Isolation Mechanism | Strength |
|----------|-------------------|----------|
| Context files (SOUL.md, IDENTITY.md) | DB-backed in managed mode | ✅ Strong (ACID) |
| Memory files (MEMORY.md, memory/*) | DB-backed via MemoryInterceptor | ✅ Strong (managed) / ⚠️ Weak (standalone) |
| Session history | Per-session key scoping | ✅ Strong |
| Regular workspace files | Session serialization + per-user directory isolation | ⚠️ Weak (same-user cross-session only) |
| Shell execution | Sandbox container (if enabled) | ✅ Strong (when enabled) |

#### What's NOT Protected

> **Important nuance**: Per-user workspaces are physically separated (`workspace/{userID}/`), so different users' agents cannot collide. File collisions are only possible when **the same user** has **multiple concurrent sessions** with the same agent in `ScopeAgent` or `ScopeShared` sandbox mode.

```
Same user, different sessions:
Agent A (session 1) ──write──► /workspace/{userID}/config.json ◄──write── Agent B (session 2)
                                     │
                              RACE CONDITION
                              (no file locking)
```

When two agents in different sessions (but same `ScopeAgent` or `ScopeShared` sandbox) modify the same file, **the last write wins**. There is no:
- Advisory file locking (`flock`/`fcntl`)
- Optimistic concurrency control (version numbers)
- Distributed lock manager
- Write-ahead logging for workspace files

### 12. The File Collision Problem

This is **a significant gap** in GoClaw's multi-agent architecture, though per-user workspace isolation reduces its severity. Collisions are primarily a concern for **same-user, multi-session** scenarios:

#### Scenario: Two Agents Editing the Same Codebase

```
Agent "Backend"  ─── edits src/api/routes.ts  (adds new endpoint)
Agent "Frontend" ─── edits src/api/routes.ts  (adds type imports)
                                │
                      Both read version 1
                      Both write version 2 (different changes)
                      Last write wins → one change lost
```

#### Why Per-Session Serialization Isn't Enough

Per-session serialization prevents concurrent writes **within a single session**. But agents in different sessions can run concurrently:

```
Session A (Agent "Backend"):  serialized within session
Session B (Agent "Frontend"): serialized within session
                              ↕ BUT ↕
Sessions A and B: CAN RUN CONCURRENTLY
                  → concurrent file access possible
```

### 13. Git Worktree-Inspired Isolation

#### The Git Worktree Model

Git worktrees provide a elegant solution: each agent gets its own working directory with an independent checkout, but they share the same repository:

```
.git/                          ← shared repository
├── worktrees/
│   ├── agent-backend/         ← Backend agent's worktree
│   │   └── HEAD → refs/heads/feature/backend-api
│   └── agent-frontend/        ← Frontend agent's worktree
│       └── HEAD → refs/heads/feature/frontend-ui
│
/workspace/
├── main/                      ← main checkout
├── agent-backend/             ← worktree checkout (different branch)
└── agent-frontend/            ← worktree checkout (different branch)
```

**Benefits**:
- Each agent has its own branch — no write collisions
- Merging happens explicitly (agent or human reviews conflicts)
- Full Git history for audit trail
- Cheap (worktrees share object store)
- Multiple worktrees cannot check out the same branch (Git enforces this)

#### Implementation Strategy

```
1. Agent spawned → create worktree:
   git worktree add /workspace/agent-{id} -b agent/{id}/task

2. Agent works in its worktree:
   All file tools scoped to /workspace/agent-{id}/

3. Agent completes → merge to main:
   git checkout main
   git merge agent/{id}/task --no-ff

4. Conflict detected → escalate:
   Report conflict to lead agent or user for resolution

5. Cleanup → remove worktree AND branch:
   git worktree remove /workspace/agent-{id}
   git branch -d agent/{id}/task     ← prevent branch accumulation
   git worktree prune                ← clean stale worktree metadata
```

> **Edge cases to handle**:
> - **Stale worktrees**: If agent crashes, worktree remains. Run `git worktree prune` periodically.
> - **Locked worktrees**: `.git/worktrees/<name>/locked` prevents removal. Delete lock file if agent confirmed terminated.
> - **Branch accumulation**: Always delete agent branches after merge to prevent ref clutter.

### 14. Non-Git & Nested Submodule Scenarios

#### Problem: What if the workspace isn't a Git repo?

Many agent workspaces are not Git repositories (config files, data directories, scratch space). Git worktrees require a `.git` directory.

#### Solution: Copy-on-Write (CoW) Isolation

```
Strategy: "Overlay Workspace"

Base Layer (read-only):
  /workspace/shared/        ← original files (immutable during agent run)

Agent Overlay (read-write):
  /workspace/agent-{id}/    ← copy-on-write layer

Resolution:
  1. Agent reads: check overlay first, fall through to base
  2. Agent writes: always write to overlay
  3. Agent completes: diff overlay vs base → generate patch
  4. Apply patch to base (with conflict detection)
```

**Implementation options**:
- **OverlayFS** (Linux kernel): Write-on-first-write semantics — reads are zero-copy from lower layer, first write to any file copies entire file to upper layer. Not true block-level CoW.
- **Filesystem snapshot** (Btrfs/ZFS): True block-level CoW — snapshots are read-only by default (writable clones need explicit setup). Zero space used until writes occur. May not be available on all systems (ZFS licensing varies).
- **Application-level CoW**: Copy file to overlay on first write. Most portable, but slowest. Conflict detection on merge: compare file timestamps + content hashes of base at spawn-time vs merge-time to detect concurrent base modifications.

#### Problem: Nested Git Submodules

```
/workspace/
├── .git/                    ← main repo
├── src/
├── libs/
│   ├── shared-lib/
│   │   └── .git/            ← submodule
│   └── vendor-lib/
│       └── .git/            ← submodule
└── tools/
    └── build-tool/
        └── .git/            ← submodule
```

**Challenges with Git worktrees + submodules**:
1. `git worktree add` does NOT automatically checkout submodules
2. Submodule `.git` files (not directories) use relative paths that may break in worktrees (Git 2.27+ auto-fixes this; older versions require manual `fix_submodule_git_paths()`)
3. Nested submodules require recursive initialization (`--jobs N` flag in Git 2.8+ speeds this up)
4. Submodule branches may conflict with worktree branches — ensure branch names don't collide with existing submodule branches

#### Solution: Submodule-Aware Worktree Manager

```python
def create_agent_worktree(workspace, agent_id, task_branch):
    # 1. Create worktree for main repo
    worktree_path = f"/workspace/agent-{agent_id}"
    run(f"git worktree add {worktree_path} -b agent/{agent_id}/{task_branch}")
    
    # 2. Initialize submodules in worktree
    run(f"cd {worktree_path} && git submodule update --init --recursive")
    
    # 3. For each submodule, create independent branch
    for submodule in get_submodules(worktree_path):
        run(f"cd {submodule.path} && git checkout -b agent/{agent_id}/{task_branch}")
    
    # 4. Fix .git file paths (worktree-relative)
    fix_submodule_git_paths(worktree_path)
    
    return worktree_path

def merge_agent_worktree(workspace, agent_id, worktree_path):
    # 1. Commit all changes in submodules first
    for submodule in get_submodules(worktree_path):
        run(f"cd {submodule.path} && git add -A && git commit -m 'agent/{agent_id} changes'")
    
    # 2. Update submodule references in main repo
    run(f"cd {worktree_path} && git add -A && git commit -m 'agent/{agent_id} task complete'")
    
    # 3. Merge to main
    run(f"cd {workspace} && git merge agent/{agent_id}/{task_branch}")
    
    # 4. Cleanup
    run(f"git worktree remove {worktree_path}")
```

#### Hybrid Strategy: Decision Matrix

```
Is workspace a Git repo?
├── YES: Is it simple (no submodules)?
│   ├── YES → Use Git worktrees (cheapest, best isolation)
│   └── NO  → Use Submodule-Aware Worktree Manager
│              (handles nested .git paths, recursive init)
├── MIXED (non-Git root with nested .git dirs):
│   └── Use Application-Level CoW for root workspace
│       + Git worktrees for each nested Git subdirectory
└── NO: Is filesystem CoW available?
    ├── YES (OverlayFS/Btrfs/ZFS) → Use filesystem-level CoW
    └── NO  → Use Application-Level CoW
              (copy-on-first-write with diff-and-merge)
```

### 15. What Works Well (Learn From)

#### ✅ Atomic Task Claiming

GoClaw uses optimistic locking (`UPDATE ... WHERE status = 'pending'`) to guarantee exactly one agent claims a task — no pessimistic locking needed.

**Recommendation**: Claw'd already has atomic task claiming with `claimed_by` column protection. Verify and extend with formal status transitions.

#### ✅ Capacity Gates

Per-link and per-target concurrency limits prevent overload:
```
Link capacity:   Agent A → Agent B: max 3 concurrent delegations
Target capacity: Agent B: max 5 total delegations from all sources
```

#### ✅ Subagent Depth & Concurrency Limits

Prevents infinite spawning and resource exhaustion:
```
Max depth:    1 level deep (default, configurable)
Max global:   8 concurrent subagents
Max per-parent: 5 children
Auto-archive: 60 min TTL
```

#### ✅ Announce Queue Batching

Prevents notification storms when multiple subagents complete:
```
Debounce:   1000ms
Max batch:  20 items
Strategy:   Suppress intermediate, batch final
```

#### ✅ Session Key Isolation

Every combination of (agent, channel, peer) gets a unique session, preventing cross-contamination:
```
agent:main:telegram:direct:123    ← DM with user 123
agent:main:telegram:group:456     ← Group chat 456
agent:main:subagent:my-task       ← Subagent session
delegate:source:target:uuid       ← Delegation session
```

#### ✅ Quality Gates (Hooks)

Post-delegation evaluation with retry loops:
```
Delegation completes → Evaluate quality gate
  → Pass: Accept result
  → Fail (blocking): Re-invoke target with feedback (max N retries)
  → Fail (non-blocking): Log warning, accept result
```

### 16. Drawbacks & Pitfalls (Avoid)

#### ❌ No File-Level Locking

**The biggest gap**. Multiple agents can write the same file simultaneously with no detection or resolution. This is acceptable for single-agent scenarios but dangerous for multi-agent teams.

#### ❌ Shared Workspace Between Delegate and Parent

When Agent A delegates to Agent B, both share the same workspace. Agent B can modify Agent A's files, which may be desirable (collaboration) or dangerous (unintended side effects).

**Recommendation**: Provide an option for isolated delegation workspaces with explicit merge-back.

#### ❌ No Task Ownership Verification

Any team member can complete any task — there's no check that the completing agent is the one who claimed it. This allows "task stealing."

**Recommendation**: Verify `owner_agent_id` matches the completing agent.

#### ❌ Subagent Inherits Parent Workspace

Subagents work in the same filesystem as their parent. A buggy subagent can corrupt the parent's workspace.

**Recommendation**: Use CoW isolation for subagent workspaces. The subagent gets a copy; changes are merged back only if the parent approves.

#### ❌ No Distributed Lock Manager

In a clustered GoClaw deployment (multiple gateway instances sharing PostgreSQL), there's no distributed file locking. Two gateway instances could route agents to the same workspace simultaneously.

**Recommendation**: Use PostgreSQL advisory locks for workspace-level coordination in clustered deployments.

#### ❌ Announce Queue Memory Leak Risk

Pending artifacts are stored in `sync.Map` keyed by source agent ID. If a delegation is cancelled but artifacts remain, they leak until process restart.

**Recommendation**: Add TTL-based cleanup for pending artifacts.

### 17. Recommendations for Claw'd

#### Priority 1: Implement Git Worktree Isolation

For Git-based workspaces (which is the common case for coding agents):

```typescript
class WorktreeManager {
  async createWorktree(agentId: string, taskBranch: string): Promise<string> {
    const worktreePath = path.join(this.baseDir, `agent-${agentId}`);
    await exec(`git worktree add ${worktreePath} -b agent/${agentId}/${taskBranch}`);
    // Handle submodules if present
    if (await this.hasSubmodules(worktreePath)) {
      await exec(`cd ${worktreePath} && git submodule update --init --recursive`);
    }
    return worktreePath;
  }
  
  async mergeWorktree(agentId: string): Promise<MergeResult> {
    // Attempt merge, return conflict info if any
  }
}
```

#### Priority 2: Application-Level CoW for Non-Git Workspaces

```typescript
class OverlayWorkspace {
  constructor(
    private baseDir: string,      // read-only base
    private overlayDir: string,   // agent-specific writes
  ) {}
  
  async readFile(path: string): Promise<string> {
    // Check overlay first, fall through to base
    const overlayPath = join(this.overlayDir, path);
    if (await exists(overlayPath)) return readFile(overlayPath);
    return readFile(join(this.baseDir, path));
  }
  
  async writeFile(path: string, content: string): Promise<void> {
    // Always write to overlay
    await writeFile(join(this.overlayDir, path), content);
  }
  
  async merge(): Promise<Diff[]> {
    // Diff overlay vs base, apply changes
  }
}
```

#### Priority 3: Extend Task Claiming with Status Transitions

Claw'd already has atomic task claiming with `claimed_by` column protection. Extend it with GoClaw's formal status machine:

```typescript
// Add status transitions: pending → in_progress → completed (+blocked)
// Add dependency tracking: blocked_by[] with auto-unblock on completion
// Add priority ordering: higher priority tasks served first
```

#### Priority 4: Delegation with Quality Gates

Implement the feedback loop pattern from GoClaw:
```
delegate → evaluate → retry with feedback → re-evaluate → accept/reject
```

#### Priority 5: Announce Queue with Batching

Prevent notification storms from parallel subagents. Use debounce + batch cap.

---

## Comparative Summary: GoClaw vs Claw'd

| Aspect | GoClaw (Current) | Claw'd (Current) | Recommendation |
|--------|-----------------|------------------|----------------|
| **Memory storage** | Markdown files + SQLite/pgvector | SQLite keyword search | Add hybrid search (FTS5 + vectors) |
| **Memory flush** | Pre-compaction LLM extraction | None | **Implement** — highest impact |
| **Memory expiration** | None (gap) | None | Add recency-weighted scoring |
| **Memory dedup** | None (gap) | None | Add cosine similarity dedup |
| **Task claiming** | Optimistic locking (WHERE condition) | Atomic claiming (`claimed_by` + WHERE guard) | Already comparable — extend with formal status transitions |
| **Delegation** | Sync/async with quality gates | File-based message bus | Add formal delegation with hooks |
| **Workspace isolation** | Config-based + Docker sandbox | Space isolation | Add Git worktree + CoW |
| **File locking** | None (gap) | None | Add advisory locking / CoW |
| **Subagent tools** | Deny lists escalating by depth | Category restrictions | Good — keep and extend |
| **Announce batching** | 1000ms debounce + 20 cap | None | Add debounced batching |
| **Concurrent control** | Lane-based scheduler (30/50/100/30) | Worker manager | Add lane-based scheduling |
| **Tracing** | OpenTelemetry spans | Console logs | Add structured tracing |

---

*This analysis is designed to be actionable for Claw'd development. Focus on Priority 1-3 items for immediate impact.*
